import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { createCliAdapter, subscriptionEnvironment } from '../src/main/cli.mjs';
import { createModelDiscovery } from '../src/main/models.mjs';
import { buildPowerShellSetupScript, openSetupTerminal, powerShellQuote } from '../src/main/connections.mjs';
import { terminateProcessTree, windowsSystemExecutable } from '../src/main/processes.mjs';

function child(pid = 73123) {
  const value = new EventEmitter();
  value.pid = pid; value.stdin = new PassThrough(); value.stdout = new PassThrough(); value.stderr = new PassThrough();
  value.kill = () => true; value.unref = () => {};
  return value;
}
const home = 'C:\\Users\\A User';

test('Windows environment removes credential variants, retains existing login homes and normalizes Path once', () => {
  const source = { Path: 'C:\\Node;C:\\Users\\A User\\bin', openai_api_key: 'secret', Codex_Access_Token: 'secret', Anthropic_Auth_Token: 'secret', Node_Options: 'unsafe', CODEX_HOME: 'D:\\Existing Login', CLAUDE_CONFIG_DIR: 'D:\\Claude Login' };
  const env = subscriptionEnvironment(source, 'win32');
  assert.equal(env.PATH, source.Path);
  assert.equal(env.Path, undefined);
  for (const name of ['openai_api_key', 'Codex_Access_Token', 'Anthropic_Auth_Token', 'Node_Options']) assert.equal(env[name], undefined);
  assert.equal(env.CODEX_HOME, source.CODEX_HOME); assert.equal(env.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
  assert.equal(source.openai_api_key, 'secret');
});

test('Windows discovery finds native Codex and npm Claude launchers without relying on inherited PATH', async () => {
  const codex = path.win32.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const claude = path.win32.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd');
  const calls = [];
  const adapter = createCliAdapter({ platform: 'win32', home, env: { Path: '' },
    stat: async file => ({ isFile: () => [codex, claude].includes(file) }), access: async () => {},
    spawn(binary, args, options) {
      calls.push({ binary, args, options }); const process = child();
      process.stdin.on('finish', () => queueMicrotask(() => {
        if (args.includes('--version')) process.stdout.write(binary === codex ? 'codex-cli 0.162.0' : '2.1.304 (Claude Code)');
        else if (binary === codex) process.stderr.write('Logged in using ChatGPT');
        else process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
        process.emit('close', 0);
      })); return process;
    },
  });
  const result = await adapter.discoverProviders();
  assert.equal(result.codex.path, codex); assert.equal(result.claude.path, claude);
  assert.equal(result.codex.authenticated, true); assert.equal(result.claude.authenticated, true);
  assert.ok(calls.every(call => call.options.shell === false && call.options.detached === false));
  adapter.configureProviderPaths({ codex: 'D:\\Exact Missing\\codex.exe' });
  assert.equal((await adapter.discoverProviders()).codex.available, false, 'an explicit path never falls back to another installation/account');
  assert.throws(() => adapter.configureProviderPaths({ codex: 'C:\\scripts\\codex.ps1' }), /executable path/);
});

test('Windows cancellation invokes taskkill on the owned PID and waits for descendant cleanup', async () => {
  const process = child(); const killer = child(73124); const calls = [];
  const options = { platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, spawn(binary, args, options) { calls.push({ binary, args, options }); return killer; } };
  let finished = false;
  const stop = terminateProcessTree(process, options).then(() => { finished = true; });
  const repeated = terminateProcessTree(process, options, 'SIGKILL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, 'D:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(calls[0].args, ['/PID', String(process.pid), '/T', '/F']);
  await Promise.resolve(); assert.equal(finished, false);
  killer.emit('close', 0); await Promise.all([stop, repeated]); assert.equal(finished, true);
});

test('Windows model catalog cleanup terminates the full app-server process tree', async () => {
  const stopped = [];
  const discovery = createModelDiscovery({ platform: 'win32', env: {}, timeoutMs: 1000,
    discoverProviders: async () => ({ codex: { available: true, authenticated: true, path: 'C:\\CLI\\codex.cmd' }, claude: { available: false } }),
    makeWorkspace: async () => 'C:\\Isolated', removeWorkspace: async () => {},
    spawn(binary, args, options) {
      assert.equal(binary, 'C:\\CLI\\codex.cmd'); assert.equal(options.detached, false);
      const process = child();
      process.stdin.on('data', bytes => {
        for (const line of bytes.toString().trim().split('\n')) {
          const message = JSON.parse(line);
          if (message.method === 'initialize') queueMicrotask(() => process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n'));
          if (message.method === 'model/list') queueMicrotask(() => process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ model: 'available-model' }] } }) + '\n'));
        }
      }); return process;
    },
    terminateSpawn(binary, args) { stopped.push({ binary, args }); const process = child(); queueMicrotask(() => process.emit('close', 0)); return process; },
  });
  assert.equal((await discovery.discoverModels()).codex.source, 'live');
  assert.equal(stopped.length, 1); assert.deepEqual(stopped[0].args, ['/PID', '73123', '/T', '/F']);
});

test('Windows Claude catalog kills its process tree before SDK close can detach descendants', async () => {
  const order = [];
  const discovery = createModelDiscovery({ platform: 'win32', env: {}, timeoutMs: 1000,
    discoverProviders: async () => ({ codex: { available: false }, claude: { available: true, authenticated: true, path: 'C:\\CLI\\claude.cmd' } }),
    makeWorkspace: async () => 'C:\\Isolated', removeWorkspace: async () => {},
    spawn: () => child(),
    terminateSpawn() { const proc = child(); queueMicrotask(() => { order.push('tree-stopped'); proc.emit('close', 0); }); return proc; },
    loadClaudeSdk: async () => ({ query({ options }) {
      options.spawnClaudeCodeProcess({ command: options.pathToClaudeCodeExecutable, args: [], cwd: options.cwd, env: options.env });
      return { supportedModels: async () => [{ value: 'opus', displayName: 'Opus' }], close() { order.push('sdk-close'); } };
    } }),
  });
  assert.equal((await discovery.discoverModels()).claude.source, 'live');
  assert.deepEqual(order, ['tree-stopped', 'sdk-close']);
});

test('PowerShell setup quotes selected paths, uses only official installers and records exit codes atomically', () => {
  const binary = "C:\\Users\\O'Brien $test & name\\codex.exe";
  const resultPath = 'C:\\App Data\\operation.result';
  const env = { CODEX_HOME: "C:\\Existing ' login", OPENAI_API_KEY: 'never-store-credentials', CODEX_INSTALL_DIR: 'C:\\Wrong' };
  const login = buildPowerShellSetupScript({ provider: 'codex', action: 'login', binary, resultPath, home, env });
  assert.ok(login.includes(`& ${powerShellQuote(binary)} login`));
  assert.ok(login.includes(`$env:CODEX_HOME = ${powerShellQuote(env.CODEX_HOME)}`));
  assert.ok(!login.includes('never-store-credentials')); assert.ok(!login.includes('Invoke-WebRequest'));
  assert.match(login, /Set-Content -LiteralPath.*\.tmp.*Encoding ASCII/);
  assert.match(login, /Move-Item -LiteralPath.*\.tmp.*-Destination \$_aiCollabResult/);
  for (const provider of ['codex', 'claude']) {
    const script = buildPowerShellSetupScript({ provider, action: 'install', binary: binary.replace('codex.exe', provider + '.exe'), resultPath, home, env });
    assert.ok(script.includes(provider === 'codex' ? 'https://chatgpt.com/codex/install.ps1' : 'https://claude.ai/install.ps1'));
    assert.ok(script.indexOf('if ($LASTEXITCODE -ne 0)') < script.indexOf(`& ${powerShellQuote(binary.replace('codex.exe', provider + '.exe'))} `), 'installer failure is checked before sign-in');
    assert.ok(script.includes('-NoProfile -ExecutionPolicy Bypass -File $_aiCollabInstaller'));
    if (provider === 'codex') assert.ok(script.includes(`$env:CODEX_INSTALL_DIR = ${powerShellQuote(path.win32.dirname(binary))}`));
  }
});

test('Windows setup launches a visible independent PowerShell with a literal -File argument', async () => {
  const calls = [];
  const file = "C:\\A User's folder & text\\setup.ps1";
  await openSetupTerminal(file, { platform: 'win32', env: { OPENAI_API_KEY: 'secret', SystemRoot: 'C:\\Windows' }, spawn(binary, args, options) {
    calls.push({ binary, args, options }); const process = child(); queueMicrotask(() => process.emit('spawn')); return process;
  } });
  assert.match(calls[0].binary, /WindowsPowerShell\\v1.0\\powershell.exe$/);
  assert.deepEqual(calls[0].args.slice(-2), ['-File', file]);
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, false);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
});

test('native Windows cmd launchers preserve literal arguments, empty tools and UTF-8 stdin', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-collab cmd test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'arguments.cjs'); const launcher = path.join(directory, 'claude.cmd');
  await writeFile(script, "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),text})));\n");
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args = ['--tools', '', 'model&literal', 'with spaces', 'quote"text', '%PATH%', '!literal!'];
  const proc = crossSpawn(launcher, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; proc.stdout.on('data', bytes => { output += bytes; });
  const done = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`))); });
  proc.stdin.end('Private prompt: café and quotation " characters.'); await done;
  assert.deepEqual(JSON.parse(output), { args, text: 'Private prompt: café and quotation " characters.' });
});

test('native PowerShell setup stops failed installers and logs in only after successful installation', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-collab O'Brien & setup "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = path.join(directory, 'login.txt');
  const binary = path.join(directory, 'codex.cmd');
  await writeFile(binary, `@echo off\r\nif defined OPENAI_API_KEY exit /b 7\r\necho %* > "${record}"\r\nexit /b 0\r\n`);
  for (const code of [22, 0]) {
    const resultPath = path.join(directory, `setup-${code}.result`);
    const scriptPath = path.join(directory, `setup-${code}.ps1`);
    // This replaces only the network download with a local stub installer. No
    // provider login or installer is run by the test.
    const mockDownload = `function Invoke-WebRequest { param($UseBasicParsing, $Uri, $OutFile) Set-Content -LiteralPath $OutFile -Value 'exit ${code}' }\r\n`;
    const script = buildPowerShellSetupScript({ provider: 'codex', action: 'install', binary, resultPath, home: directory, env: process.env });
    await writeFile(scriptPath, '\ufeff' + mockDownload.replace('$UseBasicParsing', '[switch]$UseBasicParsing') + script, 'utf8');
    await promisify(execFile)(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { env: { ...process.env, OPENAI_API_KEY: 'must-be-removed' }, timeout: 15000 });
    assert.equal((await readFile(resultPath, 'utf8')).trim(), code === 0 ? '0' : '1');
    if (code !== 0) await assert.rejects(readFile(record), { code: 'ENOENT' });
    else assert.equal((await readFile(record, 'utf8')).trim(), 'login');
  }
});
