// Test the actual packaged app with an empty profile and no provider accounts.
// No login, installer, inference, or user's profile is accessed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createDocumentFixtures } from './fixtures/document-fixtures.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'ai-collab-release-'));
const profile = path.join(root, 'profile');
const output = path.join(project, 'test-results');
const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const platformFolder = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac') : 'win-unpacked';
const executable = process.platform === 'darwin' ? 'AI Collab.app/Contents/MacOS/AI Collab' : 'AI Collab.exe';
const executablePath = process.env.AI_COLLAB_PACKAGED_EXECUTABLE || path.join(project, 'dist', 'release', platformFolder, executable);
const errors = [];
let desktop;
try {
  await mkdir(output, { recursive: true });
  const fixtures = await createDocumentFixtures(path.join(root, 'sources'));
  const env = { ...process.env,
    AI_COLLAB_CODEX_PATH: path.join(root, 'intentionally-missing-codex.exe'),
    AI_COLLAB_CLAUDE_PATH: path.join(root, 'intentionally-missing-claude.exe'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AI_COLLAB_DATA_DIR;
  desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 45000 });
  assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), manifest.version);
  assert.equal(await realpath(await desktop.evaluate(({ app }) => app.getPath('userData'))), await realpath(profile));
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.locator('body:not(.app-loading)').waitFor();
  await page.locator('#connections-dialog[open]').waitFor();
  for (const provider of ['codex', 'claude']) {
    await page.locator(`#connection-${provider} .connection-status`).filter({ hasText: /^Not installed$/ }).waitFor();
    assert.equal(await page.locator(`#connection-${provider} .provider-primary`).innerText(), 'Install CLI');
  }
  const initial = await page.evaluate(() => window.council.getState());
  assert.equal(initial.runs.length, 0);
  assert.equal(initial.activeRunId, null);
  assert.equal(initial.providers.codex.authenticated, false);
  assert.equal(initial.providers.claude.authenticated, false);
  await page.screenshot({ path: path.join(output, `release-connections-${process.platform}-${process.arch}.png`) });
  await page.locator('#done-connections').click();
  await page.locator('#goal').fill('Use the uploaded documents to check the shipment target.');
  assert.equal(await page.locator('#start-debate').isDisabled(), true, 'an unsigned-in recipient cannot accidentally start a provider call');
  await desktop.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, fixtures.map(fixture => fixture.path));
  await page.locator('#attach-files').click();
  await page.waitForFunction(count => document.querySelectorAll('.source-chip').length === count || !document.querySelector('#attachment-errors')?.hidden, fixtures.length);
  assert.equal(await page.locator('#attachment-errors').isVisible(), false, await page.locator('#attachment-errors').innerText());
  assert.equal(await page.locator('.source-chip').count(), fixtures.length);
  for (const fixture of fixtures) {
    await page.locator('.source-name').filter({ hasText: fixture.name }).first().click();
    assert.ok((await page.locator('#source-preview-text').innerText()).includes(fixture.expected), `${fixture.name} text survives native/portable reader and asar packaging`);
    await page.keyboard.press('Escape');
  }
  // Exercise the bundled portable worker even on macOS; its asar/PDF.js path is
  // independent of the native PDFKit branch used by this platform's normal UI.
  const applicationPath = await desktop.evaluate(({ app }) => app.getAppPath());
  const portable = await desktop.evaluate(async (_, input) => {
    const require = process.getBuiltinModule('node:module').createRequire(input.modulePath);
    const { AttachmentStore } = require(input.modulePath);
    const store = new AttachmentStore({ storageDir: input.storageDir, platform: 'win32' });
    await store.init();
    const result = await store.importFiles(input.files);
    return { errors: result.errors, files: result.attachments.map(attachment => ({ name: attachment.name, text: store.get(attachment.id).text })) };
  }, { modulePath: path.join(applicationPath, 'src/main/attachments.mjs'), storageDir: path.join(root, 'portable'), files: fixtures.map(fixture => fixture.path) });
  assert.deepEqual(portable.errors, [], 'portable document dependencies and worker load from app.asar');
  for (const fixture of fixtures) assert.ok(portable.files.find(file => file.name === fixture.name)?.text.includes(fixture.expected), `portable packaged ${fixture.name} extraction`);
  const preferences = { models: { codex: '', claude: '', moderator: 'gpt-6-sol' }, timeoutMinutes: 40 };
  assert.deepEqual(await page.evaluate(value => window.council.savePreferences(value), preferences), preferences);
  await page.reload();
  await page.locator('body:not(.app-loading)').waitFor();
  assert.deepEqual((await page.evaluate(() => window.council.getState())).preferences, preferences);
  assert.equal(await page.locator('#goal').inputValue(), '');
  assert.equal(await page.locator('.source-chip').count(), 0);
  assert.deepEqual(errors, [], 'packaged renderer has no script or CSP errors');
  console.log(`Release ${manifest.version} ${process.platform}/${process.arch}: isolated startup, missing-provider guidance, CSV/PDF/DOCX/RTF/XLSX imports, and saved defaults passed.`);
} finally {
  await desktop?.close();
  await rm(root, { recursive: true, force: true });
}
