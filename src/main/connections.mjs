import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configureProviderPaths as configureInstalledPaths, discoverProviders as inspectInstalledProviders, SUBSCRIPTION_ENVIRONMENT_EXCLUSIONS, subscriptionEnvironment } from './cli.mjs';
import { environmentValue, platformPaths, windowsSystemExecutable } from './processes.mjs';

const executeFile = promisify(execFile);
const PROVIDERS = ['codex', 'claude'];
const LABELS = { codex: 'Codex', claude: 'Claude Code' };
const INSTALLERS = {
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
};

function checkProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown assistant.');
}

function checkPath(file, platform = process.platform) {
  if (typeof file !== 'string' || !platformPaths(platform).isAbsolute(file) || file.length > 8192 || /[\r\n\0]/.test(file)) throw new Error('Choose an absolute executable path.');
  return file;
}

export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
export function powerShellQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

export function buildPowerShellSetupScript({ provider, action, binary, resultPath, home, env = process.env }) {
  checkProvider(provider);
  if (!['install', 'login'].includes(action)) throw new Error('Unknown setup action.');
  for (const file of [binary, resultPath, home]) checkPath(file, 'win32');
  const quote = powerShellQuote;
  const locationVariables = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].filter(name => environmentValue(env, name));
  const installer = provider === 'codex' ? 'https://chatgpt.com/codex/install.ps1' : 'https://claude.ai/install.ps1';
  return [
    "$ErrorActionPreference = 'Stop'",
    '$_aiCollabExit = 1',
    `$_aiCollabResult = ${quote(resultPath)}`,
    '$_aiCollabInstaller = $null',
    'try {',
    `  Get-ChildItem Env: | Where-Object { $_.Name -match ${quote(SUBSCRIPTION_ENVIRONMENT_EXCLUSIONS)} } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }`,
    '  Remove-Item Env:CODEX_HOME, Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue',
    ...locationVariables.map(name => `  $env:${name} = ${quote(environmentValue(env, name))}`),
    `  $env:PATH = ${quote(path.win32.join(home, '.local', 'bin') + ';' + path.win32.dirname(binary) + ';')} + $env:PATH`,
    "  $env:NO_COLOR = '1'",
    ...(action === 'install' ? [
      `  Write-Host ${quote(`Installing ${LABELS[provider]} using its official installer...`)}`,
      ...(provider === 'codex' ? [`  $env:CODEX_INSTALL_DIR = ${quote(path.win32.dirname(binary))}`] : []),
      "  $_aiCollabInstaller = Join-Path $PSScriptRoot ('installer-' + [guid]::NewGuid().ToString() + '.ps1')",
      `  Invoke-WebRequest -UseBasicParsing -Uri ${quote(installer)} -OutFile $_aiCollabInstaller`,
      '  $global:LASTEXITCODE = 0',
      `  & ${quote(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', env))} -NoLogo -NoProfile -ExecutionPolicy Bypass -File $_aiCollabInstaller`,
      "  if ($LASTEXITCODE -ne 0) { throw 'The official installer did not finish successfully.' }",
    ] : []),
    `  if (!(Test-Path -LiteralPath ${quote(binary)} -PathType Leaf)) { throw 'The CLI executable was not found after setup.' }`,
    `  Write-Host ${quote(`Sign in to ${LABELS[provider]} with your subscription account in the browser.`)}`,
    '  $global:LASTEXITCODE = 0',
    `  & ${quote(binary)} ${provider === 'codex' ? 'login' : 'auth login'}`,
    "  if ($LASTEXITCODE -ne 0) { throw 'Sign-in did not complete.' }",
    '  $_aiCollabExit = 0',
    "  Write-Host 'Sign-in finished. Return to AI Collab; its connection status will update automatically.'",
    '} catch {',
    "  Write-Host 'Setup did not finish. Check the messages above, then return to AI Collab and try again.' -ForegroundColor Red",
    "  Write-Host ('Setup detail: ' + $_.Exception.Message) -ForegroundColor Red",
    '} finally {',
    '  if ($_aiCollabInstaller) { Remove-Item -LiteralPath $_aiCollabInstaller -Force -ErrorAction SilentlyContinue }',
    "  Set-Content -LiteralPath ($_aiCollabResult + '.tmp') -Value ([string]$_aiCollabExit) -Encoding ASCII",
    "  Move-Item -LiteralPath ($_aiCollabResult + '.tmp') -Destination $_aiCollabResult -Force",
    '}',
    '',
  ].join('\r\n');
}

export async function openSetupTerminal(scriptPath, { platform = process.platform, env = process.env, spawn = nodeSpawn } = {}) {
  if (platform !== 'win32') {
    await executeFile('/usr/bin/open', ['-a', 'Terminal', scriptPath], { env: subscriptionEnvironment(env, platform), timeout: 12000, maxBuffer: 8192 });
    return;
  }
  const executable = windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', env);
  // libuv's detached Windows processes have no console. Start-Process explicitly
  // creates a visible interactive console; its hidden bootstrap waits for it so
  // closing that window can be detected even if no result marker was written.
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    `$_aiCollabTerminal = Start-Process -FilePath ${powerShellQuote(executable)} -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ${powerShellQuote('"' + scriptPath + '"')}) -WindowStyle Normal -PassThru -Wait`,
    'exit $_aiCollabTerminal.ExitCode',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      env: subscriptionEnvironment(env, platform), shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    // Only the hidden launcher's errors are captured. The visible login console
    // has its own output; neither login output nor this diagnostic is persisted.
    let diagnostic = '';
    child.stderr?.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    const closed = new Promise(resolveClosed => {
      child.once('close', code => resolveClosed({ exitCode: Number.isInteger(code) ? code : 1, ...(diagnostic.trim() ? { diagnostic: diagnostic.trim() } : {}) }));
      child.once('error', () => resolveClosed({ exitCode: 1 }));
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); child.stderr?.unref?.(); resolve({ closed }); });
  });
}

export function buildSetupScript({ provider, action, binary, resultPath, home, env = process.env }) {
  checkProvider(provider);
  if (!['install', 'login'].includes(action)) throw new Error('Unknown setup action.');
  checkPath(binary); checkPath(resultPath); checkPath(home);
  const locationVariables = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].filter(name => typeof env[name] === 'string' && env[name]);
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'umask 077',
    `_ai_collab_result=${shellQuote(resultPath)}`,
    `trap '_ai_collab_exit=$?; printf "%s\\n" "$_ai_collab_exit" > "$_ai_collab_result.tmp"; /bin/mv -f "$_ai_collab_result.tmp" "$_ai_collab_result"; exit "$_ai_collab_exit"' EXIT`,
    // Terminal may already be running and may load shell profiles, so scrub inside
    // this script as well as in the process that opens it. Values are never saved.
    `_ai_collab_excluded=${shellQuote(SUBSCRIPTION_ENVIRONMENT_EXCLUSIONS)}`,
    'while IFS= read -r _ai_collab_name; do',
    '  if [[ "$_ai_collab_name" =~ $_ai_collab_excluded ]]; then unset "$_ai_collab_name"; fi',
    'done < <(compgen -e)',
    'unset _ai_collab_name _ai_collab_excluded',
    'unset CODEX_HOME CLAUDE_CONFIG_DIR',
    ...locationVariables.map(name => `export ${name}=${shellQuote(env[name])}`),
    `export PATH=${shellQuote(path.join(home, '.local/bin'))}:"\${PATH:-/usr/bin:/bin}":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    'export NO_COLOR=1',
    ...(action === 'install' ? [
      `printf '%s\\n' ${shellQuote(`Installing ${LABELS[provider]} using its official installer…`)}`,
      ...(provider === 'codex' ? [`export CODEX_INSTALL_DIR=${shellQuote(path.join(home, '.local/bin'))}`] : []),
      INSTALLERS[provider],
    ] : []),
    `if [[ ! -f ${shellQuote(binary)} || ! -x ${shellQuote(binary)} ]]; then`,
    `  printf '%s\\n' ${shellQuote(`${LABELS[provider]} executable was not found after setup. Choose its location in AI Collab.`)} >&2`,
    '  exit 1',
    'fi',
    `printf '%s\\n' ${shellQuote(`Sign in to ${LABELS[provider]} with your subscription account in the browser.`)}`,
    `${shellQuote(binary)} ${provider === 'codex' ? 'login' : 'auth login'}`,
    `printf '%s\\n' ${shellQuote('Sign-in finished. Return to AI Collab; its connection status will update automatically.')}`,
    '',
  ].join('\n');
}

export function createConnectionManager({
  userData,
  home = homedir(),
  env = process.env,
  platform = process.platform,
  configureProviderPaths = configureInstalledPaths,
  discoverProviders = inspectInstalledProviders,
  openTerminal = scriptPath => openSetupTerminal(scriptPath, { platform, env }),
} = {}) {
  if (!userData || !path.isAbsolute(userData)) throw new Error('A local app data directory is required.');
  const settingsPath = path.join(userData, 'connections.json');
  const setupDirectory = path.join(userData, 'setup');
  const operations = new Map();
  const paths = platformPaths(platform);
  const terminalName = platform === 'win32' ? 'PowerShell' : 'Terminal';
  let configured = { codex: null, claude: null };
  let mutations = Promise.resolve();

  const getConfiguredPaths = () => ({ ...configured });
  function serial(operation) {
    const result = mutations.catch(() => {}).then(operation);
    mutations = result;
    return result;
  }
  async function savePaths(next) {
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const temporary = `${settingsPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, paths: next }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, settingsPath);
    configureProviderPaths(next);
    configured = { ...next };
    return getConfiguredPaths();
  }
  async function init() {
    let saved;
    try { saved = JSON.parse(await readFile(settingsPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Saved connection settings could not be read. Restore or remove connections.json before selecting a different installation.');
    }
    if (saved) {
      if (saved.version !== 1 || !saved.paths || typeof saved.paths !== 'object' || Array.isArray(saved.paths)) throw new Error('Saved connection settings have an unsupported format.');
      for (const provider of PROVIDERS) configured[provider] = saved.paths[provider] == null ? null : checkPath(saved.paths[provider], platform);
    }
    configureProviderPaths(configured);
    return getConfiguredPaths();
  }
  async function setExecutable(provider, file) {
    checkProvider(provider); checkPath(file, platform);
    try {
      if (platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file)) throw new Error('Not a Windows executable');
      if (!(await stat(file)).isFile()) throw new Error('Not a regular file');
      await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    } catch { throw new Error(`Choose the runnable ${LABELS[provider]} executable, not a folder or app bundle.`); }
    return serial(() => savePaths({ ...configured, [provider]: file }));
  }
  async function clearExecutable(provider) {
    checkProvider(provider);
    return serial(() => savePaths({ ...configured, [provider]: null }));
  }
  async function setupProvider(provider, action) {
    checkProvider(provider);
    if (!['install', 'login'].includes(action)) throw new Error('Unknown setup action.');
    return serial(async () => {
      const installation = platform === 'win32' ? provider === 'codex'
        ? paths.join(environmentValue(env, 'LOCALAPPDATA') || paths.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
        : paths.join(home, '.local', 'bin', 'claude.exe') : path.join(home, '.local/bin', provider);
      const binary = action === 'install' ? installation : (await discoverProviders())[provider]?.path;
      if (!binary) throw new Error(`Choose or install the ${LABELS[provider]} executable before signing in.`);
      const operationId = randomUUID();
      await mkdir(setupDirectory, { recursive: true, mode: 0o700 });
      const scriptPath = path.join(setupDirectory, `${provider}-${operationId}.${platform === 'win32' ? 'ps1' : 'command'}`);
      const resultPath = path.join(setupDirectory, `${operationId}.result`);
      const script = platform === 'win32' ? '\ufeff' + buildPowerShellSetupScript({ provider, action, binary, resultPath, home, env }) : buildSetupScript({ provider, action, binary, resultPath, home, env });
      await writeFile(scriptPath, script, { mode: 0o700 });
      const previous = getConfiguredPaths();
      if (action === 'install') await savePaths({ ...configured, [provider]: binary });
      const operation = { resultPath, terminalClosed: false };
      try {
        const terminal = await openTerminal(scriptPath);
        if (platform === 'win32' && terminal?.closed?.then) {
          Promise.resolve(terminal.closed).then(() => { operation.terminalClosed = true; }, () => { operation.terminalClosed = true; });
        }
      }
      catch {
        if (action === 'install') await savePaths(previous);
        throw new Error(`${terminalName} could not be opened. Open ${terminalName} and install or sign in to the CLI, then refresh connections.`);
      }
      operations.set(operationId, operation);
      return { provider, action, operationId, started: true, message: action === 'install'
        ? `Continue the official ${LABELS[provider]} installation and sign-in in ${terminalName}.`
        : `Complete ${LABELS[provider]} sign-in in ${terminalName} and your browser.` };
    });
  }
  async function getSetupResult(operationId) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error('Unknown setup operation.');
    const { resultPath } = operation;
    try {
      const metadata = await stat(resultPath);
      if (!metadata.isFile() || metadata.size > 16) throw new Error('Invalid setup result.');
      const value = (await readFile(resultPath, 'utf8')).trim();
      if (!/^\d{1,3}$/.test(value) || Number(value) > 255) throw new Error('Invalid setup result.');
      return { complete: true, exitCode: Number(value) };
    } catch (error) {
      if (error.code === 'ENOENT') return operation.terminalClosed ? { complete: true, exitCode: 1 } : { complete: false };
      throw new Error('Setup finished without a readable completion status. Refresh connections to check the sign-in.');
    }
  }
  return { init, getConfiguredPaths, setExecutable, clearExecutable, setupProvider, getSetupResult };
}
