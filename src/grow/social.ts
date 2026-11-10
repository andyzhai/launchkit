import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Journal, atomicJSON, digest } from '../workflow/journal.ts';
import type { Run } from '../workflow/types.ts';
import { eligible } from '../operate/operator.ts';
import { validateText, validateLength, type SocialProvider, type SocialAccount, type Publication, type Visibility } from './mastodon.ts';

interface Approval { id: string; hash: string; connection: string; account: SocialAccount; revision: number; at: string; status: 'PENDING' | 'INVALIDATED' | 'DECLINED' | 'APPROVED'; decidedAt?: string }
export interface Draft {
  id: string; text: string; visibility: Visibility; createdAt: string; updatedAt: string;
  status: 'DRAFT' | 'AWAITING_APPROVAL' | 'DECLINED' | 'INTENT' | 'UNKNOWN' | 'ACCEPTED' | 'OBSERVED';
  approvals: Approval[]; attemptedAt?: string; publication?: Publication; observedAt?: string; reconciledAt?: string; message?: string;
}
interface SocialState { schema: 1; runId: string; drafts: Draft[]; connection?: string; account?: SocialAccount; checkedAt?: string }
const sent = (d: Draft) => ['INTENT', 'UNKNOWN', 'ACCEPTED', 'OBSERVED'].includes(d.status);
const destination = (a: SocialAccount) => [a.id, a.username, a.url];
const contentHash = (d: Draft, a: SocialAccount) => digest([destination(a), d.text, d.visibility]);
export class Social {
  journal: Journal; provider: (run: Run) => SocialProvider; busy = false; now: () => Date;
  constructor(journal: Journal, provider: (run: Run) => SocialProvider, now = () => new Date()) { this.journal = journal; this.provider = provider; this.now = now; }
  path(id: string) { this.journal.path(id); return join(this.journal.dir, 'social', `${id}.json`); }
  async load(id: string): Promise<SocialState> {
    try { const state = JSON.parse(await readFile(this.path(id), 'utf8')); if (state.schema !== 1 || state.runId !== id || !Array.isArray(state.drafts)) throw Error('Unsupported social journal.'); return state; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; return { schema: 1, runId: id, drafts: [] }; }
  }
  async save(state: SocialState) { await mkdir(join(this.journal.dir, 'social'), { recursive: true, mode: 0o700 }); await atomicJSON(this.path(state.runId), state); }
  async exclusive<T>(fn: () => Promise<T>) { if (this.busy) throw Error('A social update is in progress.'); this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  invalidate(d: Draft) { for (const a of d.approvals) if (a.status === 'PENDING') a.status = 'INVALIDATED'; if (d.status === 'AWAITING_APPROVAL') d.status = 'DRAFT'; }
  async action(id: string, action: string, input: Record<string, unknown>) {
    return this.exclusive(async () => {
      const run = await this.journal.load(id); if (!eligible(run)) throw Error('Launch and bind this business before using social publishing.');
      const state = await this.load(id); const provider = this.provider(run); const at = this.now().toISOString();
      if (action === 'save' || action === 'template') {
        let d = input.draftId ? state.drafts.find(d => d.id === input.draftId) : undefined;
        if (input.draftId && !d) throw Error('Draft not found.');
        if (d && sent(d)) throw Error('Attempted publications are immutable. Reconcile their saved outcome.');
        const text = action === 'template' ? `${run.config.seo.title || run.config.domain}\n${run.config.seo.description || 'Explore our website.'}\nhttps://${run.config.domain}/` : input.text;
        validateText(text);
        const visibility = input.visibility ?? 'unlisted'; if (visibility !== 'public' && visibility !== 'unlisted') throw Error('Select public or unlisted visibility.');
        if (!d) { if (state.drafts.length >= 200) throw Error('This business has reached the 200-draft history limit.'); d = { id: randomUUID(), text, visibility, createdAt: at, updatedAt: at, status: 'DRAFT', approvals: [] }; state.drafts.push(d); }
        else { this.invalidate(d); d.text = text; d.visibility = visibility; d.status = 'DRAFT'; d.updatedAt = at; }
        await this.save(state); return d.id;
      }
      if (action === 'refresh') {
        const account = await provider.account();
        for (const d of state.drafts) { const a = d.approvals.at(-1); if (a?.status === 'PENDING' && (a.connection !== provider.identity() || digest(destination(a.account)) !== digest(destination(account)) || a.revision !== (run.approvalRevision || 0))) this.invalidate(d); }
        state.connection = provider.identity(); state.account = account; state.checkedAt = at; await this.save(state); return;
      }
      const d = state.drafts.find(d => d.id === input.draftId); if (!d) throw Error('Draft not found.');
      if (action === 'prepare') {
        if (sent(d)) throw Error('This draft already has a publication attempt; reconcile it without resending.');
        validateText(d.text); const account = await provider.account(); validateLength(d.text, account);
        if (state.drafts.some(other => other.id !== d.id && sent(other) && other.approvals.some(a => a.hash === contentHash(d, account)))) throw Error('Identical content already has a publication attempt for this destination. Inspect its history.');
        this.invalidate(d);
        if (d.approvals.length >= 200) throw Error('This draft has reached its approval history limit.');
        d.approvals.push({ id: randomUUID(), hash: contentHash(d, account), connection: provider.identity(), account, revision: run.approvalRevision || 0, at, status: 'PENDING' });
        d.status = 'AWAITING_APPROVAL'; state.account = account; state.connection = provider.identity(); state.checkedAt = at; await this.save(state); return;
      }
      const approval = d.approvals.at(-1);
      if (action === 'approval') {
        if (d.status !== 'AWAITING_APPROVAL' || !approval || approval.id !== input.approvalId || approval.status !== 'PENDING' || !['approved', 'denied'].includes(String(input.decision))) throw Error('This exact approval is no longer pending.');
        if (input.decision === 'denied') { approval.status = 'DECLINED'; approval.decidedAt = at; d.status = 'DECLINED'; await this.save(state); return; }
        if (approval.connection !== provider.identity() || approval.revision !== (run.approvalRevision || 0)) { this.invalidate(d); await this.save(state); throw Error('Connection or business settings changed. Prepare a new approval.'); }
        const account = await provider.account(); validateText(d.text); validateLength(d.text, account);
        if (approval.hash !== contentHash(d, account)) { this.invalidate(d); await this.save(state); throw Error('Content or destination changed. Prepare a new approval.'); }
        if (state.drafts.some(other => other.id !== d.id && sent(other) && other.approvals.some(a => a.hash === approval.hash))) throw Error('Identical content already has a publication attempt for this destination.');
        approval.status = 'APPROVED'; approval.decidedAt = at; d.attemptedAt = at; d.status = 'INTENT';
        await this.save(state); // No network write is possible before the durable intent.
        try {
          const publication = await provider.publish(d.text, d.visibility, approval.id);
          if (publication.accountId !== account.id || publication.visibility !== d.visibility) throw Error('Unexpected publication destination.');
          d.publication = publication; d.status = 'ACCEPTED'; d.message = 'Provider accepted the post. Reconcile to inspect saved source evidence.';
        } catch { d.status = 'UNKNOWN'; d.message = 'Publication outcome is unknown. Inspect your Mastodon account and reconcile by post ID. This draft will never be resent.'; }
        await this.save(state); return;
      }
      if (action === 'reconcile') {
        if (!sent(d) || !approval || approval.status !== 'APPROVED') throw Error('No publication attempt to reconcile.');
        const postId = d.publication?.id || input.postId;
        if (typeof postId !== 'string' || !/^\d{1,40}$/.test(postId)) throw Error('Enter the numeric post ID from your Mastodon post URL. No post will be resent.');
        d.reconciledAt = at;
        try {
          const account = await provider.account();
          if (digest(destination(account)) !== digest(destination(approval.account))) throw Error('Reconnect the original publishing account to reconcile.');
          const post = await provider.inspect(postId);
          if (post.id !== postId || post.accountId !== approval.account.id || post.visibility !== d.visibility || post.text !== d.text || post.spoiler !== '' || Date.parse(post.createdAt) < Date.parse(d.attemptedAt!) - 60_000 || Date.parse(post.createdAt) > Date.parse(d.attemptedAt!) + 600_000) throw Error('Post does not match the approved account, content, visibility and attempt time.');
          const { text: _text, spoiler: _spoiler, ...publication } = post; d.publication = publication; d.status = 'OBSERVED'; d.observedAt = at; d.message = 'Matching provider post and source observed. This is not reach, engagement or delivery evidence.';
        } catch { d.status = 'UNKNOWN'; d.message = 'Matching publication could not be verified. Check access to the original publishing account and post ID. Earlier receipts and observations are historical; missing, edited or deleted posts do not authorize resending.'; }
        await this.save(state); return;
      }
      throw Error('Unsupported social action.');
    });
  }
  async report(id: string) {
    const run = await this.journal.load(id); const state = await this.load(id); const provider = this.provider(run); const changed = state.connection !== provider.identity();
    return { ...state, account: changed ? undefined : state.account, checkedAt: changed ? undefined : state.checkedAt, drafts: state.drafts.map(d => ({ ...d, status: d.status === 'INTENT' ? 'UNKNOWN' : d.status, approvalValid: d.status === 'AWAITING_APPROVAL' && d.approvals.at(-1)?.connection === provider.identity() && d.approvals.at(-1)?.revision === (run.approvalRevision || 0) })), connected: provider.connected(), eligible: eligible(run), simulated: run.config.mode === 'mock', domain: run.config.domain, generatedAt: this.now().toISOString(), limits: 'Text posts to your mastodon.social account only. No scheduling, bulk posting, paid services or AI subscription. Acceptance and observation do not measure audience reach.' };
  }
}
