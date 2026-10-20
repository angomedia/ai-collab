import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createModelDiscovery, normalizeModels } from '../src/main/models.mjs';

function fixture({ codexPages, hang = false, sdkError = false, authenticated = true } = {}) {
  const calls = [];
  const messages = [];
  const kills = [];
  const sdkQueries = [];
  const children = new Map();
  let versionChecks = 0;
  let closedQueries = 0;
  let clock = 0;
  let nextPid = 920000;
  const pages = codexPages || [{ data: [{ id: 'test-codex', model: 'test-codex', displayName: 'Test Codex', isDefault: true }], nextCursor: null }];
  const spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.pid = ++nextPid;
    child.exitCode = null;
    child.killed = false;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    children.set(child.pid, child);
    calls.push({ binary, args, options, child });
    let page = 0;
    let pending = '';
    child.stdin.on('data', (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const message = JSON.parse(line);
        messages.push(message);
        if (hang) continue;
        if (message.method === 'initialize') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
        if (message.method === 'model/list') {
          const result = pages[Math.min(page++, pages.length - 1)];
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
        }
      }
    });
    return child;
  };
  const discovery = createModelDiscovery({
    platform: 'darwin', spawn,
    discoverProviders: async () => {
      versionChecks += 1;
      return {
        codex: { available: true, authenticated, path: '/test/codex' },
        claude: { available: true, authenticated, path: '/test/claude' },
      };
    },
    loadClaudeSdk: async () => ({
      query(request) {
        sdkQueries.push(request);
        request.options.spawnClaudeCodeProcess({ command: '/test/claude', args: ['--input-format', 'stream-json'], cwd: request.options.cwd, env: request.options.env });
        return {
          async supportedModels() {
            if (sdkError) throw new Error('Account private@example.com token sk-secret-should-not-leak');
            if (hang) return new Promise(() => {});
            return [
              { value: 'default', displayName: 'Default' },
              { value: 'opus', displayName: 'Opus', description: 'Current Opus model' },
              { value: 'model-test[1m]', displayName: 'Large context' },
            ];
          },
          close() { closedQueries += 1; },
        };
      },
    }),
    kill(pid, signal) {
      kills.push({ pid, signal });
      const child = children.get(-pid);
      if (child && !child.killed) {
        child.killed = true;
        child.exitCode = 0;
        // Synchronous exit also exercises the termination-listener race.
        child.emit('exit', 0, signal);
        child.emit('close', 0, signal);
      }
    },
    env: { HOME: '/original/home', CODEX_HOME: '/original/login', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' },
    now: () => clock,
    cacheMs: 1000,
    timeoutMs: 30,
    makeWorkspace: async () => '/isolated/model-catalog',
    removeWorkspace: async () => {},
  });
  return { ...discovery, calls, messages, kills, sdkQueries, advance: (ms) => { clock += ms; }, get versionChecks() { return versionChecks; }, get closedQueries() { return closedQueries; } };
}

test('normalization preserves CLI model identifiers and labels, filters hidden/invalid duplicates, and always offers CLI default', () => {
  const options = normalizeModels('codex', [
    { id: 'catalog-id', model: 'actual-cli-id', displayName: 'Visible model', description: 'A useful model.', isDefault: true },
    { model: 'actual-cli-id', displayName: 'Duplicate' },
    { model: 'hidden-model', displayName: 'Hidden', hidden: true },
    { model: 'invalid\nmodel', displayName: 'Invalid' },
    { model: 'model-two' },
  ]);
  assert.deepEqual(options.map((option) => option.id), ['', 'actual-cli-id', 'model-two']);
  assert.equal(options[0].label, 'CLI default');
  assert.equal(options[1].label, 'Visible model');
  assert.equal(options[1].isDefault, true);
  assert.equal(options[2].label, 'model-two');
  assert.throws(() => normalizeModels('claude', []), /no selectable models/);
});

test('Codex performs initialization and pagination only; Claude submits no prompt while fetching its supported models', async () => {
  const adapter = fixture({ codexPages: [
    { data: [{ model: 'first-model', displayName: 'First' }], nextCursor: 'second-page' },
    { data: [{ model: 'second-model', displayName: 'Second' }], nextCursor: null },
  ] });
  const result = await adapter.discoverModels();
  assert.equal(result.codex.source, 'live');
  assert.equal(result.claude.source, 'live');
  assert.deepEqual(result.codex.options.map((option) => option.id), ['', 'first-model', 'second-model']);
  assert.deepEqual(result.claude.options.map((option) => option.id), ['', 'opus', 'model-test[1m]']);
  assert.deepEqual(adapter.messages.map((message) => message.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(adapter.messages[3].params.cursor, 'second-page');
  const request = adapter.sdkQueries[0];
  assert.equal(request.options.pathToClaudeCodeExecutable, '/test/claude');
  assert.equal(request.options.persistSession, false);
  assert.deepEqual(request.options.tools, []);
  assert.equal(request.options.strictMcpConfig, true);
  const input = [];
  for await (const message of request.prompt) input.push(message);
  assert.deepEqual(input, [], 'the input closes without ever yielding a user message');
  assert.equal(adapter.closedQueries, 1);
  assert.ok(adapter.calls.every((call) => call.options.shell === false && call.options.detached));
  assert.ok(adapter.calls.every((call) => call.options.env.OPENAI_API_KEY === undefined && call.options.env.ANTHROPIC_API_KEY === undefined));
  assert.ok(adapter.calls.every((call) => call.options.env.CODEX_HOME === '/original/login'));
  assert.ok(adapter.calls.every((call) => call.child.killed));
});

test('catalog results are cached, concurrent refreshes coalesce, and callers cannot modify cached options', async () => {
  const adapter = fixture();
  const [first, simultaneous] = await Promise.all([adapter.discoverModels(), adapter.discoverModels()]);
  assert.deepEqual(first, simultaneous);
  assert.equal(adapter.versionChecks, 1);
  first.codex.options[0].label = 'Changed outside the cache';
  const cached = await adapter.discoverModels();
  assert.equal(cached.codex.options[0].label, 'CLI default');
  assert.equal(adapter.versionChecks, 1);
  await adapter.discoverModels({ force: true });
  assert.equal(adapter.versionChecks, 2);
  adapter.advance(1001);
  await adapter.discoverModels();
  assert.equal(adapter.versionChecks, 3);
});

test('catalog timeouts terminate both process groups and return clearly labeled fallback choices', async () => {
  const adapter = fixture({ hang: true });
  const result = await adapter.discoverModels();
  assert.equal(result.codex.source, 'fallback');
  assert.equal(result.claude.source, 'fallback');
  assert.deepEqual(result.codex.options.map((option) => option.id), ['']);
  assert.deepEqual(result.claude.options.map((option) => option.id), ['', 'opus', 'sonnet', 'haiku']);
  assert.match(result.claude.warning, /account access has not been verified/);
  assert.ok(adapter.kills.some(({ pid, signal }) => pid < 0 && signal === 'SIGTERM'));
  assert.ok(adapter.kills.some(({ pid, signal }) => pid < 0 && signal === 'SIGKILL'));
  assert.ok(adapter.calls.every((call) => call.child.killed));
  assert.equal(adapter.closedQueries, 1);
});

test('changing a connection discards an in-flight catalog for every waiting caller', async () => {
  const adapter = fixture();
  const original = adapter.discoverModels();
  adapter.invalidateModels();
  const changed = adapter.discoverModels();
  const [first, second] = await Promise.all([original, changed]);
  assert.deepEqual(first, second);
  assert.equal(first.codex.source, 'live');
  assert.equal(adapter.versionChecks, 2, 'an old discovery is replaced, including callers that arrived after invalidation');
  await adapter.discoverModels();
  assert.equal(adapter.versionChecks, 2, 'the replacement catalog is cached');
  adapter.invalidateModels();
  await adapter.discoverModels();
  assert.equal(adapter.versionChecks, 3);
});

test('an unavailable login never launches catalog subprocesses', async () => {
  const adapter = fixture({ authenticated: false });
  const result = await adapter.discoverModels();
  assert.equal(adapter.calls.length, 0);
  assert.equal(adapter.sdkQueries.length, 0);
  assert.equal(result.codex.source, 'fallback');
  assert.match(result.codex.warning, /Sign in/);
  assert.match(result.claude.warning, /Sign in/);
});

test('SDK errors do not reveal account metadata, and invalid pagination cannot loop indefinitely', async () => {
  const adapter = fixture({
    sdkError: true,
    codexPages: [{ data: [{ model: 'test-model' }], nextCursor: 'repeated-cursor' }],
  });
  const result = await adapter.discoverModels();
  assert.equal(result.codex.source, 'fallback');
  assert.equal(result.claude.source, 'fallback');
  assert.equal(adapter.messages.filter((message) => message.method === 'model/list').length, 2);
  assert.ok(!JSON.stringify(result).includes('private@example.com'));
  assert.ok(!JSON.stringify(result).includes('sk-secret'));
  assert.ok(adapter.calls.every((call) => call.child.killed));
});
