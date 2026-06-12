/** Linear resampling into an `AudioBuffer` at the context rate (the Web Audio
 *  spec only guarantees buffer rates ≥ 8000 Hz; game audio runs below or off it). */

export function resampledBuffer(
  ctx: BaseAudioContext,
  length: number,
  rate: number,
  sample: (i: number) => number,
): AudioBuffer | null {
  if (length === 0) return null;
  const n = Math.max(1, Math.round((length * ctx.sampleRate) / rate));
  let buffer: AudioBuffer;
  try {
    buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  } catch {
    return null;
  }
  const out = buffer.getChannelData(0);
  const step = rate / ctx.sampleRate;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), length - 1);
    const i1 = Math.min(i0 + 1, length - 1);
    const frac = pos - i0;
    const s0 = sample(i0);
    const s1 = sample(i1);
    out[i] = s0 + (s1 - s0) * frac;
  }
  return buffer;
}
