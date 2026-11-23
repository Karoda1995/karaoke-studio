export function timecode(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  return [
    String(Math.floor(ms / 60000)).padStart(2, '0'),
    String(Math.floor(ms / 1000) % 60).padStart(2, '0'),
    String(ms % 1000).padStart(3, '0'),
  ].join(':');
}

export function parseTimecode(value) {
  const text = value.trim();
  const parts = /^(\d+):([0-5]?\d):(\d{1,3})$/.exec(text);
  if (parts) return Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / 1000;
  // Accept pasted seconds as well, then display the result as a timecode.
  return /^\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(',', '.')) : NaN;
}

export const timedUnit = unit => /[\p{L}\p{N}]/u.test(unit.text);

export function retapLine(line, starts, end) {
  const result = structuredClone(line);
  const units = result.words.flatMap(word => word.units);
  const spoken = units.filter(timedUnit);
  if (!spoken.length || starts.length !== spoken.length || !Number.isFinite(end) ||
      starts.some((start, i) => !Number.isFinite(start) || start < 0 ||
        start >= (starts[i + 1] ?? end))) {
    throw Error('Отметьте начало каждого слога и конец строки.');
  }
  let i = 0;
  for (const unit of units) {
    unit.start = starts[i] ?? end;
    if (timedUnit(unit)) i++;
    unit.end = starts[i] ?? end;
    delete unit.score;
    delete unit.estimated;
  }
  for (const word of result.words) {
    word.start = word.units[0].start;
    word.end = word.units.at(-1).end;
    word.review = false;
    delete word.score;
  }
  result.start = starts[0];
  result.end = end;
  result.review = false;
  delete result.score;
  return result;
}
