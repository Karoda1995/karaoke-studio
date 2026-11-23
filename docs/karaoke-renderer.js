// Pure, time-based layout: seeking, looping and export produce the same frame.
export const FONT_OPTIONS = {
  manrope: { label: 'Manrope', family: 'Manrope', fallback: 'Arial, sans-serif' },
  arial: { label: 'Arial', family: 'Arial', fallback: 'sans-serif' },
  verdana: { label: 'Verdana', family: 'Verdana', fallback: 'sans-serif' },
  georgia: { label: 'Georgia', family: 'Georgia', fallback: 'serif' },
  trebuchet: { label: 'Trebuchet MS', family: 'Trebuchet MS', fallback: 'sans-serif' },
  courier: { label: 'Courier New', family: 'Courier New', fallback: 'monospace' },
};

export function resolveFont(key) {
  return Object.hasOwn(FONT_OPTIONS, key) ? FONT_OPTIONS[key] : FONT_OPTIONS.manrope;
}

export function canvasFont(key, size) {
  const font = resolveFont(key);
  return `500 ${size}px "${font.family}", ${font.fallback}`;
}

const ease = x => x * x * (3 - 2 * x);

export function twoLineLayout(lines, time, transitionMs = 320) {
  // End times are monotonic in validated timelines. A line is replaced in its
  // own slot as soon as it finishes, giving the upcoming line a full-line lead.
  let low = 0, high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].end <= time) low = middle + 1;
    else high = middle;
  }
  const completed = low;
  const duration = Math.max(0, Math.min(1000, Number(transitionMs) || 0)) / 1000;
  return [0, 1].map(slot => {
    const replacements = Math.max(0, Math.ceil((completed - slot) / 2));
    const index = slot + replacements * 2;
    const previous = index - 2;
    const incoming = lines[index];
    const outgoing = replacements > 0 ? lines[previous] : null;
    if (outgoing && duration > 0) {
      // Finish the reveal before the new phrase starts singing, even with
      // unusually short phrases. Disappearance of a final line also animates.
      const available = incoming ? Math.max(.02, incoming.start - outgoing.end) : duration;
      const fadeDuration = Math.min(duration, available);
      const elapsed = time - outgoing.end;
      if (elapsed < fadeDuration) {
        const p = ease(Math.max(0, elapsed / fadeDuration));
        const layers = [{ index: previous, line: outgoing, opacity: 1 - p, shift: -p }];
        if (incoming) layers.push({ index, line: incoming, opacity: p, shift: 1 - p });
        return { slot, index: incoming ? index : -1, layers };
      }
    }
    return { slot, index: incoming ? index : -1, layers: incoming ? [{ index, line: incoming, opacity: 1, shift: 0 }] : [] };
  });
}

export function highlightWidth(ctx, line, time) {
  let prefix = '', width = 0;
  const words = line.words ?? [];
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    for (const unit of word.units ?? []) {
      const advance = ctx.measureText(prefix + unit.text).width - ctx.measureText(prefix).width;
      const fraction = unit.start === unit.end
        ? Number(time >= unit.start)
        : Math.min(1, Math.max(0, (time - unit.start) / (unit.end - unit.start)));
      width += advance * fraction;
      prefix += unit.text;
      if (time < unit.end) return Math.max(0, width);
    }
    if (wi < words.length - 1) {
      width += ctx.measureText(prefix + ' ').width - ctx.measureText(prefix).width;
      prefix += ' ';
    }
  }
  return Math.max(0, Math.min(ctx.measureText(line.text).width, width));
}

export function drawKaraoke(ctx, {
  width, height, lines, time, fontKey = 'manrope', fontSize = 48,
  color = '#dfff83', panelOpacity = .75, panelPosition = 'bottom', transitionMs = 320,
}) {
  const baseSize = Number(fontSize) * height / 720;
  const bandHeight = Math.max(baseSize * 3.2, height * .2);
  const bandY = panelPosition === 'middle' ? (height - bandHeight) / 2 : height * .77 - bandHeight * .3;
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${panelOpacity})`;
  ctx.fillRect(0, bandY, width, bandHeight);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const rows = lines.length ? twoLineLayout(lines, time, transitionMs) : [
    { slot: 0, layers: [{ line: { text: 'Здесь зазвучит ваша песня', words: [] }, opacity: 1, shift: 0 }] },
    { slot: 1, layers: [{ line: { text: 'Добавьте музыку и текст', words: [] }, opacity: 1, shift: 0 }] },
  ];
  for (const row of rows) {
    const y = bandY + bandHeight * (row.slot === 0 ? .33 : .72);
    for (const layer of row.layers) {
      if (layer.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha *= layer.opacity;
      ctx.font = canvasFont(fontKey, baseSize);
      const naturalWidth = ctx.measureText(layer.line.text).width;
      // Each phrase fits independently: an incoming long line never causes the
      // other, currently sung line or the band to suddenly change size.
      const size = naturalWidth > width * .9 ? baseSize * width * .9 / naturalWidth : baseSize;
      ctx.font = canvasFont(fontKey, size);
      const textWidth = ctx.measureText(layer.line.text).width;
      const x = (width - textWidth) / 2;
      const animatedY = y + layer.shift * height * .012;
      ctx.fillStyle = row.slot === 0 ? '#f6f6f1' : '#e2e5e1';
      ctx.fillText(layer.line.text, x, animatedY);
      const fill = highlightWidth(ctx, layer.line, time);
      if (fill > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, animatedY - size, Math.min(textWidth, fill), size * 2);
        ctx.clip();
        ctx.fillStyle = color;
        ctx.fillText(layer.line.text, x, animatedY);
        ctx.restore();
      }
      ctx.restore();
    }
  }
  ctx.restore();
  return rows;
}
