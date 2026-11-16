import assert from 'node:assert/strict';
import {AudioTransport} from '../docs/transport.js';
const nodes=[];const context={currentTime:0,destination:{name:'speakers'},resume:async()=>{},createGain:()=>({links:[],connect(x){this.links.push(x);},disconnect(x){this.links=this.links.filter(t=>t!==x);}}),createBufferSource(){const node={playbackRate:{value:1},connect(x){this.destination=x;},disconnect(){},start(when,offset){this.when=when;this.offset=offset;},stop(){this.stopped=true;}};nodes.push(node);return node;}};
const vocal={duration:12,name:'voice'},backing={duration:10,name:'minus'},p=new AudioTransport(context);p.setTrack('vocal',vocal);p.setTrack('backing',backing);
await p.play();assert.equal(nodes.at(-1).buffer,vocal);context.currentTime=2;assert.equal(p.currentTime,2);
p.select('backing');assert.equal(nodes.length,2);assert.equal(nodes[0].stopped,true);assert.equal(nodes[1].buffer,backing);assert.equal(nodes[1].offset,2);
// The original is stopped, not muted alongside a still-connected second source.
assert.equal(nodes.filter(n=>!n.stopped).length,1);
p.pause();p.currentTime=0;p.setOffset(1.25);await p.play();assert.equal(nodes.at(-1).when,3.25);assert.equal(nodes.at(-1).offset,0);
context.currentTime=3;p.pause();p.currentTime=5;p.setOffset(-.5);await p.play();assert.equal(nodes.at(-1).offset,5.5);
p.playbackRate=.5;context.currentTime=5;assert.equal(p.currentTime,6);
p.pause();p.playbackRate=1;p.currentTime=11.9;let ended=false;p.onended=()=>ended=true;await p.play();context.currentTime=6;p.tick();assert.equal(ended,true);assert.equal(p.paused,true);
console.log('PASS: exclusive vocal/backing routing, common clock, signed offsets, seeking, speed, completion');
