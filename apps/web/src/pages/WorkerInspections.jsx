import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { INSPECTION_STATUSES } from '@fieldsync/contracts';
import { useOffline } from '../offline/provider.jsx';
import { mayEdit } from '../offline/store.js';
import { mergeContent } from '../offline/state.js';
import { ErrorNotice, PageIntro } from '../components/ui.jsx';
import { InspectionReport, InspectionStatus, AuditHistory } from '../components/inspection-ui.jsx';
import { EvidenceEditor,EvidencePanel } from '../components/evidence-ui.jsx';
import { AiPanel } from '../components/ai-ui.jsx';

export function WorkerInspections() {
  const { snapshot, error, online, wake } = useOffline();
  const [params, setParams] = useSearchParams();
  const allowed = ['all', ...Object.values(INSPECTION_STATUSES)];
  const status = allowed.includes(params.get('status')) ? params.get('status') : 'all';
  const records = snapshot.records.filter((row) => status === 'all' || row.inspection.status === status);
  return <><PageIntro eyebrow="Your inspections" title="Every check, accounted for." action={<button className="button-secondary" onClick={wake}>Sync now</button>}>
    Checklists are saved on this device and synchronized when connected. Open assigned work online before taking it into the field.</PageIntro>
    <ErrorNotice error={error} />
    <label className="mb-5 block max-w-sm text-sm font-medium">Status<select aria-label="Status" className="input mt-2" value={status} onChange={(event) => setParams({ status: event.target.value })}>
      {allowed.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
    <div className="space-y-4">{records.map(({ inspection, unavailable }) => <Link key={inspection.id} to={`/inspections/${inspection.id}`} className="panel block hover:border-[#7b8c70]">
      <div className="flex flex-wrap justify-between gap-3"><div><h2 className="font-semibold">{inspection.asset.code} · {inspection.asset.name}</h2>
        <p className="mt-2 text-sm text-stone-500">{inspection.template.name}</p></div><InspectionStatus status={inspection.status} /></div>
      {snapshot.queue.some((entry) => entry.inspectionId === inspection.id) && <p className="mt-3 text-sm text-amber-800">Local changes awaiting sync</p>}
      {unavailable && <p className="mt-3 text-sm text-amber-800">Retained copy · assignment unavailable</p>}
    </Link>)}</div>{!records.length && <p className="panel text-sm text-stone-500">{online ? 'No cached inspections match this status. Sync to check assignments.' : 'No inspections cached for this status. Reconnect to load assignments.'}</p>}
  </>;
}

function useEditorLock(name, writes) {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    setLocked(false);
    if (!navigator.locks) return;
    const controller = new AbortController(); let release;
    navigator.locks.request(name, { signal: controller.signal }, async () => {
      setLocked(true); await new Promise((resolve) => { release = resolve; });
    }).catch(() => {});
    return () => { controller.abort(); writes.current.finally(() => release?.()); };
  }, [name]);
  return locked;
}

function ConflictReview({ copy, disabled }) {
  const { store, snapshot, refresh, wake } = useOffline();
  const [choices, setChoices] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const merge = mergeContent(copy.conflict.base, copy.content, copy.conflict.remote, choices);
  async function resolve(action) {
    setBusy(true); setError(null);
    try {
      const remote = await refresh(copy.id);
      if (!remote) throw new Error('Reconnect and sign in to confirm the latest server version.');
      if (remote.version !== copy.conflict.remote.version) {
        await store.pause(snapshot.queue.find((entry) => entry.inspectionId === copy.id), 'The remote version changed. Review again.', remote);
        throw new Error('The remote version changed. Review the updated comparison.');
      }
      await store.resolve(copy.id, remote, merge.content, action, copy.generation); wake();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <section className="panel mt-6 space-y-4"><h2 className="text-xl font-semibold">Resolve sync conflict</h2>
    <p className="text-sm text-stone-600">Your edits are retained. Compare base version {copy.conflict.base.version}, this device, and server version {copy.conflict.remote.version}. Independent edits are combined; choose each overlapping field.</p>
    <ErrorNotice error={error} />
    {merge.conflicts.map((field) => <fieldset key={field.key} className="rounded-xl border p-4" disabled={disabled || busy}>
      <legend className="text-sm font-semibold">{field.label}</legend>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm text-stone-500">Base: {field.base ?? 'Unanswered'}</p>
      {['local', 'remote'].map((side) => <label key={side} className="mb-3 block whitespace-pre-wrap break-words text-sm"><input type="radio" name={field.key} checked={choices[field.key] === side}
        onChange={() => setChoices({ ...choices, [field.key]: side })} /> {side === 'local' ? 'This device' : 'Server'}: {field[side] ?? 'Unanswered'}</label>)}
    </fieldset>)}
    <details><summary className="cursor-pointer text-sm">Preview merged checklist and summary</summary><InspectionReport inspection={{ ...copy.conflict.remote, ...merge.content }} /></details>
    <div className="flex flex-wrap gap-3"><button className="button-secondary" disabled={disabled || busy || !merge.complete} onClick={() => resolve('save')}>Save merged draft</button>
      <button className="button-primary" disabled={disabled || busy || !merge.complete} onClick={() => resolve('submit')}>Submit merged report</button></div>
  </section>;
}

function LocalEditor({ copy, queue }) {
  const { store, wake, refresh } = useOffline();
  const writes = useRef(Promise.resolve());
  const locked = useEditorLock(`${store.name}:editor:${copy.id}`, writes);
  const [draft, setDraft] = useState(copy.content);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(0);
  const [reviewError, setReviewError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [aiBusy,setAiBusy] = useState(false),[recording,setRecording] = useState(false);
  const latest = useRef(copy.content);
  const committedGeneration = useRef(copy.generation);
  const dirty = useRef(false);
  useEffect(() => {
    // The transaction can finish before Dexie's live-query notification arrives.
    // Never restore an older render over the just-committed input buffer.
    if (!dirty.current && pending === 0 && copy.generation >= committedGeneration.current) { latest.current = copy.content; setDraft(copy.content); }
  }, [copy.content, copy.generation, pending]);
  const editable = locked && !submitting && !aiBusy && mayEdit(copy, queue);
  async function prepareReview() {
    await writes.current;
    const current=await store.snapshot(copy.id);
    if (!locked || dirty.current || current.queue.some((entry)=>entry.inspectionId===copy.id)
      || current.copy.generation!==copy.generation || current.copy.base.version!==copy.base.version) throw new Error('Sync and review your current device edits first.');
    return { generation:current.copy.generation,baseVersion:current.copy.base.version };
  }
  async function acceptReview(saved,expected) {
    const applied=await store.acceptReview(saved,expected);
    if (applied) {
      const current=await store.db.workingCopies.get(copy.id);
      committedGeneration.current=current.generation; dirty.current=false;
      latest.current=current.content; setDraft(current.content);
    }
    wake();
  }
  function persist(content, action = 'save') {
    if (action === 'submit') setSubmitting(true);
    dirty.current = true; setPending((count) => count + 1); setError(null);
    writes.current = writes.current.then(() => store.save(copy.id, content, action, copy)).then((result) => {
      committedGeneration.current = Math.max(committedGeneration.current, result.copy.generation);
      if (latest.current === content) dirty.current = false;
      wake();
    }).catch((failure) => { setError(failure); if (action === 'submit') setSubmitting(false); }).finally(() => setPending((count) => count - 1));
    return writes.current;
  }
  useEffect(() => {
    if (copy.conflict || copy.blocked || queue.some((entry) => entry.action === 'submit') || !['assigned', 'draft', 'changes_requested'].includes(copy.base.status)) setSubmitting(false);
  }, [copy.conflict, copy.blocked, copy.base.status, queue]);
  function change(content) { latest.current = content; setDraft(content); persist(content); }
  function fileAction(operation) {
    setPending((count)=>count+1);
    const task=writes.current.then(operation).then(async()=> {
      const current=await store.db.workingCopies.get(copy.id);
      committedGeneration.current=Math.max(committedGeneration.current,current.generation); wake();
    });
    writes.current=task.catch(()=>{}).finally(()=>setPending((count)=>count-1));
    return task;
  }
  return <><form className="panel print-hidden space-y-5" onSubmit={(event) => {
    event.preventDefault(); persist(latest.current, event.nativeEvent.submitter?.value === 'submit' ? 'submit' : 'save');
  }}><div className="flex flex-wrap justify-between gap-3"><h2 className="text-xl font-semibold">Complete checklist</h2><span className="text-xs text-stone-500">Base version {copy.base.version}</span></div>
    <p className="text-sm text-stone-500">Every edit is saved locally. Answer each item and explain failed checks before submitting.</p>
    {copy.base.reviewNote && <p className="rounded-xl bg-amber-50 p-4 text-sm">Changes requested: {copy.base.reviewNote}</p>}
    {!locked && <p className="text-sm text-amber-800">Another tab may be editing this checklist. Close it to edit here. Web Locks support is required.</p>}
    {copy.blocked && <p className="text-sm text-amber-800">{copy.blocked}</p>}
    {copy.blocked && queue.length > 0 && <button type="button" className="button-secondary" disabled={!locked || pending > 0} onClick={async () => {
      setReviewError(null);
      try {
        const remote = await refresh(copy.id);
        if (!remote) throw new Error('Reconnect and sign in to review the current assignment.');
        await store.pause(queue[0], 'The assignment remains read-only. Local work is retained.', remote);
      } catch (failure) { setReviewError(failure); }
    }}>Review current assignment</button>}
    {queue.some((entry) => entry.action === 'submit' && !['conflict', 'blocked'].includes(entry.status)) && <p role="status" className="text-sm text-amber-800">Submission queued. Local work is retained until acknowledged.</p>}
    {queue.some((entry) => entry.action === 'submit' && entry.status === 'attempted' && entry.error) && <p role="status" className="text-sm text-amber-800">Evidence verification is still running. Submission will retry automatically.</p>}
    <ErrorNotice error={error ?? reviewError} />
    <p role="status" className="text-sm text-emerald-800">{pending ? 'Saving on this device…' : error ? 'Device save failed. Keep this page open and retry.' : 'Saved on this device.'}</p>
    {error && <button type="button" className="button-secondary" disabled={!editable || pending > 0} onClick={() => persist(latest.current)}>Retry device save</button>}
    <fieldset disabled={!editable} className="space-y-5">{copy.base.template.items.map((item, index) => {
      const answer = draft.answers.find((entry) => entry.itemId === item.id);
      function changeAnswer(field, value) { change({ ...latest.current, answers: latest.current.answers.map((entry) => entry.itemId === item.id ? { ...entry, [field]: value } : entry) }); }
      return <div key={item.id} className="rounded-xl border border-stone-200 p-4"><h3 className="mb-3 text-sm font-semibold">{index + 1}. {item.label}</h3>
        <label className="block text-sm">Outcome<select aria-label="Outcome" className="input mt-2" value={answer.outcome ?? ''} onChange={(event) => changeAnswer('outcome', event.target.value || null)}>
          <option value="">Unanswered</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="not_applicable">Not applicable</option></select></label>
        <label className="mt-3 block text-sm">Notes{answer.outcome === 'fail' ? ' (required before submission)' : ''}<textarea aria-label={answer.outcome === 'fail' ? 'Notes (required before submission)' : 'Notes'} className="input mt-2" rows={2} maxLength={1000}
          value={answer.notes} onChange={(event) => changeAnswer('notes', event.target.value)} /></label>
      </div>;
    })}<label className="block text-sm font-medium">Report summary<textarea aria-label="Report summary" className="input mt-2" rows={5} maxLength={10000} value={draft.reportText}
      onChange={(event) => change({ ...latest.current, reportText: event.target.value })} /></label>
      <EvidenceEditor copy={copy} disabled={!editable || pending>0 || !!copy.conflict} execute={fileAction} onRecordingChange={setRecording} />
      <div className="flex flex-wrap gap-3"><button value="save" className="button-secondary" disabled={pending > 0 || recording}>Save draft</button><button value="submit" className="button-primary" disabled={pending > 0 || recording || !!error || !!copy.conflict}>Submit for review</button></div>
    </fieldset></form>
    <AiPanel inspection={copy.base} content={draft} disabled={!locked || pending>0 || recording || dirty.current || !!error || !!copy.conflict || !!copy.blocked || submitting || queue.length>0}
      prepareReview={prepareReview} acceptReview={acceptReview} onBusyChange={setAiBusy} />
    {copy.conflict && <ConflictReview key={`${copy.generation}:${copy.conflict.remote.version}`} copy={copy} disabled={!locked || pending > 0 || aiBusy || !!error} />}
  </>;
}

export function WorkerInspectionDetail() {
  const { id } = useParams();
  const { snapshot, refresh, error } = useOffline();
  const record = snapshot.records.find((row) => row.id === id);
  const copy = snapshot.copies.find((row) => row.id === id);
  const queue = snapshot.queue.filter((entry) => entry.inspectionId === id);
  const [revision, setRevision] = useState('');
  const [loadError, setLoadError] = useState(null);
  useEffect(() => { setLoadError(null); refresh(id).catch(setLoadError); }, [id, copy?.base.version]);
  const shown = record?.detail?.revisions.find((entry) => String(entry.version) === revision)?.snapshot;
  return <><Link to="/inspections" className="print-hidden mb-6 inline-block text-sm text-[#315248]">← Inspections</Link><ErrorNotice error={error ?? loadError} />
    {!copy ? <p className="panel text-sm">This inspection has not been cached. Reconnect to load it.</p> : <>
      <PageIntro eyebrow="Inspection" title={`${copy.base.asset.code} · ${copy.base.template.name}`} action={<button className="button-secondary" onClick={() => window.print()}>Print report</button>}>
        Assigned to {copy.base.worker.name}. <InspectionStatus status={record?.inspection.status ?? copy.base.status} /></PageIntro>
      {!revision && (['assigned', 'draft', 'changes_requested'].includes(copy.base.status) || queue.length > 0 || copy.blocked) && <LocalEditor key={id} copy={copy} queue={queue} />}
      <label className="print-hidden mt-6 block max-w-sm text-sm font-medium">Report version<select aria-label="Report version" className="input mt-2" value={revision} onChange={(event) => setRevision(event.target.value)}>
        <option value="">Current version ({copy.base.version})</option>{record?.detail?.revisions.filter((entry) => entry.version !== copy.base.version).map((entry) =>
          <option key={entry.id} value={String(entry.version)}>Historical version {entry.version}</option>)}</select></label>
      {revision && <p className="mt-4 text-sm text-amber-800">Historical report · Version {revision}</p>}
      <InspectionReport inspection={shown ?? { ...copy.base, ...copy.content }} /><EvidencePanel inspection={shown ?? copy.base} /><AuditHistory events={record?.detail?.events ?? []} />
      {!revision && !(['assigned','draft','changes_requested'].includes(copy.base.status) || queue.length>0 || copy.blocked) && <AiPanel inspection={copy.base} readOnly />}
    </>}
  </>;
}
