// Opt-in subscription test: a decision and follow-up with moderator-assigned roles.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Council } from '../src/main/orchestrator.mjs';
import { runProvider } from '../src/main/cli.mjs';
import { discoverModels } from '../src/main/models.mjs';

if (!process.argv.includes('--live')) throw new Error('Pass --live to use existing subscriptions for this test.');
const temporary = await mkdtemp(path.join(tmpdir(), 'ai-collab-moderated-live-'));
const calls = [];
const source = {
  id: 'career-source', name: 'fictional-job-offer.csv', extension: 'csv', warnings: [],
  text: 'fact,value\nevidence_reference,CAREER_SOURCE_9347\ncurrent_salary_usd,85000\noffer_salary_usd,105000\nannual_takehome_raise_usd,14000\nannual_extra_travel_usd,4000\nannual_extra_lunch_usd,1500\ncommute_minutes_each_way,75\noffice_days_per_week,5\nworking_weeks_per_year,46\nwork_hours_per_week_both_jobs,40\n',
};
source.charCount = source.text.length;
const council = new Council({ storageDir: temporary, runProvider: async input => {
  const phase = input.prompt.match(/PHASE:\s*(\w+)/)?.[1];
  const turn = Number(input.prompt.match(/TURN_NUMBER:\s*(\d+)/)?.[1]);
  // Search-enabled research calls deliberately never receive attachments.
  assert.equal(input.prompt.includes(source.text), phase !== 'RESEARCH', 'every role except web research receives the entire attachment');
  if (phase === 'PLANNING' || phase === 'ADJUDICATION') {
    assert.equal(input.provider, 'codex');
    assert.equal(input.model, 'gpt-6-sol');
  }
  calls.push({ phase, turn, provider: input.provider, model: input.model, prompt: input.prompt });
  return runProvider(input);
} });

function complete(id) {
  return new Promise(resolve => {
    const existing = council.getRun(id);
    if (existing.status !== 'running') return resolve(existing);
    const listener = run => {
      if (run.id === id && run.status !== 'running') { council.off('run-updated', listener); resolve(run); }
    };
    council.on('run-updated', listener);
  });
}

try {
  const catalog = await discoverModels({ force: true });
  assert.ok(catalog.codex.options.some(item=>item.id==='gpt-6-sol'));
  assert.ok(catalog.claude.options.some(item=>item.id==='sonnet'));
  const codexModel = catalog.codex.options.find(item=>item.id && item.isDefault)?.id || 'gpt-6.1-sol';
  await council.init();
  let previousPhase;
  council.on('run-updated', run => {
    const current = `${run.turns.length}:${run.phase}:${run.round}`;
    if (current !== previousPhase) { previousPhase = current; console.log(`Question ${run.turns.length}: ${run.phase}, draft ${run.round}`); }
  });
  const started = await council.start({
    goal: 'Should I take the new office job or stay remote? Use the attached fictional job facts. My current salary covers my needs; I value evenings with my partner and a personal project, but want to save more. The remote job is stable with a supportive manager and limited promotion opportunities. The offer has more interesting work and possible career growth, but an unfamiliar manager and no guaranteed promotion. Benefits are equal. Compare the choices honestly and give one recommendation under 200 words. Explicitly include the annual net financial gain after the listed costs and annual commuting hours. Do not invent facts or research. Treat the supplied take-home raise as an assumption; no tax advice is needed.',
    codexModel, claudeModel: 'sonnet', moderatorModel: 'gpt-6-sol', timeoutMinutes: 8, attachments: [source],
  });
  const first = await complete(started.id);
  assert.equal(first.status, 'completed', first.error || first.status);
  assert.equal(first.final.decided, true);
  assert.equal(first.final.moderation.action, 'finalize');
  assert.ok(first.turns[0].plan?.roles.codex.label);
  assert.notEqual(first.turns[0].plan.roles.codex.label, first.turns[0].plan.roles.claude.label);
  const firstText = first.final.text.replaceAll(',', '');
  assert.match(firstText, /8500|8\.5\s*k/i);
  assert.match(firstText, /575/);
  console.log(JSON.stringify({ question: 1, roles: first.turns[0].plan.roles, mode: first.turns[0].plan.mode, decided: first.final.decided, consensus: first.final.consensus, answer: first.final.text }));
  await council.followUp(first.id, {
    goal: 'The new employer now offers two office days per week at the same salary. Assume annual commuting and extra lunch costs fall to exactly 40% of the original amounts. Everything else is unchanged. Recalculate annual net gain and commuting hours, and explain whether your earlier recommendation changes. Use the earlier conversation and attachment. Keep the final answer under 200 words.',
    timeoutMinutes: 8,
  });
  const second = await complete(first.id);
  assert.equal(second.status, 'completed', second.error || second.status);
  assert.equal(second.final.decided, true);
  assert.equal(second.turns.length, 2);
  assert.deepEqual(second.turns[0].final, first.final);
  assert.deepEqual(second.turns[0].plan, first.turns[0].plan);
  assert.ok(second.turns[1].plan);
  const secondText = second.final.text.replaceAll(',', '');
  assert.match(secondText, /11800|11\.8\s*k/i);
  assert.match(secondText, /230/);
  assert.ok(calls.filter(call=>call.turn===2).every(call=>call.prompt.includes(first.final.text)), 'follow-up roles retain the earlier answer');
  assert.equal(calls.filter(call=>call.phase==='PLANNING').length, 2);
  console.log(JSON.stringify({question:2,roles:second.turns[1].plan.roles,decided:second.final.decided,consensus:second.final.consensus,answer:second.final.text,calls:calls.length}));
} finally {
  await council.close();
  await rm(temporary,{recursive:true,force:true});
}
