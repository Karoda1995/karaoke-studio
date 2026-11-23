import {parseLyrics,syllables} from './engine.js?v=5';

// Russian XLSR-53 CTC vocabulary, from the model's public vocab.json.
export const RU_VOCAB={'<pad>':0,'<s>':1,'</s>':2,'<unk>':3,'|':4,'-':5,'ё':6,...Object.fromEntries(Array.from('абвгдежзийклмнопрстуфхцчшщъыьэюя').map((c,i)=>[c,i+7]))};
export const ACOUSTIC_MODEL='onnx-community/wav2vec2-large-xlsr-53-russian-ONNX';
const vowels = /[аеёиоуыэюя]/u;
const latin = {a:'а',b:'б',c:'к',d:'д',e:'е',f:'ф',g:'г',h:'х',i:'и',j:'дж',k:'к',l:'л',m:'м',n:'н',o:'о',p:'п',q:'к',r:'р',s:'с',t:'т',u:'у',v:'в',w:'в',x:'кс',y:'й',z:'з'};
const english = {hello:'хэллоу', love:'лав', you:'ю', the:'зэ', i:'ай', baby:'бэйби', yeah:'йе', forever:'форэвер'};
const digraphs = {sh:'ш',ch:'ч',th:'з',ph:'ф',oo:'у',ee:'и',qu:'кв',ck:'к'};

function acousticLetters(text) {
  const lower = text.toLowerCase();
  return lower.replace(/[a-z]+/g, word => english[word] ??
    word.replace(/sh|ch|th|ph|oo|ee|qu|ck|[a-z]/g, part => digraphs[part] ?? latin[part]));
}

export function buildTarget(text, vocab = RU_VOCAB) {
  const lines = parseLyrics(text).map(line => {
    const words = line.text.split(/\s+/).map(raw => {
      const units = syllables(raw).map(text => ({text, start:0, end:0}));
      return {text:units.map(unit => unit.text).join(''), start:0, end:0, units};
    }).filter(word => word.units.length);
    return {text:words.map(word => word.text).join(' '), start:0, end:0, words};
  }).filter(line => line.words.length);
  const tokens = [];
  for (const [li, line] of lines.entries()) {
    for (const [wi, word] of line.words.entries()) {
      const start = tokens.length;
      for (const [ui, unit] of word.units.entries()) {
        const spelling = acousticLetters(unit.text).replace(/[^а-яё]/gu, '');
        const letters = spelling.replace(/([аеёиоуыэюя])\1+/gu, '$1');
        for (const char of letters) {
          const id = vocab[char] ?? vocab[char.replace('ё','е')];
          if (id !== undefined) tokens.push({id, li, wi, ui, char});
        }
        unit.estimated = (!letters && /[\p{L}\p{N}]/u.test(unit.text)) || /[a-z]/i.test(unit.text);
        unit.sustained = letters.length < spelling.length;
      }
      if (tokens.length > start) tokens.push({id:vocab['|'], li, wi, ui:-1, char:' '});
    }
  }
  if (!lines.length) throw Error('Добавьте текст песни.');
  if (tokens.length) tokens.pop();
  return {tokens, lines};
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

export function timelineFromAlignment(target, spans, duration, {voice, anchors} = {}) {
  const lines = structuredClone(target.lines);
  const groups = new Map();
  target.tokens.forEach((token, index) => {
    if (token.ui < 0) return;
    const unit = lines[token.li].words[token.wi].units[token.ui];
    if (!groups.has(unit)) groups.set(unit, []);
    groups.get(unit).push({...spans[index], char:token.char});
  });
  const units = lines.flatMap((line, li) => line.words.flatMap(word =>
    word.units.map(unit => ({unit, li, chars:groups.get(unit)}))));
  let previousEnd = 0;
  for (const [index, entry] of units.entries()) {
    if (!entry.chars) continue;
    const {unit, chars, li} = entry;
    const first = chars[0], last = chars.at(-1);
    let nextIndex = index + 1;
    while (nextIndex < units.length && !units[nextIndex].chars) nextIndex++;
    const nextStart = units[nextIndex]?.chars[0].start ?? duration;
    const anchor = anchors?.[li];
    const min = Math.min(first.start, Math.max(previousEnd, anchor?.start ?? 0));
    const max = Math.max(last.end, Math.min(nextStart, duration, anchor?.end ?? duration));
    const reach = unit.sustained || (chars.length === 1 && vowels.test(first.char)) ? 8 : .24;
    unit.start = Math.max(previousEnd, first.start);
    unit.end = Math.min(max, last.end);
    if (voice && vowels.test(first.char)) {
      unit.start = voice.edge(first, -1, Math.max(min, first.start - reach));
    }
    if (voice && vowels.test(last.char)) {
      unit.end = voice.edge(last, 1, Math.min(max, last.end + reach));
    }
    unit.start = Math.min(duration, Math.max(previousEnd, unit.start));
    unit.end = Math.min(duration, max, Math.max(unit.start, unit.end));
    previousEnd = unit.end;
    unit.score = chars.reduce((sum, char) => sum + char.peak, 0) / chars.length;
  }
  // Preserve punctuation and unmodelled writing in the displayed lyric. Only
  // spoken content without a match takes a share of the available gap.
  let cursor = 0;
  while (cursor < units.length) {
    if (units[cursor].chars) { cursor++; continue; }
    const from = cursor;
    while (cursor < units.length && !units[cursor].chars) cursor++;
    let at = from ? units[from - 1].unit.end : 0;
    const limit = units[cursor]?.unit.start ?? duration;
    const run = units.slice(from, cursor);
    const count = run.filter(({unit}) => unit.estimated).length;
    const step = count ? Math.max(0, limit - at) / count : 0;
    for (const {unit} of run) {
      const punctuationAt = !count && units[cursor]?.li === run[0].li &&
        units[from - 1]?.li !== run[0].li ? limit : at;
      unit.start = punctuationAt;
      if (unit.estimated) at += step;
      unit.end = unit.estimated ? Math.min(limit, at) : punctuationAt;
    }
  }
  const review = [];
  for (const [li, line] of lines.entries()) {
    for (const word of line.words) {
      const scored = word.units.filter(unit => unit.score !== undefined);
      word.start = word.units[0].start;
      word.end = word.units.at(-1).end;
      word.score = scored.reduce((sum, unit) => sum + unit.score, 0) / (scored.length || 1);
      word.review = word.units.some(unit => unit.estimated ||
        (unit.score !== undefined && (unit.score < .35 || unit.end - unit.start < .035)));
    }
    line.start = line.words[0].start;
    line.end = line.words.at(-1).end;
    line.score = line.words.reduce((sum, word) => sum + word.score, 0) / line.words.length;
    line.review = line.words.some(word => word.review);
    if (line.review) review.push(li);
  }
  return {lines, review, method:'ctc-russian', frameStep:.02};
}

export function lineWindows(target,anchors,duration){
  if(!anchors)return null;
  if(anchors.length!==target.lines.length)throw Error('Число строк в разметке не совпадает с текстом.');
  let prev=0;
  for(const a of anchors){if(!Number.isFinite(a.start)||!Number.isFinite(a.end)||a.start<prev-.001||a.end<=a.start||a.end>duration+.05)throw Error('Исправьте границы строк перед повторным уточнением.');prev=a.end;}
  return target.tokens.map(token=>token.ui<0?null:[Math.max(0,anchors[token.li].start-.15),Math.min(duration,anchors[token.li].end+.15)]);
}
