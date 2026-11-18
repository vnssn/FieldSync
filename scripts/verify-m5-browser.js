import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,dirname,basename } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createFixture,png,poll } from '../tests/helpers/m5.js';
import { createJobRuntime } from '../apps/server/src/modules/jobs/worker.js';
import { env } from '../apps/server/src/config/env.js';

const repo=fileURLToPath(new URL('../',import.meta.url)),local=resolve(repo,'.local'),origin=new URL(env.APP_ORIGIN).origin,address=new URL(origin);
assert.equal(address.protocol,'http:'); assert.ok(['localhost','127.0.0.1'].includes(address.hostname),'M5 browser verification is local only');
const { chromium }=await import(pathToFileURL(resolve(repo,process.env.FIELDSYNC_PLAYWRIGHT_PATH ?? '.local/qa/node_modules/playwright/index.mjs')).href);
await mkdir(local,{ recursive:true }); const profile=await mkdtemp(resolve(local,'m5-profile-'));
let f,context,page,runtime; const errors=[];
try {
  f=await createFixture('m5ui',{}, { webDirectory:resolve(repo,'apps/web/dist') });
  // Move only our generated listener onto APP_ORIGIN for real MinIO CORS.
  // EADDRINUSE fails safely without stopping a user-started process.
  await new Promise((resolve)=>f.server.close(resolve));
  await new Promise((resolve,reject)=>{ f.server.once('error',reject); f.server.listen(Number(address.port || 80),'127.0.0.1',resolve); });
  const report=await f.fresh(),voice=await f.fresh(),photo=await f.fresh(),stale=await f.fresh(),merged=await f.fresh();
  await f.fresh(f.orgB,f.workerB);
  const dbName=`fieldsync:${f.orgA.organization.id}:${f.workerA.user.id}`;
  runtime=createJobRuntime({ pool:f.pool,storage:f.storage,env:f.settings,logger:f.logger,intervalMs:100 });
  async function launch(offline=false) {
    context=await chromium.launchPersistentContext(profile,{ channel:'msedge',headless:true,viewport:{ width:1440,height:1000 },
      args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],permissions:['microphone'] });
    await context.setOffline(offline); page=context.pages()[0] ?? await context.newPage(); page.on('pageerror',(error)=>errors.push(error.message));
  }
  async function state() {
    return page.evaluate(async(name)=>{
      const db=await new Promise((resolve,reject)=>{ const open=indexedDB.open(name); open.onsuccess=()=>resolve(open.result); open.onerror=()=>reject(open.error); });
      try {
        const result={ version:db.version };
        for(const table of ['workingCopies','outbox','files','blobs']) {
          const rows=await new Promise((resolve,reject)=>{ const read=db.transaction(table).objectStore(table).getAll(); read.onsuccess=()=>resolve(read.result); read.onerror=()=>reject(read.error); });
          result[table]=table==='blobs'?rows.map((row)=>({ id:row.id,size:row.blob.size })):rows;
        }
        return result;
      } finally { db.close(); }
    },dbName);
  }
  const current=async(id)=>(await f.send('get',`/inspections/${id}`,f.workerA).expect(200)).body.inspection;
  async function wait(check,label,timeout=40000) { return poll(check,label,timeout); }
  async function empty(id) { await wait(async()=> !(await state()).outbox.some((entry)=>entry.inspectionId===id),'empty device queue'); }
  async function open(id) {
    await page.goto(`${origin}/inspections/${id}`); await page.getByRole('heading',{ name:'Complete checklist',exact:true }).waitFor();
    await wait(async()=>!(await page.getByLabel('Outcome',{ exact:true }).first().isDisabled()),'worker editor lock');
  }
  async function login(user,owner=f.orgA) {
    await page.goto(`${origin}/login`); await page.getByLabel('Organization ID').fill(owner.organization.id);
    await page.getByLabel('Email',{ exact:true }).fill(user.email); await page.getByLabel('Password',{ exact:true }).fill(f.password);
    await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(`${origin}/`);
  }
  const ai=()=>page.getByRole('region',{ name:'AI assistance',exact:true });
  async function draftReport(id) {
    await empty(id); await wait(async()=>!(await ai().getByRole('button',{ name:'Draft report',exact:true }).isDisabled()),'assistance ready');
    await ai().getByRole('button',{ name:'Draft report',exact:true }).click();
    await ai().getByRole('button',{ name:'Review suggestion',exact:true }).first().waitFor({ timeout:30000 });
  }
  async function confirm(text) {
    await ai().getByRole('button',{ name:'Review suggestion',exact:true }).first().click();
    await ai().getByLabel('Reviewed report summary',{ exact:true }).fill(text);
    assert.equal(await ai().getByRole('button',{ name:'Apply reviewed edits',exact:true }).isDisabled(),true);
    await ai().getByRole('checkbox',{ name:'I checked this draft against the inspection and accept these edits.' }).check();
    await ai().getByRole('button',{ name:'Apply reviewed edits',exact:true }).click();
  }
  await launch(); await login(f.workerA.user); await open(report.id);
  await page.getByLabel('Outcome',{ exact:true }).nth(0).selectOption('fail');
  await page.getByLabel('Notes (required before submission)',{ exact:true }).fill('Worker-confirmed pressure fluctuation');
  await page.getByLabel('Outcome',{ exact:true }).nth(1).selectOption('pass');
  await page.getByLabel('Report summary',{ exact:true }).fill('Manual checks before assistance'); await empty(report.id);
  const before=await current(report.id); await draftReport(report.id);
  assert.equal((await current(report.id)).version,before.version);
  let lose=true;
  const reviewPath=`**/api/v1/inspections/${report.id}/ai/*/review`;
  await page.route(reviewPath,async(route)=>{
    const response=await route.fetch();
    if(lose && route.request().method()==='POST' && response.ok()) { lose=false; await route.abort('failed'); }
    else await route.fulfill({ response });
  });
  await confirm('Worker corrected and accepted this draft.');
  await ai().getByRole('button',{ name:'Retry unconfirmed AI review',exact:true }).waitFor();
  assert.equal((await current(report.id)).version,before.version+1); assert.equal(await page.getByLabel('Outcome',{ exact:true }).first().isDisabled(),true);
  await ai().getByRole('button',{ name:'Retry unconfirmed AI review',exact:true }).click();
  await wait(async()=> (await page.getByLabel('Report summary',{ exact:true }).inputValue())==='Worker corrected and accepted this draft.','reviewed local acknowledgment');
  await page.unroute(reviewPath);
  assert.equal((await current(report.id)).version,before.version+1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM ai_reviews WHERE organization_id=$1 AND inspection_id=$2',[report.organizationId,report.id])).rows[0].n,1);
  console.log('PASS: explicit human confirmation, untouched generation source, lost-response retry, one review/version and clean Dexie acknowledgment.');

  await open(merged.id); await draftReport(merged.id);
  const mergedPath=`**/api/v1/inspections/${merged.id}/ai/*/review`; let inject=true;
  await page.route(mergedPath,async(route)=>{
    const response=await route.fetch();
    if(inject && response.ok()) {
      inject=false;
      await page.evaluate(async({ name,id })=>{
        const db=await new Promise((resolve,reject)=>{ const open=indexedDB.open(name); open.onsuccess=()=>resolve(open.result); open.onerror=()=>reject(open.error); });
        try { await new Promise((resolve,reject)=>{
          const tx=db.transaction(['workingCopies','outbox'],'readwrite'),read=tx.objectStore('workingCopies').get(id);
          read.onsuccess=()=>{
            const copy=read.result,mutationId=crypto.randomUUID(),content={ ...copy.content,reportText:'Newer device edit while review response was in flight' };
            tx.objectStore('workingCopies').put({ ...copy,content,generation:copy.generation+1,updatedAt:new Date().toISOString() });
            tx.objectStore('outbox').add({ organizationId:copy.organizationId,userId:copy.userId,inspectionId:id,mutationId,action:'save',
              body:{ ...content,mutationId,baseVersion:copy.base.version },base:copy.base,generation:copy.generation+1,status:'pending',attemptedAt:null,error:null });
          };
          tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
        }); } finally { db.close(); }
      },{ name:dbName,id:merged.id });
    }
    await route.fulfill({ response });
  });
  await confirm('Human-reviewed earlier response');
  await page.getByRole('heading',{ name:'Resolve sync conflict',exact:true }).waitFor();
  assert.equal((await state()).workingCopies.find((copy)=>copy.id===merged.id).content.reportText,'Newer device edit while review response was in flight');
  await page.getByRole('radio').first().check(); await page.getByRole('button',{ name:'Save merged draft',exact:true }).click(); await empty(merged.id);
  await page.unroute(mergedPath);
  assert.equal((await current(merged.id)).reportText,'Newer device edit while review response was in flight');
  console.log('PASS: an in-flight AI review preserves newer device intent and requires the existing explicit three-way merge.');

  await open(stale.id); await runtime.worker.pause(); await empty(stale.id);
  await ai().getByRole('button',{ name:'Draft report',exact:true }).click();
  await wait(async()=> (await f.send('get',`/inspections/${stale.id}/ai`,f.workerA).expect(200)).body.artifacts.length===1,'queued source artifact');
  await page.getByLabel('Report summary',{ exact:true }).fill('Newer manual data makes the previous draft stale'); await empty(stale.id);
  await runtime.worker.resume(); await ai().getByText('Older source version. Request fresh assistance before applying.',{ exact:true }).waitFor({ timeout:30000 });
  assert.equal(await ai().getByRole('button',{ name:'Review suggestion',exact:true }).isDisabled(),true);
  console.log('PASS: a slow background draft remains source-bound and cannot overwrite newer manual work.');

  await open(photo.id); await page.getByLabel('Evidence file',{ exact:true }).setInputFiles({ name:'inspection.png',mimeType:'image/png',buffer:png });
  await page.getByRole('button',{ name:'Attach file',exact:true }).click(); await empty(photo.id);
  await wait(async()=> (await f.send('get',`/inspections/${photo.id}/evidence`,f.workerA).expect(200)).body.evidence.every((row)=>row.processingStatus==='ready'),'real photo verification');
  const photoRow=await current(photo.id);
  await ai().getByLabel('AI evidence',{ exact:true }).selectOption(photoRow.evidence[0].id);
  await ai().getByRole('button',{ name:'Suggest from evidence',exact:true }).click();
  await ai().getByRole('button',{ name:'Review suggestion',exact:true }).waitFor({ timeout:30000 });
  await ai().getByRole('button',{ name:'Review suggestion',exact:true }).click();
  await ai().getByLabel('Reviewed outcome: Pressure',{ exact:true }).selectOption('pass'); await ai().getByLabel('Reviewed outcome: Leaks',{ exact:true }).selectOption('fail');
  await ai().getByLabel('Reviewed notes: Leaks',{ exact:true }).fill('Photo checked; worker confirmed a leak.');
  await ai().getByLabel('Reviewed report summary',{ exact:true }).fill('Photo was reviewed by the worker.');
  await ai().getByRole('checkbox',{ name:'I checked this draft against the inspection and accept these edits.' }).check();
  await ai().getByRole('button',{ name:'Apply reviewed edits',exact:true }).click();
  await wait(async()=> (await current(photo.id)).aiSources.some((source)=>source.kind==='image'),'reviewed photo provenance');
  await wait(async()=>!(await page.getByRole('button',{ name:'Remove evidence',exact:true }).isDisabled()),'editable reviewed photo');
  page.once('dialog',(dialog)=>dialog.accept()); await page.getByRole('button',{ name:'Remove evidence',exact:true }).click(); await empty(photo.id);
  await wait(async()=> (await current(photo.id)).evidence.length===0,'photo removal');
  assert.equal(await ai().getByRole('button',{ name:'Suggest from evidence',exact:true }).isDisabled(),true);
  console.log('PASS: direct private MinIO photo upload, real BullMQ verification, labeled image fallback, worker-confirmed findings and safe selected-evidence removal.');

  await open(voice.id); await page.waitForFunction(()=>!!navigator.serviceWorker.controller); await context.setOffline(true);
  await page.getByLabel('Outcome',{ exact:true }).nth(0).selectOption('pass'); await page.getByLabel('Outcome',{ exact:true }).nth(1).selectOption('pass');
  await page.getByLabel('Report summary',{ exact:true }).fill('Voice note captured offline');
  await page.getByRole('button',{ name:'Record voice note',exact:true }).click();
  await page.getByRole('button',{ name:'Stop recording',exact:true }).waitFor(); await page.waitForTimeout(1500);
  await page.getByRole('button',{ name:'Stop recording',exact:true }).click(); await page.getByRole('button',{ name:'Attach recording',exact:true }).waitFor();
  await page.evaluate(()=>{ window.m5Put=IDBObjectStore.prototype.put; IDBObjectStore.prototype.put=function(value,...args) {
    if(this.name==='blobs') throw new DOMException('Injected recording quota failure','QuotaExceededError'); return window.m5Put.call(this,value,...args);
  }; });
  await page.getByRole('button',{ name:'Attach recording',exact:true }).click(); await page.getByText('Injected recording quota failure',{ exact:false }).waitFor();
  assert.equal((await state()).blobs.length,0); assert.equal((await state()).files.filter((file)=>file.inspectionId===voice.id).length,0);
  await page.evaluate(()=>{ IDBObjectStore.prototype.put=window.m5Put; delete window.m5Put; });
  await page.getByRole('button',{ name:'Attach recording',exact:true }).click();
  await wait(async()=> (await state()).blobs.length===1,'durable recorded blob');
  const captured=(await state()).files.find((file)=>file.inspectionId===voice.id); assert.equal(captured.mimeType,'audio/webm'); assert.ok(captured.size>0);
  await page.reload(); await page.getByRole('heading',{ name:'Complete checklist',exact:true }).waitFor();
  await context.close(); context=null; await launch(true); await page.goto(`${origin}/inspections/${voice.id}`);
  await page.getByRole('heading',{ name:'Complete checklist',exact:true }).waitFor(); assert.equal((await state()).blobs.length,1); assert.equal((await state()).version,20);
  await context.setOffline(false); await empty(voice.id);
  await wait(async()=> (await f.send('get',`/inspections/${voice.id}/evidence`,f.workerA).expect(200)).body.evidence.every((row)=>row.processingStatus==='ready'),'recorded WebM verification');
  assert.equal((await state()).blobs.length,0); const voiceRow=await current(voice.id);
  await ai().getByLabel('AI evidence',{ exact:true }).selectOption(voiceRow.evidence[0].id); await ai().getByRole('button',{ name:'Suggest from evidence',exact:true }).click();
  await ai().getByRole('button',{ name:'Review suggestion',exact:true }).waitFor({ timeout:30000 });
  await ai().getByRole('button',{ name:'Review suggestion',exact:true }).click();
  await ai().getByLabel('Reviewed outcome: Pressure',{ exact:true }).selectOption('fail');
  await ai().getByLabel('Reviewed notes: Pressure',{ exact:true }).fill('Manually listened: unstable pressure.');
  await ai().getByLabel('Reviewed report summary',{ exact:true }).fill('Voice note listened to and checked by the worker.');
  await ai().getByRole('checkbox',{ name:'I checked this draft against the inspection and accept these edits.' }).check();
  await ai().getByRole('button',{ name:'Apply reviewed edits',exact:true }).click();
  await wait(async()=> (await page.getByLabel('Report summary',{ exact:true }).inputValue())==='Voice note listened to and checked by the worker.','reviewed voice acknowledgment');
  await page.setViewportSize({ width:390,height:1000 });
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true); await page.screenshot({ path:resolve(local,'m5-voice-mobile.png'),fullPage:true });
  await page.getByRole('button',{ name:'Submit for review',exact:true }).click(); await empty(voice.id); await wait(async()=> (await current(voice.id)).status==='submitted','manual submission after assistance');
  assert.equal((await current(voice.id)).aiSources.at(-1).kind,'voice');
  console.log('PASS: actual MediaRecorder WebM, quota rollback/retry, offline reload/browser restart, private upload/replay, voice fallback review and mobile submission.');

  await page.getByRole('button',{ name:'Log out',exact:true }).click(); await page.waitForURL(`${origin}/login`); await login(f.orgA.user);
  await page.goto(`${origin}/inspections/${voice.id}`); await page.getByRole('button',{ name:'Approve report',exact:true }).waitFor();
  await page.getByRole('button',{ name:'Approve report',exact:true }).click();
  await wait(async()=> (await current(voice.id)).status==='approved','manager approval');
  await page.getByRole('heading',{ name:'Reviewed assistance provenance',exact:true }).waitFor();
  await wait(async()=> (await f.send('get',`/inspections/${voice.id}/jobs`,f.orgA).expect(200)).body.jobs.some((job)=>job.kind==='prepare_report'&&job.status==='completed'),'background report archive');
  const jobs=(await f.send('get',`/inspections/${voice.id}/jobs`,f.orgA).expect(200)).body.jobs,archive=jobs.find((job)=>job.kind==='prepare_report');
  const archived=await f.send('get',`/inspections/${voice.id}/archives/${archive.id}`,f.orgA).expect(200); assert.match(archived.text,/Reviewed assistance provenance/);
  const dashboardStart=Date.now(); await page.goto(`${origin}/`); await page.getByRole('heading',{ name:'Asset inspection summary',exact:true }).waitFor();
  const dashboardMs=Date.now()-dashboardStart;
  await page.getByText('Workspace inspections · current status of inspections created in the past 30 UTC days. Asset counts show the current directory.',{ exact:true }).waitFor();
  for (const period of ['7','90']) {
    await page.getByLabel('Analytics period',{ exact:true }).selectOption(period); await page.waitForURL(new RegExp(`days=${period}`));
    await page.getByText(`Workspace inspections · current status of inspections created in the past ${period} UTC days. Asset counts show the current directory.`,{ exact:true }).waitFor();
  }
  const analytics=(await f.send('get','/analytics?days=90',f.orgA).expect(200)).body;
  assert.equal(analytics.inspections.total,5); assert.equal(analytics.inspections.byStatus.approved,1); assert.equal(analytics.assets.total,1);
  assert.equal(analytics.byAsset[0].id,f.directories.get(f.orgA.organization.id).asset.id);
  assert.equal(await page.getByRole('img',{ name:'Daily inspection activity for the past 90 days',exact:true }).evaluate((chart)=>{
    const bounds=chart.getBoundingClientRect();
    return [...chart.children].every((day)=>{ const rect=day.getBoundingClientRect(); return rect.width>=1 && rect.right<=bounds.right+1; });
  }),true,'All daily bars stay visible within the mobile chart.');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({ path:resolve(local,'m5-analytics-mobile.png'),fullPage:true });
  await page.setViewportSize({ width:1440,height:1000 }); await page.screenshot({ path:resolve(local,'m5-analytics-desktop.png'),fullPage:true });
  const cacheUrls=await page.evaluate(async()=>{ const urls=[]; for(const name of await caches.keys()) for(const request of await (await caches.open(name)).keys()) urls.push(request.url); return urls; });
  assert.ok(cacheUrls.every((url)=>!url.includes('/api/')&&!url.includes(':9000/'))); assert.deepEqual(errors,[]);
  const health=(await f.send('get','/health').expect(200)).body; assert.equal(health.status,'ok');
  console.log(`PASS: manager approval/provenance/archive, tenant-scoped analytics, 7/30/90-day filters, desktop/mobile layout, actual dependency health, shell-only cache and zero page errors. Dashboard navigation ${dashboardMs}ms locally.`);
} catch(error) {
  if(page && !page.isClosed()) await page.screenshot({ path:resolve(local,'m5-browser-failure.png'),fullPage:true }).catch(()=>{});
  throw error;
} finally {
  await context?.close(); await runtime?.close(); await f?.close();
  assert.equal(dirname(profile),local); assert.match(basename(profile),/^m5-profile-[a-zA-Z0-9]+$/); await rm(profile,{ recursive:true,force:true });
  console.log('Cleaned up browser/profile, generated listener, worker, Redis namespace, private bucket and PostgreSQL schema.');
}
