import { describe, expect, it, vi } from 'vitest';
import { toOtio } from './otio.js';
import { addOverlay, addSprite, removeSourceRange, trimClip } from '../core/ops.js';
import type { Manifest, MusicItem } from '../core/types.js';

const FPS = 30000 / 1001;

function manifest(clips: { srcIn: number; srcOut: number; sourceId?: string }[], sources?: Partial<Manifest['sources'][0]>[]): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 1,
    fps: FPS,
    width: 3840,
    height: 2160,
    sources: (sources ?? [{}]).map((s, i) => ({
      id: s.id ?? `s${i + 1}`,
      path: s.path ?? `/media/clip ${i + 1}#a.mp4`,
      duration: s.duration ?? 60,
      fps: s.fps ?? FPS,
      width: 3840,
      height: 2160,
      hasAudio: s.hasAudio ?? true,
    })),
    timeline: {
      video: clips.map((c, i) => ({ id: `c${i}`, sourceId: c.sourceId ?? 's1', srcIn: c.srcIn, srcOut: c.srcOut })),
      motion: [],
    },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

function videoTrack(o: any) {
  return o.tracks.children.find((t: any) => t.kind === 'Video');
}
function audioTrack(o: any) {
  return o.tracks.children.find((t: any) => t.kind === 'Audio');
}
function trackFrames(track: any): number {
  return track.children.reduce((a: number, c: any) => a + c.source_range.duration.value, 0);
}

describe('toOtio frame consistency', () => {
  it('frame-aligned clips (the ops invariant) sum exactly at 29.97', () => {
    // ops.snap() aligns every cut to the frame grid, so real manifests have
    // frame-aligned edges: 100 clips of exactly 2 frames each.
    const clips = Array.from({ length: 100 }, (_, i) => ({
      srcIn: Math.round(i * 18) / FPS,
      srcOut: (Math.round(i * 18) + 2) / FPS,
    }));
    const m = manifest(clips);
    const o: any = toOtio(m);
    expect(trackFrames(videoTrack(o))).toBe(200);
  });

  it('start+duration equals the rounded end frame for awkward ranges', () => {
    const m = manifest([{ srcIn: 1.001, srcOut: 2.9994 }]);
    const o: any = toOtio(m);
    const sr = videoTrack(o).children[0].source_range;
    expect(sr.start_time.value + sr.duration.value).toBe(Math.round(2.9994 * FPS));
  });
});

describe('toOtio audio alignment and media refs', () => {
  it('emits gaps for video-only segments so audio stays in sync', () => {
    const m = manifest(
      [
        { srcIn: 0, srcOut: 2, sourceId: 's1' },
        { srcIn: 0, srcOut: 2, sourceId: 's2' },
        { srcIn: 2, srcOut: 4, sourceId: 's1' },
      ],
      [
        { id: 's1', hasAudio: true },
        { id: 's2', hasAudio: false },
      ],
    );
    const o: any = toOtio(m);
    const audio = audioTrack(o).children;
    expect(audio).toHaveLength(3);
    expect(audio[1].OTIO_SCHEMA).toBe('Gap.1');
    expect(trackFrames(audioTrack(o))).toBe(trackFrames(videoTrack(o)));
  });

  it('escapes media paths as proper file URLs', () => {
    const m = manifest([{ srcIn: 0, srcOut: 1 }]);
    const o: any = toOtio(m);
    const url = videoTrack(o).children[0].media_reference.target_url;
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain('%23a.mp4'); // '#' must be percent-encoded
  });

  it('expresses source ranges in the media timebase for mixed-rate sources', () => {
    const m = manifest([{ srcIn: 1, srcOut: 2, sourceId: 's1' }], [{ id: 's1', fps: 24 }]);
    const o: any = toOtio(m);
    const sr = videoTrack(o).children[0].source_range;
    expect(sr.start_time.rate).toBe(24);
    expect(sr.start_time.value).toBe(24);
  });
});

describe('ops guards (wave D)', () => {
  it('removeSourceRange refuses non-finite and no-ops on zero-width', () => {
    const m = manifest([{ srcIn: 0, srcOut: 60 }]);
    expect(() => removeSourceRange(m, 's1', NaN, NaN)).toThrow(/finite/);
    const same = removeSourceRange(m, 's1', 1.001, 1.002);
    expect(same.timeline.video).toHaveLength(1); // no phantom split
  });

  it('trimClip steps in the SOURCE timebase', () => {
    const m = manifest([{ srcIn: 1, srcOut: 2, sourceId: 's1' }], [{ id: 's1', fps: 24 }]);
    const t = trimClip(m, 'c0', 'in', 1);
    expect(t.timeline.video[0].srcIn).toBeCloseTo(1 + 1 / 24, 6);
    expect(() => trimClip(m, 'c0', 'in', NaN)).toThrow(/invalid frames/);
  });
});

describe('toOtio background music (wave I: A2 track)', () => {
  function withMusic(music: MusicItem[]): Manifest {
    const m = manifest([{ srcIn: 0, srcOut: 10 }]);
    return { ...m, timeline: { ...m.timeline, music } };
  }

  it('emits no A2 track when there is no music', () => {
    const o: any = toOtio(manifest([{ srcIn: 0, srcOut: 10 }]));
    expect(o.tracks.children.find((t: any) => t.name === 'A2')).toBeUndefined();
    expect(o.tracks.children).toHaveLength(2); // V1, A1 only — unchanged shape
  });

  it('emits an A2 track with one Clip.1 per music item, gapped to its tlStart', () => {
    const music: MusicItem[] = [
      { id: 'mu1', path: '/bgm.mp3', tlStart: 3, duration: 4, srcIn: 1, gain: -12, fadeIn: 1, fadeOut: 2, duck: true },
    ];
    const o: any = toOtio(withMusic(music));
    const a2 = o.tracks.children.find((t: any) => t.name === 'A2');
    expect(a2).toBeDefined();
    expect(a2.kind).toBe('Audio');
    // Gap.1 (0..3s) then Clip.1 (source_range starting at srcIn=1)
    expect(a2.children).toHaveLength(2);
    expect(a2.children[0].OTIO_SCHEMA).toBe('Gap.1');
    expect(a2.children[0].source_range.duration.value).toBe(Math.round(3 * FPS));
    const clip = a2.children[1];
    expect(clip.OTIO_SCHEMA).toBe('Clip.1');
    expect(clip.source_range.start_time.value).toBe(Math.round(1 * FPS)); // srcIn-anchored
    expect(clip.media_reference.target_url).toMatch(/^file:\/\//);
    expect(clip.metadata.vedit.musicId).toBe('mu1');
    expect(clip.metadata.vedit.duck).toBe(true);
  });

  it('emits no leading Gap when the first music item starts at tlStart 0', () => {
    const music: MusicItem[] = [
      { id: 'mu1', path: '/bgm.mp3', tlStart: 0, duration: 4, srcIn: 0, gain: -12, fadeIn: 1, fadeOut: 2, duck: false },
    ];
    const o: any = toOtio(withMusic(music));
    const a2 = o.tracks.children.find((t: any) => t.name === 'A2');
    expect(a2.children).toHaveLength(1);
    expect(a2.children[0].OTIO_SCHEMA).toBe('Clip.1');
  });
});

describe('toOtio B-roll V2 track (wave W3)', () => {
  function withOverlaySources(): Manifest {
    return manifest([{ srcIn: 0, srcOut: 10, sourceId: 's1' }], [{ id: 's1' }, { id: 's2', duration: 30 }]);
  }

  it('emits no V2 track when there are no overlays', () => {
    const o: any = toOtio(manifest([{ srcIn: 0, srcOut: 10 }]));
    expect(o.tracks.children.find((t: any) => t.name === 'V2')).toBeUndefined();
  });

  it('emits a V2 track with a leading Gap + one Clip.1 per resolved overlay, carrying audioMode/gainDb metadata', () => {
    const m = addOverlay(withOverlaySources(), 's2', {
      id: 'ov1', srcIn: 1, srcOut: 4, anchor: { sourceId: 's1', srcTime: 3 }, audioMode: 'mix', gainDb: -9,
    });
    const o: any = toOtio(m);
    const v2 = o.tracks.children.find((t: any) => t.name === 'V2');
    expect(v2).toBeDefined();
    expect(v2.kind).toBe('Video');
    // anchor src=3 resolves to tlStart=3 on the single tl[0,10)<-src[0,10) clip -> Gap(0..3) then Clip.
    expect(v2.children).toHaveLength(2);
    expect(v2.children[0].OTIO_SCHEMA).toBe('Gap.1');
    expect(v2.children[0].source_range.duration.value).toBe(Math.round(3 * FPS));
    const clip = v2.children[1];
    expect(clip.OTIO_SCHEMA).toBe('Clip.1');
    expect(clip.source_range.start_time.value).toBe(Math.round(1 * FPS)); // srcIn-anchored, B-roll's own timebase
    expect(clip.media_reference.target_url).toMatch(/^file:\/\//);
    expect(clip.metadata.vedit.overlayId).toBe('ov1');
    expect(clip.metadata.vedit.audioMode).toBe('mix');
    expect(clip.metadata.vedit.gainDb).toBe(-9);
  });

  it('emits no leading Gap when the resolved overlay starts at tlStart 0', () => {
    const m = addOverlay(withOverlaySources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 0 } });
    const o: any = toOtio(m);
    const v2 = o.tracks.children.find((t: any) => t.name === 'V2');
    expect(v2.children).toHaveLength(1);
    expect(v2.children[0].OTIO_SCHEMA).toBe('Clip.1');
  });

  it('excludes an orphaned overlay from V2 (never thrown/written) and warns instead', () => {
    // src=50 is past the A-roll's only clip (tl[0,10)<-src[0,10)) -> unresolvable.
    const m = addOverlay(withOverlaySources(), 's2', { id: 'ovOrphan', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 50 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o: any = toOtio(m);
    expect(o.tracks.children.find((t: any) => t.name === 'V2')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ovOrphan'));
    warn.mockRestore();
  });

  it('a mix of one resolved and one orphaned overlay writes only the resolved one', () => {
    let m = addOverlay(withOverlaySources(), 's2', { id: 'ovOk', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 } });
    m = addOverlay(m, 's2', { id: 'ovOrphan', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 50 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o: any = toOtio(m);
    const v2 = o.tracks.children.find((t: any) => t.name === 'V2');
    const clips = v2.children.filter((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clips).toHaveLength(1);
    expect(clips[0].metadata.vedit.overlayId).toBe('ovOk');
    warn.mockRestore();
  });
});

describe('toOtio W8 kit sprites: metadata-only markers on the V1 track (never a real clip/media_reference)', () => {
  it('emits no sprite markers when there are no sprites', () => {
    const o: any = toOtio(manifest([{ srcIn: 0, srcOut: 10 }]));
    const markers = videoTrack(o).markers.filter((mk: any) => mk.name.startsWith('sprite:'));
    expect(markers).toHaveLength(0);
  });

  it('a resolved sprite becomes a Marker.2 on the video track carrying assetId/position/scale/opacity metadata — NEVER a Clip.1/media_reference', () => {
    let m = manifest([{ srcIn: 0, srcOut: 10 }]);
    m = addSprite(m, 'char1', {
      id: 'sp1', anchor: { sourceId: 's1', srcTime: 3 }, duration: 2,
      position: { x: 0.5, y: 0.9 }, scale: 0.3, opacity: 0.8, flip: true,
    });
    const o: any = toOtio(m);
    const track = videoTrack(o);
    const marker = track.markers.find((mk: any) => mk.name === 'sprite:sp1');
    expect(marker).toBeDefined();
    expect(marker.OTIO_SCHEMA).toBe('Marker.2');
    expect(marker.marked_range.start_time.value).toBe(Math.round(3 * FPS));
    expect(marker.marked_range.duration.value).toBe(Math.round(2 * FPS));
    expect(marker.metadata.vedit).toEqual({ assetId: 'char1', position: { x: 0.5, y: 0.9 }, scale: 0.3, opacity: 0.8, flip: true });
    // No Clip.1/media_reference anywhere carries the sprite's asset — the
    // kit PNG is never redistributed via the exported OTIO (spec: asset-pack
    // redistribution terms are respected by never referencing it at all).
    const allClips = o.tracks.children.flatMap((t: any) => t.children ?? []).filter((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    // The A-roll clip's own media_reference is expected (that's the real
    // source video) — what must NEVER appear is a media_reference pointing
    // at the sprite's kit asset (no such asset name/path anywhere in a Clip).
    expect(allClips.every((c: any) => !JSON.stringify(c.media_reference).includes('char1'))).toBe(true);
  });

  it('an orphaned sprite is excluded from markers and warns instead, same as an orphaned overlay', () => {
    let m = manifest([{ srcIn: 0, srcOut: 10 }]);
    m = addSprite(m, 'char1', { id: 'spOrphan', anchor: { sourceId: 's1', srcTime: 50 } }); // past the only clip -> unresolvable
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o: any = toOtio(m);
    const markers = videoTrack(o).markers.filter((mk: any) => mk.name.startsWith('sprite:'));
    expect(markers).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spOrphan'));
    warn.mockRestore();
  });

  it('sprite markers coexist with motion markers on the same V1 track', () => {
    let m: Manifest = { ...manifest([{ srcIn: 0, srcOut: 10 }]) };
    m = { ...m, timeline: { ...m.timeline, motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 1, duration: 2 }] } };
    m = addSprite(m, 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 3 } });
    const o: any = toOtio(m);
    const names = videoTrack(o).markers.map((mk: any) => mk.name);
    expect(names).toContain('motion:mo1');
    expect(names).toContain('sprite:sp1');
  });
});
