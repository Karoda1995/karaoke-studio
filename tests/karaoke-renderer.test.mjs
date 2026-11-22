import assert from 'node:assert/strict';
import {canvasFont,drawKaraoke,highlightWidth,twoLineLayout} from '../docs/karaoke-renderer.js';
import {makeLine} from '../docs/engine.js';
const lines=[
  makeLine('Первая строка',2,4),
  makeLine('Вторая строка',4,6),
  makeLine('Третья строка',6,8),
  makeLine('Четвёртая строка',8,10),
  makeLine('Пятая строка',12,14),
];
const visible=t=>twoLineLayout(lines,t,0).map(row=>row.index);
assert.deepEqual(visible(-5),[0,1],'Both first lines are visible during the intro');
assert.deepEqual(visible(3),[0,1]);
assert.deepEqual(visible(4),[2,1],'Top advances, second line stays at the bottom');
assert.deepEqual(visible(6),[2,3],'Third line sings at the top, fourth is previewed below');
assert.deepEqual(visible(8),[4,3]);
assert.deepEqual(visible(10),[4,-1],'Final unpaired line keeps its top position');
assert.deepEqual(visible(14),[-1,-1]);
assert.deepEqual(twoLineLayout([],0),[{slot:0,index:-1,layers:[]},{slot:1,index:-1,layers:[]}]);
assert.deepEqual(twoLineLayout(lines.slice(0,1),3,0).map(r=>r.index),[0,-1]);
// Crossfade affects only the slot being replaced, not the singing second line.
{
  const at=twoLineLayout(lines,4.16,320);
  assert.equal(at[0].layers.length,2);
  assert.ok(Math.abs(at[0].layers[0].opacity-.5)<1e-9);
  assert.ok(Math.abs(at[0].layers[1].opacity-.5)<1e-9);
  assert.equal(at[1].layers[0].index,1);
  assert.equal(at[1].layers[0].opacity,1);
  assert.equal(at[1].layers[0].shift,0);
  assert.equal(twoLineLayout(lines,4.5,320)[0].layers.length,1);
  // Re-evaluating a frame after a seek is independent of previous frames.
  twoLineLayout(lines,12,320);
  assert.deepEqual(twoLineLayout(lines,4.16,320),at);
}
// Fade timing cannot obscure a very short new phrase after its own start.
{
  const short=[makeLine('А',0,.1),makeLine('Б',.1,.2),makeLine('В',.2,.3)];
  assert.equal(twoLineLayout(short,.2,800)[0].layers.length,1);
  assert.equal(twoLineLayout(short,.2,800)[0].layers[0].opacity,1);
}
function fakeContext(){
  const stack=[],drawn=[];
  return {globalAlpha:1,font:'',fillStyle:'',drawn,
    save(){stack.push({globalAlpha:this.globalAlpha,font:this.font,fillStyle:this.fillStyle});},
    restore(){Object.assign(this,stack.pop());},
    measureText(text){const size=Number(this.font.match(/([\d.]+)px/)?.[1]??48);return {width:text.length*size*.5};},
    fillRect(){},beginPath(){},rect(x,y,w,h){this.clipRect={x,y,w,h};},clip(){},
    fillText(text,x,y){drawn.push({text,x,y,font:this.font,color:this.fillStyle,opacity:this.globalAlpha});},
  };
}
const options={width:1280,height:720,lines,fontKey:'georgia',fontSize:48,color:'#ff8800',transitionMs:320};
{
  const ctx=fakeContext();drawKaraoke(ctx,{...options,time:5});
  const highlighted=ctx.drawn.filter(d=>d.color==='#ff8800');
  assert.deepEqual(highlighted.map(d=>d.text),['Вторая строка']);
  const next=ctx.drawn.find(d=>d.text==='Третья строка');
  assert.ok(highlighted[0].y>next.y,'Second line must be highlighted below the third');
  assert.ok(ctx.drawn.every(d=>d.font.includes('Georgia')),'Selected face applies to every row');
}
{
  const ctx=fakeContext();drawKaraoke(ctx,{...options,time:7});
  assert.deepEqual(ctx.drawn.filter(d=>d.color==='#ff8800').map(d=>d.text),['Третья строка']);
}
{
  const ctx=fakeContext();ctx.font=canvasFont('arial',48);
  assert.equal(highlightWidth(ctx,lines[0],0),0);
  assert.equal(highlightWidth(ctx,lines[0],4),ctx.measureText(lines[0].text).width);
  assert.ok(highlightWidth(ctx,lines[0],3)>0);
  assert.ok(canvasFont('unknown',48).includes('Manrope'));
}
// A new long phrase must not resize the unchanged, already singing lower row.
{
  const wide=[lines[0],lines[1],makeLine('Очень длинная строка '.repeat(14),6,8)];
  const before=fakeContext(),after=fakeContext();
  drawKaraoke(before,{...options,lines:wide,time:3.9});
  drawKaraoke(after,{...options,lines:wide,time:4.5});
  assert.equal(before.drawn.find(d=>d.text==='Вторая строка').font,after.drawn.find(d=>d.text==='Вторая строка').font);
}
console.log('PASS: alternating top/bottom rows, intro/gaps/ending, isolated smooth transitions, seeking, chosen font, bottom-row highlighting, stable size');
