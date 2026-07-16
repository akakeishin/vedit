import { segments } from '../core/ops.js';
import type { Manifest } from '../core/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// OTIO files are plain JSON (schema Timeline.1). We emit Clip.1 objects for
// maximum importer compatibility (Resolve 18.5+ reads .otio natively).

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
const tr = (start: number, dur: number, rate: number) => ({
  OTIO_SCHEMA: 'TimeRange.1',
  start_time: rt(Math.round(start * rate), rate),
  duration: rt(Math.round(dur * rate), rate),
});

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
      target_url: 'file://' + s.path,
      available_range: tr(0, s.duration, rate),
      metadata: {},
    };
  };
  const clipObjs = (kind: 'Video' | 'Audio') =>
    segments(m)
      .filter((seg) => kind === 'Video' || srcById.get(seg.sourceId)?.hasAudio)
      .map((seg, i) => ({
        OTIO_SCHEMA: 'Clip.1',
        name: `${kind === 'Video' ? 'V' : 'A'}${i + 1}`,
        source_range: tr(seg.srcStart, seg.tlEnd - seg.tlStart, rate),
        media_reference: mediaRef(seg.sourceId),
        effects: [],
        markers: [],
        // OTIO has no standard "reframe" transform, so the crop position is
        // carried as opaque metadata only — see hasReframe()'s warning.
        metadata: { vedit: { clipId: seg.clipId, sourceId: seg.sourceId, ...(seg.crop ? { crop: seg.crop } : {}) } },
      }));

  const motionMarkers = m.timeline.motion.map((mo) => ({
    OTIO_SCHEMA: 'Marker.2',
    name: `motion:${mo.id}`,
    marked_range: tr(mo.tlStart, mo.duration, rate),
    color: 'PURPLE',
    metadata: { vedit: { spec: mo.spec } },
  }));

  const track = (kind: 'Video' | 'Audio') => ({
    OTIO_SCHEMA: 'Track.1',
    name: kind === 'Video' ? 'V1' : 'A1',
    kind,
    children: clipObjs(kind),
    markers: kind === 'Video' ? motionMarkers : [],
    effects: [],
    metadata: {},
  });

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: m.name,
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [track('Video'), track('Audio')],
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
