import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appendExportResult } from '../core/exportResults.js';
import { readKitFile } from '../core/kit.js';
import { loadMotionSpecs, renderComposition, renderFinal, } from './render.js';
/**
 * Full renders must never target the user-visible filename directly: ffmpeg
 * truncates an existing output as soon as it opens it, so a later encode
 * failure would destroy the last known-good export. Keep the partial beside
 * the final file (same filesystem, making the final rename atomic), hidden,
 * unique across concurrent CLI processes, and with an .mp4 suffix so ffmpeg
 * can still infer the muxer.
 */
export function projectRenderPartialPath(finalPath) {
    const resolved = path.resolve(finalPath);
    const parsed = path.parse(resolved);
    return path.join(parsed.dir, `.${parsed.name}.vedit-partial-${process.pid}-${randomUUID()}.mp4`);
}
export async function commitRenderedPartial(partialPath, finalPath) {
    let stat;
    try {
        stat = await fs.stat(partialPath);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('render completed without producing a non-empty MP4');
        }
        throw error;
    }
    if (!stat.isFile() || stat.size <= 0) {
        throw new Error('render completed without producing a non-empty MP4');
    }
    await fs.rename(partialPath, finalPath);
}
async function transcriptsFor(p, m) {
    const out = [];
    for (const s of m.sources) {
        if (!s.transcribed)
            continue;
        try {
            out.push(await p.transcript(s.id));
        }
        catch {
            // Same tolerant contract as the daemon's preview/QC loaders: a stale
            // transcribed flag must not crash preparation before renderFinal can
            // report the actual cue state.
        }
    }
    return out;
}
async function resolvedPreset(m, explicit) {
    if (explicit)
        return explicit;
    if (!m.kit)
        return undefined;
    try {
        const kit = await readKitFile(m.kit.path);
        const preset = kit.defaults?.export_preset;
        return preset === 'youtube' || preset === 'shorts' || preset === 'x' ? preset : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Shared full-MP4 orchestration used by the app export job and suitable for
 * CLI reuse: exact revision snapshot, transcript/motion loading, composition
 * routing, result recording, cancellation, and optional atomic finalization.
 */
export async function renderProjectMp4(p, outPath, opts = {}) {
    await opts.onPhase?.('preparing');
    const m = opts.manifest ?? await p.manifest();
    const preset = await resolvedPreset(m, opts.preset);
    const motionSpecs = opts.motionSpecs ?? (m.timeline.motion.length > 0 ? await loadMotionSpecs(p, m) : undefined);
    const recordFile = opts.recordFile ?? path.resolve(outPath);
    const options = {
        preset,
        noBurnCaptions: Boolean(opts.noBurnCaptions),
        noRepair: Boolean(opts.noRepair),
        fastLoudnorm: Boolean(opts.fastLoudnorm),
    };
    try {
        await opts.onPhase?.('encoding');
        let result;
        if (m.composition) {
            const rendered = await renderComposition(m, path.resolve(outPath), {
                preset,
                signal: opts.signal,
                ...(motionSpecs ? { motionSpecs } : {}),
            });
            const dialogueCount = (m.timeline.dialogue ?? []).length;
            result = {
                file: recordFile,
                revision: m.revision,
                warnings: rendered.warnings,
                ...(dialogueCount > 0 ? { dialogueBurned: true, dialogueCount } : {}),
            };
        }
        else {
            const rendered = await renderFinal(m, opts.transcripts ?? await transcriptsFor(p, m), path.resolve(outPath), {
                noBurnCaptions: opts.noBurnCaptions,
                noRepair: opts.noRepair,
                fastLoudnorm: opts.fastLoudnorm,
                preset,
                signal: opts.signal,
                ...(motionSpecs ? { motionSpecs } : {}),
            });
            result = {
                file: recordFile,
                revision: m.revision,
                warnings: rendered.warnings,
                captionsBurned: rendered.captionsBurned,
                captionCueCount: rendered.captionCueCount,
                dialogueBurned: rendered.dialogueBurned,
                dialogueCount: rendered.dialogueCount,
            };
        }
        await opts.onPhase?.('finalizing');
        await opts.finalize?.();
        const record = {
            ts: new Date().toISOString(),
            kind: 'render',
            file: recordFile,
            ok: true,
            revision: m.revision,
            options,
            ...(result.warnings.length ? { warnings: result.warnings } : {}),
            ...(typeof result.captionsBurned === 'boolean' ? { captionsBurned: result.captionsBurned } : {}),
            ...(typeof result.captionCueCount === 'number' ? { captionCueCount: result.captionCueCount } : {}),
            ...(typeof result.dialogueBurned === 'boolean' ? { dialogueBurned: result.dialogueBurned } : {}),
            ...(typeof result.dialogueCount === 'number' ? { dialogueCount: result.dialogueCount } : {}),
        };
        try {
            await appendExportResult(p.dir, record);
        }
        catch (recordError) {
            const warning = `書き出し結果の履歴を保存できませんでした: ${recordError?.message ?? String(recordError)}`;
            result.warnings = [...result.warnings, warning];
        }
        return result;
    }
    catch (e) {
        // A user cancellation is an interrupted operation, not a failed export;
        // keep the previous "last export" card intact and let the job state
        // surface cancellation. Real failures are recorded for diagnosis.
        if (e?.name !== 'AbortError') {
            try {
                await appendExportResult(p.dir, {
                    ts: new Date().toISOString(),
                    kind: 'render',
                    file: recordFile,
                    ok: false,
                    revision: m.revision,
                    options,
                    error: e?.message ?? String(e),
                });
            }
            catch {
                // Result history is explicitly best-effort. Never replace the actual
                // render/finalize error with a secondary cache-write failure.
            }
        }
        throw e;
    }
}
/**
 * CLI-safe full render: encode to a unique hidden partial, then replace the
 * final path with one same-directory rename only after ffmpeg succeeds. A
 * failure (including finalization failure) removes only this invocation's
 * partial and leaves any prior final file byte-for-byte intact.
 */
export async function renderProjectMp4Atomic(p, finalPath, opts = {}) {
    const final = path.resolve(finalPath);
    const partial = projectRenderPartialPath(final);
    try {
        return await renderProjectMp4(p, partial, {
            ...opts,
            recordFile: final,
            finalize: () => commitRenderedPartial(partial, final),
        });
    }
    finally {
        await fs.rm(partial, { force: true }).catch(() => { });
    }
}
