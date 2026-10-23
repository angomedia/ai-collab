import { spawn as nodeSpawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { access as fsAccess, stat as fsStat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { environmentValue, platformPaths, terminateProcessTree } from './processes.mjs';

const MAX_LINE = 2 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC = 8192;
const PROVIDERS = ['codex', 'claude'];
const LABELS = { codex: 'Codex', claude: 'Claude Code' };
// Also used by Terminal setup scripts, whose shell may inherit a different environment.
export const SUBSCRIPTION_ENVIRONMENT_EXCLUSIONS = '^(OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_ORGANIZATION|OPENAI_PROJECT_ID|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_OSS_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_PROFILE|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CLAUDE_CODE_BARE|CLAUDE_CODE_SIMPLE|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$|^ANTHROPIC_FEDERATION_|^CODEX_(APP_TOOLS_|INTERNAL_ORIGINATOR|SESSION_ID$|THREAD_ID$|TASK_WORKSPACE|PERMISSION_PROFILE$|CI$)';
const excludedEnvironment = new RegExp(SUBSCRIPTION_ENVIRONMENT_EXCLUSIONS, 'i');

// Children use the CLI's own login store. Never copy or inspect credential files.
export function subscriptionEnvironment(source = process.env, platform = process.platform) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (excludedEnvironment.test(name)) delete env[name];
  }
  const paths = platformPaths(platform);
  const searchPath = environmentValue(env, 'PATH');
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
  const extra = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  env.PATH = [...new Set([...searchPath.split(paths.delimiter), ...extra].filter(Boolean))].join(paths.delimiter);
  env.NO_COLOR = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

function safeDiagnostic(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+|eyJ[A-Za-z0-9_.-]{20,})\b/gi, '[credential]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\s*[=:]\s*)["']?[^\s,"'}]+/gi, '$1[credential]')
    .slice(-2000).trim();
}

// webSearch enables only each provider's hosted search tool; every other tool stays disabled.
export function providerArguments(provider, model, { outputSchemaPath, webSearch = false } = {}) {
  let args;
  if (provider === 'codex') {
    args = ['--no-daemon', '--ask-for-approval', 'never', 'exec', '--json', '--color', 'never', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-c', `web_search="${webSearch ? 'live' : 'disabled'}"`, '-c', 'project_doc_max_bytes=0'];
    for (const feature of ['shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'hooks', 'multi_agent', 'computer_use', 'browser_use', 'image_generation', 'view_image']) args.push('--disable', feature);
    if (model) args.push('--model', model);
    if (outputSchemaPath) args.push('--output-schema', outputSchemaPath);
    args.push('-');
  } else if (provider === 'claude') {
    args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--tools', webSearch ? 'WebSearch' : '', '--strict-mcp-config', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands', '--no-chrome'];
    if (webSearch) args.push('--allowedTools', 'WebSearch');
    if (model) args.push('--model', model);
  } else throw new Error('Unknown provider.');
  return args;
}

// Only public assistant text is passed to onEvent; reasoning/thinking/tool payloads are ignored.
export function createOutputParser(provider, onEvent = () => {}, { finalResponseOnly = false } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider.');
  const parts = new Map();
  const itemTypes = new Map();
  let activeId = 'anonymous';
  let sessionId = null;
  let model = null;
  let usage = null;
  let completed = false;
  let failure = null;
  let authoritativeText = null;
  let emitted = '';
  const emit = (event) => { try { onEvent(event); } catch { /* UI observers must not break process cleanup. */ } };
  const text = () => [...parts.values()].join('\n\n');
  function update(id, value, delta = false) {
    if (typeof value !== 'string' || !value) return;
    id = id || activeId;
    if (!parts.has(id) && parts.has('anonymous') && id !== 'anonymous' && value.startsWith(parts.get('anonymous'))) {
      const previous = parts.get('anonymous');
      parts.delete('anonymous');
      parts.set(id, previous);
    }
    activeId = id;
    const previous = parts.get(id) || '';
    const next = delta ? previous + value : value;
    const isNew = !parts.has(id);
    parts.set(id, next);
    const combined = text();
    if (combined.length > MAX_TEXT) throw new Error('The response exceeded the 4 MB limit. Try a more focused goal.');
    const addition = next.startsWith(previous) ? next.slice(previous.length) : '';
    if (addition) {
      const chunk = (isNew && emitted ? '\n\n' : '') + addition;
      emitted += chunk;
      emit({ type: 'delta', text: chunk });
    }
  }
  function consume(event) {
    if (!event || typeof event !== 'object') return;
    if (provider === 'codex') {
      if (event.type === 'thread.started') sessionId = event.thread_id || null;
      if (event.type === 'turn.started') emit({ type: 'status', text: 'Codex is preparing its response.' });
      if (event.model) model = event.model;
      if (event.item?.id && event.item?.type) itemTypes.set(event.item.id, event.item.type);
      if ((event.type === 'item.completed' || event.type === 'item.updated') && event.item?.type === 'agent_message') {
        update(event.item.id, event.item.text);
        // The schema constrains the final answer. Public progress messages can
        // precede it; joining those messages would make valid JSON unreadable.
        if (finalResponseOnly && event.type === 'item.completed' && typeof event.item.text === 'string') authoritativeText = event.item.text;
      }
      if (['agent_message.delta', 'item.agent_message.delta', 'response.output_text.delta'].includes(event.type)) update(event.item_id || event.id, typeof event.delta === 'string' ? event.delta : event.delta?.text, true);
      if (event.type === 'item.delta' && (event.item?.type === 'agent_message' || event.delta?.type === 'agent_message' || itemTypes.get(event.item_id) === 'agent_message')) update(event.item_id || event.item?.id, event.delta?.text, true);
      if (event.type === 'turn.completed') { completed = true; usage = event.usage || null; failure = null; }
      if (event.type === 'turn.failed') failure = safeDiagnostic(event.error?.message || event.error || 'The Codex turn failed.');
      if (event.type === 'error') failure = safeDiagnostic(event.message || event.error?.message || 'Codex reported an error.');
    } else {
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'system' && event.subtype === 'init') {
        model = event.model || model;
        emit({ type: 'status', text: 'Claude Code is preparing its response.' });
      }
      if (event.type === 'stream_event') {
        const inner = event.event;
        if (inner?.type === 'message_start') { activeId = inner.message?.id || activeId; model = inner.message?.model || model; }
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') update(activeId, inner.delta.text, true);
      }
      if (event.type === 'assistant' && event.message) {
        model = event.message.model || model;
        const publicText = (event.message.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
        update(event.message.id, publicText);
      }
      if (event.type === 'result') {
        completed = true;
        usage = event.usage || null;
        if (event.is_error || (event.subtype && event.subtype !== 'success')) failure = safeDiagnostic(event.result || (event.errors || []).join('\n') || 'Claude Code could not finish this response.');
        else if (typeof event.result === 'string') {
          authoritativeText = event.result;
          if (authoritativeText.length > MAX_TEXT) throw new Error('The response exceeded the 4 MB limit. Try a more focused goal.');
          if (!emitted) update(activeId, authoritativeText);
          else if (authoritativeText.startsWith(emitted) && authoritativeText.length > emitted.length) {
            emit({ type: 'delta', text: authoritativeText.slice(emitted.length) });
            emitted = authoritativeText;
          }
        }
      }
    }
  }
  function result() {
    if (failure) throw new Error(failure);
    if (!completed) throw new Error(`${LABELS[provider]} ended before completing its response.`);
    if (finalResponseOnly && authoritativeText === null) throw new Error(`${LABELS[provider]} completed without a final structured response.`);
    const output = (authoritativeText ?? text()).trim();
    if (!output) throw new Error(`${LABELS[provider]} returned an empty response.`);
    return { text: output, sessionId, model, usage };
  }
  return { consume, result };
}

export function createCliAdapter({ spawn = crossSpawn, terminateSpawn = nodeSpawn, access = fsAccess, stat = fsStat, env: sourceEnv = process.env, home = homedir(), platform = process.platform, kill = process.kill.bind(process), candidates: candidateOverrides = {}, temporaryRoot = tmpdir() } = {}) {
  const env = subscriptionEnvironment(sourceEnv, platform);
  const paths = platformPaths(platform);
  let configuredPaths = { codex: null, claude: null };
  function configureProviderPaths(overrides = {}) {
    const next = {};
    for (const provider of PROVIDERS) {
      const file = overrides[provider] ?? null;
      if (file !== null && (typeof file !== 'string' || !paths.isAbsolute(file) || /[\r\n\0]/.test(file) || (platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file)))) throw new Error('Choose an absolute executable path.');
      next[provider] = file;
    }
    configuredPaths = next;
    return { ...configuredPaths };
  }
  const overrideFor = provider => configuredPaths[provider] || sourceEnv[`AI_COLLAB_${provider.toUpperCase()}_PATH`] || null;
  const localAppData = environmentValue(sourceEnv, 'LOCALAPPDATA') || paths.join(home, 'AppData', 'Local');
  const appData = environmentValue(sourceEnv, 'APPDATA') || paths.join(home, 'AppData', 'Roaming');
  const names = provider => platform === 'win32' ? [`${provider}.exe`, `${provider}.cmd`, `${provider}.bat`] : [provider];
  const candidates = platform === 'win32' ? {
    codex: [sourceEnv.AI_COLLAB_CODEX_PATH, paths.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), ...names('codex').map(name => paths.join(home, '.local', 'bin', name)), ...names('codex').map(name => paths.join(appData, 'npm', name))],
    claude: [sourceEnv.AI_COLLAB_CLAUDE_PATH, ...names('claude').map(name => paths.join(home, '.local', 'bin', name)), ...names('claude').map(name => paths.join(appData, 'npm', name))],
    ...candidateOverrides,
  } : {
    codex: [sourceEnv.AI_COLLAB_CODEX_PATH, '/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', join(home, 'Applications/Codex.app/Contents/Resources/codex'), join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    claude: [sourceEnv.AI_COLLAB_CLAUDE_PATH, join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
    ...candidateOverrides,
  };
  async function findBinary(provider) {
    const override = overrideFor(provider);
    const search = override ? [override] : [...candidates[provider], ...env.PATH.split(paths.delimiter).filter(Boolean).flatMap(dir => names(provider).map(name => paths.join(dir.replace(/^"|"$/g, ''), name)))];
    for (const file of [...new Set(search.filter(Boolean))]) {
      try { if (platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file)) continue; if (!(await stat(file)).isFile()) continue; await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return file; } catch { /* Check next installation location, unless an exact override was selected. */ }
    }
    return null;
  }
  function execute(binary, args, { cwd = home, input = '', timeoutMs = 12000, signal, onLine, captureLimit = 32768 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { const error = new Error('Debate cancelled.'); error.name = 'AbortError'; reject(error); return; }
      let child;
      let stdout = '';
      let stderr = '';
      let pending = '';
      let finished = false;
      let abortError = null;
      let timer;
      let killTimer;
      const decoder = new StringDecoder('utf8');
      function killTree(method) {
        return terminateProcessTree(child, { platform, kill, spawn: terminateSpawn, env }, method);
      }
      function terminate(error) {
        if (abortError || finished) return;
        abortError = error;
        killTree('SIGTERM');
        killTimer = setTimeout(() => { killTree('SIGKILL'); finish(error); }, 1000);
        killTimer.unref?.();
      }
      function abort() { const error = new Error('Debate cancelled.'); error.name = 'AbortError'; terminate(error); }
      async function finish(error, code) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        if (abortError) await killTree('SIGKILL');
        if (error || abortError) reject(abortError || error);
        else resolve({ code, stdout, stderr });
      }
      function lines(chunk, flush = false) {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line.length > MAX_LINE) throw new Error('The CLI emitted an oversized response event.');
          if (line) onLine(line);
        }
        if (pending.length > MAX_LINE) throw new Error('The CLI emitted an oversized response event.');
        if (flush && pending.trim()) { onLine(pending.trim()); pending = ''; }
      }
      try { child = spawn(binary, args, { cwd, env, shell: false, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (error) { finish(error); return; }
      child.on('error', (error) => finish(new Error(`Could not start ${binary}: ${safeDiagnostic(error.message)}`)));
      child.stdout.on('data', (chunk) => {
        const decoded = decoder.write(chunk);
        if (onLine) { try { lines(decoded); } catch (error) { terminate(error); } }
        else stdout = (stdout + decoded).slice(-captureLimit);
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-MAX_DIAGNOSTIC); });
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE' && !abortError) terminate(new Error(`Could not send the goal to the CLI: ${safeDiagnostic(error.message)}`)); });
      child.on('close', (code) => {
        try {
          if (onLine && !abortError) lines(decoder.end(), true);
          else if (!onLine) stdout = (stdout + decoder.end()).slice(-captureLimit);
        }
        catch (error) { finish(error); return; }
        finish(null, code);
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { const error = new Error(`The CLI did not finish within ${Math.ceil(timeoutMs / 60000)} minute(s). Try again or use a shorter goal.`); error.name = 'TimeoutError'; terminate(error); }, timeoutMs);
      timer.unref?.();
      child.stdin.end(input);
    });
  }
  async function inspect(provider, signal) {
    const path = await findBinary(provider);
    const configuredPath = overrideFor(provider);
    const status = { available: Boolean(path), authenticated: false, authType: null, version: null, path, configuredPath, error: null };
    if (!path) { status.error = configuredPath ? `The selected ${LABELS[provider]} executable is missing or cannot be run. Choose its executable again, or reset the selected path.` : `${LABELS[provider]} was not found. Install its command-line app, then refresh.`; return status; }
    const results = await Promise.allSettled([
      execute(path, ['--version'], { signal }),
      execute(path, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { signal }),
    ]);
    if (results[0].status === 'fulfilled') status.version = safeDiagnostic(results[0].value.stdout).split('\n')[0] || null;
    if (results[1].status === 'rejected') { status.error = `${LABELS[provider]} login check failed: ${safeDiagnostic(results[1].reason.message)}`; return status; }
    const auth = results[1].value;
    if (provider === 'codex') {
      const output = `${auth.stdout}\n${auth.stderr}`;
      status.authenticated = auth.code === 0 && /logged in using chatgpt/i.test(output);
      status.authType = status.authenticated ? 'ChatGPT subscription' : /api key/i.test(output) ? 'API key (not used)' : null;
    } else {
      try {
        const parsed = JSON.parse(auth.stdout);
        const method = String(parsed.authMethod || '').toLowerCase();
        status.authenticated = auth.code === 0 && parsed.loggedIn === true && ['claude.ai', 'oauth'].includes(method) && (!parsed.apiProvider || parsed.apiProvider === 'firstParty');
        status.authType = status.authenticated ? 'Claude subscription' : parsed.loggedIn ? 'API or external provider (not used)' : null;
      } catch { status.error = 'Claude Code returned an unreadable login status. Update Claude Code and refresh.'; }
    }
    if (!status.authenticated && !status.error) status.error = provider === 'codex' ? 'Sign in to Codex with your ChatGPT account using “codex login”, then refresh.' : 'Sign in to Claude Code using “claude auth login”, then refresh. The Claude desktop login is separate.';
    const version = status.version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.slice(1).map(Number);
    if (provider === 'claude' && version && (version[0] < 2 || (version[0] === 2 && (version[1] < 1 || (version[1] === 1 && version[2] < 259))))) {
      status.compatible = false;
      status.error = 'Claude Code 2.1.259 or later is required for unattended permission handling. Update Claude Code using its official installer, then refresh connections.';
    }
    return status;
  }
  async function discoverProviders() {
    const [codex, claude] = await Promise.all(PROVIDERS.map((provider) => inspect(provider)));
    return { codex, claude };
  }
  async function runProvider({ provider, prompt, cwd, model, outputSchema, webSearch = false, timeoutMs = 300000, signal, onEvent = () => {} }) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Enter a goal before starting.');
    if (typeof cwd !== 'string' || !cwd) throw new Error('An isolated working directory is required.');
    if (model != null && (typeof model !== 'string' || model.length > 150 || /[\r\n\0]/.test(model))) throw new Error('Invalid model name.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Invalid response timeout.');
    if (typeof webSearch !== 'boolean') throw new Error('Invalid web search setting.');
    let serializedSchema;
    if (outputSchema != null) {
      if (provider !== 'codex') throw new Error('Output schemas are currently supported for Codex calls only.');
      if (typeof outputSchema !== 'object' || Array.isArray(outputSchema)) throw new Error('The output schema must be a JSON object.');
      try { serializedSchema = JSON.stringify(outputSchema); }
      catch { throw new Error('The output schema must contain serializable JSON.'); }
      if (!serializedSchema || serializedSchema.length > 65536 || !serializedSchema.startsWith('{')) throw new Error('The output schema must be a JSON object smaller than 64 KB.');
    }
    const status = await inspect(provider, signal);
    if (signal?.aborted) { const error = new Error('Debate cancelled.'); error.name = 'AbortError'; throw error; }
    if (!status.available || !status.authenticated || status.compatible === false) throw new Error(status.error);
    let schemaDirectory;
    try {
      let outputSchemaPath;
      if (serializedSchema) {
        schemaDirectory = await mkdtemp(join(temporaryRoot, 'ai-collab-schema-'));
        outputSchemaPath = join(schemaDirectory, 'response.schema.json');
        await writeFile(outputSchemaPath, serializedSchema, { mode: 0o600, flag: 'wx' });
      }
      // Searching produces progress messages before the final answer; only the final answer is kept.
      const parser = createOutputParser(provider, onEvent, { finalResponseOnly: Boolean(serializedSchema) || webSearch });
      let nonJson = '';
      const result = await execute(status.path, providerArguments(provider, model?.trim(), { outputSchemaPath, webSearch }), {
        cwd, input: prompt, timeoutMs, signal,
        onLine(line) {
          let event;
          try { event = JSON.parse(line); }
          catch { nonJson = (nonJson + '\n' + line).slice(-MAX_DIAGNOSTIC); return; }
          parser.consume(event);
        },
      });
      if (result.code !== 0) {
        let details;
        try { parser.result(); } catch (error) { details = error.message; }
        const diagnostic = safeDiagnostic(result.stderr || nonJson || details);
        if (/unknown (?:option|argument|feature)|unexpected argument|unrecognized (?:option|argument)|invalid value.*feature/i.test(diagnostic)) {
          throw new Error(`${LABELS[provider]} does not support an option required by AI Collab. Update it using the official installer, then refresh connections.${diagnostic ? ` ${diagnostic}` : ''}`);
        }
        throw new Error(`${LABELS[provider]} exited with code ${result.code}.${diagnostic ? ` ${diagnostic}` : ''}`);
      }
      const output = parser.result();
      return { ...output, model: output.model || model || null };
    } finally {
      if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
    }
  }
  return { discoverProviders, runProvider, configureProviderPaths };
}

const adapter = createCliAdapter();
export const discoverProviders = adapter.discoverProviders;
export const runProvider = adapter.runProvider;
export const configureProviderPaths = adapter.configureProviderPaths;
