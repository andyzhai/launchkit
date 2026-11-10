const secrets = new Set<string>();
export function registerSecret(value: string) { if (value.length >= 4) secrets.add(value); }
export function containsKnownSecret(value: string) { return [...secrets].some(secret => value.includes(secret)); }
export function redact(value: unknown): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/\b(re_[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9_-]{15,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|api[_-]?token|password|authorization|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, '$1[REDACTED]');
}
export function clean<T>(value: T): T { return JSON.parse(redact(JSON.stringify(value))) as T; }
