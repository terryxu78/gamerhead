import type { VeoSegment } from '../types';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const secondsToSrtTime = (totalSec: number): string => {
  if (!Number.isFinite(totalSec) || totalSec < 0) totalSec = 0;
  const ms = Math.floor((totalSec - Math.floor(totalSec)) * 1000);
  const s = Math.floor(totalSec) % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
};

// Strip bracketed vocal-effect cues like "[Shouting excitedly]" or "(whispering)".
// These are Veo prompt directives (see services/prompts.ts VOCAL EFFECTS rule),
// not spoken words, so they must not appear in burned-in subtitles.
const stripVocalCues = (text: string): string =>
  text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Build an SRT from the script's per-segment dialogue and estimated durations.
 * Timing is estimated (not measured from actual audio) but sufficient for
 * script-driven burn-in.
 */
export const buildFallbackSrt = (segments: VeoSegment[]): string => {
  const lines: string[] = [];
  let cursor = 0;
  let idx = 1;
  for (const seg of segments) {
    const text = stripVocalCues(seg.dialogue || '');
    const dur = typeof seg.duration === 'number' ? seg.duration : 0;
    const start = cursor;
    const end = cursor + dur;
    cursor = end;
    if (!text || dur <= 0) continue;
    lines.push(String(idx++));
    lines.push(`${secondsToSrtTime(start)} --> ${secondsToSrtTime(end)}`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
};
