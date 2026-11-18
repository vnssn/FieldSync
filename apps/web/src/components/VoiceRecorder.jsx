import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from './ui.jsx';

export function VoiceRecorder({ disabled, save, onRecordingChange }) {
  const recorder = useRef(null), stream = useRef(null), timer = useRef(null), mounted = useRef(true);
  const [recording,setRecording] = useState(false), [starting,setStarting] = useState(false);
  const [seconds,setSeconds] = useState(0), [file,setFile] = useState(null), [busy,setBusy] = useState(false);
  const [error,setError] = useState(null), [saved,setSaved] = useState(false);
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  function release() { clearInterval(timer.current); stream.current?.getTracks().forEach((track) => track.stop()); stream.current=null; }
  useEffect(() => {
    mounted.current=true;
    return () => { mounted.current=false; if (recorder.current?.state==='recording') recorder.current.stop(); release(); onRecordingChange?.(false); };
  }, []);
  async function start() {
    setStarting(true); setError(null); setSaved(false); onRecordingChange?.(true);
    try {
      const type = ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/ogg'].find((value) => MediaRecorder.isTypeSupported(value));
      if (!type) throw new Error('This browser cannot record a supported audio format. Attach an MP3, WAV, Ogg or WebM file instead.');
      const audio = await navigator.mediaDevices.getUserMedia({ audio:true });
      if (!mounted.current) { audio.getTracks().forEach((track) => track.stop()); return; }
      stream.current=audio;
      const capture = new MediaRecorder(audio,{ mimeType:type,audioBitsPerSecond:64000 }), chunks=[];
      recorder.current=capture;
      capture.ondataavailable=(event) => { if (event.data.size) chunks.push(event.data); };
      capture.onerror=() => { if (mounted.current) setError(new Error('Recording failed. Keep any captured audio and retry.')); };
      capture.onstop=() => {
        release();
        if (!mounted.current) return;
        const mimeType=capture.mimeType.split(';')[0], blob=new Blob(chunks,{ type:mimeType });
        setRecording(false); onRecordingChange?.(false);
        if (!blob.size) { setError(new Error('No audio was captured. Try again.')); return; }
        const captured=new File([blob],`voice-${new Date().toISOString().replaceAll(':','-')}.${mimeType==='audio/ogg'?'ogg':'webm'}`,{ type:mimeType });
        setFile(captured);
      };
      capture.start(1000); setSeconds(0); setRecording(true);
      const started=Date.now();
      timer.current=setInterval(() => {
        const elapsed=Math.floor((Date.now()-started)/1000); setSeconds(elapsed);
        if (elapsed>=300 && capture.state==='recording') capture.stop();
      },500);
    } catch (failure) {
      release(); onRecordingChange?.(false);
      if (mounted.current) setError(new Error(failure.name==='NotAllowedError' ? 'Microphone access was denied. Allow it in browser settings or attach an audio file.':failure.message));
    } finally { if (mounted.current) setStarting(false); }
  }
  async function attach() {
    setBusy(true); setError(null);
    try { await save(file); setFile(null); setSaved(true); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  return <div className="rounded-xl border border-stone-200 p-4 space-y-3">
    <h4 className="font-medium">Record a voice note</h4>
    <p className="text-sm text-stone-500">Works offline. Record up to five minutes, then attach the recording before leaving this page. You can request a transcript after it uploads.</p>
    {!supported && <p className="text-sm text-amber-800">Microphone recording needs a supported browser on HTTPS or localhost. You can attach an audio file instead.</p>}
    <ErrorNotice error={error} />
    <div className="flex flex-wrap gap-3">
      {!recording && <button type="button" className="button-secondary" disabled={disabled || starting || busy || !supported || !!file} onClick={start}>{starting?'Opening microphone…':'Record voice note'}</button>}
      {recording && <button type="button" className="button-secondary" onClick={() => recorder.current?.stop()}>Stop recording</button>}
      {file && <button type="button" className="button-primary" disabled={disabled || busy} onClick={attach}>{busy?'Saving recording…':'Attach recording'}</button>}
      {file && <button type="button" className="button-secondary" disabled={busy} onClick={() => { setFile(null); setError(null); }}>Discard recording</button>}
    </div>
    {recording && <p role="status" className="text-sm">Recording · {seconds}s</p>}
    {file && <p role="status" className="text-sm text-amber-800">Recording captured · {(file.size/1024).toFixed(1)} KiB. {error?'Still retained here; free storage and retry.':'Attach it to save on this device.'}</p>}
    {saved && <p role="status" className="text-sm text-emerald-800">Voice recording saved on this device; upload queued.</p>}
  </div>;
}
