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

  // B-roll V2 track (W3): resolved (non-orphan) overlays only, each a
  // Clip.1 gapped to its resolved tlStart — same Gap/Clip shape as the A2
  // music track above. Orphans (anchor cut away) are never written to the
  // file; they're surfaced as a console warning instead, mirroring how
  // reframe state that OTIO can't express is warned about via hasReframe().
  const overlayTrack = () => {
    const active = resolvedActiveOverlays(m);
    for (const o of orphanedOverlays(m)) {
      console.warn(`[vedit] overlay ${o.id} is orphaned (${o.reason}); excluded from OTIO V2 track`);
    }
    if (active.length === 0) return null;
    const children: unknown[] = [];
    let cursor = 0;
    for (const r of active) {
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
        metadata: { vedit: { overlayId: ov.id, audioMode: ov.audioMode, ...(ov.gainDb !== undefined ? { gainDb: ov.gainDb } : {}) } },
      });
      cursor = Math.max(cursor, r.tlEnd);
    }
    return {
      OTIO_SCHEMA: 'Track.1',
      name: 'V2',
      kind: 'Video',
      children,
      markers: [],
      effects: [],
      metadata: {},
    };
  };
  const oTrack = overlayTrack();

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: m.name,
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [track('Video'), track('Audio'), ...(mTrack ? [mTrack] : []), ...(oTrack ? [oTrack] : [])],
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
      },
    },
  };
}

export async function writeOtio(m: Manifest, outPath: string): Promise<string> {
  await fs.writeFile(outPath, JSON.stringify(toOtio(m), null, 2));
  return outPath;
}
