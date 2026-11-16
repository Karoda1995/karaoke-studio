import {parseLyrics,syllables} from './engine.js';

// Russian XLSR-53 CTC vocabulary, from the model's public vocab.json.
export const RU_VOCAB={'<pad>':0,'<s>':1,'</s>':2,'<unk>':3,'|':4,'-':5,'ё':6,...Object.fromEntries(Array.from('абвгдежзийклмнопрстуфхцчшщъыьэюя').map((c,i)=>[c,i+7]))};
export const ACOUSTIC_MODEL='onnx-community/wav2vec2-large-xlsr-53-russian-ONNX';
const letter=c=>c.toLowerCase().replace('ё','е');

export function buildTarget(text,vocab=RU_VOCAB){
  const tokens=[],lines=[];let wordCount=0;
  for(const [li,line]of parseLyrics(text).entries()){
    const words=[];
    for(const raw of line.text.split(/\s+/).filter(Boolean)){
      const wi=words.length,units=syllables(raw).map(t=>({text:t,start:0,end:0}));
      const word={text:raw.replaceAll('|',''),start:0,end:0,units};
      const before=tokens.length;
      for(const [ui,u]of units.entries())for(const c of Array.from(u.text)){
        if(!/\p{L}/u.test(c)){
          if(/\p{N}/u.test(c))throw Error('Запишите числа словами: «'+raw+'». Так модель сможет найти их в вокале.');
          continue;
        }
        const id=vocab[letter(c)];
        if(id===undefined)throw Error('Точный режим сейчас поддерживает русский текст. Неизвестный символ: «'+c+'».');
        tokens.push({id,li,wi,ui,char:c});
      }
      if(tokens.length===before)throw Error('В строке есть слово без русских букв: «'+raw+'». Удалите служебные отметки.');
      // Units consisting only of punctuation cannot receive an acoustic boundary.
      if(units.some((_,ui)=>!tokens.slice(before).some(t=>t.ui===ui)))throw Error('Некорректное деление на слоги в слове «'+raw+'».');
      tokens.push({id:vocab['|'],li,wi,ui:-1,char:' '});words.push(word);wordCount++;
    }
    lines.push({text:words.map(w=>w.text).join(' '),start:0,end:0,words});
  }
  if(!wordCount)throw Error('Добавьте текст песни.');
  tokens.pop();
  return {tokens,lines};
}

export function logSoftmaxFrames(logits,vocabSize){
  const result=new Float32Array(logits.length);
  for(let t=0;t<logits.length;t+=vocabSize){let max=-Infinity;for(let v=0;v<vocabSize;v++)max=Math.max(max,logits[t+v]);let sum=0;for(let v=0;v<vocabSize;v++)sum+=Math.exp(logits[t+v]-max);const den=max+Math.log(sum);for(let v=0;v<vocabSize;v++)result[t+v]=logits[t+v]-den;}
  return result;
}

// CTC Viterbi over blank/token states. Equal consecutive letters require a
// separating blank, unlike a simple monotonic text-to-frame matcher.
export function forceAlign(emissions,vocabSize,target,{blank=0,times=null,frameStep=.02,timeOffset=0,onProgress,windows=null}={}){
  const ids=target.map(t=>typeof t==='number'?t:t.id),frames=emissions.length/vocabSize,states=ids.length*2+1;
  if(!Number.isInteger(frames)||!frames||!ids.length)throw Error('Пустой акустический результат.');
  if(ids.some(id=>!Number.isInteger(id)||id<0||id>=vocabSize||id===blank))throw Error('Неверный алфавит выравнивания.');
  const repeats=ids.reduce((n,id,i)=>n+(i>0&&id===ids[i-1]?1:0),0);
  if(frames<ids.length+repeats)throw Error('Аудио слишком короткое для всего текста.');
  if(frames*states>240000000)throw Error('Для этой длины песни и текста нужно слишком много памяти. Разделите песню на части.');
  const parents=new Uint8Array(frames*states);let prev=new Float64Array(states).fill(-Infinity),next=new Float64Array(states);prev[0]=0;
  for(let t=0;t<frames;t++){
    next.fill(-Infinity);const row=t*vocabSize,base=t*states;
    const maxState=Math.min(states-1,2*t+1);
    for(let s=0;s<=maxState;s++){
      const token=s%2?ids[(s-1)/2]:blank;
      if(s%2&&windows){const window=windows[(s-1)/2],at=(times?.[t]??t*frameStep)+timeOffset;if(window&&(at<window[0]||at>window[1]))continue;}
      let value=prev[s],step=0;
      if(s&&prev[s-1]>value){value=prev[s-1];step=1;}
      if(s>1&&s%2&&token!==ids[(s-3)/2]&&prev[s-2]>value){value=prev[s-2];step=2;}
      next[s]=value+emissions[row+token];parents[base+s]=step;
    }
    [prev,next]=[next,prev];if(t%250===0)onProgress?.(t/frames);
  }
  let state=prev[states-1]>prev[states-2]?states-1:states-2;
  if(!Number.isFinite(prev[state]))throw Error('Текст не удалось уложить в указанные границы. Проверьте текст и границы строк.');
  const spans=ids.map(()=>({start:Infinity,end:-Infinity,sum:0,count:0,peak:-Infinity}));
  for(let t=frames-1;t>=0;t--){
    if(state%2){const k=(state-1)/2,p=emissions[t*vocabSize+ids[k]],at=(times?.[t]??t*frameStep)+timeOffset;const span=spans[k];span.start=Math.min(span.start,at);span.end=Math.max(span.end,at+frameStep);span.sum+=p;span.peak=Math.max(span.peak,p);span.count++;}
    state-=parents[t*states+state];
  }
  if(state!==0)throw Error('Не удалось выровнять начало текста.');
  onProgress?.(1);
  return spans.map(s=>({start:s.start,end:s.end,score:Math.exp(s.sum/Math.max(1,s.count)),peak:Math.exp(s.peak)}));
}

export function timelineFromAlignment(target,spans,duration){
  const lines=structuredClone(target.lines),groups=new Map();
  target.tokens.forEach((token,i)=>{if(token.ui<0)return;const key=`${token.li}:${token.wi}:${token.ui}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(spans[i]);});
  const review=[];
  for(const [li,line]of lines.entries()){
    for(const [wi,word]of line.words.entries()){
      const scores=[];
      for(const [ui,unit]of word.units.entries()){
        const chars=groups.get(`${li}:${wi}:${ui}`);
        unit.start=Math.max(0,chars[0].start);unit.end=Math.min(duration,chars.at(-1).end);
        unit.score=chars.reduce((s,c)=>s+c.peak,0)/chars.length;scores.push(...chars.map(c=>c.peak));
      }
      // Carry the highlight through the measured gap up to the next syllable,
      // rather than allocating equal fractions of the word's total duration.
      for(let ui=0;ui<word.units.length-1;ui++)word.units[ui].end=word.units[ui+1].start;
      word.start=word.units[0].start;word.end=word.units.at(-1).end;
      word.score=scores.reduce((s,p)=>s+p,0)/scores.length;
      word.review=word.score<.35||word.units.some(u=>u.end-u.start<.035)||word.end-word.start>4;
    }
    line.start=line.words[0].start;line.end=line.words.at(-1).end;line.score=line.words.reduce((s,w)=>s+w.score,0)/line.words.length;
    line.review=line.words.some(w=>w.review);if(line.review)review.push(li);
  }
  return {lines,review,method:'ctc-russian',frameStep:.02};
}

export function lineWindows(target,anchors,duration){
  if(!anchors)return null;
  if(anchors.length!==target.lines.length)throw Error('Число строк в разметке не совпадает с текстом.');
  let prev=0;
  for(const a of anchors){if(!Number.isFinite(a.start)||!Number.isFinite(a.end)||a.start<prev-.001||a.end<=a.start||a.end>duration+.05)throw Error('Исправьте границы строк перед повторным уточнением.');prev=a.end;}
  return target.tokens.map(token=>token.ui<0?null:[Math.max(0,anchors[token.li].start-.15),Math.min(duration,anchors[token.li].end+.15)]);
}
