/**
 * Sounds dossier panel: every sound the index places in this room (`DSOU`
 * lane), with a play/stop audition button per row.
 */
import { signal, el, append, bindClass, bindText } from '../reactive';
import type { SoundResource } from '../../engine/sound/resource';
import { panel } from './panels';

export interface RoomSound {
  readonly id: number;
  readonly res: SoundResource;
}

/** What the panel needs from the platform's SoundPreview. */
export interface SoundPlayer {
  onChange: (playing: number | null) => void;
  toggle(key: number, res: SoundResource): void;
}

export function soundsPanel(
  sounds: readonly RoomSound[],
  playable: (res: SoundResource) => boolean,
  player: SoundPlayer,
): HTMLElement | null {
  if (sounds.length === 0) return null;

  const playing = signal<number | null>(null);
  player.onChange = (key) => playing.set(key);

  const rows = el('div', { class: 'sound-rows' });
  for (const { id, res } of sounds) {
    const btn = el('button', { class: 'secondary sound-play-btn', type: 'button' });
    bindText(btn, () => (playing() === id ? '■' : '►'));
    bindClass(btn, 'is-on', () => playing() === id);
    if (playable(res)) btn.addEventListener('click', () => player.toggle(id, res));
    else btn.disabled = true;
    append(
      rows,
      el(
        'div',
        { class: 'sound-row' },
        btn,
        el('span', { class: 'sound-id', text: `#${id}` }),
        el('span', { class: 'sound-kind', text: kindLabel(res) }),
        el('span', { class: 'sound-duration', text: durationLabel(res) }),
      ),
    );
  }
  return panel('Sounds', rows, { count: sounds.length });
}

function kindLabel(res: SoundResource): string {
  const r = res.rendition;
  switch (r.kind) {
    case 'pcm':
      return `digitized · ${Math.round(r.rate)} Hz`;
    case 'midi':
      // FM/MIDI renditions are catalogued but not auditioned (synth parked
      // on the parked/audio-synth branch).
      return `${r.device} (not rendered)`;
    case 'cd':
      return `CD track ${r.track}${r.startSec > 0 ? ` @ ${cueLabel(r.startSec)}` : ''}`;
    case 'silent':
      return 'silent / unrecognized';
  }
}

function cueLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function durationLabel(res: SoundResource): string {
  if (res.looping) return 'loops until stopped';
  if (res.durationJiffies > 0) return `${(res.durationJiffies / 60).toFixed(1)} s`;
  return '—';
}
