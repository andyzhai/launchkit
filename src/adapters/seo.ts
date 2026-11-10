import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchConfig } from '../workflow/types.ts';
export const escapeHTML = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;');
export async function seo(dir: string, config: LaunchConfig) {
  if (!config.seo.approved) return;
  const base = `https://${config.domain}`;
  let html = await readFile(join(dir, 'index.html'), 'utf8');
  // Only the approved entry page is advertised. No invented business facts or structured data.
  html = html.replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '').replace(/<meta\b[^>]*property=["']og:url["'][^>]*>/gi, '');
  if (config.seo.description) html = html.replace(/<meta\b[^>]*(?:property=["']og:description["']|name=["']description["'])[^>]*>/gi, '');
  if (config.seo.title) {
    html = html.replace(/<meta\b[^>]*property=["']og:title["'][^>]*>/gi, '');
    const title = `<title>${escapeHTML(config.seo.title)}</title>`;
    html = /<title>/i.test(html) ? html.replace(/<title>[\s\S]*?<\/title>/i, title) : html.replace('</head>', `${title}</head>`);
  }
  const tags = [`<link rel="canonical" href="${base}/">`, `<meta property="og:url" content="${base}/">`];
  if (config.seo.title) tags.push(`<meta property="og:title" content="${escapeHTML(config.seo.title)}">`);
  if (config.seo.description) tags.push(`<meta name="description" content="${escapeHTML(config.seo.description)}">`, `<meta property="og:description" content="${escapeHTML(config.seo.description)}">`);
  html = html.replace('</head>', `${tags.join('\n')}\n</head>`);
  await writeFile(join(dir, 'index.html'), html);
  await writeFile(join(dir, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /__launchkit/\nSitemap: ${base}/sitemap.xml\n`);
  await writeFile(join(dir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url></urlset>\n`);
}
