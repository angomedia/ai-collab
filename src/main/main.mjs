import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Council, exportMarkdown } from './orchestrator.mjs';
import { discoverProviders, runProvider } from './cli.mjs';
import { discoverModels, invalidateModels } from './models.mjs';
import { AttachmentStore } from './attachments.mjs';
import { createConnectionManager } from './connections.mjs';
import { applyQuestionPreferences, createPreferencesStore } from './preferences.mjs';
import { summarizeResponse } from './summaries.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = 'collab://app/index.html';
const setupTerminal = process.platform === 'win32' ? 'PowerShell' : 'Terminal';
const validProviders = new Set(['codex', 'claude']);
let window;
let council;
let attachments;
let providers;
let providerRefresh;
let connections;
let preferences;
let setupTimer;
const pendingSetups = new Map();
let quitting = false;

// Optional test storage is isolated from the user's real debate history.
if (process.env.AI_COLLAB_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.AI_COLLAB_DATA_DIR));
app.setName('AI Collab');
if (process.platform === 'win32') app.setAppUserModelId('local.aicollab.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'collab', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.whenReady().then(initialize).catch(error => {
    dialog.showErrorBox('AI Collab could not start', error.message);
    app.exit(1);
  });
}

async function refreshProviders() {
  if (providerRefresh) return providerRefresh;
  providerRefresh = discoverProviders().then(async result => {
    const configured = connections?.getConfiguredPaths() || {};
    for (const provider of validProviders) {
      const setup = pendingSetups.get(provider);
      if (setup && !setup.completed) {
        let completion = { complete: false };
        try { if (setup.operationId) completion = await connections.getSetupResult(setup.operationId); }
        catch (error) { setup.error = error.message; }
        if (completion.complete) {
          invalidateModels();
          if (completion.exitCode === 0) {
            pendingSetups.delete(provider);
            // The auth check above can precede the login process finishing by a moment.
            result[provider] = (await discoverProviders())[provider];
          } else {
            setup.completed = true;
            setup.error = `Setup did not finish. Check the ${setupTerminal} window, then try again.`;
          }
        } else if (!setup.error && Date.now() - setup.startedAt > 10 * 60 * 1000) {
          setup.error = `Connection check paused. Finish or cancel setup in ${setupTerminal}, then refresh status.`;
        }
      }
      if (providers?.[provider] && (providers[provider].authenticated !== result[provider].authenticated || providers[provider].path !== result[provider].path || providers[provider].version !== result[provider].version)) invalidateModels();
      result[provider].configuredPath = configured[provider] || null;
      const current = pendingSetups.get(provider);
      result[provider].setup = current ? { action: current.action, startedAt: current.startedAt, pending: !current.completed, ...(current.error ? { error: current.error } : {}) } : null;
    }
    providers = result;
    if (window && !window.isDestroyed()) window.webContents.send('council:providers-updated', result);
    return result;
  }).finally(() => { providerRefresh = null; });
  return providerRefresh;
}

function assertConnectionsEditable(provider) {
  if (!validProviders.has(provider)) throw new Error('Unknown assistant.');
  if (council.activeRunId) throw new Error('Stop the current discussion before changing connections.');
  const pending = pendingSetups.get(provider);
  if (pending && !pending.completed) throw new Error(`Finish or cancel the setup in ${setupTerminal} first, then refresh status.`);
}

function watchConnections() {
  clearTimeout(setupTimer);
  if (quitting || ![...pendingSetups.values()].some(setup => !setup.error)) return;
  setupTimer = setTimeout(async () => {
    try { await refreshProviders(); }
    catch (error) { console.error('Connection check failed:', error.message); }
    finally { watchConnections(); }
  }, 2500);
  setupTimer.unref?.();
}

async function setupProvider(provider, action) {
  assertConnectionsEditable(provider);
  // Reserve the action before launching setup so repeated clicks cannot open duplicate flows.
  const setup = { action, startedAt: Date.now() };
  pendingSetups.set(provider, setup);
  try {
    const result = await connections.setupProvider(provider, action);
    setup.operationId = result.operationId;
    invalidateModels();
    await refreshProviders();
    watchConnections();
    return result;
  } catch (error) {
    pendingSetups.delete(provider);
    throw error;
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url.split('#')[0] !== APP_URL) throw new Error('Unsupported app request.');
    return handler(...args);
  });
}

function publicRun(run) {
  if (!run) return run;
  return { ...run, attachments: (run.attachments || []).map(({ text, sha256, ...metadata }) => metadata) };
}

async function prepareQuestion(input, previous = null, { resuming = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a question first.');
  if ([...pendingSetups.values()].some(setup => !setup.completed)) throw new Error(`Finish or cancel setup in ${setupTerminal}, then refresh status before starting a discussion.`);
  const sourceDocuments = attachments.resolve(input.attachmentIds ?? []);
  const effective = applyQuestionPreferences(input, previous, preferences.getPreferences());
  if (typeof effective.moderatorModel !== 'string' || !effective.moderatorModel || !/^[a-zA-Z0-9._:/\[\]-]{1,150}$/.test(effective.moderatorModel)) {
    throw new Error('Choose a moderator model in Models & time.');
  }
  // Each question uses current subscription authentication and explicit model selections.
  const status = await refreshProviders();
  for (const provider of validProviders) {
    if (!status[provider]?.available) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude Code'} is not installed or could not be found.`);
    if (status[provider]?.compatible === false) throw new Error(status[provider].error);
    if (!status[provider]?.authenticated) throw new Error(`Sign in to ${provider === 'codex' ? 'Codex' : 'Claude Code'} first, then refresh connections.`);
  }
  const models = await discoverModels();
  for (const provider of validProviders) {
    const selected = effective[`${provider}Model`];
    const retained = previous && selected === previous.models?.[provider];
    if (!retained && !models[provider]?.options.some(option => option.id === selected)) throw new Error(`Choose a ${provider === 'codex' ? 'Codex' : 'Claude'} model from the picker. Refresh models if the list has changed.`);
  }
  // The moderator is a separate role and model, using the same Codex subscription login.
  if (!models.codex?.options.some(option => option.id === effective.moderatorModel)) {
    throw new Error(`The moderator model “${effective.moderatorModel}” is not in the current Codex model list. ${resuming
      ? 'This paused question keeps its original models. Restore access and refresh models, or stop this question and resend it with another moderator model.'
      : 'Open Models & time to refresh or select another moderator model.'}`);
  }
  if ([...pendingSetups.values()].some(setup => !setup.completed)) throw new Error(`Finish or cancel setup in ${setupTerminal}, then refresh status before starting a discussion.`);
  return { ...effective, attachments: sourceDocuments };
}

async function initialize() {
  connections = createConnectionManager({ userData: app.getPath('userData') });
  await connections.init();
  preferences = createPreferencesStore({ userData: app.getPath('userData') });
  await preferences.init();
  const files = { '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/renderer.js': ['renderer.js', 'text/javascript'] };
  protocol.handle('collab', async request => {
    const url = new URL(request.url);
    const entry = url.host === 'app' && files[url.pathname];
    if (!entry) return new Response('Not found', { status: 404 });
    return new Response(await readFile(path.join(directory, '../renderer', entry[0])), { headers: {
      'Content-Type': `${entry[1]}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
    } });
  });
  council = new Council({ runProvider, summarizeResponse, storageDir: path.join(app.getPath('userData'), 'debates') });
  await council.init();
  attachments = new AttachmentStore({
    storageDir: path.join(app.getPath('userData'), 'attachments'),
    pdfHelperPath: app.isPackaged ? path.join(process.resourcesPath, 'document-reader') : path.join(app.getAppPath(), 'resources', 'document-reader'),
  });
  await attachments.init();
  council.on('run-updated', run => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('council:run-updated', publicRun(run));
      window.setProgressBar(run.status === 'running' ? 2 : -1);
    }
  });
  council.on('storage-warning', message => console.error('History save failed:', message));

  handle('council:state', async () => ({ providers: providers || await refreshProviders(), runs: council.listRuns().map(publicRun), activeRunId: council.activeRunId,
    preferences: preferences.getPreferences(), preferencesWarning: preferences.getWarning() }));
  handle('council:preferences-save', input => preferences.savePreferences(input));
  handle('council:providers', refreshProviders);
  handle('council:models', force => discoverModels({ force: force === true }));
  handle('council:attachments-pick', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Add documents to the debate', buttonLabel: 'Add documents',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported documents', extensions: ['pdf', ...(process.platform === 'darwin' ? ['doc'] : []), 'docx', 'rtf', 'txt', 'md', 'csv', 'tsv', 'json', 'xlsx'] }],
    });
    if (result.canceled) return { attachments: [], errors: [] };
    return attachments.importFiles(result.filePaths);
  });
  handle('council:attachment-remove', async id => {
    if (typeof id !== 'string') throw new Error('Invalid attachment.');
    // Removing a draft selection must never break sources in an older saved debate.
    const inHistory = council.listRuns().some(run => run.attachments?.some(source => source.id === id));
    if (!inHistory) await attachments.remove(id);
  });
  handle('council:attachments-reuse', id => {
    const run = council.getRun(id);
    if (!run) throw new Error('This debate was not found.');
    return (run.attachments || []).map(source => {
      const metadata = attachments.public(source.id);
      if (metadata) return metadata;
      // The conversation's immutable snapshot remains usable even if its import cache is missing.
      const { text, sha256, ...saved } = source;
      if (typeof text !== 'string') throw new Error(`The saved attachment “${source.name}” could not be found. Add the document again.`);
      return { ...saved, preview: text.slice(0, 1500), previewTruncated: text.length > 1500 };
    });
  });
  handle('council:start', async input => {
    return publicRun(await council.start(await prepareQuestion(input)));
  });
  handle('council:follow-up', async (id, input) => {
    const previous = typeof id === 'string' && council.getRun(id);
    if (!previous) throw new Error('This conversation was not found.');
    return publicRun(await council.followUp(id, await prepareQuestion(input, previous)));
  });
  handle('council:clarification-answer', async (id, input) => {
    const previous = typeof id === 'string' && council.getRun(id);
    if (!previous || previous.status !== 'awaiting_input') throw new Error('This conversation is no longer waiting for an answer.');
    // A pause can outlive account setup or an app restart. Recheck connections and
    // the original model choices before resuming, without replacing source snapshots.
    await prepareQuestion({ goal: previous.currentQuestion, attachmentIds: [],
      codexModel: previous.models.codex, claudeModel: previous.models.claude,
      moderatorModel: previous.models.moderator, timeoutMinutes: previous.timeoutMinutes }, previous, { resuming: true });
    return publicRun(await council.answerClarification(id, input));
  });
  handle('council:stop', async id => publicRun(await council.stop(id)));
  handle('council:copy', text => {
    if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('This text could not be copied.');
    clipboard.writeText(text);
  });
  handle('council:open-link', async value => {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid link.');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links can be opened.');
    await shell.openExternal(url.href);
  });
  handle('council:export', async id => {
    const run = council.getRun(id);
    if (!run) throw new Error('This debate was not found.');
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Export debate', defaultPath: `AI Collab - ${run.createdAt.slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { cancelled: true };
    await writeFile(filePath, exportMarkdown(run), 'utf8');
    return { cancelled: false, path: filePath };
  });
  handle('council:setup-provider', setupProvider);
  handle('council:sign-in', provider => setupProvider(provider, 'login'));
  handle('council:choose-executable', async provider => {
    assertConnectionsEditable(provider);
    const result = await dialog.showOpenDialog(window, {
      title: `Choose the ${provider === 'codex' ? 'Codex' : 'Claude Code'} executable`,
      buttonLabel: 'Use executable', properties: ['openFile', 'showHiddenFiles'],
    });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    assertConnectionsEditable(provider);
    await connections.setExecutable(provider, result.filePaths[0]);
    pendingSetups.delete(provider);
    invalidateModels();
    if (providerRefresh) await providerRefresh;
    return { cancelled: false, providers: await refreshProviders() };
  });
  handle('council:clear-executable', async provider => {
    assertConnectionsEditable(provider);
    await connections.clearExecutable(provider);
    pendingSetups.delete(provider);
    invalidateModels();
    if (providerRefresh) await providerRefresh;
    return { providers: await refreshProviders() };
  });
  createWindow();
  refreshProviders().catch(error => console.error('Connection check failed:', error.message));
  const template = [
    process.platform === 'darwin'
      ? { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }
      : { label: 'File', submenu: [{ role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Show saved debates', click: () => shell.openPath(path.join(app.getPath('userData'), 'debates', 'runs')) },
      { label: 'Help and downloads', click: () => shell.openExternal('https://github.com/angomedia/ai-collab#readme') },
      ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'about' }]),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 850, minHeight: 650,
    title: 'AI Collab', backgroundColor: '#ffffff', show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 } } : {}),
    webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('focus', () => { refreshProviders().catch(error => console.error('Connection check failed:', error.message)); });
  window.on('closed', () => { window = null; });
  window.loadURL(APP_URL);
}

app.on('activate', () => { if (!window && council) createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !council) return;
  event.preventDefault();
  quitting = true;
  clearTimeout(setupTimer);
  council.close().catch(error => console.error(error.message)).finally(() => app.quit());
});
