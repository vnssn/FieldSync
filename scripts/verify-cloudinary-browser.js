import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createFixture,png,wav,poll } from '../tests/helpers/m5.js';
import { cloudinaryFixture,cloudinarySettings } from '../tests/helpers/cloudinary.js';
import { createCloudinaryStorage } from '../apps/server/src/infrastructure/cloudinary-storage.js';
import { createApp } from '../apps/server/src/app.js';
import { createJobRuntime } from '../apps/server/src/modules/jobs/worker.js';

// Built UI + real cookies/IndexedDB/PostgreSQL/Redis; Cloudinary remains local.
const repo=fileURLToPath(new URL('../',import.meta.url));
const { chromium }=await import(pathToFileURL(resolve(repo,process.env.FIELDSYNC_PLAYWRIGHT_PATH??'.local/qa/node_modules/playwright/index.mjs')).href);
const provider=cloudinaryFixture(),seedStorage=createCloudinaryStorage(cloudinarySettings,provider.sdk,provider.fetchFile);
let f,server,browser,runtime;
try {
  f=await createFixture('m5cloudinaryui',cloudinarySettings,{ storage:seedStorage });
  const row=await f.fresh();
  server=createServer();
  await new Promise((done)=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${server.address().port}`,settings={ ...f.settings,APP_ORIGIN:origin };
  const storage=createCloudinaryStorage(settings,provider.sdk,provider.fetchFile);
  server.on('request',createApp({ pool:f.pool,storage,env:settings,logger:f.logger,
    getHealth:async()=>({}),webDirectory:resolve(repo,'apps/web/dist') }));
  runtime=createJobRuntime({ pool:f.pool,storage,env:settings,logger:f.logger,intervalMs:100 });
  await runtime.queue.waitUntilReady();
  browser=await chromium.launch({ channel:'msedge',headless:true });
  const context=await browser.newContext(),page=await context.newPage(),uploads=[],errors=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  context.on('request',(request)=>{
    if(request.method()==='PUT' && request.url().includes('/content/')) uploads.push({ url:request.url(),headers:request.allHeaders() });
    assert.ok(!request.url().includes('cloudinary'), 'The browser must never contact Cloudinary.');
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel('Organization ID').fill(f.orgA.organization.id);
  await page.getByLabel('Email',{ exact:true }).fill(f.workerA.user.email);
  await page.getByLabel('Password',{ exact:true }).fill(f.password);
  await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(`${origin}/`);
  await page.goto(`${origin}/inspections/${row.id}`);
  await page.getByRole('heading',{ name:'Complete checklist',exact:true }).waitFor();
  await poll(async()=>!(await page.getByLabel('Evidence file',{ exact:true }).isDisabled()),'editor lock');
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.getByLabel('Evidence file',{ exact:true }).setInputFiles({ name:'cloud-photo.png',mimeType:'image/png',buffer:png });
  await page.getByRole('button',{ name:'Attach file',exact:true }).click();
  await page.getByText('Stored on this device; upload queued',{ exact:true }).waitFor();
  assert.equal(uploads.length,0);
  await context.setOffline(false);
  const evidence=async()=> (await f.pool.query('SELECT evidence FROM inspections WHERE organization_id=$1 AND id=$2',[row.organizationId,row.id])).rows[0].evidence;
  await poll(async()=>(await evidence()).length===1,'offline photo replay',30000);
  await poll(async()=>!(await page.getByLabel('Evidence file',{ exact:true }).isDisabled()),'audio editor');
  await page.getByLabel('Evidence file',{ exact:true }).setInputFiles({ name:'cloud-audio.wav',mimeType:'audio/wav',buffer:wav });
  await page.getByRole('button',{ name:'Attach file',exact:true }).click();
  await poll(async()=>(await evidence()).length===2,'audio replay',30000);
  await poll(async()=>{
    const status=await f.pool.query("SELECT count(*)::int AS n FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND processing_status='ready'",[row.organizationId,row.id]);
    return status.rows[0].n===2;
  },'Cloudinary worker verification',30000);
  for(const file of await evidence()) {
    const result=await page.evaluate(async({ inspectionId,file })=>{
      const response=await fetch(`/api/v1/inspections/${inspectionId}/evidence/${file.id}/download`),bytes=await response.arrayBuffer();
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      return { status:response.status,size:bytes.byteLength,hash:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),cache:response.headers.get('cache-control') };
    },{ inspectionId:row.id,file });
    assert.deepEqual(result,{ status:200,size:file.size,hash:file.sha256,cache:'no-store' });
  }
  assert.ok(uploads.length>=2);
  for(const upload of uploads) { assert.equal(new URL(upload.url).origin,origin); assert.ok((await upload.headers).cookie); }
  page.on('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button',{ name:'Remove evidence',exact:true }).first().click();
  await poll(async()=>(await evidence()).length===1,'authorized removal',30000);
  assert.deepEqual(errors,[]);
  console.log('PASS: Cloudinary built UI replays offline photo and audio through same-origin session uploads, verifies/downloads original bytes and removes authorized evidence. No browser provider URLs or live Cloudinary calls.');
} finally {
  await browser?.close(); await runtime?.close();
  if(server?.listening) await new Promise((done)=>{ server.close(done); server.closeAllConnections(); });
  await f?.close();
}
