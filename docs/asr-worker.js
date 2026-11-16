import {extractEmissions} from './acoustics.js';
import {ACOUSTIC_MODEL,buildTarget,forceAlign,lineWindows,timelineFromAlignment} from './ctc-align.js';
let lib,aligner,loadedDtype,transcriber,loadedWhisper,cache;
const tell=(type,rest={})=>self.postMessage({type,...rest});
const progress=p=>{if(p.status==='progress')tell('progress',{value:p.progress,label:p.file});};
async function library(){if(!lib){lib=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');lib.env.allowLocalModels=false;lib.env.backends.onnx.wasm.numThreads=1;}return lib;}
async function align(data){
  const target=buildTarget(data.text),duration=data.samples.length/16000;
  if(duration>1200)throw Error('Точный режим рассчитан на фрагменты до 20 минут.');
  const {pipeline}=await library(),dtype=data.dtype==='fp32'?'fp32':'q8';
  // Keeping Whisper and XLSR resident together wastes gigabytes on small devices.
  if(transcriber){await transcriber.dispose();transcriber=null;loadedWhisper=null;}
  if(!aligner||loadedDtype!==dtype){if(aligner)await aligner.dispose();aligner=null;cache=null;tell('phase',{message:'Загрузка акустической модели русского языка…'});aligner=await pipeline('automatic-speech-recognition',ACOUSTIC_MODEL,{dtype,device:'wasm',progress_callback:progress});loadedDtype=dtype;}
  const key=`${data.audioKey}:${dtype}`;
  if(!cache||cache.key!==key){
    cache={key,...await extractEmissions(aligner,data.samples,update=>tell('phase',update))};
  }else tell('phase',{value:85,message:'Акустика уже рассчитана. Уточняю по вашему тексту…'});
  const spans=forceAlign(cache.emissions,cache.vocabSize,target.tokens,{times:cache.times,windows:lineWindows(target,data.anchors,duration),onProgress:p=>tell('phase',{value:85+p*15,message:`Выравниваю буквы и слоги: ${Math.round(p*100)}%`})});
  return timelineFromAlignment(target,spans,duration);
}
async function transcribe(data){
  const {pipeline}=await library();if(aligner){await aligner.dispose();aligner=null;cache=null;}
  const model=data.model||'Xenova/whisper-small';
  if(!transcriber||loadedWhisper!==model){if(transcriber)await transcriber.dispose();transcriber=await pipeline('automatic-speech-recognition',model,{dtype:'q8',device:'wasm',progress_callback:progress});loadedWhisper=model;}
  tell('phase',{message:'Расшифровываю оригинал с вокалом…'});
  return transcriber(data.samples,{language:'russian',task:'transcribe',return_timestamps:true,chunk_length_s:30,stride_length_s:5});
}
self.onmessage=async({data})=>{try{const result=data.action==='transcribe'?await transcribe(data):await align(data);tell('result',{result});}catch(e){tell('error',{message:e.message||String(e)});}};
