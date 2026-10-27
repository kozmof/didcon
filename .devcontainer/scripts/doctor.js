'use strict';
// No package installation, configuration repair, agent login, or credential
// reads. Child output is bounded and summarized rather than copied into reports.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const { X509Certificate } = require('node:crypto');
const { spawn } = require('node:child_process');
const { probeSocket } = require('./host-integration-check.js');
const { inspectStorageLimits } = require('./storage-limits.js');

const HELP = `Usage: didcon-doctor [--offline] [--json] [--strict] [--credential-fixture]

Run inside the configured container as dev, outside an agent sandbox, after
postCreateCommand completes. Checks tools, security preflight, mounts, storage,
resource limits, Landlock support, proxy environment, certificate trust, and TLS
identity enforcement. Only small temporary write probes are created and removed.

  --offline             Skip external requests, including preflight networking
  --json                Emit one JSON report (child output is suppressed)
  --strict              Exit unsuccessfully for warnings as well as failures
  --credential-fixture  Probe only the opt-in disposable .invalid Git fixture
  --help                Show this help

Exit: 0 = no failures; 1 = failures (or strict warnings); 2 = invalid arguments.
No real credential helper is invoked unless --credential-fixture is supplied.
To acknowledge socket risk in doctor diagnostics only (FAIL to WARN), run on
the host from the project root:
  python3 .devcontainer/host/acknowledge-doctor-socket-risk.py
This command acts only on its own project and accepts no target-path argument.
Paste exact socket paths or doctor finding lines, then type approve to save.
Socket access and runtime security controls remain unchanged.
`;

function parseOptions(args) {
  const options = { offline: false, json: false, strict: false, credentialFixture: false, help: false };
  const flags = { '--offline': 'offline', '--json': 'json', '--strict': 'strict', '--credential-fixture': 'credentialFixture', '--help': 'help', '-h': 'help' };
  for (const arg of args) {
    if (!Object.hasOwn(flags, arg)) throw new Error('Unknown option; run didcon-doctor --help');
    options[flags[arg]] = true;
  }
  return options;
}

const children = new Set();
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

function runCommand(file, args = [], options = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd: options.cwd || '/workspace', env: options.env || process.env,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false, errorCode;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, options.timeout || 15000);
    const collect = name => chunk => {
      bytes += chunk.length;
      if (bytes > (options.maxBuffer || 256 * 1024)) { overflow = true; killGroup(child); return; }
      if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', error => { errorCode = error.code; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, signal, stdout, stderr, timedOut, overflow, errorCode,
        ok: code === 0 && !timedOut && !overflow && !errorCode });
    });
  });
}

function summary(checks) {
  return checks.reduce((counts, check) => { counts[check.status]++; return counts; }, { pass: 0, fail: 0, warn: 0, skip: 0 });
}

function inspectProcess(status, proxyMode) {
  const get = key => status.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'))?.[1];
  const issues = [];
  if (get('NoNewPrivs') !== '1') issues.push('no-new-privileges is not enabled');
  if (get('Seccomp') !== '2') issues.push('seccomp filtering is not enabled');
  if (!get('CapEff') || BigInt('0x' + get('CapEff')) !== 0n) issues.push('dev has effective Linux capabilities');
  if (proxyMode) {
    const expected = (1n << 0n) | (1n << 6n) | (1n << 7n); // CHOWN, SETGID, SETUID for entrypoint
    if (!get('CapBnd') || (BigInt('0x' + get('CapBnd')) & ~expected)) issues.push('capability bounding set exceeds the proxy-mode startup capabilities');
  }
  return issues;
}

function finiteLimit(value) {
  if (!/^\d+$/.test(value || '')) return null;
  const number = Number(value);
  return number > 0 && number < 2 ** 60 ? number : null;
}

function toolVersion(output) {
  return output.match(/(?:^|[\s(]|go)v?(\d{1,4}\.\d{1,4}(?:\.\d{1,6})?)\b/m)?.[1];
}

function readLimits(read = filename => fs.readFileSync(filename, 'utf8').trim()) {
  const optional = filename => { try { return read(filename); } catch { return null; } };
  const v2 = optional('/sys/fs/cgroup/cgroup.controllers') !== null;
  const memory = optional(v2 ? '/sys/fs/cgroup/memory.max' : '/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const pids = optional(v2 ? '/sys/fs/cgroup/pids.max' : '/sys/fs/cgroup/pids/pids.max');
  const cpu = v2 ? optional('/sys/fs/cgroup/cpu.max')?.split(/\s+/) :
    [optional('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), optional('/sys/fs/cgroup/cpu/cpu.cfs_period_us')];
  return { version: v2 ? 2 : 1, memory: finiteLimit(memory), pids: finiteLimit(pids),
    cpus: cpu && finiteLimit(cpu[0]) && finiteLimit(cpu[1]) ? Number(cpu[0]) / Number(cpu[1]) : null,
    memoryUsed: Number(optional(v2 ? '/sys/fs/cgroup/memory.current' : '/sys/fs/cgroup/memory/memory.usage_in_bytes')),
    pidsUsed: Number(optional(v2 ? '/sys/fs/cgroup/pids.current' : '/sys/fs/cgroup/pids/pids.current')) };
}

function proxyEnvironmentIssues(env, identity) {
  const issues = [];
  const octet = /^[0-9a-f]{16}$/.test(identity || '') ? parseInt(identity.slice(0, 2), 16) : null;
  const expected = octet === null ? null : `http://172.30.${octet}.2:443`;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (!expected || env[key] !== expected) issues.push(`${key} differs from the reviewed proxy endpoint`);
  }
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const values = (env[key] || '').split(',').map(value => value.trim());
    if (!env[key] || values.some(value => !['localhost', '127.0.0.1', '::1'].includes(value))) issues.push(`${key} differs from the loopback-only policy`);
  }
  const trust = { NODE_EXTRA_CA_CERTS: '/etc/didcon/trust/ca.pem', SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
    GIT_SSL_CAINFO: '/etc/ssl/certs/ca-certificates.crt', REQUESTS_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt', CURL_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt' };
  for (const [key, expectedPath] of Object.entries(trust)) if (env[key] !== expectedPath) issues.push(`${key} differs from the configured trust store`);
  return issues;
}

function preflightGroups(output) {
  const names = ['safe-chain', 'Takumi Guard', 'Takumi Guard (Go)', 'Takumi Guard (PyPI)', 'Island',
    'Host integrations and mounts (repeat after attach/reconnect)', 'Egress policy'];
  const groups = new Map();
  const structuredHostGroups = new Set();
  let current;
  for (const line of output.split('\n')) {
    if (line.startsWith('==> ') && names.includes(line.slice(4))) {
      current = line.slice(4);
      groups.set(current, { name: current, pass: 0, fail: 0, warn: 0 });
    }
    if (current?.startsWith('Host integrations') && line.startsWith('{')) {
      try {
        const report = JSON.parse(line);
        if (report.kind === 'didcon-host-integration' && report.schemaVersion === 1 && Array.isArray(report.checks)) {
          const group = groups.get(current);
          structuredHostGroups.add(current);
          group.details = [];
          for (const check of report.checks) {
            if (!['pass', 'fail', 'warn'].includes(check.status)) continue;
            group[check.status]++;
            if (check.status === 'pass') continue;
            if (check.type === 'socket' && typeof check.socket === 'string' && check.socket.startsWith('/')) {
              const accepted = check.status === 'warn' && check.accepted === 'socket-allowlist';
              group.details.push({ type: 'socket', socket: check.socket, status: check.status,
                ...(accepted ? { accepted: 'socket-allowlist' } : {}),
                message: `${accepted ? 'Approved socket exposure' : 'Socket reachable or isolation unverified'}: ${JSON.stringify(check.socket)}` });
            } else {
              const messages = { mount: 'Protected mount verification failed', scratch: 'Shared scratch verification failed',
                'credential-config': 'Git credential-helper configuration requires review',
                'socket-policy': 'Socket approval file is invalid or not protected by the host',
                'credential-fixture': 'Disposable credential fixture is exposed or unverified' };
              const known = Object.hasOwn(messages, check.type);
              group.details.push({ type: known ? check.type : 'unknown',
                message: known ? messages[check.type] : 'Host-integration verification failed' });
            }
          }
        }
      } catch { /* A malformed structured record cannot replace the aggregate result. */ }
    }
    const status = line.match(/^\[(PASS|FAIL|WARN)\]/)?.[1].toLowerCase();
    const aggregateHostResult = line === '[PASS] host integration and mount checks' ||
      line === '[FAIL] host integration or mount exposure detected; see checks above' ||
      line === '[WARN] host integration checks include approved socket exposures; see checks above';
    if (status && current && !(structuredHostGroups.has(current) && aggregateHostResult)) groups.get(current)[status]++;
  }
  const match = output.match(/==> Summary: (\d+) passed, (\d+) failed, (\d+) warnings/);
  return { groups: [...groups.values()], totals: match ? { pass: +match[1], fail: +match[2], warn: +match[3] } : null };
}

function preflightOutcome(result, parsed) {
  const cleanExit = !result.signal && !result.timedOut && !result.overflow && !result.errorCode;
  const reportedFailure = parsed.groups.some(group => group.fail > 0);
  if (cleanExit && result.code === 1 && parsed.totals?.fail > 0 && reportedFailure) return 'reported-failures';
  if (result.ok && parsed.totals?.fail === 0 && !reportedFailure) return 'passed';
  return 'incomplete';
}

// A bounded HTTP/1.1 CONNECT + TLS request. Errors include only a stage/code;
// callers never report response bodies, headers, peer subjects, or raw errors.
function proxyProbe(proxy, ca, options = {}) {
  return new Promise((resolve, reject) => {
    let encrypted, raw, stage = 'connect', done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      encrypted?.destroy(); raw?.destroy(); connect.destroy();
      if (error) reject(Object.assign(new Error('Proxy probe failed'), { stage, code: error.code || 'PROBE_FAILED' }));
      else resolve(result);
    };
    const host = options.connectHost || 'api.github.com';
    const connect = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:443`,
      headers: { Host: `${host}:443` }, agent: false });
    const timer = setTimeout(() => finish({ code: 'ETIMEDOUT' }), options.timeout || 10000);
    connect.on('error', error => finish(error));
    connect.on('connect', (response, socket) => {
      raw = socket;
      if (response.statusCode !== 200) return finish(null, { stage, status: response.statusCode, denial: response.headers['x-didcon-denial'] === '1' });
      stage = 'tls';
      encrypted = tls.connect({ socket, servername: options.sni ?? host, ca, rejectUnauthorized: options.verify !== false, minVersion: 'TLSv1.2' });
      encrypted.on('error', error => finish(error));
      encrypted.on('secureConnect', () => {
        stage = 'response';
        encrypted.write(`GET /zen HTTP/1.1\r\nHost: ${options.authority || host}\r\nUser-Agent: didcon-doctor\r\nConnection: close\r\n\r\n`);
      });
      let headers = '';
      encrypted.on('data', chunk => {
        headers += chunk.toString();
        if (headers.length > 65536) return finish({ code: 'HEADERS_TOO_LARGE' });
        if (headers.includes('\r\n\r\n')) {
          const status = Number(headers.match(/^HTTP\/1\.[01] (\d{3}) /)?.[1]);
          if (!status) return finish({ code: 'INVALID_HTTP' });
          finish(null, { stage, status, denial: /\r\nx-didcon-denial:\s*1\r\n/i.test(headers) });
        }
      });
      encrypted.on('end', () => { if (!done) finish({ code: 'INCOMPLETE_HTTP' }); });
    });
    connect.end();
  });
}

class Doctor {
  constructor(options, emit = () => {}) {
    this.options = options;
    this.emit = emit;
    this.report = { schemaVersion: 1, checkedAt: new Date().toISOString(), complete: !options.offline,
      policy: { socketApprovals: 'host-managed-exact-paths' },
      system: { platform: process.platform, architecture: process.arch, kernel: os.release(), node: process.versions.node }, checks: [] };
  }

  add(section, id, status, message, remediation, details) {
    const check = { section, id, status, message, ...(remediation ? { remediation } : {}), ...(details?.length ? { details } : {}) };
    this.report.checks.push(check);
    this.emit(check);
  }

  async check(section, id, action, remediation) {
    try { await action(); } catch { this.add(section, id, 'fail', 'Check could not complete', remediation); }
  }

  async run() {
    const add = this.add.bind(this);
    const fixLaunch = 'Run host/prepare.py on the host and rebuild the container.';
    if (process.platform !== 'linux' || process.getuid?.() === 0 || os.userInfo().username !== 'dev' || process.env.DEVCONTAINER !== 'true') {
      add('Runtime', 'runtime.context', 'fail', 'Run inside the didcon container as dev, in an ordinary terminal', 'Use the VS Code container terminal after postCreateCommand completes.');
      this.report.complete = false;
      return this.finish();
    }
    add('Runtime', 'runtime.context', 'pass', 'Running as dev in the container');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync('/etc/didcon/manifest.json', 'utf8')); }
    catch {
      add('Runtime', 'runtime.manifest', 'fail', 'Reviewed workspace manifest is missing or unreadable', fixLaunch);
      this.report.complete = false;
      return this.finish();
    }
    if (!['bind', 'volume'].includes(manifest.mode) || !['proxy', 'firewall'].includes(manifest.egress)) {
      add('Runtime', 'runtime.manifest', 'fail', 'Reviewed workspace mode or egress mode is invalid', fixLaunch);
      this.report.complete = false;
      return this.finish();
    }
    this.report.system.workspaceMode = manifest.mode;
    this.report.system.egressMode = manifest.egress;
    try { fs.readdirSync('/var/log'); }
    catch {
      add('Runtime', 'runtime.sandbox', 'fail', 'Parent sandbox prevents comprehensive checks', 'Run didcon-doctor in an ordinary container terminal, outside an agent.');
      this.report.complete = false;
      return this.finish();
    }
    add('Runtime', 'runtime.manifest', 'pass', `Reviewed ${manifest.mode} workspace; ${manifest.egress} egress`);
    if (manifest.egress === 'proxy' && process.env.DIDCON_EGRESS_MODE !== 'proxy') add('Runtime', 'runtime.egress-mode', 'fail', 'Runtime egress mode differs from the manifest', fixLaunch);

    await this.check('Runtime', 'runtime.capabilities', () => {
      const issues = inspectProcess(fs.readFileSync('/proc/self/status', 'utf8'), manifest.egress === 'proxy');
      for (let index = 0; index < issues.length; index++) add('Runtime', `runtime.capabilities.${index}`, 'fail', issues[index], fixLaunch);
      if (!issues.length) add('Runtime', 'runtime.capabilities', 'pass', 'No effective capabilities; startup capability bounds, no-new-privileges, and seccomp verified');
    }, fixLaunch);
    await this.tools(manifest);
    await this.kernel();
    await this.storage(manifest);
    await this.integrations();
    if (manifest.egress === 'proxy') await this.trust(manifest);
    else add('Egress', 'proxy.legacy', 'warn', 'Legacy firewall mode retains client DNS and shared-IP exposure', 'Switch to proxy mode on the host and rebuild.');
    await this.preflight();
    if (manifest.egress === 'proxy') await this.network();
    return this.finish();
  }

  finish() {
    this.report.summary = summary(this.report.checks);
    this.report.status = this.report.summary.fail ? 'failed' : this.report.summary.warn || !this.report.complete ? 'degraded' : 'healthy';
    return this.report;
  }

  async tools(manifest, command = runCommand) {
    const dockerfile = manifest.build?.dockerfile || manifest.template?.build?.dockerfile || '';
    const tools = ['node', 'npm', 'npx', 'pnpm', 'git', 'claude', 'codex', 'island'].map(name => ({ name, file: name, expected: true }));
    for (const [name, file, marker] of [
      ['go', '/usr/local/go/bin/go', 'withGo'], ['cargo', '/opt/rust/bin/cargo', 'withRust'],
      ['rustc', '/opt/rust/bin/rustc', 'withRust'], ['zig', '/usr/local/zig/zig', 'withZig'],
      ['blender', '/usr/local/blender/blender', 'withBlender'], ['uv', '/usr/local/uv/uv', 'withBlender'],
      ['herdr', '/opt/herdr/bin/herdr', null],
    ]) tools.push({ name, file, expected: marker ? dockerfile.includes(marker) : String(manifest.build?.args?.INSTALL_HERDR || manifest.template?.build?.args?.INSTALL_HERDR) === 'true' });
    for (const tool of tools) {
      if (path.isAbsolute(tool.file) && !fs.existsSync(tool.file) && !tool.expected) {
        this.add('Tools', `tool.${tool.name}`, 'skip', `${tool.name} is optional and not installed`);
        continue;
      }
      const result = await command(tool.file, ['go', 'zig'].includes(tool.name) ? ['version'] : ['--version'],
        { env: { ...process.env, GOTOOLCHAIN: 'local' } });
      const version = toolVersion(result.stdout);
      this.add('Tools', `tool.${tool.name}`, result.ok && version ? 'pass' : 'fail',
        result.ok && version ? `${tool.name} ${version}` : `${tool.name} is missing, timed out, or cannot report its version`, 'Rebuild the selected image variant; verify PATH includes /usr/local/bin before /usr/bin.');
    }
    for (const filename of ['/opt/scripts', '/etc/npmrc', '/etc/island', '/usr/local/bin/didcon-doctor',
      '/usr/local/libexec/didcon-landlock-abi', '/usr/local/share/npm-global']) {
      await this.check('Tools', 'asset.' + filename, () => {
        const info = fs.statSync(filename);
        let writable = false;
        try { fs.accessSync(filename, fs.constants.W_OK); writable = true; } catch {}
        const safe = info.uid === 0 && !writable;
        this.add('Tools', 'asset.' + filename, safe ? 'pass' : 'fail', `Enforcement asset ${safe ? 'protected' : 'writable or not root-owned'}: ${filename}`, 'Rebuild to restore root-owned tools and policy assets.');
      }, 'Rebuild the image to install the doctor and its support files.');
    }
  }

  async kernel() {
    const result = await runCommand('/usr/local/libexec/didcon-landlock-abi');
    const abi = /^\d+\s*$/.test(result.stdout) ? Number(result.stdout) : 0;
    if (!result.ok || !abi) {
      this.add('Kernel', 'kernel.landlock', 'fail', 'Running kernel Landlock ABI could not be queried', 'Rebuild the image; check host kernel Landlock support and syscall permissions.');
      return;
    }
    this.report.system.landlockABI = abi;
    this.add('Kernel', 'kernel.landlock', 'pass', `Running kernel exposes Landlock ABI ${abi}`);
    if (abi < 6) this.add('Kernel', 'kernel.landlock-policy', 'warn', 'Kernel ABI is below the profiles\' ABI 6; some requested restrictions are unavailable', 'Use a host kernel supporting ABI 6 or newer; retain external egress and host-integration controls.');
    this.add('Kernel', 'kernel.pathname-sockets', 'warn', 'Current ABI 6 profiles do not enforce pathname Unix-socket connection isolation', 'Disable unwanted socket forwarding on the host; repeat doctor after IDE attach/reconnect.');
  }

  async storage(manifest) {
    await this.check('Resources', 'resources.limits', () => {
      const limits = readLimits();
      this.report.system.limits = limits;
      for (const [name, value, label] of [['memory', limits.memory, 'bytes'], ['pids', limits.pids, 'processes'], ['cpus', limits.cpus, 'CPUs']]) {
        this.add('Resources', `resources.${name}`, value ? 'pass' : 'warn', value ? `Cgroup ${name} limit: ${value} ${label}` : `Finite cgroup ${name} limit could not be verified`, 'Set and verify Docker memory, CPU, and process limits on the host.');
      }
      if (limits.memory && limits.memoryUsed / limits.memory > 0.85) this.add('Resources', 'resources.memory-pressure', 'warn', 'Container memory use exceeds 85% of its limit', 'Reduce running workloads or increase the reviewed memory limit.');
      if (limits.pids && limits.pidsUsed / limits.pids > 0.85) this.add('Resources', 'resources.pid-pressure', 'warn', 'Process use exceeds 85% of its limit', 'Review running workloads and the process limit.');
      if (limits.memory && v8.getHeapStatistics().heap_size_limit > limits.memory) this.add('Resources', 'resources.node-heap', 'warn', 'Node heap limit exceeds the container memory limit', 'Lower NODE_OPTIONS --max-old-space-size or raise the container memory limit.');
    }, 'Check the container cgroup mounts and host resource limits.');
    const dependencies = (manifest.dependencies || []).filter(value => typeof value === 'string' && value && !path.isAbsolute(value) && !value.split('/').includes('..'));
    const targets = [...new Set(['/workspace', '/home/dev', '/tmp/didcon', ...dependencies.map(value => '/workspace/' + value)])];
    for (const target of targets) {
      await this.check('Storage', 'storage.' + target, () => {
        const stat = fs.statfsSync(target);
        const free = stat.bavail * stat.bsize;
        const ratio = stat.blocks ? stat.bavail / stat.blocks : 1;
        const inodeRatio = stat.files ? stat.ffree / stat.files : 1;
        this.add('Storage', 'storage.space.' + target, free < 1024 * 1024 ? 'fail' : ratio < 0.1 || inodeRatio < 0.05 ? 'warn' : 'pass',
          `${target}: ${Math.floor(free / 1024 / 1024)} MiB available; ${Math.round(inodeRatio * 100)}% inodes free`, 'Free space/inodes or increase the host allocation before continuing work.');
        const scratch = fs.mkdtempSync(path.join(target, '.didcon-doctor-'));
        try { fs.writeFileSync(path.join(scratch, 'probe'), 'didcon doctor\n', { mode: 0o600 }); }
        finally { fs.rmSync(scratch, { recursive: true, force: true }); }
        this.add('Storage', 'storage.write.' + target, 'pass', `Small write probe succeeded and was removed: ${target}`);
      }, 'Check mount permissions, volume ownership, disk capacity, and startup initialization.');
    }
    this.storageBounds(targets);
  }

  storageBounds(targets, filesystem = fs) {
    const limits = inspectStorageLimits(targets, filesystem);
    this.report.storageLimits = limits;
    for (const limit of limits) {
      const target = JSON.stringify(limit.path);
      if (limit.state === 'bounded') {
        this.add('Storage', 'storage.limit.' + limit.path, 'pass',
          `Verified tmpfs byte limit for ${target}: ${limit.limitBytes} bytes (filesystem mounted at ${JSON.stringify(limit.mountPoint)})`);
      } else if (limit.state === 'read-only') {
        this.add('Storage', 'storage.limit.' + limit.path, 'pass',
          `Writes blocked through read-only mount for ${target}: ${JSON.stringify(limit.mountPoint)}`);
      } else {
        const reason = limit.reason === 'filesystem-quota-not-queried' ?
          `${limit.filesystem} filesystem; quota enforcement and hard limits have not been queried${limit.quotaFlags?.length ? ' (quota-related mount flags are present)' : ''}` :
          limit.reason === 'tmpfs-capacity-unverified' ? 'tmpfs capacity could not be verified' : 'path or mount information unavailable';
        this.add('Storage', 'storage.limit.' + limit.path, 'warn', `Write limit unverified for ${target}: ${reason}`,
          'Verify an enforced host/filesystem quota for this storage location. Free space and quota mount flags alone do not prove a hard limit; separate writable mounts need their own coverage.');
      }
    }
  }

  async integrations() {
    for (const filename of ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock']) {
      if (!fs.existsSync(filename)) continue;
      const result = await probeSocket(filename);
      this.add('Integrations', 'socket.' + filename, result.exposed ? 'fail' : 'pass', result.exposed ? `Container-engine socket reachable or unverified: ${filename}` : `Container-engine socket unavailable: ${filename}`, 'Remove container-engine socket forwarding and rebuild.');
    }
    if (process.env.DOCKER_HOST || process.env.CONTAINER_HOST) this.add('Integrations', 'integrations.engine-env', 'warn', 'A container-engine endpoint is configured in the environment (value suppressed)', 'Review whether access to the host container engine is intended.');
    this.add('Integrations', 'integrations.scope', 'skip', 'IDE settings, host quotas, sidecar capabilities, and real agent authentication require separate host/workflow checks');
  }

  async trust(manifest) {
    const issues = proxyEnvironmentIssues(process.env, manifest.identity);
    for (let index = 0; index < issues.length; index++) this.add('Egress', `proxy.environment.${index}`, 'fail', issues[index], 'Restore the generated proxy/trust environment and rebuild.');
    if (!issues.length) this.add('Egress', 'proxy.environment', 'pass', 'Proxy variables and trust-store paths match the reviewed endpoint');
    const insecure = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || /^(1|true|yes)$/i.test(process.env.GIT_SSL_NO_VERIFY || '') ||
      /^(0|false|no)$/i.test(process.env.PYTHONHTTPSVERIFY || '');
    this.add('Egress', 'proxy.tls-verification', insecure ? 'fail' : 'pass', insecure ? 'TLS verification is disabled in the environment (values suppressed)' : 'No known environment override disables TLS verification', 'Remove TLS-verification bypasses and fix CA trust instead.');
    const git = await runCommand('/usr/bin/git', ['config', '--bool', '--get-regexp', '^http([.].*)?[.]sslverify$'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (git.ok && /\sfalse\s*$/m.test(git.stdout)) this.add('Egress', 'proxy.git-tls', 'fail', 'Git configuration disables upstream TLS verification', 'Enable http.sslVerify and use the configured CA bundle.');
    else if (git.code !== 0 && git.code !== 1) this.add('Egress', 'proxy.git-tls', 'fail', 'Git TLS configuration could not be inspected', 'Review Git configuration without printing credential values.');
    await this.check('Egress', 'proxy.ca', () => {
      const names = fs.readdirSync('/etc/didcon/trust');
      const pem = fs.readFileSync('/etc/didcon/trust/ca.pem', 'utf8');
      const certificate = new X509Certificate(pem);
      const expiry = Date.parse(certificate.validTo);
      const valid = names.length === 1 && names[0] === 'ca.pem' && !pem.includes('PRIVATE KEY') && certificate.ca && Date.parse(certificate.validFrom) <= Date.now() && expiry > Date.now();
      if (!valid) throw new Error('invalid public trust');
      this.ca = pem;
      this.add('Egress', 'proxy.ca', expiry - Date.now() < 30 * 86400000 ? 'warn' : 'pass', `Public-only proxy CA valid until ${new Date(expiry).toISOString().slice(0, 10)}`, 'Review CA rotation before expiry; preserve private-volume isolation.');
      const trusted = fs.readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8').includes(pem.trim());
      this.add('Egress', 'proxy.system-trust', trusted ? 'pass' : 'fail', trusted ? 'Proxy CA is present in the system trust store' : 'System trust store does not contain the proxy CA', 'Rebuild/restart through the supported entrypoint to configure trust.');
    }, 'Check certificate initialization and public trust mounts; do not mount private CA keys into the development container.');
  }

  async preflight() {
    const result = await runCommand('/bin/bash', ['-c', 'exec /bin/bash "$@" 2>&1', 'didcon-doctor-preflight',
      path.join(__dirname, 'security-preflight.sh'), ...(this.options.offline ? ['--offline'] : [])],
      { timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', DIDCON_PREFLIGHT_HOST_JSON: '1',
        DIDCON_PREFLIGHT_CREDENTIAL_FIXTURE: this.options.credentialFixture ? '1' : '0' } });
    const parsed = preflightGroups(result.stdout);
    this.report.preflight = parsed.totals;
    for (const group of parsed.groups) {
      const status = group.fail ? 'fail' : group.warn ? 'warn' : group.pass ? 'pass' : 'skip';
      this.add('Security preflight', 'preflight.' + group.name, status,
        `${group.name}: ${group.pass} passed, ${group.fail} failed, ${group.warn} warnings`,
        status === 'fail' || status === 'warn' ? group.name.startsWith('Host integrations') ?
          'Review the socket paths. From the project root on the host, run python3 .devcontainer/host/acknowledge-doctor-socket-risk.py to record diagnostic risk acceptance (FAIL to WARN only). Socket access remains unchanged; other failures remain strict.' :
          'Run /opt/scripts/security-preflight.sh locally for detailed checks; review output before sharing.' : undefined, group.details);
    }
    const outcome = preflightOutcome(result, parsed);
    if (outcome === 'incomplete') {
      this.report.complete = false;
      this.add('Security preflight', 'preflight.complete', 'fail',
        result.timedOut ? 'Security preflight exceeded its 180-second deadline' : 'Security preflight failed or could not finish',
        'Run /opt/scripts/security-preflight.sh in an ordinary container terminal after postCreateCommand completes.');
    } else if (outcome === 'passed') this.add('Security preflight', 'preflight.complete', 'pass', `Preflight summary: ${parsed.totals.pass} passed, 0 failed, ${parsed.totals.warn} warnings`);
  }

  async network() {
    if (this.options.offline) {
      this.add('Egress', 'proxy.live', 'skip', 'Live proxy/TLS checks skipped in offline mode');
      this.add('Egress', 'proxy.offline', 'warn', 'Offline report does not verify live network enforcement', 'Rerun didcon-doctor without --offline.');
      return;
    }
    let proxy;
    try {
      proxy = new URL(process.env.HTTPS_PROXY);
      if (proxy.protocol !== 'http:' || !net.isIPv4(proxy.hostname) || proxy.port !== '443' || proxy.username || proxy.password || !this.ca) throw new Error();
    } catch {
      this.add('Egress', 'proxy.live', 'fail', 'Live TLS checks require the configured proxy and valid public CA', 'Restore proxy configuration and trust before retrying.');
      return;
    }
    let allowed = false;
    await this.check('Egress', 'proxy.https', async () => {
      const result = await proxyProbe(proxy, this.ca);
      allowed = result.stage === 'response' && result.status === 200;
      this.add('Egress', 'proxy.https', allowed ? 'pass' : 'fail', allowed ? 'Allowed HTTPS succeeds with verified proxy CA trust' : 'Allowed HTTPS did not return the expected response', 'Check proxy startup, allowed-hosts.txt, upstream DNS, and certificate trust.');
    }, 'Check proxy startup, upstream reachability, and certificate trust.');
    await this.check('Egress', 'proxy.connect-denial', async () => {
      const result = await proxyProbe(proxy, this.ca, { connectHost: 'didcon-doctor.invalid' });
      const denied = result.stage === 'connect' && result.status === 403 && result.denial;
      this.add('Egress', 'proxy.connect-denial', denied ? 'pass' : 'fail', denied ? 'Unlisted CONNECT is denied by policy' : 'Unlisted CONNECT policy denial was not verified', 'Review the sidecar allowlist and mandatory inspection configuration.');
    }, 'Check the proxy denial policy and connectivity.');
    if (!allowed) {
      this.add('Egress', 'proxy.identity', 'skip', 'SNI/Host checks require a successful allowed HTTPS baseline');
      return;
    }
    for (const [id, sni] of [['mismatched-sni', 'didcon-doctor.invalid'], ['missing-sni', '']]) {
      let denied = false;
      try { await proxyProbe(proxy, this.ca, { sni, verify: false }); }
      catch (error) { denied = error.stage === 'tls' && error.code !== 'ETIMEDOUT'; }
      this.add('Egress', 'proxy.' + id, denied ? 'pass' : 'fail', denied ? `${id}: proxy rejects the TLS handshake even when the client ignores certificate errors` : `${id}: proxy enforcement could not be verified`, 'Rebuild the Smokescreen wrapper and verify CONNECT/SNI equality.');
    }
    await this.check('Egress', 'proxy.host-mismatch', async () => {
      const result = await proxyProbe(proxy, this.ca, { authority: 'github.com' });
      const denied = result.stage === 'response' && result.status === 403 && result.denial;
      this.add('Egress', 'proxy.host-mismatch', denied ? 'pass' : 'fail', denied ? 'Encrypted Host differing from CONNECT is denied' : 'Encrypted Host equality could not be verified', 'Rebuild the Smokescreen wrapper and verify decrypted authority checks.');
    }, 'Check proxy availability and decrypted Host enforcement.');
  }
}

async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseOptions(args); } catch (error) { console.error(error.message); return 2; }
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (!options.json) console.log('didcon doctor — built-container diagnostics');
  const doctor = new Doctor(options, options.json ? undefined : check => {
    console.log(`[${check.status.toUpperCase()}] ${check.section}: ${check.message}`);
    for (const detail of check.details || []) console.log(`  - ${detail.message}`);
    if (check.remediation && ['fail', 'warn'].includes(check.status)) console.log(`  Fix: ${check.remediation}`);
  });
  let report;
  try { report = await doctor.run(); }
  catch {
    doctor.report.complete = false;
    doctor.add('Runtime', 'doctor.unexpected', 'fail', 'Doctor could not complete all checks', 'Run from an ordinary dev container terminal; rebuild to restore diagnostic files.');
    report = doctor.finish();
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`\nSummary: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.warn} warnings, ${report.summary.skip} skipped (${report.status})`);
  return report.summary.fail || options.strict && report.summary.warn ? 1 : 0;
}

module.exports = { parseOptions, summary, inspectProcess, finiteLimit, toolVersion, readLimits, proxyEnvironmentIssues, preflightGroups, preflightOutcome, proxyProbe, runCommand, Doctor, main };
if (require.main === module) {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => { children.forEach(killGroup); process.exit(code); });
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Doctor could not complete; run from an ordinary dev container terminal.'); process.exitCode = 1; });
}
