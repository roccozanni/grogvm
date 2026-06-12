// @vitest-environment happy-dom
/**
 * Tests the Explorer dossier panels + room rail against synthetic dossier
 * slices — no game data, no canvas (the background's ok-path needs a real 2D
 * context). Covers: rail selection drives the signal, scripts disassemble on
 * click, objects list their verbs, and a failed section shows its error.
 */
import { describe, it, expect } from 'vitest';
import { signal, createRoot } from '../reactive';
import { roomRail, scriptsPanel, objectsPanel, backgroundPanel } from './panels';
import { costumesPanel } from './costume-panel';
import { soundsPanel, type SoundPlayer } from './sounds-panel';
import type { RoomRef } from '../../engine/room/extract';
import type { LoadedObject } from '../../engine/object/loader';
import type { ResourceFile } from '../../engine/resources/tree';
import type { SoundResource } from '../../engine/sound/resource';

const refs: RoomRef[] = [
  { roomId: 5, lflfIndex: 0, roomBlock: {} as never },
  { roomId: 9, lflfIndex: 1, roomBlock: {} as never },
];

describe('roomRail', () => {
  it('highlights the selected room and updates the signal on click', () => {
    createRoot(() => {
      const current = signal(5);
      const rail = roomRail(refs, current);
      const items = [...rail.querySelectorAll('.room-rail-item')] as HTMLButtonElement[];
      expect(items.map((i) => i.textContent)).toEqual(['5', '9']);
      expect(items[0]!.classList.contains('selected')).toBe(true);

      items[1]!.click();
      expect(current()).toBe(9);
      expect(items[0]!.classList.contains('selected')).toBe(false);
      expect(items[1]!.classList.contains('selected')).toBe(true);
    });
  });

  it('prev/next step through rooms', () => {
    createRoot(() => {
      const current = signal(5);
      const rail = roomRail(refs, current);
      const next = rail.querySelector('.room-rail-nav button:last-child') as HTMLButtonElement;
      next.click();
      expect(current()).toBe(9);
      next.click(); // already last — no-op
      expect(current()).toBe(9);
    });
  });
});

describe('scriptsPanel', () => {
  const noGlobals = { ok: true as const, value: [] };

  it('shows the active script already disassembled in the pane', () => {
    createRoot(() => {
      const panel = scriptsPanel(
        { ok: true, value: [{ label: 'ENCD (entry)', kind: 'entry', id: null, bytecode: new Uint8Array([0xa0]) }] },
        noGlobals,
      )!;
      expect(panel.querySelector('.disasm-tab')!.textContent).toBe('ENCD (entry)');
      expect(panel.querySelector('.disasm-pane .disasm-line')).not.toBeNull();
    });
  });

  it('returns null when there are no room scripts and no referenced globals', () => {
    expect(scriptsPanel({ ok: true, value: [] }, noGlobals)).toBeNull();
  });

  it('merges referenced globals into the tabs, ENCD/EXCD first then numbered by id', () => {
    createRoot(() => {
      const panel = scriptsPanel(
        {
          ok: true,
          value: [
            { label: 'local #202', kind: 'local', id: 202, bytecode: new Uint8Array([0xa0]) },
            { label: 'EXCD (exit)', kind: 'exit', id: null, bytecode: new Uint8Array([0xa0]) },
            { label: 'ENCD (entry)', kind: 'entry', id: null, bytecode: new Uint8Array([0xa0]) },
          ],
        },
        { ok: true, value: [{ id: 25, room: 5, bytecode: new Uint8Array([0xa0]) }] },
      )!;
      const labels = [...panel.querySelectorAll('.disasm-tab')].map((t) => t.textContent);
      expect(labels).toEqual(['ENCD (entry)', 'EXCD (exit)', 'global #25', 'local #202']);
    });
  });

  it('still renders an error panel when the section failed', () => {
    const panel = scriptsPanel({ ok: false, error: 'bad LSCR' }, noGlobals);
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.dossier-error')!.textContent).toContain('bad LSCR');
  });
});

describe('objectsPanel', () => {
  const obj = (objId: number, name: string, verbs = new Map<number, Uint8Array>()): LoadedObject => ({
    objId,
    cdhd: { objId, x: 1, y: 2, width: 3, height: 4, flags: 0, parent: 0, walkX: 80, walkY: 120, actorDir: 1 },
    imhd: { objId, numImages: 0, flags: 0, x: 8, y: 16, width: 24, height: 32 },
    images: new Map(),
    name,
    verbs,
  });
  const map = (...objs: LoadedObject[]) => new Map(objs.map((o) => [o.objId, o] as const));

  it('defaults to the first object and shows its name, count, and verbs', () => {
    createRoot(() => {
      const selected = signal<number | null>(null);
      const door = obj(42, 'door', new Map([[3, new Uint8Array([0xa0])]]));
      const panel = objectsPanel({ ok: true, value: map(door) }, selected, null, null)!;
      expect(selected()).toBe(42); // auto-selected
      expect(panel.querySelector('.object-name')!.textContent).toBe('door');
      expect(panel.querySelector('.dossier-panel-count')!.textContent).toBe('1');
      expect(panel.querySelector('.disasm-tab')!.textContent).toBe('verb 3');
      // The active verb is shown already disassembled, not behind a click.
      expect(panel.querySelector('.disasm-pane .disasm-line')).not.toBeNull();
    });
  });

  it('labels the 255 default verb', () => {
    createRoot(() => {
      const panel = objectsPanel(
        { ok: true, value: map(obj(7, 'sign', new Map([[255, new Uint8Array([0xa0])]]))) },
        signal<number | null>(null),
        null,
        null,
      )!;
      expect(panel.querySelector('.disasm-tab')!.textContent).toBe('default');
    });
  });

  it('prev/next steps the shared selection through the objects', () => {
    createRoot(() => {
      const selected = signal<number | null>(null);
      const panel = objectsPanel({ ok: true, value: map(obj(10, 'a'), obj(20, 'b')) }, selected, null, null)!;
      expect(selected()).toBe(10);
      (panel.querySelector('.object-nav button:nth-child(2)') as HTMLButtonElement).click(); // next
      expect(selected()).toBe(20);
      expect(panel.querySelector('.object-name')!.textContent).toBe('b');
    });
  });
});

describe('costumesPanel', () => {
  it('returns null when the room has no costumes (panel omitted)', () => {
    expect(costumesPanel([], {} as ResourceFile, null)).toBeNull();
  });
});

describe('section errors', () => {
  it('renders a decode error instead of throwing', () => {
    const panel = backgroundPanel({ ok: false, error: 'no CLUT' }, [], [], [], signal<number | null>(null));
    expect(panel.querySelector('.dossier-error')!.textContent).toContain('no CLUT');
  });
});

describe('soundsPanel', () => {
  const pcm = (jiffies: number): SoundResource => ({
    durationJiffies: jiffies,
    looping: false,
    rendition: { kind: 'pcm', samples: new Uint8Array(8), rate: 10000 },
  });
  const silent: SoundResource = { durationJiffies: 0, looping: false, rendition: { kind: 'silent' } };
  const playablePcm = (res: SoundResource): boolean => res.rendition.kind === 'pcm';

  /** A SoundPreview stand-in that flips its playing key like the real one. */
  const stubPlayer = (): SoundPlayer & { toggled: number[] } => {
    const player = {
      toggled: [] as number[],
      onChange: (() => {}) as (playing: number | null) => void,
      playing: null as number | null,
      toggle(key: number) {
        this.toggled.push(key);
        this.playing = this.playing === key ? null : key;
        this.onChange(this.playing);
      },
    };
    return player;
  };

  it('returns null for a room with no sounds', () => {
    expect(soundsPanel([], playablePcm, stubPlayer())).toBeNull();
  });

  it('lists rows with id, kind, and duration', () => {
    createRoot(() => {
      const panel = soundsPanel(
        [
          { id: 28, res: pcm(164) },
          { id: 7, res: silent },
        ],
        playablePcm,
        stubPlayer(),
      )!;
      const rows = [...panel.querySelectorAll('.sound-row')];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.querySelector('.sound-id')!.textContent).toBe('#28');
      expect(rows[0]!.querySelector('.sound-kind')!.textContent).toContain('digitized');
      expect(rows[0]!.querySelector('.sound-duration')!.textContent).toBe('2.7 s');
    });
  });

  it('play toggles through the player and tracks the playing row', () => {
    createRoot(() => {
      const player = stubPlayer();
      const panel = soundsPanel(
        [
          { id: 1, res: pcm(60) },
          { id: 2, res: pcm(60) },
        ],
        playablePcm,
        player,
      )!;
      const [a, b] = [...panel.querySelectorAll('.sound-play-btn')] as HTMLButtonElement[];
      expect(a!.textContent).toBe('►');
      a!.click();
      expect(player.toggled).toEqual([1]);
      expect(a!.textContent).toBe('■');
      expect(a!.classList.contains('is-on')).toBe(true);
      expect(b!.textContent).toBe('►');
      a!.click(); // stop
      expect(a!.textContent).toBe('►');
    });
  });

  it('disables the button for unplayable renditions', () => {
    createRoot(() => {
      const panel = soundsPanel([{ id: 7, res: silent }], playablePcm, stubPlayer())!;
      const btn = panel.querySelector('.sound-play-btn') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });
});
