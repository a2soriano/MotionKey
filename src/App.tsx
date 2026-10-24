import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Command, Download, Fingerprint, Hand, Keyboard, LayoutDashboard, LoaderCircle, LockKeyhole, Maximize2, Monitor, MoreHorizontal, MousePointer2, MoveHorizontal, Pause, Play, Plus, Power, ScanFace, Settings2, ShieldCheck, SlidersHorizontal, Smile, Sparkles, Square, ThumbsUp, Trash2, X, Zap } from 'lucide-react';
import { COMMANDS, GestureGate, commandLabel, readMappings, readSettings } from './domain';
import type { Mapping, Settings } from './domain';
import { BRIDGE_URL, bridgeRequest } from './bridge';
import { ensureVisionAssets } from './visionAssets';
import type { BridgeHealth } from './bridge';
import { createVisionTracker, getPoseSignature, signatureDistance } from './vision';
import type { VisionFrame, VisionTracker } from './vision';

type Page = 'studio' | 'library' | 'activity' | 'settings';
type Log = { id: string; time: Date; gesture: string; command: string; state: 'success' | 'error' | 'preview'; detail: string };
const emptyFrame: VisionFrame = { hands: [], face: null, candidates: [], fps: 0 };
const connections = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];

function GestureIcon({ id, size = 26 }: { id: string; size?: number }) {
  if (id === 'thumbs_up') return <ThumbsUp size={size} strokeWidth={1.6} />;
  if (id === 'victory') return <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15 6 5C5 2 8 1 9 4l5 10 2-11c.6-3 4-2 3.5 1L18 16c5-4 7 0 4 3l-3 5c-4 5-12 1-13-3l-2-5c-1-3 2-4 4-1l2 3"/><path d="m10 15 7 2c3 1 2 4 0 4l-5-1m2-6 4 2"/></svg>;
  if (id.includes('swipe')) return <MoveHorizontal size={size} strokeWidth={1.6} />;
  if (id === 'pinch') return <MousePointer2 size={size} strokeWidth={1.6} />;
  if (id === 'pointing_up') return <MousePointer2 size={size} strokeWidth={1.6}/>;
  if (id === 'smile') return <Smile size={size} strokeWidth={1.6} />;
  if (['blink', 'head_left', 'head_right'].includes(id)) return <ScanFace size={size} strokeWidth={1.6} />;
  if (id === 'closed_fist') return <Square size={size} strokeWidth={1.6} />;
  if (id.startsWith('custom_')) return <Fingerprint size={size} strokeWidth={1.6} />;
  return <Hand size={size} strokeWidth={1.6} />;
}
function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={e => { e.stopPropagation(); onChange(); }} disabled={disabled}><span /></button>;
}
function Modal({ title, subtitle, children, close }: { title: string; subtitle?: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = ref.current;
    panel?.querySelector<HTMLElement>('input, button, select')?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab' && panel) {
        const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href], textarea')];
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}><button className="icon-button modal-close" onClick={close} aria-label="Close dialog"><X size={19}/></button><div className="modal-symbol"><Command size={24}/></div><h2>{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}{children}</div></div>;
}
function HandIllustration() {
  return <div className="hand-art" aria-hidden="true"><div className="scan-corner tl"/><div className="scan-corner tr"/><div className="scan-corner bl"/><div className="scan-corner br"/><svg viewBox="0 0 190 210" fill="none"><path d="M60 165C48 150 41 137 31 120C24 107 28 97 36 97C42 96 48 105 58 117L58 60C58 46 74 45 75 59L76 99L76 33C76 18 94 18 94 33L95 95L98 22C99 8 116 10 116 24L115 97L123 43C125 28 142 32 139 47L132 112C141 102 144 87 155 87C167 89 158 108 153 123L137 166C128 183 118 194 96 194C80 193 69 181 60 165Z" fill="url(#handFill)" stroke="#a69bdc" strokeWidth="1.5"/><path d="M96 181L84 136L66 118M84 136L66 76M84 136L85 49M84 136L106 43M84 136L127 61M84 136L145 109" stroke="#b2a5ff" strokeWidth="1" opacity=".7"/>{[[96,181],[84,136],[66,118],[66,76],[85,49],[106,43],[127,61],[145,109]].map(([x,y],i)=><g key={i}><circle cx={x} cy={y} r="6" fill="#ad9cff" opacity=".12"/><circle cx={x} cy={y} r="2.7" fill="#b8a5ff"/></g>)}<defs><linearGradient id="handFill" x1="130" y1="20" x2="40" y2="190"><stop stopColor="#7f6bb6" stopOpacity=".3"/><stop offset="1" stopColor="#7f6bb6" stopOpacity=".04"/></linearGradient></defs></svg><span className="float-label"><span/>21 tracking points</span></div>;
}

export default function App() {
  const [page, setPage] = useState<Page>('studio');
  const [mappings, setMappings] = useState(readMappings);
  const [settings, setSettings] = useState(readSettings);
  const [filter, setFilter] = useState('all');
  const [camera, setCamera] = useState<'off' | 'loading' | 'on'>('off');
  const [cameraError, setCameraError] = useState('');
  const [frame, setFrame] = useState<VisionFrame>(emptyFrame);
  const [paused, setPaused] = useState(false);
  const [armed, setArmed] = useState(false);
  const [bridge, setBridge] = useState<BridgeHealth | null>(null);
  const [token, setToken] = useState(() => sessionStorage.getItem('motionkey.token') ?? '');
  const [pairOpen, setPairOpen] = useState(false);
  const [pairError, setPairError] = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [editing, setEditing] = useState<Mapping | null>(null);
  const [creating, setCreating] = useState(false);
  const [customName, setCustomName] = useState('');
  const [samples, setSamples] = useState<number[][]>([]);
  const [customCommand, setCustomCommand] = useState('play_pause');
  const [toast, setToast] = useState('');
  const [help, setHelp] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraPanel = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<VisionTracker | null>(null);
  const gate = useRef(new GestureGate());
  const frameRef = useRef<VisionFrame>(emptyFrame);
  const session = useRef(0);
  const renderTime = useRef(0);
  const busy = useRef(false);
  const activeRef = useRef({ mappings, settings, paused, armed, token, bridge, modalOpen: false });
  activeRef.current = { mappings, settings, paused, armed, token, bridge, modalOpen: !!editing || creating || pairOpen || help || page === 'settings' };
  const connected = !!bridge?.authenticated;
  const enabled = mappings.filter(m => m.enabled).length;
  const successful = logs.filter(l => l.state === 'success').length;
  const preview = !connected || !armed;

  useEffect(() => { try { localStorage.setItem('motionkey.mappings.v1', JSON.stringify(mappings)); } catch { setToast('Browser storage is unavailable. Your changes will last for this session.'); } }, [mappings]);
  useEffect(() => { try { localStorage.setItem('motionkey.settings.v1', JSON.stringify(settings)); } catch { /* session still works */ } }, [settings]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4500); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    if (page !== 'studio' && camera !== 'off') { stopCamera(); setToast('Camera stopped when leaving the studio. Return to the studio to keep tracking.'); }
  }, [page]);
  useEffect(() => () => { session.current++; trackerRef.current?.stop(); streamRef.current?.getTracks().forEach(t => t.stop()); }, []);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const check = async () => { try { const result = await bridgeRequest<BridgeHealth>('/health', token); if (alive) { setBridge(result); if (!result.authenticated) setArmed(false); } } catch { if (alive) { setBridge(null); setArmed(false); } } };
    void check();
    const id = setInterval(check, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [token]);

  function addLog(mapping: Mapping, state: Log['state'], detail: string) {
    setLogs(old => [{ id: crypto.randomUUID(), time: new Date(), gesture: mapping.name, command: commandLabel(mapping.command), state, detail }, ...old].slice(0, 100));
  }
  function stopCamera() {
    session.current++;
    trackerRef.current?.stop(); trackerRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera('off'); setFrame(emptyFrame); frameRef.current = emptyFrame; setArmed(false); gate.current.reset();
  }
  async function fire(mapping: Mapping) {
    const current = activeRef.current;
    if (busy.current || current.modalOpen || current.paused) return;
    if (!current.armed || !current.bridge?.authenticated) { addLog(mapping, 'preview', 'Recognized only. Desktop control is not armed.'); return; }
    busy.current = true;
    try {
      await bridgeRequest('/command', current.token, { command: mapping.command });
      addLog(mapping, current.bridge.mode === 'dry-run' ? 'preview' : 'success', current.bridge.mode === 'dry-run' ? 'Dry-run companion: no key was sent.' : 'Sent to the active desktop application.');
    } catch (error) { addLog(mapping, 'error', (error as Error).message); setArmed(false); setToast('Desktop control paused. Check your companion connection.'); }
    finally { busy.current = false; }
  }
  function handleFrame(next: VisionFrame) {
    frameRef.current = next;
    const current = activeRef.current;
    const candidates = [...next.candidates];
    let best: { mapping: Mapping; distance: number } | null = null;
    for (const hand of next.hands) {
      const signature = getPoseSignature(hand.landmarks);
      for (const m of current.mappings.filter(m => m.kind === 'custom' && m.enabled)) {
        const distance = Math.min(...(m.samples ?? []).map(s => signatureDistance(signature, s)));
        if (distance < 0.17 && (!best || distance < best.distance)) best = { mapping: m, distance };
      }
    }
    if (best) candidates.unshift({ id: best.mapping.id, confidence: Math.max(0.8, 1 - best.distance) });
    if (!current.paused && !current.modalOpen) {
      const result = gate.current.update(candidates, current.mappings, performance.now(), current.settings);
      if (result) void fire(result);
    } else gate.current.reset();
    drawLandmarks(next, current.settings);
    if (performance.now() - renderTime.current > 110) { setFrame({ ...next, candidates }); renderTime.current = performance.now(); }
  }
  function drawLandmarks(next: VisionFrame, config: Settings) {
    const canvas = canvasRef.current, video = videoRef.current;
    if (!canvas || !video) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!config.showLandmarks) return;
    ctx.lineWidth = Math.max(2, w / 450); ctx.strokeStyle = '#b6ffcf'; ctx.fillStyle = '#d9ffe6';
    next.hands.forEach(hand => {
      connections.forEach(([a,b]) => { ctx.beginPath(); ctx.moveTo(hand.landmarks[a].x*w, hand.landmarks[a].y*h); ctx.lineTo(hand.landmarks[b].x*w, hand.landmarks[b].y*h); ctx.stroke(); });
      hand.landmarks.forEach(p => { ctx.beginPath(); ctx.arc(p.x*w, p.y*h, w/280, 0, Math.PI*2); ctx.fill(); });
    });
    if (config.faceEnabled && next.face?.present) {
      const points = next.face.landmarks;
      const xs = points.map(p=>p.x), ys = points.map(p=>p.y);
      ctx.strokeStyle = '#c3afff'; ctx.setLineDash([8,6]);
      ctx.strokeRect(Math.min(...xs)*w, Math.min(...ys)*h, (Math.max(...xs)-Math.min(...xs))*w, (Math.max(...ys)-Math.min(...ys))*h); ctx.setLineDash([]);
    }
  }
  async function startCamera() {
    if (camera !== 'off') return;
    const ticket = ++session.current;
    setCamera('loading'); setCameraError(''); setPaused(false); gate.current.reset();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost. Open MotionKey using the local companion.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      if (ticket !== session.current) { stream.getTracks().forEach(t=>t.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current!; video.srcObject = stream; await video.play();
      await ensureVisionAssets(settings.faceEnabled);
      if (ticket !== session.current) return;
      const tracker = await createVisionTracker(video, handleFrame, { faceEnabled: settings.faceEnabled, onError: e => { stopCamera(); setCameraError(`Tracking stopped: ${e.message}`); } });
      if (ticket !== session.current) { tracker.stop(); return; }
      trackerRef.current = tracker;
      stream.getVideoTracks()[0].onended = () => { stopCamera(); setCameraError('Camera disconnected. Reconnect it and enable the camera again.'); };
      setCamera('on');
    } catch (error) {
      if (ticket !== session.current) return;
      stopCamera();
      const e = error as Error;
      setCameraError(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser, then try again.' : e.name === 'NotFoundError' ? 'No webcam found. Connect a camera and try again.' : e.name === 'NotReadableError' ? 'Your camera is in use. Close other camera apps and try again.' : e.message);
    }
  }
  async function pair(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setPairLoading(true); setPairError('');
    const value = new FormData(e.currentTarget).get('token')?.toString().trim() ?? '';
    try {
      const health = await bridgeRequest<BridgeHealth>('/health', value);
      if (!health.authenticated) throw new Error('That token does not match. Copy the current pairing token from the companion terminal.');
      setBridge(health); setToken(value); sessionStorage.setItem('motionkey.token', value); setPairOpen(false); setToast(health.mode === 'dry-run' ? 'Connected in dry-run mode. No desktop keys will be sent.' : 'Desktop connected. Enable your camera, then arm control when ready.');
    } catch (error) { setPairError(error instanceof TypeError ? 'Companion not reachable. Start it on this computer and check the setup steps below.' : (error as Error).message); }
    finally { setPairLoading(false); }
  }
  function toggleMapping(id: string) { setMappings(old=>old.map(m=>m.id===id?{...m,enabled:!m.enabled}:m)); gate.current.reset(); }
  function openCreate() { setSamples([]); setCustomName(''); setCustomCommand('play_pause'); setCreating(true); }
  function capturePose() {
    const hand = frameRef.current.hands[0];
    if (camera !== 'on' || !hand) { setToast('Enable the camera and hold one hand in view first.'); return; }
    setSamples(old => [...old.slice(0, 4), getPoseSignature(hand.landmarks)]);
  }
  function createCustom(e: FormEvent) {
    e.preventDefault();
    if (!customName.trim() || samples.length < 3) return;
    setMappings(old=>[...old,{id:`custom_${crypto.randomUUID()}`,name:customName.trim(),kind:'custom',command:customCommand,enabled:true,description:'Your recorded hand pose. Hold it steady to trigger.',samples}]);
    setCreating(false); setToast('Custom gesture saved. Try it with desktop control disarmed first.'); gate.current.reset();
  }
  function exportMappings() {
    const blob = new Blob([JSON.stringify({ version: 1, mappings, settings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='motionkey-gestures.json'; a.click(); URL.revokeObjectURL(url); setToast('Your gesture profile has been exported.');
  }
  const visible = mappings.filter(m => filter === 'all' || m.kind === filter);
  const recognized = frame.candidates[0];
  const recognizedName = recognized ? mappings.find(m=>m.id===recognized.id)?.name : null;
  const changeSettings = (patch: Partial<Settings>) => { setSettings(old=>({...old,...patch})); gate.current.reset(); };

  const gestureGrid = (limit?: number) => <div className="gesture-grid">{visible.slice(0, limit).map((mapping, index) => <article className={`gesture-card ${!mapping.enabled?'disabled-card':''}`} key={mapping.id}><div className="gesture-card-top"><div className={`gesture-symbol color-${mapping.kind==='face'?2:index%4}`}><GestureIcon id={mapping.id}/></div><Toggle checked={mapping.enabled} onChange={()=>toggleMapping(mapping.id)} label={`Enable ${mapping.name}`}/></div><button className="card-main" onClick={()=>setEditing({...mapping})}><h3>{mapping.name}</h3><p>{mapping.kind === 'custom' ? 'Custom hand pose' : mapping.kind === 'face' ? 'Face expression' : mapping.id.includes('swipe') ? 'Hand motion' : 'Hand gesture'}</p><div className="command-assignment"><span><ArrowDown size={13}/>{commandLabel(mapping.command)}</span><ChevronRight size={14}/></div></button><button className="card-edit" onClick={()=>setEditing({...mapping})} aria-label={`Edit ${mapping.name}`}><MoreHorizontal size={17}/></button></article>)}</div>;
  const filterBar = <div className="filter-row"><div className="tabs">{[['all','All gestures'],['hand','Hands'],['face','Face'],['custom','Custom']].map(([value,label])=><button key={value} className={filter===value?'selected':''} onClick={()=>setFilter(value)}>{label}{value==='all'&&<span>{mappings.length}</span>}</button>)}</div><span className="saved-note"><Check size={13}/> Saved on this device</span></div>;

  return <div className="app-shell"><aside className="sidebar"><a href="#" className="brand" onClick={e=>{e.preventDefault();setPage('studio');}}><span className="brand-symbol"><AudioLines size={22}/></span>motionkey<span className="brand-dot">.</span></a><div className="workspace-switch"><div className="workspace-avatar">P</div><div><strong>Personal workspace</strong><span>Make it your own</span></div><ChevronDown size={14}/></div><div className="nav-label">WORKSPACE</div><nav>{[{id:'studio',label:'Gesture studio',icon:LayoutDashboard},{id:'library',label:'My gestures',icon:Hand},{id:'activity',label:'Activity',icon:Activity},{id:'settings',label:'Settings',icon:Settings2}].map(({id,label,icon:Icon})=><button key={id} className={page===id?'nav-item active':'nav-item'} onClick={()=>setPage(id as Page)}><Icon size={18}/>{label}{id==='library'&&<span className="nav-count">{mappings.length}</span>}{page===id&&<span className="active-dot"/>}</button>)}</nav><div className="sidebar-tip"><div className="tip-icon"><Sparkles size={18}/></div><strong>Less clicking.<br/>More doing.</strong><p>Your next shortcut is<br/>already in your hands.</p><svg className="tip-squiggle" viewBox="0 0 140 120" fill="none" aria-hidden="true"><path d="M15 110C9 73 62 106 58 68S115 105 109 57s26-2 16-47" stroke="currentColor" strokeWidth="15" strokeLinecap="round"/></svg></div><div className="sidebar-bottom"><button className="help-link" onClick={()=>setHelp(true)}><CircleHelp size={17}/>Getting started<ArrowUpRight size={14}/></button><div className="local-tag"><span/><span>Private by design</span><LockKeyhole size={12}/></div><div className="profile"><div className="user-avatar">Y</div><div><strong>Your space</strong><span>Local profile</span></div><button className="icon-button" onClick={()=>setPage('settings')} aria-label="Profile settings"><Settings2 size={17}/></button></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs">Workspace<ChevronRight size={13}/><span>{({studio:'Gesture studio',library:'My gestures',activity:'Activity',settings:'Settings'})[page]}</span></div><div className="topbar-right"><span className="local-processing"><ShieldCheck size={14}/>On-device processing</span><span className="topbar-divider"/><button className={`connection-pill ${connected?'connected':''}`} onClick={()=>{setPairError('');setPairOpen(true);}}><span/>{connected?'Desktop connected':'Connect desktop'}<ChevronRight size={13}/></button></div></header>
    <main>
      {(page==='studio'||page==='library')&&<><section className="page-heading"><div><div className="eyebrow"><span/>YOUR SPACE, IN MOTION</div><h1>{page==='studio'?<>Make your move<span className="heading-dot">.</span></>:'Your gesture library.'}</h1><p>{page==='studio'?'Turn everyday gestures into effortless shortcuts.':'Small movements. Powerful possibilities. Make every gesture yours.'}</p></div><button className="button primary" onClick={openCreate}><Plus size={17}/>Create gesture</button></section>
      {page==='studio'&&<><div className="studio-layout"><section className="camera-card" ref={cameraPanel}><div className="panel-header"><div className="panel-title"><span className={camera==='on'?'status-dot live':'status-dot'}/><h2>Live preview</h2><span className="small-tag">{camera==='on'?(paused?'PAUSED':'LIVE'):'CAMERA OFF'}</span></div><div className="camera-tools"><button title="Expand camera" className="icon-button" aria-label="Expand camera" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else if(cameraPanel.current?.requestFullscreen)void cameraPanel.current.requestFullscreen().catch(()=>setToast('Full screen is unavailable in this browser.'));else setToast('Full screen is unavailable in this browser.');}}><Maximize2 size={15}/></button><button className="icon-button" aria-label="Camera settings" onClick={()=>setPage('settings')}><SlidersHorizontal size={16}/></button></div></div><div className={`camera-view ${camera==='on'?'is-live':''}`}><video ref={videoRef} muted playsInline className={camera==='on'?'visible':''}/><canvas ref={canvasRef} className={camera==='on'?'visible':''}/><div className="view-top"><span className="view-chip"><Hand size={13}/>Hands{settings.faceEnabled&&<><span className="chip-separator"/> <ScanFace size={13}/>Face</>}</span><span className="view-chip privacy-chip"><LockKeyhole size={11}/>100% local</span></div>{camera!=='on'&&<div className="camera-placeholder"><HandIllustration/><h2>Your hands. Your shortcuts.</h2><p>One camera. A whole new way to take control.</p><button className="button camera-enable" onClick={()=>void startCamera()} disabled={camera==='loading'}>{camera==='loading'?<LoaderCircle size={16} className="spin"/>:<Camera size={16}/>} {camera==='loading'?'Loading tracking models…':'Enable camera'}{camera!=='loading'&&<ArrowRight size={15}/>}</button><span className="camera-permission">Your video never leaves this device.</span></div>}{camera==='on'&&<><div className="tracking-overlay"><span className="view-chip"><span className="status-dot live"/>{frame.hands.length?`${frame.hands.length} hand${frame.hands.length>1?'s':''} detected`:'Show your hand to get started'}</span>{recognizedName&&<span className="recognized-badge"><CheckCircle2 size={14}/>{recognizedName}</span>}</div>{paused&&<div className="paused-overlay"><Pause size={30}/><strong>Recognition paused</strong><button className="button camera-enable" onClick={()=>setPaused(false)}><Play size={15}/>Resume tracking</button></div>}</>}<div className="view-bottom"><span><span className={`tiny-dot ${camera==='on'?'green':''}`}/>{camera==='loading'?'Preparing on-device recognition':camera==='on'?`${frame.fps} FPS · ${frame.face?.present?'Face detected':'Hand tracking'}`:'Ready when you are'}</span><span>MotionKey Vision <span className="version-tag">v1</span></span></div></div><div className="camera-footer"><div><span className={`footer-status ${camera==='on'?'online':''}`}><span/>{camera==='on'?(preview?'Preview mode':'Desktop control active'):'Waiting for camera'}</span><span className="footer-description">{camera==='on'?'Hold a gesture, then release to repeat.':'Good lighting works wonders.'}</span></div><div className="camera-actions">{camera==='on'&&<><button className="icon-button" onClick={()=>{setPaused(!paused);gate.current.reset();}} aria-label={paused?'Resume tracking':'Pause tracking'}>{paused?<Play size={16}/>:<Pause size={16}/>}</button><button className="icon-button" onClick={stopCamera} aria-label="Stop camera"><Power size={16}/></button></>}{camera==='loading'&&<button className="text-button" onClick={stopCamera}>Cancel</button>}<button className={`arm-button ${armed?'armed':''}`} disabled={camera!=='on'||!connected} onClick={()=>{setArmed(!armed);gate.current.reset();}} title={!connected?'Connect the desktop companion first':camera!=='on'?'Enable your camera first':'Send commands to the active desktop app'}><Zap size={13}/>{armed?'Disarm':'Arm control'}</button></div></div>{cameraError&&<div className="error-banner" role="alert">{cameraError}</div>}</section>
      <aside className="right-column"><section className="flow-card"><div className="flow-icon"><Zap size={18}/></div><span className="overline">BUILT AROUND YOU</span><h2>Find your flow.</h2><p>Your favorite actions,<br/>just a gesture away.</p><div className="quick-mappings">{mappings.filter(m=>m.enabled).slice(0,3).map((m,i)=><button key={m.id} onClick={()=>setEditing({...m})}><div className={`quick-icon color-${i}`}><GestureIcon id={m.id} size={19}/></div><div><strong>{m.name}</strong><span>{commandLabel(m.command)}</span></div><ArrowUpRight size={15}/></button>)}</div><button className="text-link" onClick={()=>setPage('library')}>Make it yours<ArrowRight size={14}/></button></section><button className="companion-card" onClick={()=>setPairOpen(true)}><span className="companion-icon"><Monitor size={21}/></span><div><strong>{connected?'Your desktop is connected':'Meet your desktop companion'}</strong><p>{connected?(bridge.mode==='dry-run'?'Dry-run mode · no keys sent':'Ready for your next move'):'Connect once. Control your computer.'}</p></div><ArrowUpRight size={17}/></button></aside></div>
      <section className="stats-row"><div><span className="stat-icon lavender"><Hand size={18}/></span><div><strong>{enabled}<span>gestures enabled</span></strong><p>A shortcut for every flow</p></div></div><div><span className="stat-icon peach"><Zap size={18}/></span><div><strong>{successful}<span>commands this session</span></strong><p>{successful?'Nice moves. Keep them coming.':'Your first move is the start'}</p></div></div><div><span className="stat-icon mint"><ShieldCheck size={18}/></span><div><strong>100%<span>on your device</span></strong><p>Your camera. Your privacy.</p></div></div></section></>}
      <section className="gestures-section"><div className="section-heading"><div><h2>{page==='studio'?'Your gestures':'All your moves'}<span className="count-badge">{mappings.length}</span></h2><p>Give your movements a little meaning.</p></div>{page==='studio'?<button className="text-link" onClick={()=>{setPage('library');setFilter('all');}}>View all gestures<ArrowRight size={15}/></button>:<button className="button secondary compact" onClick={exportMappings}><Download size={15}/>Export profile</button>}</div>{filterBar}{visible.length?gestureGrid(page==='studio'?6:undefined):<div className="empty-state"><Fingerprint size={32}/><h3>A gesture that’s all you.</h3><p>Record a hand pose and give it a command.</p><button className="button primary" onClick={openCreate}><Plus size={16}/>Create gesture</button></div>}</section></>}
      {page==='activity'&&<><section className="page-heading"><div><div className="eyebrow"><span/>A LITTLE MOMENTUM</div><h1>Your moves, in action.</h1><p>A live history of recognized gestures and desktop commands.</p></div><button className="button secondary" disabled={!logs.length} onClick={()=>setLogs([])}><Trash2 size={16}/>Clear activity</button></section><div className="activity-summary"><Activity size={24}/><div><strong>{successful} commands sent</strong><span>{logs.filter(l=>l.state==='preview').length} preview events · {logs.filter(l=>l.state==='error').length} errors · this session only</span></div><span className="small-tag">LOCAL HISTORY</span></div><section className="activity-list">{logs.length?logs.map(log=><div className="activity-item" key={log.id}><span className={`event-icon ${log.state}`}>{log.state==='success'?<Check size={18}/>:log.state==='error'?<X size={18}/>:<ScanFace size={18}/>}</span><div><strong>{log.gesture}<ArrowRight size={13}/>{log.command}</strong><p>{log.detail}</p></div><div className="event-time"><span>{log.state==='preview'?'Preview':log.state==='success'?'Sent':'Failed'}</span><time>{log.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time></div></div>):<div className="empty-state"><Activity size={36}/><h3>Every move starts somewhere.</h3><p>Enable your camera and try a gesture. Recognitions appear here,<br/>even before you connect your desktop.</p><button className="button primary" onClick={()=>setPage('studio')}><ArrowLeft size={16}/>Back to studio</button></div>}</section></>}
      {page==='settings'&&<><section className="page-heading"><div><div className="eyebrow"><span/>TUNE YOUR EXPERIENCE</div><h1>Feel right at home.</h1><p>A few thoughtful adjustments to make MotionKey yours.</p></div></section><div className="settings-layout"><section className="settings-panel"><div className="settings-title"><SlidersHorizontal size={20}/><div><h2>Recognition</h2><p>Find the balance between responsive and deliberate.</p></div></div><div className="setting-row"><div><strong>Gesture hold time</strong><p>How long to hold a pose before it triggers.</p></div><output>{(settings.dwell/1000).toFixed(1)}s</output><input aria-label="Gesture hold time" type="range" min="300" max="1500" step="100" value={settings.dwell} onChange={e=>changeSettings({dwell:+e.target.value})}/><div className="range-labels"><span>Responsive</span><span>Deliberate</span></div></div><div className="setting-row"><div><strong>Command cooldown</strong><p>The minimum pause between desktop commands.</p></div><output>{(settings.cooldown/1000).toFixed(2)}s</output><input aria-label="Command cooldown" type="range" min="750" max="5000" step="250" value={settings.cooldown} onChange={e=>changeSettings({cooldown:+e.target.value})}/><div className="range-labels"><span>0.75 seconds</span><span>5 seconds</span></div></div><div className="setting-row inline"><div><strong>Show tracking points</strong><p>Visualize your hand landmarks and face outline.</p></div><Toggle checked={settings.showLandmarks} onChange={()=>changeSettings({showLandmarks:!settings.showLandmarks})} label="Show tracking points"/></div><div className="setting-row inline"><div><strong>Face recognition</strong><p>{camera==='off'?'Track expressions and head movements. Not identity recognition.':'Stop the camera to change this setting.'}</p></div><Toggle checked={settings.faceEnabled} disabled={camera!=='off'} onChange={()=>changeSettings({faceEnabled:!settings.faceEnabled})} label="Enable face recognition"/></div></section><div><section className="settings-panel"><div className="settings-title"><Monitor size={20}/><div><h2>Desktop connection</h2><p>{connected?'Your companion is paired.':'Pair with your local companion.'}</p></div></div><div className="bridge-status"><span className={`status-dot ${connected?'live':''}`}/>{connected?`${bridge.mode==='dry-run'?'Dry-run':'Desktop'} companion connected`:'Not connected'}<code>{BRIDGE_URL}</code></div><button className="button primary full" onClick={()=>setPairOpen(true)}>{connected?'Manage connection':'Connect desktop'}<ArrowRight size={16}/></button>{connected&&<button className="text-button disconnect" onClick={()=>{setToken('');sessionStorage.removeItem('motionkey.token');setBridge(null);setArmed(false);setToast('Desktop disconnected.');}}>Disconnect companion</button>}</section><section className="settings-panel privacy-panel"><ShieldCheck size={23}/><h3>Your privacy stays yours.</h3><p>Video is processed in your browser. No camera frames, recordings, or face data are uploaded. Custom hand-pose coordinates stay in this browser. Desktop commands go only to your local companion.</p><span><LockKeyhole size={13}/>No account. No cloud processing.</span></section><button className="button secondary full" onClick={exportMappings}><Download size={16}/>Export gesture profile</button></div></div></>}
      <footer className="page-footer"><span><AudioLines size={14}/> A more natural way to do your thing.</span><span>Made for the way you move <span className="footer-sparkle">✳</span></span></footer>
    </main></div>
    {editing&&<Modal title={`Make ${editing.name.toLowerCase()} yours.`} subtitle={editing.description} close={()=>setEditing(null)}><form onSubmit={e=>{e.preventDefault();setMappings(old=>old.map(m=>m.id===editing.id?editing:m));setEditing(null);gate.current.reset();setToast('Gesture updated. Your shortcuts, your way.');}}><div className="edit-gesture-visual"><GestureIcon id={editing.id} size={42}/><span>{editing.name}</span></div><label className="field-label" htmlFor="command">WHEN I MAKE THIS GESTURE</label><select id="command" value={editing.command} onChange={e=>setEditing({...editing,command:e.target.value})}>{['Media','Navigation','Editing','Keyboard'].map(group=><optgroup label={group} key={group}>{COMMANDS.filter(c=>c.group===group).map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>)}</select><div className="edit-enable"><div><strong>Enable this gesture</strong><p>Recognize and trigger its command.</p></div><Toggle checked={editing.enabled} onChange={()=>setEditing({...editing,enabled:!editing.enabled})} label="Enable this gesture"/></div><div className="info-note"><Keyboard size={17}/><p>Commands control the application currently in focus on your computer. Try gestures in preview mode before arming desktop control.</p></div><div className="modal-actions">{editing.kind==='custom'?<button type="button" className="text-button danger" onClick={()=>{setMappings(old=>old.filter(m=>m.id!==editing.id));setEditing(null);}}><Trash2 size={15}/>Delete</button>:<button type="button" className="button secondary" onClick={()=>setEditing(null)}>Cancel</button>}<button className="button primary" type="submit"><Check size={16}/>Save gesture</button></div></form></Modal>}
    {creating&&<Modal title="Make a gesture of your own." subtitle="Record a hand pose from a few slightly different angles. Dynamic custom motion sequences aren’t supported yet." close={()=>setCreating(false)}><form onSubmit={createCustom}><label className="field-label" htmlFor="gesture-name">GIVE IT A NAME</label><input id="gesture-name" placeholder="e.g. My focus pose" maxLength={32} required value={customName} onChange={e=>setCustomName(e.target.value)}/><label className="field-label">TEACH MOTIONKEY YOUR POSE</label><div className="capture-box"><Fingerprint size={32}/><strong>{samples.length?`${samples.length} of 3+ samples captured`:'Hold your pose in the camera'}</strong><p>{camera==='on'?(frame.hands.length?'Hand detected. Change the angle slightly between samples.':'No hand in view. Hold one hand up to the camera.'):'Enable the camera in the studio before recording.'}</p><div className="sample-dots">{[0,1,2,3,4].map(i=><span key={i} className={i<samples.length?'filled':''}>{i<samples.length?<Check size={12}/>:i+1}</span>)}</div><button type="button" className="button secondary" onClick={capturePose} disabled={camera!=='on'||samples.length>=5}><Camera size={16}/>Capture sample</button>{samples.length>0&&<button type="button" className="text-button" onClick={()=>setSamples([])}>Start over</button>}</div><label className="field-label" htmlFor="custom-command">ASSIGN A COMMAND</label><select id="custom-command" value={customCommand} onChange={e=>setCustomCommand(e.target.value)}>{COMMANDS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select><div className="modal-actions"><button className="button secondary" type="button" onClick={()=>setCreating(false)}>Cancel</button><button className="button primary" type="submit" disabled={samples.length<3||!customName.trim()}><Plus size={16}/>Create gesture</button></div></form></Modal>}
    {pairOpen&&<Modal title={connected?'Your desktop connection.':'A little connection. A lot of control.'} subtitle="The companion securely sends gestures to the active app on your computer." close={()=>setPairOpen(false)}><div className="setup-steps"><div><span>1</span><div><strong>Start the companion on your computer</strong><p>From your MotionKey checkout, install the desktop helper.</p><code>python -m pip install -r requirements-desktop.txt</code><code>python companion/server.py --web-root dist</code><p>Build the web app first with <code className="inline-code">npm run build</code>. Then open the address printed by the companion. On macOS, allow Accessibility access for your terminal.</p></div></div><div><span>2</span><div><strong>Paste your pairing token</strong><p>The companion prints a new token each time it starts. It stays in this browser tab’s session.</p></div></div></div><form onSubmit={pair}><label className="field-label" htmlFor="pair-token">COMPANION PAIRING TOKEN</label><input type="password" id="pair-token" name="token" autoComplete="off" placeholder="Paste token from your terminal" required defaultValue={token}/>{pairError&&<div className="form-error" role="alert">{pairError}</div>}<div className="info-note"><ShieldCheck size={18}/><p>Connect only to the companion running on your own computer. No remote desktop or cloud access is used.</p></div><button className="button primary full" disabled={pairLoading}>{pairLoading?<LoaderCircle size={16} className="spin"/>:<Monitor size={16}/>} {pairLoading?'Connecting…':'Connect desktop'}<ArrowRight size={16}/></button></form></Modal>}
    {help&&<Modal title="Your next shortcut is in your hands." subtitle="A few simple steps to find your flow." close={()=>setHelp(false)}><div className="help-steps">{[{icon:Camera,title:'Start with your camera',text:'Enable your webcam in the studio. Keep your hand in frame, with good lighting and a little space around your fingers.'},{icon:Hand,title:'Make a move',text:'Hold an open palm, peace sign, or thumbs up. Watch your landmarks and check Activity to see what’s recognized.'},{icon:Settings2,title:'Make it yours',text:'Choose a command for each gesture. Record custom hand poses, or enable smiles and head turns in your library.'},{icon:Monitor,title:'Take control of your desktop',text:'Run the local companion on your computer, paste its pairing token, and arm desktop control. Commands go to the focused app. Release each pose before repeating.'}].map(({icon:Icon,title,text})=><div key={title}><span><Icon size={21}/></span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="info-note"><LockKeyhole size={18}/><p>Face tracking recognizes expressions and head movement, not who you are. Media keys and screenshots depend on your operating system. Stop the camera any time to stop control.</p></div><button className="button primary full" onClick={()=>{setHelp(false);setPage('studio');}}>Let’s make a move<ArrowRight size={16}/></button></Modal>}
    {toast&&<div className="toast" role="status"><CheckCircle2 size={18}/><span>{toast}</span><button onClick={()=>setToast('')} aria-label="Dismiss notification"><X size={15}/></button></div>}
  </div>;
}
