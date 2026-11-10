import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerSecret } from './redaction.ts';
export interface Credentials { cloudflare?: string; registrar?: string; resend?: string; monitoring?: string; bingApiKey?: string; mastodonToken?: string; mastodonConnectionId?: string; googleClientId?: string; googleClientSecret?: string; googleRefreshToken?: string; googleScope?: string }
// DPAPI ties ciphertext to the current Windows user. No key or plaintext file is stored.
async function dpapi(input: string, decrypt: boolean): Promise<string> {
  const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.resume(); child.on('error', () => reject(Error('Windows credential protection unavailable')));
    child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(Error('Windows credential protection failed'))); child.stdin.end(input);
  });
}
export class Vault {
  dir: string; values: Credentials = {};
  constructor(dir: string) { this.dir = dir; }
  async load() {
    if (process.platform === 'win32') {
      try { this.values = JSON.parse(Buffer.from(await dpapi(await readFile(join(this.dir, 'connections.dpapi'), 'utf8'), true), 'base64').toString('utf8')); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    this.values = { ...this.values,
      ...(process.env.CLOUDFLARE_API_TOKEN ? { cloudflare: process.env.CLOUDFLARE_API_TOKEN } : {}),
      ...(process.env.CLOUDFLARE_REGISTRAR_TOKEN ? { registrar: process.env.CLOUDFLARE_REGISTRAR_TOKEN } : {}),
      ...(process.env.RESEND_API_KEY ? { resend: process.env.RESEND_API_KEY } : {}),
      ...(process.env.LAUNCHKIT_MONITORING_KEY ? { monitoring: process.env.LAUNCHKIT_MONITORING_KEY } : {}),
      ...(process.env.GOOGLE_CLIENT_ID ? { googleClientId: process.env.GOOGLE_CLIENT_ID } : {}),
      ...(process.env.BING_WEBMASTER_API_KEY ? { bingApiKey: process.env.BING_WEBMASTER_API_KEY } : {}),
      ...(process.env.MASTODON_ACCESS_TOKEN ? { mastodonToken: process.env.MASTODON_ACCESS_TOKEN } : {}),
      ...(process.env.GOOGLE_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_CLIENT_SECRET } : {}) };
    Object.entries(this.values).filter(([key]) => !['googleClientId', 'googleScope'].includes(key)).forEach(([, value]) => registerSecret(value));
  }
  async connect(input: Credentials) {
    const next = { ...this.values };
    for (const key of ['cloudflare', 'registrar', 'resend', 'monitoring', 'bingApiKey', 'mastodonToken', 'googleClientId', 'googleClientSecret', 'googleRefreshToken', 'googleScope'] as const) {
      const value = input[key];
      if (value === '' && !key.startsWith('google')) continue;
      if (value !== undefined) { if (typeof value !== 'string' || value.length > 4096 || /\s/.test(value)) throw Error('Invalid credential'); next[key] = value; if (!['googleClientId', 'googleScope'].includes(key)) registerSecret(value); }
    }
    if (input.mastodonToken) next.mastodonConnectionId = randomUUID();
    if (process.platform === 'win32') {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const path = join(this.dir, 'connections.dpapi'); const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, await dpapi(Buffer.from(JSON.stringify(next)).toString('base64'), false), { mode: 0o600 }); await rename(temp, path);
    }
    this.values = next;
  }
  status() { return { cloudflare: !!this.values.cloudflare, registrar: !!this.values.registrar, resend: !!this.values.resend, persistence: process.platform === 'win32' ? 'Windows user-protected storage' : 'Memory / environment only' }; }
}
