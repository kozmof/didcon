package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

func loadCA(path string) (*tls.Certificate, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("CA must be a private regular file")
	}
	ca, err := tls.LoadX509KeyPair(path, path)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(ca.Certificate[0])
	if err != nil {
		return nil, err
	}
	if !cert.IsCA || !cert.BasicConstraintsValid || cert.KeyUsage&x509.KeyUsageCertSign == 0 ||
		time.Now().Before(cert.NotBefore) || !time.Now().Before(cert.NotAfter) {
		return nil, errors.New("CA is invalid or expired; explicit rotation required")
	}
	ca.Leaf = cert
	return &ca, nil
}

func newCA() ([]byte, error) {
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "didcon Smokescreen CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(5, 0, 0),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return append(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...), nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".didcon-ca-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Chmod(mode)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func initCA(private, public string, uid, gid int) error {
	for _, dir := range []string{private, public} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	path := filepath.Join(private, "smokescreen-ca.pem")
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		// Reuse the previous proxy CA so existing clients retain the same trust.
		legacy := filepath.Join(private, "mitmproxy-ca.pem")
		var data []byte
		if _, err := loadCA(legacy); err == nil {
			data, err = os.ReadFile(legacy)
			if err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		} else {
			entries, err := os.ReadDir(private)
			if err != nil {
				return err
			}
			if len(entries) != 0 {
				return errors.New("CA files exist without a private CA; explicit recovery required")
			}
			if _, err := os.Lstat(filepath.Join(public, "ca.pem")); !errors.Is(err, os.ErrNotExist) {
				return errors.New("published CA exists without a private key; explicit recovery required")
			}
			data, err = newCA()
			if err != nil {
				return err
			}
		}
		if err := writeAtomic(path, data, 0600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	ca, err := loadCA(path)
	if err != nil {
		return err
	}
	if err := os.Chown(path, uid, gid); err != nil {
		return err
	}
	if err := os.Chmod(private, 0700); err != nil {
		return err
	}
	if err := os.Chown(private, uid, gid); err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(public, "ca.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Certificate[0]}), 0444); err != nil {
		return err
	}
	return os.Chmod(public, 0755)
}
