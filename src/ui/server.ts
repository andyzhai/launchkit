import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal, atomicJSON } from '../workflow/journal.ts';
import { Cloudflare } from '../adapters/cloudflare.ts';
import { Runner } from '../workflow/runner.ts';
import type { Provider } from '../workflow/types.ts';
import { Vault } from '../security/tokens.ts';
import { clean } from '../security/redaction.ts';
import { configuration } from '../security/config.ts';
import { Operator, eligible } from '../operate/operator.ts';
import { LiveOperatorProvider, MockOperatorProvider } from '../operate/provider.ts';
import type { OperatorProvider } from '../operate/types.ts';
import { CloudController } from '../operate/cloud/controller.ts';
import { GoogleSearch, type SearchProvider } from '../grow/google.ts';
import { Growth, MockSearch } from '../grow/controller.ts';
import type { Run } from '../workflow/types.ts';
import { BusinessSelection } from './selection.ts';
import { BingSearch, MockBing, type BingMetrics } from '../grow/bing.ts';
import { Discoverability, type AuditTools } from '../grow/audit.ts';
import { Mastodon, MockSocial, type SocialProvider } from '../grow/mastodon.ts';
import { Social } from '../grow/social.ts';
import { Improvements, type ImprovementPublisher } from '../grow/improve.ts';
import { M1ImprovementPublisher } from '../grow/improve-publisher.ts';
const assets = dirname(fileURLToPath(import.meta.url));
export async function startServer(options: { journal: Journal; vault: Vault; provider: (mode: 'mock' | 'live') => Provider; operatorProvider?: (mode: 'mock' | 'live') => OperatorProvider; cloudController?: Pick<CloudController, 'deploy' | 'action' | 'report'>; google?: GoogleSearch; growthProvider?: (run: Run) => SearchProvider; bingProvider?: (run: Run) => SearchProvider<BingMetrics>; socialProvider?: (run: Run) => SocialProvider; auditTools?: AuditTools; improvementPublisher?: ImprovementPublisher; port?: number }) {
  const token = randomBytes(32).toString('hex');
  // Keep browser assets and API code from the same server startup. Reading assets
  // on every request can serve a new UI against old in-memory routes after an update.
  const uiAssets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async file => [file, (await readFile(join(assets, file), 'utf8')).replace('__SESSION__', token)] as const)));
  const runners = new Map<string, Runner>(); let active = false; let writing = false;
  const operator = new Operator(options.journal, options.operatorProvider || (mode => mode === 'mock' ? new MockOperatorProvider() : new LiveOperatorProvider(options.vault)));
  const cloud = options.cloudController || new CloudController(options.journal, options.vault);
  const google = options.google || new GoogleSearch(options.vault);
  const bing = new BingSearch(options.vault);
  const mastodon = new Mastodon(options.vault); const mockSocial = new Map<string, MockSocial>();
  const social = new Social(options.journal, options.socialProvider || (run => {
    if (run.config.mode === 'live') return mastodon;
    if (!mockSocial.has(run.id)) mockSocial.set(run.id, new MockSocial());
    return mockSocial.get(run.id)!;
  }));
  const audit = new Discoverability(options.journal, options.auditTools);
  const improvements = new Improvements(options.journal, audit, options.improvementPublisher || new M1ImprovementPublisher(options.vault));
  const mockBing = new Map<string, MockBing>();
  const bingGrowth = new Growth(options.journal, options.bingProvider || (run => {
    if (run.config.mode === 'live') return bing;
    if (!mockBing.has(run.id)) mockBing.set(run.id, new MockBing(run.config.domain));
    return mockBing.get(run.id)!;
  }), undefined, 'bing');
  const selection = new BusinessSelection(options.journal);
  await selection.restore();
  const mockSearch = new Map<string, MockSearch>();
  const growth = new Growth(options.journal, options.growthProvider || (run => {
    if (run.config.mode === 'live') return google;
    if (!mockSearch.has(run.id)) mockSearch.set(run.id, new MockSearch(run.config.domain));
    return mockSearch.get(run.id)!;
  }));
  let backgroundError: string | undefined;
  const getRunner = (id: string, mode: 'mock' | 'live') => { if (!runners.has(id)) runners.set(id, new Runner(options.journal, options.provider(mode))); return runners.get(id)!; };
  const launch = async (id: string, select = false) => {
    if (active) throw Error('A launch or operations check is running. Try again when it finishes.');
    await improvements.assertSettled(id);
    active = true;
    try {
      let run = await options.journal.load(id);
      // A launch started before onboarding is a draft. With one connected account,
      // resume it into the stable account-scoped identity without repeating setup.
      if (run.config.mode === 'live' && !run.config.accountId && options.vault.values.cloudflare && !Object.keys(run.operations).length) {
        const accounts = await new Cloudflare('', options.vault.values).list('/accounts');
        if (accounts.length === 1) {
          const next = await options.journal.create({ ...run.config, accountId: accounts[0].id });
          run.resources.supersededBy = next.id; await options.journal.save(run);
          run = next; await atomicJSON(join(options.journal.dir, 'defaults.json'), run.config);
        }
      }
      backgroundError = undefined;
      if (select) await selection.select(run.id);
      void getRunner(run.id, run.config.mode).execute(run.id).then(async result => {
        if (result.config.mode === 'live' && result.status === 'LIVE_VERIFIED') {
          try { await cloud.action(result.id, 'release', {}); }
          catch { backgroundError = 'Production launch verified; cloud release sync is pending. Refresh cloud status and retry release sync.'; }
        }
      }).catch(() => { /* Saved step evidence is the user-facing error channel. */ }).finally(() => { active = false; });
      return run.id;
    } catch (error) { active = false; throw error; }
  };
  const check = async (id: string) => {
    if (active) throw Error('A launch or operations check is running. Try again when it finishes.');
    active = true;
    try {
      if (!eligible(await options.journal.load(id))) throw Error('Launch and bind this business before checking public health.');
      backgroundError = undefined;
      void operator.check(id).catch(() => { backgroundError = 'An operations check could not be saved. Check access to the state directory and retry.'; }).finally(() => { active = false; });
    } catch (error) { active = false; throw error; }
  };
  let origin = '';
  const server = createServer(async (req, res) => {
    let ownsWrite = false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(clean(value))); };
    try {
      if (req.headers.host !== origin.slice(7)) return send(403, { error: 'Local same-origin access only' });
      const requestURL = new URL(req.url || '/', origin); const path = requestURL.pathname;
      // Only this loopback GET accepts a cross-site navigation. OAuth state + PKCE
      // authenticate it; ordinary API routes still require cookie, CSRF and Origin.
      if (req.method === 'GET' && path === '/oauth/google/callback') {
        if (active || writing) throw Error('The local operator is busy. Start Connect Google again when it finishes.');
        writing = true; ownsWrite = true;
        await google.callback(requestURL);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Google connected</title><p>Google is connected. Return to LaunchKit and refresh Google properties.</p><a href="/">Return to LaunchKit</a>');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local same-origin access only' });
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const body = uiAssets.get(file)!;
        if (path === '/') res.setHeader('Set-Cookie', `launchkit=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript' : 'text/css' }); return res.end(body);
      }
      if (req.headers['x-launchkit-token'] !== token || !req.headers.cookie?.split(';').map(x => x.trim()).includes(`launchkit=${token}`)) return send(403, { error: 'Open LaunchKit in this browser to establish a local session' });
      if (req.method !== 'GET' && (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json'))) return send(403, { error: 'Invalid request origin or content type' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 20_000) return send(413, { error: 'Request too large' }); }
      const body = raw ? JSON.parse(raw) : {};
      if (req.method !== 'GET') { if (writing) throw Error('Another local update is in progress. Try again.'); writing = true; ownsWrite = true; }
      if (path === '/api/status' && req.method === 'GET') return send(200, { connections: options.vault.status(), google: google.status(), bing: bing.status(), social: { connected: mastodon.connected(), persistence: options.vault.status().persistence }, active, backgroundError });
      if (path === '/api/selection' && req.method === 'GET') return send(200, { selectedRunId: (await selection.current())?.id });
      if (path === '/api/selection' && req.method === 'POST') return send(200, await selection.select(body.selectedRunId));
      if (path === '/api/defaults' && req.method === 'GET') {
        try { return send(200, JSON.parse(await readFile(join(options.journal.dir, 'defaults.json'), 'utf8'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; return send(200, {}); }
      }
      if (path === '/api/accounts' && req.method === 'GET') {
        if (!options.vault.values.cloudflare) return send(200, []);
        return send(200, (await new Cloudflare('', options.vault.values).list('/accounts')).map(a => ({ id: a.id, name: a.name })));
      }
      if (path === '/api/apps' && req.method === 'GET') {
        const parent = dirname(process.cwd()); const apps: { path: string; name: string }[] = [];
        for (const item of await readdir(parent, { withFileTypes: true })) if (item.isDirectory() && !item.name.startsWith('.')) {
          try { const pkg = JSON.parse(await readFile(join(parent, item.name, 'package.json'), 'utf8')); if (pkg.devDependencies?.vite || pkg.dependencies?.vite) apps.push({ path: join(parent, item.name), name: pkg.name || item.name }); } catch { /* Not an application. */ }
        }
        return send(200, apps);
      }
      if (path === '/api/connections' && req.method === 'POST') { if (active) throw Error('Wait until the launch pauses before changing connections'); await options.vault.connect({ cloudflare: body.cloudflare, registrar: body.registrar, resend: body.resend, monitoring: body.monitoring }); return send(200, options.vault.status()); }
      if (path === '/api/grow/google' && req.method === 'GET') return send(200, google.status());
      if (path === '/api/grow/social/connect' && req.method === 'POST') {
        if (active) throw Error('Wait until the current operation finishes.');
        if (typeof body.accessToken !== 'string' || (!body.accessToken && !mastodon.connected()) || body.accessToken.length > 4096 || /\s/.test(body.accessToken)) throw Error('Enter a mastodon.social user access token.');
        if (body.accessToken) await options.vault.connect({ mastodonToken: body.accessToken });
        return send(200, { connected: mastodon.connected(), persistence: options.vault.status().persistence });
      }
      if (path === '/api/grow/bing/connect' && req.method === 'POST') {
        if (active) throw Error('Wait until the current operation finishes.');
        if (typeof body.apiKey !== 'string' || (!body.apiKey && !bing.connected())) throw Error('Enter your Bing Webmaster API key.');
        await options.vault.connect({ bingApiKey: body.apiKey });
        return send(200, bing.status());
      }
      if (path === '/api/grow/google/connect' && req.method === 'POST') {
        if (active) throw Error('Wait until the current operation finishes.');
        return send(200, google.begin(origin, body));
      }
      if (path === '/api/runs' && req.method === 'GET') return send(200, await options.journal.list());
      if (path === '/api/runs' && req.method === 'POST') {
        if (active) throw Error('A launch is already running');
        const config = configuration(body);
        for (const existing of await options.journal.list()) if (existing.config.domain === config.domain && existing.config.mode === config.mode) await improvements.assertSettled(existing.id);
        await atomicJSON(join(options.journal.dir, 'defaults.json'), config);
        const run = await options.journal.create(config); const id = await launch(run.id, true); return send(202, { id });
      }
      const analyticsRoute = path.match(/^\/api\/runs\/([a-f0-9]{24})\/analytics$/);
      if (analyticsRoute && req.method === 'POST') {
        if (active) throw Error('Wait until the current operation finishes.');
        active = true;
        try {
          const run = await options.journal.load(analyticsRoute[1]);
          return send(200, (await getRunner(run.id, run.config.mode).configureAnalytics(run.id)).steps.analytics);
        } finally { active = false; }
      }
      const socialRoute = path.match(/^\/api\/runs\/([a-f0-9]{24})\/grow\/social(?:\/(refresh|save|template|prepare|approval|reconcile))?$/);
      if (socialRoute) {
        const id = socialRoute[1]; const action = socialRoute[2];
        if (req.method === 'GET' && !action) return send(200, await social.report(id));
        if (req.method === 'POST' && action) {
          if (active) throw Error('Wait until the current operation finishes.');
          const draftId = await social.action(id, action, body);
          return send(200, { ...await social.report(id), ...(draftId ? { savedDraftId: draftId } : {}) });
        }
      }
      const improvementRoute = path.match(/^\/api\/runs\/([a-f0-9]{24})\/grow\/improvements(?:\/(prepare|publish|decline|verify))?$/);
      if (improvementRoute) {
        const id = improvementRoute[1]; const action = improvementRoute[2];
        if (req.method === 'GET' && !action) return send(200, await improvements.report(id));
        if (req.method === 'POST' && action) {
          if (active) throw Error('Wait until the current operation finishes.');
          await improvements.action(id, action, body);
          return send(200, await improvements.report(id));
        }
      }
      const auditRoute = path.match(/^\/api\/runs\/([a-f0-9]{24})\/grow\/audit(?:\/(refresh))?$/);
      if (auditRoute) {
        if (req.method === 'GET' && !auditRoute[2]) return send(200, await audit.report(auditRoute[1]));
        if (req.method === 'POST' && auditRoute[2]) {
          if (active) throw Error('Wait until the current operation finishes.');
          return send(200, await audit.refresh(auditRoute[1]));
        }
      }
      const growthRoute = path.match(/^\/api\/runs\/([a-f0-9]{24})\/grow(\/bing)?(?:\/(refresh|select|prepare|approval))?$/);
      if (growthRoute) {
        const id = growthRoute[1]; const action = growthRoute[3]; const controller = growthRoute[2] ? bingGrowth : growth;
        if (req.method === 'GET' && !action) return send(200, await controller.report(id));
        if (req.method === 'POST' && action) {
          if (active) throw Error('Wait until the current operation finishes.');
          if (action === 'refresh') await controller.refresh(id);
          if (action === 'select') await controller.select(id, body.property);
          if (action === 'prepare') await controller.prepare(id);
          if (action === 'approval') await controller.decide(id, body.approvalId, body.decision);
          return send(200, await controller.report(id));
        }
      }
      const cloudRoute = path.match(/^\/api\/runs\/([a-f0-9]{24})\/cloud(?:\/(deploy|configure|verification|acknowledge|release))?$/);
      if (cloudRoute) {
        const id = cloudRoute[1]; const action = cloudRoute[2];
        if (req.method === 'GET' && !action) return send(200, await cloud.report(id));
        if (req.method === 'POST' && action) {
          if (active) throw Error('Wait until the current operation finishes.');
          if (action === 'deploy') {
            active = true; backgroundError = undefined;
            void cloud.deploy(id, body).catch((error: Error) => { backgroundError = error.message; }).finally(() => { active = false; });
            return send(202, { id });
          }
          const result = await cloud.action(id, action as 'configure' | 'verification' | 'acknowledge' | 'release', body);
          if (action === 'release') backgroundError = undefined;
          return send(200, result);
        }
      }
      const operation = path.match(/^\/api\/runs\/([a-f0-9]{24})\/operate(?:\/(check|acknowledge|recover))?$/);
      if (operation) {
        const id = operation[1];
        if (req.method === 'GET' && !operation[2]) return send(200, await operator.report(id));
        if (req.method === 'POST') {
          if (active) throw Error('Wait until the current launch or operations check finishes.');
          if (!operation[2]) return send(200, await operator.configure(id, body));
          if (operation[2] === 'check') { await check(id); return send(202, { id }); }
          if (operation[2] === 'acknowledge') return send(200, await operator.acknowledge(id, body.incidentId));
          if (operation[2] === 'recover') {
            if (!eligible(await options.journal.load(id))) throw Error('Launch and bind this business before inspecting recovery.');
            await operator.recordRecovery(id); await launch(id, true); return send(202, { id });
          }
        }
      }
      const match = path.match(/^\/api\/runs\/([a-f0-9]{24})(?:\/(resume|approval|report))?$/);
      if (match) {
        const run = await options.journal.load(match[1]);
        if (req.method === 'GET' && !match[2]) return send(200, run);
        if (req.method === 'GET' && match[2] === 'report') return send(200, run.report || { status: run.status, steps: run.steps });
        if (req.method === 'POST' && match[2] === 'resume') { const id = await launch(run.id, true); return send(202, { id }); }
        if (req.method === 'POST' && match[2] === 'approval') {
          if (active) throw Error('Wait until the launch pauses');
          if (!['approved', 'denied'].includes(body.decision)) throw Error('Invalid approval decision');
          await getRunner(run.id, run.config.mode).decide(run.id, body.approvalId, body.decision); await launch(run.id, true); return send(202, { id: run.id });
        }
      }
      return send(404, { error: 'Not found' });
    } catch (e: any) { send(400, { error: e.message || 'Request failed' }); }
    finally { if (ownsWrite) writing = false; }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No local address'); origin = `http://127.0.0.1:${address.port}`;
  // Bounded polling also resumes interrupted runs. No repeated purchase or denied approvals.
  const polls = new Map<string, number>();
  let closed = false;
  let preferOperations = true;
  const tick = async () => {
    if (closed || active || writing) return;
    writing = true;
    try {
      const due = await operator.due();
      if (closed) return;
      if (due && preferOperations) { preferOperations = false; await check(due); return; }
      for (const run of await options.journal.list()) {
        if (closed) return;
        const count = polls.get(run.id) || 0;
        const pending = run.status === 'RUNNING' || Object.values(run.steps).some(s => s.status === 'WAITING_PROVIDER' || s.evidence?.poll === true);
        if (pending && count < 10) { polls.set(run.id, count + 1); preferOperations = true; await launch(run.id); return; }
      }
      if (due) { preferOperations = false; await check(due); }
    } catch { backgroundError = 'A scheduled check could not start. Check the local state directory and retry.'; }
    finally { writing = false; }
  };
  const timer = setInterval(() => void tick(), 30_000); timer.unref();
  server.on('close', () => { closed = true; clearInterval(timer); });
  return { server, origin, tick };
}
