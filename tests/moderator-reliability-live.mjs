// Opt-in regression: the smartphone question that exposed malformed moderator JSON.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Council } from '../src/main/orchestrator.mjs';
import { runProvider } from '../src/main/cli.mjs';

if (!process.argv.includes('--live')) throw new Error('Pass --live to use existing subscriptions.');
const storageDir = await mkdtemp(path.join(tmpdir(), 'ai-collab-moderator-regression-'));
const goal = await readFile(new URL('./fixtures/smartphone-goal.txt', import.meta.url), 'utf8');
const calls = [];
const council = await new Council({ storageDir, runProvider: async input => {
  const phase = input.prompt.match(/PHASE:\s*(\w+)/)?.[1];
  if (['PLANNING', 'ADJUDICATION'].includes(phase)) {
    assert.equal(input.provider, 'codex');
    assert.equal(input.model, 'gpt-6.1-sol');
    assert.ok(input.outputSchema, 'moderator responses use a provider-enforced schema');
  }
  calls.push({ phase, model: input.model });
  return runProvider(input);
} }).init();

try {
  let previous;
  council.on('run-updated', run => {
    const phase = `${run.phase}:${run.round}`;
    if (phase !== previous) { previous = phase; console.log(`${run.phase}, draft ${run.round}`); }
  });
  const initial = await council.start({ goal, codexModel: 'gpt-6.1-sol', claudeModel: 'opus', moderatorModel: 'gpt-6.1-sol', timeoutMinutes: 10 });
  await council.tasks.get(initial.id);
  const run = council.getRun(initial.id);
  assert.equal(run.status, 'completed', run.error || run.status);
  assert.equal(run.models.moderator, 'gpt-6.1-sol', 'the user-selected model is preserved');
  assert.equal(run.final.decided, true);
  assert.equal(run.final.moderation.action, 'finalize');
  assert.ok(run.final.reviews.every(review => review.valid && review.candidateVersion === run.final.version));
  assert.notEqual(run.turns[0].plan.roles.codex.label, run.turns[0].plan.roles.claude.label);
  assert.equal(run.messages.filter(message => message.kind === 'planning').length, 1, 'valid plan on first attempt');
  assert.ok(!run.messages.some(message => message.error), 'no protocol validation failures');
  console.log(JSON.stringify({ passed: true, moderator: run.models.moderator, roles: Object.fromEntries(Object.entries(run.turns[0].plan.roles).map(([key, role]) => [key, role.label])), drafts: run.final.version, consensus: run.final.consensus, calls: calls.length, final: run.final.text }));
} finally {
  await council.close();
  await rm(storageDir, { recursive: true, force: true });
}
