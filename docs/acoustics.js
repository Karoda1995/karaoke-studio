import {logSoftmaxFrames} from './ctc-align.js';
export async function extractEmissions(aligner,samples,onProgress=()=>{}){
  const chunks=[],times=[],rate=16000,hop=16*rate,context=2*rate,duration=samples.length/rate;let total=0,vocabSize;
  // Nonoverlapping 16-second interiors, plus 2 seconds of acoustic context on
  // both sides. Only keep the interior predictions, preventing duplicated words.
  for(let offset=0;offset<samples.length;offset+=hop){
    const start=Math.max(0,offset-context),end=Math.min(samples.length,offset+hop+context);let audio=samples.subarray(start,end);
    // The convolutional front end requires at least 400 input samples.
    if(audio.length<400){const padded=new Float32Array(400);padded.set(audio);audio=padded;}
    onProgress({value:offset/samples.length*85,message:`Слушаю вокал: ${Math.floor(offset/rate)} / ${Math.ceil(duration)} с`});
    const inputs=await aligner.processor(audio);let outputs;
    try{
      outputs=await aligner.model(inputs);const logits=outputs.logits;vocabSize=logits.dims[2];const raw=logits.data,kept=[];
      for(let f=0;f<logits.dims[1];f++){
        // XLSR convolution: stride=320 samples, receptive field=400 samples.
        const center=start+f*320+200;
        if(center<offset||center>=Math.min(offset+hop,samples.length))continue;
        kept.push(f);times.push(Math.max(0,(center-160)/rate));
      }
      const selected=new Float32Array(kept.length*vocabSize);
      kept.forEach((f,i)=>selected.set(raw.subarray(f*vocabSize,(f+1)*vocabSize),i*vocabSize));
      chunks.push(logSoftmaxFrames(selected,vocabSize));total+=selected.length;
    }finally{for(const x of Object.values(inputs))x?.dispose?.();if(outputs)for(const x of Object.values(outputs))x?.dispose?.();}
  }
  const emissions=new Float32Array(total);let cursor=0;for(const c of chunks){emissions.set(c,cursor);cursor+=c.length;}
  return {emissions,times:new Float64Array(times),vocabSize};
}
