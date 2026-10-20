import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createConnectionManager, shellQuote } from '../src/main/connections.mjs';
import { createCliAdapter } from '../src/main/cli.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-collab-connections-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'app data');
  const binaryDirectory = path.join(home, '.local/bin');
  await mkdir(binaryDirectory, { recursive: true });
  const opened = [];
  const applied = [];
  let statuses = { codex: { path: path.join(binaryDirectory, 'codex') }, claude: { path: path.join(binaryDirectory, 'claude') } };
  const options = { userData, home, platform: process.platform === 'win32' ? 'win32' : 'darwin', env: { CODEX_HOME: path.join(root, 'existing auth home'), OPENAI_API_KEY: 'never-store-this', ANTHROPIC_AUTH_TOKEN: 'never-store-that' },
    discoverProviders: async () => statuses,
    configureProviderPaths: value => applied.push(structuredClone(value)),
    openTerminal: async file => opened.push(file) };
  const manager = createConnectionManager(options);
  await manager.init();
  return { root, home, userData, binaryDirectory, manager, options, opened, applied, setStatuses(value) { statuses = value; } };
}

async function executable(file, source) {
  await writeFile(file, source, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

test('selected executable paths persist without credentials and survive restart/reset', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const binary = await executable(path.join(f.binaryDirectory, 'custom codex'), '#!/bin/sh\nexit 0\n');
  await f.manager.setExecutable('codex', binary);
  const settingsPath = path.join(f.userData, 'connections.json');
  const saved = await readFile(settingsPath, 'utf8');
  assert.deepEqual(JSON.parse(saved), { version: 1, paths: { codex: binary, claude: null } });
  assert.ok(!saved.includes('never-store'));
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  const restarted = createConnectionManager(f.options);
  assert.deepEqual(await restarted.init(), { codex: binary, claude: null });
  await restarted.clearExecutable('codex');
  assert.deepEqual(f.applied.at(-1), { codex: null, claude: null });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).paths, { codex: null, claude: null });
});

test('path selection rejects directories, missing/nonexecutable files, and invalid provider/path inputs', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const ordinary = path.join(f.root, 'not executable');
  await writeFile(ordinary, 'text', { mode: 0o600 });
  for (const file of [f.root, ordinary, path.join(f.root, 'missing')]) await assert.rejects(f.manager.setExecutable('codex', file), /runnable/);
  await assert.rejects(f.manager.setExecutable('codex', 'relative'), /absolute/);
  await assert.rejects(f.manager.setExecutable('other', ordinary), /Unknown assistant/);
  await assert.rejects(f.manager.setupProvider('codex', 'untrusted-command'), /Unknown setup action/);
  assert.deepEqual(f.manager.getConfiguredPaths(), { codex: null, claude: null });
});

test('an explicit missing path never falls back; adapter configuration changes discovery and execution together', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const automatic = await executable(path.join(f.root, 'automatic-codex'), `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('automatic');else console.log('Logged in using ChatGPT');\n`);
  const selected = await executable(path.join(f.root, 'selected-codex'), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.includes('--version'))console.log('selected');else if(args.includes('status'))console.log('Logged in using ChatGPT');else {process.stdin.resume();process.stdin.on('end',()=>{for(const event of [{type:'item.completed',item:{id:'answer',type:'agent_message',text:'Selected executable answer.'}},{type:'turn.completed'}])console.log(JSON.stringify(event));});}\n`);
  const adapter = createCliAdapter({ home: f.home, env: { PATH: '/usr/bin:/bin' }, candidates: { codex: [automatic], claude: [] },
    stat: async file => { if (![automatic, selected].includes(file)) throw new Error('Not a test executable'); return stat(file); } });
  adapter.configureProviderPaths({ codex: path.join(f.root, 'missing-selected') });
  let status = (await adapter.discoverProviders()).codex;
  assert.equal(status.available, false);
  assert.equal(status.path, null);
  assert.match(status.error, /selected.*missing/);
  await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Test only', cwd: f.root }), /selected.*missing/);
  adapter.configureProviderPaths({ codex: selected });
  status = (await adapter.discoverProviders()).codex;
  assert.equal(status.path, selected);
  assert.equal(status.configuredPath, selected);
  assert.equal(status.version, 'selected');
  const answer = await adapter.runProvider({ provider: 'codex', prompt: 'Test only', cwd: f.root });
  assert.equal(answer.text, 'Selected executable answer.');
  adapter.configureProviderPaths({});
  assert.equal((await adapter.discoverProviders()).codex.path, automatic);
});

test('login uses the exact chosen executable, safely quotes shell syntax, and reports only completion status', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const record = path.join(f.root, 'login-args.txt');
  const chosen = await executable(path.join(f.root, "codex ' $(touch injected) ; #"), `#!/bin/bash\nprintf '%s\\n' "$@" > ${shellQuote(record)}\n[[ -z "\${OPENAI_API_KEY+x}" && -z "\${ANTHROPIC_PROFILE+x}" && -z "\${ANTHROPIC_FEDERATION_TOKEN+x}" && -z "\${CODEX_THREAD_ID+x}" ]] || exit 9\n[[ "$CODEX_HOME" == ${shellQuote(f.options.env.CODEX_HOME)} ]] || exit 10\n`);
  f.setStatuses({ codex: { path: chosen } });
  const operation = await f.manager.setupProvider('codex', 'login');
  assert.equal(f.opened.length, 1);
  const script = await readFile(f.opened[0], 'utf8');
  assert.ok(script.includes(shellQuote(chosen)));
  assert.ok(!script.includes('never-store'));
  assert.equal((await stat(f.opened[0])).mode & 0o777, 0o700);
  assert.deepEqual(await f.manager.getSetupResult(operation.operationId), { complete: false });
  await execute('/bin/bash', [f.opened[0]], { cwd: f.root, env: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'fixture-only', ANTHROPIC_PROFILE: 'fixture-only', ANTHROPIC_FEDERATION_TOKEN: 'fixture-only', CODEX_THREAD_ID: 'fixture-only' } });
  assert.equal(await readFile(record, 'utf8'), 'login\n');
  await assert.rejects(access(path.join(f.root, 'injected')));
  assert.deepEqual(await f.manager.getSetupResult(operation.operationId), { complete: true, exitCode: 0 });
  const resultPath = path.join(f.userData, 'setup', `${operation.operationId}.result`);
  assert.equal(await readFile(resultPath, 'utf8'), '0\n');
  await assert.rejects(f.manager.getSetupResult('../../credentials'), /Unknown setup operation/);
});

test('official installer pipelines stop on download failure before login and write an exit-code marker', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const loggedIn = path.join(f.root, 'login-was-called');
  await executable(path.join(f.binaryDirectory, 'curl'), '#!/bin/sh\nexit 22\n');
  for (const provider of ['codex', 'claude']) {
    await executable(path.join(f.binaryDirectory, provider), `#!/bin/sh\ntouch ${shellQuote(loggedIn)}\n`);
    const operation = await f.manager.setupProvider(provider, 'install');
    const script = f.opened.at(-1);
    const contents = await readFile(script, 'utf8');
    assert.ok(contents.includes(provider === 'codex' ? 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' : 'curl -fsSL https://claude.ai/install.sh | bash'));
    await assert.rejects(execute('/bin/bash', [script], { env: { PATH: '/usr/bin:/bin' } }), error => error.code === 22);
    await assert.rejects(access(loggedIn));
    assert.deepEqual(await f.manager.getSetupResult(operation.operationId), { complete: true, exitCode: 22 });
    assert.equal(f.manager.getConfiguredPaths()[provider], path.join(f.binaryDirectory, provider));
  }
});

test('successful stub installers proceed to subscription login at the selected native destination', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const record = path.join(f.root, 'commands.txt');
  await executable(path.join(f.binaryDirectory, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(record)}\nprintf 'exit 0\\n'\n`);
  for (const provider of ['codex', 'claude']) {
    await executable(path.join(f.binaryDirectory, provider), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(record)}\n`);
    const operation = await f.manager.setupProvider(provider, 'install');
    await execute('/bin/bash', [f.opened.at(-1)], { env: { PATH: '/usr/bin:/bin', CODEX_INSTALL_DIR: '/wrong/inherited/destination' } });
    assert.deepEqual(await f.manager.getSetupResult(operation.operationId), { complete: true, exitCode: 0 });
  }
  const commands = await readFile(record, 'utf8');
  assert.equal(commands, '-fsSL https://chatgpt.com/codex/install.sh\nlogin\n-fsSL https://claude.ai/install.sh\nauth login\n');
  assert.ok((await readFile(f.opened[0], 'utf8')).includes(`export CODEX_INSTALL_DIR=${shellQuote(f.binaryDirectory)}`));
});

test('Terminal launch errors restore the previous override and no missing executable can be logged into', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const manager = createConnectionManager({ ...f.options, openTerminal: async () => { throw new Error('launch failed with private details'); } });
  await manager.init();
  await assert.rejects(manager.setupProvider('codex', 'install'), /Terminal could not be opened/);
  assert.deepEqual(manager.getConfiguredPaths(), { codex: null, claude: null });
  f.setStatuses({ codex: { path: null } });
  await assert.rejects(manager.setupProvider('codex', 'login'), /Choose or install/);
});

test('malformed saved paths fail explicitly instead of choosing a different installation', async t => {
  const f = await fixture(t);
  await mkdir(f.userData, { recursive: true });
  await writeFile(path.join(f.userData, 'connections.json'), '{"version":1,"paths":{"codex":"relative"}}');
  const manager = createConnectionManager(f.options);
  await assert.rejects(manager.init(), /absolute/);
});
