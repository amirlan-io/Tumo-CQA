import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

async function until(check) {
  for (let i=0;i<300;i++) { if (check()) return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Condition timed out');
}
async function fixture(ai={}) {
  const store=createStore(); const server=createApp(store,{},ai).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,body)=>{const response=await fetch(base+'/api/'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  return {store,base,request,close:async()=>{await new Promise(r=>server.close(r));store.db.close();}};
}
const record = id => ({conversation_id:id,language:'RU',channel:'voice call',audio_url:'https://example.invalid/test.mp3',transcript:[
  {timestamp:'2026-11-07T12:00:00Z',speaker:'client',text:'Здравствуйте'},
  {timestamp:'2026-11-07T12:00:02Z',speaker:'operator',text:'Здравствуйте, Анна'},
  {timestamp:'2026-11-07T12:00:04Z',speaker:'client',text:'Спасибо'}]});
const results = version => version.criteria.map(c=>({criterion_id:c.criterion_id,answer:c.answer_type==='scale'?'scale':'no',raw_score:c.is_gross_error?null:0,explanation:'Тестовое объяснение',evidence_message_nos:[2]}));

test('invalid imports return 400 atomically without storing malformed audio',async()=>{
  const f=await fixture();try {
    for(const records of [[null],[{...record('bad'),audio_url:123}],[{...record('bad'),audio_url:'javascript:alert(1)'}],[record('good'),null]]) {
      assert.equal((await f.request('import',{group_id:'TEST',records})).status,400);
    }
    assert.equal(f.store.list('conversation').length,0);
  } finally {await f.close();}
});

test('retry batch schedules only failed conversations and preserves original batch',async()=>{
  let failOnce=true; const calls=[];
  const f=await fixture({model:'test',prompt_version:'v1',evaluateDialogue:async(c,v)=>{
    calls.push(c.conversation_id); if(c.conversation_id==='fail'&&failOnce){failOnce=false;throw new Error('Synthetic failure');}
    return {model:'test',prompt_version:'v1',results:results(v)};
  }});
  try {
    await f.request('import',{group_id:'TEST',records:[record('good'),record('fail')]});
    const v=f.store.list('checklist_version')[0];
    const batch=(await f.request('evaluation-batches',{group_id:'TEST',checklist_version:v.id})).data;
    await until(()=>f.store.list('job').every(j=>['completed','failed'].includes(j.status)));
    const retry=await f.request('evaluation-batches/'+batch.id+'/retry',{});
    assert.equal(retry.status,202);assert.equal(retry.data.total,1);
    await until(()=>f.store.list('job').at(-1).status==='completed');
    assert.deepEqual(calls,['good','fail','fail']);
    assert.equal((await f.request('evaluation-batches/'+batch.id)).data.failed,1);
    assert.equal((await f.request('evaluation-batches/'+retry.data.id+'/retry',{})).status,409);
  }finally{await f.close();}
});

test('UI shows actual evaluation version and stops audio excerpts despite delayed pause events',async()=>{
  const f=await fixture();let dom;
  try{
    const audioRecord=record('AUDIO');
    audioRecord.transcript.forEach((turn,index)=>{turn.timestamp='00:0'+index*2;});
    const [c]=(await f.request('import',{group_id:'TEST',records:[audioRecord]})).data;
    const v=f.store.list('checklist_version')[0];
    const e=(await f.request('evaluations',{conversation_id:c.id,checklist_version:v.id,results:results(v)})).data;
    await f.request('checklists/'+v.checklist_id+'/versions',{...v,name:'New rubric'});
    const errors=[];
    dom=await JSDOM.fromURL(f.base+'/frontend/',{resources:'usable',runScripts:'dangerously',beforeParse(w){
      w.fetch=(p,o)=>fetch(new URL(p,f.base+'/frontend/'),o);
      w.HTMLElement.prototype.scrollIntoView=function(){};
      w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
      w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
      Object.defineProperty(w.HTMLMediaElement.prototype,'paused',{get(){return this._paused!==false;}});
      w.HTMLMediaElement.prototype.play=function(){this._paused=false;return Promise.resolve();};
      w.HTMLMediaElement.prototype.pause=function(){this._paused=true;w.setTimeout(()=>this.dispatchEvent(new w.Event('pause')),0);};
      w.addEventListener('error',event=>{errors.push(event.error);event.preventDefault();});
    }});
    const d=dom.window.document;const find=t=>[...d.querySelectorAll('button')].find(b=>b.textContent===t);
    await until(()=>find('Открыть AUDIO · RU'));find('Открыть AUDIO · RU').click();
    await until(()=>d.querySelector('audio'));
    assert.equal([...d.querySelectorAll('select')].find(s=>s.parentElement.textContent.startsWith('Версия чек-листа')).value,v.id);
    assert.match(d.querySelector('.cqa-evaluation-version').textContent,/v1/);
    assert.ok(d.body.textContent.includes('Тренер оператора'));
    const audio=d.querySelector('audio');
    find('Доказательство · 2').click();await until(()=>!find('Доказательство · 2').disabled);
    assert.equal(audio.currentTime,2);assert.equal(audio.paused,false);
    audio.currentTime=4.1;audio.dispatchEvent(new dom.window.Event('timeupdate'));
    audio.dispatchEvent(new dom.window.Event('timeupdate'));
    assert.equal(audio.paused,true);assert.deepEqual(errors,[]);
    await new Promise(r=>setTimeout(r,5));
    find('Доказательство · 2').click();await until(()=>!find('Доказательство · 2').disabled);
    find('Закрыть ×').click();assert.equal(audio.paused,true);
    await new Promise(r=>setTimeout(r,5));
    find('Доказательство · 2').click();await until(()=>!find('Доказательство · 2').disabled);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));assert.equal(audio.paused,true);
    assert.equal(e.results[0].answer,'no');
  }finally{dom?.window.close();await f.close();}
});
