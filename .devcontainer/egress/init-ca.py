"""Keep the CA key in the proxy-only volume; publish only the certificate."""
import os
from pathlib import Path
import shutil

from mitmproxy import certs

private = Path('/pki')
public = Path('/trust')
private.mkdir(exist_ok=True)
public.mkdir(exist_ok=True)
certs.CertStore.from_store(private, 'mitmproxy', 2048)
for path in private.iterdir():
    if path.is_file():
        os.chown(path, 1000, 1000)
        path.chmod(0o600)
os.chown(private, 1000, 1000)
private.chmod(0o700)
shutil.copyfile(private / 'mitmproxy-ca-cert.pem', public / 'ca.pem')
(public / 'ca.pem').chmod(0o444)
public.chmod(0o755)
