import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const artifacts = path.join(project, 'dist', 'release');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Installer checks run on macOS or Windows.');
// NSIS writes per-user install registration. Never run this test against a
// developer's real Windows profile or replace their existing installation.
if (process.platform === 'win32' && (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP)) {
  throw new Error('The Windows install/uninstall check runs only on an isolated GitHub Actions runner. Use npm run test:release to check an unpacked app locally.');
}
const temporary = await mkdtemp(path.join(process.platform === 'win32' ? process.env.RUNNER_TEMP : tmpdir(), 'ai-collab-installer-'));
async function check(executablePath) {
  await access(executablePath);
  const { stdout, stderr } = await execute(process.execPath, [path.join(project, 'tests', 'release-smoke.mjs')], {
    cwd: project,
    env: { ...process.env, AI_COLLAB_PACKAGED_EXECUTABLE: executablePath },
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
}
try {
  if (process.platform === 'darwin') {
    const mount = path.join(temporary, 'mounted');
    await mkdir(mount);
    let attached = false;
    try {
      await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(artifacts, `AI-Collab-${manifest.version}-mac-${process.arch}.dmg`)], { timeout: 90000 });
      attached = true;
      await check(path.join(mount, 'AI Collab.app', 'Contents', 'MacOS', 'AI Collab'));
      console.log('Read-only DMG application passed.');
    } finally {
      if (attached) await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 });
    }
    const expanded = path.join(temporary, 'expanded');
    await execute('/usr/bin/ditto', ['-x', '-k', path.join(artifacts, `AI-Collab-${manifest.version}-mac-${process.arch}.zip`), expanded], { timeout: 90000 });
    await check(path.join(expanded, 'AI Collab.app', 'Contents', 'MacOS', 'AI Collab'));
    console.log('Extracted ZIP application passed.');
  } else {
    const installation = path.join(temporary, 'AI Collab');
    let installed = false;
    try {
      // NSIS requires /D last and unquoted, even when the destination has spaces.
      // windowsVerbatimArguments preserves those documented NSIS semantics.
      await execute(path.join(artifacts, `AI-Collab-${manifest.version}-win-x64.exe`), ['/S', `/D=${installation}`], { windowsVerbatimArguments: true, timeout: 120000 });
      installed = true;
      await check(path.join(installation, 'AI Collab.exe'));
      console.log('NSIS-installed application passed.');
    } finally {
      if (installed) {
        const uninstaller = (await readdir(installation)).find(name => /^Uninstall.*\.exe$/i.test(name));
        if (!uninstaller) throw new Error('NSIS did not install an uninstaller.');
        // _?= prevents asynchronous self-copy, so we wait for actual cleanup.
        await execute(path.join(installation, uninstaller), ['/S', `_?=${installation}`], { windowsVerbatimArguments: true, timeout: 90000 });
        try { await access(path.join(installation, 'AI Collab.exe')); }
        catch (error) { if (error.code === 'ENOENT') { console.log('NSIS uninstall passed.'); } else throw error; }
        if ((await readdir(installation).catch(() => [])).includes('AI Collab.exe')) throw new Error('NSIS uninstall left the application executable behind.');
      }
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
