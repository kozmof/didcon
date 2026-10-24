package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"
)

func testCA(t *testing.T) (*tls.Certificate, string) {
	t.Helper()
	dir := t.TempDir()
	private, public := filepath.Join(dir, "private"), filepath.Join(dir, "public")
	if err := initCA(private, public, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	ca, err := loadCA(filepath.Join(private, "smokescreen-ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	return ca, dir
}

func TestExactHTTPSPolicy(t *testing.T) {
	allowed := exactPolicy{"allowed.invalid": true, "other.invalid": true}
	outer, _ := http.NewRequest("CONNECT", "http://allowed.invalid:443", nil)
	outer.URL.Scheme = ""
	for _, tc := range []struct {
		name, method, target, host, proxy, service string
		connect                                    *http.Request
		allow                                      bool
	}{
		{"CONNECT", "CONNECT", "http://allowed.invalid:443", "allowed.invalid:443", "", "didcon", nil, true},
		{"encrypted HTTPS", "GET", "https://allowed.invalid/path", "allowed.invalid", "", "didcon", outer, true},
		{"canonical DNS", "GET", "https://ALLOWED.INVALID./", "ALLOWED.INVALID.:443", "", "didcon", outer, true},
		{"different allowed Host", "GET", "https://other.invalid/", "other.invalid", "", "didcon", outer, false},
		{"different URL authority", "GET", "https://other.invalid/", "allowed.invalid", "", "didcon", outer, false},
		{"denied CONNECT", "CONNECT", "http://denied.invalid:443", "denied.invalid:443", "", "didcon", nil, false},
		{"non-HTTPS port", "CONNECT", "http://allowed.invalid:80", "allowed.invalid:80", "", "didcon", nil, false},
		{"missing CONNECT port", "CONNECT", "http://allowed.invalid", "allowed.invalid", "", "didcon", nil, false},
		{"plain HTTP", "GET", "http://allowed.invalid/", "allowed.invalid", "", "didcon", nil, false},
		{"plain HTTP inside TLS", "GET", "http://allowed.invalid/", "allowed.invalid", "", "didcon", outer, false},
		{"nested CONNECT", "CONNECT", "https://allowed.invalid:443", "allowed.invalid:443", "", "didcon", outer, false},
		{"client upstream proxy", "CONNECT", "http://allowed.invalid:443", "allowed.invalid:443", "other.invalid", "didcon", nil, false},
		{"missing role", "CONNECT", "http://allowed.invalid:443", "allowed.invalid:443", "", "", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(tc.method, tc.target, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Host = tc.host
			decision, err := allowed.Decide(acl.DecideArgs{Req: req, ConnectReq: tc.connect, Service: tc.service, ConnectProxyHost: tc.proxy})
			if err != nil || (decision.Result == acl.Allow) != tc.allow {
				t.Fatalf("unexpected decision: %+v, %v", decision, err)
			}
			if tc.allow && tc.connect == nil && decision.MitmConfig == nil {
				t.Fatal("allowed CONNECT lacks mandatory inspection")
			}
		})
	}
	for _, name := range []string{"127.0.0.1", "169.254.169.254", "::1", "[::1]", "user@allowed.invalid", "allowed.invalid/path", "*.invalid", "a..b", "a.invalid..", "", "host\\name", "host\nname"} {
		if _, err := hostname(name); err == nil {
			t.Errorf("invalid DNS hostname accepted: %q", name)
		}
	}
}

func TestAllowlistFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "allowed-hosts.txt")
	for _, text := range []string{"", "# empty\n", "*.invalid\n", "127.0.0.1\n", "allowed.invalid:443\n", "allowed.invalid\n10.0.0.0/8\n"} {
		os.WriteFile(path, []byte(text), 0600)
		if _, err := readAllowlist(path); err == nil {
			t.Errorf("invalid allowlist accepted: %q", text)
		}
	}
	os.WriteFile(path, []byte("# approved\nALLOWED.INVALID. # comment\n"), 0600)
	allowed, err := readAllowlist(path)
	if err != nil || !allowed["allowed.invalid"] || len(allowed) != 1 {
		t.Fatalf("valid allowlist rejected: %v, %v", allowed, err)
	}
}

func TestDNSRejectsNonPublicAndMixedAnswers(t *testing.T) {
	public := net.ParseIP("1.1.1.1")
	if err := validateAnswers([]net.IP{public}); err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{"0.0.0.0", "0.1.2.3", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::1", "2606:4700:4700::1111"} {
		ip := net.ParseIP(address)
		if validateAnswers([]net.IP{ip}) == nil || validateAnswers([]net.IP{public, ip}) == nil {
			t.Errorf("private or mixed DNS answer accepted: %s", address)
		}
	}
	if validateAnswers(nil) == nil {
		t.Fatal("empty DNS response accepted")
	}
}

func TestCAReuseAndLegacyMigration(t *testing.T) {
	_, dir := testCA(t)
	private, public := filepath.Join(dir, "private"), filepath.Join(dir, "public")
	path := filepath.Join(private, "smokescreen-ca.pem")
	before, _ := os.ReadFile(path)
	trust, _ := os.ReadFile(filepath.Join(public, "ca.pem"))
	if bytes.Contains(trust, []byte("PRIVATE KEY")) || !bytes.Contains(trust, []byte("CERTIFICATE")) {
		t.Fatal("public trust contains private data or lacks a certificate")
	}
	for _, legacy := range []bool{false, true} {
		if legacy {
			if err := os.Rename(path, filepath.Join(private, "mitmproxy-ca.pem")); err != nil {
				t.Fatal(err)
			}
		}
		if err := initCA(private, public, os.Getuid(), os.Getgid()); err != nil {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(path)
		afterTrust, _ := os.ReadFile(filepath.Join(public, "ca.pem"))
		if !bytes.Equal(before, after) || !bytes.Equal(trust, afterTrust) {
			t.Fatal("CA identity changed during restart or migration")
		}
	}
	if err := os.WriteFile(path, []byte("invalid CA"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := initCA(private, public, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("invalid CA was silently replaced")
	}
}

type fixtureResolver struct{}

func (fixtureResolver) LookupIP(context.Context, string, string) ([]net.IP, error) {
	return []net.IP{net.ParseIP("1.1.1.1")}, nil
}
func (fixtureResolver) LookupPort(context.Context, string, string) (int, error) { return 443, nil }

// Test real TLS and HTTP parsing through the production Smokescreen integration.
// Only DNS and dialing are substituted: no public network is used by this test.
func TestProxyIdentityAndUpstreamVerification(t *testing.T) {
	ca, _ := testCA(t)
	leaf := func(host string) tls.Certificate {
		template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), DNSNames: []string{host},
			NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
			KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, template, ca.Leaf, ca.PrivateKey.(crypto.Signer).Public(), ca.PrivateKey)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: ca.PrivateKey}
	}
	upstreamTLS := &tls.Config{Certificates: []tls.Certificate{leaf("allowed.invalid")}}
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		io.WriteString(w, "fixture")
	}))
	upstream.TLS = upstreamTLS
	upstream.Config.ErrorLog = log.New(io.Discard, "", 0)
	upstream.StartTLS()
	defer upstream.Close()
	proxy, config, err := newProxy(exactPolicy{"allowed.invalid": true, "other.invalid": true}, ca)
	if err != nil {
		t.Fatal(err)
	}
	if proxy.Tr.Proxy != nil || proxy.Tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("upstream TLS or proxy safety defaults regressed")
	}
	config.Resolver = fixtureResolver{}
	var dialed string
	config.ProxyDialTimeout = func(ctx context.Context, network, address string, timeout time.Duration) (net.Conn, error) {
		dialed = address
		return net.DialTimeout("tcp", upstream.Listener.Addr().String(), timeout)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca.Leaf)
	proxy.Tr.TLSClientConfig.RootCAs = roots
	server := httptest.NewServer(proxy)
	defer server.Close()
	defer proxy.Tr.CloseIdleConnections()

	request := func(sni, host, target string, insecure bool) (int, error) {
		conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
		if err != nil {
			return 0, err
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		fmt.Fprint(conn, "CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n")
		response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: "CONNECT"})
		if err != nil || response.StatusCode != 200 {
			return 0, fmt.Errorf("CONNECT failed: %v, %v", response, err)
		}
		if response.Proto != "HTTP/1.1" {
			return 0, fmt.Errorf("CONNECT must use HTTP/1.1 for safe-chain: %s", response.Proto)
		}
		encrypted := tls.Client(conn, &tls.Config{ServerName: sni, RootCAs: roots, InsecureSkipVerify: insecure})
		if err := encrypted.Handshake(); err != nil {
			return 0, err
		}
		fmt.Fprintf(encrypted, "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", target, host)
		response, err = http.ReadResponse(bufio.NewReader(encrypted), &http.Request{Method: "GET"})
		if err != nil {
			return 0, err
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return response.StatusCode, nil
	}
	if status, err := request("allowed.invalid", "allowed.invalid", "/", false); err != nil || status != 200 {
		t.Fatalf("allowed request failed: %d, %v", status, err)
	}
	if dialed != "1.1.1.1:443" {
		t.Fatalf("dialer did not receive the validated DNS address: %s", dialed)
	}
	for _, sni := range []string{"other.invalid", ""} {
		if _, err := request(sni, "allowed.invalid", "/", true); err == nil {
			t.Errorf("hostile client escaped SNI enforcement with %q", sni)
		}
	}
	for _, tc := range [][2]string{{"other.invalid", "/"}, {"denied.invalid", "/"}, {"allowed.invalid", "https://other.invalid/"}} {
		if status, err := request("allowed.invalid", tc[0], tc[1], false); err != nil || status != 403 {
			t.Errorf("Host/URL mismatch accepted: %v: %d, %v", tc, status, err)
		}
	}
	// A CA-signed certificate for a different upstream hostname is still denied.
	proxy.Tr.CloseIdleConnections()
	upstream.TLS.Certificates = []tls.Certificate{leaf("other.invalid")}
	if status, _ := request("allowed.invalid", "allowed.invalid", "/", false); status == 200 {
		t.Fatal("wrong upstream certificate hostname was accepted")
	}
	// Even a certificate for the right hostname must chain to a trusted root.
	proxy.Tr.CloseIdleConnections()
	upstream.TLS.Certificates = upstreamTLS.Certificates
	proxy.Tr.TLSClientConfig.RootCAs = x509.NewCertPool()
	if status, _ := request("allowed.invalid", "allowed.invalid", "/", false); status == 200 {
		t.Fatal("untrusted upstream certificate was accepted")
	}
}

func TestCARefusesPublicPermissionsAndSymlinks(t *testing.T) {
	_, dir := testCA(t)
	path := filepath.Join(dir, "private", "smokescreen-ca.pem")
	os.Chmod(path, 0644)
	if _, err := loadCA(path); err == nil {
		t.Fatal("world-readable private key accepted")
	}
	os.Chmod(path, 0600)
	link := filepath.Join(dir, "link")
	os.Symlink(path, link)
	if _, err := loadCA(link); err == nil {
		t.Fatal("symlink CA accepted")
	}
}

func TestCARefusesToRotateWhenPrivateKeyIsLost(t *testing.T) {
	_, dir := testCA(t)
	private, public := filepath.Join(dir, "private"), filepath.Join(dir, "public")
	if err := os.Remove(filepath.Join(private, "smokescreen-ca.pem")); err != nil {
		t.Fatal(err)
	}
	if err := initCA(private, public, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("published CA was silently replaced after private key loss")
	}
}

func TestDenialResponseRedactsRequestData(t *testing.T) {
	response := &http.Response{StatusCode: 407, Header: http.Header{"Secret": {"do-not-leak"}}, Body: io.NopCloser(strings.NewReader("do-not-leak"))}
	denialResponse(response)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 403 || response.Header.Get("X-Didcon-Denial") != "1" || strings.Contains(string(body), "do-not-leak") || response.Header.Get("Secret") != "" {
		t.Fatal(errors.New("denial response leaked internal data"))
	}
	response = &http.Response{StatusCode: 502}
	denialResponse(response)
	if response.StatusCode != 502 || response.Header.Get("X-Didcon-Denial") != "" {
		t.Fatal("network failure was incorrectly marked as a policy denial")
	}
}
