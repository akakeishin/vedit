import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshId } from '../core/ops.js';
import { detectScenesForSource } from '../core/scenes.js';
import { resolveWhisperModelDir } from '../core/statePaths.js';
import { buildColorChain } from '../export/color.js';
import { run, runBinary } from './run.js';
/**
 * Parse an ffprobe "N/D" frame-rate string. ffprobe emits the sentinel
 * "0/0" for avg_frame_rate when it can't compute an average (e.g. very
 * short or corrupt-container clips) — `"0/0" || fallback` in a truthiness
 * check never catches that because "0/0" is a non-empty, truthy string.
 * Returns null for anything that isn't a real positive rate so the caller
 * can fall back explicitly.
 */
function parseFrameRate(s) {
    if (typeof s !== 'string')
        return null;
    const [numStr, denStr] = s.split('/');
    const num = Number(numStr);
    const den = denStr !== undefined ? Number(denStr) : 1;
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0)
        return null;
    return num / den;
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    const error = new Error('operation cancelled');
    error.name = 'AbortError';
    throw error;
}
export async function probe(file, opts = {}) {
    throwIfAborted(opts.signal);
    const out = await run('ffprobe', [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format', '-show_streams',
        file,
    ], { signal: opts.signal });
    const j = JSON.parse(out);
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.find((s) => s.codec_type === 'audio');
    if (!v)
        throw new Error(`no video stream in ${file}`);
    const rFps = parseFrameRate(v.r_frame_rate) ?? undefined;
    const fps = parseFrameRate(v.avg_frame_rate) ?? rFps ?? 30;
    const codec = typeof v.codec_name === 'string' && v.codec_name ? v.codec_name : undefined;
    const creationTimeRaw = j.format?.tags?.creation_time;
    const creationTime = typeof creationTimeRaw === 'string' && creationTimeRaw ? creationTimeRaw : undefined;
    // ffprobe emits the sentinel "N/A" for format.duration when the container
    // doesn't carry an overall duration (common for some raw/streamed
    // formats); `Number("N/A")` is NaN, which `??` doesn't catch since the
    // value is a defined (non-null) string. Fall back to the video stream's
    // own duration, and fail loudly rather than silently returning 0/NaN if
    // neither is usable — a bogus duration corrupts every downstream time
    // computation.
    const formatDuration = Number(j.format?.duration);
    const streamDuration = Number(v.duration);
    const duration = Number.isFinite(formatDuration) && formatDuration > 0
        ? formatDuration
        : Number.isFinite(streamDuration) && streamDuration > 0
            ? streamDuration
            : NaN;
    if (!Number.isFinite(duration)) {
        throw new Error(`ffprobe returned no usable duration for ${file} (format.duration=${JSON.stringify(j.format?.duration)}, stream.duration=${JSON.stringify(v.duration)})`);
    }
    // ffprobe reports the literal string "unknown" for an untagged color_*
    // field rather than omitting it; bits_per_raw_sample may come through as
    // either a JSON number or a numeric string depending on ffprobe version.
    const bitDepth = Number(v.bits_per_raw_sample);
    const hasColorInfo = Boolean(v.color_primaries) || Boolean(v.color_transfer) || Boolean(v.color_space) || Number.isFinite(bitDepth);
    const color = hasColorInfo
        ? {
            ...(v.color_primaries ? { primaries: String(v.color_primaries) } : {}),
            ...(v.color_transfer ? { transfer: String(v.color_transfer) } : {}),
            ...(v.color_space ? { space: String(v.color_space) } : {}),
            ...(Number.isFinite(bitDepth) ? { bitDepth } : {}),
        }
        : undefined;
    return {
        duration,
        fps,
        rFps,
        width: v.width,
        height: v.height,
        hasAudio: Boolean(a),
        codec,
        creationTime,
        color,
    };
}
/**
 * Lightweight ffprobe for a music file: unlike `probe()` above this never
 * requires a video stream (music-add's inputs are typically audio-only), it
 * only needs to confirm an audio stream exists and learn its duration.
 */
export async function probeAudio(file, opts = {}) {
    throwIfAborted(opts.signal);
    const out = await run('ffprobe', [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format', '-show_streams',
        file,
    ], { signal: opts.signal });
    const j = JSON.parse(out);
    const a = j.streams.find((s) => s.codec_type === 'audio');
    const formatDuration = Number(j.format?.duration);
    const streamDuration = a ? Number(a.duration) : NaN;
    const duration = Number.isFinite(formatDuration) && formatDuration > 0
        ? formatDuration
        : Number.isFinite(streamDuration) && streamDuration > 0
            ? streamDuration
            : NaN;
    if (!Number.isFinite(duration)) {
        throw new Error(`ffprobe returned no usable duration for ${file}`);
    }
    return { duration, hasAudio: Boolean(a) };
}
// ---- オーバーレイ・スタック: still-image overlay sources (Source.kind:'image') ----
//
// A separate, deliberately lightweight sibling to probe()/ingestFile() above
// — see docs/superpowers/specs/2026-07-18-vedit-overlay-stack.md. An image
// overlay source (PNG/JPEG/WebP) never needs a proxy (there's nothing to
// seek — the whole point is a single still frame), a waveform (no audio),
// scene detection, or transcription, so this path skips all four rather than
// reusing ingestFile's video pipeline. See Source.kind's doc in
// core/types.ts for what an image-kind Source's fields mean.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/** Whether `file`'s extension marks it as an overlay-stack image source rather than footage — case-insensitive match against IMAGE_EXTENSIONS. Used by ingestFile to route to ingestImageFile, and by cli.ts's `overlay-add` to decide whether a bare file argument should be auto-ingested. */
export function isImageFile(file) {
    return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}
/**
 * Synthetic Source.duration for an image-kind source: a still image has no
 * intrinsic duration, but addOverlay/updateOverlay (ops.ts) bound
 * OverlayClip.srcOut by `<= source.duration`, and OTIO's media
 * `available_range` wants SOME finite number. 24 hours is far beyond any
 * practical overlay placement while staying a normal finite JSON number —
 * `Infinity` would round-trip through JSON.stringify as `null` and corrupt
 * the manifest, so a large-but-finite sentinel is required, not just
 * convenient. `vedit overlay-add --dur <秒>` on an image source sets
 * srcIn:0, srcOut:<秒> — the requested ON-SCREEN duration, unrelated to
 * this sentinel (which only bounds how large that request is ALLOWED to be).
 */
export const IMAGE_SOURCE_DURATION = 24 * 60 * 60;
/**
 * Lightweight ffprobe for a still image: unlike `probe()` above, this never
 * requires (or reports) a duration/fps/audio-stream — a still image has none
 * of those intrinsically (ffprobe reports a single-frame "video" stream for
 * a PNG/JPEG with no `format.duration` at all, which is exactly why probe()
 * itself can't be reused here — it would throw "no usable duration").
 */
export async function probeImage(file, opts = {}) {
    throwIfAborted(opts.signal);
    const out = await run('ffprobe', [
        '-v', 'error',
        '-print_format', 'json',
        '-show_streams',
        file,
    ], { signal: opts.signal });
    const j = JSON.parse(out);
    const v = j.streams.find((s) => s.codec_type === 'video');
    const width = Number(v?.width);
    const height = Number(v?.height);
    if (!v || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`ffprobe returned no usable image dimensions for ${file}`);
    }
    return { width, height };
}
/**
 * Streaming SHA-256 of a file's raw bytes (hex digest). Used by
 * `vedit ingest-batch` (src/ingest/batch.ts) for duplicate detection and
 * post-copy verification — never loads the whole file into memory, so it's
 * safe on multi-GB camera-card footage.
 */
export function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(file);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}
/**
 * One-time 720p-class CFR proxy for smooth seeking; original is never touched.
 * Keeps the source fps as-is (e.g. 29.97) rather than rounding it — rounding
 * to 30 drifts the proxy out of sync with the original over a long timeline.
 * Only very high frame rates (>60) get capped, to keep the proxy light.
 *
 * `colorTransform` (W5), when given, is baked into the proxy so the preview
 * shows the corrected look without re-decoding the original on every seek —
 * see buildColorChain in src/export/color.ts. Omitted (the normal ingest
 * path, since colorTransform is only ever set AFTER ingest via `vedit
 * color`) means no color filter at all, byte-for-byte the same `-vf` as
 * before this parameter existed. `vedit color` regenerates the proxy by
 * calling this again with the newly-set colorTransform.
 */
export async function makeProxy(file, outPath, p, colorTransform, opts = {}) {
    throwIfAborted(opts.signal);
    const targetH = Math.min(720, p.height);
    const fps = p.fps > 60 ? 30 : p.fps || 30;
    const gop = Math.max(1, Math.round(fps));
    const colorPart = buildColorChain(colorTransform);
    const vf = colorPart ? `${colorPart},scale=-2:${targetH}` : `scale=-2:${targetH}`;
    await run('ffmpeg', [
        '-y', '-i', file,
        '-vf', vf,
        '-r', String(fps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-g', String(gop), // ~1s keyframe interval → snappy seeks
        '-pix_fmt', 'yuv420p',
        ...(p.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-dn', '-map_metadata', '-1', // drop data streams (e.g. DJI tmcd) and source metadata
        '-movflags', '+faststart',
        outPath,
    ], { signal: opts.signal });
}
/** Mono peak envelope for waveform display: `rate` values per second, 0..1. */
export async function makePeaks(file, outPath, rate = 25, opts = {}) {
    throwIfAborted(opts.signal);
    const sr = 8000;
    const buf = await runBinary('ffmpeg', [
        '-v', 'error', '-i', file,
        '-map', 'a:0?', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-',
    ], { signal: opts.signal });
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    const win = Math.floor(sr / rate);
    const peaks = [];
    for (let i = 0; i < samples.length; i += win) {
        if ((peaks.length & 0x3ff) === 0)
            throwIfAborted(opts.signal);
        let max = 0;
        for (let j = i; j < Math.min(i + win, samples.length); j++) {
            const v = Math.abs(samples[j]);
            if (v > max)
                max = v;
        }
        peaks.push(Math.round((max / 32768) * 100) / 100);
    }
    throwIfAborted(opts.signal);
    await fs.writeFile(outPath, JSON.stringify({ rate, peaks }), { signal: opts.signal });
}
// ---- transcription (whisper.cpp) ----
const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}.bin`;
export async function findWhisperModel() {
    const preferred = process.env.VEDIT_WHISPER_MODEL;
    if (preferred)
        return preferred;
    const modelDir = resolveWhisperModelDir();
    try {
        const files = await fs.readdir(modelDir);
        const bins = files.filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
        // Prefer larger/turbo models when several are present.
        const order = ['large-v3-turbo', 'large', 'medium', 'small', 'base', 'tiny'];
        bins.sort((a, b) => order.findIndex((o) => a.includes(o)) - order.findIndex((o) => b.includes(o)));
        return bins.length ? path.join(modelDir, bins[0]) : null;
    }
    catch {
        return null;
    }
}
export async function downloadWhisperModel(name = 'ggml-large-v3-turbo') {
    const modelDir = resolveWhisperModelDir();
    await fs.mkdir(modelDir, { recursive: true });
    const dest = path.join(modelDir, `${name}.bin`);
    try {
        await fs.access(dest);
        return dest;
    }
    catch { /* download below */ }
    // Never let two Codex/Claude/daemon processes share one `.part` inode.
    // With a common temp path, the first rename can expose that inode as the
    // live model while the second curl is still writing to it, silently
    // corrupting an apparently complete model. Each downloader writes its own
    // sibling, then hard-links the complete file into place with no-overwrite
    // semantics. Losing a race is success: the winner already published a
    // complete model. Failed/cancelled downloads leave neither a live file nor
    // an accumulating partial.
    const part = `${dest}.part-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
        await run('curl', ['-L', '--fail', '-o', part, MODEL_URL(name)], { maxBuffer: 1024 });
        try {
            await fs.link(part, dest);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        return dest;
    }
    finally {
        await fs.rm(part, { force: true }).catch(() => { });
    }
}
/**
 * Build whisper.cpp's `--prompt` value from a user-supplied glossary
 * (`vedit transcribe --glossary "<term1,term2,...>"`, roadmap "whisper 用語集
 * プロンプト"). whisper's initial-prompt mechanism biases decoding toward
 * vocabulary that appears in the prompt text — the cheapest lever available
 * for getting proper nouns/jargon spelled consistently, before a heavier
 * stable-ts/faster-whisper realignment pass (see docs/polish-backlog.md's
 * 文字起こし section for that unimplemented alternative). Terms are trimmed
 * and empty ones dropped; an empty/all-blank glossary produces '' so the
 * caller omits `--prompt` entirely — byte-for-byte the same whisper
 * invocation as before this feature existed. Pure and independent of
 * actually running whisper, so it's unit-testable without a model
 * installed.
 */
export function buildWhisperPrompt(glossary) {
    const terms = glossary.map((t) => t.trim()).filter(Boolean);
    if (terms.length === 0)
        return '';
    return terms.join('、');
}
/**
 * Word-level transcription via whisper-cli. Tokens are merged into words:
 * latin tokens merge until a leading space; CJK tokens stay as-is (token-level
 * granularity is the natural cut unit for Japanese).
 */
export async function transcribe(file, sourceId, opts = {}) {
    const model = opts.model ?? (await findWhisperModel());
    if (!model) {
        throw new Error('no whisper model found. Run `vedit doctor --download-model` (default: large-v3-turbo, ~1.6GB) or set VEDIT_WHISPER_MODEL.');
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vedit-asr-'));
    try {
        const wav = path.join(tmp, 'audio.wav');
        await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-map', 'a:0', '-ac', '1', '-ar', '16000', wav], { signal: opts.signal });
        const outBase = path.join(tmp, 'out');
        const args = [
            '-m', model,
            '-f', wav,
            '-ojf', // full JSON with token-level offsets
            '-of', outBase,
            '--threads', String(Math.max(2, os.cpus().length - 2)),
            // Explicit rather than relying on whatever the installed whisper-cli
            // build defaults to — beam-size/best-of pin decoding quality, and
            // split-on-word keeps segment boundaries at word edges (matches how
            // this pipeline consumes token offsets as word-level timing).
            '--beam-size', '5',
            '--best-of', '5',
            '--split-on-word',
        ];
        if (opts.language)
            args.push('-l', opts.language);
        else
            args.push('-l', 'auto');
        const prompt = opts.glossary ? buildWhisperPrompt(opts.glossary) : '';
        if (prompt)
            args.push('--prompt', prompt);
        let actualArgs = args;
        try {
            await run('whisper-cli', actualArgs, { maxBuffer: 256 * 1024 * 1024, signal: opts.signal });
        }
        catch (error) {
            // whisper.cpp's Metal backend has been observed to die immediately
            // with SIGSEGV on otherwise-valid models/audio.  Retry exactly once on
            // CPU only for a process crash (not a decoding/model error), keeping
            // ordinary failures fast and preserving cancellation semantics.
            const child = error;
            const crashed = child.signal === 'SIGSEGV'
                || child.signal === 'SIGABRT'
                || child.code === 134
                || child.code === 139;
            if (!crashed || opts.signal?.aborted || child.name === 'AbortError')
                throw error;
            actualArgs = [...args, '--no-gpu'];
            await run('whisper-cli', actualArgs, { maxBuffer: 256 * 1024 * 1024, signal: opts.signal });
        }
        const j = JSON.parse(await fs.readFile(outBase + '.json', 'utf8'));
        const words = [];
        let n = 0;
        const push = (text, t0, t1, p) => {
            const clean = text.trim();
            if (!clean)
                return;
            words.push({ id: `w${(n++).toString().padStart(4, '0')}`, text: clean, t0, t1, p });
        };
        for (const seg of j.transcription ?? []) {
            let cur = null;
            for (const tok of seg.tokens ?? []) {
                const text = tok.text ?? '';
                if (text.startsWith('[_') || text.startsWith('<|'))
                    continue; // special tokens
                const t0 = (tok.offsets?.from ?? 0) / 1000;
                const t1 = (tok.offsets?.to ?? 0) / 1000;
                const p = tok.p ?? 1;
                const startsWord = text.startsWith(' ') || /^[　-鿿！-｠ぁ-んァ-ヶ]/u.test(text);
                if (cur && startsWord) {
                    push(cur.text, cur.t0, cur.t1, cur.p);
                    cur = null;
                }
                if (!cur)
                    cur = { text, t0, t1, p };
                else {
                    cur.text += text;
                    cur.t1 = t1;
                    cur.p = Math.min(cur.p, p);
                }
            }
            if (cur)
                push(cur.text, cur.t0, cur.t1, cur.p);
        }
        // `meta` is provenance for debugging/reproducibility (which model, what
        // decoding args, when) — not part of the Transcript type, so any reader
        // that only knows about `sourceId`/`language`/`words` ignores it
        // (JSON.stringify/parse round-trips extra own properties just fine; this
        // is purely additive and backward compatible).
        const result = {
            sourceId,
            language: j.result?.language ?? opts.language ?? 'auto',
            words: sanitizeWords(words, opts.sourceDuration),
            meta: {
                model: path.basename(model),
                args: actualArgs,
                at: new Date().toISOString(),
            },
        };
        return result;
    }
    finally {
        // ASR can fail during audio extraction, whisper decoding, JSON parsing,
        // or be cancelled by the daemon. None of those paths may strand a WAV
        // or whisper JSON in /tmp (long recordings can consume gigabytes).
        await fs.rm(tmp, { recursive: true, force: true });
    }
}
/**
 * whisper-cli sometimes collapses a run of trailing words near a clip's end
 * to the same zero-width timestamp (t0 === t1) instead of spreading them out
 * — observed in practice, and it makes remove-words/captions unusable there.
 * This pass fixes that up:
 *  - a run of zero-width words gets time reallocated across
 *    [previous good word's t1, next good word's t0 (or sourceDuration)],
 *    proportional to character count; confidence is capped at 0.3 since the
 *    timing is a guess.
 *  - standalone punctuation/symbol tokens are folded into a neighboring
 *    word's text instead of staying their own (often zero-width) Word.
 *  - a zero-width word that still can't be anchored (no usable boundary on
 *    either side) is kept as-is but marked p=0 so callers treat it as noise.
 */
export function sanitizeWords(raw, sourceDuration) {
    if (raw.length === 0)
        return raw;
    // Fold standalone punctuation/symbol tokens into a neighbor, in the
    // direction the mark actually reads: an opening bracket/quote (「『([（【)
    // belongs with the word that follows it, everything else (closing
    // brackets, commas, sentence-enders) belongs with the word before it.
    // Classifying purely by "is there a previous word yet" (as opposed to by
    // the mark itself) glued a run like closing-then-opening bracket tokens
    // ("」" then "「") onto the SAME previous word, producing garbage like
    // "な」「" instead of "な」" + "「next". Classification is keyed off the
    // token's first character, which matches whisper's actual granularity of
    // one punctuation mark per token.
    const OPEN_CHARS = new Set(['(', '（', '「', '『', '[', '【']);
    const PUNCT_ONLY = /^[、。！？!?」「『』()（）\[\]【】…・,.\s]+$/u;
    const folded = [];
    let openPrefix = ''; // open-class punctuation queued to prefix the next real word
    for (const w of raw) {
        if (PUNCT_ONLY.test(w.text)) {
            const isOpen = OPEN_CHARS.has(w.text[0]);
            if (isOpen || folded.length === 0) {
                // open-class marks always attach forward; anything else falls back
                // to forward attachment too when there's no previous word yet.
                openPrefix += w.text;
            }
            else {
                folded[folded.length - 1] = { ...folded[folded.length - 1], text: folded[folded.length - 1].text + w.text };
            }
            continue;
        }
        folded.push(openPrefix ? { ...w, text: openPrefix + w.text } : { ...w });
        openPrefix = '';
    }
    if (openPrefix) {
        // trailing punctuation with nothing after it to attach to; keep the input.
        if (folded.length === 0)
            return raw;
        folded[folded.length - 1] = { ...folded[folded.length - 1], text: folded[folded.length - 1].text + openPrefix };
    }
    // Reallocate time for runs of zero-width (t0 >= t1) words.
    const out = [];
    for (let i = 0; i < folded.length; i++) {
        if (folded[i].t1 > folded[i].t0) {
            out.push(folded[i]);
            continue;
        }
        let j = i;
        while (j < folded.length && folded[j].t1 <= folded[j].t0)
            j++;
        const run = folded.slice(i, j);
        const prevGood = out[out.length - 1];
        const nextGood = folded[j];
        const start = prevGood ? prevGood.t1 : run[0].t0;
        const end = nextGood ? nextGood.t0 : sourceDuration;
        if (end !== undefined && end > start) {
            const totalChars = run.reduce((a, w) => a + Math.max(1, w.text.length), 0);
            let t = start;
            for (const w of run) {
                const share = (Math.max(1, w.text.length) / totalChars) * (end - start);
                const t0 = t;
                const t1 = t0 + share;
                out.push({ ...w, t0, t1, p: Math.min(w.p, 0.3) });
                t = t1;
            }
        }
        else {
            for (const w of run)
                out.push({ ...w, p: 0 });
        }
        i = j - 1;
    }
    return out;
}
/**
 * Remove files owned exclusively by a video ingest that never became a
 * manifest source. The source id is freshly generated for this attempt, so
 * these paths cannot belong to an older successful ingest. Re-check the
 * manifest first because a very late lock-release error can be reported
 * after the durable commit already landed; referenced media must win over
 * cleanup in that ambiguous boundary.
 */
async function cleanupFailedVideoIngest(project, sourceId, proxyRel, peaksRel) {
    try {
        const current = await project.manifest();
        if (current.sources.some((source) => source.id === sourceId))
            return;
    }
    catch {
        // If durable truth cannot be read, deleting possibly referenced media is
        // the dangerous choice. GC can recover confirmed orphans later.
        return;
    }
    const owned = [
        path.join(project.dir, proxyRel),
        path.join(project.dir, peaksRel),
        project.transcriptPath(sourceId),
        project.scenesPath(sourceId),
    ];
    let cacheNames = [];
    try {
        cacheNames = await fs.readdir(project.cacheDir);
    }
    catch { /* no cache directory/files to clean */ }
    const sceneThumbPrefix = `sc-${sourceId}-`;
    for (const name of cacheNames) {
        if (name.startsWith(sceneThumbPrefix))
            owned.push(path.join(project.cacheDir, name));
    }
    await Promise.all(owned.map((target) => fs.rm(target, { force: true }).catch(() => { })));
}
/**
 * Lightweight ingest for a still-image overlay source (Source.kind:'image' —
 * see the "オーバーレイ・スタック" section above): probes dimensions only —
 * no proxy, no waveform, no scene detection, no transcription, none of
 * which apply to a still image. Unlike ingestFile's video path, the
 * resulting source is NEVER added to `timeline.video` (an image has no
 * A-roll role; it exists purely to be referenced by `vedit overlay-add`)
 * and NEVER touches manifest-level fps/width/height, even when this is the
 * very first source ingested into a brand new project — those describe the
 * PROJECT's own canvas/frame rate, which a decorative overlay image must
 * never redefine. `ingestFile` delegates here automatically for any file
 * `isImageFile` recognizes, so both `vedit ingest <image>` and the daemon's
 * generic `/api/ingest` route (which just calls `ingestFile`) already work
 * for images with no daemon.ts changes needed.
 */
export async function ingestImageFile(project, file, opts = {}) {
    const abs = path.resolve(file);
    throwIfAborted(opts.signal);
    await fs.access(abs);
    throwIfAborted(opts.signal);
    const notify = opts.onProgress ?? (() => { });
    const timings = {};
    const started = Date.now();
    notify('probing (image)');
    const p = await probeImage(abs, { signal: opts.signal });
    timings.probeMs = Date.now() - started;
    const id = freshId('src');
    const source = {
        id,
        path: abs,
        duration: IMAGE_SOURCE_DURATION,
        fps: 0,
        width: p.width,
        height: p.height,
        hasAudio: false,
        kind: 'image',
        sha256: opts.sha256,
    };
    const summary = `ingested ${path.basename(abs)} (image, ${p.width}x${p.height})`;
    const buildNext = (m) => ({ ...m, sources: [...m.sources, source] });
    // Same retry-on-STALE_REVISION loop as ingestFile's video path (see its
    // doc below for why concurrent ingests need it) — the risk is identical
    // here (ingest-batch never targets images, but overlay-add's auto-ingest
    // and a plain `vedit ingest` on multiple image files can still race).
    const MAX_STALE_RETRIES = 20;
    for (let attempt = 0;; attempt++) {
        const cur = await project.manifest();
        throwIfAborted(opts.signal);
        try {
            // There is deliberately no await between this notification and commit:
            // a cancellation endpoint can therefore either abort before the
            // durable boundary or truthfully report that it is too late.
            opts.onCommitStart?.();
            await project.commit(cur.revision, 'system', 'ingest-image', { file: abs }, summary, buildNext);
            break;
        }
        catch (e) {
            if (e?.code === 'STALE_REVISION' && attempt < MAX_STALE_RETRIES)
                continue;
            throw e;
        }
    }
    return { source, timings };
}
export async function ingestFile(project, file, opts = {}) {
    // オーバーレイ・スタック: a PNG/JPEG/WebP routes to the lightweight
    // image-only path instead — see ingestImageFile's doc above. language/
    // transcribe/scenes/addToTimeline are all meaningless for a still image
    // (no audio, no scenes, no A-roll role), so they're silently ignored
    // rather than threaded through; sha256/onProgress still apply uniformly.
    if (isImageFile(file)) {
        return ingestImageFile(project, file, {
            sha256: opts.sha256,
            onProgress: opts.onProgress,
            signal: opts.signal,
            onCommitStart: opts.onCommitStart,
        });
    }
    const abs = path.resolve(file);
    throwIfAborted(opts.signal);
    await fs.access(abs);
    throwIfAborted(opts.signal);
    const notify = opts.onProgress ?? (() => { });
    const timings = {};
    const timed = async (name, fn) => {
        const started = Date.now();
        try {
            return await fn();
        }
        finally {
            timings[name] = Date.now() - started;
        }
    };
    notify('probing');
    const p = await timed('probeMs', () => probe(abs, { signal: opts.signal }));
    const id = freshId('src');
    const proxyRel = `cache/proxy-${id}.mp4`;
    const peaksRel = `cache/peaks-${id}.json`;
    let committed = false;
    try {
        notify('generating proxy');
        await timed('proxyMs', () => makeProxy(abs, path.join(project.dir, proxyRel), p, undefined, { signal: opts.signal }));
        if (p.hasAudio) {
            notify('extracting waveform');
            await timed('peaksMs', () => makePeaks(abs, path.join(project.dir, peaksRel), 25, { signal: opts.signal }));
        }
        const source = {
            id,
            path: abs,
            duration: p.duration,
            fps: p.fps,
            width: p.width,
            height: p.height,
            hasAudio: p.hasAudio,
            proxy: proxyRel,
            peaks: p.hasAudio ? peaksRel : undefined,
            transcribed: false,
            color: p.color,
            sha256: opts.sha256,
        };
        const addToTimeline = opts.addToTimeline ?? true;
        const summary = `ingested ${path.basename(abs)} (${p.duration.toFixed(1)}s)${addToTimeline ? '' : ', pool only'}`;
        // Defined before the transcribe/scenes steps below (rather than only right
        // before the commit loop, as before W-LAZY) so detectScenesForSource can
        // be handed a manifest whose timeline already includes this source's own
        // clip — without that, keptWords() (which hasSpeech is derived from) sees
        // no segment for `id` at all yet and every scene would come back
        // hasSpeech:false regardless of the transcript. `buildNext` reads `source`
        // from the enclosing closure at CALL time, so mutating source.transcribed
        // below (before the scenes step) is still reflected here.
        const buildNext = (m) => {
            const first = m.sources.length === 0;
            return {
                ...m,
                fps: first ? Math.min(60, p.fps) : m.fps,
                width: first ? p.width : m.width,
                height: first ? p.height : m.height,
                sources: [...m.sources, source],
                timeline: addToTimeline
                    ? {
                        ...m.timeline,
                        video: [
                            ...m.timeline.video,
                            { id: freshId('c'), sourceId: id, srcIn: 0, srcOut: p.duration },
                        ],
                    }
                    : m.timeline,
            };
        };
        let transcript;
        if (p.hasAudio && opts.transcribe === true) {
            notify('transcribing (whisper)');
            transcript = await timed('transcribeMs', () => transcribe(abs, id, {
                language: opts.language,
                sourceDuration: p.duration,
                signal: opts.signal,
            }));
            // The source is not visible in the manifest yet, so this compatibility
            // sidecar cannot leak into an export. The same value is also recorded on
            // the ingest revision below for exact undo/redo reproduction.
            await project.writeTranscript(transcript);
            source.transcribed = true;
        }
        if (opts.scenes !== false) {
            notify('detecting scenes');
            await timed('scenesMs', async () => detectScenesForSource(project, buildNext(await project.manifest()), id, { signal: opts.signal }));
        }
        // `ingest-batch` runs up to two ingests concurrently (bounded parallelism
        // for the slow proxy/transcribe work — see batch.ts) but Project.commit
        // is optimistic-concurrency-checked: reading `cur.revision` here and then
        // committing against it is a read-then-write pair, so a second concurrent
        // ingestFile call can land its commit in between and make this one's
        // baseRev stale. That's not a real conflict (each ingest only appends its
        // own source/clip, independent of what the other wrote) — just re-read
        // the manifest and retry. Bounded so a genuinely stuck/looping caller
        // still fails loudly instead of spinning forever.
        const MAX_STALE_RETRIES = 20;
        for (let attempt = 0;; attempt++) {
            const cur = await project.manifest();
            throwIfAborted(opts.signal);
            try {
                // No await until Project.commit owns the operation. The daemon flips
                // its job to `committing` here, so DELETE never promises a cancellation
                // after durable manifest publication can begin.
                opts.onCommitStart?.();
                await project.commit(cur.revision, 'system', 'ingest', { file: abs }, summary, buildNext, undefined, transcript ? { [id]: transcript } : undefined);
                break;
            }
            catch (e) {
                if (e?.code === 'STALE_REVISION' && attempt < MAX_STALE_RETRIES)
                    continue;
                throw e;
            }
        }
        committed = true;
        return { source, timings };
    }
    finally {
        if (!committed)
            await cleanupFailedVideoIngest(project, id, proxyRel, peaksRel);
    }
}
