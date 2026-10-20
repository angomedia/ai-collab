import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

export const platformPaths = platform => platform === 'win32' ? path.win32 : path.posix;
export const environmentValue = (env, name) => env[Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase())] || '';
export const windowsSystemExecutable = (name, env = process.env) => path.win32.join(environmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', name);
const stopping = new WeakMap();

// Windows child.kill() only kills the immediate process. A .cmd launcher and CLI
// may have descendants, so wait for taskkill /T before completing cancellation.
export function terminateProcessTree(child, { platform = process.platform, kill = process.kill.bind(process), spawn = nodeSpawn, env = process.env } = {}, signal = 'SIGTERM') {
  if (!child?.pid) return Promise.resolve();
  if (platform !== 'win32') {
    try { kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* Already exited. */ } }
    return Promise.resolve();
  }
  if (stopping.has(child)) return stopping.get(child);
  const operation = new Promise(resolve => {
    let killer;
    let timer;
    let done = false;
    const finish = failed => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (failed) { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
      resolve();
    };
    try {
      killer = spawn(windowsSystemExecutable('taskkill.exe', env), ['/PID', String(child.pid), '/T', '/F'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => finish(true));
      killer.once('close', code => finish(code !== 0));
      timer = setTimeout(() => { try { killer.kill(); } catch {} finish(true); }, 3000);
    } catch { finish(true); }
  });
  stopping.set(child, operation);
  return operation;
}
