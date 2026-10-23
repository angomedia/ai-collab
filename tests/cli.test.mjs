import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCliAdapter, createOutputParser, providerArguments, subscriptionEnvironment } from '../src/main/cli.mjs';

const codexCompletion = [{ type: 'thread.started', thread_id: 'test-session' }, { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'An answer.' } }, { type: 'turn.completed', usage: { input_tokens: 14, output_tokens: 3 } }];
function fixture({ events = codexCompletion, stderr = '', code = 0, hang = false, auth = 'subscription', stdoutChunks, temporaryRoot, claudeVersion = '2.1.260' } = {}) {
  const calls = [];
  const killed = [];
  const children = new Map();
  let nextPid = 910000;
  const spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.pid = ++nextPid;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    children.set(child.pid, child);
    const call = { binary, args, options, input: '', child };
    if (args.includes('--output-schema')) {
      call.schemaPath = args[args.indexOf('--output-schema') + 1];
      call.schema = JSON.parse(readFileSync(call.schemaPath, 'utf8'));
      call.schemaMode = statSync(call.schemaPath).mode & 0o777;
      call.schemaDirectoryMode = statSync(path.dirname(call.schemaPath)).mode & 0o777;
    }
    calls.push(call);
    child.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
    child.stdin.on('finish', () => setImmediate(() => {
      const isClaude = binary.includes('claude');
      if (args.includes('--version')) child.stdout.write(isClaude ? `${claudeVersion} (Claude Code)\n` : 'codex-cli 0.162.0\n');
      else if (args.includes('status')) {
        if (isClaude) child.stdout.write(JSON.stringify({ loggedIn: auth !== 'none', authMethod: auth === 'subscription' ? 'claude.ai' : 'api_key', apiProvider: 'firstParty', email: 'private@example.com' }));
        else child.stderr.write(auth === 'subscription' ? 'Logged in using ChatGPT' : auth === 'none' ? 'Not logged in' : 'Logged in using an API key: sk-neverprintthiskey');
      } else {
        if (hang) return;
        if (stdoutChunks) for (const chunk of stdoutChunks) child.stdout.write(chunk);
        else child.stdout.write(events.map((e) => JSON.stringify(e)).join('\n'));
        child.stderr.write(stderr);
      }
      child.emit('close', args.includes('status') && auth === 'none' ? 1 : args.includes('status') || args.includes('--version') ? 0 : code);
    }));
    return child;
  };
  const kill = (pid, signal) => { killed.push({ pid, signal }); if (signal === 'SIGTERM') setImmediate(() => children.get(-pid)?.emit('close', null)); };
  const adapter = createCliAdapter({ platform: 'darwin', spawn, kill, temporaryRoot, stat: async () => ({ isFile: () => true }), access: async (path) => { if (!['/test/codex', '/test/claude'].includes(path)) throw new Error('ENOENT'); }, candidates: { codex: ['/test/codex'], claude: ['/test/claude'] }, home: '/isolated', env: { PATH: '', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CODEX_HOME: '/existing/codex-login' } });
  return { ...adapter, calls, killed };
}

test('subscription child environment strips API credentials and provider switches without mutating parent', () => {
  const original = { PATH: '/custom/bin', OPENAI_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: '/login/codex', HOME: '/real-home', CODEX_THREAD_ID: 'parent' };
  const env = subscriptionEnvironment(original, 'darwin');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.CODEX_HOME, '/login/codex');
  assert.equal(env.HOME, '/real-home');
  assert.match(env.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(original.OPENAI_API_KEY, 'secret');
});

test('provider commands preserve subscription login and disable tools/customizations', () => {
  const codex = providerArguments('codex', 'a-model');
  assert.ok(codex.includes('--ignore-user-config'));
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(codex.includes('shell_tool'));
  assert.equal(codex.at(-1), '-');
  const claude = providerArguments('claude');
  assert.ok(claude.includes('--safe-mode'));
  assert.ok(!claude.includes('--bare'));
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.ok(claude.includes('--no-session-persistence'));
  assert.ok(codex.includes('web_search="disabled"'));
  assert.ok(!claude.includes('--allowedTools'));
});

test('web research enables only each provider\'s search tool', () => {
  const codex = providerArguments('codex', 'a-model', { webSearch: true });
  assert.ok(codex.includes('web_search="live"') && !codex.includes('web_search="disabled"'));
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'computer_use', 'browser_use']) assert.equal(codex[codex.indexOf(feature) - 1], '--disable');
  const claude = providerArguments('claude', 'sonnet', { webSearch: true });
  assert.equal(claude[claude.indexOf('--tools') + 1], 'WebSearch');
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], 'WebSearch');
  assert.ok(claude.includes('--safe-mode') && claude.includes('--strict-mcp-config'));
  assert.equal(claude[claude.indexOf('--permission-prompts') + 1], 'none');
});

test('Codex streaming emits public text once and ignores reasoning', () => {
  const events = [];
  const parser = createOutputParser('codex', (event) => events.push(event));
  parser.consume({ type: 'thread.started', thread_id: 'session' });
  parser.consume({ type: 'item.completed', item: { id: 'thought', type: 'reasoning', text: 'Private thought' } });
  parser.consume({ type: 'item.delta', item_id: 'thought', delta: { type: 'text_delta', text: 'Private continuation' } });
  parser.consume({ type: 'item.delta', delta: { type: 'text_delta', text: 'Unknown channel' } });
  parser.consume({ type: 'agent_message.delta', item_id: 'answer', delta: 'Hello ' });
  parser.consume({ type: 'agent_message.delta', item_id: 'answer', delta: 'world.' });
  parser.consume({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Hello world.' } });
  parser.consume({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Hello world.' } });
  parser.consume({ type: 'turn.completed', usage: { output_tokens: 3 } });
  assert.equal(events.map((e) => e.text).join(''), 'Hello world.');
  assert.deepEqual(parser.result(), { text: 'Hello world.', sessionId: 'session', model: null, usage: { output_tokens: 3 } });
});

test('Claude partial messages, assistant snapshots, and final result do not duplicate text', () => {
  const events = [];
  const parser = createOutputParser('claude', (event) => events.push(event));
  parser.consume({ type: 'system', subtype: 'init', model: 'test-model', session_id: 'session' });
  parser.consume({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message' } } });
  parser.consume({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Private thought' } } });
  parser.consume({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } });
  parser.consume({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world.' } } });
  parser.consume({ type: 'assistant', message: { id: 'message', content: [{ type: 'thinking', thinking: 'Private thought' }, { type: 'text', text: 'Hello world.' }] } });
  parser.consume({ type: 'result', subtype: 'success', result: 'Hello world.', usage: { output_tokens: 3 } });
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello world.');
  assert.deepEqual(parser.result(), { text: 'Hello world.', sessionId: 'session', model: 'test-model', usage: { output_tokens: 3 } });
});

test('parsers reject unsuccessful, empty, and truncated responses', () => {
  const codex = createOutputParser('codex');
  codex.consume({ type: 'turn.failed', error: { message: 'Rate limit reached' } });
  assert.throws(() => codex.result(), /Rate limit/);
  const empty = createOutputParser('codex');
  empty.consume({ type: 'turn.completed' });
  assert.throws(() => empty.result(), /empty/);
  const truncated = createOutputParser('codex');
  truncated.consume(codexCompletion[1]);
  assert.throws(() => truncated.result(), /before completing/);
  const claude = createOutputParser('claude');
  claude.consume({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Could not finish'] });
  assert.throws(() => claude.result(), /Could not finish/);
});

test('discovery finds explicit locations without PATH and returns no account identifiers', async () => {
  const adapter = fixture();
  const statuses = await adapter.discoverProviders();
  assert.equal(statuses.codex.authenticated, true);
  assert.equal(statuses.claude.authenticated, true);
  assert.equal(statuses.codex.path, '/test/codex');
  assert.equal(statuses.claude.authType, 'Claude subscription');
  assert.ok(!JSON.stringify(statuses).includes('private@example.com'));
});

test('API-key login is not accepted as subscription access', async () => {
  const adapter = fixture({ auth: 'api' });
  const statuses = await adapter.discoverProviders();
  assert.equal(statuses.codex.authenticated, false);
  assert.equal(statuses.claude.authenticated, false);
  assert.ok(!JSON.stringify(statuses).includes('sk-neverprintthiskey'));
  await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Goal', cwd: '/isolated' }), /Sign in/);
  assert.ok(!adapter.calls.some((call) => call.args.includes('exec')));
});

test('old Claude versions and unsupported CLI options explain how to update without dropping isolation', async () => {
  const old = fixture({ claudeVersion: '2.1.100' });
  const status = (await old.discoverProviders()).claude;
  assert.equal(status.compatible, false);
  assert.match(status.error, /2\.1\.259.*Update Claude Code/);
  await assert.rejects(old.runProvider({ provider: 'claude', prompt: 'Question', cwd: '/isolated' }), /2\.1\.259/);
  assert.ok(!old.calls.some(call => call.args.includes('--print')));
  const unsupported = fixture({ code: 2, stderr: "error: unexpected argument '--ignore-user-config' found" });
  await assert.rejects(unsupported.runProvider({ provider: 'codex', prompt: 'Question', cwd: '/isolated' }), /Update it using the official installer/);
  assert.equal(unsupported.calls.filter(call => call.args.includes('exec')).length, 1, 'never retry with isolation flags removed');
});

test('run sends prompt only through stdin and decodes split UTF-8 / final JSON line', async () => {
  const raw = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'a', text: 'Hello 🌍' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }));
  const emojiOffset = raw.indexOf(Buffer.from('🌍'));
  const adapter = fixture({ stdoutChunks: [raw.subarray(0, emojiOffset + 1), raw.subarray(emojiOffset + 1)] });
  const output = await adapter.runProvider({ provider: 'codex', prompt: 'Goal $(unsafe) with `quotes`', cwd: '/isolated' });
  assert.equal(output.text, 'Hello 🌍');
  const call = adapter.calls.find((item) => item.args.includes('exec'));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.cwd, '/isolated');
  assert.equal(call.input, 'Goal $(unsafe) with `quotes`');
  assert.ok(!call.args.some((arg) => arg.includes('Goal')));
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
});

test('non-zero exits surface bounded redacted diagnostics', async () => {
  const adapter = fixture({ code: 1, stderr: 'x'.repeat(12000) + ' private@example.com sk-neverexposethiskey' });
  await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Goal', cwd: '/isolated' }), (error) => {
    assert.match(error.message, /exited with code 1/);
    assert.ok(error.message.length < 2100);
    assert.ok(!error.message.includes('private@example.com'));
    assert.ok(!error.message.includes('sk-neverexposethiskey'));
    return true;
  });
});

test('abort terminates the process group including descendants', async () => {
  const adapter = fixture({ hang: true });
  const controller = new AbortController();
  const result = adapter.runProvider({ provider: 'codex', prompt: 'Goal', cwd: '/isolated', signal: controller.signal });
  const poll = setInterval(() => { if (adapter.calls.some((call) => call.args.includes('exec'))) { clearInterval(poll); controller.abort(); } }, 2);
  await assert.rejects(result, { name: 'AbortError' });
  assert.ok(adapter.killed.some(({ pid, signal }) => pid < 0 && signal === 'SIGTERM'));
  assert.ok(adapter.killed.some(({ pid, signal }) => pid < 0 && signal === 'SIGKILL'));
});

test('timeout stops the process group and rejects', async () => {
  const adapter = fixture({ hang: true });
  // The real child process keeps Node alive; the fixture needs a referenced timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Goal', cwd: '/isolated', timeoutMs: 5 }), { name: 'TimeoutError' });
    assert.ok(adapter.killed.some(({ signal }) => signal === 'SIGKILL'));
  } finally { clearInterval(keepAlive); }
});

test('oversized protocol lines stop the process rather than growing buffers', async () => {
  const adapter = fixture({ stdoutChunks: [Buffer.alloc(2 * 1024 * 1024 + 1, 'x')] });
  await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Goal', cwd: '/isolated' }), /oversized/);
});

const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const structuredCompletion = [
  { type: 'item.completed', item: { id: 'progress', type: 'agent_message', text: 'I will compare the perspectives first.' } },
  { type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'Private reasoning is not part of the answer.' } },
  { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: '{"answer":"A valid structured answer."}' } },
  { type: 'turn.completed', usage: { output_tokens: 10 } },
];

async function schemaWorkspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-collab-schema-tests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Codex structured mode returns only the last completed public response, never commentary or reasoning', () => {
  const events = [];
  const parser = createOutputParser('codex', event => events.push(event), { finalResponseOnly: true });
  for (const event of structuredCompletion) parser.consume(event);
  assert.equal(parser.result().text, '{"answer":"A valid structured answer."}');
  assert.ok(!events.some(event => event.text.includes('Private reasoning')));
  const incomplete = createOutputParser('codex', () => {}, { finalResponseOnly: true });
  incomplete.consume({ type: 'agent_message.delta', item_id: 'incomplete', delta: '{"answer":"partial"}' });
  incomplete.consume({ type: 'turn.completed' });
  assert.throws(() => incomplete.result(), /without a final structured response/);
});

test('Codex output-schema uses a private temporary file, preserves the selected model, and removes the file after success', async t => {
  const temporaryRoot = await schemaWorkspace(t);
  const adapter = fixture({ temporaryRoot, events: structuredCompletion });
  const output = await adapter.runProvider({ provider: 'codex', prompt: 'Private task text stays on stdin.', cwd: '/isolated', model: 'gpt-6.1-sol', outputSchema });
  const call = adapter.calls.find(call => call.args.includes('exec'));
  assert.deepEqual(call.schema, outputSchema);
  if (process.platform !== 'win32') { assert.equal(call.schemaMode, 0o600); assert.equal(call.schemaDirectoryMode, 0o700); }
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.equal(call.args.at(-1), '-');
  assert.equal(call.input, 'Private task text stays on stdin.');
  assert.equal(output.model, 'gpt-6.1-sol');
  assert.equal(output.text, '{"answer":"A valid structured answer."}');
  await assert.rejects(access(call.schemaPath));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('schema temporary files are removed on CLI failure, parsing failure, cancellation, and timeout', async t => {
  const temporaryRoot = await schemaWorkspace(t);
  for (const mode of ['exit', 'parse', 'cancel', 'timeout']) {
    const adapter = fixture({ temporaryRoot, code: mode === 'exit' ? 1 : 0,
      events: mode === 'parse' ? [{ type: 'turn.completed' }] : structuredCompletion,
      hang: ['cancel', 'timeout'].includes(mode) });
    const controller = new AbortController();
    const keepAlive = setInterval(() => {
      if (mode === 'cancel' && adapter.calls.some(call => call.args.includes('exec'))) controller.abort();
    }, 2);
    try {
      await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Schema cleanup test', cwd: '/isolated', outputSchema,
        signal: controller.signal, timeoutMs: mode === 'timeout' ? 5 : 30000 }));
      const call = adapter.calls.find(call => call.args.includes('exec'));
      assert.ok(call?.schemaPath, `${mode} created the schema before executing`);
      await assert.rejects(access(call.schemaPath));
      assert.deepEqual(await readdir(temporaryRoot), [], `${mode} leaves no schema directory`);
    } finally { clearInterval(keepAlive); }
  }
});

test('invalid schemas fail before starting any CLI and ordinary calls do not opt into schema mode', async t => {
  const temporaryRoot = await schemaWorkspace(t);
  const circular = {}; circular.self = circular;
  for (const schema of [[], 'not a schema', circular, { description: 'x'.repeat(65536) }]) {
    const adapter = fixture({ temporaryRoot });
    await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Test', cwd: '/isolated', outputSchema: schema }), /schema/);
    assert.equal(adapter.calls.length, 0);
  }
  const adapter = fixture({ temporaryRoot });
  await assert.rejects(adapter.runProvider({ provider: 'claude', prompt: 'Test', cwd: '/isolated', outputSchema }), /Codex calls only/);
  await adapter.runProvider({ provider: 'codex', prompt: 'Ordinary call', cwd: '/isolated' });
  assert.ok(!adapter.calls.find(call => call.args.includes('exec')).args.includes('--output-schema'));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('a web research call passes the search flag and keeps only the final answer', async () => {
  const lines = [
    { type: 'item.completed', item: { type: 'agent_message', id: 'progress', text: 'Searching for the device.' } },
    { type: 'item.completed', item: { type: 'web_search', id: 'search', query: 'iPhone Duo' } },
    { type: 'item.completed', item: { type: 'agent_message', id: 'final', text: 'Brief with sources.' } },
    { type: 'turn.completed' },
  ];
  const adapter = fixture({ stdoutChunks: [Buffer.from(lines.map(line => JSON.stringify(line)).join('\n'))] });
  const output = await adapter.runProvider({ provider: 'codex', prompt: 'Research', cwd: '/isolated', webSearch: true });
  assert.equal(output.text, 'Brief with sources.');
  assert.ok(adapter.calls.find(call => call.args.includes('exec')).args.includes('web_search="live"'));
  await assert.rejects(adapter.runProvider({ provider: 'codex', prompt: 'Research', cwd: '/isolated', webSearch: 'yes' }), /web search setting/);
});
