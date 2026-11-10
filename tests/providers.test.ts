import test from 'node:test';
import assert from 'node:assert/strict';
import { Cloudflare, APIError } from '../src/adapters/cloudflare.ts';
import { incoming, outgoing, Resend } from '../src/adapters/email.ts';
import { Pause, type Context } from '../src/workflow/types.ts';
import { ensureDomain } from '../src/adapters/domain.ts';
import { registerSecret } from '../src/security/redaction.ts';
const accountId = 'a'.repeat(32);
const envelope = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result }), { status, headers: { 'Content-Type': 'application/json' } });
function context(): Context {
  const run: any = { id: 'f'.repeat(24), config: { domain: 'example.test', inbox: 'owner@example.test' }, resources: { zone: { id: 'zone', name: 'example.test' }, worker: 'lk-test' }, operations: {}, approvals: [] };
  return { run, save: async () => {}, approve: async () => { throw new Pause('WAITING_USER', 'Approval required'); }, effect: async (key, before, action) => { run.operations[key] = { status: 'INTENT', before }; const result = await action(); run.operations[key].status = 'OBSERVED'; return result; } };
}
test('A18 registrar sandbox uses documented isolated paths and never production registrations', async () => {
  const calls: { path: string; method: string; body: any }[] = [];
  const transport: typeof fetch = async (input, init) => { calls.push({ path: new URL(String(input)).pathname, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }); return envelope({ domains: [{ name: 'example.com', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '10.11', renewal_cost: '10.11' } }] }); };
  const cf = new Cloudflare(accountId, { registrar: 'test-registrar-token' }, transport, true);
  assert.equal((await cf.check('example.com')).amount, '10.11');
  await cf.sandboxPurchase('example.com', { registrant: { email: 'test@example.test' } });
  assert.ok(calls.every(c => c.path.includes('/registrar-sandbox/'))); assert.deepEqual(calls[0].body, { domains: ['example.com'] });
  await assert.rejects(cf.purchase('example.com'), /requires explicit contact/);
  await assert.rejects(new Cloudflare(accountId, {}, transport).sandboxPurchase('example.com', {}), /cannot register production/);
});
test('A15/A16 provider error bodies are never reflected; GETs retry but mutations do not', async () => {
  const secret = 'api-secret-not-for-output'; registerSecret(secret); let calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ success: false, errors: [{ code: 999, message: secret }] }), { status: 503 }); };
  const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, transport);
  await assert.rejects(cf.request('/zones'), e => e instanceof APIError && !e.message.includes(secret)); assert.equal(calls, 3);
  calls = 0; await assert.rejects(cf.request('/zones', 'POST', {})); assert.equal(calls, 1);
});
test('A07 Cloudflare pagination inspects later pages before creating resources', async () => {
  const transport: typeof fetch = async input => { const url = new URL(String(input)); const page = Number(url.searchParams.get('page')); return new Response(JSON.stringify({ success: true, result: page === 1 ? [] : [{ id: 'owned', name: 'example.test', account: { id: accountId } }], result_info: { total_pages: 2 } })); };
  const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, transport); assert.equal((await cf.zone('example.test'))?.id, 'owned');
});
test('A09 Cloudflare DNS conflicts do not cause DELETE or POST before approval', async () => {
  const ctx = context(); const calls: string[] = [];
  const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, async (_input, init) => { calls.push(init?.method || 'GET'); return envelope([{ id: 'existing', name: 'send.example.test', type: 'MX', content: 'mail.existing.test', priority: 10 }]); });
  await assert.rejects(cf.ensureDNS(ctx, 'zone', { name: 'send.example.test', type: 'MX', content: 'mail.new.test', priority: 10 }), e => e instanceof Pause && e.status === 'WAITING_USER');
  assert.deepEqual(calls, ['GET']);
});
test('A09 approval is invalidated when DNS changes before deletion', async () => {
  const ctx = context(); ctx.approve = async () => {};
  const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, async (_input, init) => { assert.equal(init?.method, 'GET'); return envelope({ id: 'record', name: 'example.test', type: 'MX', content: 'changed.test' }); });
  await assert.rejects(cf.removeDNS(ctx, 'zone', [{ id: 'record', name: 'example.test', type: 'MX', content: 'old.test' }], 'replace'), /changed after approval/);
});
test('A10 real incoming adapter waits for verified destination without changing DNS', async () => {
  const calls: string[] = []; const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, async input => { const path = new URL(String(input)).pathname; calls.push(path); return envelope([{ id: 'destination', email: 'owner@example.test', verified: null }]); });
  await assert.rejects(incoming(context(), cf), e => e instanceof Pause && e.status === 'WAITING_USER'); assert.ok(calls.every(p => p.endsWith('/addresses')));
});
test('A07 real inbound forwarding reconciles ready DNS, destination and rule without writes', async () => {
  const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, async (input, init) => {
    assert.equal(init?.method, 'GET'); const path = new URL(String(input)).pathname;
    if (path.endsWith('/addresses')) return envelope([{ id: 'destination', email: 'owner@example.test', verified: '2026-01-01' }]);
    if (path.endsWith('/dns')) return envelope([{ type: 'MX', name: 'example.test', content: 'route.mx.cloudflare.net.', priority: 10 }, {type:'TXT',content:'"v=spf1 include:_spf.mx.cloudflare.net ~all"'}]);
    if (path.endsWith('/dns_records')) return envelope([{ type: 'MX', name: 'example.test', content: 'ROUTE.mx.cloudflare.net', priority: 10 }, {type:'TXT',content:'v=spf1 include:_spf.mx.cloudflare.net ~all'}]);
    if (path.endsWith('/rules')) return envelope([{ id: 'rule', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'contact@example.test' }], actions: [{ type: 'forward', value: ['owner@example.test'] }] }]);
    return envelope({ enabled: true, status: 'ready' });
  });
  const result = await incoming(context(), cf, async () => [{ exchange: 'route.mx.cloudflare.net', priority: 10 }]); assert.equal(result.ruleId, 'rule'); assert.equal(result.configurationVerified,true); assert.equal(result.deliveryTested,false);
});

test('email enablement still propagating after submission is not repeatedly submitted', async () => {
  const ctx = context();ctx.run.operations['email-enable']={status:'OBSERVED',at:''};
  const cf = new Cloudflare(accountId,{cloudflare:'test-token'},async(input,init)=>{
    assert.equal(init?.method,'GET'); const path=new URL(String(input)).pathname;
    if(path.endsWith('/addresses'))return envelope([{email:'owner@example.test',verified:true}]);
    if(path.endsWith('/dns')||path.endsWith('/dns_records'))return envelope([]);
    return envelope({enabled:true,status:'pending'});
  });
  await assert.rejects(incoming(ctx,cf),e=>e instanceof Pause && e.status==='WAITING_PROVIDER');
});

test('changed forwarding rule after approval is never overwritten', async () => {
  const ctx=context();ctx.approve=async()=>{};let reads=0;
  const cf=new Cloudflare(accountId,{cloudflare:'test-token'},async(input,init)=>{
    assert.equal(init?.method,'GET');const path=new URL(String(input)).pathname;
    if(path.endsWith('/addresses'))return envelope([{email:'owner@example.test',verified:true}]);
    if(path.endsWith('/dns')||path.endsWith('/dns_records'))return envelope([]);
    if(path.endsWith('/rules'))return envelope([{id:'rule',enabled:true,matchers:[{type:'literal',field:'to',value:'contact@example.test'}],actions:[{type:'forward',value:[++reads===1?'old@example.test':'changed@example.test']}]}]);
    return envelope({enabled:true,status:'ready'});
  });
  await assert.rejects(incoming(ctx,cf),/changed after approval/);
});
test('A07 outgoing uses a separate sending subdomain and never sends email', async () => {
  const calls: string[] = [];
  const resend = new Resend('test-key', async (input, init) => { const path = new URL(String(input)).pathname; calls.push(path); assert.equal(init?.method, 'GET'); return new Response(JSON.stringify(path === '/domains' ? { data: [{ id: 'sending', name: 'send.example.test' }], has_more: false } : { id: 'sending', status: 'verified', records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'public-key' }] })); });
  const cf = new Cloudflare(accountId, { cloudflare: 'test-token' }, async (input, init) => { assert.equal(init?.method, 'GET'); assert.equal(new URL(String(input)).searchParams.get('name'), 'resend._domainkey.send.example.test'); return envelope([{ type: 'TXT', content: 'public-key' }]); });
  assert.equal((await outgoing(context(), cf, resend)).domain, 'send.example.test'); assert.ok(calls.every(p => !p.includes('emails')));
});
test('A05/A17 price drift invalidates approval before purchase', async () => {
  const ctx = context(); ctx.approve = async () => {}; let checks = 0; let purchases = 0;
  await assert.rejects(ensureDomain(ctx, { zone: async () => undefined, registration: async () => 'missing', check: async () => ({ domain: 'example.test', available: true, amount: ++checks === 1 ? '10.11' : '12.11', currency: 'USD', renewal: '12.11' }), suggestions: async () => [], purchase: async () => { purchases++; }, createZone: async () => { throw Error('must not create'); } }), /price changed/);
  assert.equal(purchases, 0);
});
test('A06 unresolved purchase with no visible ownership remains blocked indefinitely', async () => {
  const ctx = context(); ctx.run.operations.purchase = { status: 'INTENT', at: '' };
  const api: any = { zone: async () => undefined, registration: async () => 'missing', purchase: async () => assert.fail('double charge') };
  await assert.rejects(ensureDomain(ctx, api), e => e instanceof Pause && e.status === 'NEEDS_RECONCILIATION');
});
