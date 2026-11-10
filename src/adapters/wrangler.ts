import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './process.ts';
import { metricHTML, pageScript } from './analytics.ts';
import { Cloudflare, APIError } from './cloudflare.ts';
import { Pause, type Context, type LaunchConfig } from '../workflow/types.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
export function workerSource(config: LaunchConfig, release: string, analyticsToken?: string, headers: Record<string, string> = {}) {
  const settings = JSON.stringify({ domain: config.domain, www: config.www, release, headers, analytics: config.analytics.approved && !!analyticsToken, paths: config.analytics.publicPaths,
    pageJS: pageScript(config.domain, config.analytics.publicPaths), metrics: analyticsToken ? metricHTML(analyticsToken) : '' });
  return `const config=${settings};
export default {async fetch(request,env){
 const url=new URL(request.url); const production=url.hostname===config.domain;
 if(url.protocol==='http:'){url.protocol='https:';return Response.redirect(url.toString(),301);}
 if(config.www&&url.hostname==='www.'+config.domain){url.hostname=config.domain;return Response.redirect(url.toString(),301);}
 const base={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-LaunchKit-Release':config.release};
 if(url.pathname==='/robots.txt'&&!production)return new Response('User-agent: *\\nDisallow: /\\n',{headers:{...base,'Content-Type':'text/plain','X-Robots-Tag':'noindex, nofollow'}});
 if(url.pathname==='/__launchkit/page.js')return new Response(config.analytics?config.pageJS:'',{headers:{...base,'Content-Type':'text/javascript','Cache-Control':'no-store','X-Robots-Tag':'noindex'}});
 const match=url.pathname.match(/^\\/__launchkit\\/metrics\\/(\\d+)$/);
 if(match){
  if(!production||!config.analytics||url.search||Number(match[1])>=config.paths.length)return new Response('Not found',{status:404,headers:base});
  return new Response(config.metrics,{headers:{...base,'Content-Type':'text/html','Cache-Control':'no-store, no-transform','X-Robots-Tag':'noindex','Content-Security-Policy':"default-src 'none'; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com; frame-ancestors 'self'; sandbox allow-scripts"}});
 }
 let response=await env.ASSETS.fetch(request);response=new Response(response.body,response);
 if(!production||config.analytics){const cache=response.headers.get('Cache-Control');response.headers.set('Cache-Control',cache?cache+', no-transform':'public, no-transform');}
 for(const [k,v] of Object.entries({...config.headers,...base}))response.headers.set(k,v);
 if(!production)response.headers.set('X-Robots-Tag','noindex, nofollow');
 return response;
}};\n`;
}
export async function wranglerConfig(ctx: Context, dir: string) {
  const r = ctx.run.resources; const work = join(dirname(dir), 'worker'); await mkdir(work, { recursive: true, mode: 0o700 });
  const headers: Record<string, string> = {};
  try { for (const line of (await readFile(join(dir, '_headers'), 'utf8')).split(/\r?\n/)) { const m = line.match(/^\s+(Content-Security-Policy|Referrer-Policy|X-Content-Type-Options): (.+)$/i); if (m) headers[m[1]] = m[2]; } } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  await writeFile(join(work, 'worker.js'), workerSource(ctx.run.config, r.release, r.analytics?.site_token, headers));
  const path = join(work, 'wrangler.json');
  await writeFile(path, JSON.stringify({ name: r.worker, account_id: ctx.run.config.accountId, main: './worker.js', compatibility_date: '2026-10-27', workers_dev: true, preview_urls: false,
    assets: { directory: dir, binding: 'ASSETS', run_worker_first: true, not_found_handling: 'none' }, observability: { enabled: false } }, null, 2));
  return path;
}
export interface DeploymentTools {
  command: typeof command;
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}
export async function deploy(ctx: Context, cf: Cloudflare, dir: string, tools: DeploymentTools = {
  command, fetch, sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const r = ctx.run.resources; r.worker = `lk-${ctx.run.id}`;
  const subdomain = await cf.get(cf.account('/workers/subdomain'));
  if (!subdomain?.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain)) throw new Pause('WAITING_USER', 'Complete Cloudflare Workers account onboarding and choose an account subdomain.');
  const url = `https://${r.worker}.${subdomain.subdomain}.workers.dev`;
  const deploymentPath = cf.account(`/workers/scripts/${r.worker}/deployments`);
  const inspectDeployments = async () => {
    try {
      const result = await cf.get(deploymentPath);
      if (!Array.isArray(result?.deployments)) throw Error('Cloudflare returned an invalid deployment list');
      return result;
    } catch (error) {
      // A nonexistent script is expected on first launch, and may remain
      // temporarily invisible immediately after Wrangler creates it.
      if (error instanceof APIError && error.status === 404 && error.codes.length === 1 && error.codes[0] === 10007) return undefined;
      throw error;
    }
  };
  const inspectPreview = async () => {
    try {
      const response = await tools.fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      const matches = response.ok && response.headers.get('x-launchkit-release') === r.release;
      await response.body?.cancel(); return matches;
    } catch { return false; }
  };
  let deployments = await inspectDeployments();
  let visible = await inspectPreview();
  const operationKey = `deploy:${r.release}`;
  const prior = ctx.run.operations[operationKey];
  const submitted = prior?.status === 'INTENT' || prior?.status === 'OBSERVED' || r.deployedRelease === r.release;
  if (!visible && !submitted) {
    const existing = deployments?.deployments?.[0];
    if (existing && r.deployedRelease !== r.release) await ctx.approve('deployment', { worker: r.worker, beforeDeploymentId: existing.id, newRelease: r.release, domain: ctx.run.config.domain, action: 'Update an existing Worker deployment' });
    const path = await wranglerConfig(ctx, dir);
    await ctx.effect(operationKey, { deploymentId: existing?.id || null }, async () => {
      await tools.command(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', path, '--no-autoconfig'], dirname(path), { CLOUDFLARE_API_TOKEN: cf.credentials.cloudflare!, CLOUDFLARE_ACCOUNT_ID: cf.accountId, WRANGLER_SEND_METRICS: 'false' }, 600_000);
      return { submitted: true, release: r.release };
    });
    deployments = undefined; visible = false;
  }
  r.previewUrl = url; await ctx.save();
  // Both the control plane and public edge must observe the release. An
  // unresolved submission is reconciled here on resume, never redeployed.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await tools.sleep([250, 1000, 2000][attempt - 1]);
    if (attempt || !deployments) deployments = await inspectDeployments();
    if (attempt || !visible) visible = await inspectPreview();
    const deploymentId = deployments?.deployments?.[0]?.id;
    if (typeof deploymentId === 'string' && deploymentId && visible) {
      r.deployedRelease = r.release; r.deploymentId = deploymentId;
      if (ctx.run.operations[operationKey]?.status === 'INTENT') {
        ctx.run.operations[operationKey] = { ...ctx.run.operations[operationKey], status: 'OBSERVED', result: { reconciled: true, release: r.release, deploymentId } };
      }
      await ctx.save(); return { url, worker: r.worker, deploymentId, releaseVerified: true };
    }
  }
  throw new Pause('WAITING_PROVIDER', 'Wrangler deployment is awaiting Cloudflare propagation. LaunchKit will recheck the deployment record and public release without creating another Worker.', { endpoint: `GET ${deploymentPath}`, url, release: r.release });
}
