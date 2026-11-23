import {parseTimecode,retapLine,timecode,timedUnit} from './timing-edit.js?v=5';
import {canvasFont,drawKaraoke,resolveFont} from './karaoke-renderer.js?v=5';
import {parseLyrics,roughTiming,validateTimeline} from './engine.js?v=5';
import {buildTarget} from './ctc-align.js?v=5';
import {AudioTransport} from './transport.js';
const $=id=>document.getElementById(id),canvas=$('screen'),ctx=canvas.getContext('2d');
const S={audio:null,tracks:{vocal:null,backing:null},image:null,imageData:null,lines:[],duration:0,color:'#ffad66',ratio:'wide',exporting:false,busy:false,tapIndex:-1,tapBackup:null,selectedLine:0,selectedWord:0,loop:false,peaks:{},waveBase:null};
let ac,worker,activeJob,recording,exportFrame,exportRestore,aiGeneration=0;
const DEFAULT_COLOR = '#ffad66';
const DEFAULT_OFFSET = '-0.3';
let dynamic = null;

function timeField(seconds, label, apply) {
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'text';
  input.autocomplete = 'off';
  input.className = 'timecode';
  input.title = label + ' · мм:сс:мс';
  input.setAttribute('aria-label', label + ', минуты:секунды:миллисекунды');
  input.value = timecode(seconds);
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
  });
  input.addEventListener('change', () => {
    const next = parseTimecode(input.value);
    if (Number.isFinite(next) && Math.abs(next - seconds) < .0005) input.value = timecode(seconds);
    else if (Number.isFinite(next) && apply(next)) input.value = timecode(next);
    else {
      input.value = timecode(seconds);
      if (!Number.isFinite(next)) status('Введите время в формате ММ:СС:ммм, например 01:25:300.', true);
    }
  });
  return input;
}
function status(msg,error=false){$('status').parentElement.hidden=!msg;$('status').textContent=msg;$('status').classList.toggle('error',error);}
function safe(fn){return async(...args)=>{try{await fn(...args);}catch(e){status(e.message||String(e),true);console.error(e);}};}
async function context(){ac??=new AudioContext();return ac;}
function readData(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(Error('Не удалось прочитать файл'));r.readAsDataURL(file);});}
function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),60000);}
function settings(){return Object.fromEntries(['dim','fontFamily','fontSize','lineTransition','panelOpacity','panelY','offset','resolution','backingOffset'].map(id=>[id,$(id).value]));}
function resize(){const h=Number($('resolution').value),w=S.ratio==='wide'?Math.round(h*16/9):S.ratio==='vertical'?Math.round(h*9/16):h;canvas.width=w;canvas.height=h;draw();}
function refreshDuration(){S.duration=S.audio?.duration??0;$('duration').textContent=timecode(S.duration);$('seek').max=S.duration||1;S.waveBase=null;}
function refreshTracks(){
  $('audioName').textContent=S.tracks.vocal?.file.name??'Оригинал с вокалом';$('backingName').textContent=S.tracks.backing?.file.name??'Добавить минус';
  $('previewTrack').value=S.audio?.mode??'vocal';
  for(const opt of $('previewTrack').options)opt.disabled=!S.tracks[opt.value];
  refreshDuration();
}
async function decodeTrack(file){const audio=await context();const buffer=await audio.decodeAudioData(await file.arrayBuffer());if(!Number.isFinite(buffer.duration)||buffer.duration<=0)throw Error('Не удалось прочитать длительность аудио.');return {file,buffer,key:crypto.randomUUID(),samples:null};}
function installTrack(kind,track,{keep=false}={}){
  S.audio??=new AudioTransport(ac);S.audio.pause();S.tracks[kind]=track;S.audio.setTrack(kind,track.buffer);S.audio.onended=()=>{if(dynamic)finishDynamic();else if(S.tapIndex>=0)stopTap();};
  if(kind==='vocal'&&!keep){S.lines=[];renderLines();$('timingBadge').textContent='новый оригинал · нужна разметка';}
  if(kind==='backing'){$('exportTrack').value='backing';S.audio.select('backing');}else if(!S.tracks.backing)S.audio.select('vocal');
  if(!keep)S.audio.currentTime=0;delete S.peaks[kind];refreshTracks();
}
async function loadTrack(file,kind){if(S.exporting||S.busy||S.tapIndex>=0)return;status('Загружаю '+(kind==='vocal'?'оригинал с вокалом':'минус')+'…');const track=await decodeTrack(file);installTrack(kind,track);status(kind==='vocal'?'Оригинал загружен. Вставьте точный текст или расшифруйте запись, затем выровняйте текст по вокалу.':'Минус загружен и выбран для прослушивания и экспорта. Разметка по оригиналу сохранена.');}
async function samples16(track){if(track.samples)return track.samples;const off=new OfflineAudioContext(1,Math.ceil(track.buffer.duration*16000),16000),src=off.createBufferSource();src.buffer=track.buffer;src.connect(off.destination);src.start();track.samples=(await off.startRendering()).getChannelData(0);return track.samples;}
async function setImage(data){if(!data){S.image=null;S.imageData=null;return;}if(!/^data:image\//.test(data))throw Error('Неверный формат картинки.');const im=new Image();im.src=data;await im.decode();S.image=im;S.imageData=data;draw();}
function textChanged(){const parsed=parseLyrics($('lyrics').value);$('lineCount').textContent=`${parsed.length} строк`;if(S.lines.length){S.lines=[];S.loop=false;renderLines();$('timingBadge').textContent='текст изменён';status('Текст изменён. Выполните точное выравнивание заново.');}}
function assertAudio(){if(!S.audio||!S.duration)throw Error('Сначала добавьте аудиодорожку.');}
function assertMaterials(){assertAudio();if(!parseLyrics($('lyrics').value).length)throw Error('Добавьте текст песни.');}
function drawBackground(c,w,h){c.fillStyle='#141814';c.fillRect(0,0,w,h);}
function currentLine(t){let idx=S.lines.findIndex(l=>t>=l.start&&t<l.end);if(idx<0){idx=S.lines.findIndex(l=>t<l.start);if(idx<0)return -1;}return idx;}
function draw(){
  const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
  if(S.image){const scale=Math.max(w/S.image.width,h/S.image.height);ctx.drawImage(S.image,(w-S.image.width*scale)/2,(h-S.image.height*scale)/2,S.image.width*scale,S.image.height*scale);}else drawBackground(ctx,w,h);
  ctx.fillStyle=`rgba(0,0,0,${Number($('dim').value)/100})`;ctx.fillRect(0,0,w,h);
  drawKaraoke(ctx,{width:w,height:h,lines:S.lines,time:(S.audio?.currentTime??0)-Number($('offset').value),fontKey:$('fontFamily').value,fontSize:Number($('fontSize').value),color:S.color,panelOpacity:Number($('panelOpacity').value)/100,panelPosition:$('panelY').value,transitionMs:Number($('lineTransition').value)});
}
async function prepareKaraokeFont(){
  const key=$('fontFamily').value;
  try{await document.fonts.load(canvasFont(key,48),'Караоке — поём вместе');}
  catch{status(`Не удалось загрузить ${resolveFont(key).label}. Используется резервный шрифт браузера.`,true);}
  draw();
}
function waveform(){
  const c=$('waveform'),g=c.getContext('2d'),w=c.width,h=c.height,mode=S.audio?.mode??'vocal',track=S.tracks[mode];
  if(!S.waveBase){const base=document.createElement('canvas');base.width=w;base.height=h;const b=base.getContext('2d');b.fillStyle='#11170f';b.fillRect(0,0,w,h);
    if(track){let peaks=S.peaks[mode];if(!peaks){const signal=track.buffer.getChannelData(0),bins=Math.min(5000,signal.length),step=Math.max(1,Math.floor(signal.length/bins));peaks=new Float32Array(bins);for(let i=0;i<bins;i++){let max=0;for(let j=i*step;j<Math.min(signal.length,(i+1)*step);j+=Math.max(1,Math.floor(step/40)))max=Math.max(max,Math.abs(signal[j]));peaks[i]=max;}S.peaks[mode]=peaks;}
      b.fillStyle=mode==='backing'?'#6fa891':'#8aab64';const shift=mode==='backing'?Number($('backingOffset').value):0;for(let x=0;x<w;x+=2){const t=x/w*S.duration-shift,index=Math.floor(t/track.buffer.duration*peaks.length),amp=index>=0&&index<peaks.length?peaks[index]:0;const hh=Math.max(1,amp*h*.88);b.fillRect(x,(h-hh)/2,1,hh);}
    }S.waveBase=base;
  }
  g.drawImage(S.waveBase,0,0);const line=S.lines[S.selectedLine];if(line&&S.duration){g.fillStyle='#dfff8318';g.fillRect(line.start/S.duration*w,0,(line.end-line.start)/S.duration*w,h);g.strokeStyle='#dfff8366';g.strokeRect(line.start/S.duration*w,0,(line.end-line.start)/S.duration*w,h);}
  if(S.audio&&S.duration){const x=S.audio.currentTime/S.duration*w;g.fillStyle='#f4f7e8';g.fillRect(x,0,2,h);}$('waveformLabel').textContent=(mode==='backing'?'Минус':'Оригинал')+' · шкала времени оригинала';
}
function update(){S.audio?.tick();if(dynamic&&S.audio.currentTime>=dynamic.stopAt)finishDynamic();if(!S.exporting){if(S.loop&&!S.audio?.paused&&S.tapIndex<0){const l=S.lines[S.selectedLine],offset=Number($('offset').value);if(l&&S.audio.currentTime>=l.end+offset+.15)S.audio.currentTime=Math.max(0,l.start+offset-.15);}draw();waveform();if(S.audio){$('clock').textContent=timecode(S.audio.currentTime);$('seek').value=S.audio.currentTime;$('play').textContent=S.audio.paused?'▶':'Ⅱ';const idx=dynamic?.index??currentLine(S.audio.currentTime-Number($('offset').value));document.querySelectorAll('.timing-line').forEach(e=>e.classList.toggle('active',Number(e.dataset.index)===idx));}}requestAnimationFrame(update);}requestAnimationFrame(update);
$('audioFile').onchange=safe(async e=>{if(e.target.files[0])await loadTrack(e.target.files[0],'vocal');e.target.value='';});$('backingFile').onchange=safe(async e=>{if(e.target.files[0])await loadTrack(e.target.files[0],'backing');e.target.value='';});
for(const [id,kind]of [['audioDrop','vocal'],['backingDrop','backing']])for(const event of ['dragover','dragleave','drop'])$(id).addEventListener(event,safe(async e=>{e.preventDefault();$(id).classList.toggle('drag',event==='dragover');if(event==='drop'&&e.dataTransfer.files[0])await loadTrack(e.dataTransfer.files[0],kind);}));
$('imageFile').onchange=safe(async e=>{if(e.target.files[0]){await setImage(await readData(e.target.files[0]));$('imageName').textContent=e.target.files[0].name;}e.target.value='';});
$('lyrics').oninput=textChanged;$('textFile').onchange=safe(async e=>{if(!e.target.files[0])return;$('lyrics').value=await e.target.files[0].text();textChanged();if(parseLyrics($('lyrics').value).some(l=>l.lrc!==null)&&S.audio)createRough();e.target.value='';});
function createRough(){assertMaterials();const parsed=parseLyrics($('lyrics').value),lrc=parsed.some(l=>l.lrc!==null),duration=S.tracks.vocal?.buffer.duration??S.duration;if(lrc&&!parsed.every(l=>l.lrc!==null))throw Error('В LRC нужен таймкод для каждой строки.');if(lrc&&parsed.some((l,i)=>l.lrc>=duration||(i&&l.lrc<=parsed[i-1].lrc)))throw Error('Таймкоды LRC должны возрастать и находиться внутри записи.');S.lines=roughTiming($('lyrics').value,duration);$('timingBadge').textContent=lrc?'LRC · можно акустически уточнить':'черновик · равномерно';renderLines();status(lrc?'Начало строк взято из LRC. Включите учёт границ строк и запустите точное выравнивание.':'Это черновая разметка. Для точных границ запустите выравнивание по вокалу.');}
$('rough').onclick=safe(createRough);
$('play').onclick=safe(async()=>{assertAudio();if(S.exporting)return;if(S.audio.paused)await S.audio.play();else S.audio.pause();$('play').blur();});
$('seek').oninput=()=>{if(S.audio&&!S.exporting)S.audio.currentTime=Number($('seek').value);};$('fullscreen').onclick=safe(()=>canvas.requestFullscreen());
$('previewTrack').onchange=safe(()=>{assertAudio();if(S.tapIndex>=0)throw Error('Сначала завершите ручную запись слогов.');S.audio.select($('previewTrack').value);S.waveBase=null;});
$('speed').onchange=()=>{if(S.audio)S.audio.playbackRate=Number($('speed').value);};
$('backingOffset').onchange=safe(()=>{const n=Number($('backingOffset').value);if(!Number.isFinite(n)||Math.abs(n)>600)throw Error('Укажите сдвиг от −600 до 600 секунд.');S.audio?.setOffset(n);refreshDuration();status('Смещение минуса изменено. Прослушайте фразу с оригиналом и с минусом, чтобы проверить совпадение.');});
$('waveform').onclick=e=>{if(S.audio&&!S.exporting&&!dynamic&&S.tapIndex<0){const r=e.currentTarget.getBoundingClientRect();S.audio.currentTime=Math.max(0,Math.min(S.duration,(e.clientX-r.left)/r.width*S.duration));}};
for(const id of ['dim','fontSize','lineTransition','panelOpacity','panelY','offset','resolution'])$(id).oninput=()=>{if(id==='resolution'){if(!S.exporting)resize();}else draw();$('dimValue').textContent=$('dim').value+'%';$('fontValue').textContent=$('fontSize').value;$('opacityValue').textContent=$('panelOpacity').value+'%';$('transitionValue').textContent=$('lineTransition').value+' мс';};
$('fontFamily').onchange=safe(prepareKaraokeFont);
document.querySelectorAll('[data-ratio]').forEach(b=>b.onclick=()=>{if(S.exporting)return;S.ratio=b.dataset.ratio;document.querySelectorAll('[data-ratio]').forEach(x=>x.classList.toggle('selected',x===b));resize();});document.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>{S.color=b.dataset.color;$('customColor').value=S.color;document.querySelectorAll('[data-color]').forEach(x=>x.classList.toggle('selected',x===b));draw();});$('customColor').oninput=e=>{S.color=e.target.value;document.querySelectorAll('[data-color]').forEach(x=>x.classList.remove('selected'));draw();};
function dynamicButton(index, compact = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = compact ? 'small dynamic-icon' : 'small';
  button.textContent = compact ? 'С' : 'Динамический способ';
  button.title = 'Динамический способ';
  button.setAttribute('aria-label', 'Динамический способ, строка ' + (index + 1));
  button.onclick = safe(() => startDynamic(index));
  return button;
}

function renderLines(){const root=$('wordEditor');root.replaceChildren();$('syllableEditor').hidden=true;$('loopLine').textContent=`↻ Повтор строки: ${S.loop?'вкл.':'выкл.'}`;if(!S.lines.length){const empty=document.createElement('div');empty.className='empty-timeline';empty.textContent='Здесь появятся строки и тайминги вашей песни';root.append(empty);return;}
  S.lines.forEach((l,i)=>{if($('reviewOnly').checked&&!l.review)return;const row=document.createElement('div');row.className='timing-line'+(l.review?' needs-review':'');row.dataset.index=i;const num=document.createElement('span');num.textContent=String(i+1).padStart(2,'0');row.append(num);
    for (const key of ['start','end']) {
      row.append(timeField(l[key], key==='start' ? 'Начало строки' : 'Конец строки', value => {
        const min = S.lines[i-1]?.end??0;
        const max = S.lines[i+1]?.start??S.duration;
        const start = key==='start' ? value : l.start;
        const end = key==='end' ? value : l.end;
        if (start<0 || end>S.duration || start>=end ||
            start<min || end>max) {
          status('Строка должна находиться внутри песни и не пересекаться с соседними.', true);
          return false;
        }
        retime(l,start,end);
        renderLines();
        editLine(i);
        return true;
      }));
    }
    const button=document.createElement('button');button.textContent=l.text+(l.review?' · Уточнить':'');button.title='Открыть слова и слоги';button.onclick=()=>{if(S.audio&&!S.exporting)S.audio.currentTime=Math.max(0,l.start+Number($('offset').value));editLine(i);};row.append(button,dynamicButton(i,true));root.append(row);
  });if(!root.children.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='Строк, отмеченных для проверки, нет. Прослушайте результат целиком перед экспортом.';root.append(empty);}
}
function retime(obj,start,end){const old=obj.start,scale=(end-start)/Math.max(.001,obj.end-obj.start);for(const w of obj.words??[]){for(const u of w.units){u.start=start+(u.start-old)*scale;u.end=start+(u.end-old)*scale;}w.start=start+(w.start-old)*scale;w.end=start+(w.end-old)*scale;}if(obj.units)for(const u of obj.units){u.start=start+(u.start-old)*scale;u.end=start+(u.end-old)*scale;}obj.start=start;obj.end=end;}
function editLine(i){S.selectedLine=i;const root=$('syllableEditor');root.hidden=false;root.replaceChildren();const actions=document.createElement('div');actions.className='line-actions';const replay=document.createElement('button');replay.textContent='▶ Прослушать строку';replay.className='small';replay.onclick=safe(async()=>{const l=S.lines[i];S.audio.currentTime=Math.max(0,l.start+Number($('offset').value)-.15);S.loop=true;$('loopLine').textContent='↻ Повтор строки: вкл.';await S.audio.play();replay.blur();});const reviewed=document.createElement('button');reviewed.textContent=S.lines[i].review?'✓ Отметить как проверенную':'Пометить для проверки';reviewed.className='small';reviewed.onclick=()=>{S.lines[i].review=!S.lines[i].review;for(const w of S.lines[i].words)w.review=S.lines[i].review;renderLines();editLine(i);};actions.append(replay,dynamicButton(i),reviewed);root.append(actions);if(S.lines[i].review){const note=document.createElement('p');note.className='active-review-note';note.textContent='Здесь слабое акустическое совпадение или подозрительная длительность. Уточните на слух; это отметка для проверки, а не измеренная ошибка.';root.append(note);}
  const label=document.createElement('div');label.textContent='Выберите слово: можно поправить и всё слово, и отдельные слоги.';root.append(label);const chips=document.createElement('div');chips.className='word-chips';S.lines[i].words.forEach((w,j)=>{const b=document.createElement('button');b.textContent=w.text;if(w.review)b.classList.add('needs-review');b.onclick=()=>editWord(i,j);chips.append(b);});root.append(chips);const container=document.createElement('div');container.id='units';root.append(container);editWord(i,0);
}
function editWord(i,j){S.selectedWord=j;const word=S.lines[i].words[j],line=S.lines[i],root=$('units');root.replaceChildren();document.querySelectorAll('.word-chips button').forEach((b,k)=>b.classList.toggle('active',k===j));
  const bounds = document.createElement('div');
  bounds.className = 'word-bounds';
  for (const key of ['start','end']) {
    const label = document.createElement('label');
    label.textContent = key==='start' ? 'Начало слова' : 'Конец слова';
    label.append(timeField(word[key], label.textContent, value => {
      const start = key==='start' ? value : word.start;
      const end = key==='end' ? value : word.end;
      const min = j ? line.words[j-1].end : (S.lines[i-1]?.end??0);
      const max = j<line.words.length-1 ? line.words[j+1].start : (S.lines[i+1]?.start??S.duration);
      if (start<min || end>max || start>=end) {
        status('Слово не должно пересекаться с соседними словами.',true);
        return false;
      }
      retime(word,start,end);
      line.start=line.words[0].start;
      line.end=line.words.at(-1).end;
      renderLines();
      editLine(i);
      editWord(i,j);
      return true;
    }));
    bounds.append(label);
  }
  root.append(bounds);
  for (const [k,unit] of word.units.entries()) {
    const row=document.createElement('div');
    row.className='unit-row';
    const label=document.createElement('strong');
    label.textContent=unit.text;
    row.append(label);
    for (const key of ['start','end']) {
      row.append(timeField(unit[key], key==='start' ? 'Начало слога' : 'Конец слога', value => {
        const min=k ? word.units[k-1].start : word.start;
        const max=k<word.units.length-1 ? word.units[k+1].end : word.end;
        if (value<min || value>max || (key==='start' ? value>=unit.end : value<=unit.start) ||
            (key==='start' && k>0 && value<=min) ||
            (key==='end' && k<word.units.length-1 && value>=max)) {
          status('Слог должен находиться внутри слова и идти по порядку.',true);
          return false;
        }
        unit[key]=value;
        if (key==='start'&&k) word.units[k-1].end=value;
        if (key==='end'&&k<word.units.length-1) word.units[k+1].start=value;
        editWord(i,j);
        return true;
      }));
    }
    const b=document.createElement('button');b.textContent='▶';b.onclick=safe(async()=>{if(S.exporting)return;S.loop=false;$('loopLine').textContent='↻ Повтор строки: выкл.';S.audio.currentTime=Math.max(0,unit.start+Number($('offset').value)-.1);await S.audio.play();b.blur();});row.append(b);root.append(row);
  }
  const note=document.createElement('p');note.className='hint';note.textContent='Формат времени — минуты:секунды:миллисекунды. Снижение скорости помогает уточнить границы. Для своего деления слогов используйте знак | в тексте и повторите выравнивание.';root.append(note);
}
$('reviewOnly').onchange=renderLines;$('nextReview').onclick=()=>{const indices=S.lines.map((l,i)=>l.review?i:-1).filter(i=>i>=0);if(!indices.length){status('Все отмеченные места проверены.');return;}const next=indices.find(i=>i>S.selectedLine)??indices[0];editLine(next);S.audio.currentTime=Math.max(0,S.lines[next].start+Number($('offset').value)-.2);};$('loopLine').onclick=()=>{S.loop=!S.loop;$('loopLine').textContent=`↻ Повтор строки: ${S.loop?'вкл.':'выкл.'}`;};
function setBusy(on){S.busy=on;for(const id of ['sync','transcribe','rough','tap','audioFile','backingFile','textFile','lyrics','export','openProject','importTiming','saveProject','useAnchors','model','backingOffset','applyTranscript'])$(id).disabled=on;$('cancelAI').hidden=!on;$('aiProgress').hidden=!on;}
function runWorker(data){worker??=new Worker('./asr-worker.js?v=5',{type:'module'});return new Promise((resolve,reject)=>{activeJob={reject};worker.onmessage=({data:message})=>{if(message.type==='progress'){$('aiProgress').value=message.value;status(`Загрузка модели ${Math.round(message.value)}% · ${message.label}`);}if(message.type==='phase'){if(Number.isFinite(message.value))$('aiProgress').value=message.value;else $('aiProgress').removeAttribute('value');status(message.message);}if(message.type==='error'){activeJob=null;reject(Error(message.message));}if(message.type==='result'){activeJob=null;resolve(message.result);}};worker.onerror=e=>{worker?.terminate();worker=null;activeJob=null;reject(Error(e.message||'Не удалось запустить акустическую модель.'));};worker.postMessage(data,[data.samples.buffer]);});}
$('cancelAI').onclick=()=>{aiGeneration++;worker?.terminate();worker=null;const pending=activeJob;activeJob=null;pending?.reject(Error('Обработка отменена. Прежние тайминги сохранены.'));};
async function runAI(action){if(S.busy||S.exporting||dynamic)return;if(!S.tracks.vocal)throw Error('Для распознавания нужен оригинал с вокалом. Минус используется только для прослушивания и экспорта.');if(action==='align'){assertMaterials();buildTarget($('lyrics').value);}const generation=++aiGeneration;S.audio.pause();S.loop=false;setBusy(true);$('aiProgress').value=0;status('Подготовка оригинала с вокалом…');
  try{const samples=new Float32Array(await samples16(S.tracks.vocal));if(generation!==aiGeneration)throw Error('Обработка отменена.');const data={action,samples,audioKey:S.tracks.vocal.key,dtype:$('model').value,text:$('lyrics').value};if(action==='align'&&$('useAnchors').checked){if(!S.lines.length)throw Error('Сначала импортируйте LRC или задайте границы строк.');data.anchors=S.lines.map(l=>({start:l.start,end:l.end}));}const result=await runWorker(data);
    if(action==='transcribe'){$('transcript').value=(result.chunks?.length?result.chunks.map(c=>c.text.trim()).filter(Boolean).join('\n'):result.text??'').trim();$('transcriptPanel').hidden=false;status('Расшифровка готова. Исправьте черновик, вставьте его в текст песни и запустите точное выравнивание.');}
    else{validateTimeline(result.lines,S.tracks.vocal.buffer.duration);S.lines=result.lines;$('timingBadge').textContent=`акустика · ${result.review.length} строк для проверки`;renderLines();status(result.method==='estimated'?'Для этого алфавита создана черновая разметка. Уточните её динамическим способом.':`Тайминги выровнены по вокалу. Строк для проверки: ${result.review.length}.`);}
  }catch(e){status(e.message+(action==='align'?' Предыдущая разметка сохранена.':''),true);}finally{setBusy(false);}
}
$('sync').onclick=safe(()=>runAI('align'));$('transcribe').onclick=safe(()=>runAI('transcribe'));$('applyTranscript').onclick=()=>{$('lyrics').value=$('transcript').value;textChanged();status('Черновик вставлен. Исправьте слова и строки, затем выровняйте по вокалу.');};
function showNextTap() {
  const {starts, units, stopAt} = dynamic;
  const next = units[starts.length];
  $('dynamicPrompt').textContent = next
    ? `Слог ${starts.length + 1} из ${units.length} · «${next.text}»`
    : `Все слоги отмечены. Нажмите С на конце строки или дождитесь ${timecode(stopAt)}.`;
  $('dynamicMark').textContent = next ? 'С · Отметить слог' : 'С · Отметить конец';
}

async function startDynamic(index) {
  if (S.busy || S.exporting || dynamic) return;
  assertAudio();
  const line = S.lines[index];
  const previous = S.lines[index - 1];
  const units = line.words.flatMap(word => word.units).filter(timedUnit);
  if (!units.length || line.end <= line.start) throw Error('У этой строки нет слогов или допустимого интервала.');
  S.audio.pause();
  const source = S.audio.mode;
  const previousPosition = S.audio.currentTime;
  if (S.tracks.vocal) S.audio.select('vocal');
  $('previewTrack').value = S.audio.mode;
  S.waveBase = null;
  S.loop = false;
  editLine(index);
  $('loopLine').textContent = '↻ Повтор строки: выкл.';
  const controls = Array.from(document.querySelectorAll('button,input,textarea,select'))
    .filter(element => !element.closest('#dynamicPanel'));
  const state = {
    index, line, units, source, previousPosition, starts:[],
    earliest:previous?.end??0,
    stopAt:Math.min(line.end, S.lines[index + 1]?.start??S.duration, S.duration),
    controls:controls.map(element => [element, element.disabled]),
  };
  dynamic = state;
  S.busy = true;
  for (const control of controls) control.disabled = true;
  $('dynamicPanel').hidden = false;
  $('dynamicTitle').textContent = `Динамический способ · строка ${index + 1}`;
  showNextTap();
  $('dynamicMark').focus({preventScroll:true});
  S.audio.currentTime = Math.max(0, previous
    ? Math.min((previous.start + previous.end) / 2, line.start - .5)
    : line.start - 2);
  status('Слушайте оригинал и нажимайте С в начале каждого слога.');
  try {
    // Resume before starting so a cancellation during resume cannot restart playback.
    await S.audio.context.resume();
    if (dynamic === state) S.audio.start();
  } catch (error) {
    if (dynamic === state) finishDynamic(true);
    throw error;
  }
}

function markDynamic() {
  if (!dynamic || S.audio.paused) return;
  const {starts, units, earliest, stopAt} = dynamic;
  const instant = S.audio.currentTime;
  if (instant < earliest || instant >= stopAt || instant <= (starts.at(-1) ?? -1)) return;
  if (starts.length === units.length) {
    finishDynamic(false, instant);
    return;
  }
  starts.push(instant);
  showNextTap();
}

function finishDynamic(cancelled = false, end = dynamic?.stopAt) {
  if (!dynamic) return;
  const session = dynamic;
  dynamic = null;
  S.audio.pause();
  S.audio.select(session.source);
  $('previewTrack').value = S.audio.mode;
  S.waveBase = null;
  $('dynamicPanel').hidden = true;
  for (const [element, disabled] of session.controls) element.disabled = disabled;
  S.busy = false;
  const complete = session.starts.length === session.units.length;
  if (!cancelled && complete) {
    const line = retapLine(session.line, session.starts, end);
    const updated = S.lines.slice();
    updated[session.index] = line;
    validateTimeline(updated, S.duration);
    S.lines = updated;
    status(`Строка ${session.index + 1} сохранена · ${timecode(line.start)} — ${timecode(line.end)}.`);
  } else {
    status(cancelled ? 'Динамическая разметка отменена.' :
      `Отмечено ${session.starts.length} из ${session.units.length} слогов. Тайминги строки сохранены без изменений.`, !cancelled);
  }
  S.audio.currentTime = cancelled ? session.previousPosition : end;
  renderLines();
  editLine(session.index);
  const button = $('syllableEditor').querySelector('button[title="Динамический способ"]');
  button?.focus({preventScroll:true});
}

$('dynamicMark').onclick = safe(markDynamic);
$('dynamicCancel').onclick = () => finishDynamic(true);
window.addEventListener('keydown', event => {
  if (!dynamic) return;
  if (event.code === 'Escape') {
    event.preventDefault();
    finishDynamic(true);
  } else if (event.code === 'KeyC') {
    event.preventDefault();
    if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) markDynamic();
  }
});

function allUnits(){return S.lines.flatMap(l=>l.words.flatMap(w=>w.units));}
$('tap').onclick=safe(async()=>{assertMaterials();if(S.tapIndex>=0){stopTap();return;}if(!S.lines.length)createRough();S.audio.pause();if(S.tracks.vocal){S.audio.select('vocal');$('previewTrack').value='vocal';S.waveBase=null;}S.audio.currentTime=0;S.loop=false;S.tapBackup=structuredClone(S.lines);S.tapIndex=0;$('tap').blur();$('tap').textContent='■ Прервать';setBusy(true);$('tap').disabled=false;$('cancelAI').hidden=true;$('aiProgress').hidden=true;$('previewTrack').disabled=true;$('offset').disabled=true;$('seek').disabled=true;document.querySelectorAll('#wordEditor input,#wordEditor button,#syllableEditor input,#syllableEditor button').forEach(el=>el.disabled=true);$('timelineHelp').textContent='Нажимайте ПРОБЕЛ в начале каждого слога. Последний слог завершится через 0,6 с — поправьте конец при необходимости.';status(`Первый слог: «${allUnits()[0].text}». Нажимайте пробел в момент начала слога.`);await S.audio.play();});
function recalcLines(){for(const l of S.lines){for(const w of l.words){w.start=w.units[0].start;w.end=w.units.at(-1).end;}l.start=l.words[0].start;l.end=l.words.at(-1).end;}}
function stopTap(){const incomplete=S.tapIndex>=0&&S.tapIndex<allUnits().length;if(incomplete&&S.tapBackup)S.lines=S.tapBackup;S.tapBackup=null;S.tapIndex=-1;setBusy(false);$('previewTrack').disabled=false;$('offset').disabled=false;$('seek').disabled=false;$('tap').textContent='● Отбивать слоги';$('timelineHelp').textContent='Формат времени — минуты:секунды:миллисекунды. Нажмите на строку для правки слов и слогов.';recalcLines();renderLines();status(incomplete?'Запись прервана. Предыдущие тайминги восстановлены.':'Слоги записаны. Уточните окончание последнего слога на слух.');}
window.addEventListener('keydown',e=>{if(dynamic||e.code!=='Space'||/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)||S.exporting)return;e.preventDefault();if(S.tapIndex>=0){if(S.audio.paused){status('Сначала запустите песню кнопкой ▶.');return;}const units=allUnits(),t=Math.max(0,S.audio.currentTime-Number($('offset').value));if(t>=S.duration||(S.tapIndex>0&&t<=units[S.tapIndex-1].start))return;units[S.tapIndex].start=t;if(S.tapIndex>0)units[S.tapIndex-1].end=t;units[S.tapIndex].end=Math.min(S.duration,t+.3);S.tapIndex++;if(S.tapIndex>=units.length){units.at(-1).end=Math.min(S.duration,t+.6);stopTap();}else status(`Следующий слог: «${units[S.tapIndex].text}» · ${S.tapIndex}/${units.length}`);}else $('play').click();});
$('downloadTiming').onclick=safe(()=>{if(!S.lines.length)throw Error('Сначала создайте тайминги.');validateTimeline(S.lines,S.duration);download(new Blob([JSON.stringify({version:2,method:'acoustic-or-manual',lines:S.lines},null,2)],{type:'application/json'}),'karaoke-timing.json');});$('importTiming').onclick=()=>$('timingFile').click();$('timingFile').onchange=safe(async e=>{const f=e.target.files[0];if(!f)return;assertAudio();const text=await f.text();if(f.name.toLowerCase().endsWith('.lrc')){$('lyrics').value=text;textChanged();createRough();}else{const d=JSON.parse(text),lines=validateTimeline(d.lines??d,S.duration);S.lines=lines;$('lyrics').value=lines.map(l=>l.text).join('\n');$('lineCount').textContent=`${lines.length} строк`;$('timingBadge').textContent='тайминги импортированы';renderLines();status('Тайминги импортированы.');}e.target.value='';});
$('saveProject').onclick=safe(async()=>{if(S.exporting||S.busy)throw Error('Дождитесь завершения текущей операции.');status('Сохраняю обе дорожки, фон и разметку…');const tracks={};for(const [kind,track]of Object.entries(S.tracks))tracks[kind]=track?{name:track.file.name,data:await readData(track.file)}:null;const data={type:'kadr-karaoke',version:2,tracks,image:S.imageData,lyrics:$('lyrics').value,lines:S.lines,color:S.color,ratio:S.ratio,settings:settings(),previewTrack:S.audio?.mode??'vocal',exportTrack:$('exportTrack').value};download(new Blob([JSON.stringify(data)],{type:'application/json'}),'Моё караоке.karaoke');status('Проект сохранён с оригиналом, минусом, текстом, фоном и таймингами.');});
async function trackFromData(d){if(!d)return null;if(typeof d.data!=='string'||!/^data:(?:audio\/[^;,]+|application\/octet-stream)?;base64,/.test(d.data))throw Error('Некорректное аудио в проекте.');const blob=await(await fetch(d.data)).blob();return decodeTrack(new File([blob],String(d.name||'audio.wav'),{type:blob.type}));}
$('openProject').onclick=()=>$('projectFile').click();$('projectFile').onchange=safe(async e=>{const file=e.target.files[0];if(!file)return;const d=JSON.parse(await file.text());if(d.type!=='kadr-karaoke'||![1,2].includes(d.version)||typeof d.lyrics!=='string')throw Error('Это не поддерживаемый проект Кадр.');if(d.lines?.length)validateTimeline(d.lines);const inputs=d.version===1?{vocal:d.audio,backing:null}:d.tracks;if(!inputs||typeof inputs!=='object')throw Error('Не найдены дорожки проекта.');const tracks={vocal:await trackFromData(inputs.vocal),backing:await trackFromData(inputs.backing)};const shift=Number(d.settings?.backingOffset??0);if(!Number.isFinite(shift)||Math.abs(shift)>600)throw Error('Неверный сдвиг минуса.');const duration=Math.max(tracks.vocal?.buffer.duration??0,(tracks.backing?tracks.backing.buffer.duration+shift:0),0);if(d.lines?.length)validateTimeline(d.lines,duration||86400);if(d.image){if(!/^data:image\//.test(d.image))throw Error('Неверная картинка проекта.');const im=new Image();im.src=d.image;await im.decode();}
  S.audio?.pause();S.audio=null;S.tracks={vocal:null,backing:null};S.peaks={};S.lines=[];S.loop=false;for(const kind of ['vocal','backing'])if(tracks[kind])installTrack(kind,tracks[kind],{keep:true});S.audio?.setOffset(shift);if(S.audio&&tracks[d.previewTrack])S.audio.select(d.previewTrack);$('exportTrack').value=['vocal','backing'].includes(d.exportTrack)?d.exportTrack:tracks.backing?'backing':'vocal';
  await setImage(d.image);S.lines=d.lines??[];$('lyrics').value=d.lyrics;$('lineCount').textContent=`${parseLyrics(d.lyrics).length} строк`;S.ratio=['wide','vertical','square'].includes(d.ratio)?d.ratio:'wide';S.color=/^#[a-f0-9]{6}$/i.test(d.color)?d.color:'#ffad66';
  $('fontFamily').value='manrope';$('lineTransition').value='320';$('offset').value=DEFAULT_OFFSET;
  for(const [id,value]of Object.entries(d.settings??{}))if(['dim','fontFamily','fontSize','lineTransition','panelOpacity','panelY','offset','resolution','backingOffset'].includes(id))$(id).value=value;if(!$('fontFamily').value)$('fontFamily').value='manrope';$('backingOffset').value=shift;$('speed').value='1';$('transitionValue').textContent=$('lineTransition').value+' мс';await prepareKaraokeFont();
  document.querySelectorAll('[data-ratio]').forEach(b=>b.classList.toggle('selected',b.dataset.ratio===S.ratio));$('customColor').value=S.color;document.querySelectorAll('[data-color]').forEach(b=>b.classList.toggle('selected',b.dataset.color===S.color));$('dimValue').textContent=$('dim').value+'%';$('fontValue').textContent=$('fontSize').value;$('opacityValue').textContent=$('panelOpacity').value+'%';$('imageName').textContent=d.image?'Фон из проекта':'Фоновая картинка';$('timingBadge').textContent=d.version===1?'старый проект · можно уточнить акустически':'проект загружен';refreshTracks();resize();renderLines();status(d.version===1?'Старый проект открыт. Его песня используется как оригинал. Добавьте минус и уточните тайминги.':'Проект открыт с обеими аудиодорожками.');e.target.value='';
});
function lockExport(on){S.exporting=on;document.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=on);$('cancelExport').disabled=false;$('cancelExport').hidden=!on;$('exportProgress').hidden=!on;}
function cleanupExport(){cancelAnimationFrame(exportFrame);S.audio?.pause();if(exportRestore){if(exportRestore.dest){S.audio.output.disconnect(exportRestore.dest);exportRestore.dest.stream.getTracks().forEach(t=>t.stop());}if(S.tracks[exportRestore.mode])S.audio.select(exportRestore.mode);S.audio.playbackRate=exportRestore.rate;S.audio.currentTime=exportRestore.time;S.loop=exportRestore.loop;S.audio.onended=()=>{if(dynamic)finishDynamic();else if(S.tapIndex>=0)stopTap();};exportRestore=null;}lockExport(false);recording=null;refreshTracks();draw();}
$('export').onclick=safe(async()=>{
  assertMaterials();if(!S.lines.length)throw Error('Сначала создайте или импортируйте тайминги.');validateTimeline(S.lines,S.duration);const mode=$('exportTrack').value;if(!S.tracks[mode])throw Error(mode==='backing'?'Добавьте минус для экспорта без вокала. Либо явно выберите «Оригинал с вокалом».':'Добавьте оригинал с вокалом.');
  if(!window.MediaRecorder||!canvas.captureStream)throw Error('Браузер не поддерживает запись видео. Используйте актуальный Chrome или Safari.');const mime=['video/mp4;codecs=avc1.424028,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(x=>MediaRecorder.isTypeSupported(x));if(!mime)throw Error('Нет поддерживаемого кодека записи.');
  lockExport(true);$('cancelExport').hidden=true;$('exportProgress').hidden=true;
  try{await prepareKaraokeFont();}catch(e){lockExport(false);throw e;}
  S.audio.pause();exportRestore={time:S.audio.currentTime,mode:S.audio.mode,rate:S.audio.playbackRate,loop:S.loop};S.loop=false;S.audio.select(mode);S.audio.playbackRate=1;S.audio.currentTime=0;resize();draw();let stream,rec,cancelled=false;const chunks=[];
  try{await ac.resume();const dest=ac.createMediaStreamDestination();exportRestore.dest=dest;S.audio.output.connect(dest);stream=canvas.captureStream(30);dest.stream.getAudioTracks().forEach(t=>stream.addTrack(t));rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:Number($('resolution').value)===1080?8000000:4500000,audioBitsPerSecond:192000});recording=rec;}
  catch(e){stream?.getTracks().forEach(t=>t.stop());cleanupExport();throw e;}
  lockExport(true);$('exportHint').textContent=`${mime.includes('mp4')?'MP4':'WebM'} · 30 кадров/с · ${mode==='backing'?'только минус, исходный вокал не подключён':'оригинал с вокалом'} · скорость 1×`;
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};rec.onerror=e=>{cancelled=true;status('Ошибка записи: '+(e.error?.message??'сбой кодека'),true);if(rec.state!=='inactive')rec.stop();else cleanupExport();};
  rec.onstop=()=>{stream.getTracks().forEach(t=>t.stop());if(!cancelled){download(new Blob(chunks,{type:mime}),`Караоке${mode==='backing'?' — минус':''}.${mime.includes('mp4')?'mp4':'webm'}`);status('Видео готово и скачивается. Звук: '+(mode==='backing'?'только минус.':'оригинал с вокалом.'));}cleanupExport();};
  $('cancelExport').onclick=()=>{cancelled=true;S.audio.pause();if(rec.state!=='inactive')rec.stop();status('Экспорт отменён.');};S.audio.onended=()=>{draw();if(rec.state!=='inactive')rec.stop();};
  const frame=()=>{draw();$('exportProgress').value=S.audio.currentTime/S.duration*100;status(`Экспорт ${Math.floor(S.audio.currentTime/S.duration*100)}% · ${timecode(S.audio.currentTime)} / ${timecode(S.duration)} · ${mode==='backing'?'минус':'оригинал'}. Оставьте вкладку на экране.`);exportFrame=requestAnimationFrame(frame);};
  try{rec.start(1000);await S.audio.play();frame();}catch(e){cancelled=true;if(rec.state!=='inactive')rec.stop();else cleanupExport();throw e;}
});
resize();refreshTracks();document.fonts.ready.then(draw);window.addEventListener('beforeunload',e=>{if(S.tracks.vocal||S.tracks.backing||S.lines.length){e.preventDefault();e.returnValue='';}});
