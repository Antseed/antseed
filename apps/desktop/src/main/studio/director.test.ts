import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStudioProject } from './store.js';
import { changeDesk, readDesk } from './director.js';

test('shelf, trims and keeper choices survive reopening without changing the source', async t => {
  try { execFileSync('ffmpeg',['-version']); } catch { t.skip('ffmpeg unavailable'); return; }
  const tmp = await mkdtemp(path.join(tmpdir(),'director-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const root = path.join(tmp,'studio'); await mkdir(root);
  const {id} = await createStudioProject('test',root);
  const src = path.join(tmp,'source.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=s=96x64:r=20','-t','1','-c:v','libx264',src]);
  const raw = await readFile(src);
  const act=(a: Parameters<typeof changeDesk>[1])=>changeDesk(id,a,[],root);
  const ref=(await changeDesk(id,{type:'import'},[src],root)).shelf[0]!;
  await act({type:'role',source:ref.path,role:'Opening frame'});
  const shot=(await act({type:'place',source:ref.path})).importedShots![0]!.id;
  const take=(await act({type:'trim',shot,source:ref.path,end:0.5})).edits[shot]!.takes[0]!;
  const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',path.join(root,id,take.path)]).toString());
  assert.ok(Math.abs(duration-0.5)<0.1); assert.deepEqual(await readFile(path.join(root,id,ref.path)),raw);
  await act({type:'keep',shot,source:take.path}); await act({type:'lock',shot});
  await assert.rejects(act({type:'undo',shot}),/Unlock/); await act({type:'lock',shot});
  await act({type:'undo',shot}); await act({type:'hold',shot,seconds:1.25});
  await writeFile(path.join(root,id,'board.json'),JSON.stringify({shots:[{id:'other'}]}));
  await act({type:'order',ids:[shot,'other']}); await act({type:'teach',lesson:'Leave room for captions'});
  const saved=await readDesk(id,root); assert.equal(saved.edits[shot]?.keeper,ref.path); assert.deepEqual(saved.order,[shot,'other']); assert.deepEqual(saved.lessons,['Leave room for captions']); assert.equal(saved.shelf[0]?.role,'Opening frame');
});
