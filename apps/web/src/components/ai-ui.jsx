import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiListSchema,aiArtifactSchema,requestAiSchema,reviewAiSchema,inspectionSchema } from '@fieldsync/contracts';
import { useAuth } from '../auth.jsx';
import { useOffline } from '../offline/provider.jsx';
import { apiRequest } from '../api/client.js';
import { ErrorNotice } from './ui.jsx';
import { useOnlineMutation,MutationNotice } from './inspection-ui.jsx';

const labels={ image:'Photo observations',voice:'Voice findings',report:'Report draft' };
export function AiPanel({ inspection,content,disabled=false,readOnly=false,prepareReview,acceptReview,onBusyChange }) {
  const { session,expired }=useAuth(),{ online }=useOffline();
  const owner=`${session.data.organization.id}:${session.data.user.id}`, worker=session.data.user.role==='worker';
  const [evidenceId,setEvidenceId]=useState(''),[selected,setSelected]=useState(null),[draft,setDraft]=useState(null);
  const [confirmed,setConfirmed]=useState(false),[error,setError]=useState(null),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(null);
  const query=useQuery({ queryKey:['ai',owner,inspection.id],enabled:online&&!expired,
    queryFn:({ signal })=>apiRequest(`/inspections/${inspection.id}/ai`,{ schema:aiListSchema,signal }),
    refetchInterval:(query)=>online && query.state.data?.artifacts.some((row)=>row.status==='queued') ? 3000:false });
  const request=useOnlineMutation(aiArtifactSchema,()=>query.refetch());
  const closed=['approved','cancelled'].includes(inspection.status), canRequest=worker&&!readOnly&&!disabled&&online&&!expired;
  const selectedEvidence=inspection.evidence.find((file)=>file.id===evidenceId);
  function generate(kind,id=null) {
    const body=requestAiSchema.parse({ kind,evidenceId:id,mutationId:crypto.randomUUID(),baseVersion:inspection.version });
    request.send(`/inspections/${inspection.id}/ai`,'POST',body);
  }
  function choose(artifact) {
    setSelected(artifact); setConfirmed(false); setError(null);
    const current=content ?? { answers:inspection.answers,reportText:inspection.reportText };
    setDraft({ reportText:artifact.kind==='report' ? artifact.original.text:current.reportText,
      answers:inspection.template.items.map((item) => {
        const answer=current.answers.find((row)=>row.itemId===item.id) ?? { itemId:item.id,outcome:null,notes:'' };
        const finding=artifact.original.findings.find((row)=>row.itemId===item.id);
        return { ...answer,notes:finding?.notes ?? answer.notes };
      }) });
  }
  async function perform(next) {
    setBusy(true); setError(null); onBusyChange?.(true);
    try {
      const saved=await apiRequest(`/inspections/${inspection.id}/ai/${next.artifactId}/review`,{ method:'POST',body:next.body,schema:inspectionSchema });
      if (acceptReview) await acceptReview(saved,next.expected);
      setAttempt(null); setSelected(null); setConfirmed(false); onBusyChange?.(false); await query.refetch();
    } catch (failure) {
      setError(failure);
      if (failure.status && failure.status<500) { setAttempt(null); onBusyChange?.(false); }
      // An uncertain response keeps the exact request and editor frozen for retry.
    } finally { setBusy(false); }
  }
  async function review(artifact,decision) {
    setError(null); onBusyChange?.(true);
    try {
      const expected=prepareReview ? await prepareReview():null;
      const body=reviewAiSchema.parse({ decision,confirmed:true,mutationId:crypto.randomUUID(),baseVersion:inspection.version,
        ...(decision==='apply'?draft:{}) });
      const next={ artifactId:artifact.id,body,expected }; setAttempt(next); await perform(next);
    } catch (failure) { setError(failure); onBusyChange?.(false); }
  }
  return <section className="panel print-hidden mt-6 space-y-4" aria-label="AI assistance">
    <h2 className="text-xl font-semibold">Assistance, with your review</h2>
    <p className="text-sm text-stone-600">Suggestions never change your report automatically. Review each field before applying. A manager still reviews the submitted report.</p>
    {!online && <p className="text-sm text-amber-800">Reconnect for assistance. Checklists, recordings and files still save on this device.</p>}
    {online && query.data && <p className="text-xs text-stone-500">{query.data.providerEnabled?'Available assistance sends saved checklist text or selected evidence to the configured AI provider. Requests without an available provider produce labeled manual-assistance drafts.':'AI provider is unavailable or disabled. Requests produce labeled manual-assistance drafts.'}</p>}
    <ErrorNotice error={error ?? (online?query.error:null)} /><MutationNotice mutation={request} />
    {worker&&!readOnly && <div className="space-y-3">
      {disabled && !attempt && <p className="text-sm text-stone-500">Save and sync your current edits/files before requesting or applying assistance.</p>}
      <label className="block text-sm">Uploaded evidence<select aria-label="AI evidence" className="input mt-2" value={evidenceId} disabled={!canRequest || busy || !!attempt} onChange={(event)=>setEvidenceId(event.target.value)}>
        <option value="">Choose a photo or voice note</option>{inspection.evidence.map((file)=><option key={file.id} value={file.id}>{file.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="button-secondary" disabled={!canRequest || request.blocked || busy || !!attempt} onClick={()=>generate('report')}>Draft report</button>
        <button type="button" className="button-secondary" disabled={!canRequest || request.blocked || busy || !!attempt || !selectedEvidence} onClick={()=>generate(selectedEvidence.kind==='photo'?'image':'voice',selectedEvidence.id)}>Suggest from evidence</button>
      </div>
    </div>}
    {attempt && !busy && <button type="button" className="button-secondary" disabled={!online || expired} onClick={()=>perform(attempt)}>Retry unconfirmed AI review</button>}
    {query.data?.artifacts.map((artifact)=><div key={artifact.id} className="rounded-xl border border-stone-200 p-4 space-y-2">
      <p className="font-medium">{labels[artifact.kind]} · Source version {artifact.sourceVersion}</p>
      <p className="text-xs text-stone-500">{artifact.status}{artifact.mode && ` · ${artifact.mode==='fallback'?'Manual fallback':'AI suggestion'} · ${artifact.model}`}</p>
      {artifact.sourceVersion!==inspection.version && !artifact.review && <p className="text-sm text-amber-800">Older source version. Request fresh assistance before applying.</p>}
      {artifact.status==='failed' && <p className="text-sm text-amber-800">Source unavailable or processing failed. Continue manually.</p>}
      {artifact.original && <details><summary className="cursor-pointer text-sm">Original suggestion and provenance</summary>
        <p className="mt-2 text-xs text-stone-500">{artifact.provider} · {artifact.model} · {artifact.promptVersion}{artifact.fallbackReason && ` · ${artifact.fallbackReason.replaceAll('_',' ')}`}</p>
        {artifact.original.warnings.map((warning,index)=><p key={index} className="mt-2 text-sm text-amber-800">{warning}</p>)}
        {artifact.original.transcript && <p className="mt-2 whitespace-pre-wrap text-sm">Transcript: {artifact.original.transcript}</p>}
        {artifact.original.text && <p className="mt-2 whitespace-pre-wrap text-sm">{artifact.original.text}</p>}
        {artifact.original.findings.map((finding)=><p key={finding.itemId} className="mt-2 whitespace-pre-wrap text-sm">{inspection.template.items.find((item)=>item.id===finding.itemId)?.label}: {finding.notes}</p>)}
      </details>}
      {artifact.review && <p className="text-sm text-emerald-800">{artifact.review.decision==='apply'?`Human-reviewed and applied at version ${artifact.review.appliedVersion}`:'Rejected'} by {artifact.review.reviewerName}.</p>}
      {!artifact.review && artifact.status==='ready' && !closed && <div className="flex flex-wrap gap-3">
        {worker&&!readOnly && <button type="button" className="button-secondary" disabled={!canRequest || busy || !!attempt || artifact.sourceVersion!==inspection.version} onClick={()=>choose(artifact)}>Review suggestion</button>}
        <button type="button" className="button-secondary" disabled={!online || expired || disabled || busy || !!attempt} onClick={()=>review(artifact,'reject')}>Reject suggestion</button>
      </div>}
    </div>)}
    {query.data && !query.data.artifacts.length && <p className="text-sm text-stone-500">No assistance requested for this inspection.</p>}
    {selected && draft && <div className="rounded-xl border border-[#7b8c70] p-4 space-y-4">
      <h3 className="font-semibold">Review draft · Source version {selected.sourceVersion}</h3>
      {selected.original.warnings.map((warning,index)=><p key={index} className="text-sm text-amber-800">{warning}</p>)}
      {selected.original.transcript && <p className="whitespace-pre-wrap text-sm">Original transcript: {selected.original.transcript}</p>}
      <fieldset disabled={busy || !!attempt || disabled} className="space-y-4">
        {inspection.template.items.map((item)=><div key={item.id} className="space-y-2"><p className="text-sm font-medium">{item.label}</p>
          <label className="block text-sm">Reviewed outcome<select aria-label={`Reviewed outcome: ${item.label}`} className="input mt-1" value={draft.answers.find((row)=>row.itemId===item.id).outcome ?? ''}
            onChange={(event)=>setDraft({ ...draft,answers:draft.answers.map((row)=>row.itemId===item.id?{ ...row,outcome:event.target.value || null }:row) })}>
            <option value="">Unanswered</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="not_applicable">Not applicable</option></select></label>
          <label className="block text-sm">Reviewed notes<textarea aria-label={`Reviewed notes: ${item.label}`} rows={2} maxLength={1000} className="input mt-1" value={draft.answers.find((row)=>row.itemId===item.id).notes}
            onChange={(event)=>setDraft({ ...draft,answers:draft.answers.map((row)=>row.itemId===item.id?{ ...row,notes:event.target.value }:row) })} /></label>
        </div>)}
        <label className="block text-sm">Reviewed report summary<textarea aria-label="Reviewed report summary" className="input mt-2" rows={5} maxLength={10000} value={draft.reportText} onChange={(event)=>setDraft({ ...draft,reportText:event.target.value })} /></label>
        <label className="block text-sm"><input type="checkbox" checked={confirmed} onChange={(event)=>setConfirmed(event.target.checked)} /> I checked this draft against the inspection and accept these edits.</label>
        <div className="flex flex-wrap gap-3"><button type="button" className="button-primary" disabled={!confirmed || !canRequest || selected.sourceVersion!==inspection.version} onClick={()=>review(selected,'apply')}>Apply reviewed edits</button>
          <button type="button" className="button-secondary" onClick={()=>setSelected(null)}>Close draft</button></div>
      </fieldset>
    </div>}
  </section>;
}
