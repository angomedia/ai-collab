import { discoverProviders, runProvider } from '../src/main/cli.mjs';
import { Council } from '../src/main/orchestrator.mjs';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const providers = await discoverProviders();
console.log(JSON.stringify(providers, null, 2));
const args = process.argv.slice(2);
const providerIndex = args.indexOf('--provider');
if (providerIndex >= 0) {
  const provider = args[providerIndex + 1];
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-collab-smoke-'));
  const response = await runProvider({ provider, cwd, timeoutMs: 180000,
    prompt: 'This is a connection test for AI Collab. Do not use tools. Respond with exactly: Connection ready.',
    onEvent: event => { if (event.type === 'status') console.log(event.text); },
  });
  console.log(`${provider}: ${response.text}`);
} else if (args.includes('--full')) {
  for (const [name, status] of Object.entries(providers)) if (!status.authenticated) throw new Error(`${name} needs sign-in.`);
  const storageDir = path.resolve('test-results/live-smoke');
  await mkdir(storageDir, { recursive: true });
  const council = await new Council({ runProvider, storageDir }).init();
  let previous;
  council.on('run-updated', run => {
    const state = `${run.status}: ${run.phase} (draft ${run.round})`;
    if (state !== previous) { console.log(state); previous = state; }
  });
  const first = await council.start({
    goal: 'Suggest a simple two-step routine for keeping a small desk tidy. Keep the final answer under 100 words. No research or tools are needed.',
    timeoutMinutes: 8,
  });
  await new Promise(resolve => {
    if (council.getRun(first.id).status !== 'running') return resolve();
    const listener = run => { if (run.id === first.id && run.status !== 'running') { council.off('run-updated', listener); resolve(); } };
    council.on('run-updated', listener);
  });
  const result = council.getRun(first.id);
  console.log(JSON.stringify({ status: result.status, error: result.error, final: result.final, messageCount: result.messages.length }, null, 2));
  await council.close();
  if (result.status !== 'completed') process.exitCode = 1;
}
