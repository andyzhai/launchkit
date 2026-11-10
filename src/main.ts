import { Journal } from './workflow/journal.ts';
import { Vault } from './security/tokens.ts';
import { MockProvider } from './adapters/mock.ts';
import { startServer } from './ui/server.ts';
import { LiveProvider } from './adapters/live.ts';
import { relative, isAbsolute } from 'node:path';
const configuredDataDir = process.env.LAUNCHKIT_DATA_DIR;
if (configuredDataDir) {
  const location = relative(process.cwd(), configuredDataDir);
  if (!location || (!location.startsWith('..') && !isAbsolute(location))) throw Error('LAUNCHKIT_DATA_DIR must be outside the LaunchKit repository');
}
const journal = new Journal(process.env.LAUNCHKIT_DATA_DIR); await journal.init();
const unlock = await journal.lock();
const vault = new Vault(journal.dir); await vault.load();
const { server, origin } = await startServer({ journal, vault, port: Number(process.env.PORT || 4317), provider: mode => mode === 'mock' ? new MockProvider(journal.dir) : new LiveProvider(journal.dir, vault) });
console.log(`LaunchKit is ready at ${origin}`);
let closing = false;
async function close() { if (closing) return; closing = true; server.close(); server.closeAllConnections(); await unlock(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
