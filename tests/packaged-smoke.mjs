// Verify native helpers, asar dependencies/workers, and live model discovery in the built Mac app.
// Pass --live to run a document question and contextual follow-up using existing logins.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import ExcelJS from 'exceljs';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), 'ai-collab-package-test-'));
const profile = path.join(temporary, 'profile');
const artifacts = path.join(project, 'test-results');
const executablePath = process.env.AI_COLLAB_PACKAGED_EXECUTABLE || path.join(project, `dist/AI Collab-darwin-${process.arch}/AI Collab.app/Contents/MacOS/AI Collab`);
const live = process.argv.includes('--live');
const errors = [];
let desktop;
let page;

async function completedTurn(count) {
  const deadline = Date.now() + 480000;
  let runs = [];
  let phase;
  while (Date.now() < deadline) {
    ({ runs } = await page.evaluate(() => window.council.getState()));
    if (runs[0]?.turns?.length === count && runs[0].status !== 'running') break;
    if (runs[0]?.phase && runs[0].phase !== phase) { phase = runs[0].phase; console.log(`Question ${count}: ${phase}`); }
    await delay(400);
  }
  assert.equal(runs.length, 1, 'follow-ups remain in one conversation');
  const run = runs[0];
  assert.equal(run.turns.length, count);
  assert.equal(run.status, 'completed', run.error || 'Live conversation did not finish');
  assert.equal(run.final.decided, true, JSON.stringify(run.final.unresolved));
  assert.equal(run.final.moderation?.action, 'finalize');
  assert.ok(run.turns.at(-1).plan?.roles?.codex?.label);
  assert.ok(run.turns.at(-1).plan?.roles?.claude?.label);
  await page.locator('.final-message').nth(count - 1).waitFor();
  return run;
}
try {
  await mkdir(artifacts, { recursive: true });
  const csv = path.join(temporary, 'shipments.csv');
  const brief = path.join(temporary, 'brief.txt');
  const docx = path.join(temporary, 'brief.docx');
  const xlsx = path.join(temporary, 'shipments.xlsx');
  const pdf = path.join(temporary, 'target-scan.pdf');
  await writeFile(csv, 'shipment,units\nAlpha,17\nBeta,25\n');
  await writeFile(brief, 'Count Alpha and Beta once each. The workbook repeats the CSV for reference; it is not extra shipments. Compare the total against the project target in the PDF.');
  await promisify(execFile)('/usr/bin/textutil', ['-convert', 'docx', '-output', docx, '--', brief]);
  await promisify(execFile)('/usr/bin/swift', [path.join(project, 'tests/fixtures/create-scan.swift'), pdf], { timeout: 60000 });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Shipments');
  sheet.addRows([['shipment', 'units'], ['Alpha', 17], ['Beta', 25]]);
  await workbook.xlsx.writeFile(xlsx);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AI_COLLAB_CODEX_PATH;
  delete env.AI_COLLAB_CLAUDE_PATH;
  desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 45000 });
  const actualProfile = await desktop.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(await realpath(actualProfile), await realpath(profile), 'packaged checks use an isolated profile');
  page = await desktop.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.locator('body:not(.app-loading)').waitFor();
  await page.locator('#open-connections').click();
  await page.locator('#connections-dialog[open]').waitFor();
  for (const provider of ['codex', 'claude']) {
    await page.locator(`#connection-${provider} .connection-status`).filter({ hasText: /^Connected$/ }).waitFor();
    assert.equal(await page.locator(`#connection-${provider} .connection-status`).innerText(), 'Connected');
    assert.equal(await page.locator(`#connection-${provider} .provider-primary`).innerText(), 'Reconnect');
  }
  assert.equal(await desktop.evaluate(({ app }) => app.getVersion()), JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version);
  await page.screenshot({ path: path.join(artifacts, 'packaged-connections.png') });
  await page.locator('#done-connections').click();
  await page.waitForFunction(() => document.querySelector('#codex-model')?.options.length > 1 && document.querySelector('#claude-model')?.options.length > 1);
  const catalog = await page.evaluate(() => window.council.getModels());
  assert.equal(catalog.codex.source, 'live');
  assert.equal(catalog.claude.source, 'live');
  assert.ok(catalog.codex.options.length > 1 && catalog.claude.options.length > 1);
  const codex = catalog.codex.options.find(option => option.id && option.isDefault) || catalog.codex.options.find(option => option.id);
  const claude = catalog.claude.options.find(option => option.id === 'sonnet');
  assert.ok(claude, 'a known subscription Claude model is available for the test');
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#moderator-model').inputValue(), 'gpt-6-sol');
  assert.ok(catalog.codex.options.some(option=>option.id==='gpt-6-sol'));
  await page.locator('#codex-model').selectOption(codex.id);
  await page.locator('#claude-model').selectOption(claude.id);
  await page.locator('#timeout-minutes').selectOption('40');
  await page.locator('#save-defaults').click();
  await page.waitForFunction(() => document.querySelector('#defaults-status')?.textContent === 'Saved for new chats.' && !document.querySelector('#save-defaults')?.disabled);
  const savedPreferences = { models: { codex: codex.id, claude: claude.id, moderator: 'gpt-6-sol' }, timeoutMinutes: 40 };
  assert.deepEqual((await page.evaluate(() => window.council.getState())).preferences, savedPreferences);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')), { version: 1, ...savedPreferences });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#timeout-minutes')?.value === '40' && !document.querySelector('#moderator-model')?.disabled);
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#codex-model').inputValue(), codex.id);
  assert.equal(await page.locator('#claude-model').inputValue(), claude.id);
  assert.equal(await page.locator('#moderator-model').inputValue(), 'gpt-6-sol');
  assert.equal(await page.locator('#goal').inputValue(), '');
  assert.equal(await page.locator('.source-chip').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'packaged-saved-defaults.png') });
  console.log('Packaged model/time defaults saved to the isolated profile and restored after reload.');
  await page.locator('#close-settings').click();
  await desktop.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [csv, docx, xlsx, pdf]);
  await page.locator('#attach-files').click();
  await page.waitForFunction(() => document.querySelectorAll('.source-chip').length === 4 || !document.querySelector('#attachment-errors')?.hidden);
  assert.equal(await page.locator('#attachment-errors').isVisible(), false, await page.locator('#attachment-errors').innerText());
  assert.equal(await page.locator('.source-chip').count(), 4);
  for (const [filename, expected] of [['shipments.csv', 'Alpha,17'], ['brief.docx', 'Count Alpha and Beta once each'], ['shipments.xlsx', 'B2: "17"'], ['target-scan.pdf', 'Project target is 42']]) {
    await page.locator('.source-name').filter({ hasText: filename }).first().click();
    assert.ok((await page.locator('#source-preview-text').innerText()).includes(expected));
    await page.keyboard.press('Escape');
  }
  await page.locator('#goal').fill('Use the attached sources to calculate total shipped units and compare that total with the PDF project target. Explain whether the target is met. Cite the source filenames. Keep the final answer under 100 words.');
  assert.equal(await page.locator('#max-rounds').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'packaged-documents.png') });
  console.log(`Packaged imports and live catalogs passed: ${catalog.codex.options.length - 1} Codex / ${catalog.claude.options.length - 1} Claude choices; CSV, DOCX, XLSX worker, and scanned PDF OCR.`);
  if (live) {
    await page.locator('#start-debate').click();
    const run = await completedTurn(1);
    assert.equal(run.attachments.length, 4);
    assert.equal(run.models.codex, codex.id);
    assert.equal(run.models.claude, claude.id);
    assert.equal(run.models.moderator, 'gpt-6-sol');
    assert.ok(run.messages.some(message => message.provider === 'moderator' && message.kind === 'planning' && message.plan));
    assert.ok(run.messages.some(message => message.provider === 'moderator' && message.kind === 'adjudication' && message.adjudication?.action === 'finalize'));
    assert.match(run.final.text, /42/);
    assert.match(run.final.text, /shipments\.csv/);
    assert.match(run.final.text, /target-scan\.pdf/);
    await page.locator('.final-message').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'packaged-live-solution.png') });
    console.log(`Live document debate passed with ${codex.id}, ${claude.id}, and moderator gpt-6-sol: ${run.messages.length} messages, decided=${run.final.decided}, consensus=${run.final.consensus}.\n${run.final.text}`);
    await page.locator('#goal').fill('What if Beta was 30 units instead? Recalculate against the same PDF target, retaining the other shipment. Explain the change from your previous answer in under 100 words and cite the files.');
    await page.locator('#start-debate').click();
    const continued = await completedTurn(2);
    assert.equal(continued.id, run.id);
    assert.equal(continued.attachments.length, 4);
    assert.deepEqual(continued.turns[0].final, run.turns[0].final);
    assert.deepEqual(continued.turns[0].plan, run.turns[0].plan);
    assert.ok(continued.turns[1].plan);
    assert.match(continued.final.text, /47/);
    assert.match(continued.final.text, /42/);
    assert.match(continued.final.text, /5|five/i);
    assert.equal(await page.locator('.user-message').count(), 2);
    assert.equal(await page.locator('.final-message').count(), 2);
    await page.locator('.final-message').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'packaged-live-followup.png') });
    await page.reload();
    await page.locator('body:not(.app-loading)').waitFor();
    await page.locator('.chat-item').first().click();
    assert.equal(await page.locator('.final-message').count(), 2);
    console.log(`Live follow-up passed: same conversation, 4 retained sources, both original and follow-up answers survive reload.\n${continued.final.text}`);
  }
  assert.deepEqual(errors, [], 'packaged renderer has no console errors');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'packaged-failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-12000));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
