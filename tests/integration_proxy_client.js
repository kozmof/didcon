'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const { execFileSync } = require('node:child_process');
const proxy = new URL(process.env.HTTPS_PROXY);

function request(connectHost, sni = connectHost, hostHeader = connectHost) {
  return new Promise((resolve, reject) => {
    const connect = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${connectHost}:443`,
      headers: { Host: `${connectHost}:443` }, timeout: 10000 });
    connect.on('error', reject);
    connect.on('timeout', () => connect.destroy(new Error('CONNECT timeout')));
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) { console.log(`Fixture CONNECT ${connectHost}: ${response.statusCode} ${response.headers['x-didcon-denial'] || ''}`); socket.destroy(); resolve(response.statusCode); return; }
      const encrypted = tls.connect({ socket, servername: sni, ca: fs.readFileSync('/etc/didcon/trust/ca.pem') });
      encrypted.setTimeout(10000, () => encrypted.destroy(new Error('TLS request timeout')));
      let body = '';
      encrypted.on('error', reject);
      encrypted.on('secureConnect', () => encrypted.write(`GET /zen HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: didcon-hardening-test\r\nConnection: close\r\n\r\n`));
      encrypted.on('data', chunk => { body += chunk.toString(); });
      encrypted.on('end', () => {
        const status = Number(body.match(/^HTTP\/1[.]1 (\d+)/)?.[1] || 0);
        if (status === 403) console.log('Fixture HTTPS denial:', body.split('\r\n\r\n')[1]);
        resolve(status);
      });
    });
    connect.end();
  });
}

function directDenied(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
    socket.once('error', () => resolve());
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Direct connection escaped: ${host}:${port}`)); });
  });
}

async function dnsDenied() {
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); resolve(); }, 1000);
    socket.on('error', () => { clearTimeout(timer); socket.close(); resolve(); });
    socket.on('message', () => { clearTimeout(timer); socket.close(); reject(new Error('Docker DNS bypass is reachable')); });
    // A complete example.com A query; any response demonstrates resolver reachability.
    socket.send(Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001', 'hex'), 53, '127.0.0.11');
  });
}

async function main() {
  if (process.argv.includes('--proxy-down')) {
    await assert.rejects(request('api.github.com'));
    await directDenied('1.1.1.1', 443);
    console.log('PASS: proxy failure leaves direct egress denied');
    return;
  }
  assert.equal(await request('api.github.com'), 200, 'Allowed HTTPS request failed');
  assert.equal(await request('example.com'), 403, 'Denied CONNECT was accepted');
  assert.equal(await request('api.github.com', 'api.github.com', 'example.com'), 403, 'Encrypted Host mismatch was accepted');
  assert.equal(await request('api.github.com', 'example.com', 'api.github.com'), 403, 'SNI mismatch was accepted');
  assert.equal(await request('169.254.169.254'), 403, 'IP literal CONNECT was accepted');
  await directDenied('1.1.1.1', 443);
  await directDenied('169.254.169.254', 80);
  await directDenied('2606:4700:4700::1111', 443);
  await dnsDenied();
  assert.deepEqual(fs.readdirSync('/etc/didcon/trust'), ['ca.pem']);
  if (process.getuid() === 0) {
    assert.throws(() => execFileSync('iptables', ['-F'], { stdio: 'pipe' }), 'Development root rewrote guard rules');
  }
  console.log('PASS: allowed HTTPS, CONNECT/SNI/Host enforcement, direct IPv4/IPv6/metadata denial, Docker DNS denial, and public-only CA trust');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
