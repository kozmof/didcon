package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"regexp"
	"strings"

	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func hostname(value string) (string, error) {
	value = strings.ToLower(strings.TrimSuffix(value, "."))
	if len(value) == 0 || len(value) > 253 || net.ParseIP(value) != nil {
		return "", errors.New("invalid DNS hostname")
	}
	for _, label := range strings.Split(value, ".") {
		if !dnsLabel.MatchString(label) {
			return "", errors.New("invalid DNS hostname")
		}
	}
	return value, nil
}

func authority(value string, requirePort bool) (string, error) {
	host := value
	if strings.Contains(value, ":") {
		var port string
		var err error
		host, port, err = net.SplitHostPort(value)
		if err != nil || port != "443" {
			return "", errors.New("only HTTPS port 443 is allowed")
		}
	} else if requirePort {
		return "", errors.New("CONNECT requires an explicit port")
	}
	return hostname(host)
}

type exactPolicy map[string]bool

func readAllowlist(path string) (exactPolicy, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	allowed := exactPolicy{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		name := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if name == "" {
			continue
		}
		name, err = hostname(name)
		if err != nil {
			return nil, errors.New("allowlist must contain exact DNS hostnames")
		}
		allowed[name] = true
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(allowed) == 0 {
		return nil, errors.New("empty hostname allowlist")
	}
	return allowed, nil
}

func (allowed exactPolicy) Decide(args acl.DecideArgs) (acl.Decision, error) {
	deny := acl.Decision{Result: acl.Deny, Reason: "destination denied by didcon policy"}
	req := args.Req
	if req == nil || req.URL == nil || args.Service != "didcon" || args.ConnectProxyHost != "" ||
		req.Header.Get("X-Upstream-Https-Proxy") != "" {
		return deny, nil
	}
	host, err := authority(req.Host, args.ConnectReq == nil)
	if err != nil || !allowed[host] {
		return deny, nil
	}
	if args.ConnectReq == nil {
		if req.Method != http.MethodConnect || req.URL.Host != req.Host {
			return deny, nil
		}
		// Every allowed CONNECT must be inspected; no raw tunnel fallback.
		return acl.Decision{Result: acl.Allow, MitmConfig: &acl.MitmConfig{}}, nil
	}
	outerHost, err := authority(args.ConnectReq.Host, true)
	if err != nil || host != outerHost || req.Method == http.MethodConnect || req.URL.Scheme != "https" || req.URL.User != nil {
		return deny, nil
	}
	urlHost, err := authority(req.URL.Host, false)
	if err != nil || urlHost != host {
		return deny, nil
	}
	return acl.Decision{Result: acl.Allow}, nil
}

// Reject the entire DNS response if any answer is non-public, including mixed
// public/private responses. Smokescreen then validates and pins the dialed IP.
type strictResolver struct{ *net.Resolver }

var reservedIPv4 = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
}

func validateAnswers(ips []net.IP) error {
	if len(ips) == 0 {
		return errors.New("no DNS answers")
	}
	for _, ip := range ips {
		v4 := ip.To4()
		if v4 == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() {
			return errors.New("non-public DNS answer denied")
		}
		addr, _ := netip.AddrFromSlice(v4)
		for _, prefix := range reservedIPv4 {
			if prefix.Contains(addr) {
				return errors.New("reserved DNS answer denied")
			}
		}
	}
	return nil
}

func (r strictResolver) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	ips, err := r.Resolver.LookupIP(ctx, network, host)
	if err == nil {
		err = validateAnswers(ips)
	}
	if err != nil {
		return nil, err
	}
	return ips, nil
}

func denialResponse(response *http.Response) {
	if response.Body != nil {
		response.Body.Close()
	}
	body := "Proxy upstream request failed\n"
	response.Header = http.Header{"Content-Type": {"text/plain"}}
	// Smokescreen uses 407 for ACL denial. Distinguish policy enforcement from
	// DNS/network failures so an unreachable health fixture cannot look healthy.
	if response.StatusCode == http.StatusProxyAuthRequired {
		response.StatusCode = http.StatusForbidden
		response.Header.Set("X-Didcon-Denial", "1")
		body = "Denied by didcon egress policy\n"
	}
	response.Status = http.StatusText(response.StatusCode)
	response.Body = io.NopCloser(strings.NewReader(body))
	response.ContentLength = int64(len(body))
}
