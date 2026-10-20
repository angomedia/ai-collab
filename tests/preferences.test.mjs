import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyQuestionPreferences, createPreferencesStore, DEFAULT_PREFERENCES } from '../src/main/preferences.mjs';

const chosen = () => ({ models: { codex: 'gpt-6.1-sol', claude: 'opus', moderator: 'gpt-6.1-sol' }, timeoutMinutes: 20 });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-collab-preferences-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, 'app data');
  const file = path.join(userData, 'preferences.json');
  const store = createPreferencesStore({ userData });
  return { root, userData, file, store };
}

test('a new installation uses temporary defaults without writing a settings file', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.init(), DEFAULT_PREFERENCES);
  assert.equal(f.store.getWarning(), null);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const snapshot = f.store.getPreferences();
  snapshot.models.moderator = 'changed-in-caller';
  assert.deepEqual(f.store.getPreferences(), DEFAULT_PREFERENCES);
});

test('explicit save persists only model/time values privately and survives a new store', async t => {
  const f = await fixture(t);
  await f.store.init();
  const input = chosen();
  const saved = await f.store.savePreferences(input);
  assert.deepEqual(saved, chosen());
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, ...chosen() });
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(f.userData), ['preferences.json']);
  input.models.codex = 'changed-input';
  saved.models.claude = 'changed-return-value';
  assert.deepEqual(f.store.getPreferences(), chosen());
  const restarted = createPreferencesStore({ userData: f.userData });
  assert.deepEqual(await restarted.init(), chosen());
  assert.equal(restarted.getWarning(), null);
});

test('preferences reject malformed IDs, time limits and extra fields without changing saved defaults', async t => {
  const f = await fixture(t);
  await f.store.savePreferences(chosen());
  const original = await fs.readFile(f.file, 'utf8');
  const invalid = [null, [], {}, { ...chosen(), credentials: 'must-never-be-stored' },
    { ...chosen(), models: { ...chosen().models, apiKey: 'must-never-be-stored' } }];
  for (const provider of ['codex', 'claude', 'moderator']) {
    for (const id of [null, 12, 'model with spaces', 'model\n', '-- model', 'x'.repeat(151)]) {
      invalid.push({ ...chosen(), models: { ...chosen().models, [provider]: id } });
    }
  }
  invalid.push({ ...chosen(), models: { ...chosen().models, moderator: '' } });
  for (const timeoutMinutes of [0, -1, 61, NaN, Infinity, '20', null]) invalid.push({ ...chosen(), timeoutMinutes });
  for (const input of invalid) await assert.rejects(f.store.savePreferences(input), /Choose/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual(f.store.getPreferences(), chosen());
  // Saving does not require a live catalog or login. Removed models remain the user's
  // explicit choice and are validated against the catalog when starting a new chat.
  const offlineChoice = { models: { codex: '', claude: 'sonnet[1m]', moderator: 'future/model:version' }, timeoutMinutes: 1.5 };
  assert.deepEqual(await f.store.savePreferences(offlineChoice), offlineChoice);
  assert.deepEqual(await f.store.savePreferences({ ...offlineChoice, models: { ...offlineChoice.models, claude: '' }, timeoutMinutes: 60 }),
    { ...offlineChoice, models: { ...offlineChoice.models, claude: '' }, timeoutMinutes: 60 });
});

test('malformed and unsupported saved files are preserved with a recoverable warning', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.userData, { recursive: true });
  for (const contents of ['{"models":', JSON.stringify({ version: 200, ...chosen() }), JSON.stringify({ version: 1, ...chosen(), timeoutMinutes: 100 })]) {
    await fs.writeFile(f.file, contents);
    const store = createPreferencesStore({ userData: f.userData });
    assert.deepEqual(await store.init(), DEFAULT_PREFERENCES);
    assert.match(store.getWarning(), /could not be read.*kept.*Save as defaults/);
    assert.equal(await fs.readFile(f.file, 'utf8'), contents);
    assert.deepEqual(await store.savePreferences(chosen()), chosen());
    assert.equal(store.getWarning(), null);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, ...chosen() });
  }
});

test('read failures do not crash startup or expose raw file errors', async t => {
  const f = await fixture(t);
  await f.store.savePreferences(chosen());
  const store = createPreferencesStore({ userData: f.userData, fileSystem: { ...fs,
    readFile: async () => { const error = new Error('private payload must not appear'); error.code = 'EACCES'; throw error; },
  } });
  assert.deepEqual(await store.init(), DEFAULT_PREFERENCES);
  assert.match(store.getWarning(), /Saved defaults could not be read/);
  assert.ok(!store.getWarning().includes('private payload'));
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, ...chosen() });
});

test('a failed atomic save leaves disk and memory intact, cleans its temporary file and permits retry', async t => {
  const f = await fixture(t);
  await f.store.savePreferences(chosen());
  let fail = true;
  const store = createPreferencesStore({ userData: f.userData, fileSystem: { ...fs,
    rename: async (...args) => { if (fail) throw new Error('simulated disk failure'); return fs.rename(...args); },
  } });
  await store.init();
  const next = { models: { codex: '', claude: '', moderator: 'different-model' }, timeoutMinutes: 5 };
  await assert.rejects(store.savePreferences(next), /Defaults could not be saved.*have not changed/);
  assert.deepEqual(store.getPreferences(), chosen());
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, ...chosen() });
  assert.deepEqual(await fs.readdir(f.userData), ['preferences.json']);
  fail = false;
  assert.deepEqual(await store.savePreferences(next), next);
  assert.deepEqual(store.getPreferences(), next);
});

test('concurrent explicit saves commit in order and each resolves only after its file is committed', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let renames = 0;
  const store = createPreferencesStore({ userData: f.userData, fileSystem: { ...fs,
    rename: async (...args) => { renames += 1; if (renames === 1) { entered(); await gate; } return fs.rename(...args); },
  } });
  const first = chosen();
  const second = { ...chosen(), timeoutMinutes: 30 };
  const firstSave = store.savePreferences(first);
  const secondSave = store.savePreferences(second);
  await waiting;
  assert.equal(renames, 1);
  assert.deepEqual(store.getPreferences(), DEFAULT_PREFERENCES);
  release();
  assert.deepEqual(await firstSave, first);
  assert.deepEqual(await secondSave, second);
  assert.deepEqual(store.getPreferences(), second);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, ...second });
});

test('new questions use saved defaults; conversation snapshots and explicit choices take precedence', () => {
  const preferences = chosen();
  const previous = { models: { codex: '', claude: 'old-claude', moderator: 'old-moderator' }, timeoutMinutes: 7 };
  const before = structuredClone(previous);
  assert.deepEqual(applyQuestionPreferences({ goal: 'New question' }, null, preferences), {
    goal: 'New question', codexModel: 'gpt-6.1-sol', claudeModel: 'opus', moderatorModel: 'gpt-6.1-sol', timeoutMinutes: 20,
  });
  assert.deepEqual(applyQuestionPreferences({ goal: 'Follow up' }, previous, preferences), {
    goal: 'Follow up', codexModel: '', claudeModel: 'old-claude', moderatorModel: 'old-moderator', timeoutMinutes: 7,
  });
  assert.deepEqual(applyQuestionPreferences({ goal: 'Override', codexModel: 'explicit-model', claudeModel: '', moderatorModel: 'explicit-moderator', timeoutMinutes: 2 }, previous, preferences), {
    goal: 'Override', codexModel: 'explicit-model', claudeModel: '', moderatorModel: 'explicit-moderator', timeoutMinutes: 2,
  });
  assert.equal(applyQuestionPreferences({ goal: 'Legacy follow up' }, { models: { codex: 'legacy' } }, preferences).moderatorModel,
    DEFAULT_PREFERENCES.models.moderator);
  assert.deepEqual(previous, before);
  assert.deepEqual(preferences, chosen());
});
