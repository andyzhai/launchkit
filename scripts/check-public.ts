import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
const staged = git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const candidates = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
const forbidden = /(^|\/)(private|node_modules|dist|test-results|\.wrangler|\.codex|\.launchkit)(\/|$)|(^|\/)\.env(?!\.example$)|\.(pem|key|pfx|log|report\.json|journal\.json)$/i;
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(?:sk-|re_)[A-Za-z0-9_-]{24,}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /(?:CLOUDFLARE_API_TOKEN|RESEND_API_KEY)[ \t]*=[ \t]*['"]?[A-Za-z0-9_-]{20,}/];
const failures: string[] = [];
for (const path of new Set([...tracked, ...candidates])) {
  if (forbidden.test(path)) failures.push(`Forbidden public path: ${path}`);
  let content: string; try { content = await readFile(path, 'utf8'); } catch { continue; }
  if (patterns.some(pattern => pattern.test(content))) failures.push(`Potential secret: ${path}`);
  if (/C:[\\/]Users[\\/]/i.test(content)) failures.push(`Machine-specific path: ${path}`);
}
// Inspect index contents separately: a safe working tree must not conceal an older staged secret.
for (const path of staged) {
  try { const content = git(['show', `:${path}`]); if (patterns.some(p => p.test(content))) failures.push(`Potential staged secret: ${path}`); } catch { /* Staged deletion. */ }
}
console.log(`Exact staged file list (${staged.length}):`); staged.forEach(path => console.log(path));
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; } else console.log(`Public hygiene scan passed for ${new Set([...tracked, ...candidates]).size} files. No commit or push performed.`);
