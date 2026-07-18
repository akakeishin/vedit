import path from 'node:path';
import { ffmpegHasFilter, run } from '../ingest/run.js';
// ---- W5: input color transform chain (HLG/PQ/LUT -> Rec.709 SDR) ----
function assertFilter(name, purpose) {
    if (!ffmpegHasFilter(name)) {
        throw new Error(`this ffmpeg build lacks the \`${name}\` filter (needed for ${purpose}). Install \`brew install ffmpeg-full\` or set VEDIT_FFMPEG.`);
    }
}
/** Escape a filesystem path for embedding inside a single-quoted ffmpeg filter option value — same convention as toAss's ASS-path escaping in render.ts. */
function escapeFilterPath(p) {
    return p.replace(/'/g, "\\'");
}
// npl (nominal peak luminance) follows the ffmpeg HDR-tonemap wiki
// convention (https://trac.ffmpeg.org/wiki/HighDynamicRangeVideo): HLG
// material is conventionally graded to a 1000-nit reference, while PQ
// content is tonemapped assuming a 100-nit SDR-equivalent reference before
// `tonemap=hable` compresses it further. Both land on the same bt709/tv SDR
// target.
const HLG_CHAIN = 'zscale=t=linear:npl=1000,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p';
const PQ_CHAIN = 'zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p';
/** Round to 4dp and stringify (drops trailing zeros) so generated filter args stay short/deterministic. */
function fmt(n) {
    return String(Math.round(n * 10000) / 10000);
}
/**
 * Build the input-color-transform + exposure/WB/saturation filter chain for
 * one source, as filter clauses joined by commas (no leading/trailing
 * comma, no brackets) ready to splice into a video chain — same shape as
 * render.ts's buildRepairChain for audio. No colorTransform (undefined or
 * an explicit `{ type: 'none' }`) and no adjust returns '' so an untouched
 * source's filtergraph/proxy is byte-for-byte identical to before this
 * feature existed (full regression).
 *
 * D-Log and similar log profiles that don't tag a transfer curve at all
 * can't be auto-detected (see needsColorTransform in ops.ts) — this
 * function never guesses; the caller must have explicitly set 'hlg'/'pq'/
 * 'lut' via `vedit color` (SKILL.md documents this operational split).
 */
export function buildColorChain(colorTransform, adjust) {
    const parts = [];
    if (colorTransform && colorTransform.type !== 'none') {
        if (colorTransform.type === 'hlg') {
            assertFilter('zscale', 'HLG input color transform');
            assertFilter('tonemap', 'HLG input color transform');
            parts.push(HLG_CHAIN);
        }
        else if (colorTransform.type === 'pq') {
            assertFilter('zscale', 'PQ input color transform');
            assertFilter('tonemap', 'PQ input color transform');
            parts.push(PQ_CHAIN);
        }
        else if (colorTransform.type === 'lut') {
            if (!colorTransform.lut)
                throw new Error('color transform type "lut" requires a lut path');
            assertFilter('lut3d', 'LUT input color transform');
            parts.push(`lut3d='${escapeFilterPath(colorTransform.lut)}'`);
        }
    }
    if (adjust) {
        const { exposure, wb, sat } = adjust;
        // eq's brightness is an additive shift in -1..1; exposure is EV -2..2,
        // so each EV stop maps to a 0.25 brightness shift (±2 EV -> ±0.5,
        // comfortably inside eq's clamp range). saturation passes straight
        // through — colorAdjust.sat's 0..2 domain already matches eq's.
        if (exposure !== undefined || sat !== undefined) {
            const brightness = fmt((exposure ?? 0) * 0.25);
            const saturation = fmt(sat ?? 1);
            parts.push(`eq=brightness=${brightness}:saturation=${saturation}`);
        }
        if (wb !== undefined) {
            if (ffmpegHasFilter('colortemperature')) {
                // wb -100..100 -> Kelvin 3000..10000 around a 6500K neutral center.
                const temperature = Math.round(6500 + wb * 35);
                parts.push(`colortemperature=temperature=${temperature}`);
            }
            else {
                // Approximation for ffmpeg builds without `colortemperature`
                // (pre-7.0): nudge the midtone red/blue balance in opposite
                // directions. wb -100..100 -> ±0.5 on colorbalance's -1..1 scale.
                const k = fmt(wb / 200);
                parts.push(`colorbalance=rm=${k}:bm=${fmt(-(wb / 200))}`);
            }
        }
    }
    return parts.join(',');
}
/**
 * Parse ffmpeg's `signalstats,metadata=print` output for one frame's
 * YAVG/UAVG/VAVG/SATAVG. Throws if any are missing — a genuinely unusable
 * measurement (e.g. the filter produced no output at all), not merely "no
 * signal", so a caller never silently proposes adjustments from zeros.
 */
export function parseSignalStats(text) {
    const grab = (key) => {
        const m = text.match(new RegExp(`lavfi\\.signalstats\\.${key}=([\\-0-9.]+)`));
        if (!m)
            throw new Error(`signalstats output missing ${key}`);
        return Number(m[1]);
    };
    return { yavg: grab('YAVG'), uavg: grab('UAVG'), vavg: grab('VAVG'), satavg: grab('SATAVG') };
}
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
/**
 * Convert a target source's signalstats delta from the base source into a
 * colorAdjust suggestion. Deliberately simple: luma delta maps linearly
 * onto the exposure range, the U/V chroma delta maps onto the wb range, and
 * the SATAVG ratio maps onto the sat multiplier. This is a rough,
 * human-approved PROPOSAL, never applied automatically — clamped to the
 * same ranges setColorAdjust enforces so the result can be passed straight
 * to `vedit color-adjust`.
 */
export function suggestColorAdjust(base, target) {
    const exposure = clamp(((base.yavg - target.yavg) / 255) * 2, -2, 2);
    const wb = clamp((base.uavg - target.uavg - (base.vavg - target.vavg)) * 4, -100, 100);
    const sat = target.satavg > 1e-6 ? clamp(base.satavg / target.satavg, 0, 2) : 1;
    return {
        exposure: Math.round(exposure * 100) / 100,
        wb: Math.round(wb),
        sat: Math.round(sat * 100) / 100,
    };
}
/**
 * Sample one representative (mid-point) frame per source via ffmpeg
 * signalstats and propose colorAdjust values that would bring each target
 * source's look closer to the base source's. Read-only — never writes
 * anything to the manifest; the caller (CLI `vedit color-match`) shows the
 * proposal and lets the user apply it themselves via `vedit color-adjust`.
 * Samples from the proxy when one exists (matches what preview/render
 * already show, including any baked-in colorTransform) and falls back to
 * the original source otherwise.
 */
export async function proposeColorMatch(m, projectDir, baseSourceId, targetSourceIds) {
    const srcById = new Map(m.sources.map((s) => [s.id, s]));
    const sample = async (sourceId) => {
        const src = srcById.get(sourceId);
        if (!src)
            throw new Error(`unknown source: ${sourceId}`);
        const media = src.proxy ? path.join(projectDir, src.proxy) : src.path;
        const at = src.duration / 2;
        const out = await run('ffmpeg', [
            '-ss', String(at), '-i', media,
            '-frames:v', '1',
            '-vf', 'signalstats,metadata=print',
            '-f', 'null', '-',
        ]);
        return parseSignalStats(out);
    };
    const baseStats = await sample(baseSourceId);
    const proposals = [];
    for (const id of targetSourceIds) {
        const stats = await sample(id);
        proposals.push({ sourceId: id, measured: stats, suggested: suggestColorAdjust(baseStats, stats) });
    }
    return { base: { sourceId: baseSourceId, ...baseStats }, proposals };
}
