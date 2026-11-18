import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspection } from './helpers/offline.js';
import { png,wav } from './helpers/m5.js';
import { createAiProvider } from '../apps/server/src/modules/ai/provider.js';

// Contract simulations on a real local HTTP server. These are not live model
// analyses, and no paid provider request or real API key is used by verification.
let server,origin,handler;
before(async()=>{
  server=createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    await handler(req,res,Buffer.concat(chunks));
  });
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve)); origin=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{ await new Promise((resolve)=>{ server.close(resolve); server.closeAllConnections(); }); });
function provider(overrides={}) {
  return createAiProvider({ AI_ENABLED:true,OPENAI_API_KEY:'synthetic-provider-test-key',OPENAI_MODEL:'gpt-5-mini',OPENAI_TRANSCRIPTION_MODEL:'gpt-transcribe',AI_TIMEOUT_MS:1000,...overrides },
    { fetchImpl:(url,options)=>fetch(`${origin}${new URL(url).pathname}`,options) });
}
function result(res,output,extra={}) {
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ id:'test_response_1',model:'test-model-snapshot',status:'completed',output:[{ type:'message',content:[{ type:'output_text',text:JSON.stringify(output) }] }],...extra }));
}
const output=(row)=>({ text:'Possible visible wear; confirm on equipment.',transcript:'',findings:[{ itemId:row.template.items[0].id,notes:'Possible visible wear; requires confirmation.' }],warnings:['Suggestion requires human verification.'] });

test('M5 disabled/missing-key fallback makes no provider request and invents no image or voice observations',async()=>{
  let calls=0; const fake=async()=>{ calls++; throw new Error('Must not call'); },row=inspection();
  for(const settings of [{ AI_ENABLED:false,OPENAI_API_KEY:'synthetic' },{ AI_ENABLED:true }]) {
    const adapter=createAiProvider(settings,{ fetchImpl:fake });
    for(const kind of ['image','voice','report']) {
      const value=await adapter.generate({ kind,inspection:row });
      assert.equal(value.mode,'fallback'); assert.equal(value.provider,'manual'); assert.deepEqual(value.original.findings,[]); assert.equal(value.original.transcript,'');
      if(kind==='report') assert.match(value.original.text,/unanswered/); else assert.equal(value.original.text,'');
    }
  }
  assert.equal(calls,0);
});

test('M5 image adapter sends only selected bytes/checklist to the official Responses shape and validates returned provenance',async()=>{
  const row=inspection(),expected=output(row); let request;
  handler=async(req,res,body)=>{ request={ path:req.url,headers:req.headers,body:JSON.parse(body) }; result(res,expected); };
  const generated=await provider().generate({ kind:'image',inspection:row,evidence:{ mime_type:'image/png',name:'photo.png' },bytes:png });
  assert.equal(generated.mode,'provider'); assert.equal(generated.model,'test-model-snapshot'); assert.equal(generated.providerRequestId,'test_response_1'); assert.deepEqual(generated.original,expected);
  assert.equal(request.path,'/v1/responses'); assert.equal(request.body.store,false); assert.equal(request.body.text.format.strict,true);
  assert.ok(request.body.input[0].content.some((item)=>item.type==='input_image' && item.image_url.endsWith(png.toString('base64'))));
  assert.ok(!JSON.stringify(request.body).includes(row.worker.email)); assert.ok(!JSON.stringify(request.body).includes(row.organizationId));
  assert.equal(JSON.parse(generated.raw).findings[0].notes,expected.findings[0].notes);
});

test('M5 voice adapter transcribes real multipart bytes, extracts checklist findings and preserves the original transcript separately',async()=>{
  const row=inspection(),calls=[];
  handler=async(req,res,body)=>{
    calls.push({ path:req.url,body:body.toString('utf8'),headers:req.headers });
    if(req.url==='/v1/audio/transcriptions') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ text:'I checked pressure and noticed wear.',usage:{ input_tokens:1 } })); }
    else result(res,{ ...output(row),transcript:'Model rewrote the transcript' });
  };
  const generated=await provider().generate({ kind:'voice',inspection:row,evidence:{ mime_type:'audio/wav',name:'voice.wav' },bytes:wav });
  assert.equal(generated.mode,'provider'); assert.equal(calls.length,2); assert.match(calls[0].headers['content-type'],/multipart\/form-data; boundary=/);
  assert.match(calls[0].body,/RIFF/); assert.match(calls[0].body,/gpt-transcribe/);
  assert.equal(generated.original.transcript,'I checked pressure and noticed wear.'); assert.match(generated.model,/gpt-transcribe$/);
  const raw=JSON.parse(generated.raw); assert.equal(raw.transcript,generated.original.transcript); assert.equal(raw.analysis.transcript,'Model rewrote the transcript');
});

test('M5 provider errors, malformed/oversized output, refusals, incomplete responses and unknown checklist references fall back deterministically',async()=>{
  const row=inspection();
  const scenarios=[
    (_req,res)=>{ res.statusCode=500; res.end('private provider credentials should never be persisted'); },
    (_req,res)=>res.end('not json'),
    (_req,res)=>result(res,{ ...output(row),findings:[{ itemId:'00000000-0000-4000-8000-000000000000',notes:'Wrong inspection' }] }),
    (_req,res)=>result(res,{ ...output(row),text:'x'.repeat(10001) }),
    (_req,res)=>result(res,output(row),{ status:'incomplete' }),
    (_req,res)=>result(res,output(row),{ output:[{ type:'message',content:[{ type:'refusal',refusal:'no' }] }] }),
    (_req,res)=>res.end('x'.repeat(300000)),
    (_req,res)=>result(res,{ ...output(row),organizationId:row.organizationId }),
  ];
  for(const scenario of scenarios) {
    handler=scenario; const generated=await provider().generate({ kind:'report',inspection:row });
    assert.equal(generated.mode,'fallback'); assert.equal(generated.fallbackReason,'provider_error'); assert.ok(!generated.raw.includes('private provider credentials'));
    assert.deepEqual(generated.original.findings,[]);
  }
});

test('M5 one bounded timeout covers transcription and extraction without changing manual data',async()=>{
  const row=inspection(); handler=async()=>{};
  const started=Date.now(),value=await provider({ AI_TIMEOUT_MS:100 }).generate({ kind:'voice',inspection:row,evidence:{ mime_type:'audio/wav',name:'voice.wav' },bytes:wav });
  assert.equal(value.mode,'fallback'); assert.equal(value.fallbackReason,'provider_error'); assert.ok(Date.now()-started<2000);
  assert.equal(row.reportText,'');
});

test('M5 a successful transcript survives extraction failure as a labeled fallback with provider provenance',async()=>{
  const row=inspection();
  handler=async(req,res)=>{
    if(req.url==='/v1/audio/transcriptions') res.end(JSON.stringify({ text:'A retained, original transcript.' }));
    else { res.statusCode=503; res.end('Provider unavailable'); }
  };
  const value=await provider().generate({ kind:'voice',inspection:row,evidence:{ mime_type:'audio/wav',name:'voice.wav' },bytes:wav });
  assert.equal(value.mode,'fallback'); assert.equal(value.provider,'openai'); assert.equal(value.model,'gpt-transcribe');
  assert.equal(value.original.transcript,'A retained, original transcript.'); assert.match(value.original.warnings[0],/Transcription completed/);
  assert.equal(JSON.parse(value.raw).transcript,value.original.transcript);
});
