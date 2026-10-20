import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Council, exportMarkdown, parsePlan, parseAdjudication, validatePlan, validateAdjudication, PLAN_OUTPUT_SCHEMA, adjudicationOutputSchema, DEFAULT_MODERATOR_MODEL } from '../src/main/orchestrator.mjs';

const TERMINAL = new Set(['completed', 'cancelled', 'timed_out', 'failed', 'interrupted']);
const phaseOf = prompt => /PHASE:\s*(PLANNING|ANALYSIS|CRITIQUE|SYNTHESIS|REVISION|REVIEW|ADJUDICATION)\b/.exec(prompt)?.[1];
const versionOf = prompt => Number(/CANDIDATE_VERSION:\s*(\d+)/.exec(prompt)?.[1]);
const turnOf = prompt => Number(/TURN_NUMBER:\s*(\d+)/.exec(prompt)?.[1] || 1);
const vote = (version, verdict = 'approve', issues = [], suggestions = [], summary = '') => JSON.stringify({ candidate_version: version, verdict, issues, suggestions, summary });
const planFor = (turn = 1, overrides = {}) => ({ refinedQuestion: `Evaluate the original question ${turn} without changing its constraints.`, mode: 'complementary', rationale: 'Test evidence and implementation from different perspectives.', roles: {
  codex: { label: `Evidence analyst ${turn}`, instructions: 'Evaluate the evidence, assumptions, and retention implications.' },
  claude: { label: `Operations analyst ${turn}`, instructions: 'Evaluate operational feasibility, support workload, and alternatives.' },
}, ...overrides });
const decisionFor = (version, action = 'finalize', overrides = {}) => ({ candidate_version: version, action, reason: action === 'finalize' ? 'The exact candidate meets the user constraints and acknowledges material uncertainty.' : 'The reviews identify required corrections.', revisionInstructions: action === 'revise' ? ['Resolve the stated blocking issues before finalization.'] : [], remainingDisagreements: [], ...overrides });
const isModerator = request => ['PLANNING', 'ADJUDICATION'].includes(phaseOf(request.prompt));

async function until(getValue, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = getValue(); if (value) return value; await delay(5); }
  assert.fail(`Timed out waiting for ${description}`);
}
async function finish(council, id) {
  return until(() => { const run = council.getRun(id); return run && TERMINAL.has(run.status) && council.activeRunId !== id && run; }, 'discussion completion and flush');
}
async function harness(t, implementation, options = {}) {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'ai-council-test-'));
  const calls = [], events = [];
  const council = new Council({ storageDir, ...options, runProvider: async request => { calls.push(request); return implementation(request); } });
  council.on('run-updated', run => events.push(structuredClone(run)));
  await council.init();
  t.after(async () => { await council.close(); await rm(storageDir, { recursive: true, force: true }); });
  return { council, storageDir, calls, events };
}
function basicProvider(request) {
  const phase = phaseOf(request.prompt), turn = turnOf(request.prompt);
  assert.ok(phase, 'provider prompt identifies its phase');
  if (phase === 'PLANNING') return { text: JSON.stringify(planFor(turn)) };
  if (phase === 'ADJUDICATION') {
    const reviews = JSON.parse(/INDEPENDENT_REVIEWS_JSON:\n([^\n]+)/.exec(request.prompt)[1]);
    return { text: JSON.stringify(decisionFor(versionOf(request.prompt), reviews.every(review => review.valid && review.verdict === 'approve') ? 'finalize' : 'revise')) };
  }
  if (phase === 'SYNTHESIS' || phase === 'REVISION') return { text: `Answer for question ${turn}, draft ${versionOf(request.prompt)}: use the measurable approach.` };
  if (phase === 'REVIEW') return { text: vote(versionOf(request.prompt), 'approve', [], [], `${request.provider}: I agree with this draft.`) };
  return { text: `${request.provider} ${phase.toLowerCase()} response for question ${turn}.` };
}
function blockUntilAborted(request, onAbort = () => {}) {
  request.onEvent?.({ type: 'delta', text: `${request.provider}: partial public response` });
  return new Promise((_resolve, reject) => {
    const abort = () => { onAbort(); const error = new Error('Cancelled by the signal'); error.name = 'AbortError'; reject(error); };
    if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true });
  });
}
function manualDeadline() {
  const pending = new Set();
  return { timers: { setTimeout(callback) { pending.add(callback); return callback; }, clearTimeout(callback) { pending.delete(callback); } }, fire() { for (const callback of [...pending]) callback(); } };
}
function documentSource(overrides = {}) {
  const text = '=== Page 1 ===\nThe source budget is $420.\nThe target is four of five successful retrievals.';
  return { id: 'document-source-1', name: 'Research brief.pdf', extension: 'pdf', size: 2048, charCount: text.length, text, pages: 1,
    warnings: ['OCR can misread numbers; verify important details.'], sha256: 'a'.repeat(64), createdAt: '2026-10-19T20:00:00.000Z', ...overrides };
}

test('moderator assigns perspectives, Codex proposes, Claude responds, and exact peer agreement is finalized', async (t) => {
  let releaseAnalysis;
  const gate = new Promise(resolve => { releaseAnalysis = resolve; });
  t.after(() => releaseAnalysis());
  const reviewResolvers = [];
  const { council, calls, events } = await harness(t, async request => {
    const phase = phaseOf(request.prompt);
    request.onEvent?.({ type: 'delta', text: `Live ${request.provider} ${phase}` });
    if (phase === 'ANALYSIS') await gate;
    if (phase === 'REVIEW') await new Promise(resolve => { reviewResolvers.push(resolve); if (reviewResolvers.length === 2) reviewResolvers.forEach(release => release()); });
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Choose a reliable approach.', codexModel: 'codex-test', claudeModel: 'claude-test' });
  assert.equal(initial.status, 'running');
  await until(() => calls.length === 2, 'the initial proposal after planning');
  assert.equal(calls[0].provider, 'codex');
  await until(() => events.some(event => event.messages.some(message => message.text.includes('Live '))), 'the throttled public stream event');
  releaseAnalysis();
  const run = await finish(council, initial.id);
  assert.deepEqual(calls.slice(0, 4).map(call => [call.provider, phaseOf(call.prompt)]), [['codex', 'PLANNING'], ['codex', 'ANALYSIS'], ['claude', 'CRITIQUE'], ['codex', 'SYNTHESIS']]);
  assert.ok(calls[2].prompt.includes('codex analysis response for question 1.'));
  assert.ok(calls[3].prompt.includes('claude critique response for question 1.'));
  assert.equal(run.status, 'completed');
  assert.equal(run.final.consensus, true); assert.equal(run.final.approved, true); assert.equal(run.final.reviewed, true); assert.equal(run.final.decided, true);
  const reviews = calls.filter(call => phaseOf(call.prompt) === 'REVIEW');
  assert.equal(reviews.length, 2); assert.equal(reviews[0].prompt, reviews[1].prompt);
  assert.ok(reviews.every(call => call.prompt.includes(run.final.text)));
  for (const call of calls) { assert.equal(call.model, isModerator(call) ? DEFAULT_MODERATOR_MODEL : call.provider === 'codex' ? 'codex-test' : 'claude-test'); assert.ok(call.signal instanceof AbortSignal); assert.ok(call.timeoutMs > 0); }
  assert.ok(events.some(event => event.messages.some(message => message.text.includes('Live '))));
  assert.ok(run.messages.every(message => message.turnId === run.turnId));
  assert.ok(run.messages.filter(message => message.kind === 'review').every(message => message.review?.summary.includes('I agree')));
  assert.deepEqual(run.turns[0].final, run.final);
  const exported = exportMarkdown(run);
  assert.ok(exported.includes('codex: I agree with this draft.'));
  assert.ok(!exported.includes('candidate_version'), 'exports show the public review, not protocol JSON');
  assert.ok(!exported.includes('refinedQuestion'), 'exports show the readable moderator plan');
  assert.equal(run.messages[0].provider, 'moderator'); assert.deepEqual(run.messages[0].plan, run.turns[0].plan);
  assert.equal(run.messages.at(-1).provider, 'moderator'); assert.equal(run.messages.at(-1).adjudication.action, 'finalize');
  assert.ok(calls[1].prompt.includes(`YOUR ASSIGNED PERSPECTIVE — CODEX:\n${run.turns[0].plan.roles.codex.label}`));
  assert.ok(calls[2].prompt.includes(`YOUR ASSIGNED PERSPECTIVE — CLAUDE:\n${run.turns[0].plan.roles.claude.label}`));
  for (const call of calls) {
    if (phaseOf(call.prompt) === 'PLANNING') assert.deepEqual(call.outputSchema, PLAN_OUTPUT_SCHEMA);
    else if (phaseOf(call.prompt) === 'ADJUDICATION') assert.deepEqual(call.outputSchema, adjudicationOutputSchema(versionOf(call.prompt)));
    else assert.equal(Object.hasOwn(call, 'outputSchema'), false, 'moderator-only structured output does not change the debaters');
  }
});

test('discussion continues beyond three revisions and alternates authors until fresh agreement', async (t) => {
  const { council, calls } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'REVIEW') { const version = versionOf(request.prompt); return { text: version < 5 && request.provider === 'claude' ? vote(version, 'revise', [`Draft ${version} needs a measurable target.`], ['Add detail.']) : vote(version) }; }
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Work through all objections.', maxRounds: 1 });
  const run = await finish(council, initial.id);
  assert.equal(run.final.consensus, true); assert.equal(run.final.version, 5, 'legacy maxRounds is ignored');
  assert.deepEqual(calls.filter(call => phaseOf(call.prompt) === 'REVISION').map(call => [call.provider, versionOf(call.prompt)]), [['claude', 2], ['codex', 3], ['claude', 4], ['codex', 5]]);
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'REVIEW').length, 10);
  assert.ok(calls.filter(call => phaseOf(call.prompt) === 'REVIEW' && versionOf(call.prompt) === 5).every(call => call.prompt.includes(run.final.text)));
});

for (const [label, response] of [['malformed review', 'Approved!'], ['approval for a different version', vote(99)]]) {
  test(`${label} cannot establish consensus`, async (t) => {
    let revising = false;
    const { council } = await harness(t, request => {
      if (phaseOf(request.prompt) === 'REVIEW' && request.provider === 'codex' && versionOf(request.prompt) === 1) return { text: response };
      if (phaseOf(request.prompt) === 'REVISION') { revising = true; return blockUntilAborted(request); }
      return basicProvider(request);
    });
    const initial = await council.start({ goal: 'Require valid reviews.' });
    await until(() => revising, 'a revision after invalid approval');
    const beforeStop = council.getRun(initial.id);
    assert.equal(beforeStop.final.consensus, false);
    assert.ok(beforeStop.final.reviews.some(review => review.provider === 'codex' && review.verdict === 'revise'));
    await council.stop(initial.id); assert.equal((await finish(council, initial.id)).status, 'cancelled');
  });
}

test('cancellation aborts the active sequential call, preserves partials, and prevents later phases', async (t) => {
  const aborted = [];
  const { council, calls } = await harness(t, request => phaseOf(request.prompt) === 'PLANNING' ? basicProvider(request) : blockUntilAborted(request, () => aborted.push(request.provider)));
  const initial = await council.start({ goal: 'A cancellable discussion.' });
  await until(() => council.getRun(initial.id).messages.some(message => message.text.includes('partial public')), 'partial output');
  await council.stop(initial.id); const run = await finish(council, initial.id);
  assert.equal(run.status, 'cancelled'); assert.deepEqual(aborted, ['codex']); assert.equal(calls.length, 2);
  assert.ok(run.messages[1].text.includes('partial public')); assert.equal(run.turns[0].status, 'cancelled');
});

test('stopping during independent review aborts both reviewers and leaves the draft unapproved', async (t) => {
  const aborted = new Set();
  const { council } = await harness(t, request => phaseOf(request.prompt) === 'REVIEW' ? blockUntilAborted(request, () => aborted.add(request.provider)) : basicProvider(request));
  const initial = await council.start({ goal: 'Stop during review.' });
  await until(() => council.getRun(initial.id).messages.filter(message => message.kind === 'review').length === 2, 'both reviewers');
  await council.stop(initial.id); const run = await finish(council, initial.id);
  assert.deepEqual(aborted, new Set(['codex', 'claude'])); assert.equal(run.final.consensus, false); assert.equal(run.final.approved, false); assert.equal(run.final.reviewed, false);
});

test('time limit has its own status and retains an incomplete draft with explicit unreviewed labels', async (t) => {
  const deadline = manualDeadline();
  const { council } = await harness(t, request => phaseOf(request.prompt) === 'SYNTHESIS' ? blockUntilAborted(request) : basicProvider(request), { timers: deadline.timers });
  const initial = await council.start({ goal: 'Save an interrupted draft.', timeoutMinutes: 1 });
  await until(() => council.getRun(initial.id).messages.some(message => message.kind === 'candidate' && message.text), 'a partial draft');
  deadline.fire(); const run = await finish(council, initial.id);
  assert.equal(run.status, 'timed_out'); assert.equal(run.turns[0].status, 'timed_out');
  assert.equal(run.final.consensus, false); assert.equal(run.final.approved, false); assert.equal(run.final.reviewed, false); assert.equal(run.final.partial, true);
  assert.match(run.final.text, /partial public response/); assert.match(exportMarkdown(run), /Incomplete, unreviewed draft — not approved/);
});

test('timeout during review preserves a completed draft without claiming both reviewers agreed', async (t) => {
  const deadline = manualDeadline();
  const { council } = await harness(t, request => phaseOf(request.prompt) === 'REVIEW' && request.provider === 'claude' ? blockUntilAborted(request) : basicProvider(request), { timers: deadline.timers });
  const initial = await council.start({ goal: 'Keep the candidate if one review times out.' });
  await until(() => council.getRun(initial.id).final?.reviews.length === 1, 'one completed review');
  deadline.fire(); const run = await finish(council, initial.id);
  assert.equal(run.status, 'timed_out'); assert.equal(run.final.reviewed, false); assert.equal(run.final.approved, false); assert.equal(run.final.consensus, false);
  assert.equal(run.final.partial, false); assert.equal(run.final.reviews.length, 1); assert.match(run.final.text, /Answer for question 1/);
});

test('provider failure aborts its active reviewing peer and never claims completion', async (t) => {
  let siblingAborted = false;
  const { council } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'REVIEW') { if (request.provider === 'codex') throw new Error('Codex login expired in test'); return blockUntilAborted(request, () => { siblingAborted = true; }); }
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Handle provider errors honestly.' }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'failed'); assert.match(run.error, /Codex login expired/); assert.equal(siblingAborted, true); assert.equal(run.final.consensus, false);
});

test('concurrent starts and follow-ups are rejected while a discussion is active', async (t) => {
  const { council } = await harness(t, blockUntilAborted);
  const initial = await council.start({ goal: 'The active goal.' });
  await assert.rejects(council.start({ goal: 'Competing goal.' }), /already running/);
  await assert.rejects(council.followUp(initial.id, { goal: 'Premature follow-up.' }), /already running/);
  assert.equal(council.listRuns().length, 1); await council.stop(initial.id);
});

test('all phases and review repairs retain the entire source extraction and selected models', async (t) => {
  const sources = [documentSource(), documentSource({ id: 'csv', name: 'User research.csv', extension: 'csv', text: 'person,notes\nAna,"Found it, quickly"\nJo,"Tried twice\nand stopped"\n', warnings: [] })];
  let codexReviews = 0;
  const { council, calls } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'REVIEW' && versionOf(request.prompt) === 1) {
      if (request.provider === 'codex' && ++codexReviews === 1) return { text: 'Malformed review.' };
      if (request.provider === 'claude') return { text: vote(1, 'revise', ['Cite the source budget.']) };
    }
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Use attached evidence.', attachments: sources, codexModel: 'gpt-6.1-sol', claudeModel: 'sonnet[1m]' });
  assert.equal((await finish(council, initial.id)).final.version, 2); assert.ok(codexReviews >= 2);
  for (const call of calls) {
    for (const source of sources) { assert.ok(call.prompt.includes(source.name)); assert.ok(call.prompt.includes(source.text)); for (const warning of source.warnings) assert.ok(call.prompt.includes(warning)); }
    assert.equal(call.model, isModerator(call) ? DEFAULT_MODERATOR_MODEL : call.provider === 'codex' ? 'gpt-6.1-sol' : 'sonnet[1m]');
  }
});

test('repeated follow-ups keep one conversation with every prior question, public message, final, and source', async (t) => {
  const firstSource = documentSource(), nextSource = documentSource({ id: 'second-source', name: 'New evidence.txt', text: 'The new budget is $600.', warnings: [] });
  const { council, calls, storageDir } = await harness(t, basicProvider);
  const initial = await council.start({ goal: 'Original prototype question.', attachments: [firstSource], codexModel: 'codex-chosen', claudeModel: 'claude-chosen', timeoutMinutes: 20 });
  const first = await finish(council, initial.id);
  const secondInitial = await council.followUp(initial.id, { goal: 'How should the budget change?', attachments: [nextSource] });
  assert.equal(secondInitial.id, initial.id); assert.equal(secondInitial.goal, initial.goal); assert.equal(secondInitial.currentQuestion, 'How should the budget change?');
  assert.deepEqual(secondInitial.models, first.models); assert.equal(secondInitial.timeoutMinutes, 20); assert.deepEqual(secondInitial.turns[0], first.turns[0]); assert.equal(secondInitial.final, null);
  const second = await finish(council, initial.id);
  await council.followUp(initial.id, { goal: 'Now give me the next action.', codexModel: 'codex-new', claudeModel: '', timeoutMinutes: 5 });
  const third = await finish(council, initial.id);
  assert.equal(council.listRuns().length, 1); assert.equal(third.turns.length, 3); assert.equal(new Set(third.messages.map(message => message.turnId)).size, 3);
  assert.deepEqual(third.turns[0], first.turns[0]); assert.deepEqual(third.turns[1], second.turns[1]);
  assert.ok(third.turns.every(turn => !Object.hasOwn(turn, 'attachments')));
  assert.deepEqual(third.turns[0].attachmentIds, [firstSource.id]); assert.deepEqual(third.turns[2].attachmentIds, [firstSource.id, nextSource.id]);
  for (const call of calls.filter(call => turnOf(call.prompt) === 3)) {
    for (const prior of second.messages) assert.ok(call.prompt.includes(prior.text), `question 3 retains ${prior.title}`);
    for (const prior of second.turns) { assert.ok(call.prompt.includes(prior.question)); assert.ok(call.prompt.includes(prior.final.text)); }
    assert.ok(call.prompt.includes(firstSource.text)); assert.ok(call.prompt.includes(nextSource.text));
    assert.equal(call.model, isModerator(call) ? DEFAULT_MODERATOR_MODEL : call.provider === 'codex' ? 'codex-new' : undefined);
  }
  await council.close();
  const reloaded = await new Council({ storageDir, runProvider: () => assert.fail('reload must not call a provider') }).init();
  assert.deepEqual(reloaded.getRun(initial.id).turns, third.turns); assert.deepEqual(reloaded.getRun(initial.id).attachments, [firstSource, nextSource]);
  const exported = exportMarkdown(third);
  for (const turn of third.turns) { assert.ok(exported.includes(turn.question)); assert.ok(exported.includes(turn.final.text)); }
  for (const message of third.messages.filter(message => message.kind !== 'review')) assert.ok(exported.includes(message.text));
  assert.ok(exported.includes(firstSource.name)); assert.ok(exported.includes(firstSource.warnings[0])); assert.ok(exported.includes('codex-chosen')); assert.ok(exported.includes('codex-new'));
});

test('caller and UI snapshots cannot mutate old sources, old turns, or newly added sources', async (t) => {
  const firstSource = documentSource({ sheets: [{ name: 'Evidence', rows: 3 }] });
  const { council } = await harness(t, basicProvider);
  const initial = await council.start({ goal: 'Retain immutable evidence.', attachments: [firstSource] }); const first = await finish(council, initial.id);
  firstSource.text = 'Caller mutated original input.';
  const newSource = documentSource({ id: 'new-source', name: 'Follow-up.txt', text: 'New source text.', warnings: ['New warning'] });
  const next = await council.followUp(initial.id, { goal: 'Continue using the original.', attachments: [documentSource({ text: 'Collision must not replace original.' }), newSource] });
  newSource.text = 'Caller mutated new input.'; newSource.warnings[0] = 'Caller changed warning.'; next.turns[0].final.text = 'UI mutation';
  council.getRun(initial.id).attachments[0].sheets[0].name = 'Mutation through getRun'; council.listRuns()[0].turns[0].final.text = 'Mutation through listRuns';
  const completed = await finish(council, initial.id);
  assert.deepEqual(completed.turns[0], first.turns[0]); assert.deepEqual(completed.attachments[0], first.attachments[0]);
  assert.equal(completed.attachments[1].text, 'New source text.'); assert.deepEqual(completed.attachments[1].warnings, ['New warning']);
});

test('rejected follow-up persistence rolls back the previous final, messages, status, and active reservation', async (t) => {
  const { council, calls } = await harness(t, basicProvider);
  const initial = await council.start({ goal: 'Keep the answer if disk is full.' }); const previous = await finish(council, initial.id), priorCalls = calls.length;
  const persist = council.persist.bind(council); council.persist = async () => { throw new Error('ENOSPC simulated full disk'); };
  try { await assert.rejects(council.followUp(initial.id, { goal: 'Cannot save this follow-up.' }), /Couldn't save/); } finally { council.persist = persist; }
  assert.deepEqual(council.getRun(initial.id), previous); assert.equal(calls.length, priorCalls); assert.equal(council.activeRunId, null);
  await council.followUp(initial.id, { goal: 'Retry after recovery.' }); assert.equal((await finish(council, initial.id)).turns.length, 2);
});

test('timed-out and failed follow-ups preserve earlier answers and all earlier public history', async (t) => {
  const deadline = manualDeadline();
  const { council } = await harness(t, request => {
    if (turnOf(request.prompt) === 2 && phaseOf(request.prompt) === 'SYNTHESIS') return blockUntilAborted(request);
    if (turnOf(request.prompt) === 3) throw new Error('Provider unavailable for follow-up');
    return basicProvider(request);
  }, { timers: deadline.timers });
  const initial = await council.start({ goal: 'The original answer should survive.' }); const first = await finish(council, initial.id);
  await council.followUp(initial.id, { goal: 'A follow-up with too little time.' });
  await until(() => council.getRun(initial.id).messages.some(message => message.turnId !== first.turnId && message.kind === 'candidate' && message.text), 'second-turn partial draft');
  deadline.fire(); const second = await finish(council, initial.id); assert.equal(second.status, 'timed_out'); assert.deepEqual(second.turns[0], first.turns[0]);
  await council.followUp(initial.id, { goal: 'A follow-up during an outage.' }); const third = await finish(council, initial.id);
  assert.equal(third.status, 'failed'); assert.deepEqual(third.turns.slice(0, 2), second.turns); assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages); assert.equal(third.final, null);
});

test('follow-up validation uses cumulative actual text and file count without changing history', async (t) => {
  const { council } = await harness(t, basicProvider);
  const initial = await council.start({ goal: 'Use the source budget.', attachments: [documentSource({ text: 'x'.repeat(120000), charCount: 1 })] }); const previous = await finish(council, initial.id);
  await assert.rejects(council.followUp(initial.id, { goal: 'Too much context.', attachments: [documentSource({ id: 'second', text: 'y'.repeat(90000), charCount: 1 })] }), /200,000 characters/);
  await assert.rejects(council.followUp(initial.id, { goal: 'Too many sources.', attachments: Array.from({ length: 8 }, (_, index) => documentSource({ id: `extra-${index}`, text: 'small' })) }), /8 documents/);
  assert.deepEqual(council.getRun(initial.id), previous); assert.equal(council.activeRunId, null);
  const boundary = await council.followUp(initial.id, { goal: 'Use the full allowed context.', attachments: [documentSource({ id: 'second', text: 'y'.repeat(80000), charCount: 999999 })] });
  assert.equal((await finish(council, boundary.id)).status, 'completed');
});

test('legacy history migrates truthfully and follows up without discarding earlier disagreement', async (t) => {
  const { council, storageDir } = await harness(t, basicProvider), id = '11111111-2222-3333-4444-555555555555';
  const legacy = { id, goal: 'Legacy original question', createdAt: '2026-10-19T20:00:00.000Z', updatedAt: '2026-10-19T20:01:00.000Z', status: 'completed', phase: 'completed', round: 1, maxRounds: 1, timeoutMinutes: 10, models: { codex: '', claude: '' }, attachments: [documentSource()],
    messages: [{ id: 'old-public-message', provider: 'claude', kind: 'critique', title: 'Old objection', text: 'The original budget was not verified.', status: 'completed' }],
    final: { text: 'Legacy answer with unresolved assumptions.', consensus: false, version: 1, reviews: [{ provider: 'codex', verdict: 'approve', issues: [] }, { provider: 'claude', verdict: 'revise', issues: ['Budget is uncertain.'] }], unresolved: ['Budget is uncertain.'] }, error: null };
  await writeFile(path.join(storageDir, 'runs', `${id}.json`), JSON.stringify(legacy)); await council.init(); const migrated = council.getRun(id);
  assert.equal(migrated.turns.length, 1); assert.equal(migrated.turns[0].final.consensus, false); assert.equal(migrated.turns[0].final.reviewed, true); assert.equal(migrated.messages[0].turnId, migrated.turnId);
  await council.followUp(id, { goal: 'Resolve the old objection.' }); const completed = await finish(council, id);
  assert.equal(completed.turns.length, 2); assert.equal(completed.turns[0].final.consensus, false); assert.ok(exportMarkdown(completed).includes('Reviewed draft — agreement not reached'));
});

test('valid legacy history stays available when saving its migration fails', async (t) => {
  const { council, storageDir } = await harness(t, basicProvider);
  const initial = await council.start({ goal: 'A valid older conversation.' }); const completed = await finish(council, initial.id), legacy = { ...completed };
  delete legacy.turns; delete legacy.turnId; delete legacy.currentQuestion; for (const message of legacy.messages) delete message.turnId;
  await writeFile(path.join(storageDir, 'runs', `${initial.id}.json`), JSON.stringify(legacy));
  const reloaded = new Council({ storageDir, runProvider: basicProvider }); reloaded.persist = async () => { throw new Error('ENOSPC during migration'); }; await reloaded.init(); const restored = reloaded.getRun(initial.id);
  assert.ok(restored); assert.equal(restored.final.text, completed.final.text); assert.equal(restored.turns.length, 1); assert.match(restored.storageWarning, /could not be saved/);
});

test('restart marks the running turn interrupted while retaining its conversation', async (t) => {
  const { council, storageDir } = await harness(t, blockUntilAborted); const initial = await council.start({ goal: 'Interrupted by closing the app.' });
  const crashCopy = await mkdtemp(path.join(os.tmpdir(), 'ai-council-crash-')); t.after(() => rm(crashCopy, { recursive: true, force: true })); await cp(storageDir, crashCopy, { recursive: true });
  const reloaded = await new Council({ storageDir: crashCopy, runProvider: () => assert.fail('reload must not start providers') }).init(), restored = reloaded.getRun(initial.id);
  assert.equal(restored.status, 'interrupted'); assert.equal(restored.turns[0].status, 'interrupted'); assert.equal(restored.goal, initial.goal); assert.ok(!reloaded.activeRunId); await council.stop(initial.id);
});

test('immediate completion-event follow-up is not erased by the old same-ID task cleanup', async (t) => {
  let followUpPromise, triggered = false;
  const { council } = await harness(t, request => turnOf(request.prompt) === 2 && phaseOf(request.prompt) === 'ANALYSIS' ? blockUntilAborted(request) : basicProvider(request));
  council.on('run-updated', run => { if (run.status === 'completed' && !triggered) { triggered = true; followUpPromise = council.followUp(run.id, { goal: 'Continue immediately.' }); } });
  const initial = await council.start({ goal: 'Test same-ID task handoff.' });
  await until(() => followUpPromise, 'immediate follow-up'); await followUpPromise;
  await until(() => { const run = council.getRun(initial.id); return run.turns.length === 2 && run.messages.some(message => message.turnId === run.turnId && message.text); }, 'new-turn streaming');
  assert.ok(council.tasks.has(initial.id)); await council.stop(initial.id); const stopped = await finish(council, initial.id);
  assert.equal(stopped.turns[0].status, 'completed'); assert.equal(stopped.turns[1].status, 'cancelled');
});

test('moderator plan and adjudication parsers reject malformed, oversized, ambiguous, or stale decisions', () => {
  assert.deepEqual(parsePlan(JSON.stringify(planFor())), planFor());
  assert.equal(parsePlan(JSON.stringify(planFor(1, { mode: 'opposing' }))).mode, 'opposing');
  for (const invalid of [
    'I have two good roles.',
    JSON.stringify(planFor(1, { refinedQuestion: '' })),
    JSON.stringify(planFor(1, { mode: 'debate' })),
    JSON.stringify(planFor(1, { rationale: 'x'.repeat(3001) })),
    JSON.stringify(planFor(1, { extra: 'not allowed' })),
    JSON.stringify(planFor(1, { roles: { codex: { label: 'Analyst', instructions: 'Review evidence.' }, claude: { label: ' analyst ', instructions: 'Check workload.' } } })),
    JSON.stringify(planFor(1, { roles: { codex: { label: 'Evidence', instructions: 'Review evidence.' }, claude: { label: 'Operations', instructions: ' REVIEW   EVIDENCE. ' } } })),
    JSON.stringify(planFor(1, { roles: { codex: { label: 'Evidence', instructions: 'x'.repeat(4001) }, claude: { label: 'Operations', instructions: 'Check workload.' } } })),
  ]) assert.equal(parsePlan(invalid), null, 'invalid plans cannot silently become shared roles');
  assert.deepEqual(parseAdjudication(JSON.stringify(decisionFor(1)), 1), decisionFor(1));
  for (const invalid of [
    'Finalize it.', JSON.stringify(decisionFor(2)), JSON.stringify(decisionFor(1, 'agree')),
    JSON.stringify(decisionFor(1, 'revise', { revisionInstructions: [] })),
    JSON.stringify(decisionFor(1, 'finalize', { revisionInstructions: ['Change a fact after approval.'] })),
    JSON.stringify(decisionFor(1, 'finalize', { reason: ' ' })),
    JSON.stringify(decisionFor(1, 'finalize', { finalText: 'A replacement answer is forbidden.' })),
    JSON.stringify(decisionFor(1, 'finalize', { remainingDisagreements: ['x'.repeat(1001)] })),
  ]) assert.equal(parseAdjudication(invalid, 1), null);
});

test('invalid planning repairs once before assigning distinct perspectives without exposing protocol text', async (t) => {
  let attempts = 0;
  const { council, calls, events } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'PLANNING') {
      const text = ++attempts === 1 ? '{"refinedQuestion":"BROKEN PROTOCOL"}' : JSON.stringify(planFor());
      request.onEvent({ type: 'delta', text }); return { text };
    }
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Keep this original constraint: do not increase the support budget.' });
  const run = await finish(council, initial.id);
  assert.equal(run.status, 'completed'); assert.equal(attempts, 2);
  assert.deepEqual(calls.slice(0, 3).map(call => phaseOf(call.prompt)), ['PLANNING', 'PLANNING', 'ANALYSIS']);
  assert.equal(run.messages[0].status, 'failed'); assert.equal(run.messages[1].provider, 'moderator');
  assert.ok(calls.every(call => call.prompt.includes(initial.goal)), 'the original constraints remain in all calls, including repair');
  assert.ok(events.every(event => event.messages.every(message => !message.text.includes('BROKEN PROTOCOL') && !message.text.includes('"refinedQuestion"'))));
  assert.ok(!exportMarkdown(run).includes('BROKEN PROTOCOL'));
});

test('two invalid plans fail clearly without starting an unmoderated discussion', async (t) => {
  const { council, calls } = await harness(t, () => ({ text: JSON.stringify(planFor(1, { roles: { codex: { label: 'Same', instructions: 'Same instructions.' }, claude: { label: 'Same', instructions: 'Same instructions.' } } })) }));
  const initial = await council.start({ goal: 'Require genuinely distinct perspectives.' });
  const run = await finish(council, initial.id);
  assert.equal(run.status, 'failed'); assert.match(run.error, /valid discussion plan after one repair/);
  assert.deepEqual(calls.map(call => phaseOf(call.prompt)), ['PLANNING', 'PLANNING']);
  assert.equal(run.turns[0].plan, null); assert.equal(run.final, null);
  assert.ok(run.messages.every(message => message.provider === 'moderator'));
});

test('a moderator may finalize the exact reviewed candidate despite valid peer dissent without inventing consensus', async (t) => {
  const reason = 'The candidate respects the hard capacity constraint; the remaining preference for higher retention does not make infeasible onboarding possible.';
  const { council, calls } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'REVIEW' && request.provider === 'claude') return { text: vote(1, 'revise', ['I prefer a higher retention target.'], [], 'The capacity plan is feasible, but I prefer greater retention.') };
    if (phaseOf(request.prompt) === 'ADJUDICATION') return { text: JSON.stringify(decisionFor(1, 'finalize', { reason, remainingDisagreements: ['Claude prefers greater retention despite the capacity tradeoff.'] })) };
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Choose within a hard capacity limit.', codexModel: 'debater-model', moderatorModel: 'judge-model' });
  const run = await finish(council, initial.id);
  assert.equal(run.status, 'completed'); assert.equal(run.final.decided, true); assert.equal(run.final.reviewed, true);
  assert.equal(run.final.consensus, false); assert.equal(run.final.approved, false);
  assert.equal(run.final.text, run.messages.find(message => message.kind === 'candidate').text, 'moderation never substitutes a new final answer');
  assert.equal(run.final.moderation.model, 'judge-model'); assert.equal(run.final.moderation.reason, reason);
  assert.ok(run.final.reviews.some(review => review.provider === 'claude' && review.verdict === 'revise' && review.valid));
  assert.ok(run.final.unresolved.some(issue => issue.includes('retention')));
  assert.ok(calls.filter(isModerator).every(call => call.provider === 'codex' && call.model === 'judge-model'));
  assert.ok(calls.filter(call => !isModerator(call) && call.provider === 'codex').every(call => call.model === 'debater-model'));
  assert.match(exportMarkdown(run), /Moderator decision — peer agreement not reached/); assert.ok(exportMarkdown(run).includes(reason));
});

test('moderator can require a concrete revision after both peers approve, followed by fresh exact-version reviews', async (t) => {
  const fix = 'Include the 8,000-minute hard support limit and explain the infeasible option.';
  const { council, calls, events } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'ADJUDICATION' && versionOf(request.prompt) === 1) return { text: JSON.stringify(decisionFor(1, 'revise', { reason: 'Both reviewers overlooked a hard constraint.', revisionInstructions: [fix] })) };
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Stay within 8,000 support minutes.' }); const run = await finish(council, initial.id);
  assert.equal(run.final.version, 2); assert.equal(run.final.decided, true); assert.equal(run.final.consensus, true);
  const revision = calls.find(call => phaseOf(call.prompt) === 'REVISION'); assert.ok(revision.prompt.includes(fix)); assert.equal(revision.provider, 'claude');
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'REVIEW').length, 4);
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'ADJUDICATION').length, 2);
  assert.ok(events.filter(event => event.final?.version === 1).every(event => !event.final.decided && !event.final.approved && !event.final.consensus));
});

test('a stale adjudication is repaired once for the same exact candidate', async (t) => {
  let attempts = 0;
  const { council, calls } = await harness(t, request => phaseOf(request.prompt) === 'ADJUDICATION'
    ? { text: JSON.stringify(decisionFor(++attempts === 1 ? 99 : 1)) } : basicProvider(request));
  const initial = await council.start({ goal: 'Finalize only the reviewed version.' }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'completed'); assert.equal(run.final.version, 1); assert.equal(attempts, 2);
  assert.ok(calls.filter(call => phaseOf(call.prompt) === 'ADJUDICATION').every(call => versionOf(call.prompt) === 1 && call.prompt.includes(run.final.text)));
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'REVISION').length, 0);
  assert.equal(run.messages.filter(message => message.kind === 'adjudication' && message.status === 'failed').length, 1);
  const repaired = calls.filter(call => phaseOf(call.prompt) === 'ADJUDICATION')[1];
  assert.ok(repaired.prompt.includes('VALIDATION FIELD: candidate_version'));
  assert.ok(repaired.prompt.includes(JSON.stringify(JSON.stringify(decisionFor(99)))));
  assert.equal(run.messages.find(message => message.kind === 'adjudication').validationError.code, 'wrong_candidate_version');
});

test('invalid adjudication after one repair fails with the reviewed candidate intact and unfinalized', async (t) => {
  const { council, calls } = await harness(t, request => phaseOf(request.prompt) === 'ADJUDICATION' ? { text: JSON.stringify(decisionFor(7)) } : basicProvider(request));
  const initial = await council.start({ goal: 'Keep an honest fallback draft.' }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'failed'); assert.match(run.error, /could not validate a decision for draft 1 after one repair/);
  assert.equal(run.final.reviewed, true); assert.equal(run.final.decided, false); assert.equal(run.final.consensus, false); assert.equal(run.final.approved, false);
  assert.equal(run.final.text, run.messages.find(message => message.kind === 'candidate').text);
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'ADJUDICATION').length, 2);
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'REVISION').length, 0);
});

test('moderator cannot finalize by treating malformed peer reviews as valid reviews', async (t) => {
  const { council, calls } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'REVIEW' && request.provider === 'claude') return { text: 'Looks good to me.' };
    if (phaseOf(request.prompt) === 'ADJUDICATION') return { text: JSON.stringify(decisionFor(1)) };
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Require valid peer assessment even with a decider.' }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'failed'); assert.equal(run.final.reviewed, false); assert.equal(run.final.decided, false); assert.equal(run.final.consensus, false);
  assert.equal(run.final.reviews.find(review => review.provider === 'claude').valid, false);
  assert.equal(calls.filter(call => phaseOf(call.prompt) === 'ADJUDICATION').length, 2);
});

test('planning uses the same total deadline and cannot consume a fresh debate budget afterwards', async (t) => {
  let clock = new Date('2026-10-19T20:00:00.000Z').getTime();
  const { council, calls } = await harness(t, request => { clock += 60001; return basicProvider(request); }, { now: () => new Date(clock) });
  const initial = await council.start({ goal: 'The moderator also uses time.', timeoutMinutes: 1 }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'timed_out'); assert.equal(run.final, null); assert.equal(calls.length, 1);
  assert.equal(phaseOf(calls[0].prompt), 'PLANNING'); assert.equal(calls[0].timeoutMs, 60000);
});

for (const interruption of ['stop', 'timeout']) {
  test(`${interruption} during adjudication never labels peer-approved text as a finalized agreement`, async (t) => {
    const deadline = manualDeadline(); let judging = false, aborted = false;
    const { council } = await harness(t, request => {
      if (phaseOf(request.prompt) === 'ADJUDICATION') { judging = true; return blockUntilAborted(request, () => { aborted = true; }); }
      return basicProvider(request);
    }, { timers: deadline.timers });
    const initial = await council.start({ goal: 'Wait for the moderator to decide.' }); await until(() => judging, 'active adjudication');
    const pending = council.getRun(initial.id);
    assert.equal(pending.final.reviewed, true); assert.ok(pending.final.reviews.every(review => review.verdict === 'approve'));
    assert.equal(pending.final.decided, false); assert.equal(pending.final.consensus, false);
    if (interruption === 'stop') await council.stop(initial.id); else deadline.fire();
    const run = await finish(council, initial.id);
    assert.equal(run.status, interruption === 'stop' ? 'cancelled' : 'timed_out'); assert.equal(aborted, true);
    assert.equal(run.messages.at(-1).failureKind, interruption === 'stop' ? 'cancelled' : 'timed_out');
    assert.equal(run.final.text, pending.final.text); assert.equal(run.final.approved, false); assert.equal(run.final.decided, false); assert.equal(run.final.consensus, false);
    assert.ok(!exportMarkdown(run).includes('### Agreed solution'));
  });
}

test('follow-ups regenerate and persist plans while preserving earlier moderator choices and distinct model snapshots', async (t) => {
  const source = documentSource();
  const { council, calls, storageDir } = await harness(t, basicProvider);
  const initial = await council.start({ goal: 'Original question with evidence.', attachments: [source], codexModel: 'codex-role', moderatorModel: 'moderator-first' });
  const first = await finish(council, initial.id);
  await council.followUp(initial.id, { goal: 'Now test the previous assumptions.', moderatorModel: 'moderator-next' }); const second = await finish(council, initial.id);
  assert.deepEqual(second.turns[0], first.turns[0]); assert.notDeepEqual(second.turns[0].plan, second.turns[1].plan);
  assert.equal(second.turns[0].models.moderator, 'moderator-first'); assert.equal(second.turns[1].models.moderator, 'moderator-next');
  assert.equal(second.models.codex, 'codex-role'); assert.equal(calls.filter(call => phaseOf(call.prompt) === 'PLANNING').length, 2);
  for (const call of calls.filter(call => turnOf(call.prompt) === 2)) {
    assert.ok(call.prompt.includes(first.final.text)); assert.ok(call.prompt.includes(first.turns[0].plan.roles.codex.instructions)); assert.ok(call.prompt.includes(source.text));
    if (isModerator(call)) assert.equal(call.model, 'moderator-next');
  }
  const exposed = council.getRun(initial.id); exposed.turns[0].plan.roles.codex.instructions = 'UI mutation'; exposed.messages[0].plan.roles.claude.label = 'Changed';
  assert.deepEqual(council.getRun(initial.id), second);
  await council.close();
  const reloaded = await new Council({ storageDir, runProvider: () => assert.fail('reload cannot start a new moderation') }).init();
  assert.deepEqual(reloaded.getRun(initial.id), second);
  const exported = exportMarkdown(second);
  assert.ok(exported.includes('Moderator — moderator-first')); assert.ok(exported.includes('Moderator — moderator-next'));
  assert.ok(exported.includes(second.turns[1].plan.roles.claude.label));
  await assert.rejects(council.followUp(initial.id, { goal: 'No silent default for an explicit empty moderator.', moderatorModel: '' }), /moderator model/);
});

test('restart during adjudication preserves the reviewed draft, plan, and truthful unfinalized status', async (t) => {
  let judging = false;
  const { council, storageDir } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'ADJUDICATION') { judging = true; return blockUntilAborted(request); }
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Preserve the plan and draft across a restart.' }); await until(() => judging, 'the moderator decision');
  const before = council.getRun(initial.id); await council.flush(before);
  const crashCopy = await mkdtemp(path.join(os.tmpdir(), 'ai-council-moderator-crash-')); t.after(() => rm(crashCopy, { recursive: true, force: true })); await cp(storageDir, crashCopy, { recursive: true });
  const reloaded = await new Council({ storageDir: crashCopy, runProvider: () => assert.fail('reload must not call the moderator') }).init();
  const restored = reloaded.getRun(initial.id);
  assert.equal(restored.status, 'interrupted'); assert.deepEqual(restored.turns[0].plan, before.turns[0].plan);
  assert.equal(restored.final.text, before.final.text); assert.equal(restored.final.reviewed, true); assert.equal(restored.final.decided, false); assert.equal(restored.final.consensus, false);
  assert.equal(restored.turns[0].final.decided, false); await council.stop(initial.id);
});

test('planner diagnostics identify the exact rejected field without echoing response content', () => {
  const invalid = planFor(); invalid.roles.claude.instructions = ['A list instead of one string.'];
  const { plan, error } = validatePlan(JSON.stringify(invalid));
  assert.equal(plan, null); assert.equal(error.code, 'invalid_type'); assert.equal(error.path, 'roles.claude.instructions');
  assert.match(error.message, /Claude's role instructions must be one text string, not a list/);
  assert.ok(!error.message.includes(invalid.roles.claude.instructions[0]));
  assert.equal(validatePlan(JSON.stringify(planFor(1, { rationale: ' '.repeat(10) }))).error.code, 'empty_text');
  assert.equal(validatePlan(JSON.stringify(planFor(1, { refinedQuestion: 'x'.repeat(20001) }))).error.path, 'refinedQuestion');
  assert.equal(validatePlan(JSON.stringify(planFor(1, { roles: { codex: planFor().roles.codex, claude: { ...planFor().roles.claude, label: planFor().roles.codex.label } } }))).error.code, 'duplicate_roles');
  assert.equal(validateAdjudication(JSON.stringify(decisionFor(3)), 2).error.code, 'wrong_candidate_version');
  assert.equal(validateAdjudication(JSON.stringify(decisionFor(1, 'revise', { revisionInstructions: [] })), 1).error.code, 'missing_revision_instructions');
});

test('missing-brace planner regression repairs with the exact diagnostic and prior response while keeping raw JSON private', async (t) => {
  // Same structural defect as the reproduced smartphone failure: Codex's role
  // is not closed before Claude's role, leaving the enclosing object incomplete.
  const malformed = JSON.stringify(planFor(1, { refinedQuestion: 'PRIVATE_REPAIR_RESPONSE_MARKER' })).replace('},"claude"', ',"claude"');
  assert.throws(() => JSON.parse(malformed));
  assert.equal(validatePlan(malformed).error.code, 'invalid_json');
  let plans = 0;
  const source = documentSource();
  const { council, calls, events, storageDir } = await harness(t, request => {
    if (phaseOf(request.prompt) === 'PLANNING' && ++plans === 1) { request.onEvent({ type: 'delta', text: malformed }); return { text: malformed }; }
    return basicProvider(request);
  });
  const initial = await council.start({ goal: 'Choose a smartphone while respecting these original requirements.', moderatorModel: 'gpt-6.1-sol', attachments: [source] });
  const run = await finish(council, initial.id);
  assert.equal(run.status, 'completed'); assert.equal(plans, 2);
  const attempts = calls.filter(call => phaseOf(call.prompt) === 'PLANNING');
  assert.ok(attempts.every(call => call.model === 'gpt-6.1-sol' && call.provider === 'codex' && call.outputSchema.additionalProperties === false));
  assert.ok(attempts[1].prompt.includes('VALIDATION ERROR: The moderator returned incomplete or invalid JSON'));
  assert.ok(attempts[1].prompt.includes('VALIDATION FIELD: $'));
  assert.ok(attempts[1].prompt.includes(JSON.stringify(malformed)), 'the repair sees the actual failed response');
  assert.ok(attempts[1].prompt.includes(initial.goal)); assert.ok(attempts[1].prompt.includes(source.text));
  const rejected = run.messages[0];
  assert.deepEqual(rejected.validationError, { ...validatePlan(malformed).error, attempt: 1 });
  assert.equal(rejected.failureKind, 'validation'); assert.match(rejected.error, /incomplete or invalid JSON/);
  assert.ok(events.every(event => event.messages.every(message => !message.text.includes('PRIVATE_REPAIR_RESPONSE_MARKER'))));
  assert.ok(!JSON.stringify(run).includes('PRIVATE_REPAIR_RESPONSE_MARKER'));
  const saved = await readFile(path.join(storageDir, 'runs', `${run.id}.json`), 'utf8');
  assert.ok(!saved.includes('PRIVATE_REPAIR_RESPONSE_MARKER'));
  const exported = exportMarkdown(run);
  assert.ok(!exported.includes('PRIVATE_REPAIR_RESPONSE_MARKER')); assert.match(exported, /incomplete or invalid JSON/);
});

test('repair context explicitly bounds oversized model responses without weakening planner constraints', async (t) => {
  const oversized = '{"refinedQuestion":"' + 'x'.repeat(41000) + 'PRIVATE_OMITTED_TAIL';
  let plans = 0;
  const { council, calls, storageDir } = await harness(t, request => phaseOf(request.prompt) === 'PLANNING' && ++plans === 1 ? { text: oversized } : basicProvider(request));
  const initial = await council.start({ goal: 'Keep diagnostics bounded.' }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'completed');
  const repair = calls.filter(call => phaseOf(call.prompt) === 'PLANNING')[1];
  assert.match(repair.prompt, /Only the first 12000 of \d+ characters are included; the remainder is omitted/);
  assert.ok(repair.prompt.includes(JSON.stringify(oversized.slice(0, 12000))));
  assert.ok(!repair.prompt.includes('PRIVATE_OMITTED_TAIL'));
  assert.equal(run.messages[0].validationError.code, 'response_too_long');
  assert.ok(!(await readFile(path.join(storageDir, 'runs', `${run.id}.json`), 'utf8')).includes('x'.repeat(1000)));
});

test('terminal planner failure retains a precise error and never claims cancellation or saves raw protocol', async (t) => {
  const malformed = '{"refinedQuestion":"PRIVATE_INVALID_PLAN';
  const { council } = await harness(t, () => ({ text: malformed }));
  const initial = await council.start({ goal: 'Show a useful planning error.' }); const run = await finish(council, initial.id);
  assert.equal(run.status, 'failed'); assert.equal(run.final, null);
  assert.match(run.error, /incomplete or invalid JSON/); assert.match(run.error, /Retry the question/);
  assert.ok(run.messages.every(message => message.failureKind === 'validation' && message.validationError.code === 'invalid_json'));
  assert.deepEqual(run.messages.map(message => message.validationError.attempt), [1, 2]);
  assert.ok(!JSON.stringify(run).includes('PRIVATE_INVALID_PLAN'));
});
