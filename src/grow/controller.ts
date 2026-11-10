import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, Journal } from '../workflow/journal.ts';
import type { Run } from '../workflow/types.ts';
import { eligible } from '../operate/operator.ts';
import { searchWindow, type SearchProvider, type Site, type Sitemap, type Metrics, type Window } from './google.ts';
import { bingCovers } from './bing.ts';

type Result<T> = { status: 'AVAILABLE'; at: string; data: T } | { status: 'UNAVAILABLE' | 'NO_DATA'; at: string; message: string };
interface Submission {
  id: string; property: string; sitemap: string; connection: string; createdAt: string;
  status: 'AWAITING_APPROVAL' | 'DECLINED' | 'INTENT' | 'UNKNOWN' | 'ACCEPTED' | 'OBSERVED';
  approvedAt?: string; attemptedAt?: string; observedAt?: string;
}
export interface GrowthState<M = Metrics> {
  schema: 1; runId: string; connection?: string; property?: string; refreshedAt?: string;
  properties?: Result<Site[]>; sitemaps?: Result<Sitemap[]>; performance?: Result<M>;
  window?: Window; submissions: Submission[];
}
export function covers(site: string, domain: string) {
  if (site === `https://${domain}/`) return true;
  if (!site.startsWith('sc-domain:')) return false;
  const base = site.slice(10);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(base) && (domain === base || domain.endsWith(`.${base}`));
}
const readable = (site: Site) => ['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(site.permissionLevel);
const writable = (site: Site) => ['siteOwner', 'siteFullUser'].includes(site.permissionLevel);
const unknown = (at: string, message: string): Result<never> => ({ status: 'UNAVAILABLE', at, message });

export class Growth<M = Metrics> {
  journal: Journal; provider: (run: Run) => SearchProvider<M>; now: () => Date; busy = false; engine: 'google' | 'bing';
  constructor(journal: Journal, provider: (run: Run) => SearchProvider<M>, now = () => new Date(), engine: 'google' | 'bing' = 'google') { this.journal = journal; this.provider = provider; this.now = now; this.engine = engine; }
  get directory() { return this.engine === 'bing' ? 'grow-bing' : 'grow'; }
  get name() { return this.engine === 'bing' ? 'Bing' : 'Google'; }
  writable(site: Site) { return this.engine === 'bing' ? site.permissionLevel === 'verified' : writable(site); }
  path(id: string) { this.journal.path(id); return join(this.journal.dir, this.directory, `${id}.json`); }
  async load(id: string): Promise<GrowthState<M>> {
    try { const state = JSON.parse(await readFile(this.path(id), 'utf8')); if (state.schema !== 1 || state.runId !== id) throw Error('Unsupported Growth journal'); return state; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; return { schema: 1, runId: id, submissions: [] }; }
  }
  async save(state: GrowthState<M>) { await mkdir(join(this.journal.dir, this.directory), { recursive: true, mode: 0o700 }); await atomicJSON(this.path(state.runId), state); }
  async exclusive<T>(action: () => Promise<T>) { if (this.busy) throw Error('A Growth update is in progress.'); this.busy = true; try { return await action(); } finally { this.busy = false; } }
  async context(id: string) {
    const run = await this.journal.load(id); if (!eligible(run)) throw Error('Launch and bind this business before using Growth.');
    const provider = this.provider(run); const state = await this.load(id);
    if (state.connection !== provider.identity()) {
      state.connection = provider.identity(); state.property = undefined; state.properties = undefined; state.sitemaps = undefined; state.performance = undefined; state.window = undefined; state.refreshedAt = undefined;
    }
    return { run, provider, state };
  }
  async sites(run: Run, provider: SearchProvider<M>) { return (await provider.sites()).filter(s => this.engine === 'bing' ? s.permissionLevel === 'verified' && bingCovers(s.siteUrl, run.config.domain) : readable(s) && covers(s.siteUrl, run.config.domain)); }
  async selected(run: Run, provider: SearchProvider<M>, state: GrowthState<M>) {
    const site = (await this.sites(run, provider)).find(s => s.siteUrl === state.property);
    if (!site) throw Error(`Selected property is unavailable. Refresh properties, verify ownership/access in ${this.name}, and select again.`);
    return site;
  }
  async select(id: string, property: string) {
    return this.exclusive(async () => {
      const { run, provider, state } = await this.context(id);
      const sites = await this.sites(run, provider);
      if (!sites.some(s => s.siteUrl === property)) throw Error('Select an accessible property covering this production hostname.');
      state.property = property; state.properties = { status: 'AVAILABLE', at: this.now().toISOString(), data: sites };
      state.sitemaps = undefined; state.performance = undefined; state.window = undefined; state.refreshedAt = undefined;
      await this.save(state); return state;
    });
  }
  reconcile(state: GrowthState<M>, maps: Sitemap[], at: string) {
    for (const action of state.submissions) if (action.property === state.property && ['INTENT', 'UNKNOWN', 'ACCEPTED'].includes(action.status) && maps.some(m => m.path === action.sitemap)) { action.status = 'OBSERVED'; action.observedAt = at; }
  }
  async refresh(id: string) {
    return this.exclusive(async () => {
      const { run, provider, state } = await this.context(id); const at = this.now().toISOString(); state.refreshedAt = at;
      try { state.properties = { status: 'AVAILABLE', at, data: await this.sites(run, provider) }; }
      catch (e: any) { state.properties = unknown(at, e.message); state.sitemaps = unknown(at, 'Property access could not be checked.'); state.performance = unknown(at, 'Property access could not be checked.'); await this.save(state); return state; }
      if (!state.property || !state.properties.data.some(s => s.siteUrl === state.property)) {
        state.property = undefined; state.sitemaps = unknown(at, 'Select an accessible property first.'); state.performance = unknown(at, 'Select an accessible property first.'); await this.save(state); return state;
      }
      state.window = this.engine === 'google' ? searchWindow(this.now()) : undefined;
      state.performance = unknown(at, 'Search metrics refresh has not completed. Refresh again to resume.');
      // Independent components preserve useful evidence when another API is unavailable.
      try { const maps = await provider.sitemaps(state.property); state.sitemaps = { status: 'AVAILABLE', at, data: maps }; this.reconcile(state, maps, at); }
      catch (e: any) { state.sitemaps = unknown(at, e.message); }
      await this.save(state);
      try { const metrics = await provider.performance(state.property, state.window || searchWindow(this.now())); state.performance = metrics ? { status: 'AVAILABLE', at: this.now().toISOString(), data: metrics } : { status: 'NO_DATA', at: this.now().toISOString(), message: `${this.name} returned no reporting rows. Traffic and indexing cannot be inferred.` }; }
      catch (e: any) { state.performance = unknown(this.now().toISOString(), e.message); }
      await this.save(state); return state;
    });
  }
  async prepare(id: string) {
    return this.exclusive(async () => {
      const { run, provider, state } = await this.context(id);
      if (!run.config.seo.approved || run.steps.seo.status !== 'VERIFIED') throw Error('Verify the existing M1 SEO/sitemap step before preparing submission.');
      const site = await this.selected(run, provider, state);
      if (!provider.writable() || !this.writable(site)) throw Error(this.engine === 'bing' ? 'Sitemap submission requires a Bing API key and verified site access.' : 'Sitemap submission requires Google sitemap management consent and owner/full-user property access.');
      const sitemap = `https://${run.config.domain}/sitemap.xml`;
      if (state.submissions.some(a => a.connection !== state.connection && a.property === site.siteUrl && a.sitemap === sitemap && ['INTENT', 'UNKNOWN', 'ACCEPTED'].includes(a.status))) throw Error('An earlier connection has an unresolved submission for this target. Refresh to reconcile its listing; reconnecting cannot authorize a duplicate attempt.');
      const prior = state.submissions.find(a => a.property === site.siteUrl && a.sitemap === sitemap && a.connection === state.connection && a.status !== 'DECLINED');
      if (!prior) {
        if (state.submissions.length >= 100) throw Error('Growth action history is full. Export and review the journal before adding more actions.');
        state.submissions.push({ id: randomUUID(), property: site.siteUrl, sitemap, connection: state.connection!, status: 'AWAITING_APPROVAL', createdAt: this.now().toISOString() });
      }
      await this.save(state); return state;
    });
  }
  async decide(id: string, approvalId: string, decision: string) {
    return this.exclusive(async () => {
      if (!['approved', 'denied'].includes(decision)) throw Error('Choose approve or decline.');
      const { run, provider, state } = await this.context(id);
      const action = state.submissions.find(a => a.id === approvalId);
      if (!action || action.connection !== provider.identity() || action.property !== state.property || action.sitemap !== `https://${run.config.domain}/sitemap.xml`) throw Error('This approval no longer matches the connection or selected target. Prepare it again.');
      if (decision === 'denied') { if (action.status !== 'AWAITING_APPROVAL') throw Error('This action has already been decided.'); action.status = 'DECLINED'; await this.save(state); return state; }
      if (action.status === 'DECLINED') throw Error('This action was declined. Prepare a new approval.');
      if (!run.config.seo.approved || run.steps.seo.status !== 'VERIFIED') throw Error('The verified M1 sitemap is required.');
      const site = await this.selected(run, provider, state);
      if (!provider.writable() || !this.writable(site)) throw Error(this.engine === 'bing' ? 'A Bing API key and verified site access are required.' : 'Sitemap management scope and owner/full-user property access are required.');
      const at = this.now().toISOString();
      const maps = await provider.sitemaps(action.property); state.sitemaps = { status: 'AVAILABLE', at, data: maps };
      if (action.status === 'AWAITING_APPROVAL') { action.approvedAt = at; }
      if (maps.some(m => m.path === action.sitemap)) { action.status = 'OBSERVED'; action.observedAt = at; await this.save(state); return state; }
      if (action.status !== 'AWAITING_APPROVAL') { if (action.status === 'INTENT') action.status = 'UNKNOWN'; await this.save(state); return state; }
      action.status = 'INTENT'; action.attemptedAt = at; await this.save(state);
      try { await provider.submit(action.property, action.sitemap); action.status = 'ACCEPTED'; }
      catch { action.status = 'UNKNOWN'; } // A transport/provider failure is never safe evidence to resubmit.
      await this.save(state);
      try { const after = await provider.sitemaps(action.property); state.sitemaps = { status: 'AVAILABLE', at: this.now().toISOString(), data: after }; this.reconcile(state, after, this.now().toISOString()); }
      catch { state.sitemaps = unknown(this.now().toISOString(), 'Submission recorded; provider observation is unavailable. Refresh to reconcile without resubmitting.'); }
      await this.save(state); return state;
    });
  }
  async report(id: string) {
    const run = await this.journal.load(id); const provider = this.provider(run); const state = await this.load(id);
    const connectionChanged = state.connection !== provider.identity();
    const visible = connectionChanged ? { ...state, property: undefined, properties: undefined, sitemaps: undefined, performance: undefined, window: undefined, refreshedAt: undefined } : state;
    const next: string[] = [];
    if (!provider.connected()) next.push(this.engine === 'bing' ? 'Connect your Bing Webmaster API key. Keys grant account-wide access; submissions still require exact approval.' : 'Connect Google with your Desktop OAuth client and approve read-only Search Console access.');
    else if (!visible.properties) next.push(`Refresh ${this.name} properties to discover existing verification.`);
    else if (visible.properties.status !== 'AVAILABLE') next.push(visible.properties.message);
    else if (!visible.properties.data.length) next.push(`No accessible property covers this hostname. Add/verify it in ${this.name} or obtain access, then refresh. No DNS or ownership changes were made.`);
    else if (!visible.property) next.push('Select an existing property, then refresh search evidence.');
    if (visible.sitemaps?.status === 'AVAILABLE') {
      if (!visible.sitemaps.data.some(m => m.path === `https://${run.config.domain}/sitemap.xml`)) next.push('The M1 sitemap is absent from this property listing. Prepare its exact submission for approval if SEO is verified.');
      if (visible.sitemaps.data.some(m => (m.errors || 0) > 0 || (m.warnings || 0) > 0)) next.push('Google reports sitemap errors or warnings. Inspect the sitemap report in Search Console before proposing changes.');
      if (visible.sitemaps.data.some(m => m.isPending)) next.push('Google is still processing a sitemap. Refresh later; submission does not guarantee indexing.');
    } else if (visible.sitemaps) next.push(visible.sitemaps.message);
    if (visible.performance && visible.performance.status !== 'AVAILABLE') next.push(visible.performance.message);
    if (state.submissions.some(a => ['INTENT', 'UNKNOWN'].includes(a.status))) next.push(`A submission outcome is unknown. Select its property and refresh to reconcile, or inspect ${this.name}; LaunchKit will not resubmit it automatically.`);
    if (this.engine === 'bing' && visible.sitemaps?.status === 'AVAILABLE' && visible.sitemaps.data.some(m => m.providerStatus && m.providerStatus !== 'Success')) next.push('Review Bing sitemap processing status in Webmaster Tools. Listing and URL counts do not prove indexing.');
    return { ...visible, eligible: eligible(run), sitemapReady: run.config.seo.approved && run.steps.seo.status === 'VERIFIED', simulated: run.config.mode === 'mock', connected: provider.connected(), writable: provider.writable(), connectionChanged, domain: run.config.domain, generatedAt: this.now().toISOString(), stale: !visible.refreshedAt || this.now().getTime() - Date.parse(visible.refreshedAt) > 86_400_000, nextActions: next,
      indexing: 'UNAVAILABLE — URL indexing inspection is not implemented. Sitemap processing is not indexing.',
      measurement: this.engine === 'bing' ? 'Bing-reported daily rows across Web, Chat, News, Images, Videos and Knowledge Panel. Provider-selected dates are shown as UTC instants; no requested window or completeness guarantee. No separate AI visibility, visitors or ranking estimates.' : 'Google-reported final web-search aggregates for the selected property, which may cover other subdomains/protocols. Dates use Pacific Time. No traffic, referral, ranking-change or AI-discovery estimates.',
      propertyURL: this.engine === 'bing' ? 'https://www.bing.com/webmasters/' : `https://search.google.com/search-console${visible.property ? `?resource_id=${encodeURIComponent(visible.property)}` : ''}` };
  }
}

export class MockSearch implements SearchProvider {
  domain: string; maps: Sitemap[] = [];
  constructor(domain: string) { this.domain = domain; }
  identity() { return `simulation:${this.domain}`; }
  connected() { return true; }
  writable() { return true; }
  async sites() { return [{ siteUrl: `https://${this.domain}/`, permissionLevel: 'siteOwner' }]; }
  async sitemaps() { return this.maps; }
  async performance() { return { clicks: 12, impressions: 240, ctr: 0.05, position: 8.5 }; }
  async submit(_site: string, sitemap: string) { this.maps = [{ path: sitemap, isPending: true, errors: 0, warnings: 0 }]; }
}
