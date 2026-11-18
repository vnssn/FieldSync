import { useEffect,useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { evidenceListSchema,jobsResponseSchema } from '@fieldsync/contracts';
import { useAuth } from '../auth.jsx';
import { VoiceRecorder } from './VoiceRecorder.jsx';
import { useOffline } from '../offline/provider.jsx';
import { apiRequest } from '../api/client.js';
import { ErrorNotice } from './ui.jsx';

function Preview({ file,local=false }) {
  const { store,online }=useOffline();
  const [url,setUrl]=useState(null),[failed,setFailed]=useState(false);
  useEffect(() => {
    let stopped=false,objectUrl;
    setFailed(false); setUrl(null);
    if(local) store.file(file.id).then(({ blob }) => {
      objectUrl=URL.createObjectURL(blob); if(!stopped) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
    }).catch(() => { if(!stopped) setFailed(true); });
    else if(online) setUrl(`/api/v1/inspections/${file.inspectionId}/evidence/${file.id}/download`);
    return () => { stopped=true; if(objectUrl) URL.revokeObjectURL(objectUrl); };
  },[store,file.id,file.inspectionId,local,online]);
  if(failed || !url) return <p className="text-xs text-stone-500">{failed?'Preview unavailable; file metadata is retained.':'Preview available when connected.'}</p>;
  return file.mimeType.startsWith('image/') ? <a href={url} target="_blank" rel="noreferrer"><img className="mt-3 max-h-48 max-w-full rounded-lg object-contain" src={url} alt={file.name} onError={()=>setFailed(true)} /></a>
    : <audio className="mt-3 max-w-full" controls preload="none" src={url} onError={()=>setFailed(true)} />;
}

export function EvidenceEditor({ copy,disabled,execute,onRecordingChange }) {
  const { store,snapshot }=useOffline();
  const [selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null),[saved,setSaved]=useState(false);
  const local=snapshot.files.filter((row)=>row.inspectionId===copy.id && row.status==='queued');
  const removed=new Set(snapshot.queue.filter((entry)=>entry.inspectionId===copy.id && entry.action==='remove').map((entry)=>entry.body.evidenceId));
  async function run(operation) {
    setBusy(true); setSaved(false); setError(null);
    try { await execute(operation); setSaved(true); } catch(failure) { setError(failure); } finally { setBusy(false); }
  }
  return <section className="space-y-3"><h3 className="font-semibold">Photos and audio notes</h3>
    <p className="text-sm text-stone-500">Photos: JPEG, PNG, WebP up to 10 MiB. Audio: MP3, WAV, Ogg, WebM up to 25 MiB. Files upload before submission.</p>
    <VoiceRecorder disabled={disabled || busy} save={(file)=>execute(()=>store.attachFile(copy.id,file))} onRecordingChange={onRecordingChange} />
    <ErrorNotice error={error} />
    <label className="block text-sm">Evidence file<input aria-label="Evidence file" className="input mt-2" type="file" disabled={disabled || busy}
      accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/ogg,audio/webm" onChange={(event)=>{ setSelected(event.target.files[0] ?? null); setSaved(false); }} /></label>
    <button type="button" className="button-secondary" disabled={disabled || busy || !selected} onClick={()=>run(async()=>{ await store.attachFile(copy.id,selected); setSelected(null); })}>{busy?'Saving file on this device…':'Attach file'}</button>
    {selected && <p className="text-xs">Selected: {selected.name}. {error?'Keep this page open and retry after freeing storage.':''}</p>}
    {saved && <p role="status" className="text-sm text-emerald-800">Evidence change saved on this device.</p>}
    {[...local,...copy.base.evidence.filter((file)=>!local.some((row)=>row.id===file.id))].map((file)=> <div className="rounded-xl border p-3" key={file.id}>
      <p className="break-words text-sm font-medium">{file.name} · {(file.size/1024/1024).toFixed(2)} MiB</p>
      <p className="text-xs text-stone-500">{removed.has(file.id)?'Removal queued':file.status==='queued'?'Stored on this device; upload queued':'Attached to report'}</p>
      <Preview file={{ ...file,inspectionId:copy.id }} local={file.status==='queued'} />
      <button type="button" className="mt-2 text-sm text-red-800 underline" disabled={disabled || busy || removed.has(file.id)} onClick={()=> {
        if(window.confirm(`Remove ${file.name}?`)) run(()=>store.removeFile(copy.id,file.id));
      }}>Remove evidence</button>
    </div>)}
  </section>;
}

export function EvidencePanel({ inspection }) {
  const { session,expired }=useAuth(),{ online }=useOffline();
  const owner=`${session.data?.organization.id}:${session.data?.user.id}`,id=inspection.id;
  const query=useQuery({ queryKey:['evidence',owner,id],enabled:online&&!expired,
    queryFn:({ signal })=>apiRequest(`/inspections/${id}/evidence`,{ schema:evidenceListSchema,signal }),refetchInterval:online?5000:false });
  const jobs=useQuery({ queryKey:['inspection-jobs',owner,id],enabled:online&&!expired,
    queryFn:({ signal })=>apiRequest(`/inspections/${id}/jobs`,{ schema:jobsResponseSchema,signal }),refetchInterval:online?5000:false });
  return <section className="panel print-hidden mt-6 space-y-4"><h2 className="text-xl font-semibold">Evidence and background work</h2>
    <ErrorNotice error={online?query.error ?? jobs.error:null} />
    {!inspection.evidence.length && <p className="text-sm text-stone-500">No evidence attached to this report version.</p>}
    {inspection.evidence.map((file)=> {
      const current=query.data?.evidence.find((row)=>row.id===file.id);
      return <div className="rounded-xl border p-3" key={file.id}><p className="break-words font-medium">{file.name}</p>
        <p className="text-xs text-stone-500">{current?`Verification: ${current.processingStatus}`:online&&query.data?'Removed evidence; historical metadata retained.':'Connect to check verification status.'}</p>
        {(!query.data || current) && <Preview file={{ ...file,inspectionId:id }} />}</div>;
    })}
    {jobs.data?.jobs.filter((job)=>job.kind==='prepare_report').map((job)=> <div className="text-sm" key={job.id}>
      Report archive v{job.sourceVersion}: {job.status}{job.summary && <p className="text-stone-500">{job.summary}</p>}
      {job.status==='completed' && <a className="text-[#315248] underline" target="_blank" rel="noreferrer" href={`/api/v1/inspections/${id}/archives/${job.id}`}>Open printable archive</a>}
    </div>)}
  </section>;
}
