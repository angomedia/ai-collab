import { spawn as nodeSpawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { discoverProviders as installedProviders, subscriptionEnvironment } from './cli.mjs';
import { terminateProcessTree } from './processes.mjs';

const CACHE_MS = 5 * 60 * 1000;
const MAX_LINE = 2 * 1024 * 1024;
const DEFAULT_OPTION = { id: '', label: 'CLI default', description: 'Use the model selected by your CLI.', isDefault: true, source: 'automatic' };
const MODEL_ID = /^[a-zA-Z0-9._:/\[\]-]{1,150}$/;

// These are version-independent aliases documented at
// https://code.claude.com/docs/en/model-config#model-aliases (checked 2026-10-19).
// Fallback options are not a claim that a subscription has access to them.
const CLAUDE_FALLBACK = [
  { id: 'opus', label: 'Opus', description: 'Documented Claude Code alias for complex reasoning.' },
  { id: 'sonnet', label: 'Sonnet', description: 'Documented Claude Code alias for everyday work.' },
  { id: 'haiku', label: 'Haiku', description: 'Documented Claude Code alias for quick, simple tasks.' },
];

export function normalizeModels(provider, entries) {
  if (!Array.isArray(entries)) throw new Error('The CLI returned an invalid model catalog.');
  const result = [{ ...DEFAULT_OPTION }];
  const seen = new Set(['', 'default']);
  for (const entry of entries.slice(0, 500)) {
    if (!entry || typeof entry !== 'object' || entry.hidden === true) continue;
    const rawId = provider === 'codex' ? entry.model || entry.id : entry.value;
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry.displayName === 'string' ? entry.displayName.trim().slice(0, 200) : id;
    const option = { id, label: label || id, source: 'cli' };
    if (typeof entry.description === 'string' && entry.description.trim()) option.description = entry.description.trim().slice(0, 1000);
    if (entry.isDefault === true) option.isDefault = true;
    result.push(option);
  }
  if (result.length === 1) throw new Error('The CLI returned no selectable models.');
  return result;
}

function fallback(provider, reason) {
  return {
    options: [{ ...DEFAULT_OPTION }, ...(provider === 'claude' ? CLAUDE_FALLBACK.map((item) => ({ ...item, source: 'documented-alias' })) : [])],
    source: 'fallback',
    warning: provider === 'claude'
      ? `${reason} Showing documented aliases; account access has not been verified.`
      : `${reason} Use CLI default, or refresh the list.`,
  };
}

function withinTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Model discovery timed out.')), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export function createModelDiscovery({
  discoverProviders = installedProviders,
  spawn = crossSpawn,
  terminateSpawn = nodeSpawn,
  loadClaudeSdk = () => import('@anthropic-ai/claude-agent-sdk'),
  env: sourceEnv = process.env,
  platform = process.platform,
  kill = process.kill.bind(process),
  now = Date.now,
  cacheMs = CACHE_MS,
  timeoutMs = 12000,
  makeWorkspace = () => mkdtemp(path.join(tmpdir(), 'ai-collab-models-')),
  removeWorkspace = (directory) => rm(directory, { recursive: true, force: true }),
} = {}) {
  let cache;
  let expiresAt = 0;
  let inFlight;
  let generation = 0;
  function invalidateModels() {
    generation += 1;
    cache = undefined;
    expiresAt = 0;
  }
  const env = subscriptionEnvironment(sourceEnv, platform);

  function spawnManaged(binary, args, options, children) {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: subscriptionEnvironment(options.env || env, platform),
      shell: false, detached: platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const record = { child, exited: false };
    children.push(record);
    const markExited = () => { record.exited = true; };
    child.once('exit', markExited);
    child.once('close', markExited);
    // Catalog queries never expose raw stderr, which can contain account metadata.
    child.stderr?.on('data', () => {});
    return child;
  }

  function signalChild(child, signal) {
    return terminateProcessTree(child, { platform, kill, spawn: terminateSpawn, env }, signal);
  }

  async function stopChildren(children) {
    await Promise.all(children.map((record) => {
      const { child } = record;
      if (platform === 'win32') return signalChild(child, 'SIGKILL');
      signalChild(child, 'SIGTERM');
      if (record.exited) { signalChild(child, 'SIGKILL'); return; }
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off('exit', finish);
          child.off('close', finish);
          // Clear any descendants that remained after the CLI shut down.
          signalChild(child, 'SIGKILL');
          resolve();
        };
        const timer = setTimeout(finish, 750);
        child.once('exit', finish);
        child.once('close', finish);
      });
    }));
  }

  async function codexCatalog(binary, cwd) {
    const children = [];
    let rejectPending;
    const operation = new Promise((resolve, reject) => {
      rejectPending = reject;
      const child = spawnManaged(binary, [
        '--no-daemon', 'app-server', '--listen', 'stdio://',
        '-c', 'model_provider="openai"', '-c', 'mcp_servers={}',
        '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks',
      ], { cwd }, children);
      let nextId = 1;
      let responseId = 1;
      let initialized = false;
      let pending = '';
      let totalBytes = 0;
      let pages = 0;
      const cursors = new Set();
      const entries = [];
      const decoder = new StringDecoder('utf8');
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      function requestPage(cursor) {
        responseId = ++nextId;
        send({ id: responseId, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
      }
      function consume(line) {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== responseId) return;
        if (message.error) { reject(new Error('Codex could not return its model catalog.')); return; }
        if (!initialized) {
          initialized = true;
          send({ method: 'initialized' });
          requestPage();
          return;
        }
        if (!Array.isArray(message.result?.data)) { reject(new Error('Codex returned an invalid model catalog.')); return; }
        entries.push(...message.result.data);
        pages += 1;
        const cursor = message.result.nextCursor;
        if (cursor != null && cursor !== '') {
          if (typeof cursor !== 'string' || cursor.length > 4096 || cursors.has(cursor) || pages >= 10 || entries.length > 500) {
            reject(new Error('Codex returned invalid model catalog pagination.')); return;
          }
          cursors.add(cursor);
          requestPage(cursor);
        } else resolve(entries);
      }
      child.on('error', () => reject(new Error('The Codex catalog process could not start.')));
      child.on('close', () => reject(new Error('Codex closed before returning its model catalog.')));
      child.stdin.on('error', () => reject(new Error('The Codex catalog connection closed.')));
      child.stdout.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > 8 * MAX_LINE) { reject(new Error('The Codex model catalog exceeded its size limit.')); return; }
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          if (newline > MAX_LINE) { reject(new Error('The Codex model catalog exceeded its size limit.')); return; }
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.trim()) consume(line);
        }
        if (pending.length > MAX_LINE) reject(new Error('The Codex model catalog exceeded its size limit.'));
      });
      // Official app-server protocol: initialize, initialized, then paginated model/list.
      // https://learn.chatgpt.com/docs/app-server#list-models-modellist
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'ai_collab', title: 'AI Collab', version: '1.0.0' },
        capabilities: { experimentalApi: false },
      } });
    });
    try { return await withinTimeout(operation, timeoutMs); }
    finally { rejectPending?.(new Error('Model discovery closed.')); await stopChildren(children); }
  }

  async function claudeCatalog(binary, cwd) {
    const children = [];
    const abortController = new AbortController();
    let query;
    let releaseInput;
    const inputClosed = new Promise((resolve) => { releaseInput = resolve; });
    // An open, empty input stream triggers SDK initialization but never submits a prompt.
    async function* noUserMessages() { await inputClosed; }
    try {
      return await withinTimeout((async () => {
        const sdk = await loadClaudeSdk();
        if (abortController.signal.aborted) throw new Error('Model discovery closed.');
        query = sdk.query({ prompt: noUserMessages(), options: {
          pathToClaudeCodeExecutable: binary, cwd, env,
          abortController, persistSession: false, tools: [],
          strictMcpConfig: true, permissionPrompts: 'none', promptSuggestions: false,
          extraArgs: { 'safe-mode': null, 'disable-slash-commands': null, 'no-chrome': null },
          spawnClaudeCodeProcess: (options) => spawnManaged(options.command, options.args, options, children),
        } });
        // Official SDK read-only catalog API; only the model fields are retained.
        // https://code.claude.com/docs/en/agent-sdk/typescript#query-object
        return await query.supportedModels();
      })(), timeoutMs);
    } finally {
      // The SDK's close() can terminate only the launcher. On Windows kill its
      // descendants while that parent still exists, before SDK cleanup runs.
      if (platform === 'win32') await stopChildren(children);
      releaseInput();
      try { query?.close(); } catch { /* Still terminate the owned process group below. */ }
      abortController.abort();
      await stopChildren(children);
    }
  }

  async function discoverOne(provider, status) {
    if (!status?.available || !status.path) return fallback(provider, `${provider === 'codex' ? 'Codex' : 'Claude Code'} was not found.`);
    if (status.compatible === false) return fallback(provider, `Update ${provider === 'codex' ? 'Codex' : 'Claude Code'} to load its model list.`);
    if (!status.authenticated) return fallback(provider, `Sign in to ${provider === 'codex' ? 'Codex' : 'Claude Code'} to load its model list.`);
    let cwd;
    try {
      cwd = await makeWorkspace();
      const entries = await (provider === 'codex' ? codexCatalog(status.path, cwd) : claudeCatalog(status.path, cwd));
      return { options: normalizeModels(provider, entries), source: 'live' };
    } catch {
      // Do not expose raw subprocess/SDK errors: they can include credentials or account details.
      return fallback(provider, `${provider === 'codex' ? 'Codex' : 'Claude Code'} could not load its model list.`);
    } finally {
      if (cwd) await removeWorkspace(cwd).catch(() => {});
    }
  }

  async function discoverModels({ force = false } = {}) {
    if (!force && cache && now() < expiresAt) return structuredClone(cache);
    if (!inFlight) inFlight = (async () => {
      const startedGeneration = generation;
      const statuses = await discoverProviders();
      const [codex, claude] = await Promise.all([
        discoverOne('codex', statuses.codex), discoverOne('claude', statuses.claude),
      ]);
      const catalog = { codex, claude };
      if (startedGeneration === generation) {
        cache = catalog;
        expiresAt = now() + cacheMs;
      }
      return { catalog, generation: startedGeneration };
    })().finally(() => { inFlight = null; });
    const result = await inFlight;
    // A connection may change while a catalog is loading. Never publish the previous account's list.
    if (result.generation !== generation) return discoverModels();
    return structuredClone(result.catalog);
  }

  return { discoverModels, invalidateModels };
}

const discovery = createModelDiscovery();
export const discoverModels = discovery.discoverModels;
export const invalidateModels = discovery.invalidateModels;
