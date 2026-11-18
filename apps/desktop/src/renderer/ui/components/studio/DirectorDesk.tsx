import { useEffect, useRef, useState } from 'react';
import { Button, TextField } from '@antseed/ui';
import { emptyDesk, type Desk, type DeskAction } from '../../../../shared/director.js';
import { studioMediaKind, type StudioProjectDetail } from '../../../../shared/studio.js';
import { studioFileUrl } from '../../../modules/studio/board-view';
import s from './DirectorDesk.module.scss';
import { SceneFeedback } from './SceneFeedback';

export function DirectorDesk({ detail, onDirect, canSend }: { detail: StudioProjectDetail; onDirect: (text: string) => void; canSend: boolean }) {
  const id = detail.project.id;
  const [desk, setDesk] = useState<Desk>(emptyDesk);
  const [selected, select] = useState('');
  const [candidate, choose] = useState('');
  const [compare, setCompare] = useState(false);
  const [playing, play] = useState(false);
  const [moment, mark] = useState(0);
  const [region, box] = useState<number[] | null>(null);
  const anchor = useRef<number[] | null>(null);
  const [lesson, teach] = useState('');
  const [error, fail] = useState('');
  const [busy, wait] = useState(false);
  const drag = useRef('');
  const vid = useRef<HTMLVideoElement>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; void window.antseedDesktop?.studioDesk?.(id).then(r => {
    if (mounted.current) { if (r.data) setDesk(r.data); else fail(r.error ?? 'Desk unavailable'); }
  }).catch(err => mounted.current && fail(String(err))); return () => { mounted.current = false; }; }, [id]);
  async function change(action: DeskAction) {
    wait(true); fail(''); play(false);
    try { const r = await window.antseedDesktop?.studioDesk?.(id, action); if (!r?.data) throw Error(r?.error ?? 'Restart the desktop to enable the desk');
      if (mounted.current) setDesk(r.data); return r.data;
    } catch (err) { if (mounted.current) fail(err instanceof Error ? err.message : String(err)); } finally { if (mounted.current) wait(false); }
  }
  const shots = [...detail.board.shots, ...(desk.importedShots ?? []).map(i => ({ id:i.id, title:i.label, durationSeconds:null, clip:studioMediaKind(i.path)==='video'?i.path:null, still:studioMediaKind(i.path)==='image'?i.path:null, alternatives:[] }))];
  const ids = [...new Set([...desk.order.filter(k => shots.some(t => t.id===k)), ...shots.map(t=>t.id)])];
  const key = ids.includes(selected) ? selected : ids[0] ?? '';
  const shot = shots.find(t=>t.id===key);
  const edit = desk.edits[key];
  const keeper = edit?.keeper || shot?.clip || shot?.still || '';
  const takes = [...new Set([shot?.still, shot?.clip, ...(shot?.alternatives ?? []), ...(edit?.takes ?? []).map(t=>t.path), keeper].filter((p):p is string=>!!p))];
  const source = playing ? (edit?.keeper && studioMediaKind(edit.keeper)==='image'?edit.keeper:shot?.still || keeper) : takes.includes(candidate)?candidate:keeper;
  const url = (p:string)=>studioFileUrl(id,p,detail.files[p]);
  const hold = edit?.hold ?? shot?.durationSeconds ?? 3;
  const move = (a:string,b:string) => { if (a===b || !ids.includes(a)||!ids.includes(b)) return; const next=[...ids]; next.splice(ids.indexOf(a),1); next.splice(ids.indexOf(b),0,a); void change({type:'order',ids:next}); };
  function pick(k:string) { select(k); choose(''); mark(0); box(null); setCompare(false); }
  const index = ids.indexOf(key), next = ids[index+1];
  useEffect(()=>{ if (!playing) return; const t=setTimeout(()=>{ if(next) pick(next); else play(false); },hold*1000); return ()=>clearTimeout(t); },[playing,key,next,hold]);
  const short = (p:string)=>desk.shelf.find(r=>r.path===p)?.label || edit?.takes.find(t=>t.path===p)?.label || p.split('/').pop();
  function media(p:string, main:boolean) {
    if (!p) return <span className={s.placeholder}>Planned shot · no media yet</span>;
    if (studioMediaKind(p)==='video') return <video key={p} ref={main?vid:undefined} src={url(p)} controls={!playing} muted={playing} autoPlay={playing} playsInline onTimeUpdate={main?e=>mark(e.currentTarget.currentTime):undefined}/>;
    const pos=(e:React.PointerEvent<HTMLDivElement>)=>{const r=e.currentTarget.getBoundingClientRect(); return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))];};
    return <div className={s.image} onPointerDown={e=>{if(!main||playing)return; anchor.current=pos(e); box(null); e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={e=>{if(!anchor.current||!main)return; const [x,y]=anchor.current; const [a,b]=pos(e); anchor.current=null; box([Math.min(x,a),Math.min(y,b),Math.abs(a-x),Math.abs(b-y)]);}}>
      <img draggable={false} src={url(p)} alt={shot?.title || 'Shot preview'}/>{main && region && <i style={{left:`${region[0]*100}%`,top:`${region[1]*100}%`,width:`${region[2]*100}%`,height:`${region[3]*100}%`}}/>}</div>;
  }
  return <section className={s.desk}><h2>Director’s desk</h2>{error && <p role="alert">{error}</p>}
    <fieldset disabled={busy}><legend>Storyboard</legend>
    {shot && <><h3>Choose a shot</h3><p className={s.hint}>Click a title to work on that shot. Drag titles to change the order they play.</p>
    <div className={s.strip}>{ids.map((k,i)=><button key={k} type="button" aria-pressed={key===k} draggable={!busy} onDragStart={()=>{drag.current=k;}} onDragOver={e=>e.preventDefault()} onDrop={()=>move(drag.current,k)} onClick={()=>{play(false);pick(k);}}>{i+1}. {shots.find(t=>t.id===k)?.title || k}</button>)}</div>
    <div className={s.preview}>{compare && <figure><figcaption>Current choice</figcaption>{media(keeper,false)}</figure>}<figure><figcaption>{compare?'Alternative':`Shot ${index+1} of ${ids.length}`} · {shot.title}</figcaption>{media(source,true)}</figure></div>
    {playing ? <p className={s.hint}>Stop the storyboard preview to leave a note on a scene.</p> : <SceneFeedback current={{scene:String(index+1),title:shot.title,file:source,time:studioMediaKind(source)==='video'?moment:null}} canSend={canSend} onSend={onDirect} capture={()=>{vid.current?.pause();return {scene:String(index+1),title:shot.title,file:source,time:studioMediaKind(source)==='video'?vid.current?.currentTime ?? moment:null,locked:edit?.locked,region:region?.map(n=>`${Math.round(n*100)}%`).join(', ')};}}/>}
    <h3>Preview the sequence</h3><p className={s.hint}>Play from shot 1 to check the pacing. The time below controls how long this shot appears in the preview.</p>
    <div className={s.row}><Button size="sm" onClick={()=>{if(!playing)pick(ids[0]);play(!playing);}}>{playing?'Stop preview':'Play storyboard'}</Button><Button size="sm" variant="ghost" title={index?'Move the selected shot one place earlier':'Already the first shot'} disabled={!index} onClick={()=>move(key,ids[index-1])}>Move shot earlier</Button><Button size="sm" variant="ghost" title={next?'Move the selected shot one place later':'Already the last shot'} disabled={!next} onClick={()=>move(key,next)}>Move shot later</Button>
    <label>Seconds on screen <input key={`${key}-${hold}`} type="number" step="0.1" min="0.1" max="600" defaultValue={hold} disabled={edit?.locked} onBlur={e=>{const seconds=e.target.valueAsNumber;if(seconds!==hold)void change({type:'hold',shot:key,seconds});}}/></label></div>
    <h3>Versions of shot {index+1}</h3><p className={s.hint}>{takes.length>1?'Choose an alternative to compare it beside your current choice. Both files stay in the project.':takes.length===1?'This shot has one version. To compare another, import a file below and try it on this shot.':'No picture or clip yet. Import one below or ask the agent to make it.'}</p>
    <div className={s.row}>{takes.length>0 && <label>Preview version <select value={source} onChange={e=>{choose(e.target.value);setCompare(false);box(null);mark(0);play(false);}}>{takes.map(p=><option key={p} value={p}>{short(p)}{p===keeper?' · current choice':''}</option>)}</select></label>}
    {source && source!==keeper && <><Button size="sm" variant="outline" onClick={()=>setCompare(!compare)}>{compare?'Close comparison':'Compare side by side'}</Button>
    <Button size="sm" disabled={edit?.locked} onClick={async()=>{if(await change({type:'keep',shot:key,source}))setCompare(false);}}>Use this version</Button></>}
    {edit?.previous && <Button size="sm" variant="ghost" disabled={edit.locked} onClick={()=>void change({type:'undo',shot:key})}>Restore previous choice</Button>}
    <Button size="sm" variant="outline" onClick={()=>void change({type:'lock',shot:key})}>{edit?.locked?'Unlock for editing':'Lock shot'}</Button></div>
    <p className={s.hint}>{edit?.locked?'Shot locked. Unlock it to change its timing, trim a clip, or choose another version.':'Lock the shot when you’re happy with it to protect your edits.'}</p>
    <div className={s.row}>{source && studioMediaKind(source)==='video' && <Button size="sm" disabled={!!edit?.locked||moment<0.1} onClick={async()=>{vid.current?.pause();const r=await change({type:'trim',shot:key,source,end:moment});const last=r?.edits[key]?.takes.at(-1);if(last){choose(last.path);setCompare(true);mark(0);}}}>Trim copy to {moment.toFixed(2)} s</Button>}
    </div></>}
    {!shot && <p>Start with a storyboard in chat, or import material below and add your first shot.</p>}</fieldset>
    <fieldset disabled={busy}><legend>Your source files</legend><p className={s.hint}>Import a picture or clip from your computer. Add it as a new shot, try it as another version of the selected shot, or describe how the agent should use it as a reference.</p><Button size="sm" variant="outline" onClick={()=>void change({type:'import'})}>Import pictures or footage…</Button>
    {desk.shelf.map(ref=><div key={ref.path} className={s.ref}><strong>{ref.label}</strong><TextField label="Use as" key={`${ref.path}-${ref.role}`} defaultValue={ref.role} placeholder="Opening frame, lighting only…" onBlur={e=>{if(e.target.value!==ref.role)void change({type:'role',source:ref.path,role:e.target.value});}}/><div className={s.row}><Button size="sm" variant="outline" onClick={()=>void change({type:'place',source:ref.path})}>Add as shot</Button>{shot&&<Button size="sm" variant="ghost" disabled={edit?.locked} onClick={async()=>{if(await change({type:'add',source:ref.path,shot:key})){choose(ref.path);setCompare(false);box(null);mark(0);}}}>Try on selected shot</Button>}</div></div>)}</fieldset>
    <fieldset disabled={busy}><legend>Project instructions</legend><p className={s.hint}>Save a rule you want the agent to follow on future edits in this project. For a one-time change, use chat.</p><TextField value={lesson} label="Rule for the agent" placeholder="Keep every product label readable for two seconds" onChange={e=>teach(e.target.value)}/><Button size="sm" disabled={!lesson.trim()} onClick={async()=>{if(await change({type:'teach',lesson}))teach('');}}>Save project rule</Button>{desk.lessons.map(l=><p key={l}>{l} <Button variant="link" onClick={()=>void change({type:'forget',lesson:l})}>Remove rule</Button></p>)}</fieldset>
  </section>;
}
