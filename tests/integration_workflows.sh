#!/bin/bash
# Runs as dev in the disposable proxy project. No agent login or real credentials.
set -euo pipefail

echo 'TEST: sandboxed CLI versions'
for tool in claude codex npm npx pnpm git; do
    "$tool" --version
done

echo 'TEST: pinned safe-chain installation through TLS inspection'
/bin/sh /opt/scripts/install-safe-chain.sh
/bin/bash -i -c 'npm safe-chain-verify'

mkdir -p /workspace/workflow-npm /workspace/workflow-pnpm
cat > /workspace/workflow-npm/package.json <<'JSON'
{"name":"didcon-workflow-npm","version":"1.0.0","private":true,"scripts":{"probe":"node probe.cjs"}}
JSON
cat > /workspace/workflow-npm/probe.cjs <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
assert.throws(() => fs.readFileSync('/var/log/firewall-status.txt'), error => error.code === 'EACCES');
if (process.env.DIDCON_PARENT_SCRATCH) {
  assert.equal(fs.readFileSync(process.env.DIDCON_PARENT_SCRATCH, 'utf8'), 'parent fixture');
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'didcon-workflow-'));
fs.writeFileSync(path.join(scratch, 'probe'), 'fixture');
fs.rmSync(scratch, { recursive: true });
console.log('PASS: lifecycle child inherits filesystem restrictions and can use its scratch path');
JS

echo 'TEST: interactive safe-chain npm package installation'
cd /workspace/workflow-npm
/bin/bash -i -c 'npm install --no-audit --no-fund is-number@7.0.0'
/usr/bin/node -e 'if (!require("is-number")(42)) process.exit(1)'
/usr/local/bin/npm run --silent probe
mkdir -p node_modules/.bin
cat > node_modules/.bin/didcon-workflow-probe <<'SH'
#!/bin/sh
exec /usr/bin/node /workspace/workflow-npm/probe.cjs
SH
chmod 755 node_modules/.bin/didcon-workflow-probe
/usr/local/bin/npx --offline --no-install didcon-workflow-probe

echo 'TEST: nested agent-profile to npm scratch and lifecycle execution'
for profile in claude-code codex herdr; do
    XDG_CONFIG_HOME=/etc /usr/local/bin/island run -p "$profile" -- \
        /usr/bin/node -e '
          const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
          const directory=fs.mkdtempSync(path.join(os.tmpdir(),"didcon-parent-"));
          const fixture=path.join(directory,"input"); fs.writeFileSync(fixture,"parent fixture");
          try { cp.execFileSync("/usr/local/bin/npm",["run","--silent","probe"],{
            cwd:"/workspace/workflow-npm",env:{...process.env,DIDCON_PARENT_SCRATCH:fixture},stdio:"inherit"
          }); } finally { fs.rmSync(directory,{recursive:true}); }
        '
done

echo 'TEST: interactive safe-chain pnpm package installation'
cd /workspace/workflow-pnpm
printf '%s\n' '{"name":"didcon-workflow-pnpm","version":"1.0.0","private":true}' > package.json
/bin/bash -i -c 'pnpm add --ignore-scripts is-number@7.0.0'
/usr/bin/node -e 'if (!require("is-number")(42)) process.exit(1)'

echo 'TEST: sandboxed public Git HTTPS transport'
cd /workspace
/usr/local/bin/git -c credential.helper= -c core.hooksPath=/dev/null \
    ls-remote https://github.com/landlock-lsm/island.git HEAD >/dev/null

echo 'TEST: full production preflight after safe-chain installation'
/bin/bash /opt/scripts/security-preflight.sh

echo 'PASS: Node agent CLI, safe-chain, npm/npx/pnpm, nested scratch, and Git HTTPS smoke tests'
