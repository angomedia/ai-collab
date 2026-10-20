import { build, Platform, Arch } from 'electron-builder';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocumentReader } from './build-document-reader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const platform = args.includes('--mac') ? 'darwin' : args.includes('--win') ? 'win32' : process.platform;
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch;
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) {
  throw new Error('Supported installers: --mac --arm64, --mac --x64, or --win --x64.');
}
// Each release runs natively so npm's optional PDF/canvas binaries match the target.
if (platform !== process.platform || arch !== process.arch) throw new Error('Build each installer on a matching native OS and architecture. Use the release workflow for the full matrix.');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) {
  throw new Error(`Release tag must match package.json: v${manifest.version}.`);
}
const output = path.join(root, 'dist', 'release');
const mac = platform === 'darwin';
const helper = mac ? await buildDocumentReader({ arch, output: path.join(root, 'resources', arch, 'document-reader') }) : null;
const hasSigningIdentity = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const canNotarize = Boolean((process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) || (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER));
// Do not silently use a certificate from a developer's personal keychain.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const target = mac ? Platform.MAC : Platform.WINDOWS;
await build({
  projectDir: root,
  targets: target.createTarget(args.includes('--dir') ? ['dir'] : mac ? ['dmg', 'zip'] : ['nsis'], Arch[arch]),
  publish: 'never',
  config: {
    appId: 'local.aicollab.desktop',
    productName: 'AI Collab',
    copyright: 'Copyright © Ango Media',
    directories: { output, buildResources: path.join(root, 'assets') },
    files: [
      'src/**/*', 'assets/icon.png', 'package.json', 'LICENSE', 'README.md',
      // The app always passes the user's installed Claude Code to the SDK.
      // Its optional CLI binaries are not a second managed installation.
      '!node_modules/@anthropic-ai/claude-agent-sdk-*/**/*',
    ],
    asar: true,
    asarUnpack: ['**/*.node'],
    npmRebuild: false,
    forceCodeSigning: false,
    artifactName: 'AI-Collab-${version}-${os}-${arch}.${ext}',
    publish: null,
    mac: {
      category: 'public.app-category.productivity',
      icon: path.join(root, 'assets', 'icon.icns'),
      minimumSystemVersion: '13.0',
      extraResources: helper ? [{ from: helper, to: 'document-reader' }] : [],
      // Ad-hoc signing makes the ARM binary runnable; it is not Developer ID signing.
      ...(hasSigningIdentity ? {} : { identity: '-' }),
      hardenedRuntime: hasSigningIdentity,
      notarize: hasSigningIdentity && canNotarize,
    },
    dmg: { sign: hasSigningIdentity },
    win: { icon: path.join(root, 'assets', 'icon.png'), target: ['nsis'], executableName: 'AI Collab' },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: 'AI Collab',
      deleteAppDataOnUninstall: false,
    },
  },
});
const suffix = `${mac ? 'mac' : 'win'}-${arch}`;
const installers = (await readdir(output)).filter(name => name.startsWith(`AI-Collab-${manifest.version}-${suffix}.`) && /\.(dmg|zip|exe)$/.test(name)).sort();
if (!args.includes('--dir')) {
  if (installers.length !== (mac ? 2 : 1)) throw new Error(`Expected ${mac ? 2 : 1} ${suffix} installer artifacts; got ${installers.length}.`);
  const checksums = await Promise.all(installers.map(async name => `${createHash('sha256').update(await readFile(path.join(output, name))).digest('hex')}  ${name}`));
  await writeFile(path.join(output, `SHA256SUMS-${suffix}.txt`), checksums.join('\n') + '\n');
  console.log(installers.map(name => path.join(output, name)).join('\n'));
}
