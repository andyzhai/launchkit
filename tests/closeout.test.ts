import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, digest } from '../src/workflow/journal.ts';
import { LiveProvider } from '../src/adapters/live.ts';
import { discover, auditDistribution } from '../src/adapters/app-vite.ts';
import { Vault } from '../src/security/tokens.ts';
import { Runner } from '../src/workflow/runner.ts';
import { MockProvider } from '../src/adapters/mock.ts';
import { startServer } from '../src/ui/server.ts';
import type { Context } from '../src/workflow/types.ts';

test('live preparation removes legacy instrumentation and unchanged settings preserve release identity', async () => {
  const dir=await mkdtemp(join(tmpdir(),'launchkit-optional-'));const app=join(dir,'app');await mkdir(app);
  await writeFile(join(app,'package.json'),JSON.stringify({name:'fixture',devDependencies:{vite:'1'},scripts:{build:'unused',test:'unused'}}));
  await writeFile(join(app,'package-lock.json'),'{}');
  const journal=new Journal(join(dir,'state'));
  const run=await journal.create({appPath:app,domain:'example.test',accountId:'a'.repeat(32),inbox:'owner@example.test',mode:'live',outbound:false,www:true,analytics:{approved:false,publicPaths:['/']},seo:{approved:false,title:'',description:''}});
  const info=await discover(app);
  const fingerprint=digest([info.fingerprint,run.config.seo,run.config.analytics,run.config.domain]);
  const built=join(journal.dir,'releases',run.id,fingerprint);await mkdir(built,{recursive:true});
  await writeFile(join(built,'index.html'),'<html><head></head><body>Application</body></html>');
  run.resources.buildFingerprint=fingerprint;run.resources.originalManifest=await auditDistribution(built);
  run.resources.analytics={site_tag:'old-site',site_token:'a'.repeat(32)};
  const ctx:Context={run,save:()=>journal.save(run),approve:async()=>assert.fail('No approval expected'),effect:async()=>assert.fail('No provider mutation expected')};
  // No credentials: any accidental provider access would fail this test.
  const provider=new LiveProvider(journal.dir,new Vault(journal.dir));
  await provider.step('prepare',ctx);const release=run.resources.release;
  assert.equal(run.resources.analytics,undefined);
  assert.ok(!(await readFile(join(run.resources.publishDir,'index.html'),'utf8')).includes('__launchkit'));
  assert.equal((await provider.step('analytics',ctx)).status,'unsupported');assert.equal(await provider.step('outgoing',ctx),'SKIPPED');
  await provider.step('prepare',ctx);assert.equal(run.resources.release,release);
  run.config.www=false;await provider.step('prepare',ctx);assert.notEqual(run.resources.release,release);
});

test('inbox verification wait automatically resumes on the local polling tick', async t => {
  const journal=new Journal(await mkdtemp(join(tmpdir(),'launchkit-poll-')));
  const run=await journal.create({appPath:journal.dir,domain:'example.test',accountId:'mock',inbox:'owner@example.test',mode:'mock',outbound:false,www:true,analytics:{approved:false,publicPaths:['/']},seo:{approved:false,title:'',description:''}});
  const provider=new MockProvider(journal.dir,{emailPending:true});
  const paused=await new Runner(journal,provider).execute(run.id);paused.steps.incoming.evidence={poll:true};await journal.save(paused);
  provider.options.emailPending=false;
  let persistenceError: unknown;
  const save=journal.save.bind(journal);
  journal.save=async state=>{try{await save(state);}catch(error){persistenceError=error;throw error;}};
  t.mock.timers.enable({apis:['setInterval']});
  const {server}=await startServer({journal,vault:new Vault(journal.dir),provider:()=>provider});
  try {
    t.mock.timers.tick(30000);
    let complete=false;
    // Each step fsyncs its journal; concurrent provider/vault suites can exceed
    // two seconds on Windows. Keep a bounded wait without assuming disk speed.
    const deadline=performance.now()+15000;
    while(performance.now()<deadline) {if(persistenceError)throw persistenceError;if((await journal.load(run.id)).status==='LIVE_VERIFIED'){complete=true;break;}await new Promise(r=>setTimeout(r,20));}
    assert.equal(complete,true,JSON.stringify((await journal.load(run.id)).steps));
    const remote=JSON.parse(await readFile(join(journal.dir,`mock-${run.id}.json`),'utf8'));
    assert.equal(remote.counts.destination,1);assert.equal(remote.counts.route,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));t.mock.timers.reset();}
});
