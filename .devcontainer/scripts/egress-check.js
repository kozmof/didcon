'use strict';
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { execFileSync } = require('node:child_process');

function deniedTCP(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = denied => { socket.destroy(); resolve(denied); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(['EACCES', 'EPERM', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)));
  });
}

async function main() {
  if (process.env.DIDCON_EGRESS_MODE !== 'proxy') {
    console.log('[WARN] legacy IP firewall: client DNS and shared-IP egress remain possible');
    return;
  }
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const bounding = BigInt('0x' + status.match(/^CapBnd:\s*(\w+)/m)[1]);
  if (bounding & ((1n << 12n) | (1n << 13n))) throw new Error('development capability bounding set includes NET_ADMIN or NET_RAW');
  const proxy = new URL(process.env.HTTPS_PROXY);
  if (proxy.protocol !== 'http:' || proxy.port !== '443' || !net.isIPv4(proxy.hostname)) throw new Error('proxy endpoint differs from the expected fixed IPv4 listener');
  const blocked = await new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: 443, method: 'CONNECT', path: 'example.com:443',
      headers: { Host: 'example.com:443' }, timeout: 3000 });
    request.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode === 403 && Boolean(response.headers['x-didcon-denial'])); });
    request.once('timeout', () => request.destroy(new Error('proxy denial probe timed out')));
    request.once('error', reject);
    request.end();
  });
  if (!blocked) throw new Error('proxy did not enforce the denied CONNECT fixture');
  for (const [host, port] of [['1.1.1.1', 443], ['169.254.169.254', 80], ['127.0.0.11', 53], ['2606:4700:4700::1111', 443]]) {
    if (!await deniedTCP(host, port)) throw new Error(`direct egress denial unverified: ${host}:${port}`);
  }
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); resolve(); }, 1000);
    socket.once('message', () => { clearTimeout(timer); socket.close(); reject(new Error('Docker DNS UDP listener is reachable')); });
    socket.once('error', () => { clearTimeout(timer); socket.close(); resolve(); });
    socket.send(Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001', 'hex'), 53, '127.0.0.11');
  });
  execFileSync('wget', ['--no-hsts', '--timeout=8', '--tries=1', '-qO-', 'https://api.github.com/zen'], { stdio: 'ignore', timeout: 12000 });
  console.log('[PASS] proxy trust and allowed HTTPS; denied CONNECT, direct IPv4/IPv6, metadata, Docker DNS, and development network capabilities');
}
main().catch(error => { console.error(`[FAIL] egress verification: ${error.message}`); process.exitCode = 1; });
