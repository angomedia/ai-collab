import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MODERATOR_MODEL } from './orchestrator.mjs';

const PROVIDERS = ['codex', 'claude', 'moderator'];
const MODEL_ID = /^[a-zA-Z0-9._:/\[\]-]{1,150}$/;
export const DEFAULT_PREFERENCES = Object.freeze({
  models: Object.freeze({ codex: '', claude: '', moderator: DEFAULT_MODERATOR_MODEL }),
  timeoutMinutes: 20,
});
const copy = value => structuredClone(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validatePreferences(input) {
  if (!isObject(input) || Object.keys(input).some(key => !['models', 'timeoutMinutes'].includes(key))
    || !isObject(input.models) || Object.keys(input.models).some(key => !PROVIDERS.includes(key))) {
    throw new Error('Choose the three model defaults and a time limit.');
  }
  const models = {};
  for (const provider of PROVIDERS) {
    const value = input.models[provider];
    if (typeof value !== 'string' || (value === '' ? provider === 'moderator' : !MODEL_ID.test(value))) {
      throw new Error(`Choose a valid ${provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'moderator'} model default.`);
    }
    models[provider] = value;
  }
  if (typeof input.timeoutMinutes !== 'number' || !Number.isFinite(input.timeoutMinutes)
    || input.timeoutMinutes < 1 || input.timeoutMinutes > 60) {
    throw new Error('Choose a time limit between 1 and 60 minutes.');
  }
  return { models, timeoutMinutes: input.timeoutMinutes };
}

// A conversation's settings are its own snapshot; changing app defaults must not
// change a later question in that conversation, including older saved chats.
export function applyQuestionPreferences(input, previous, preferences = DEFAULT_PREFERENCES) {
  const base = previous ? {
    models: { ...DEFAULT_PREFERENCES.models, ...previous.models },
    timeoutMinutes: previous.timeoutMinutes ?? DEFAULT_PREFERENCES.timeoutMinutes,
  } : preferences;
  return {
    ...input,
    codexModel: input.codexModel ?? base.models.codex,
    claudeModel: input.claudeModel ?? base.models.claude,
    moderatorModel: input.moderatorModel ?? base.models.moderator,
    timeoutMinutes: input.timeoutMinutes ?? base.timeoutMinutes,
  };
}

export function createPreferencesStore({ userData, fileSystem = fs } = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('A local app data directory is required.');
  const settingsPath = path.join(userData, 'preferences.json');
  let preferences = copy(DEFAULT_PREFERENCES);
  let warning = null;
  let initialization;
  let mutations = Promise.resolve();
  const getPreferences = () => copy(preferences);
  const getWarning = () => warning;

  function init() {
    initialization ??= (async () => {
      try {
        const metadata = await fileSystem.stat(settingsPath);
        if (!metadata.isFile() || metadata.size > 16384) throw new Error('Invalid preferences file.');
        const saved = JSON.parse(await fileSystem.readFile(settingsPath, 'utf8'));
        if (!isObject(saved) || saved.version !== 1
          || Object.keys(saved).some(key => !['version', 'models', 'timeoutMinutes'].includes(key))) throw new Error('Unsupported preferences format.');
        preferences = validatePreferences({ models: saved.models, timeoutMinutes: saved.timeoutMinutes });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          warning = 'Saved defaults could not be read. Temporary app defaults are in use. The existing preferences.json has been kept; use Save as defaults to replace it.';
        }
      }
      return getPreferences();
    })();
    return initialization;
  }

  async function savePreferences(input) {
    const next = validatePreferences(input);
    const save = mutations.catch(() => {}).then(async () => {
      await init();
      const temporary = `${settingsPath}.${randomUUID()}.tmp`;
      try {
        await fileSystem.mkdir(userData, { recursive: true, mode: 0o700 });
        const handle = await fileSystem.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        await fileSystem.rename(temporary, settingsPath);
        preferences = next;
        warning = null;
        return getPreferences();
      } catch {
        throw new Error('Defaults could not be saved. Your previously saved defaults have not changed. Check access to the app data folder and try again.');
      } finally {
        await fileSystem.rm(temporary, { force: true }).catch(() => {});
      }
    });
    mutations = save;
    return save;
  }

  return { init, getPreferences, getWarning, savePreferences };
}
