import { describe, expect, it, vi } from 'vitest';
import { hasOverlayTransform, toOtio } from './otio.js';
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
      ...(s.kind ? { kind: s.kind } : {}),
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

  it('a layer-1-only overlay carries layer:1 in its clip metadata (still just ONE "V2" track — full regression shape)', () => {
    const m = addOverlay(withOverlaySources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 } });
    const o: any = toOtio(m);
    const overlayTracks = o.tracks.children.filter((t: any) => /^V[2-9]/.test(t.name));
    expect(overlayTracks).toHaveLength(1);
    expect(overlayTracks[0].name).toBe('V2');
    const clip = overlayTracks[0].children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clip.metadata.vedit.layer).toBe(1);
  });
});

// ---- オーバーレイ・スタック: layer -> V2..Vn tracks ----

describe('toOtio overlay stack: layer -> V2..Vn tracks', () => {
  function withStackSources(): Manifest {
    return manifest(
      [{ srcIn: 0, srcOut: 10, sourceId: 's1' }],
      [{ id: 's1' }, { id: 's2', duration: 30 }, { id: 'img1', duration: 86400, kind: 'image' }],
    );
  }

  it('two overlays on DIFFERENT layers overlapping in time produce TWO tracks (V2, V3) — impossible to represent in a single sequential OTIO track', () => {
    let m = addOverlay(withStackSources(), 's2', { id: 'ovA', srcIn: 0, srcOut: 3, anchor: { sourceId: 's1', srcTime: 1 }, layer: 1 });
    m = addOverlay(m, 'img1', { id: 'ovB', srcIn: 0, srcOut: 3, anchor: { sourceId: 's1', srcTime: 1 }, layer: 2 }); // same resolved range, different layer
    const o: any = toOtio(m);
    const v2 = o.tracks.children.find((t: any) => t.name === 'V2');
    const v3 = o.tracks.children.find((t: any) => t.name === 'V3');
    expect(v2).toBeDefined();
    expect(v3).toBeDefined();
    const v2Clip = v2.children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    const v3Clip = v3.children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(v2Clip.metadata.vedit.overlayId).toBe('ovA');
    expect(v2Clip.metadata.vedit.layer).toBe(1);
    expect(v3Clip.metadata.vedit.overlayId).toBe('ovB');
    expect(v3Clip.metadata.vedit.layer).toBe(2);
  });

  it('layers are mapped to SEQUENTIAL V-names in ascending layer order, regardless of the raw layer numbers used (e.g. layer 5 -> still V3 if it is the second-lowest present)', () => {
    let m = addOverlay(withStackSources(), 's2', { id: 'ovLow', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 }, layer: 1 });
    m = addOverlay(m, 'img1', { id: 'ovHigh', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 }, layer: 5 });
    const o: any = toOtio(m);
    const names = o.tracks.children.filter((t: any) => /^V[2-9]/.test(t.name)).map((t: any) => t.name).sort();
    expect(names).toEqual(['V2', 'V3']);
    const v3 = o.tracks.children.find((t: any) => t.name === 'V3');
    const v3Clip = v3.children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(v3Clip.metadata.vedit.layer).toBe(5);
  });

  it('rect/opacity/fade ride along as opaque clip metadata when set', () => {
    const m = addOverlay(withStackSources(), 's2', {
      id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 },
      rect: { x: 0.1, y: 0.2, w: 0.3 }, opacity: 0.5, fade: { in: 1 },
    });
    const o: any = toOtio(m);
    const clip = o.tracks.children.find((t: any) => t.name === 'V2').children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clip.metadata.vedit.rect).toEqual({ x: 0.1, y: 0.2, w: 0.3 });
    expect(clip.metadata.vedit.opacity).toBe(0.5);
    expect(clip.metadata.vedit.fade).toEqual({ in: 1 });
  });

  it('an image-kind overlay source still gets a normal ExternalReference media_reference (same as a video overlay)', () => {
    const m = addOverlay(withStackSources(), 'img1', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 } });
    const o: any = toOtio(m);
    const clip = o.tracks.children.find((t: any) => t.name === 'V2').children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clip.media_reference.OTIO_SCHEMA).toBe('ExternalReference.1');
    expect(clip.media_reference.target_url).toMatch(/^file:\/\//);
  });
});

describe('hasOverlayTransform', () => {
  function withStackSources(): Manifest {
    return manifest([{ srcIn: 0, srcOut: 10, sourceId: 's1' }], [{ id: 's1' }, { id: 's2', duration: 30 }]);
  }

  it('false for a manifest with no overlays, or overlays with no rect/opacity/fade', () => {
    expect(hasOverlayTransform(manifest([{ srcIn: 0, srcOut: 10 }]))).toBe(false);
    const m = addOverlay(withStackSources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 } });
    expect(hasOverlayTransform(m)).toBe(false);
  });

  it('true when any resolved overlay has a rect, opacity, or fade', () => {
    const withRect = addOverlay(withStackSources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 }, rect: { x: 0, y: 0, w: 0.5 } });
    expect(hasOverlayTransform(withRect)).toBe(true);
    const withOpacity = addOverlay(withStackSources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 }, opacity: 0.5 });
    expect(hasOverlayTransform(withOpacity)).toBe(true);
    const withFade = addOverlay(withStackSources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 }, fade: { in: 1 } });
    expect(hasOverlayTransform(withFade)).toBe(true);
  });

  it('ignores an orphaned overlay\'s rect/opacity/fade (only resolved overlays count)', () => {
    const m = addOverlay(withStackSources(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 50 }, rect: { x: 0, y: 0, w: 0.5 } });
    expect(hasOverlayTransform(m)).toBe(false); // src=50 is past the A-roll's only clip -> orphan
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
