import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Council } from '../src/main/orchestrator.mjs';

function moderatorResponse(prompt) {
  if (prompt.includes('PHASE: PLANNING')) return { text: JSON.stringify({ refinedQuestion: 'Preserve the user goal and provide a reliable answer.', mode: 'complementary', rationale: 'Examine evidence and practical constraints independently.', roles: { codex: { label: 'Evidence analyst', instructions: 'Examine the available evidence and assumptions.' }, claude: { label: 'Practical reviewer', instructions: 'Check feasibility and implementation risks.' } } }) };
  if (prompt.includes('PHASE: ADJUDICATION')) return { text: JSON.stringify({ candidate_version: 1, action: 'finalize', reason: 'Both reviews are valid and the exact candidate answers the question.', revisionInstructions: [], remainingDisagreements: [] }) };
  return null;
}

async function waitFor(check, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('a continuous sequential response is checkpointed repeatedly before it completes', async (t) => {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'ai-collab-checkpoint-'));
  let chunks = 0;
  const council = new Council({
    storageDir,
    runProvider: (request) => moderatorResponse(request.prompt) || new Promise((_resolve, reject) => {
      const interval = setInterval(() => {
        chunks += 1;
        request.onEvent({ type: 'delta', text: `${request.provider} chunk ${chunks}; ` });
      }, 25);
      const abort = () => {
        clearInterval(interval);
        reject(new Error('Test stopped the continuing stream.'));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    }),
  });
  await council.init();
  t.after(async () => {
    await council.close();
    await rm(storageDir, { recursive: true, force: true });
  });
  const initial = await council.start({ goal: 'A long response that must survive an interruption.' });
  const file = path.join(storageDir, 'runs', `${initial.id}.json`);
  const readCheckpoint = async () => JSON.parse(await readFile(file, 'utf8'));
  const textLength = (run) => run.messages.reduce((length, message) => length + message.text.length, 0);

  const first = await waitFor(async () => {
    const run = await readCheckpoint();
    return run.messages.length === 2 && run.messages.every((message) => message.text.length > 0) && run;
  }, 'a durable checkpoint containing the active partial response');
  const firstLength = textLength(first);
  const second = await waitFor(async () => {
    const run = await readCheckpoint();
    return textLength(run) > firstLength && run;
  }, 'another durable checkpoint while the streams continue');

  assert.equal(first.status, 'running');
  assert.equal(second.status, 'running');
  assert.equal(second.messages[0].kind, 'planning');
  assert.equal(second.messages[0].status, 'completed');
  assert.equal(second.messages[1].status, 'running');
  assert.equal(council.activeRunId, initial.id);
  assert.ok(chunks > 10, 'output continued arriving more frequently than the checkpoint interval');
  assert.equal(council.getRun(initial.id).final, null, 'the test never completed either provider response');
  await council.stop(initial.id);
});

test('a failed final flush publishes a visible storage warning with the completed solution', async (t) => {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'ai-collab-save-failure-'));
  let releaseAnalyses;
  const analysesGate = new Promise((resolve) => { releaseAnalyses = resolve; });
  const events = [];
  const warnings = [];
  const council = new Council({
    storageDir,
    runProvider: async ({ provider, prompt }) => {
      const moderator = moderatorResponse(prompt);
      if (moderator) return moderator;
      if (prompt.includes('PHASE: ANALYSIS')) await analysesGate;
      if (prompt.includes('PHASE: REVIEW')) {
        return { text: JSON.stringify({ candidate_version: 1, verdict: 'approve', issues: [], suggestions: [] }) };
      }
      return { text: `${provider}'s useful response.` };
    },
  });
  council.on('run-updated', (run) => events.push(run));
  council.on('storage-warning', (warning) => warnings.push(warning));
  await council.init();
  const persist = council.persist.bind(council);
  t.after(async () => {
    releaseAnalyses();
    council.persist = persist;
    await council.close();
    await rm(storageDir, { recursive: true, force: true });
  });
  const initial = await council.start({ goal: 'Preserve a useful answer if saving fails.' });
  // The initial record was persisted successfully; only the terminal flush fails.
  let failedFinalWrites = 0;
  council.persist = async (run) => {
    if (run.status === 'completed') {
      failedFinalWrites += 1;
      throw new Error('ENOSPC: simulated full disk');
    }
    return persist(run);
  };
  releaseAnalyses();
  await council.tasks.get(initial.id);

  const completed = council.getRun(initial.id);
  assert.equal(failedFinalWrites, 1);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.final.consensus, true);
  assert.ok(completed.final.text.length > 0, 'the solution stays available for copying or exporting');
  assert.match(completed.storageWarning, /could not be saved/i);
  assert.match(completed.storageWarning, /export/i);
  assert.deepEqual(warnings, ['ENOSPC: simulated full disk']);
  const terminalEvents = events.filter((run) => run.status === 'completed');
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].storageWarning, completed.storageWarning,
    'the first completion event already tells the renderer that saving failed');
  assert.equal(council.activeRunId, null);
});
