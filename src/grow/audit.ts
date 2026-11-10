import { lookup } from 'node:dns/promises';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicAddress } from '../operate/health.ts';
import { eligible } from '../operate/operator.ts';
import { hostname } from '../security/config.ts';
import { Journal, atomicJSON } from '../workflow/journal.ts';
import { redact } from '../security/redaction.ts';
import { crawlers, homepagePolicy, type PolicyState } from './robots.ts';
import { readPublicPage, type AuditPath, type PublicPage, type Address } from './public.ts';
import { renderHomepage, type RenderedPage } from './render.ts';

type Path = AuditPath;
export type { PublicPage } from './public.ts';
export interface AuditTools {
  resolve(domain: string): Promise<{ address: string; family: number }[]>;
  read(domain: string, path: Path, address: { address: string; family: number }): Promise<PublicPage>;
  render?(domain: string, homepage: PublicPage, address: Address): Promise<RenderedPage>;
}
export interface Finding {
  check: string; url: string; at: string; status: 'OBSERVED' | 'REVIEW' | 'UNAVAILABLE'; evidence: string; action?: string;
  priority?: 'P1' | 'P2' | 'P3'; why?: string;
  crawler?: string; purpose?: 'SEARCH' | 'TRAINING'; policy?: PolicyState;
  source?: 'STATIC_HTML' | 'RENDERED_PAGE' | 'ROBOTS_POLICY' | 'PUBLIC_ENDPOINT';
  assessment?: boolean;
}
interface AuditState { schema: 1; inspectionVersion?: 2; runId: string; at: string; findings: Finding[] }
export const publicAuditTools: AuditTools = {
  async resolve(domain) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([lookup(domain, { all: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('DNS deadline')), 10_000); })]); }
    finally { clearTimeout(timer); }
  },
  read: readPublicPage,
  render: renderHomepage
};
function attrs(tag: string) {
  const result: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[m[1].toLowerCase()] ??= m[2] ?? m[3] ?? m[4];
  return result;
}
const clip = (s: string) => redact(s).replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
function crawlerFindings(domain: string, at: string, body?: string): Finding[] {
  return crawlers.map(({ token, purpose }) => {
    const policy = body === undefined ? { state: 'UNAVAILABLE' as const, evidence: 'No usable robots.txt response; no permission inferred.' } : homepagePolicy(body, token);
    const issue = policy.state !== 'ALLOWED';
    return { check: `crawler-policy:${token}`, crawler: token, purpose, policy: policy.state, source: 'ROBOTS_POLICY',
      url: `https://${domain}/robots.txt`, at,
      status: policy.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : policy.state === 'INDETERMINATE' || (policy.state === 'BLOCKED' && purpose === 'SEARCH') ? 'REVIEW' : 'OBSERVED',
      priority: issue && purpose === 'SEARCH' ? 'P1' : 'P3', evidence: clip(policy.evidence),
      why: purpose === 'SEARCH' ? 'A robots restriction may limit discovery of the homepage by this search crawler. Permission does not prove retrieval, indexing or citation.' : 'This is a model-training control, separate from search access; a training block is not a search defect.',
      ...(issue && purpose === 'SEARCH' ? { action: 'Review this bot’s homepage rules in robots.txt and confirm owner intent before proposing any change.' } : policy.state === 'INDETERMINATE' || policy.state === 'UNAVAILABLE' ? { action: 'Inspect robots.txt to confirm the intended training policy separately from search access.' } : {}) };
  });
}
export function inspectRendered(domain: string, page: RenderedPage, at: string): Finding[] {
  const url = `https://${domain}/`;
  const base = { url, at, source: 'RENDERED_PAGE' as const };
  if (page.status !== 'AVAILABLE') return [{ ...base, check: 'rendered-content', status: 'UNAVAILABLE', priority: 'P1',
    evidence: 'Rendered-page inspection unavailable or incomplete. Static HTML has not been substituted for rendered product evidence.',
    why: 'Without a completed browser observation, content rendered by JavaScript cannot be assessed.', action: 'Check browser availability and the bounded rendering restrictions, then retry the explicit audit.' }];
  // Runtime fallback instructions are not product-purpose or product-limit claims.
  const fallback = /\b(?:enable|disable|requires?|required|need|turn (?:on|off))\b.*\bjavascript\b|\bjavascript\b.*\b(?:enable|disable|required|requires?|need|turned (?:on|off))\b/i;
  const text = (page.text || '').slice(0, 12_000).split(/\n|(?<=[.!?])\s+/).filter(s => !fallback.test(s)).join('\n');
  const heading = (page.headings || []).filter(h => h.level === 1 && !fallback.test(h.text)).map(h => h.text);
  const candidates = (pattern: RegExp) => text.split(/\n|(?<=[.!?])\s+/).find(s => pattern.test(s));
  const purposePattern = /\b(?:helps? .{1,100}|(?:tool|app|application|service|software) (?:to|for)|(?:redact(?:s|ing)?|edit(?:s|ing)?|convert(?:s|ing)?|creat(?:e|es|ing)|manag(?:e|es|ing)|remov(?:e|es|ing)|protect(?:s|ing)?|shar(?:e|es|ing)|build(?:s|ing)?)\s+\w+)/i;
  const limitationPattern = /\b(?:limitations?|cannot|can't|does not|doesn't|not (?:support|suitable|intended)|only supports?|requires?|required|must|unsupported)\b/i;
  const bodyPurpose = text.split(/\n|(?<=[.!?])\s+/).find(s => purposePattern.test(s) && !limitationPattern.test(s));
  const descriptionPurpose = !fallback.test(page.description || '') && !limitationPattern.test(page.description || '') && purposePattern.test(page.description || '') ? page.description : undefined;
  const fields = [
    { name: 'product-name', candidate: heading.length === 1 ? heading[0] : undefined, method: 'Exactly one visible H1', action: 'Confirm the observed heading and page title name the product consistently; a task heading alone may not identify it.', why: 'Consistent product naming can help readers distinguish the application.' },
    { name: 'purpose', candidate: bodyPurpose || descriptionPurpose, method: `English purpose phrase heuristic (${bodyPurpose ? 'visible body text' : descriptionPurpose ? 'rendered meta description' : 'visible body text and rendered description'})`, action: 'Review the observed page text and confirm which sentence accurately explains what the product does.', why: 'A concrete purpose helps readers assess what the application offers.' },
    { name: 'audience', candidate: candidates(/\b(?:designed|built|intended|made) for\b|\b(?:for (?:people|teams|users|businesses|developers|students|professionals)|who need)\b/i), method: 'English audience phrase heuristic', action: 'Confirm who the product is intended for; if unclear in the rendered page, propose a factual audience sentence.', why: 'An explicit intended audience helps readers assess suitability.' },
    { name: 'limitations', candidate: candidates(limitationPattern), method: 'English limitation phrase heuristic (visible body text)', action: 'Check the rendered page for important limits and requirements; propose only limitations the owner can verify.', why: 'Clear constraints help prevent unsupported expectations about capabilities.' }
  ];
  const observations: Finding[] = [
    { ...base, check: 'rendered-metadata', status: 'OBSERVED', priority: 'P3', evidence: clip(`Browser title: “${clip(page.title || '').slice(0, 180)}”; description: “${clip(page.description || '').slice(0, 220)}”. These are observed DOM values, not validated claims.`) },
    { ...base, check: 'rendered-headings', status: 'OBSERVED', priority: 'P3', evidence: clip((page.headings || []).slice(0, 6).map(h => `H${h.level}: “${clip(h.text).slice(0, 120)}”`).join('; ') || 'No visible H1–H3 headings observed in this browser snapshot.') },
    { ...base, check: 'rendered-content', status: 'OBSERVED', priority: 'P3', evidence: clip(`${(page.text || '').length} characters of visible text sampled. Product-text excerpt: “${clip(text).slice(0, 240)}”. Runtime JavaScript fallback instructions excluded from product assessments.`) },
    { ...base, check: 'rendered-coverage', status: 'OBSERVED', priority: 'P3', evidence: `Restricted browser snapshot: ${page.blocked || 0} intercepted requests blocked; ${page.scriptErrors || 0} script errors; text truncated: ${!!page.truncated}. Images, fonts, third-party resources, APIs, workers and frames are not loaded. A bounded snapshot is not proof the entire page finished rendering.` }
  ];
  return [...observations, ...fields.map((f): Finding => ({ ...base, check: `content-${f.name}`, status: 'REVIEW', priority: 'P2', assessment: true, why: f.why, action: f.action,
    evidence: clip(`${f.method}: ${f.candidate ? `candidate excerpt “${clip(f.candidate).slice(0, 220)}”` : `no unambiguous candidate in the sampled rendered text (${text.length} characters)`}. Human review required; heuristics do not establish accuracy, clarity or AI comprehension. Missing candidates do not prove content is absent.`) }))];
}
export function inspectPage(domain: string, path: Path, page: PublicPage, at: string): Finding[] {
  const url = `https://${domain}${path}`; const findings: Finding[] = [];
  const add = (check: string, status: Finding['status'], evidence: string, action?: string) => findings.push({ check, status, url, at, source: path === '/' ? 'STATIC_HTML' : 'PUBLIC_ENDPOINT', evidence: clip(evidence), priority: status === 'UNAVAILABLE' ? 'P1' : status === 'REVIEW' ? 'P2' : 'P3',
    why: check === 'indexing-directives' ? 'Response directives can restrict indexing or snippets; actual index status is unmeasured.' : check === 'canonical' ? 'A consistent canonical URL helps identify the preferred public page.' : check.includes('sitemap') ? 'Sitemap declarations help crawlers discover public URLs; they do not prove indexing.' : 'Returned public HTML and endpoint responses are evidence readers and crawlers may encounter.', ...(action ? { action } : {}) });
  if (page.status !== 200) { add('http', 'UNAVAILABLE', `HTTP ${page.status}; redirects are not followed.`, 'Review this public endpoint before proposing a change.'); if (path === '/robots.txt') findings.push(...crawlerFindings(domain, at)); return findings; }
  if (path === '/') {
    if (!/^text\/html\b/i.test(page.type)) { add('html', 'UNAVAILABLE', 'Homepage did not return text/html.', 'Review the homepage Content-Type and confirm it serves the intended public HTML.'); return findings; }
    // Static source inspection, not a browser DOM or a complete HTML validator.
    const html = page.body.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] || '';
    const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(m => attrs(m[0]));
    const canonical = links.filter(a => a.rel?.toLowerCase().split(/\s+/).includes('canonical')).map(a => a.href || '');
    const correct = canonical.length === 1 && canonical[0] === url;
    add('canonical', correct ? 'OBSERVED' : 'REVIEW', canonical.length ? `Static head canonical values: ${canonical.map(clip).join(', ')}` : 'No canonical link found in the static head.', correct ? undefined : 'Review the preferred canonical URL and approve any metadata change through the launch workflow.');
    const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map(m => attrs(m[0]));
    const directives = metas.filter(a => /^(robots|googlebot|bingbot)$/i.test(a.name || '')).map(a => `${a.name}: ${a.content || ''}`);
    if (page.robots) directives.push(`X-Robots-Tag: ${page.robots}`);
    const restrictive = directives.some(d => /\b(noindex|none|nosnippet|nofollow)\b/i.test(d));
    add('indexing-directives', restrictive ? 'REVIEW' : 'OBSERVED', directives.length ? clip(directives.join('; ')) : 'No robots meta or X-Robots-Tag observed in this static response.', restrictive ? 'Review whether these restrictions are intentional. Their presence is not proof of index status.' : undefined);
    const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.trim();
    const description = metas.find(a => a.name?.toLowerCase() === 'description')?.content?.trim();
    add('metadata', title && description ? 'OBSERVED' : 'REVIEW', `Initial HTML title: “${clip(title || '').slice(0, 180)}”; description: “${clip(description || '').slice(0, 220)}”.`, title && description ? undefined : 'Review factual title and description in website preferences before approving publication.');
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] || '';
    const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    add('public-content', 'OBSERVED', `${text.length} characters of initial HTML body text after removing tags, scripts, styles and templates; this may include noscript fallback text. Not product-content evidence and not a rendering result.`);
  } else if (path === '/robots.txt') {
    if (!/^text\/plain\b/i.test(page.type)) { add('robots', 'UNAVAILABLE', 'Expected text/plain for robots.txt; no crawl permission inferred.', 'Review the robots.txt endpoint response.'); findings.push(...crawlerFindings(domain, at)); return findings; }
    const lines = page.body.split(/\r?\n/).map(l => l.split('#')[0].trim()).filter(l => /^(user-agent|allow|disallow|sitemap)\s*:/i.test(l));
    add('robots-directives', 'OBSERVED', lines.length ? `Observed directives (first 40, original order): ${clip(lines.slice(0, 40).join('; '))}` : 'No recognized robots directives observed.');
    const sitemap = `https://${domain}/sitemap.xml`;
    const listed = lines.some(l => /^sitemap\s*:/i.test(l) && l.slice(l.indexOf(':') + 1).trim() === sitemap);
    add('robots-sitemap', listed ? 'OBSERVED' : 'REVIEW', listed ? `Sitemap directive includes ${sitemap}.` : 'The production sitemap URL was not found in a Sitemap directive.', listed ? undefined : 'Review the approved M1 sitemap configuration before changing robots.txt.');
    findings.push(...crawlerFindings(domain, at, page.body));
  } else {
    if (!/^(application|text)\/xml\b/i.test(page.type) || /<!DOCTYPE|<!ENTITY/i.test(page.body)) { add('sitemap', 'UNAVAILABLE', 'Unsupported sitemap representation; XML with DTDs/entities is not inspected.', 'Review sitemap Content-Type and XML format against the approved sitemap configuration.'); return findings; }
    const xml = page.body.replace(/<!--[\s\S]*?-->/g, '');
    const root = /<(urlset|sitemapindex)\b[^>]*>/i.exec(xml)?.[1]?.toLowerCase();
    const locs = [...xml.matchAll(/<loc\s*>([^<]*)<\/loc\s*>/gi)].map(m => m[1].trim());
    const hasHome = locs.includes(`https://${domain}/`);
    add('sitemap', root && locs.length ? 'OBSERVED' : 'REVIEW', `Static XML scan: root ${root || 'unrecognized'}; ${locs.length} loc elements; homepage present: ${hasHome}. This is not XML schema validation or indexing evidence.`, root === 'sitemapindex' ? 'Child sitemaps were not fetched; review them in your provider.' : !hasHome ? 'Review homepage inclusion in the approved sitemap.' : undefined);
  }
  return findings;
}
export class Discoverability {
  journal: Journal; tools: AuditTools; now: () => Date; busy = false;
  constructor(journal: Journal, tools = publicAuditTools, now = () => new Date()) { this.journal = journal; this.tools = tools; this.now = now; }
  path(id: string) { this.journal.path(id); return join(this.journal.dir, 'grow-audit', `${id}.json`); }
  async report(id: string) {
    const run = await this.journal.load(id); let state: AuditState | undefined;
    try { state = JSON.parse(await readFile(this.path(id), 'utf8')); if (state?.schema !== 1 || state.runId !== id) throw Error('Unsupported audit journal'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const legacy = state && state.inspectionVersion !== 2;
    const findings = state && legacy ? [...state.findings.filter(f => !f.check.startsWith('content-')), ...inspectRendered(run.config.domain, { status: 'UNAVAILABLE' }, state.at)] : state?.findings || [];
    return { runId: id, domain: run.config.domain, eligible: eligible(run), simulated: run.config.mode === 'mock', at: state?.at, findings, stale: !state?.at || !!legacy || this.now().getTime() - Date.parse(state.at) > 86_400_000,
      limits: 'Read-only initial HTML and restricted JavaScript-rendered homepage evidence are separate. Rendering uses only bounded same-host /assets/ JavaScript and CSS; APIs, third parties, workers, frames and other navigation are blocked. Missing candidates do not prove absent content. Product assessments are heuristic REVIEW suggestions, not semantic verification. Crawler policies apply only to homepage /, not actual retrieval. No indexing, training or AI citation measurement; public changes require separate approval.' };
  }
  async refresh(id: string) {
    if (this.busy) throw Error('An audit is in progress.'); this.busy = true;
    try {
      const run = await this.journal.load(id); if (!eligible(run)) throw Error('Select a bound production business before auditing.');
      const domain = hostname(run.config.domain); const at = this.now().toISOString(); const findings: Finding[] = [];
      let homepage: PublicPage | undefined;
      let address: { address: string; family: number } | undefined;
      if (run.config.mode === 'live') {
        try { const addresses = await this.tools.resolve(domain); if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error(); address = addresses.find(a => a.family === 4) || addresses[0]; }
        catch { findings.push({ check: 'public-dns', url: `https://${domain}/`, at, status: 'UNAVAILABLE', priority: 'P1', evidence: 'DNS unavailable or non-public address returned. No public requests made.', why: 'Public evidence could not be safely retrieved.', action: 'Review production DNS before retrying the audit.' }, ...crawlerFindings(domain, at)); }
      }
      if (run.config.mode === 'mock' || address) for (const path of ['/', '/robots.txt', '/sitemap.xml'] as const) {
        try {
          const page = run.config.mode === 'mock' ? mockPage(domain, path) : await this.tools.read(domain, path, address!);
          if (path === '/' && page.status === 200 && /^text\/html\b/i.test(page.type)) homepage = page;
          findings.push(...inspectPage(domain, path, page, this.now().toISOString()));
        } catch { const failedAt = this.now().toISOString(); findings.push({ check: 'fetch', url: `https://${domain}${path}`, at: failedAt, status: 'UNAVAILABLE', priority: 'P1', evidence: 'HTTPS read failed, timed out, or exceeded the 512 KB audit limit. No content retained.', why: 'This endpoint could not be measured independently.', action: 'Review this endpoint and retry the read-only audit.' }); if (path === '/robots.txt') findings.push(...crawlerFindings(domain, failedAt)); }
      }
      let rendered: RenderedPage = { status: 'UNAVAILABLE' };
      if (run.config.mode === 'mock') rendered = { status: 'AVAILABLE', title: 'Simulated business', description: 'Synthetic product information.', headings: [{ level: 1, text: 'Simulated business' }], text: 'A tool for creating sample reports.\nDesigned for small teams.\nOnly supports sample data.' };
      else if (homepage && address && this.tools.render) {
        try { rendered = await this.tools.render(domain, homepage, address); }
        catch { /* Fixed unavailable evidence below; never expose browser errors. */ }
      }
      findings.push(...inspectRendered(domain, rendered, this.now().toISOString()));
      await mkdir(join(this.journal.dir, 'grow-audit'), { recursive: true, mode: 0o700 });
      await atomicJSON(this.path(id), { schema: 1, inspectionVersion: 2, runId: id, at, findings } satisfies AuditState);
      return this.report(id);
    } finally { this.busy = false; }
  }
}
function mockPage(domain: string, path: Path): PublicPage {
  return path === '/' ? { status: 200, type: 'text/html', body: `<html><head><title>Simulation</title><meta name="description" content="Simulated business"><link rel="canonical" href="https://${domain}/"></head><body><h1>Simulated business</h1></body></html>` } : path === '/robots.txt' ? { status: 200, type: 'text/plain', body: `User-agent: *\nAllow: /\nSitemap: https://${domain}/sitemap.xml` } : { status: 200, type: 'application/xml', body: `<urlset><url><loc>https://${domain}/</loc></url></urlset>` };
}
