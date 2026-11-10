import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redact } from '../security/redaction.ts';
export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS']) if (process.env[key]) result[key] = process.env[key];
  return { ...result, CI: 'true', NO_COLOR: '1', ...extra };
}
export async function command(executable: string, args: string[], cwd: string, extra: Record<string, string> = {}, timeout = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: safeEnv(extra), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false;
    const collect = (data: Buffer) => { output = (output + redact(data.toString())).slice(-12_000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } else child.kill('SIGKILL'); }, timeout);
    child.on('error', () => { clearTimeout(timer); reject(Error('Could not start the configured application tool')); });
    child.on('exit', code => { clearTimeout(timer); if (code === 0 && !timedOut) resolve(output); else reject(Error(`${timedOut ? 'Tool timed out' : `Tool exited with code ${code}`}. ${redact(output).slice(-3000)}`)); });
  });
}
export function npmCLI(): string {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const path = candidates.find(p => p && /npm-cli\.js$/.test(p) && existsSync(p)); if (!path) throw Error('Node installation is missing npm-cli.js'); return path;
}
export const npm = (args: string[], cwd: string, env: Record<string, string> = {}, timeout?: number) => command(process.execPath, [npmCLI(), ...args], cwd, env, timeout);
