// didcon integrates Smokescreen as a library so that every CONNECT is inspected
// and CONNECT, TLS SNI, and decrypted HTTP authority must identify the same host.
package main

import (
	"bufio"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/stripe/goproxy"
	"github.com/stripe/smokescreen/pkg/smokescreen"
	"github.com/stripe/smokescreen/pkg/smokescreen/conntrack"
)

func inspectedTLS(ca *tls.Certificate) func(string, *goproxy.ProxyCtx) (*tls.Config, error) {
	sign := goproxy.TLSConfigFromCA(ca)
	return func(host string, ctx *goproxy.ProxyCtx) (*tls.Config, error) {
		expected, err := authority(host, true)
		if err != nil {
			return nil, err
		}
		config, err := sign(host, ctx)
		if err != nil {
			return nil, err
		}
		config.MinVersion = tls.VersionTLS12
		config.NextProtos = []string{"http/1.1"}
		config.GetConfigForClient = func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			actual, err := hostname(hello.ServerName)
			if err != nil || actual != expected {
				return nil, errors.New("SNI must match CONNECT")
			}
			return nil, nil
		}
		return config, nil
	}
}

func newProxy(allowed exactPolicy, ca *tls.Certificate) (*goproxy.ProxyHttpServer, *smokescreen.Config, error) {
	config := smokescreen.NewConfig()
	config.Port = 443
	config.Network = "ip4"
	config.Resolver = strictResolver{net.DefaultResolver}
	config.EgressACL = allowed
	config.RoleFromRequest = func(*http.Request) (string, error) { return "didcon", nil }
	config.MitmTLSConfig = inspectedTLS(ca)
	config.RejectResponseHandler = denialResponse
	config.IdleTimeout = 2 * time.Minute
	// Upstream errors can contain client-supplied URLs. Keep requests, headers,
	// bodies, and trace IDs out of logs; the supervisor records lifecycle errors.
	config.Log.SetOutput(io.Discard)
	if err := config.Validate(); err != nil {
		return nil, nil, err
	}
	if err := config.InitializeSelfConnectionDetection(); err != nil {
		return nil, nil, err
	}
	config.ShuttingDown.Store(false)
	config.ConnTracker = conntrack.NewTracker(config.IdleTimeout, config.MetricsClient, config.Log, config.ShuttingDown, nil)
	proxy := smokescreen.BuildProxy(config)
	// goproxy defaults to insecure upstream TLS and environment proxies. Override
	// both explicitly: validated destination IPs and verified server names only.
	proxy.Tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	proxy.Tr.Proxy = nil
	proxy.Tr.TLSHandshakeTimeout = 10 * time.Second
	proxy.Tr.ResponseHeaderTimeout = 60 * time.Second
	proxy.Tr.MaxIdleConns = 64
	proxy.Logger = log.New(io.Discard, "", 0)
	return proxy, config, nil
}

func serve() error {
	allowed, err := readAllowlist("/policy/allowed-hosts.txt")
	if err != nil {
		return err
	}
	ca, err := loadCA("/pki/smokescreen-ca.pem")
	if err != nil {
		return err
	}
	proxy, _, err := newProxy(allowed, ca)
	if err != nil {
		return err
	}
	log.Print("Smokescreen ready: exact HTTPS allowlist with CONNECT/SNI/Host enforcement")
	server := &http.Server{Addr: ":443", Handler: proxy, ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 64 << 10, ErrorLog: log.New(io.Discard, "", 0)}
	return server.ListenAndServe()
}

func health() error {
	conn, err := net.DialTimeout("tcp4", "127.0.0.1:443", time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(conn, "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n"); err != nil {
		return err
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 403 || response.Header.Get("X-Didcon-Denial") != "1" {
		return errors.New("proxy denial policy is inactive")
	}
	return nil
}

func main() {
	var err error
	if len(os.Args) != 2 {
		err = errors.New("usage: didcon-proxy serve|init-ca|health")
	} else {
		switch os.Args[1] {
		case "serve":
			err = serve()
		case "init-ca":
			err = initCA("/pki", "/trust", 1000, 1000)
		case "health":
			err = health()
		default:
			err = errors.New("unknown proxy command")
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
