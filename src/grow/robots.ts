// Official identities and purpose reviewed 2026-10-29; sources and supported
// REP subset are recorded in docs/grow-discoverability.md. No bot impersonation.
export const crawlers = [
  { token: 'Googlebot', purpose: 'SEARCH' },
  { token: 'bingbot', purpose: 'SEARCH' },
  { token: 'OAI-SearchBot', purpose: 'SEARCH' },
  { token: 'Claude-SearchBot', purpose: 'SEARCH' },
  { token: 'PerplexityBot', purpose: 'SEARCH' },
  { token: 'GPTBot', purpose: 'TRAINING' },
  { token: 'ClaudeBot', purpose: 'TRAINING' }
] as const;
export type PolicyState = 'ALLOWED' | 'BLOCKED' | 'INDETERMINATE' | 'UNAVAILABLE';
interface Rule { allow: boolean; path: string; line: number }
interface Group { agents: string[]; rules: Rule[] }
export interface Policy { state: PolicyState; evidence: string }

// Deliberately evaluates only the exact homepage path. Unsupported syntax is
// uncertainty, never permission. This helper cannot fetch arbitrary URLs.
export function homepagePolicy(body: string, token: string): Policy {
  const uncertain = (evidence: string): Policy => ({ state: 'INDETERMINATE', evidence });
  const lines = body.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  if (lines.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(body)) return uncertain('Robots text exceeds parsing limits or contains invalid text.');
  const groups: Group[] = []; let group: Group | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#')[0].trim(); if (!line) continue;
    const field = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!field) return uncertain(`Malformed robots line ${i + 1}; group interpretation requires review.`);
    const key = field[1].toLowerCase(), value = field[2].trim();
    if (key === 'user-agent') {
      if (!/^(\*|[a-z_-]+)$/i.test(value)) return uncertain(`Unsupported user-agent on line ${i + 1}; use an exact product token.`);
      if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!group) return uncertain(`Rule without a user-agent on line ${i + 1}.`);
      group.rules.push({ allow: key === 'allow', path: value, line: i + 1 });
    }
    // Non-REP fields (including Sitemap and Crawl-delay) do not form groups.
  }
  const agent = token.toLowerCase();
  const exact = groups.filter(g => g.agents.includes(agent));
  // An exact product-token match is already the most specific group. Shorter
  // names cannot make that result ambiguous (Google REP precedence / RFC 9309
  // exact-group merging). Without an exact match, provider-specific partial
  // matching remains outside this evaluator rather than guessed as permission.
  if (!exact.length && groups.some(g => g.agents.some(a => a !== '*' && agent.includes(a)))) return uncertain('Partial product-token matching without an exact group is not evaluated; review the relevant groups manually.');
  const selected = exact.length ? exact : groups.filter(g => g.agents.includes('*'));
  const rules = selected.flatMap(g => g.rules).filter(r => r.path !== '');
  // Percent normalization, non-ASCII paths and malformed expressions are outside
  // this small evaluator. Even an apparently unrelated unsupported rule is not guessed.
  if (rules.some(r => r.path.length > 500 || !r.path.startsWith('/') || /[^\x21-\x7e]|[%\\]/.test(r.path) || /\$(?!$)/.test(r.path))) return uncertain('Selected group contains an unsupported path (encoding, syntax or length); no permission inferred.');
  const matches = rules.filter(r => {
    const anchored = r.path.endsWith('$');
    const path = anchored ? r.path.slice(0, -1) : r.path;
    // On '/', a rule can match only a single slash and optional wildcards.
    // This avoids building regular expressions from untrusted policy text.
    return /^\/\**$/.test(path);
  });
  const specificity = (r: Rule) => r.path.replace(/\*+$/, '').length;
  matches.sort((a, b) => specificity(b) - specificity(a) || Number(b.allow) - Number(a.allow));
  const winner = matches[0];
  const groupLabel = exact.length ? `${exact.length} exact ${token} group(s), merged; wildcard groups excluded` : `${selected.length} wildcard group(s)`;
  return { state: winner && !winner.allow ? 'BLOCKED' : 'ALLOWED', evidence: `${groupLabel}. Homepage /: ${winner ? `line ${winner.line}, ${winner.allow ? 'Allow' : 'Disallow'}: ${winner.path}` : 'no matching nonempty rule'}. Policy only; actual crawler retrieval is untested.` };
}
