import assert from 'node:assert/strict';
import {buildTarget,forceAlign,lineWindows,logSoftmaxFrames,timelineFromAlignment,RU_VOCAB} from '../docs/ctc-align.js';
import {validateTimeline} from '../docs/engine.js';
function fixture(ids,{vocab=5,lead=4,tail=4,stretch=3}={}){const frames=[...Array(lead).fill(0)];ids.forEach(id=>{frames.push(...Array(stretch).fill(id),0);});frames.push(...Array(tail).fill(0));const logits=new Float32Array(frames.length*vocab).fill(-12);frames.forEach((id,t)=>logits[t*vocab+id]=5);return {emissions:logSoftmaxFrames(logits,vocab),frames};}
// Consecutive identical characters must use the required blank, and instrumentals
// before/after the lyrics must remain outside the token spans.
{
 const ids=[1,1,2,3],{emissions}=fixture(ids),spans=forceAlign(emissions,5,ids);
 assert.equal(spans[0].start,.08);assert.ok(Math.abs(spans[0].end-.14)<1e-9);assert.equal(spans[1].start,.16);assert.ok(spans.at(-1).end<.4);
 assert.throws(()=>forceAlign(new Float32Array(2*5),5,[1,1,1]),/короткое/);
}
{
 const target=buildTarget('На|ша песня\nНаша песня'),ids=target.tokens.map(t=>t.id),{emissions}=fixture(ids,{vocab:39});
 const spans=forceAlign(emissions,39,ids),result=timelineFromAlignment(target,spans,10);validateTimeline(result.lines,10);
 assert.equal(result.lines[0].text,'Наша песня');assert.equal(result.lines[0].words[0].units.length,2);assert.ok(result.lines[1].start>result.lines[0].end);
 const anchors=result.lines.map(l=>({start:l.start,end:l.end}));const windows=lineWindows(target,anchors,10);const fixed=forceAlign(emissions,39,ids,{windows});assert.equal(fixed[0].start,spans[0].start);
 assert.throws(()=>buildTarget('2026 год'),/числа словами/);assert.throws(()=>buildTarget('Hello'),/русский/);
 assert.equal(RU_VOCAB['я'],38);assert.equal(RU_VOCAB['о'],21);
}
// A sustained vowel is not forced to occupy the same fraction as a short vowel.
{
 const target=buildTarget('мама'),ids=target.tokens.map(t=>t.id),frames=[0,0,19,19,...Array(30).fill(7),0,19,19,7,7,0,0];
 const logits=new Float32Array(frames.length*39).fill(-10);frames.forEach((id,t)=>logits[t*39+id]=8);
 const result=timelineFromAlignment(target,forceAlign(logSoftmaxFrames(logits,39),39,ids),5);
 const u=result.lines[0].words[0].units;assert.ok(u[0].end-u[0].start>5*(u[1].end-u[1].start));validateTimeline(result.lines,5);
}
// Invalid or impossible anchors must fail, preserving the caller's old timeline.
assert.throws(()=>lineWindows(buildTarget('Наша песня'),[{start:9,end:3}],10),/границы/);
assert.throws(()=>forceAlign(new Float32Array(10*3),3,[1,2],{windows:[[20,21],[20,21]]}),/границы/);
console.log('PASS: CTC repeats, silence, measured syllable duration, exact text, anchors, validation');
