import {logSoftmaxFrames} from './ctc-align.js?v=5';
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

// CTC often emits a single spike for a vowel, even when the singer holds it.
// Follow the periodic signal and its spectral envelope around that spike.
// The search stops at a pause, a change of vowel, or the next aligned unit.
export function vocalBoundaries(samples) {
  const rate = 16000;
  const step = .02;
  const features = new Map();
  function feature(frame) {
    if (features.has(frame)) return features.get(frame);
    const center = Math.round(frame * step * rate);
    const signal = new Float32Array(160);
    let energy = 0;
    for (let i = 0; i < signal.length; i++) {
      const at = center + (i - 80) * 4;
      signal[i] = ((samples[at] ?? 0) + (samples[at + 1] ?? 0) +
        (samples[at + 2] ?? 0) + (samples[at + 3] ?? 0)) / 4;
      energy += signal[i] ** 2;
    }
    const rms = Math.sqrt(energy / signal.length);
    let periodicity = 0;
    if (rms > .0002) {
      for (let lag = 5; lag <= 48; lag++) {
        let cross = 0, left = 0, right = 0;
        for (let i = lag; i < signal.length; i++) {
          const a = signal[i], b = signal[i - lag];
          cross += a * b;
          left += a * a;
          right += b * b;
        }
        if (left > 0 && right > 0) periodicity = Math.max(periodicity, cross / Math.sqrt(left * right));
      }
    }
    // Lag correlations describe the envelope without requiring a fixed pitch
    // such as the exact note on which the acoustic model fired.
    const spectrum = [250, 430, 680, 1000, 1450, 1850].map(frequency => {
      const coefficient = 2 * Math.cos(2 * Math.PI * frequency / 4000);
      let last = 0, older = 0;
      for (let i = 0; i < signal.length; i++) {
        const next = signal[i] * (.5 - .5 * Math.cos(2 * Math.PI * i / 159)) +
          coefficient * last - older;
        older = last;
        last = next;
      }
      return Math.log1p(Math.max(0, last * last + older * older - coefficient * last * older) /
        Math.max(energy, 1e-10));
    });
    const result = {rms, periodicity, spectrum};
    features.set(frame, result);
    return result;
  }

  function similar(a, b) {
    const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
    const magnitudes = Math.hypot(...a) * Math.hypot(...b);
    return magnitudes ? dot / magnitudes : 0;
  }

  return {
    edge(span, direction, limit) {
      const initial = direction < 0 ? span.start : span.end;
      if (direction * (limit - initial) <= 0) return initial;
      const middle = Math.round((span.start + span.end) / (2 * step));
      const candidates = [middle, middle - 1, middle + 1].map(feature);
      const seed = candidates.reduce((best, value) =>
        value.periodicity * value.rms > best.periodicity * best.rms ? value : best);
      if (seed.periodicity < .55 || seed.rms < .0005) return initial;
      let lastGood = initial;
      let misses = 0;
      for (let at = initial + direction * step; direction * (limit - at) >= 0; at += direction * step) {
        const current = feature(Math.round(at / step));
        const matching = current.periodicity >= .57 && current.rms >= Math.max(.0005, seed.rms * .16) &&
          similar(seed.spectrum, current.spectrum) >= .72;
        if (matching) {
          lastGood = at;
          misses = 0;
        } else if (++misses >= 2) break;
      }
      return Math.round(lastGood * 1000) / 1000;
    },
  };
}
