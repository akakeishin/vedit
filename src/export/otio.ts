import { orphanedOverlays, orphanedSprites, resolvedActiveOverlays, resolvedActiveSprites, segments } from '../core/ops.js';
import type { Manifest } from '../core/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// OTIO files are plain JSON (schema Timeline.1). We emit Clip.1 objects for
// maximum importer compatibility (Resolve 18.5+ reads .otio natively).

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
// Frame-consistent range: rounding start and duration independently drifts
// (round(start)+round(dur) != round(end)) and the error accumulates across a
// clip sequence. Round the START and END frames, then take the difference.
const tr = (startT: number, endT: number, rate: number) => {
  const startFrame = Math.round(startT * rate);
  const endFrame = Math.round(endT * rate);
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rt(startFrame, rate),
    duration: rt(Math.max(0, endFrame - startFrame), rate),
  };
};

/** Whether this manifest carries reframe state OTIO cannot express natively. */
export function hasReframe(m: Manifest): boolean {
  return Boolean(m.output) || m.timeline.video.some((c) => c.crop);
}

/**
 * Whether any resolved (non-orphan) overlay carries placement/visual state
 * OTIO's Clip.1 has no standard field for — `rect`/`opacity`/`fade` (see
 * OverlayClip in types.ts). Those still ride along as opaque
 * `metadata.vedit` on each Clip.1 (overlayTracksByLayer below), same
 * "record it, but most importers won't visually apply it" contract as
 * `hasReframe`'s crop/output metadata — this just decides whether
 * `export otio`'s caller (cli.ts) should also print the same kind of
 * best-effort warning it already prints for reframe.
 */
export function hasOverlayTransform(m: Manifest): boolean {
  return resolvedActiveOverlays(m).some((r) => Boolean(r.overlay.rect) || r.overlay.opacity !== undefined || Boolean(r.overlay.fade));
}

export function toOtio(m: Manifest): unknown {
  const rate = m.fps;
  const srcById = new Map(m.sources.map((s) => [s.id, s]));
  const mediaRef = (sourceId: string) => {
    const s = srcById.get(sourceId)!;
    return {
      OTIO_SCHEMA: 'ExternalReference.1',
      name: path.basename(s.path),
      target_url: pathToFileURL(s.path).href,
      // media ranges live in the MEDIA's timebase, not the timeline's
      available_range: tr(0, s.duration, s.fps || rate),
      metadata: {},
    };
  };
  const clipObjs = (kind: 'Video' | 'Audio') =>
    segments(m).map((seg, i) => {
      const src = srcById.get(seg.sourceId)!;
      // Audio track must stay duration-aligned with video: a video-only
      // segment becomes a Gap, never gets filtered out (filtering would
      // slide all later audio toward zero).
      if (kind === 'Audio' && !src.hasAudio) {
        return {
          OTIO_SCHEMA: 'Gap.1',
          name: `gap${i + 1}`,
          source_range: tr(0, seg.tlEnd - seg.tlStart, rate),
          effects: [],
          markers: [],
          metadata: {},
        };
      }
      const srcRate = src.fps || rate;
      return {
        OTIO_SCHEMA: 'Clip.1',
        name: `${kind === 'Video' ? 'V' : 'A'}${i + 1}`,
        // source_range is expressed in the media's own timebase
        source_range: tr(seg.srcStart, seg.srcStart + (seg.tlEnd - seg.tlStart), srcRate),
        media_reference: mediaRef(seg.sourceId),
        effects: [],
        markers: [],
        // OTIO has no standard "reframe" transform, so the crop position is
        // carried as opaque metadata only — see hasReframe()'s warning.
        metadata: { vedit: { clipId: seg.clipId, sourceId: seg.sourceId, ...(seg.crop ? { crop: seg.crop } : {}) } },
      };
    });

  const motionMarkers = m.timeline.motion.map((mo) => ({
    OTIO_SCHEMA: 'Marker.2',
    name: `motion:${mo.id}`,
    marked_range: tr(mo.tlStart, mo.tlStart + mo.duration, rate),
    color: 'PURPLE',
    metadata: { vedit: { spec: mo.spec } },
  }));

  // W8 kit sprites: metadata-only markers, NEVER a real clip/media_reference
  // — the asset PNG lives in an external (possibly shared/licensed) kit
  // directory, and the spec requires respecting the underlying asset-pack's
  // redistribution terms by not embedding/pointing OTIO consumers at it at
  // all. Render still bakes the sprite into the final video (the user's own
  // output, not a redistribution of the kit asset itself) — see render.ts.
  for (const s of orphanedSprites(m)) {
    console.warn(`[vedit] sprite ${s.id} is orphaned (${s.reason}); excluded from OTIO markers`);
  }
  const spriteMarkers = resolvedActiveSprites(m).map((r) => ({
    OTIO_SCHEMA: 'Marker.2',
    name: `sprite:${r.sprite.id}`,
    marked_range: tr(r.tlStart, r.tlEnd, rate),
    color: 'PINK',
    metadata: {
      vedit: {
        assetId: r.sprite.assetId,
        position: r.sprite.position,
        scale: r.sprite.scale,
        opacity: r.sprite.opacity,
        ...(r.sprite.flip ? { flip: true } : {}),
      },
    },
  }));

  const track = (kind: 'Video' | 'Audio') => ({
    OTIO_SCHEMA: 'Track.1',
    name: kind === 'Video' ? 'V1' : 'A1',
    kind,
    children: clipObjs(kind),
    markers: kind === 'Video' ? [...motionMarkers, ...spriteMarkers] : [],
    effects: [],
    metadata: {},
  });

  // Background music travels on its own audio track (A2), one Clip.1 per
  // MusicItem with its own media_reference, gapped to its tlStart the same
  // way the main audio track (A1) gaps around video-only segments — OTIO has
  // no volume/fade/duck concept, so gain/fadeIn/fadeOut/duck ride along as
  // opaque metadata only (mirrors how crop/reframe are carried, see
  // hasReframe() above).
  const musicMediaRef = (mu: NonNullable<Manifest['timeline']['music']>[number]) => ({
    OTIO_SCHEMA: 'ExternalReference.1',
    name: path.basename(mu.path),
    target_url: pathToFileURL(mu.path).href,
    // The manifest doesn't record the music file's full length, only how
    // much of it is used — approximate the available range as exactly what
    // this clip consumes (srcIn..srcIn+duration).
    available_range: tr(0, mu.srcIn + mu.duration, rate),
    metadata: {},
  });
  const musicTrack = () => {
    const music = m.timeline.music ?? [];
    if (music.length === 0) return null;
    const children: unknown[] = [];
    let cursor = 0;
    for (const mu of [...music].sort((a, b) => a.tlStart - b.tlStart)) {
      if (mu.tlStart > cursor + 1e-9) {
        children.push({
          OTIO_SCHEMA: 'Gap.1',
          name: 'gap',
          source_range: tr(0, mu.tlStart - cursor, rate),
          effects: [],
          markers: [],
          metadata: {},
        });
      }
      children.push({
        OTIO_SCHEMA: 'Clip.1',
        name: `M${children.length + 1}`,
        source_range: tr(mu.srcIn, mu.srcIn + mu.duration, rate),
        media_reference: musicMediaRef(mu),
        effects: [],
        markers: [],
        metadata: { vedit: { musicId: mu.id, gain: mu.gain, fadeIn: mu.fadeIn, fadeOut: mu.fadeOut, duck: mu.duck } },
      });
      cursor = Math.max(cursor, mu.tlStart + mu.duration);
    }
    return {
      OTIO_SCHEMA: 'Track.1',
      name: 'A2',
      kind: 'Audio',
      children,
      markers: [],
      effects: [],
      metadata: {},
    };
  };
  const mTrack = musicTrack();

  // Overlay stack (W3 B-roll V2, generalized to N layers — オーバーレイ・
  // スタック mini-spec: layer ごとに V2..Vn トラックとして出力): resolved
  // (non-orphan) overlays only, one Track.1 PER LAYER, each a Gap/Clip
  // sequence exactly like the A2 music track above. OTIO tracks are
  // sequential/non-overlapping by construction — a single layer is itself
  // guaranteed non-overlapping (assertNoOverlayOverlap in ops.ts), so it
  // maps naturally onto one track; DIFFERENT layers may overlap in time
  // (the whole point of a stack), so each needs its OWN track to be
  // representable at all. Layers present in the manifest are mapped to
  // SEQUENTIAL V2, V3, ... names in ascending layer order — a project with
  // every overlay on layer 1 (overlayLayerOf's default: every pre-existing
  // project, and every broll-add/-update call) produces exactly one track
  // named "V2", byte-for-byte the original single-track W3 shape (full
  // regression). Orphans (anchor cut away) are never written to the file;
  // they're surfaced as a console warning instead, mirroring how reframe
  // state OTIO can't express is warned about via hasReframe(). `rect`/
  // `opacity`/`fade` — OTIO has no standard transform field for them, same
  // situation as crop/reframe (see hasOverlayTransform above) — ride along
  // as opaque `metadata.vedit` only, same as audioMode/gainDb already did.
  const overlayTracksByLayer = () => {
    const active = resolvedActiveOverlays(m); // already sorted: layer asc, then tlStart
    for (const o of orphanedOverlays(m)) {
      console.warn(`[vedit] overlay ${o.id} is orphaned (${o.reason}); excluded from OTIO overlay track`);
    }
    if (active.length === 0) return [];
    const byLayer = new Map<number, typeof active>();
    for (const r of active) {
      const layer = r.overlay.layer ?? 1;
      const bucket = byLayer.get(layer);
      if (bucket) bucket.push(r);
      else byLayer.set(layer, [r]);
    }
    const layers = [...byLayer.keys()].sort((a, b) => a - b);
    return layers.map((layer, trackIdx) => {
      const items = byLayer.get(layer)!; // inherits `active`'s tlStart order within this layer
      const children: unknown[] = [];
      let cursor = 0;
      for (const r of items) {
        const ov = r.overlay;
        if (r.tlStart > cursor + 1e-9) {
          children.push({
            OTIO_SCHEMA: 'Gap.1',
            name: 'gap',
            source_range: tr(0, r.tlStart - cursor, rate),
            effects: [],
            markers: [],
            metadata: {},
          });
        }
        const ovSrc = srcById.get(ov.sourceId)!;
        const ovRate = ovSrc.fps || rate;
        children.push({
          OTIO_SCHEMA: 'Clip.1',
          name: `B${children.length + 1}`,
          source_range: tr(ov.srcIn, ov.srcOut, ovRate),
          media_reference: mediaRef(ov.sourceId),
          effects: [],
          markers: [],
          metadata: {
            vedit: {
              overlayId: ov.id,
              layer,
              audioMode: ov.audioMode,
              ...(ov.gainDb !== undefined ? { gainDb: ov.gainDb } : {}),
              ...(ov.rect ? { rect: ov.rect } : {}),
              ...(ov.opacity !== undefined ? { opacity: ov.opacity } : {}),
              ...(ov.fade ? { fade: ov.fade } : {}),
            },
          },
        });
        cursor = Math.max(cursor, r.tlEnd);
      }
      return {
        OTIO_SCHEMA: 'Track.1',
        name: `V${trackIdx + 2}`,
        kind: 'Video',
        children,
        markers: [],
        effects: [],
        metadata: {},
      };
    });
  };
  const oTracks = overlayTracksByLayer();

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: m.name,
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [track('Video'), track('Audio'), ...(mTrack ? [mTrack] : []), ...oTracks],
      markers: [],
      effects: [],
      metadata: {},
    },
    metadata: {
      vedit: {
        revision: m.revision,
        ...(hasReframe(m)
          ? {
              output: m.output,
              reframeNote:
                'crop/output are recorded under each clip\'s metadata.vedit.crop, but OTIO has no standard transform field — most importers (including Resolve) will not visually apply the reframe on import.',
            }
          : {}),
        ...(hasOverlayTransform(m)
          ? {
              overlayTransformNote:
                'overlay rect/opacity/fade are recorded under each overlay clip\'s metadata.vedit, but OTIO has no standard transform field — most importers (including Resolve) will not visually apply the placement/opacity/fade on import.',
            }
          : {}),
      },
    },
  };
}

export async function writeOtio(m: Manifest, outPath: string): Promise<string> {
  await fs.writeFile(outPath, JSON.stringify(toOtio(m), null, 2));
  return outPath;
}
