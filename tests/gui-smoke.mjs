// Exercise the real Electron UI, IPC, coordinator, and child-process adapters.
// All model responses come from temporary fake CLI executables; no account is used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ai-collab-gui-'));
const resultsDir = path.join(project, 'test-results');
const controlPath = path.join(temporary, 'control.json');
const callLogPath = path.join(temporary, 'calls.jsonl');
const exportPath = path.join(temporary, 'exported-debate.md');
const csvName = 'source-benchmarks.csv';
const textName = 'scope-notes.txt';
const csvPath = path.join(temporary, csvName);
const textPath = path.join(temporary, textName);
const sourceMarker = 'COUNCIL_SOURCE_MARKER_7419';
const noteMarker = 'SOURCE_NOTE_SINGLE_DEVICE_8326';
const initialGoal = 'Plan a two-week prototype for a personal knowledge app. Compare simplicity, search quality, and a realistic validation plan.';
const followupGoal = 'Turn the agreed plan into a release checklist. FOLLOWUP_MARKER_RELEASE_CHECKLIST_9462';
const priorFinalMarker = 'PRIOR_FINAL_MARKER_5081';
const followupAnswerMarker = 'FOLLOWUP_ANSWER_MARKER_3918';
const refinedInitial = 'Choose a focused local knowledge-app prototype and a measurable two-week validation plan.';
const refinedFollowup = 'Build a release checklist from the prior agreed prototype, retaining the evidence and open risks.';
const initialRoles = { codex: 'Prototype scope advocate', claude: 'Retrieval evidence skeptic' };
const followupRoles = { codex: 'Release readiness advocate', claude: 'Failure recovery reviewer' };
const stopGoal = 'Explore a longer architecture discussion. [STOP TEST]';
const errors = [];
let desktop;
let page;

const fakeCli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const provider = path.basename(process.argv[1]).startsWith('codex') ? 'codex' : 'claude';
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(process.env.AI_COLLAB_TEST_CONTROL, 'utf8'));
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (args.includes('--version')) {
  console.log(provider === 'codex' ? 'codex-cli 0.0.0-gui-test' : 'Claude Code 2.1.304-gui-test');
  process.exit(0);
}
if (args[0] === 'login' || args[0] === 'auth') {
  if (provider === 'codex') console.log('Logged in using ChatGPT');
  else emit({loggedIn: control.claudeLoggedIn, authMethod: 'claude.ai', apiProvider: 'firstParty'});
  process.exit(0);
}
const isCatalog = args.includes('app-server') || (args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');
if (isCatalog) {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (provider === 'codex' && message.method === 'initialize') emit({id: message.id, result: {userAgent: 'AI Collab GUI test'}});
      if (provider === 'codex' && message.method === 'model/list') emit({id: message.id, result: {
        data: [{id: 'codex-test', model: 'codex-test', displayName: 'Codex test model', description: 'A model from the test Codex catalog.', isDefault: true},
          {id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', description: 'The moderator test model.'}].filter(model => model.id !== control.hiddenCodexModel), nextCursor: null
      }});
      if (provider === 'claude' && message.type === 'control_request' && message.request?.subtype === 'initialize') emit({
        type: 'control_response', response: {subtype: 'success', request_id: message.request_id, response: {
          commands: [], agents: [], account: {}, output_style: 'default', available_output_styles: ['default'],
          models: [{value: 'claude-test', displayName: 'Claude test model', description: 'A model from the test Claude catalog.'}]
        }}
      });
    }
  });
} else {
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const rawPhase = prompt.match(/PHASE:\\s*(PLANNING|PLAN|ADJUDICATION|JUDGE|ANALYSIS|CRITIQUE|SYNTHESIS|REVISION|REVIEW)/)?.[1];
  const phase = ({PLANNING: 'PLAN', ADJUDICATION: 'JUDGE'})[rawPhase] || rawPhase;
  const version = Number(prompt.match(/CANDIDATE_VERSION:\\s*(\\d+)/)?.[1] || 1);
  const turn = Number(prompt.match(/TURN_NUMBER:\\s*(\\d+)/)?.[1] || 1);
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';
  const callId = provider + '-' + process.pid;
  fs.appendFileSync(process.env.AI_COLLAB_TEST_CALLS, JSON.stringify({event: 'start', callId, provider, phase, rawPhase, version, turn, model, prompt}) + '\\n');
  const logEnd = () => fs.appendFileSync(process.env.AI_COLLAB_TEST_CALLS, JSON.stringify({event: 'end', callId}) + '\\n');
  process.on('SIGTERM', () => { logEnd(); process.exit(0); });
  let text;
  if (phase === 'PLAN') {
    const labels = turn === 1 ? ${JSON.stringify(initialRoles)} : ${JSON.stringify(followupRoles)};
    text = JSON.stringify({refinedQuestion: turn === 1 ? ${JSON.stringify(refinedInitial)} : ${JSON.stringify(refinedFollowup)},
      mode: turn === 1 ? 'opposing' : 'complementary',
      rationale: turn === 1 ? 'Compare fast delivery against evidence that the retrieval workflow is useful.' : 'Check both release readiness and recovery without inventing disagreement about the prior evidence.',
      roles: {codex: {label: labels.codex, instructions: 'Build the strongest practical case for scope and delivery; update your position when evidence warrants it.'},
        claude: {label: labels.claude, instructions: 'Test assumptions, retrieval evidence, and failure recovery; acknowledge facts and useful corrections.'}}});
  }
  else if (phase === 'JUDGE') text = JSON.stringify({candidate_version: version, action: version < 4 ? 'revise' : 'finalize',
    reason: version < 4 ? 'The answer still needs a concrete criterion before the discussion can conclude.' : turn === 1 ? 'Both reviews and the evidence support this exact plan.' : 'The checklist is ready as a bounded recommendation; the remaining concern is preserved explicitly.',
    revisionInstructions: version < 4 ? ['Add the measurable retrieval threshold and keep the agreed scope.'] : [],
    remainingDisagreements: turn > 1 && version === 4 ? ['Claude still prefers a stricter retrieval threshold before release.'] : []});
  else if (phase === 'ANALYSIS') text = provider === 'codex'
    ? '## Start with a small, useful prototype\\n\\nUse a local SQLite database and a simple desktop interface. Keep notes in plain text and add full-text search. The first version should make saving and retrieving one useful note feel effortless.\\n\\n**Success criterion:** five people can save and find a note without help. Reserve the second week for observation and fixes.'
    : '## Validate retrieval before adding features\\n\\nThe hardest part is whether people can find the right note later. Start with ten realistic notes and three retrieval tasks, then test a simple full-text search interface.\\n\\nKeep synchronization and semantic search out of the first prototype. A local SQLite store is a reasonable starting point, assuming one device is enough.';
  else if (phase === 'CRITIQUE') text = provider === 'codex'
    ? 'Claude is right to make retrieval the central test. The plan should specify representative tasks and capture whether people succeed without hints. Keep the initial architecture simple, then revise it only when the tests reveal a concrete need.'
    : 'Codex has proposed a practical scope. The main gap is a measurable validation threshold: define what counts as successful retrieval and observe several participants. Include the single-device assumption in the final plan.';
  else if (phase === 'SYNTHESIS') text = '## A focused two-week prototype\\n\\nBuild a local notes app with SQLite and full-text search.\\n\\n1. **Week one:** implement note capture, editing, and retrieval.\\n2. **Week two:** test realistic tasks with five people and fix the largest points of friction.\\n\\nStart with one device. Add synchronization after validating the core workflow.';
  else if (phase === 'REVISION') text = '## Build the smallest useful knowledge app\\n\\nUse **SQLite with full-text search** and a simple desktop interface. Keep the first version focused on capturing a note and finding it again.\\n\\n### Week one: build the core loop\\n\\n1. Add note creation, editing, and search.\\n2. Prepare ten representative notes and three realistic retrieval tasks.\\n3. Keep data local and make a plain-text export available.\\n\\n### Week two: test and improve\\n\\nAsk five people to complete the tasks without hints. Aim for **at least four of five participants** to find the right note on each task. Record failures and improve the wording or search behavior before expanding scope.\\n\\n**Assumption:** one device is enough for this prototype. Defer synchronization and semantic search until the observed problems justify them.';
  else if (phase === 'REVIEW') {
    const revise = provider === 'claude' && (version < 4 || turn > 1);
    text = JSON.stringify({candidate_version: version, verdict: revise ? 'revise' : 'approve',
      summary: revise ? 'The plan is improving, but the retrieval success criterion still needs a measurable threshold.' : 'I agree with this version. It gives us a practical scope, a measurable test, and clear assumptions.',
      issues: revise ? ['The retrieval success criterion needs a measurable threshold.'] : [],
      suggestions: revise ? ['Define a target such as four of five participants succeeding.'] : []});
  }
  else { console.error('Missing workflow phase'); process.exit(2); }
  if (phase === 'SYNTHESIS' || phase === 'REVISION') {
    text += turn > 1
      ? '\\n\\n## Release checklist\\n\\n- Verify note capture and retrieval.\\n- Test with five participants.\\n- Export a backup before release.\\n\\nFOLLOWUP_ANSWER_MARKER_3918'
      : '\\n\\nReference: PRIOR_FINAL_MARKER_5081';
  }
  const id = provider + '-message';
  if (provider === 'codex') {
    emit({type: 'thread.started', thread_id: 'gui-test-codex'});
    emit({type: 'turn.started'});
  } else {
    emit({type: 'system', subtype: 'init', session_id: 'gui-test-claude', model: model || 'test-claude'});
    emit({type: 'stream_event', event: {type: 'message_start', message: {id, model: model || 'test-claude'}}});
  }
  const shouldStop = prompt.includes('[STOP TEST]') && phase === 'ANALYSIS';
  const first = shouldStop ? provider + ': partial response awaiting cancellation.' : text.slice(0, Math.min(90, text.length));
  const stream = delta => provider === 'codex'
    ? emit({type: 'agent_message.delta', item_id: id, delta})
    : emit({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: delta}}});
  stream(first);
  if (shouldStop) { setInterval(() => {}, 1000); return; }
  setTimeout(() => {
    stream(text.slice(first.length));
    logEnd();
    if (provider === 'codex') {
      emit({type: 'item.completed', item: {id, type: 'agent_message', text}});
      emit({type: 'turn.completed', usage: {input_tokens: 10, output_tokens: 20}});
    } else {
      emit({type: 'assistant', message: {id, model: model || 'test-claude', content: [{type: 'text', text}]}});
      emit({type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'gui-test-claude'});
    }
  }, turn > 1 && phase === 'SYNTHESIS' ? 1200 : 160);
});
}
`;

async function setAuthentication(loggedIn) {
  await writeFile(controlPath, JSON.stringify({ claudeLoggedIn: loggedIn }));
}

async function launchDesktop(env) {
  desktop = await electron.launch({ executablePath: electronPath, args: [project], env, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || /violates.*content security policy|refused to.*content security policy/i.test(message.text())) errors.push(message.text());
  });
  await page.setViewportSize({ width: 1320, height: 880 });
  await page.locator('body:not(.app-loading)').waitFor();
  assert.equal(await page.locator('#boot-error').isVisible(), false);
}

async function waitForText(selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
}

async function expectAttachments(count) {
  await page.waitForFunction(expected => document.querySelectorAll('#source-list .source-chip').length === expected
    && !document.querySelector('#attach-files').disabled, count);
  assert.equal(await page.locator('#attachment-errors').isVisible(), false);
}

async function waitForChat(goal, status, turnCount = 1) {
  const deadline = Date.now() + 25000;
  let last;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.council.getState());
    last = state.runs.find(run => run.goal === goal);
    if (last?.status === status && last.turns?.length === turnCount && state.activeRunId !== last.id) return last;
    if (last && ['failed', 'timed_out'].includes(last.status)) assert.fail(`Chat unexpectedly ${last.status}: ${last.error}`);
    await delay(50);
  }
  assert.fail(`Chat did not reach ${status} with ${turnCount} turns: ${JSON.stringify(last)}`);
}

async function checkNarrowLayout(filename) {
  await page.setViewportSize({ width: 850, height: 650 });
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    panelWidth: document.querySelector('.main-panel').clientWidth,
    panelScrollWidth: document.querySelector('.main-panel').scrollWidth,
    composerVisible: document.querySelector('#goal').getBoundingClientRect().bottom <= innerHeight,
  }));
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth, `page overflow: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.panelScrollWidth <= dimensions.panelWidth + 1, `main panel overflow: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.composerVisible, 'the question composer stays accessible at the minimum window size');
  await page.screenshot({ path: path.join(resultsDir, filename) });
  await page.setViewportSize({ width: 1320, height: 880 });
}

async function assertNeutralColors() {
  const colored = await page.evaluate(() => {
    const failures = [];
    for (const element of document.querySelectorAll('body, body *')) {
      if (!element.getClientRects().length) continue;
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        for (const property of ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'outlineColor', 'boxShadow']) {
          for (const match of style[property].matchAll(/rgba?\(([^)]+)\)/g)) {
            const channels = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            if (channels.length > 3 && channels[3] === 0) continue;
            if (Math.max(...channels.slice(0, 3)) - Math.min(...channels.slice(0, 3)) > 1) {
              failures.push(`${element.id || element.className || element.tagName}${pseudo || ''} ${property}: ${match[0]}`);
            }
          }
        }
      }
    }
    return [...new Set(failures)].slice(0, 20);
  });
  assert.deepEqual(colored, [], 'all visible interface colors are neutral grayscale');
}

async function closeConnectionsWithEscape() {
  await page.keyboard.press('Escape');
  await page.locator('#connections-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.id === 'open-connections');
}

async function testSavedDefaults(env) {
  const before = await page.evaluate(() => window.council.getState());
  const original = before.runs.find(run => run.goal === initialGoal);
  const defaults = { models: { codex: 'gpt-6-sol', claude: 'claude-test', moderator: 'codex-test' }, timeoutMinutes: 40 };
  const override = { models: { codex: 'codex-test', claude: '', moderator: 'gpt-6-sol' }, timeoutMinutes: 10 };
  const overrideGoal = 'Use these settings for this chat only. [PERSISTED DEFAULTS TEST]';
  const settings = async () => page.evaluate(() => ({
    models: Object.fromEntries(['codex', 'claude', 'moderator'].map(provider => [provider, document.querySelector(`#${provider}-model`).value])),
    timeoutMinutes: Number(document.querySelector('#timeout-minutes').value),
  }));
  async function choose(values) {
    for (const [provider, model] of Object.entries(values.models)) await page.locator(`#${provider}-model`).selectOption(model);
    await page.locator('#timeout-minutes').selectOption(String(values.timeoutMinutes));
  }
  const savedPreferences = async () => (await page.evaluate(() => window.council.getState())).preferences;
  const assertOriginalHistory = async () => {
    const current = await page.evaluate(() => window.council.getState());
    for (const run of before.runs) assert.deepEqual(current.runs.find(item => item.id === run.id), run, 'saving defaults and overriding a chat never rewrites existing conversation history');
  };

  await page.locator('#chat-list button').filter({ hasText: initialGoal }).click();
  await page.locator('#settings-toggle').click();
  await choose(defaults);
  await page.locator('#save-defaults').click();
  await waitForText('#defaults-status', 'Saved for new chats');
  assert.deepEqual(await savedPreferences(), defaults);
  await page.screenshot({ path: path.join(resultsDir, 'gui-saved-defaults.png') });
  await page.locator('#close-settings').click();
  await page.locator('#new-chat').click();
  assert.deepEqual(await settings(), defaults, 'a new chat inherits explicitly saved model and time defaults');
  assert.equal(await page.locator('#goal').inputValue(), '', 'a new chat does not inherit a historical question');
  await expectAttachments(0);

  // Overrides and an unsent draft survive navigation, but neither changes defaults.
  await page.locator('#goal').fill(overrideGoal);
  await page.locator('#settings-toggle').click();
  await choose(override);
  await page.locator('#close-settings').click();
  await page.locator('#chat-list button').filter({ hasText: initialGoal }).click();
  await expectAttachments(2);
  await page.locator('#new-chat').click();
  assert.equal(await page.locator('#goal').inputValue(), overrideGoal);
  assert.deepEqual(await settings(), override);
  await expectAttachments(0);
  assert.deepEqual(await savedPreferences(), defaults, 'per-chat dropdown changes alone do not save new defaults');
  await page.locator('#start-debate').click();
  const overridden = await waitForChat(overrideGoal, 'completed');
  assert.deepEqual(overridden.models, override.models);
  assert.equal(overridden.timeoutMinutes, override.timeoutMinutes);
  assert.deepEqual(overridden.attachments, []);
  assert.deepEqual(await savedPreferences(), defaults);
  await page.locator('#new-chat').click();
  assert.deepEqual(await settings(), defaults, 'a consumed new-chat override is not reused for the next new chat');
  assert.equal(await page.locator('#goal').inputValue(), '');
  await expectAttachments(0);
  await assertOriginalHistory();

  // Restart Electron itself, not just the renderer, with the same isolated profile.
  const oldPid = desktop.process().pid;
  await desktop.close();
  await launchDesktop(env);
  assert.notEqual(desktop.process().pid, oldPid);
  await waitForText('#provider-codex', 'Connected');
  await page.waitForFunction(() => [...document.querySelector('#moderator-model').options].some(option => option.value === 'codex-test' && !option.disabled));
  assert.deepEqual(await savedPreferences(), defaults, 'saved defaults survive a complete app restart');
  await page.locator('#new-chat').click();
  assert.deepEqual(await settings(), defaults);
  assert.equal(await page.locator('#goal').inputValue(), '');
  await expectAttachments(0);
  await assertOriginalHistory();
  await page.locator('#chat-list button').filter({ hasText: initialGoal }).click();
  assert.deepEqual(await settings(), { models: original.models, timeoutMinutes: original.timeoutMinutes }, 'historical chats retain their own models and time limit after restart');
  await expectAttachments(2);
  await page.locator('#new-chat').click();

  // The provider catalog can change after a preference was saved. Retain the
  // saved selection visibly and block sending; never substitute another model.
  await writeFile(controlPath, JSON.stringify({ claudeLoggedIn: true, hiddenCodexModel: defaults.models.moderator }));
  await page.locator('#settings-toggle').click();
  await page.locator('#refresh-models').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-models').disabled
    && document.querySelector('#moderator-model option:checked')?.textContent.includes('unavailable'));
  assert.equal(await page.locator('#moderator-model').inputValue(), defaults.models.moderator);
  assert.deepEqual(await savedPreferences(), defaults);
  await page.locator('#close-settings').click();
  await page.locator('#goal').fill('Do not substitute an unavailable saved moderator.');
  assert.equal(await page.locator('#start-debate').isDisabled(), true);
  assert.match(await page.locator('#composer-notice').innerText(), /moderator|unavailable/i);
  await page.locator('#settings-toggle').click();
  await page.screenshot({ path: path.join(resultsDir, 'gui-defaults-unavailable.png') });
  await writeFile(controlPath, JSON.stringify({ claudeLoggedIn: true }));
  await page.locator('#refresh-models').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-models').disabled
    && !document.querySelector('#moderator-model option:checked')?.disabled);
  assert.equal(await page.locator('#moderator-model').inputValue(), defaults.models.moderator);

  // Fail only the Save IPC after testing real persistence. No false success is
  // allowed, and the previously durable defaults must remain unchanged.
  await desktop.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('council:preferences-save');
    ipcMain.handle('council:preferences-save', () => { throw new Error('ENOSPC test: defaults could not be saved.'); });
  });
  await page.locator('#timeout-minutes').selectOption('60');
  await page.locator('#save-defaults').click();
  await waitForText('#defaults-status', 'ENOSPC test');
  assert.match(await page.locator('#defaults-status').getAttribute('class'), /error/);
  assert.doesNotMatch(await page.locator('#defaults-status').innerText(), /Saved for new chats/);
  assert.deepEqual(await savedPreferences(), defaults, 'a rejected save does not change durable defaults');
  await assertOriginalHistory();
  await page.locator('#close-settings').click();
}

async function testModeratorFailureUi() {
  const snapshot = await page.evaluate(() => window.council.getState());
  const sourceRun = snapshot.runs.find(run => run.goal === initialGoal);
  const now = new Date().toISOString();
  const question = 'Compare the two career paths using the attached notes. [VALIDATION FAILURE UI]';
  const detail = 'The moderator response ended before the complete plan was returned. Try the question again.';
  const failed = {
    id: 'gui-validation-failure', goal: question, currentQuestion: question, turnId: 'gui-validation-turn',
    createdAt: now, updatedAt: now, status: 'failed', phase: 'failed', timeoutMinutes: 20,
    models: { codex: 'codex-test', claude: 'claude-test', moderator: 'gpt-6-sol' },
    attachments: sourceRun.attachments, final: null, error: `Moderator: ${detail}`,
    turns: [{ id: 'gui-validation-turn', question, createdAt: now, updatedAt: now, status: 'failed', final: null, plan: null,
      models: { codex: 'codex-test', claude: 'claude-test', moderator: 'gpt-6-sol' }, error: `Moderator: ${detail}` }],
    messages: [1, 2].map(attempt => ({ id: `gui-invalid-plan-${attempt}`, turnId: 'gui-validation-turn', provider: 'moderator',
      kind: 'planning', status: 'failed', failureKind: 'validation', createdAt: now,
      text: '{"refinedQuestion":"private incomplete protocol', error: detail,
      validationError: { code: 'invalid_json', path: '$', message: detail, attempt } })),
  };
  // Only public snapshots and follow-up IPC are replaced in this isolated app.
  // The recovery assertion launches no model or real account operation.
  await desktop.evaluate(({ ipcMain, BrowserWindow }, { snapshot, failed }) => {
    globalThis.__failureUiSnapshot = { ...snapshot, runs: [...snapshot.runs, failed], activeRunId: null };
    ipcMain.removeHandler('council:state');
    ipcMain.handle('council:state', () => structuredClone(globalThis.__failureUiSnapshot));
    ipcMain.removeHandler('council:follow-up');
    ipcMain.handle('council:follow-up', (_event, id, input) => {
      globalThis.__failureUiFollowup = { id, input };
      throw new Error('Recovery submission captured without starting a model.');
    });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('council:run-updated', failed);
  }, { snapshot, failed });
  await page.locator('#chat-list button').filter({ hasText: question }).click();
  await waitForText('#thread .moderator-plan', 'response ended before');
  assert.equal(await page.locator('#thread .moderator-plan').count(), 2);
  for (const label of await page.locator('#thread .assistant-message .message-label').allTextContents()) {
    assert.match(label, /failed/);
    assert.doesNotMatch(label, /interrupted/);
  }
  const text = await page.locator('#thread').innerText();
  assert.doesNotMatch(text, /refinedQuestion|private incomplete protocol|could not assign reliable/);
  await expectAttachments(2);
  const retry = page.locator('.retry-question');
  await page.locator('#goal').fill('Keep this unsent draft.');
  assert.equal(await retry.isDisabled(), true, 'recovery never overwrites an unsent draft');
  assert.equal(await page.locator('#goal').inputValue(), 'Keep this unsent draft.');
  await page.locator('#goal').fill('');
  await retry.click();
  assert.equal(await page.locator('#goal').inputValue(), question);
  assert.equal(await page.locator('#source-list .source-chip.retained').count(), 2);
  await page.screenshot({ path: path.join(resultsDir, 'gui-validation-failure.png') });
  await page.locator('#start-debate').click();
  await waitForText('#send-error', 'Recovery submission captured');
  const recovery = await desktop.evaluate(() => globalThis.__failureUiFollowup);
  assert.equal(recovery.id, failed.id, 'recovery stays in the same conversation');
  assert.equal(recovery.input.goal, question);
  assert.deepEqual(recovery.input.attachmentIds, [], 'saved source files are inherited, not duplicated');
  assert.equal(recovery.input.moderatorModel, 'gpt-6-sol');
  assert.equal(await page.locator('#goal').inputValue(), question, 'a rejected recovery keeps the draft');
}

async function testConnectionSetupUi() {
  const original = await page.evaluate(() => window.council.getState());
  const catalog = await page.evaluate(() => window.council.getModels(false));
  // Replace setup and picker IPC handlers in this one isolated test process.
  // No real installer, login, logout, browser opener, or executable-setting write can run.
  await desktop.evaluate(({ ipcMain, BrowserWindow }, { snapshot, catalog }) => {
    globalThis.__connectionTestState = structuredClone(snapshot);
    globalThis.__connectionActions = [];
    globalThis.__connectionModelRequests = [];
    globalThis.__connectionSendAttempts = 0;
    const register = (channel, callback) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, callback); };
    const announce = () => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('council:providers-updated', globalThis.__connectionTestState.providers);
      return structuredClone(globalThis.__connectionTestState.providers);
    };
    register('council:state', () => structuredClone(globalThis.__connectionTestState));
    register('council:providers', () => announce());
    register('council:models', async (_event, force) => {
      globalThis.__connectionModelRequests.push({ force });
      if (globalThis.__holdConnectionModels) await new Promise(resolve => { globalThis.__releaseConnectionModels = resolve; });
      return structuredClone(catalog);
    });
    for (const channel of ['council:start', 'council:follow-up']) register(channel, () => {
      globalThis.__connectionSendAttempts += 1;
      throw new Error('No discussion should start during connection setup tests.');
    });
    register('council:setup-provider', (_event, provider, action) => {
      globalThis.__connectionActions.push({ provider, action });
      return { started: true, provider, action, message: 'Setup action captured by test; nothing was launched.' };
    });
    register('council:choose-executable', (_event, provider) => {
      globalThis.__connectionActions.push({ provider, action: 'choose' });
      globalThis.__connectionTestState.providers[provider].configuredPath = '/test/custom/bin/' + provider;
      return { cancelled: false, providers: announce() };
    });
    register('council:clear-executable', (_event, provider) => {
      globalThis.__connectionActions.push({ provider, action: 'reset' });
      globalThis.__connectionTestState.providers[provider].configuredPath = null;
      return { providers: announce() };
    });
    register('council:sign-in', () => { throw new Error('Legacy sign-in must not be called by connection setup.'); });
    register('council:open-link', () => { globalThis.__connectionActions.push({ action: 'help' }); return { opened: true }; });
  }, { snapshot: original, catalog });

  async function expectForcedCatalogRefresh(previousCount, reason) {
    const deadline = Date.now() + 5000;
    let requests;
    do {
      requests = await desktop.evaluate(() => globalThis.__connectionModelRequests);
      if (requests.length > previousCount) break;
      await delay(25);
    } while (Date.now() < deadline);
    assert.ok(requests.length > previousCount, reason);
    assert.equal(requests.at(-1).force, true, reason);
  }

  await page.locator('#open-connections').click();
  await waitForText('#connection-codex .connection-status', 'Connected');
  await waitForText('#connection-claude .connection-status', 'Connected');
  assert.equal(await page.locator('#connection-codex .provider-primary').innerText(), 'Reconnect');
  await page.locator('#connection-codex .provider-primary').click();
  await waitForText('#connection-codex .connection-setup-note', `${process.platform === 'win32' ? 'PowerShell' : 'Terminal'} opened`);
  await page.locator('#connection-codex details summary').click();
  let catalogRequests = await desktop.evaluate(() => globalThis.__connectionModelRequests.length);
  await page.locator('#connection-codex .choose-executable').click();
  await waitForText('#connection-codex .connection-path', 'Custom executable: /test/custom/bin/codex');
  await expectForcedCatalogRefresh(catalogRequests, 'choosing a new executable refreshes models while authentication stays connected');
  assert.equal(await page.locator('#connection-codex .reset-executable').isVisible(), true);
  catalogRequests = await desktop.evaluate(() => globalThis.__connectionModelRequests.length);
  await page.locator('#connection-codex .reset-executable').click();
  await page.locator('#connection-codex .reset-executable').waitFor({ state: 'hidden' });
  await expectForcedCatalogRefresh(catalogRequests, 'resetting an executable refreshes models while authentication stays connected');
  await page.locator('#connection-codex .provider-help').click();
  await page.locator('#connection-codex details summary').click();
  await page.locator('#done-connections').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.querySelector('#connections-dialog').contains(document.activeElement)), true, 'modal keeps keyboard focus inside');
  await page.locator('#done-connections').click();
  await page.waitForFunction(() => document.activeElement?.id === 'open-connections');

  // A fresh renderer starts with one missing CLI and one installed signed-out CLI.
  // The synthetic initial state and fake executable paths cannot inspect real logins.
  await desktop.evaluate(() => {
    const state = globalThis.__connectionTestState;
    state.providers.codex = { available: false, authenticated: false, path: null, configuredPath: null, version: null, error: 'The test Codex CLI is not installed.' };
    state.providers.claude = { ...state.providers.claude, available: true, authenticated: false, configuredPath: null, error: 'Sign in to your own Claude account.' };
    state.runs = []; state.activeRunId = null;
  });
  await page.reload();
  await page.locator('body:not(.app-loading)').waitFor();
  await page.locator('#connections-dialog').waitFor({ state: 'visible' });
  await waitForText('#connection-codex .connection-status', 'Not installed');
  await waitForText('#connection-claude .connection-status', 'Sign in needed');
  assert.equal(await page.locator('#connection-codex .provider-primary').innerText(), 'Install CLI');
  assert.equal(await page.locator('#connection-claude .provider-primary').innerText(), 'Connect');
  await assertNeutralColors();
  await page.screenshot({ path: path.join(resultsDir, 'gui-connections-setup.png') });
  await page.setViewportSize({ width: 850, height: 650 });
  const modalFits = await page.locator('#connections-dialog').evaluate(dialog => {
    const box = dialog.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  });
  assert.equal(modalFits, true, 'setup dialog fits the minimum window size');
  await page.screenshot({ path: path.join(resultsDir, 'gui-connections-setup-narrow.png') });
  await page.setViewportSize({ width: 1320, height: 880 });
  await page.locator('#connection-codex .provider-primary').click();
  await page.locator('#connection-claude .provider-primary').click();
  const actions = await desktop.evaluate(() => globalThis.__connectionActions);
  for (const expected of [{ provider: 'codex', action: 'login' }, { provider: 'codex', action: 'choose' }, { provider: 'codex', action: 'reset' }, { provider: 'codex', action: 'install' }, { provider: 'claude', action: 'login' }]) {
    assert.ok(actions.some(action => action.provider === expected.provider && action.action === expected.action), `setup action routed correctly: ${JSON.stringify(expected)}`);
  }
  await page.locator('#close-connections').click();
  await page.locator('#connections-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#open-connections').isVisible(), true, 'Connections remains discoverable after closing first-launch setup');
  await page.locator('#goal').fill('A question that needs both accounts connected.');
  assert.equal(await page.locator('#goal-form button[type="submit"]').isDisabled(), true);
  await page.locator('#open-connections').click();
  await closeConnectionsWithEscape();

  // Simulate finishing both official sign-ins, then verify refresh makes the app usable.
  await desktop.evaluate((_electron, providers) => { globalThis.__connectionTestState.providers = providers; }, original.providers);
  await page.locator('#open-connections').click();
  await page.locator('#refresh-connections').click();
  await waitForText('#connection-codex .connection-status', 'Connected');
  await waitForText('#connection-claude .connection-status', 'Connected');
  await page.locator('#done-connections').click();
  await page.waitForFunction(() => !document.querySelector('#goal-form button[type="submit"]').disabled);

  // A signed-in but outdated CLI must offer an update, not silently run with fewer restrictions.
  await desktop.evaluate(({ BrowserWindow }) => {
    Object.assign(globalThis.__connectionTestState.providers.claude, { compatible: false, error: 'Claude Code 2.1.259 or later is required. Update Claude Code.' });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('council:providers-updated', globalThis.__connectionTestState.providers);
  });
  await waitForText('#composer-notice', 'update the CLI');
  assert.equal(await page.locator('#goal-form button[type="submit"]').isDisabled(), true);
  await page.locator('#open-connections').click();
  await waitForText('#connection-claude .connection-status', 'Update required');
  await waitForText('#connection-claude .connection-setup-error', '2.1.259');
  await page.locator('#connection-claude .provider-primary').click();
  assert.ok((await desktop.evaluate(() => globalThis.__connectionActions)).some(action => action.provider === 'claude' && action.action === 'install'));
  await desktop.evaluate((_electron, providers) => { globalThis.__connectionTestState.providers = providers; }, original.providers);
  await page.locator('#refresh-connections').click();
  await waitForText('#connection-claude .connection-status', 'Connected');
  await page.locator('#done-connections').click();
  await page.waitForFunction(() => !document.querySelector('#goal-form button[type="submit"]').disabled);

  // Reconnecting an already connected account must still block messages until
  // completion; failed setup must leave a visible retry path.
  async function publishSetup(setup) {
    await desktop.evaluate(({ BrowserWindow }, value) => {
      globalThis.__connectionTestState.providers.codex.setup = value;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('council:providers-updated', globalThis.__connectionTestState.providers);
    }, setup);
  }
  await publishSetup({ action: 'login', startedAt: Date.now() });
  await waitForText('#composer-notice', 'Finish connecting');
  assert.equal(await page.locator('#goal-form button[type="submit"]').isDisabled(), true);
  await page.locator('#goal').focus();
  await page.keyboard.press('Meta+Enter');
  await page.locator('#open-connections').click();
  for (const selector of ['.provider-primary', '.choose-executable', '.reset-executable']) assert.equal(await page.locator(`#connection-codex ${selector}`).isDisabled(), true, 'pending setup locks its connection controls');
  await publishSetup({ action: 'login', pending: true, startedAt: Date.now(), error: 'Connection check paused. Finish or cancel setup in Terminal, then refresh status.' });
  await waitForText('#connection-codex .connection-setup-error', 'Connection check paused');
  assert.equal(await page.locator('#goal-form button[type="submit"]').isDisabled(), true, 'a setup status timeout does not unlock sending while Terminal is unfinished');
  for (const selector of ['.provider-primary', '.choose-executable', '.reset-executable']) assert.equal(await page.locator(`#connection-codex ${selector}`).isDisabled(), true, 'an error does not unlock a still-pending setup');
  await page.locator('#done-connections').click();
  await waitForText('#composer-notice', 'Finish or cancel setup');
  await page.locator('#goal').focus();
  await page.keyboard.press('Meta+Enter');
  await page.locator('#open-connections').click();
  assert.equal(await desktop.evaluate(() => globalThis.__connectionSendAttempts), 0, 'Cmd+Enter cannot bypass a timed-out but unfinished setup');
  assert.equal(await page.locator('#chat-list button').count(), 0, 'unfinished setup creates no new conversation');
  await publishSetup({ action: 'login', pending: false, startedAt: Date.now(), error: 'Test sign-in was interrupted. Try again.' });
  await waitForText('#connection-codex .connection-setup-error', 'Test sign-in was interrupted');
  for (const selector of ['.provider-primary', '.choose-executable', '.reset-executable']) assert.equal(await page.locator(`#connection-codex ${selector}`).isEnabled(), true, 'completed failed setup permits retry or location changes');
  assert.equal(await page.locator('#goal-form button[type="submit"]').isEnabled(), true, 'a completed failed reconnect releases the setup lock when the account is still connected');
  await page.locator('#connection-codex .provider-primary').click();
  await publishSetup({ action: 'login', startedAt: Date.now() });
  await page.locator('#done-connections').click();
  assert.equal(await desktop.evaluate(() => globalThis.__connectionSendAttempts), 0, 'Cmd+Enter does not bypass pending setup');

  // Hold discovery in flight, then complete a reconnect without changing the
  // authenticated flag. The renderer must queue a fresh forced catalog load.
  await desktop.evaluate(() => { globalThis.__holdConnectionModels = true; });
  const beforeRefresh = await desktop.evaluate(() => globalThis.__connectionModelRequests.length);
  await page.locator('#settings-toggle').click();
  await page.locator('#refresh-models').click();
  const discoveryDeadline = Date.now() + 5000;
  while (Date.now() < discoveryDeadline && await desktop.evaluate(() => globalThis.__connectionModelRequests.length) === beforeRefresh) await delay(25);
  assert.equal(await desktop.evaluate(() => globalThis.__connectionModelRequests.length), beforeRefresh + 1);
  await page.locator('#close-settings').click();
  await publishSetup(null);
  await page.waitForFunction(() => !document.querySelector('#goal-form button[type="submit"]').disabled);
  assert.equal(await desktop.evaluate(() => globalThis.__connectionModelRequests.length), beforeRefresh + 1, 'completion queues behind in-flight catalog discovery');
  await desktop.evaluate(() => { globalThis.__holdConnectionModels = false; globalThis.__releaseConnectionModels(); });
  await page.waitForFunction(() => !document.querySelector('#refresh-models').disabled);
  const requests = await desktop.evaluate(() => globalThis.__connectionModelRequests);
  assert.equal(requests.length, beforeRefresh + 2);
  assert.equal(requests.at(-1).force, true, 'successful reconnect refreshes models even when authentication stays connected');
  await page.locator('#open-connections').click();
  assert.equal(await page.locator('#connection-codex .connection-setup-error').isVisible(), false);
  assert.equal(await page.locator('#connection-codex .connection-setup-note').isVisible(), false);
  await closeConnectionsWithEscape();
}

try {
  await mkdir(resultsDir, { recursive: true });
  await setAuthentication(true);
  await Promise.all([
    writeFile(csvPath, `metric,value\nretrieval_success_target,${sourceMarker}\nparticipants,5\n`),
    writeFile(textPath, `Scope evidence: ${noteMarker}. This prototype only needs one device.\n`),
  ]);
  async function createFakeCli(provider) {
    const script = path.join(temporary, `${provider}-fake.cjs`);
    await writeFile(script, fakeCli, { mode: 0o700 });
    if (process.platform !== 'win32') return script;
    const wrapper = path.join(temporary, `${provider}-fake.cmd`);
    const batchPath = value => value.replaceAll('%', '%%');
    await writeFile(wrapper, `@echo off\r\n"${batchPath(process.execPath)}" "${batchPath(script)}" %*\r\n`);
    return wrapper;
  }
  const [codexPath, claudePath] = await Promise.all(['codex', 'claude'].map(createFakeCli));
  const env = {
    ...process.env,
    AI_COLLAB_CODEX_PATH: codexPath,
    AI_COLLAB_CLAUDE_PATH: claudePath,
    AI_COLLAB_DATA_DIR: path.join(temporary, 'app-data'),
    AI_COLLAB_TEST_CONTROL: controlPath,
    AI_COLLAB_TEST_CALLS: callLogPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await launchDesktop(env);
  await page.locator('body:not(.app-loading)').waitFor();
  assert.equal(await page.locator('#boot-error').isVisible(), false);
  await waitForText('#provider-codex', 'Connected');
  await waitForText('#provider-claude', 'Connected');
  assert.equal(await page.locator('#open-connections').isVisible(), true);
  assert.equal(await page.locator('#connections-dialog').isVisible(), false, 'connected accounts do not require first-launch setup');
  await page.locator('#open-connections').click();
  await waitForText('#connection-codex .connection-status', 'Connected');
  await waitForText('#connection-claude .connection-status', 'Connected');
  await assertNeutralColors();
  await page.screenshot({ path: path.join(resultsDir, 'gui-connections-connected.png') });
  await closeConnectionsWithEscape();
  await page.waitForFunction(() => [...document.querySelector('#codex-model').options].some(option => option.value === 'codex-test')
    && [...document.querySelector('#claude-model').options].some(option => option.value === 'claude-test'));
  assert.equal(await page.locator('#max-rounds').count(), 0, 'the chat has no fixed-round control');
  assert.equal(await page.locator('[role="tablist"]').count(), 0, 'discussion and final answers share one thread');
  const send = page.locator('#goal-form button[type="submit"]');
  assert.equal(await send.isDisabled(), true, `empty questions cannot be submitted: ${JSON.stringify(await page.evaluate(() => ({ value: document.querySelector('#goal').value, button: document.querySelector('#start-debate').outerHTML })))}, errors=${JSON.stringify(errors)}`);
  await assertNeutralColors();
  await page.screenshot({ path: path.join(resultsDir, 'gui-empty.png') });
  await checkNarrowLayout('gui-empty-narrow.png');

  await page.locator('#settings-toggle').click();
  await page.locator('#chat-settings').waitFor({ state: 'visible' });
  await page.locator('#codex-model').selectOption('codex-test');
  await page.locator('#claude-model').selectOption('claude-test');
  assert.equal(await page.locator('#moderator-model').inputValue(), 'gpt-6-sol', 'new questions use the explicit GPT-6 Sol moderator');
  assert.equal(await page.locator('#moderator-model option[value=""]').count(), 0, 'moderation never silently chooses a CLI default');
  assert.equal(await page.locator('#moderator-model option[value="claude-test"]').count(), 0, 'moderator choices come from the Codex catalog');
  await page.locator('#timeout-minutes').selectOption('20');
  assert.equal(await page.locator('#codex-model option[value=""]').count(), 1);
  assert.equal(await page.locator('#claude-model option[value=""]').count(), 1);
  await waitForText('#model-discovery-note', 'live');
  await page.locator('#close-settings').click();
  await page.locator('#goal').fill(initialGoal);
  // The file dialog alone is mocked; extraction, storage, previews and IPC remain real.
  await desktop.evaluate(({ dialog }, selections) => {
    const queue = [...selections];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: queue.shift() || [] });
  }, [[csvPath, textPath], [textPath], [csvPath, textPath]]);
  await page.locator('#attach-files').click();
  await expectAttachments(2);
  await page.locator('#source-list .source-chip').filter({ hasText: csvName }).locator('.source-name').click();
  await waitForText('#source-preview-text', sourceMarker);
  await page.locator('#close-source-preview').click();
  await page.getByRole('button', { name: `Remove ${textName}`, exact: true }).click();
  await expectAttachments(1);
  await page.locator('#attach-files').click();
  await expectAttachments(2);
  await page.locator('#source-list .source-chip').filter({ hasText: textName }).locator('.source-name').click();
  await waitForText('#source-preview-text', noteMarker);
  await page.locator('#close-source-preview').click();
  await page.screenshot({ path: path.join(resultsDir, 'gui-attachments-models.png') });
  await checkNarrowLayout('gui-attachments-models-narrow.png');

  // Observe all displayed assistant updates, including partial moderation/reviews, for leaked protocol JSON.
  await page.evaluate(() => {
    window.__rawReviewVisible = false;
    new MutationObserver(() => {
      const visible = [...document.querySelectorAll('#thread .assistant-message')].map(item => item.innerText).join('\n');
      if (/candidate_version|"(?:verdict|issues|refinedQuestion|revisionInstructions|remainingDisagreements)"\s*:/.test(visible)) window.__rawReviewVisible = true;
    }).observe(document.querySelector('#thread'), { subtree: true, childList: true, characterData: true });
  });
  await send.click();
  await waitForText('#thread .moderator-plan .plan-question', refinedInitial);
  for (const role of Object.values(initialRoles)) await waitForText('#thread .moderator-plan .plan-roles', role);
  assert.equal(await page.locator('#thread .assistant-message').first().getAttribute('data-provider'), 'moderator', 'the moderator assigns perspectives before the debate');
  await waitForText('#thread', 'Start with a small');
  await waitForText('#thread', 'retrieval');
  const initial = await waitForChat(initialGoal, 'completed');
  assert.equal(initial.final.version, 4, 'agreement can require more than three candidate versions');
  assert.equal(initial.timeoutMinutes, 20);
  assert.equal(initial.final.consensus, true);
  assert.equal(initial.final.decided, true, 'peer agreement still requires moderator finalization');
  assert.equal(initial.models.moderator, 'gpt-6-sol');
  assert.equal(initial.messages[0].kind, 'planning');
  assert.equal(initial.messages[0].provider, 'moderator');
  assert.equal(initial.turns[0].plan.refinedQuestion, refinedInitial);
  for (const provider of ['codex', 'claude']) {
    assert.equal(initial.turns[0].plan.roles[provider].label, initialRoles[provider]);
    await waitForText(`#thread .assistant-message[data-provider="${provider}"] .message-perspective`, initialRoles[provider]);
  }
  assert.equal(await page.locator('#thread .user-message').count(), 1);
  assert.equal(await page.locator('#thread .final-message').count(), 1);
  await waitForText('#thread .final-message .final-badge', 'Both agree');
  await waitForText('#thread .final-message', priorFinalMarker);
  await waitForText('#thread', 'I agree with this version');
  await waitForText('#thread .moderator-adjudication', 'The answer still needs a concrete criterion');
  await assertNeutralColors();
  assert.equal(await page.evaluate(() => window.__rawReviewVisible), false, 'review JSON is never visible, even while streaming');
  assert.equal(await page.locator('#chat-list button').count(), 1);
  assert.equal(await page.locator('#run-error').isVisible(), false);
  await expectAttachments(2);
  const originalMessageIds = initial.messages.map(message => message.id);
  await page.screenshot({ path: path.join(resultsDir, 'gui-final.png') });
  await checkNarrowLayout('gui-final-narrow.png');

  // Continue the existing conversation, keeping prior answers, sources, models, and history identity.
  await page.locator('#goal').fill(followupGoal);
  await send.click();
  await page.waitForFunction(() => document.querySelectorAll('#thread .user-message').length === 2);
  await page.waitForFunction(() => [...document.querySelectorAll('#thread .assistant-message')].at(-1)?.innerText.includes('A focused two-week prototype'));
  const draftWhileRunning = 'Please keep this unsent follow-up while the assistants finish.';
  await page.locator('#goal').fill(draftWhileRunning);
  await page.evaluate(() => {
    const scroller = document.querySelector('#chat-scroll');
    if (scroller.scrollHeight <= scroller.clientHeight + 200) throw new Error('The transcript must overflow to test reader scroll position.');
    scroller.scrollTop = 0;
    window.__streamNodes = document.querySelectorAll('#thread .assistant-message').length;
  });
  await page.waitForFunction(() => document.querySelectorAll('#thread .assistant-message').length > window.__streamNodes);
  assert.equal(await page.locator('#goal').inputValue(), draftWhileRunning, 'streaming preserves an unsent follow-up');
  assert.ok(await page.locator('#goal').evaluate(element => document.activeElement === element), 'streaming preserves composer focus');
  assert.ok(await page.locator('#chat-scroll').evaluate(element => element.scrollTop < 3), 'streaming does not yank readers back to the bottom');
  const followed = await waitForChat(initialGoal, 'completed', 2);
  assert.equal(followed.id, initial.id);
  assert.equal(followed.turns.length, 2);
  assert.equal(followed.final.consensus, false, 'a moderator decision never fabricates peer consensus');
  assert.equal(followed.final.approved, false);
  assert.equal(followed.final.decided, true);
  assert.equal(followed.models.moderator, 'gpt-6-sol');
  assert.equal(followed.turns[0].plan.refinedQuestion, refinedInitial);
  assert.equal(followed.turns[1].plan.refinedQuestion, refinedFollowup);
  assert.equal(followed.turns[1].plan.mode, 'complementary');
  for (const provider of ['codex', 'claude']) assert.equal(followed.turns[1].plan.roles[provider].label, followupRoles[provider]);
  assert.equal(followed.final.version, 4);
  assert.deepEqual(followed.messages.slice(0, originalMessageIds.length).map(message => message.id), originalMessageIds);
  assert.equal(await page.locator('#chat-list button').count(), 1, 'a followup keeps the same chat history entry');
  assert.equal(await page.locator('#thread .user-message').count(), 2);
  assert.equal(await page.locator('#thread .final-message').count(), 2);
  assert.ok((await page.locator('#thread').innerText()).includes(priorFinalMarker));
  await page.locator('#thread .final-message').last().filter({ hasText: followupAnswerMarker }).waitFor();
  const latestFinal = page.locator('#thread .final-message').last();
  assert.equal(await latestFinal.locator('.final-badge').innerText(), 'Moderator decision');
  assert.ok(!(await latestFinal.innerText()).includes('Both agree'));
  assert.ok((await latestFinal.locator('.moderation-reason').innerText()).includes('bounded recommendation'));
  assert.ok((await latestFinal.locator('.moderation-disagreements').innerText()).includes('Claude still prefers'));
  assert.equal(await page.locator('#thread .moderator-plan').count(), 2);
  assert.ok((await page.locator('#thread .moderator-plan').last().innerText()).includes(refinedFollowup));
  await expectAttachments(2);
  assert.equal(await page.evaluate(() => window.__rawReviewVisible), false);
  await page.locator('#chat-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(resultsDir, 'gui-followup.png') });
  await checkNarrowLayout('gui-followup-narrow.png');

  await desktop.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, exportPath);
  await page.locator('#export-run').click();
  await waitForText('#toast', 'Chat exported');
  const exported = await readFile(exportPath, 'utf8');
  for (const value of [initialGoal, followupGoal, refinedInitial, refinedFollowup, ...Object.values(initialRoles), ...Object.values(followupRoles), priorFinalMarker, followupAnswerMarker, csvName, textName, 'codex-test', 'claude-test', 'gpt-6-sol', 'Claude still prefers']) {
    assert.ok(exported.includes(value), `export retains ${value}`);
  }
  assert.ok(!exported.includes('"candidate_version"'), 'exports contain readable reviews');
  assert.ok(!/"(?:refinedQuestion|revisionInstructions)"\s*:/.test(exported), 'exports contain readable moderator plans and judgments');

  await page.locator('#new-chat').click();
  assert.equal(await page.locator('#thread .assistant-message').count(), 0);
  await page.locator('#goal').fill(stopGoal);
  await page.locator('#settings-toggle').click();
  await page.locator('#codex-model').selectOption('codex-test');
  await page.locator('#claude-model').selectOption('claude-test');
  await page.locator('#timeout-minutes').selectOption('10');
  await page.locator('#close-settings').click();
  await page.locator('#attach-files').click();
  await expectAttachments(2);
  await send.click();
  await waitForText('#thread', 'codex: partial response');
  assert.equal(await page.locator('#goal').isVisible(), true, 'the composer remains in the conversation view');
  await page.locator('#open-connections').click();
  assert.equal(await page.locator('#connections-active-notice').isVisible(), true);
  for (const provider of ['codex', 'claude']) {
    for (const selector of ['.provider-primary', '.choose-executable', '.reset-executable']) assert.equal(await page.locator(`#connection-${provider} ${selector}`).isDisabled(), true, 'setup mutations stay disabled while a discussion runs');
  }
  assert.equal(await page.locator('#refresh-connections').isDisabled(), false);
  const guardedConnectionCalls = await page.evaluate(async () => {
    const attempts = [
      () => window.council.setupProvider('codex', 'login'),
      () => window.council.chooseProviderExecutable('codex'),
      () => window.council.clearProviderExecutable('codex'),
    ];
    const results = [];
    for (const attempt of attempts) {
      try { await attempt(); results.push('unexpected success'); }
      catch (error) { results.push(error.message); }
    }
    return results;
  });
  for (const message of guardedConnectionCalls) assert.match(message, /Stop the current discussion before changing connections/, 'main rejects connection mutation independently of disabled GUI controls');
  await closeConnectionsWithEscape();
  await page.locator('#stop-active-run').click();
  const stopped = await waitForChat(stopGoal, 'cancelled');
  assert.equal(stopped.timeoutMinutes, 10);
  assert.ok((await page.locator('#thread').innerText()).includes('partial response'));
  assert.equal(await page.locator('#chat-list button').count(), 2);
  assert.equal(stopped.messages.filter(message => message.provider === 'claude').length, 0,
    'Claude never starts while the first Codex response is awaiting cancellation');

  await page.locator('#chat-list button').filter({ hasText: initialGoal }).click();
  assert.equal(await page.locator('#thread .user-message').count(), 2);
  await waitForText('#thread', followupAnswerMarker);
  await page.locator('#chat-list button').filter({ hasText: stopGoal }).click();
  await waitForText('#thread', 'partial response');

  await setAuthentication(false);
  await page.locator('#refresh-providers').click();
  await waitForText('#provider-claude', 'Connect');
  await page.locator('#new-chat').click();
  await page.locator('#goal').fill('This attempt should require signing in.');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.locator('#chat-list button').count(), 2);
  await setAuthentication(true);
  await page.locator('#refresh-providers').click();
  await waitForText('#provider-claude', 'Connected');
  await page.waitForFunction(() => !document.querySelector('#goal-form button[type="submit"]').disabled);

  await page.reload();
  await page.locator('body:not(.app-loading)').waitFor();
  await waitForText('#provider-codex', 'Connected');
  assert.equal(await page.locator('#chat-list button').count(), 2);
  await page.locator('#chat-list button').filter({ hasText: initialGoal }).click();
  assert.equal(await page.locator('#thread .user-message').count(), 2);
  assert.equal(await page.locator('#thread .final-message').count(), 2);
  assert.equal(await page.locator('#thread .moderator-plan').count(), 2);
  assert.equal(await page.locator('#thread .final-message').last().locator('.final-badge').innerText(), 'Moderator decision');
  await waitForText('#thread', followupAnswerMarker);
  await expectAttachments(2);
  await page.locator('#source-list .source-chip').filter({ hasText: csvName }).locator('.source-name').click();
  await waitForText('#source-preview-text', sourceMarker);
  await page.locator('#close-source-preview').click();

  const lifecycle = (await readFile(callLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const calls = lifecycle.filter(event => event.event === 'start');
  const active = new Map();
  for (const event of lifecycle) {
    if (event.event === 'end') { active.delete(event.callId); continue; }
    assert.ok(active.size === 0 || (event.phase === 'REVIEW' && [...active.values()].every(call => call.phase === 'REVIEW')),
      `discussion turns must wait for their peers: ${event.provider} ${event.phase}`);
    active.set(event.callId, event);
  }
  if (process.platform === 'win32') {
    // Forced Windows tree termination cannot run the fixture's SIGTERM handler.
    for (const event of active.values()) {
      assert.match(event.prompt, /\[STOP TEST\]/, 'only the deliberately stopped request may miss its exit marker');
      const pid = Number(event.callId.split('-').at(-1));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Stop also kills the Node process inside its CMD wrapper');
    }
  } else assert.equal(active.size, 0, 'completion and cancellation leave no running inference process');
  assert.equal(calls.filter(call => call.phase === 'REVISION').length, 6, 'each question can revise through version four');
  assert.equal(calls.filter(call => call.phase === 'REVIEW' && call.version === 4).length, 4);
  assert.equal(calls.filter(call => call.phase === 'PLAN').length, 3, 'every question, including a cancelled question, gets its own perspectives');
  assert.equal(calls.filter(call => call.phase === 'JUDGE').length, 8, 'the moderator judges each reviewed candidate');
  assert.deepEqual(new Set(calls.map(call => call.provider)), new Set(['codex', 'claude']));
  for (const call of calls) {
    const isModerator = ['PLAN', 'JUDGE'].includes(call.phase);
    assert.equal(call.model, isModerator ? 'gpt-6-sol' : `${call.provider}-test`, `${call.provider} ${call.phase} receives its selected --model`);
    if (isModerator) {
      assert.equal(call.provider, 'codex', 'moderation uses the existing Codex login');
      assert.equal(call.rawPhase, call.phase === 'PLAN' ? 'PLANNING' : 'ADJUDICATION');
    }
    assert.ok(call.prompt.includes(sourceMarker), `${call.provider} ${call.phase} receives CSV evidence`);
    assert.ok(call.prompt.includes(noteMarker), `${call.provider} ${call.phase} receives text evidence`);
    if (call.turn === 2) {
      assert.ok(call.prompt.includes(followupGoal), 'every followup phase receives the current question');
      assert.ok(call.prompt.includes(initialGoal), 'every followup phase receives the original question');
      assert.ok(call.prompt.includes(priorFinalMarker), 'every followup phase receives the prior agreed answer');
    }
    if (call.phase !== 'PLAN') {
      for (const role of Object.values(call.turn === 1 ? initialRoles : followupRoles)) assert.ok(call.prompt.includes(role), `${call.phase} receives the current assigned perspectives`);
    }
  }
  assert.ok(calls.some(call => call.turn === 2 && call.provider === 'claude'));
  assert.ok(calls.some(call => call.turn === 2 && call.provider === 'codex'));
  await testSavedDefaults(env);
  await testModeratorFailureUi();
  await testConnectionSetupUi();
  assert.deepEqual(errors, [], 'no renderer JavaScript errors or CSP violations');
  console.log('GUI smoke passed: durable model/time defaults across full app restart, per-chat overrides, unavailable selections and save failure; moderator planning and role assignments, exact-model routing, validated consensus versus moderator decision with dissent, same-chat followup planning/context, neutral theme, Connections setup, streaming focus/scroll, exports, cancellation, history/reload, and console/CSP checks.');
  console.log(`Screenshots: ${path.join(resultsDir, 'gui-empty.png')}, gui-final.png, gui-followup.png, gui-connections-connected.png, and gui-connections-setup.png`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(resultsDir, 'gui-failure.png') }).catch(() => {});
    console.error('Visible app text:', (await page.locator('body').innerText().catch(() => '')).slice(-14000));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
