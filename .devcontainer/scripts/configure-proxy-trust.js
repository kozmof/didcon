'use strict';
const fs = require('node:fs');
if (process.env.DIDCON_EGRESS_MODE === 'proxy') {
  const ca = fs.readFileSync('/etc/didcon/trust/ca.pem', 'utf8');
  if (!ca.includes('-----BEGIN CERTIFICATE-----') || ca.includes('PRIVATE KEY')) throw new Error('Proxy public trust certificate missing or invalid');
  // Root-owned system trust is shared by CLI tools; no proxy private key is
  // mounted into this container. Repeated starts must not append duplicates.
  const system = '/etc/ssl/certs/ca-certificates.crt';
  const existing = fs.readFileSync(system, 'utf8');
  if (!existing.includes(ca.trim())) fs.appendFileSync(system, '\n' + ca);
}
