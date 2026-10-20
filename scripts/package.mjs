import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { buildDocumentReader } from './build-document-reader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icon = path.join(root, 'assets', 'icon.icns');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Package on macOS or Windows for a supported desktop build.');
const helper = await buildDocumentReader();
const results = await packager({
  dir: root,
  name: 'AI Collab',
  appBundleId: 'local.aicollab.desktop',
  appVersion: manifest.version,
  platform: process.platform,
  arch: process.arch,
  out: path.join(root, 'dist'),
  overwrite: true,
  asar: { unpack: '**/*.node' },
  extraResource: helper ? [helper] : [],
  prune: true,
  ...(process.platform === 'darwin' && existsSync(icon) ? { icon } : {}),
  ignore: [/^\/dist(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/test-results(?:\/|$)/, /^\/outputs(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/resources(?:\/|$)/, /^\/\.git(?:hub)?(?:\/|$)/,
    /^\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/],
  extendInfo: { NSHumanReadableCopyright: 'AI Collab contributors', LSMinimumSystemVersion: '13.0' },
});
for (const result of results) console.log(path.join(result, process.platform === 'darwin' ? 'AI Collab.app' : 'AI Collab.exe'));
