import assert from 'node:assert/strict';
import {vocalBoundaries} from '../docs/acoustics.js';
import {buildTarget, timelineFromAlignment} from '../docs/ctc-align.js';
import {makeLine,validateTimeline} from '../docs/engine.js';
import {parseTimecode,retapLine,timecode} from '../docs/timing-edit.js';

assert.equal(timecode(85.3),'01:25:300');
assert.equal(parseTimecode('01:25:300'),85.3);
assert.equal(timecode(59.9997),'01:00:000');
assert.ok(Number.isNaN(parseTimecode('01:78:000')));

const old = makeLine('Ма|ма — до|ма',21,23);
const edited = retapLine(old,[20,20.3,20.82,21.56],22.5);
validateTimeline([makeLine('До',18,20),edited,makeLine('После',23,24)],24);
assert.deepEqual(edited.words[0].units.map(u=>[u.start,u.end]),[[20,20.3],[20.3,20.82]]);
assert.equal(edited.words[1].start,edited.words[1].end);
assert.equal(edited.words.at(-1).units.at(-1).end,22.5);
assert.equal(old.start,21);
assert.throws(()=>retapLine(old,[20,20.3],22.5),/каждого слога/);

const vowel=buildTarget('Уууууу');
assert.equal(vowel.tokens.length,1);
assert.equal(vowel.lines[0].words[0].units.length,1);
const samples=new Float32Array(30*16000);
for(let i=25*16000;i<28*16000;i++){
  const t=i/16000-25;
  samples[i]=.17*Math.sin(2*Math.PI*(214*t+t*t))+.06*Math.sin(4*Math.PI*(214*t+t*t));
}
const {lines:[line]}=timelineFromAlignment(vowel,[{start:26.5,end:26.52,peak:.98}],30,{voice:vocalBoundaries(samples)});
assert.ok(Math.abs(line.start-25)<.05, JSON.stringify(line));
assert.ok(Math.abs(line.end-28)<.05, JSON.stringify(line));
validateTimeline([line],30);
console.log('PASS: millisecond timecodes, atomic line tapping, and 25–28 s held vowel with a single CTC spike');
