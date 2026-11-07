import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../server/store.js';
import {createApp} from '../server/app.js';
import {buildSubmission} from '../server/submission.js';
function setup(dataset='prod') {
 const s=createStore();createApp(s);const v=s.list('checklist_version')[0];
 const c=Array.from({length:dataset==='dev'?65:10},(_,i)=>s.add('conversation',{group_id:'SET',conversation_id:'original-'+i,channel:dataset==='dev'&&i>=60?'voice call':'agent chat',transcript:[{text:'Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ',message_no:1}]}));
 return {s,v,c,options:{dataset,group_id:'SET',checklist_version:v.id,model:'real-model'}};
}
function addEvaluation(ctx) {
 const {s,v,c}=ctx;
 const results=v.criteria.map(criterion=>({criterion_id:criterion.criterion_id,answer:criterion.is_gross_error?'yes':criterion.allow_na?'na':criterion.answer_type==='scale'?'scale':'yes',raw_score:criterion.is_gross_error||criterion.allow_na?null:criterion.answer_type==='scale'?7:1,na_reason:criterion.allow_na?'РћР±РѕСЃРЅРѕРІР°РЅРЅР°СЏ РїСЂРёС‡РёРЅР°':null,explanation:'РџСЂРѕРІРµСЂРµРЅ СЂР°Р·РіРѕРІРѕСЂ',evidence_message_nos:[1]}));
 const e=s.add('evaluation',{conversation_id:c[0].id,checklist_version:v.id,model:'real-model',prompt_version:'v1',results});
 return {e,results};
}
test('official schema mapping types N/A scale scores gross flag and missing errors',()=>{
 const ctx=setup();try {
 const {e}=addEvaluation(ctx);ctx.s.add('job',{conversation_id:ctx.c[0].id,checklist_version:ctx.v.id,status:'completed',evaluation_id:e.id});
 const out=buildSubmission(ctx.s,ctx.options);
 assert.equal(out.schema_version,'1.0');assert.equal(out.results.length,10);
 const first=out.results[0];assert.equal(first.conversation_id,'original-0');
 assert.deepEqual(first.criteria.map(c=>c.criterion_id),['contact','discovery','identification','consultation','empathy','dialogue','closure','critical']);
 assert.equal(first.criteria[0].value,true);assert.equal(first.criteria[1].value,null);assert.equal(first.criteria[5].value,7);
 assert.equal(first.score.critical_flag,true);assert.equal(first.score.final_score,88.75);
 assert.equal(out.results[1].status,'error');assert.deepEqual(out.results[1].criteria,[]);assert.equal(out.results[1].score,null);
 }finally{ctx.s.db.close();}
});
test('manual and demonstration evaluations are excluded; failure never turns into zero',()=>{
 const ctx=setup();try{addEvaluation(ctx);assert.equal(buildSubmission(ctx.s,ctx.options).results[0].status,'error');
 assert.throws(()=>buildSubmission(ctx.s,{...ctx.options,group_id:'DEMO'}));
 ctx.s.add('job',{conversation_id:ctx.c[0].id,checklist_version:ctx.v.id,status:'failed'});
 assert.equal(buildSubmission(ctx.s,ctx.options).results[0].score,null);
 }finally{ctx.s.db.close();}
});
test('wrong size duplicate IDs changed rubric and wrong channels block export',()=>{
 const ctx=setup();try{
 const changed=ctx.s.add('checklist_version',{...ctx.v,criteria:ctx.v.criteria.map((c,i)=>i?c:{...c,text:'changed'})});
 assert.throws(()=>buildSubmission(ctx.s,{...ctx.options,checklist_version:changed.id}));
 ctx.s.update('conversation',ctx.c[0].id,{channel:'voice call'});assert.throws(()=>buildSubmission(ctx.s,ctx.options));
 ctx.s.update('conversation',ctx.c[0].id,{channel:'agent chat',conversation_id:'original-1'});assert.throws(()=>buildSubmission(ctx.s,ctx.options));
 ctx.s.add('conversation',{group_id:'SET',conversation_id:'extra'});assert.throws(()=>buildSubmission(ctx.s,ctx.options));
 }finally{ctx.s.db.close();}
});
test('DEV includes exactly 65 original records including errors',()=>{
 const ctx=setup('dev');try{const out=buildSubmission(ctx.s,ctx.options);assert.equal(out.results.length,65);assert.ok(out.results.every(r=>r.status==='error'));}finally{ctx.s.db.close();}
});

test('HTTP export downloads results.json with correct content type',async()=>{
 const ctx=setup();const server=createApp(ctx.s).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/exports/submission`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ctx.options)});
 assert.equal(res.status,200);assert.match(res.headers.get('content-disposition'),/results.json/);
 assert.match(res.headers.get('content-type'),/application\/json/);assert.equal((await res.json()).results.length,10);
 }finally{await new Promise(r=>server.close(r));ctx.s.db.close();}
});
