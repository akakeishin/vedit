#!/usr/bin/env node
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './server/daemon.js';
import { Project, resolveRedoTarget, resolveUndoTarget } from './core/project.js';
import { buildSelectsTimeline, COMP_SOURCE_ID, parseReframeSpec, segments, sourceRangeToTimeline, timelineDuration, timelineTimeToSource, } from './core/ops.js';
import { listProjects } from './core/registry.js';
import { loadPreset, listPresets, savePreset } from './core/presets.js';
import { renderView, renderSceneSheet } from './export/view.js';
import { hasOverlayTransform, hasReframe, writeOtio } from './export/otio.js';
import { renderRangePreview, toAss } from './export/render.js';
import { commitRenderedPartial, projectRenderPartialPath, renderProjectMp4Atomic, } from './export/projectRender.js';
import { forkProject } from './core/fork.js';
import { planGc, runGc } from './core/gc.js';
import { chaptersFromMotion, loadPeaksBySource, publishPack } from './export/publish.js';
import { buildQcReport, probeRenderedFile, staticChecks, tempoContractLite, } from './export/qc.js';
import { writeSrt } from './export/srt.js';
import { downloadWhisperModel, findWhisperModel, isImageFile, sha256File } from './ingest/ingest.js';
import { proposeColorMatch } from './export/color.js';
import { buildPlanSettled, canResumeSkip, copyAndVerify, copyPlain, createJournal, detectDuplicates, journalPath, listVideoFiles, readJournal, reusableVerifiedCopy, runPool, sortByCreationTime, VIDEO_EXTENSIONS, } from './ingest/batch.js';
import { ffmpegBin, ffmpegHasFilter, run } from './ingest/run.js';
import { buildResume } from './core/resume.js';
import { summarizeFirstDraftForCli } from './core/autonomy.js';
import { appendNote, markTodoDone, readNotes } from './core/notes.js';
import { detectTakes, packTakes } from './core/takes.js';
import { buildRetrospective, parseRetentionCsv } from './core/analytics.js';
import { appendExportResult } from './core/exportResults.js';
import { kitProfileHighlights, packKitAssets, readKitFile, recognizedKitSections, scaffoldKit, scanKit, searchKitAssets, writeKitFile, } from './core/kit.js';
const PORT = Number(process.env.VEDIT_PORT ?? 7799);
const BASE = `http://localhost:${PORT}`;
// ---- tiny arg parsing ----
// Flags that never consume the following token as a value — without this,
// `--no-transcribe clip.mp4` would eat `clip.mp4` as the flag's value and
// leave the positional argument list empty.
const BOOLEAN_FLAGS = new Set([
    'transcribe', 'no-transcribe', 'no-scenes', 'no-add', 'no-fillers', 'no-silence',
    'latest', 'full', 'all', 'burn-captions', 'no-burn-captions', 'no-duck',
    'no-repair', 'fast-loudnorm', 'deess', 'confirm',
    'plan', 'link', 'no-verify', 'force', 'flip', 'no-flip',
    'clear', 'no-motion', 'no-sprite', 'no-pos', 'raw', 'keep-duration', 'sfx',
    'yes', 'dry-run', 'mute', 'no-mute', 'no-rect', 'no-fade',
]);
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq > 0) {
            flags[a.slice(2, eq)] = a.slice(eq + 1);
        }
        else {
            const name = a.slice(2);
            if (BOOLEAN_FLAGS.has(name))
                flags[name] = true;
            else if (i + 1 < argv.length && !argv[i + 1].startsWith('--'))
                flags[name] = argv[++i];
            else
                flags[name] = true;
        }
    }
    else
        pos.push(a);
}
function out(obj) {
    console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));
}
function fail(msg) {
    console.error(JSON.stringify({ error: msg }));
    process.exit(1);
}
/** Parse a `--flag` value as a finite number, or fail with a clear message before it ever reaches the API. */
function numFlag(name, raw) {
    if (raw === undefined)
        return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n))
        fail(`--${name} must be a finite number (got ${JSON.stringify(raw)})`);
    return n;
}
/** Parse a positional argument as a finite number, or fail with a clear message before it ever reaches the API. */
function numArg(label, raw) {
    const n = Number(raw);
    if (!Number.isFinite(n))
        fail(`${label} must be a finite number (got ${JSON.stringify(raw)})`);
    return n;
}
/**
 * 「書き出し結果カード」への記録(cache/export-results.json, best-effort)。
 * docs/product-bet-sensory-vs-structural.md:「構造系に必要なのは操作では
 * なく結果の可視化」— 書き出し(export/publish-pack)の完了ごとに成功・
 * 失敗どちらも記録する。書き込み失敗は書き出し自体を失敗させない契約
 * (exportResults.ts の doc 参照)なので、ここで例外を握りつぶして stderr
 * に注記するだけにとどめる。
 */
async function recordExportResult(dir, record) {
    try {
        await appendExportResult(dir, { ts: new Date().toISOString(), ...record });
    }
    catch (e) {
        console.error(`警告: export-results.json への記録に失敗しました: ${e?.message ?? e}`);
    }
}
const MUTATE_HINT = '確認: vedit view / 取消: vedit undo';
function projectDir() {
    const dir = flags.project ?? process.env.VEDIT_PROJECT ?? process.cwd();
    const abs = path.resolve(dir);
    if (!existsSync(path.join(abs, 'project.json'))) {
        fail(`no project.json in ${abs}. Use --project <dir> or run \`vedit create <dir>\` first.`);
    }
    return abs;
}
// ---- daemon client ----
let expectedDaemonProjectDir = null;
function apiRequestInit(pathname, init) {
    if (!init)
        return init;
    const headers = new Headers(init.headers);
    if (typeof init.body === 'string' && !headers.has('content-type'))
        headers.set('content-type', 'application/json');
    const method = (init.method ?? 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        && pathname !== '/api/open'
        && expectedDaemonProjectDir) {
        // Percent-encode so Unicode project paths remain valid Fetch header
        // values; the daemon decodes before comparing absolute identities.
        headers.set('x-vedit-project-dir', encodeURIComponent(expectedDaemonProjectDir));
    }
    return { ...init, headers };
}
async function api(pathname, init) {
    const res = await fetch(BASE + pathname, apiRequestInit(pathname, init));
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = text;
    }
    if (!res.ok) {
        const msg = body?.error ?? text;
        if (res.status === 409 && body?.code === 'PROJECT_IDENTITY_MISMATCH') {
            fail(`REJECTED (project changed): ${msg}`);
        }
        if (res.status === 409)
            fail(`REJECTED (stale revision): ${msg}`);
        fail(msg);
    }
    return body;
}
/**
 * Like `api()`, but never exits the process on a backend error — resolves
 * to a discriminated result instead. `api()`'s exit-on-error is right for
 * every other command (one shot, fail fast), but `ingest-batch` processes
 * many files in one invocation and is designed to survive a single file's
 * ingest failure (record it in the journal, keep going, let the user retry
 * just that file later) — see the 'ingest-batch' case below.
 */
async function apiTry(pathname, init) {
    try {
        const res = await fetch(BASE + pathname, apiRequestInit(pathname, init));
        const text = await res.text();
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            body = text;
        }
        if (!res.ok)
            return { ok: false, error: body?.error ?? text };
        return { ok: true, body };
    }
    catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}
async function daemonUp() {
    try {
        await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(500) });
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDaemon(dir) {
    if (!(await daemonUp())) {
        const self = fileURLToPath(import.meta.url);
        const child = spawn(process.execPath, [self, 'serve', ...(dir ? ['--project', dir] : [])], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 250));
            if (await daemonUp())
                break;
        }
        if (!(await daemonUp()))
            fail('failed to start vedit daemon');
    }
    if (dir) {
        const resolved = path.resolve(dir);
        await api('/api/open', { method: 'POST', body: JSON.stringify({ dir: resolved }) });
        expectedDaemonProjectDir = resolved;
    }
}
function baseRevOf(state) {
    if (flags.base !== undefined)
        return numFlag('base', flags.base);
    if (flags.latest)
        return Number(state.revision);
    fail('--base <revision> is required (or --latest to explicitly use the current one); run `vedit status` first');
}
/** Submit an edit against an already-known baseRev, bypassing the --base/--latest requirement (used by `undo`, which always bases itself on the current revision). */
async function editRaw(baseRev, body) {
    const res = await api('/api/edit', {
        method: 'POST',
        body: JSON.stringify({ baseRev, actor: flags.actor ?? 'agent', ...body }),
    });
    out({ ...res, hint: MUTATE_HINT });
}
async function edit(body) {
    const dir = projectDir();
    await ensureDaemon(dir);
    const state = await api('/api/state');
    await editRaw(baseRevOf(state), body);
}
/**
 * Resolve `--scene <id>` sugar to (sourceId, t0, t1). Scene ids restart per
 * source (like word ids), so when `explicitSource` isn't given this searches
 * every source's scenes file and fails if the id is ambiguous across more
 * than one of them.
 */
async function resolveScene(dir, sceneId, explicitSource) {
    const p = await Project.open(dir);
    const m = await p.manifest();
    const sourceIds = explicitSource ? [explicitSource] : m.sources.map((s) => s.id);
    const hits = [];
    for (const sourceId of sourceIds) {
        const f = await p.scenes(sourceId);
        const sc = f.scenes.find((s) => s.id === sceneId);
        if (sc)
            hits.push({ sourceId, t0: sc.t0, t1: sc.t1 });
    }
    if (hits.length === 0)
        fail(`scene ${sceneId} not found${explicitSource ? ` in source ${explicitSource}` : ''} — run \`vedit scenes detect\` first`);
    if (hits.length > 1)
        fail(`scene id ${sceneId} is ambiguous across sources (${hits.map((h) => h.sourceId).join(', ')}); specify --source`);
    return hits[0];
}
/**
 * Resolve a B-roll overlay's (or W8 sprite's — same anchor contract) anchor
 * sugar — at most one of --at-word / --at-src / --at-tl — to
 * {sourceId, srcTime}. Returns undefined when none were given (broll-update
 * / sprite-update: "don't change the anchor"); broll-add's/sprite-add's
 * caller additionally requires the result to be present.
 *
 * --at-src's syntax is `--at-src <aRollSrc> <秒>`: the tiny flag parser at
 * the top of this file only ever consumes ONE token as a flag's value, so
 * `<aRollSrc>` lands in flags['at-src'] and the trailing `<秒>` token falls
 * through to the positional list — it's pos[1] here since pos[0] is always
 * the command's own id positional (brollSourceId / assetId) for
 * broll-add/broll-update/sprite-add/sprite-update.
 */
async function resolveAnchorFlags(dir) {
    const given = ['at-word', 'at-src', 'at-tl', 'at'].filter((k) => flags[k] !== undefined);
    if (given.length === 0)
        return undefined;
    if (given.length > 1) {
        fail(`specify only one of --at / --at-word / --at-src / --at-tl (got ${given.map((k) => `--${k}`).join(', ')})`);
    }
    if (flags['at'] !== undefined) {
        // W-ANIME: composition-mode sugar — `--at <t>` IS the absolute timeline
        // time directly (COMP_SOURCE_ID sentinel), since a composition has no
        // A-roll source to anchor into (see ops.ts's sourceTimeToTimeline doc).
        const p = await Project.open(dir);
        const m = await p.manifest();
        if (!m.composition) {
            fail('--at requires a composition project (`vedit compose` first); use --at-word/--at-src/--at-tl for a normal (source-driven) project');
        }
        return { sourceId: COMP_SOURCE_ID, srcTime: numFlag('at', flags.at) };
    }
    if (flags['at-word'] !== undefined) {
        const wordId = String(flags['at-word']);
        const p = await Project.open(dir);
        const m = await p.manifest();
        let sourceId = flags.source;
        if (!sourceId) {
            const hits = [];
            for (const s of m.sources) {
                if (!s.transcribed)
                    continue;
                try {
                    const t = await p.transcript(s.id);
                    if (t.words.some((w) => w.id === wordId))
                        hits.push(s.id);
                }
                catch { /* transcript file missing; skip */ }
            }
            if (hits.length === 0)
                fail(`word id ${wordId} not found in any transcribed source; specify --source`);
            if (hits.length > 1)
                fail(`word id ${wordId} is ambiguous across sources (${hits.join(', ')}); specify --source`);
            sourceId = hits[0];
        }
        const t = await p.transcript(sourceId);
        const w = t.words.find((x) => x.id === wordId);
        if (!w)
            fail(`unknown word id: ${wordId} (source ${sourceId})`);
        return { sourceId, srcTime: w.t0 };
    }
    if (flags['at-src'] !== undefined) {
        return { sourceId: String(flags['at-src']), srcTime: numArg('--at-src seconds', pos[1]) };
    }
    // --at-tl: reverse-resolve a CURRENT timeline second to (sourceId, srcTime).
    const tl = numFlag('at-tl', flags['at-tl']);
    const p = await Project.open(dir);
    const m = await p.manifest();
    const r = timelineTimeToSource(m, tl);
    if (!r)
        fail(`--at-tl ${tl}: not a valid timeline position (0..${timelineDuration(m).toFixed(2)})`);
    return r;
}
/** `--emote-at "1:happy,3.5:sad"` -> [{t,assetId},...] (W-ANIME). The tiny flag parser only keeps ONE value per flag name, so multiple emote points are comma-separated in a single flag rather than repeated `--emote-at` occurrences. */
function parseEmoteAt(raw) {
    return raw.split(',').map((pair) => {
        const [tStr, assetId] = pair.split(':');
        const t = Number(tStr);
        if (!Number.isFinite(t) || !assetId) {
            fail(`--emote-at: invalid entry "${pair}" (expected "t:assetId", comma-separated for multiple, e.g. "1:happy,3.5:sad")`);
        }
        return { t, assetId };
    });
}
/** `--rect x,y,w` -> {x,y,w} (0..1 normalized against the output canvas — see OverlayClip.rect) — overlay-add/overlay-update share this. */
function parseOverlayRectFlag(raw) {
    const parts = raw.split(',');
    if (parts.length !== 3)
        fail(`--rect must be "x,y,w" (got ${JSON.stringify(raw)})`);
    return { x: numArg('--rect x', parts[0]), y: numArg('--rect y', parts[1]), w: numArg('--rect w', parts[2]) };
}
/** Collect `--fade-in`/`--fade-out` into an OverlayClip.fade patch, or undefined when neither was given — overlay-add/overlay-update share this. */
function overlayFadeFromFlags() {
    const fadeIn = numFlag('fade-in', flags['fade-in']);
    const fadeOut = numFlag('fade-out', flags['fade-out']);
    if (fadeIn === undefined && fadeOut === undefined)
        return undefined;
    return { ...(fadeIn !== undefined ? { in: fadeIn } : {}), ...(fadeOut !== undefined ? { out: fadeOut } : {}) };
}
/** Collect `--enter`/`--loop`/`--exit`/`--emote-at` into a SpriteItem.motion patch (W-ANIME), or undefined when none were given — sprite-add/sprite-update share this. */
function spriteMotionFromFlags() {
    const motion = {};
    if (flags.enter !== undefined)
        motion.enter = flags.enter;
    if (flags.loop !== undefined)
        motion.loop = flags.loop;
    if (flags.exit !== undefined)
        motion.exit = flags.exit;
    if (flags['emote-at'] !== undefined)
        motion.emoteAt = parseEmoteAt(String(flags['emote-at']));
    return Object.keys(motion).length ? motion : undefined;
}
const HELP = `vedit — conversational local NLE

usage: vedit <command> [args] [--project <dir>]

project:   create <dir> [--name n] | status | resume | revisions | undo [--rev N] | redo | open | projects
             # undo/redo は --base 不要(常に最新に対して)。--rev 無しの undo/redo は連打可能な論理
             # undo/redo スタック(revision ログの形から都度再計算、実装は core/project.ts の
             # resolveUndoTarget/resolveRedoTarget)。redo は直前が undo の時だけ有効 — 間に通常編集や
             # --rev 指定の手動 restore が入ると破棄される。--rev N は従来どおり指定revisionへ直接ジャンプ
           fork --project <src> --to <dir> [--name n]   # 派生プロジェクト作成(revision 独立、cache/transcriptをCoW clone/copy流用)
maintenance: compact [--dry-run]   # revisions.jsonl の世代圧縮(直近100件は全量、以降は10件毎に1件のみ全量保持)
           gc [--yes]              # cache/ の孤児(未参照プロキシ・波形・シーンサムネ等)+ orphan transcript を列挙/削除(既定 dry-run)
notes:     note "<text>" [--type policy|decision|todo|pref]   # 低摩擦メモ(既定 decision; revision が読めれば rev N も記録)
           notes [--limit N]                    # 直近のメモ一覧(既定10件。todo には note-done 用の番号付き)
           note-done <todo番号>                   # 未完了 todo を完了にする(番号は vedit notes の todos[].no)
             # manifest は変更しないので --base 不要。revision ログが「何をしたか」を記録するので、
             # メモは「なぜ/次に何を」だけを残す(重複記録しない)。vedit resume が直近の policy/pref・
             # 未完了todo全件・直近decision2件を自動で拾う
ingest:    ingest <file...> [--language ja] [--transcribe] [--no-scenes] [--no-add]
             # 既定: プロキシ+波形+シーン検出まで(文字起こしはしない)。旧挙動(即時transcribe)は --transcribe
             # 画像ファイル(png/jpg/jpeg/webp)は probe のみ(kind:'image'。オーバーレイ素材用、timelineには追加されない)
           ingest-batch <dir|files...> [--plan] [--copy destDir | --link] [--no-verify]
             [--language ja] [--transcribe] [--no-scenes] [--no-add]   # 撮影カード一括取込、検証付き・再開可能
transcribe: transcribe <sourceId|all> [--language ja] [--glossary "語1,語2,..."]
             # 文字起こしを裏で非同期実行(即座に返る; WSで transcribe-progress/-done/-error を配信)
             # --glossary は whisper の --prompt に整形して渡し、manifest に保存して以後の transcribe にも自動適用
           transcribe-cancel <taskId|sourceId>   # 保存開始前の文字起こしを安全に中止
read:      transcript [--full] [--source id] | candidates [--all] | sources
detect:    detect [--min-gap 0.7] [--threshold 0.06] [--no-fillers] [--no-silence]
           first-draft [same detection flags]   # AI初稿: 両検出が一致した低リスク無音だけ自律適用し、好みが要る候補だけ残す
cut:       remove-words <w1 w5..w9 ...> [--source id] [--pad 0.08] | remove-range <t0> <t1> [--source id]
           approve <id...|all> | reject <id...> | trim <clipId> <in|out> <±frames>
clips:     clip-add <sourceId> [--in s] [--out s] [--at index] | clip-remove <clipId>
           clip-move <clipId> --before <clipId|end>
           clip-audio <clipId> [--gain -30..12] [--mute|--no-mute] --base <rev>   # クリップ単位の音量/ミュート(プレビュー未反映、書き出しで確認)
           split <clipId> --at <tl秒> --base <rev>       # タイムライン時刻で2分割(内容不変・境界追加のみ)。クリップ端/端から1フレーム未満はエラー
           duplicate <clipId> --base <rev>                # 直後に同一ソース範囲を複製配置(新id)
scenes:    scenes detect [--source id] [--sensitivity 0.3] [--max-len 12] [--min-len 1.5]
           scenes [--source id]                    # packed scene list (id/range/hasSpeech/energy/[keep|reject]/note)
           scenes sheet [--source id] [--cols n]    # contact sheet PNG (prints path; Read it)
           scenes note <sceneId> "<text>" --by model|user [--source id]
           --scene <sceneId> sugar on clip-add / remove-range / view (resolves to sourceId+t0+t1)
culling:   review <sceneId...> keep|reject|clear [--source id] --base <rev>   # 3状態カリング(未確認/keep/reject)
           review-status                            # keep/reject/未確認の集計 + 次に確認すべきシーン id
           selects --base <rev> [--confirm]         # keep シーンだけの仮タイムラインでタイムラインを置換(--confirm 無しはプレビューのみ)。keep シーン内の既存の微修正(remove-words 等)は既定で保持
           selects --raw                            # プレビューのみ: 旧動作(シーン生範囲でそのまま置換、微修正は破棄)を確認。--raw --confirm は未対応
reframe:   reframe <9:16|1:1|16:9|WxH> [--focus left|center|right|0..1]
           clip-crop <clipId> [--x 0..1] [--y 0..1]
captions:  captions [--enabled true|false] [--style clean|bold|<kitStyleId>] [--max-chars 24]
           captions [--font f] [--text-color #rrggbb] [--outline-color #rrggbb] [--box-color #rrggbb]
             [--size-scale 0.5..2] [--outline-width px] [--bg-opacity 0..1] [--position-v 0..1]  # 字幕スタイルの微調整(UI のポップオーバーからも変更可)
           caption-text <sourceId:wordId> "新テキスト" --base <rev>   # 字幕テキストの誤字修正(元の書き起こしは変えない)
           caption-text <sourceId:wordId> --clear --base <rev>       # 修正を解除
           fonts   # 利用可能なフォント一覧(キット内 + システム、read-only)
motion:    motion-add --type chapter-card --text "..." --at 12 --duration 4 [--subtitle ...]
           motion-update <id> [--text ...] [--at ...] [--duration ...] | motion-remove <id>
music:     music-add <file> [--at 0] [--duration N] [--src-in 0] [--gain -12] [--fade-in 1] [--fade-out 2] [--no-duck] [--sfx]
             # --sfx: SE(効果音)糖衣 — duck無効+0.03sクリックガードfade+role:'sfx'。明示フラグが常に優先
           music-update <id> [同フラグ] | music-remove <id>
           audio-mix [--target-lufs -14] [--duck-amount -10] [--crossfade-ms 12]
           audio-repair --preset outdoor|indoor|wireless|off [--deess]   # 会話音声リペア(既定 off)
color:     color --source <id> --type hlg|pq|lut|none [--lut path] --base <rev>   # 入力色変換(Rec.709へ、プロキシ自動再生成)
           color-adjust --source <id> [--exposure -2..2] [--wb -100..100] [--sat 0..2] --base <rev>
           color-match <基準sourceId> <対象sourceId...>   # 代表フレームの signalstats から調整候補を提案(read-only)
broll:     broll-add <brollSourceId> [--in s --out s | --scene sX]
             (--at-word wXXXX [--source aRollSrc] | --at-src aRollSrc t | --at-tl t)
             [--audio mute|mix|replace] [--gain -18] --base <rev>        # B-roll V2 トラック(重複不可・話者音声に張り付く)
           broll-update <id> [同フラグ] --base <rev> | broll-remove <id> --base <rev>
             # broll-add は overlay-add の layer 1 の別名として引き続き動作(挙動不変)
overlay:   overlay-add <sourceId|画像ファイル> --at <アンカー> [--dur s | --in s --out s | --scene sX]
             [--rect x,y,w] [--layer N(既定1)] [--opacity 0..1] [--fade-in s] [--fade-out s]
             [--audio mute|mix|replace] [--gain -18] --base <rev>
             # オーバーレイ・スタック: 複数レイヤーの画像/動画重ね(同一layer内は重複不可・レイヤー間は自由)
             # 画像ファイル(png/jpg/jpeg/webp)を直接指定すると自動 ingest(kind:'image')してから配置。画像は常に無音
             # --rect x,y,w は 0..1 正規化(縦は元画像比率を維持)。省略時は現行どおり全面表示
           overlay-update <id> [同フラグ] [--no-rect] [--no-fade] --base <rev> | overlay-remove <id> --base <rev>
kit:       kit-init <dir> [--name n]                  # 雛形生成(kit.json + GUIDE.md + fonts/ + assets/{characters,backgrounds,props})
           kit-link <dir> --base <rev> | kit-unlink --base <rev> | kit   # リンク/解除/内容表示(profile要点含む)
           kit-scan [dir] [--force]                    # assets/ の PNG からアルファ境界・足元アンカーを自動計算
           kit-assets [--tag t] [--emotion e]           # キット素材の検索(read-only)
sprites:   sprite-add <assetId> (--at t [composition] | --at-word wXXXX [--source aRollSrc] | --at-src aRollSrc t | --at-tl t)
             [--pos x,y] [--scale 0..1] [--opacity 0..1] [--duration s] [--flip]
             [--enter slide-left|slide-right|hop-in|pop|fade] [--loop sway|bob|hop|breathe|none] [--exit 同名]
             [--emote-at "t:assetId,..."] --base <rev>
           sprite-update <id> [同フラグ] [--no-motion] --base <rev> | sprite-remove <id> --base <rev>
anime:     compose <dir> --duration 秒 --size WxH|比率 [--name n] [--background #hex|assetId|videoPath] [--kit <dir>]
             # コンポジション(スプライトアニメ): 映像ソースなしの製作モード。ゆる紙芝居+キャラが緩く動くショート
           bg-set --at t --to <#hex|assetId|videoPath> --base <rev>   # 紙芝居の背景切替(t=0 は基本背景を置換)
           bg-remove --at t --base <rev>
           dialogue-add "セリフ" --at t [--duration s] [--sprite <spriteItemId>] [--pos x,y] [--voice <音声ファイル>] --base <rev>
             # --pos は 0..1 正規化座標の手動アンカー(自動配置より優先)。同時刻の既存セリフと重なり、
             # 双方に --pos が無い場合は warnings に重なり注意が出る(ブロックはしない)
           dialogue-update <id> ["新テキスト"] [--at t] [--duration s] [--sprite <id>|--no-sprite] [--pos x,y|--no-pos] --base <rev>
           dialogue-remove <id> --base <rev>
           shift --from <t> --by <±秒> [--keep-duration] --base <rev>
             # 「間」の一括調整(コンポジション専用): t>=from の sprite/dialogue/music/背景切替を平行移動。
             # 既定は duration も伸縮、--keep-duration で尺固定(はみ出す項目はエラー、黙って消さない)
takes:     takes [--source id]   # 言い直し(撮り直し)候補の検出結果を表示(read-only、何も適用しない)
intent:    intent-add <sourceId> <t0> <t1> --label "余韻" [--kind quiet|hold] --base <rev>
             # 「静寂スコア」保護区間: --kind quiet(既定)は無音検出の自動除外+BGMダッキング警告、hold は検出除外のみ
           intent-remove <id> --base <rev>
show:      show range <t0> <t1> | show words <w1 w5..w9 ...> [--source id] | show candidate <id>
           show compare <revA> <revB> | show source <id> [--at s] | show takes <sourceId> <groupId>
             # 隣の画面(web UI)へジャンプ/ハイライトの合図を送るだけ(revision を作らない、--base 不要)
inspect:   view [--from a] [--to b] [--domain timeline|source] [--source id] [--scene id] (prints PNG path)
qc:        qc [--render <out.mp4>] [--report <out.html>]
             # 静的チェック(未処理候補/orphan/字幕重複/色警告/素材欠落/kit尺乖離)。--render で暗転・無音・ラウドネスも実測
             # kit があれば tempo contract(表示のみ・合否判定なし)も付与。--report で buildQcReport の HTML を書き出し
export:    export otio <out.otio> | export render <out.mp4> [--no-burn-captions] [--preset youtube|shorts|x]
           export render ... [--no-repair] [--fast-loudnorm]   # 乾音A/B比較 / 1-passループドネスに落とす
           export render <out.mp4> --range <a>..<b>   # 範囲下見レンダー(下見品質固定: 720p級/veryfast/1-passloudnorm)
             # captions.enabled なら字幕は既定で焼き込み。--no-burn-captions でクリーン映像に(NLE手渡し用)
             # dialogue(セリフ)は captions 設定と無関係に常に焼き込み(唯一の出口のため)
             # motion(チャプターカード等4プリセット)は自動で焼き込み。custom-html は対象外(警告を出力)
             # --burn-captions は後方互換の受理のみ(焼き込みが既定になったため no-op)
           export fcp7xml <out.xml> | export srt <out.srt> | export ass <out.ass>
publish:   publish-pack <outdir> [--thumbs 6] [--render <file>]   # chapters.txt + thumbnails/ + materials.json (read-only)
             # --render <file>: コンポジション(スプライトアニメ)PJのサムネイルは書き出し済みファイルから抽出(未指定なら理由付きでスキップ)
analytics: retro <csv> [--render-duration 秒]
             # YouTube Studio の視聴者維持率CSVを取り込み、構造化JSON+人間向けサマリを出力(仮説は含まない・事実のみ)
presets:   preset-save <name> [--data '{"k":"v"}'] | preset-apply <name> | preset-list
misc:      doctor [--download-model [name]] | serve [--port]

Mutating commands REQUIRE --base <rev> (or --latest to explicitly use the
current one); if the project changed since that revision the edit is
REJECTED (409) — re-read state first. Exception: \`undo\`/\`redo\` never need
--base — they always base themselves on the current revision, since undoing/
redoing inherently means "from here, go back/forward one logical step".`;
/** "1:23.4" — same compact timestamp convention as qc.ts's fmtTl / takes.ts's ts. */
function tsFmt(t) {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
}
/**
 * Human-readable rendering of `buildRetrospective`'s FACTS-ONLY output
 * (analytics.ts deliberately returns no hypotheses field — see its doc
 * comment) — this stays equally fact-only: numbers, quotes, chapter/scene
 * context, no causal claims. Interpreting *why* a dip happened is the
 * director's job in conversation (per SKILL.md's 振り返り section), not
 * something baked into CLI output.
 */
function formatRetrospective(r) {
    const lines = ['視聴者維持率ふりかえり(事実のみ・原因の断定は含みません)'];
    lines.push(`- イントロ離脱: -${r.introDropPct.toFixed(1)}pt`);
    const pushEvent = (e, sign) => {
        const chap = e.chapter ? ` [${e.chapter.title}]` : '';
        const quote = e.quote ? ` "${e.quote}"` : '';
        lines.push(`  - ${e.positionPct.toFixed(1)}% (t=${tsFmt(e.tlTime)}, ${sign}${Math.abs(e.deltaPct).toFixed(1)}pt)${chap}${quote}`);
    };
    lines.push(`- 落ち込み: ${r.dips.length}件`);
    for (const e of r.dips)
        pushEvent(e, '-');
    lines.push(`- 伸び: ${r.spikes.length}件`);
    for (const e of r.spikes)
        pushEvent(e, '+');
    lines.push('※ 数値は実測値です。原因はディレクターとの対話で整理してください(このコマンドは仮説を出しません)');
    return lines.join('\n');
}
async function main() {
    switch (cmd) {
        case undefined:
        case 'help':
        case '--help':
            return out(HELP);
        case 'serve': {
            const dir = flags.project ? path.resolve(flags.project) : undefined;
            const daemon = await startDaemon({ port: numFlag('port', flags.port) ?? PORT, projectDir: dir });
            const { url } = daemon;
            let shuttingDown = false;
            const shutdown = async () => {
                if (shuttingDown)
                    return;
                shuttingDown = true;
                process.off('SIGINT', shutdown);
                process.off('SIGTERM', shutdown);
                try {
                    await daemon.close();
                }
                catch (error) {
                    console.error(`failed to shut down vedit daemon cleanly: ${error?.message ?? String(error)}`);
                    process.exitCode = 1;
                }
            };
            process.once('SIGINT', shutdown);
            process.once('SIGTERM', shutdown);
            console.log(`vedit daemon on ${url}${dir ? ` (project: ${dir})` : ''}`);
            return; // keeps running
        }
        case 'create': {
            const dir = path.resolve(pos[0] ?? fail('usage: vedit create <dir>'));
            await Project.create(dir, flags.name ?? path.basename(dir));
            await ensureDaemon(dir);
            return out({ ok: true, dir, next: `vedit ingest <video> --project ${dir}` });
        }
        case 'fork': {
            // 「--project」はここでは source project の意味(projectDir() の通常
            // 解決規則そのまま — --project/VEDIT_PROJECT/cwd の順)。新しい派生
            // プロジェクトの行き先は --to。派生元の daemon は不要(ファイル操作の
            // み)なので ensureDaemon は呼ばない。
            const destArg = flags.to;
            if (!destArg)
                fail('usage: vedit fork --project <src> --to <dir> [--name <名前>]');
            const srcDir = projectDir();
            const destDir = path.resolve(destArg);
            const res = await forkProject(srcDir, destDir, { name: flags.name });
            return out({ ...res, hint: `vedit open --project ${destDir}` });
        }
        case 'compose': {
            // W-ANIME: create (or re-tune) a source-less "composition" project —
            // sprites moving over a background, no A-roll footage. `dir` is
            // created if it doesn't exist yet (same convention as `create`).
            const USAGE = 'usage: vedit compose <dir> --duration <seconds> --size <WxH|ratio> [--name n] [--background #hex|assetId|videoPath] [--kit <dir>]';
            const dir = path.resolve(pos[0] ?? fail(USAGE));
            const duration = numFlag('duration', flags.duration) ?? fail(USAGE);
            if (!flags.size)
                fail(USAGE);
            const size = parseReframeSpec(String(flags.size));
            await ensureDaemon(dir);
            // Kit must link BEFORE the compose op: `--background <kitAssetId>`
            // resolves against the manifest's linked kit at apply time.
            if (flags.kit) {
                const state0 = await api('/api/state');
                await api('/api/edit', {
                    method: 'POST',
                    body: JSON.stringify({
                        baseRev: state0.revision, actor: flags.actor ?? 'agent',
                        op: 'kit-link', path: path.resolve(String(flags.kit)),
                    }),
                });
            }
            const state = await api('/api/state');
            const res = await api('/api/edit', {
                method: 'POST',
                body: JSON.stringify({
                    // compose is a create-class command: it opened/created the project
                    // itself just above, so demanding --base here would only add
                    // friction with nothing to protect (like `create`, unlike edits).
                    baseRev: flags.base !== undefined ? Number(flags.base) : state.revision,
                    actor: flags.actor ?? 'agent',
                    op: 'compose', duration, width: size.width, height: size.height,
                    background: flags.background,
                    // Resolved against THIS process's cwd (the user's actual shell),
                    // not the daemon's — see resolveBackgroundArg's doc in daemon.ts.
                    backgroundPathHint: flags.background ? path.resolve(String(flags.background)) : undefined,
                }),
            });
            return out({
                ok: true, dir, ...res,
                hint: 'vedit sprite-add <assetId> --at <t> --pos x,y --scale .. --enter .. --loop .. --base <rev>',
            });
        }
        case 'bg-set': {
            const t = numFlag('at', flags.at) ?? fail('usage: vedit bg-set --at <t> --to <#hex|assetId|videoPath> --base <rev>');
            const to = flags.to;
            if (!to)
                fail('usage: vedit bg-set --at <t> --to <#hex|assetId|videoPath> --base <rev>');
            // Resolved against THIS process's cwd — see resolveBackgroundArg's doc in daemon.ts.
            return edit({ op: 'bg-set', t, to, toPathHint: path.resolve(to) });
        }
        case 'bg-remove':
            return edit({ op: 'bg-remove', t: numFlag('at', flags.at) ?? fail('usage: vedit bg-remove --at <t> --base <rev>') });
        case 'shift': {
            // Composition-only "間" adjustment (see ops.ts's shiftComposition):
            // translate every sprite/dialogue/music/bg-cut at/after --from by --by
            // seconds; duration stretches by the same amount unless
            // --keep-duration pins it (out-of-range then errors, never drops).
            const USAGE = 'usage: vedit shift --from <t> --by <±秒> [--keep-duration] --base <rev>';
            const from = numFlag('from', flags.from) ?? fail(USAGE);
            const by = numFlag('by', flags.by) ?? fail(USAGE);
            return edit({ op: 'shift', from, by, keepDuration: Boolean(flags['keep-duration']) });
        }
        case 'dialogue-add': {
            const USAGE = 'usage: vedit dialogue-add "text" --at <t> [--duration s] [--sprite <spriteItemId>] [--pos x,y] [--voice <audioFile>] --base <rev>';
            const text = pos[0] ?? fail(USAGE);
            const tlStart = numFlag('at', flags.at) ?? fail(USAGE);
            let dialoguePos;
            if (flags.pos !== undefined) {
                const [xs, ys] = String(flags.pos).split(',');
                dialoguePos = { x: numArg('--pos x', xs), y: numArg('--pos y', ys) };
            }
            return edit({
                op: 'dialogue-add',
                text,
                tlStart,
                duration: numFlag('duration', flags.duration),
                spriteId: flags.sprite,
                pos: dialoguePos,
                voice: flags.voice ? path.resolve(String(flags.voice)) : undefined,
            });
        }
        case 'dialogue-update': {
            const id = pos[0] ?? fail('usage: vedit dialogue-update <id> ["text"] [--at t] [--duration s] [--sprite <id>|--no-sprite] [--pos x,y|--no-pos] --base <rev>');
            let dialoguePos;
            if (flags['no-pos']) {
                dialoguePos = null;
            }
            else if (flags.pos !== undefined) {
                const [xs, ys] = String(flags.pos).split(',');
                dialoguePos = { x: numArg('--pos x', xs), y: numArg('--pos y', ys) };
            }
            return edit({
                op: 'dialogue-update',
                id,
                text: pos[1],
                tlStart: numFlag('at', flags.at),
                duration: numFlag('duration', flags.duration),
                spriteId: flags['no-sprite'] ? null : flags.sprite,
                pos: dialoguePos,
            });
        }
        case 'dialogue-remove':
            return edit({ op: 'dialogue-remove', id: pos[0] ?? fail('usage: vedit dialogue-remove <id> --base <rev>') });
        case 'open': {
            const dir = projectDir();
            await ensureDaemon(dir);
            return out({ url: BASE, hint: 'open this URL in a browser (or your AI client browser pane) for live preview' });
        }
        case 'status': {
            const dir = projectDir();
            await ensureDaemon(dir);
            const state = await api('/api/state');
            return out({ ...state, previewUrl: BASE, hint: 'pass --base ' + state.revision + ' to mutating commands' });
        }
        case 'resume': {
            // Read-only session-resume snapshot — deliberately reads project.json
            // + revisions.jsonl + candidates.json directly (like `sources`), no
            // daemon required, no --base needed.
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const revs = await p.revisions();
            const cands = await p.candidates();
            let kit = null;
            if (m.kit) {
                try {
                    kit = await readKitFile(m.kit.path);
                }
                catch { /* kit unreadable — resume() surfaces no kitProfile rather than failing the whole command */ }
            }
            // W-LAZY: feeds buildResume's "talk-likely but untranscribed" nextSteps
            // hint (see core/resume.ts) — every source's scenes file, skipping
            // ones with none detected yet (same pattern as sceneFilesFor in
            // server/daemon.ts).
            const sceneFiles = [];
            for (const s of m.sources) {
                const f = await p.scenes(s.id);
                if (f.scenes.length)
                    sceneFiles.push(f);
            }
            // 低摩擦編集メモ(NOTES.md, 無ければ [])— see core/notes.ts / core/resume.ts's ResumeNotesSummary.
            const notes = await readNotes(dir);
            return out(buildResume(m, dir, revs, cands, kit, sceneFiles, notes));
        }
        case 'note': {
            // NOTES.md への追記(core/notes.ts)。manifest を一切変更しないので
            // revision の安全機構(--base)の対象外——`show` と同じ「いつでも呼べる」
            // 系のコマンド。revision 番号は分かれば記録するだけで、読めなくても失敗しない。
            const USAGE = 'usage: vedit note "<text>" [--type policy|decision|todo|pref]';
            const text = pos[0] ?? fail(USAGE);
            const type = flags.type ?? 'decision';
            if (type !== 'policy' && type !== 'decision' && type !== 'todo' && type !== 'pref') {
                fail(`--type must be one of: policy | decision | todo | pref (got ${JSON.stringify(type)})`);
            }
            const dir = projectDir();
            let rev;
            try {
                const m = await (await Project.open(dir)).manifest();
                rev = m.revision;
            }
            catch { /* manifest unreadable — note still gets written, just without a rev number */ }
            await appendNote(dir, { type: type, text, rev });
            return out({ ok: true, type, rev });
        }
        case 'notes': {
            // Read-only, no daemon required (same as `resume`/`sources`).
            const dir = projectDir();
            const all = await readNotes(dir);
            // `note-done` 用の連番(ファイル全体を通した未完了 todo の出現順)を
            // 表示にも付与する——`--limit` で切っても番号自体はファイル全体基準のまま。
            let n = 0;
            const numbered = all.map((e) => ({
                ...e,
                ...(e.todos ? { todos: e.todos.map((t) => (t.done ? t : { ...t, no: ++n })) } : {}),
            }));
            const limit = numFlag('limit', flags.limit) ?? 10;
            return out(numbered.slice(-limit));
        }
        case 'note-done': {
            const USAGE = 'usage: vedit note-done <todo番号> (番号は `vedit notes` の todos[].no を参照)';
            const idx = Number(pos[0]);
            if (!Number.isInteger(idx) || idx < 1)
                fail(USAGE);
            const dir = projectDir();
            try {
                const { text } = await markTodoDone(dir, idx);
                return out({ ok: true, done: text });
            }
            catch (e) {
                fail(e?.message ?? String(e));
            }
        }
        case 'projects': {
            // Global registry, not tied to any single project — reads the
            // project.json files directly instead of going through the daemon.
            const entries = await listProjects();
            const rows = [];
            for (const e of entries) {
                try {
                    const p = await Project.open(e.dir);
                    const m = await p.manifest();
                    rows.push({ name: m.name, dir: e.dir, lastOpened: e.lastOpened, duration: timelineDuration(m) });
                }
                catch {
                    rows.push({ name: e.name, dir: e.dir, lastOpened: e.lastOpened, duration: null });
                }
            }
            return out(rows);
        }
        case 'ingest': {
            if (flags.transcribe && flags['no-transcribe'])
                fail('--transcribe and --no-transcribe are mutually exclusive');
            const dir = projectDir();
            await ensureDaemon(dir);
            if (pos.length === 0)
                fail('usage: vedit ingest <file...> [--language ja] [--transcribe] [--no-scenes] [--no-add]');
            // W-LAZY: transcription defaults OFF (scene detection is the ingest-time
            // structural signal instead) — pass --transcribe to keep the old
            // "transcribe at ingest" behavior for material known upfront to be
            // talk-centric; otherwise run `vedit transcribe <sourceId|all>` later.
            for (const f of pos) {
                console.error(`ingesting ${f} (proxy + waveform${flags['no-scenes'] ? '' : ' + scene detection'}${flags.transcribe ? ' + transcription' : ''}; this can take a while)...`);
                const res = await api('/api/ingest', {
                    method: 'POST',
                    body: JSON.stringify({
                        file: path.resolve(f),
                        language: flags.language,
                        transcribe: flags.transcribe ? true : flags['no-transcribe'] ? false : undefined,
                        scenes: flags['no-scenes'] ? false : undefined,
                        addToTimeline: flags['no-add'] ? false : undefined,
                    }),
                });
                out(res);
            }
            return;
        }
        case 'ingest-batch': {
            const USAGE = 'usage: vedit ingest-batch <dir|files...> [--plan] [--copy destDir | --link] [--no-verify] [--language ja] [--transcribe] [--no-scenes] [--no-add]';
            if (pos.length === 0)
                fail(USAGE);
            if (flags.copy && flags.link)
                fail('--copy and --link are mutually exclusive');
            if (flags.transcribe && flags['no-transcribe'])
                fail('--transcribe and --no-transcribe are mutually exclusive');
            const dir = projectDir();
            const files = await listVideoFiles(pos);
            if (files.length === 0)
                fail(`no video files found (recognized extensions: ${[...VIDEO_EXTENSIONS].join('/')})`);
            console.error(`scanning ${files.length} file(s)...`);
            const plan = await buildPlanSettled(files);
            const sorted = await sortByCreationTime(plan.entries);
            if (flags.plan) {
                return out({
                    selectedFileCount: files.length,
                    fileCount: plan.fileCount,
                    totalSize: plan.totalSize,
                    totalDuration: Number(plan.totalDuration.toFixed(1)),
                    files: sorted.map((e) => ({
                        file: e.file,
                        size: e.size,
                        duration: Number(e.duration.toFixed(1)),
                        codec: e.codec,
                        hasAudio: e.hasAudio,
                        warnings: e.warnings.map((w) => w.message),
                    })),
                    failed: plan.failures,
                    applied: false,
                    hint: plan.failures.length > 0
                        ? '読み取り専用プラン。一部ファイルはprobeに失敗しましたが、正常なファイルの下見は完了しています。実行するには --plan を外してください'
                        : '読み取り専用プラン(重複検出・取り込みは未実行)。実行するには --plan を外して再実行してください',
                });
            }
            const copyDest = flags.copy ? path.resolve(String(flags.copy)) : undefined;
            const verify = !flags['no-verify'];
            // Existing-source dedup: read the manifest directly (like `vedit
            // sources`) rather than through the daemon — this is a read-only
            // lookup that doesn't need the daemon up yet.
            const p = await Project.open(dir);
            const m0 = await p.manifest();
            const existingBySha = new Map();
            for (const s of m0.sources)
                if (s.sha256)
                    existingBySha.set(s.sha256, s.id);
            // Journal failures are per-file. A corrupt container must not hide
            // usable peers selected in the same run.
            const priorJournal = await readJournal(dir);
            const priorByFile = new Map(priorJournal.map((e) => [e.file, e]));
            const journal = createJournal(dir, priorJournal);
            const preflightFailures = [...plan.failures];
            for (const failure of plan.failures) {
                await journal.record({
                    file: failure.file,
                    status: 'failed',
                    stage: failure.stage,
                    error: failure.error,
                    at: new Date().toISOString(),
                });
            }
            // Hashing (unless --no-verify): sequential with N/M progress, since a
            // multi-GB file can take real wall-clock time to hash and interleaving
            // hash progress with 2-wide ingest progress would be unreadable. Resume
            // skips happen only AFTER this hash proves the path still has the same
            // bytes that were recorded as ingested.
            const fileHashes = new Map();
            const toProcess = [];
            const reprocessedChangedFiles = [];
            let resumeSkipped = 0;
            for (let i = 0; i < sorted.length; i++) {
                const entry = sorted[i];
                const previous = priorByFile.get(entry.file);
                let hash;
                if (verify) {
                    console.error(`hashing ${i + 1}/${sorted.length}: ${path.basename(entry.file)}`);
                    try {
                        hash = await sha256File(entry.file);
                    }
                    catch (error) {
                        const failure = { file: entry.file, stage: 'hash', error: error?.message ?? String(error) };
                        preflightFailures.push(failure);
                        await journal.record({ ...failure, status: 'failed', at: new Date().toISOString() });
                        continue;
                    }
                    fileHashes.set(entry.file, hash);
                    if (canResumeSkip(previous, hash)) {
                        resumeSkipped++;
                        continue;
                    }
                    if (previous?.status === 'ingested' && previous.sha256 && previous.sha256 !== hash) {
                        reprocessedChangedFiles.push(entry.file);
                        console.error(`bytes changed since prior ingest; reprocessing: ${path.basename(entry.file)}`);
                    }
                    await journal.record({ file: entry.file, sha256: hash, status: 'planned', at: new Date().toISOString() });
                }
                else {
                    // With no current hash, path-only resume would silently skip a new
                    // file that reused an old camera/download filename. Retry instead.
                    await journal.record({ file: entry.file, status: 'planned', at: new Date().toISOString() });
                }
                toProcess.push(entry);
            }
            if (resumeSkipped > 0)
                console.error(`skipping ${resumeSkipped} byte-identical already-ingested file(s) (journal resume: ${journalPath(dir)})`);
            if (!verify && sorted.some((e) => priorByFile.get(e.file)?.status === 'ingested')) {
                console.error('--no-verify: journal resume cannot prove byte identity; previously ingested paths will be retried');
            }
            // Duplicate detection (batch-internal + against existing sources) —
            // only meaningful when hashes were actually computed.
            let targets = toProcess;
            const skippedDuplicates = [];
            if (verify) {
                const { unique, duplicates } = detectDuplicates(toProcess.map((e) => ({ file: e.file, hash: fileHashes.get(e.file) })), existingBySha);
                skippedDuplicates.push(...duplicates);
                const uniqueFiles = new Set(unique.map((u) => u.file));
                targets = toProcess.filter((e) => uniqueFiles.has(e.file));
                for (const d of duplicates) {
                    console.error(`skip duplicate (${d.kind === 'existing' ? 'already in project: ' + d.duplicateOf : 'same as ' + path.basename(d.duplicateOf)}): ${path.basename(d.file)}`);
                }
            }
            if (targets.length === 0) {
                return out({
                    ingested: 0,
                    failed: preflightFailures,
                    skippedDuplicates: skippedDuplicates.map((d) => ({ file: d.file, kind: d.kind, duplicateOf: d.duplicateOf })),
                    skippedAlreadyIngested: resumeSkipped,
                    reprocessedChangedFiles,
                    journal: journalPath(dir),
                    hint: preflightFailures.length > 0
                        ? '正常にprobe/hashできた取り込み対象はありません。失敗ファイルはstageを確認して再試行できます'
                        : '取り込み対象なし(全件が重複または取り込み済み)',
                });
            }
            await ensureDaemon(dir);
            const results = new Map();
            // Bounded to 2 concurrent files: proxy generation + scene detection
            // (+ transcription when --transcribe is given) are the expensive part
            // of each /api/ingest call (see runPool in batch.ts). Copy-then-verify
            // happens inside the same worker so it's
            // bounded by the same concurrency limit.
            const workerFailures = await runPool(targets, 2, async (entry) => {
                const hash = fileHashes.get(entry.file);
                const previous = priorByFile.get(entry.file);
                let ingestPath = entry.file;
                let stage = copyDest ? 'copy' : 'ingest';
                try {
                    if (copyDest) {
                        const reusable = await reusableVerifiedCopy(previous, copyDest, hash);
                        ingestPath = reusable
                            ?? (hash ? await copyAndVerify(entry.file, copyDest, hash) : await copyPlain(entry.file, copyDest));
                        if (reusable)
                            console.error(`reusing verified copy after interrupted/failed ingest: ${path.basename(reusable)}`);
                        await journal.record({ file: entry.file, sha256: hash, status: 'copied', destPath: ingestPath, at: new Date().toISOString() });
                    }
                    stage = 'ingest';
                    console.error(`ingesting ${path.basename(entry.file)}...`);
                    const res = await apiTry('/api/ingest', {
                        method: 'POST',
                        body: JSON.stringify({
                            file: ingestPath,
                            sha256: hash,
                            language: flags.language,
                            transcribe: flags.transcribe ? true : flags['no-transcribe'] ? false : undefined,
                            scenes: flags['no-scenes'] ? false : undefined,
                            addToTimeline: flags['no-add'] ? false : undefined,
                        }),
                    });
                    if (res.ok) {
                        await journal.record({ file: entry.file, sha256: hash, status: 'ingested', destPath: copyDest ? ingestPath : undefined, at: new Date().toISOString() });
                        results.set(entry.file, { file: entry.file, ok: true });
                    }
                    else {
                        await journal.record({ file: entry.file, sha256: hash, status: 'failed', stage, destPath: copyDest ? ingestPath : undefined, error: res.error, at: new Date().toISOString() });
                        results.set(entry.file, { file: entry.file, ok: false, stage, error: res.error });
                    }
                }
                catch (error) {
                    const message = error?.message ?? String(error);
                    await journal.record({
                        file: entry.file,
                        sha256: hash,
                        status: 'failed',
                        stage,
                        destPath: copyDest && ingestPath !== entry.file ? ingestPath : undefined,
                        error: message,
                        at: new Date().toISOString(),
                    });
                    results.set(entry.file, { file: entry.file, ok: false, stage, error: message });
                }
            });
            // runPool waits for every peer even when a worker rejects unexpectedly.
            // Most errors are caught above with a precise stage; this is the final
            // guard for e.g. a journal write failure inside that catch path.
            for (const failure of workerFailures) {
                const entry = failure.item;
                if (results.has(entry.file))
                    continue;
                const error = failure.error instanceof Error ? failure.error.message : String(failure.error);
                try {
                    await journal.record({ file: entry.file, sha256: fileHashes.get(entry.file), status: 'failed', stage: 'worker', error, at: new Date().toISOString() });
                }
                catch (journalError) {
                    console.error(`journal write also failed for ${entry.file}: ${journalError?.message ?? journalError}`);
                }
                results.set(entry.file, { file: entry.file, ok: false, stage: 'worker', error });
            }
            const settledResults = targets.map((entry) => results.get(entry.file)).filter(Boolean);
            const failures = [
                ...preflightFailures,
                ...settledResults.filter((r) => !r.ok).map((r) => ({ file: r.file, stage: r.stage, error: r.error })),
            ];
            return out({
                ingested: settledResults.filter((r) => r.ok).length,
                failed: failures,
                skippedDuplicates: skippedDuplicates.map((d) => ({ file: d.file, kind: d.kind, duplicateOf: d.duplicateOf })),
                skippedAlreadyIngested: resumeSkipped,
                reprocessedChangedFiles,
                journal: journalPath(dir),
                hint: failures.length > 0 ? '失敗したファイルはstageごとに隔離されました。同じコマンドの再実行で失敗分だけ再試行できます(同一bytesの完了済みはスキップ)' : undefined,
            });
        }
        case 'transcribe': {
            // W-LAZY: explicit, asynchronous transcription — decoupled from
            // ingest (see ingestFile's `transcribe` default of false). The daemon
            // starts a background job and returns immediately; progress/
            // completion arrive over the websocket (transcribe-progress /
            // transcribe-done / transcribe-error) and via `vedit status`'s
            // per-source transcribing/transcribed fields — this command does not
            // block until the job finishes.
            const target = pos[0] ?? fail('usage: vedit transcribe <sourceId|all> [--language ja] [--glossary "語1,語2,..."]');
            const dir = projectDir();
            // 用語集(roadmap "whisper 用語集プロンプト"): --glossary が明示され
            // ればそれを使い、manifest へ保存して以後の transcribe にも自動適用
            // (setTranscriptionGlossary, core/ops.ts)。省略時は manifest に既に
            // 保存されている用語集を読んで、そのまま今回にも適用する。
            const explicitGlossary = flags.glossary !== undefined
                ? String(flags.glossary).split(',').map((s) => s.trim()).filter(Boolean)
                : undefined;
            let glossary = explicitGlossary;
            if (glossary === undefined) {
                try {
                    const p0 = await Project.open(dir);
                    glossary = (await p0.manifest()).transcription?.glossary;
                }
                catch { /* project not open yet — nothing stored to fall back to */ }
            }
            await ensureDaemon(dir);
            const glossaryState = explicitGlossary !== undefined ? await api('/api/state') : undefined;
            const res = await api('/api/transcribe', {
                method: 'POST',
                body: JSON.stringify({
                    sourceId: target,
                    language: flags.language,
                    // Omitted means "reuse the stored glossary"; sending the resolved
                    // value here used to manufacture a no-op revision on every run.
                    glossary: explicitGlossary,
                    ...(glossaryState
                        ? { actor: flags.actor ?? 'agent', baseRev: glossaryState.revision }
                        : {}),
                }),
            });
            return out({
                ...res,
                glossary: glossary ?? [],
                hint: res.started?.length
                    ? '裏で実行中。完了は `vedit status` の sources[].transcribed、または web の存在感ストリップで確認できる'
                    : '対象なし(既に文字起こし済み、または全て実行中)',
            });
        }
        case 'transcribe-cancel': {
            const target = pos[0] ?? fail('usage: vedit transcribe-cancel <taskId|sourceId>');
            const dir = projectDir();
            await ensureDaemon(dir);
            const listed = await api('/api/transcribe-jobs');
            const job = (listed.jobs ?? []).find((candidate) => ((candidate.taskId === target || candidate.sourceId === target)
                && (candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'cancelling')));
            if (!job)
                fail(`no running transcribe job for ${target}`);
            const res = await api(`/api/transcribe-jobs/${encodeURIComponent(job.taskId)}`, { method: 'DELETE' });
            return out({ ...res, hint: '中止処理を開始しました。子プロセス終了と一時ファイル削除後に status=cancelled になります' });
        }
        case 'transcript': {
            const dir = projectDir();
            await ensureDaemon(dir);
            const q = new URLSearchParams();
            if (flags.full)
                q.set('full', '1');
            if (flags.source)
                q.set('source', String(flags.source));
            const res = await fetch(`${BASE}/api/transcript?${q}`);
            if (!res.ok)
                fail(await res.text());
            return console.log(await res.text());
        }
        case 'detect': {
            const dir = projectDir();
            await ensureDaemon(dir);
            const res = await api('/api/detect', {
                method: 'POST',
                body: JSON.stringify({
                    minGap: numFlag('min-gap', flags['min-gap']),
                    threshold: numFlag('threshold', flags.threshold),
                    fillers: flags['no-fillers'] ? false : undefined,
                    silence: flags['no-silence'] ? false : undefined,
                }),
            });
            return out(res);
        }
        case 'first-draft': {
            const dir = projectDir();
            await ensureDaemon(dir);
            const state = await api('/api/state');
            // Detection does not advance the manifest revision. The subsequent
            // first-draft POST revalidates this exact baseRev and applies every
            // independently corroborated cut as one undoable AI revision.
            const detected = await api('/api/detect', {
                method: 'POST',
                body: JSON.stringify({
                    minGap: numFlag('min-gap', flags['min-gap']),
                    threshold: numFlag('threshold', flags.threshold),
                    fillers: flags['no-fillers'] ? false : undefined,
                    silence: flags['no-silence'] ? false : undefined,
                }),
            });
            const draft = await api('/api/first-draft', {
                method: 'POST',
                body: JSON.stringify({ actor: flags.actor ?? 'agent', baseRev: state.revision }),
            });
            return out(summarizeFirstDraftForCli(draft, detected));
        }
        case 'candidates': {
            const dir = projectDir();
            await ensureDaemon(dir);
            return out(await api(`/api/candidates${flags.all ? '?all=1' : ''}`));
        }
        case 'takes': {
            // Read-only: detectTakes → packTakes, straight through (see
            // core/takes.js's module doc — nothing here ever edits the manifest).
            // Reads project.json/transcript-*.json directly, no daemon required
            // (same "read-only doesn't need the daemon" pattern as `sources`/`kit`).
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            let sourceId = flags.source;
            if (!sourceId) {
                const transcribed = m.sources.filter((s) => s.transcribed);
                if (transcribed.length === 0)
                    fail('no transcribed source; run `vedit transcribe <sourceId|all>` first');
                if (transcribed.length > 1) {
                    fail(`multiple transcribed sources; specify --source (${transcribed.map((s) => s.id).join(', ')})`);
                }
                sourceId = transcribed[0].id;
            }
            else if (!m.sources.some((s) => s.id === sourceId && s.transcribed)) {
                fail(`source has no transcript: ${sourceId}`);
            }
            const t = await p.transcript(sourceId);
            return out(packTakes(detectTakes(t)));
        }
        case 'sources': {
            // Read-only project inventory; reads project.json directly like
            // `view`/`export` rather than going through the daemon.
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const used = new Map();
            for (const s of segments(m))
                used.set(s.sourceId, (used.get(s.sourceId) ?? 0) + (s.tlEnd - s.tlStart));
            return out(m.sources.map((s) => ({
                id: s.id,
                file: path.basename(s.path),
                duration: s.duration,
                transcribed: !!s.transcribed,
                usedSeconds: used.get(s.id) ?? 0,
            })));
        }
        case 'approve':
        case 'reject': {
            const dir = projectDir();
            await ensureDaemon(dir);
            const state = await api('/api/state');
            const ids = pos[0] === 'all' ? 'all' : pos;
            if (!ids || (Array.isArray(ids) && ids.length === 0))
                fail(`usage: vedit ${cmd} <candidateId...|all>`);
            const res = await api('/api/candidates/decide', {
                method: 'POST',
                body: JSON.stringify({ ids, decision: cmd === 'approve' ? 'approve' : 'reject', actor: flags.actor ?? 'agent', baseRev: baseRevOf(state) }),
            });
            return out({ ...res, hint: MUTATE_HINT });
        }
        case 'remove-words':
            if (pos.length === 0)
                fail('usage: vedit remove-words <w12 w40..w52 ...>');
            return edit({ op: 'remove-words', ids: pos, sourceId: flags.source, pad: numFlag('pad', flags.pad) });
        case 'remove-range': {
            if (flags.scene) {
                if (pos.length > 0)
                    fail('--scene cannot be combined with explicit t0/t1');
                const dir = projectDir();
                const r = await resolveScene(dir, String(flags.scene), flags.source);
                return edit({ op: 'remove-range', t0: r.t0, t1: r.t1, sourceId: r.sourceId });
            }
            if (pos.length < 2)
                fail('usage: vedit remove-range <t0> <t1> [--scene id]');
            return edit({ op: 'remove-range', t0: numArg('t0', pos[0]), t1: numArg('t1', pos[1]), sourceId: flags.source });
        }
        case 'trim':
            if (pos.length < 3)
                fail('usage: vedit trim <clipId> <in|out> <±frames>');
            return edit({ op: 'trim', clipId: pos[0], edge: pos[1], frames: numArg('±frames', pos[2]) });
        case 'clip-add': {
            if (pos.length === 0 && !flags.scene)
                fail('usage: vedit clip-add <sourceId> [--in s] [--out s] [--at index] [--scene id]');
            if (flags.scene && (flags.in !== undefined || flags.out !== undefined))
                fail('--scene cannot be combined with --in/--out');
            let sourceId = pos[0];
            let inVal = numFlag('in', flags.in);
            let outVal = numFlag('out', flags.out);
            if (flags.scene) {
                const dir = projectDir();
                const r = await resolveScene(dir, String(flags.scene), sourceId);
                sourceId = r.sourceId;
                inVal = r.t0;
                outVal = r.t1;
            }
            return edit({
                op: 'clip-add',
                sourceId,
                in: inVal,
                out: outVal,
                at: numFlag('at', flags.at),
            });
        }
        case 'clip-remove':
            if (pos.length === 0)
                fail('usage: vedit clip-remove <clipId>');
            return edit({ op: 'clip-remove', clipId: pos[0] });
        case 'clip-move':
            if (pos.length === 0 || flags.before === undefined)
                fail('usage: vedit clip-move <clipId> --before <clipId|end>');
            return edit({ op: 'clip-move', clipId: pos[0], before: flags.before });
        case 'clip-audio': {
            if (pos.length === 0)
                fail('usage: vedit clip-audio <clipId> [--gain -30..12] [--mute|--no-mute] --base <rev>');
            if (flags.mute && flags['no-mute'])
                fail('--mute and --no-mute are mutually exclusive');
            const gainDb = numFlag('gain', flags.gain);
            const muted = flags.mute ? true : flags['no-mute'] ? false : undefined;
            if (gainDb === undefined && muted === undefined)
                fail('usage: vedit clip-audio <clipId> [--gain -30..12] [--mute|--no-mute] --base <rev> (at least one of --gain/--mute/--no-mute is required)');
            return edit({ op: 'clip-audio', clipId: pos[0], gainDb, muted });
        }
        case 'split': {
            if (pos.length === 0 || flags.at === undefined)
                fail('usage: vedit split <clipId> --at <tl秒> --base <rev>');
            return edit({ op: 'split', clipId: pos[0], at: numFlag('at', flags.at) });
        }
        case 'duplicate':
            if (pos.length === 0)
                fail('usage: vedit duplicate <clipId> --base <rev>');
            return edit({ op: 'duplicate', clipId: pos[0] });
        case 'scenes': {
            const sub = pos[0];
            if (sub === 'detect') {
                const dir = projectDir();
                await ensureDaemon(dir);
                const res = await api('/api/scenes/detect', {
                    method: 'POST',
                    body: JSON.stringify({
                        sourceId: flags.source,
                        sensitivity: numFlag('sensitivity', flags.sensitivity),
                        maxLen: numFlag('max-len', flags['max-len']),
                        minLen: numFlag('min-len', flags['min-len']),
                    }),
                });
                return out(res);
            }
            if (sub === 'sheet') {
                const dir = projectDir();
                const p = await Project.open(dir);
                const m = await p.manifest();
                const sourceId = flags.source ?? m.sources[0]?.id;
                if (!sourceId)
                    fail('no sources in project');
                const file = await p.scenes(sourceId);
                const v = await renderSceneSheet(file, dir, { cols: numFlag('cols', flags.cols) });
                return out({ ...v, hint: 'Read the png to inspect scene thumbnails; grid maps cells to scene ids' });
            }
            if (sub === 'note') {
                const sceneId = pos[1] ?? fail('usage: vedit scenes note <sceneId> "<text>" --by model|user [--source id]');
                const text = pos[2] ?? fail('usage: vedit scenes note <sceneId> "<text>" --by model|user [--source id]');
                const by = flags.by;
                if (by !== 'user' && by !== 'model')
                    fail('usage: vedit scenes note <sceneId> "<text>" --by model|user');
                const dir = projectDir();
                await ensureDaemon(dir);
                let sourceId = flags.source;
                if (!sourceId) {
                    const p = await Project.open(dir);
                    const m = await p.manifest();
                    for (const s of m.sources) {
                        const f = await p.scenes(s.id);
                        if (f.scenes.some((sc) => sc.id === sceneId)) {
                            sourceId = s.id;
                            break;
                        }
                    }
                    if (!sourceId)
                        fail(`scene ${sceneId} not found in any source; specify --source`);
                }
                const res = await api('/api/scenes/note', {
                    method: 'POST',
                    body: JSON.stringify({ sourceId, id: sceneId, text, by }),
                });
                return out(res);
            }
            // list (packed scene text, like `vedit transcript`)
            const dir = projectDir();
            await ensureDaemon(dir);
            const q = new URLSearchParams();
            if (flags.source)
                q.set('source', String(flags.source));
            const res = await fetch(`${BASE}/api/scenes?${q}`);
            if (!res.ok)
                fail(await res.text());
            return console.log(await res.text());
        }
        case 'review': {
            if (pos.length < 2)
                fail('usage: vedit review <sceneId...> keep|reject|clear [--source id] --base <rev>');
            const verdict = pos[pos.length - 1];
            if (verdict !== 'keep' && verdict !== 'reject' && verdict !== 'clear') {
                fail('usage: vedit review <sceneId...> keep|reject|clear [--source id] --base <rev>');
            }
            const sceneIds = pos.slice(0, -1);
            const dir = projectDir();
            let sourceId = flags.source;
            if (!sourceId) {
                const p = await Project.open(dir);
                const m = await p.manifest();
                for (const s of m.sources) {
                    const f = await p.scenes(s.id);
                    if (sceneIds.every((id) => f.scenes.some((sc) => sc.id === id))) {
                        sourceId = s.id;
                        break;
                    }
                }
                if (!sourceId)
                    fail(`scene(s) ${sceneIds.join(',')} not found together in any single source; specify --source`);
            }
            return edit({ op: 'scene-review', sourceId, sceneIds, review: verdict });
        }
        case 'review-status': {
            const dir = projectDir();
            await ensureDaemon(dir);
            return out(await api('/api/review-status'));
        }
        case 'selects': {
            const raw = !!flags.raw;
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const sceneFiles = [];
            for (const s of m.sources) {
                const f = await p.scenes(s.id);
                if (f.scenes.length)
                    sceneFiles.push(f);
            }
            const newVideo = buildSelectsTimeline(m, sceneFiles, raw ? { raw: true } : undefined);
            const { keepScenes, preservedScenes, newScenes } = newVideo.summary;
            const summaryLine = raw
                ? `keep ${keepScenes}シーン → クリップ${newVideo.length}個(--raw: シーン範囲でそのまま置換、微修正は保持しません)`
                : `keep ${keepScenes}シーン → クリップ${newVideo.length}個(微修正${preservedScenes}件を保持、${newScenes}シーンを新規追加)`;
            const preview = {
                currentClips: m.timeline.video.length,
                currentDuration: Number(timelineDuration(m).toFixed(2)),
                newClips: newVideo.length,
                newDuration: Number(newVideo.reduce((sum, c) => sum + (c.srcOut - c.srcIn), 0).toFixed(2)),
                keepScenes,
                preservedScenes,
                newScenes,
                raw,
                summary: summaryLine,
            };
            if (!flags.confirm) {
                return out({
                    ...preview,
                    applied: false,
                    hint: 'プレビューのみ(タイムラインは未変更)。適用するには --confirm を付けて再実行してください',
                });
            }
            await ensureDaemon(dir);
            const state = await api('/api/state');
            const res = await api('/api/edit', {
                method: 'POST',
                body: JSON.stringify({ baseRev: baseRevOf(state), actor: flags.actor ?? 'agent', op: 'selects', raw }),
            });
            return out({ ...res, ...preview, applied: true, hint: MUTATE_HINT });
        }
        case 'reframe': {
            if (pos.length === 0)
                fail('usage: vedit reframe <9:16|1:1|16:9|WxH> [--focus left|center|right|0..1]');
            // kit defaults.reframe_focus (W8): consulted only when --focus is
            // omitted AND a kit is linked — never overrides an explicit flag. No
            // manifest field stores this (unlike defaults.captions_style, applied
            // once at kit-link time), so it's re-consulted on every reframe call.
            let focus = flags.focus;
            if (focus === undefined) {
                const dir = projectDir();
                const p = await Project.open(dir);
                const m = await p.manifest();
                if (m.kit) {
                    try {
                        const kit = await readKitFile(m.kit.path);
                        if (kit.defaults?.reframe_focus)
                            focus = kit.defaults.reframe_focus;
                    }
                    catch { /* kit unreadable — fall back to reframe's own default (center) */ }
                }
            }
            return edit({ op: 'reframe', spec: pos[0], focus });
        }
        case 'clip-crop':
            if (pos.length === 0)
                fail('usage: vedit clip-crop <clipId> [--x 0..1] [--y 0..1]');
            return edit({
                op: 'clip-crop',
                clipId: pos[0],
                x: numFlag('x', flags.x),
                y: numFlag('y', flags.y),
            });
        case 'captions': {
            const patch = {};
            if (flags.enabled !== undefined)
                patch.enabled = flags.enabled === 'true' || flags.enabled === true;
            if (flags.style)
                patch.style = flags.style;
            if (flags['max-chars'])
                patch.maxChars = numFlag('max-chars', flags['max-chars']);
            // W-CAP: style overrides, layered on top of `style` (see
            // CaptionSettings.overrides in types.ts) — same `captions` patch op,
            // merged server-side onto whatever's already set (see
            // mergeCaptionOverrides in daemon.ts), so e.g. `--size-scale 1.2` on
            // its own never drops a previously-set `--font`.
            const overrides = {};
            if (flags.font)
                overrides.font = flags.font;
            if (flags['size-scale'] !== undefined)
                overrides.sizeScale = numFlag('size-scale', flags['size-scale']);
            if (flags['outline-width'] !== undefined)
                overrides.outlineWidth = numFlag('outline-width', flags['outline-width']);
            if (flags['bg-opacity'] !== undefined)
                overrides.bgOpacity = numFlag('bg-opacity', flags['bg-opacity']);
            const palette = {};
            if (flags['text-color'])
                palette.text = flags['text-color'];
            if (flags['outline-color'])
                palette.outline = flags['outline-color'];
            if (flags['box-color'])
                palette.box = flags['box-color'];
            if (Object.keys(palette).length)
                overrides.palette = palette;
            if (flags['position-v'] !== undefined)
                overrides.position = { v: numFlag('position-v', flags['position-v']) };
            if (Object.keys(overrides).length)
                patch.overrides = overrides;
            if (Object.keys(patch).length === 0) {
                const dir = projectDir();
                await ensureDaemon(dir);
                return out(await api('/api/captions'));
            }
            return edit({ op: 'captions', patch });
        }
        case 'caption-text': {
            const USAGE = 'usage: vedit caption-text <sourceId:wordId> "新テキスト" --base <rev> (or --clear)';
            const key = pos[0] ?? fail(USAGE);
            if (flags.clear)
                return edit({ op: 'caption-text', key, text: null });
            if (pos.length < 2)
                fail(USAGE);
            return edit({ op: 'caption-text', key, text: pos[1] });
        }
        case 'fonts': {
            const dir = projectDir();
            await ensureDaemon(dir);
            return out(await api('/api/fonts'));
        }
        case 'motion-add': {
            const type = flags.type ?? 'chapter-card';
            const params = {};
            for (const k of ['text', 'subtitle', 'palette', 'position', 'animation'])
                if (flags[k])
                    params[k] = flags[k];
            return edit({
                op: 'motion-add',
                spec: { type, params, html: flags.html },
                tlStart: numFlag('at', flags.at) ?? 0,
                duration: numFlag('duration', flags.duration) ?? 4,
            });
        }
        case 'motion-update': {
            const params = {};
            for (const k of ['text', 'subtitle', 'palette', 'position', 'animation'])
                if (flags[k])
                    params[k] = flags[k];
            return edit({
                op: 'motion-update',
                id: pos[0] ?? fail('usage: vedit motion-update <id> [--text ...]'),
                spec: Object.keys(params).length ? { params } : undefined,
                tlStart: numFlag('at', flags.at),
                duration: numFlag('duration', flags.duration),
            });
        }
        case 'motion-remove':
            return edit({ op: 'motion-remove', id: pos[0] ?? fail('usage: vedit motion-remove <id>') });
        case 'music-add': {
            if (pos.length === 0) {
                fail('usage: vedit music-add <file> [--at 0] [--duration N] [--src-in 0] [--gain -12] [--fade-in 1] [--fade-out 2] [--no-duck] [--sfx]');
            }
            // --sfx (SE 糖衣): one-shot sound-effect defaults — no speech ducking
            // and 0.03s click-guard micro-fades instead of the BGM-ish 1s/2s —
            // plus a role:'sfx' tag on the item. Every explicitly-passed flag
            // (--fade-in/--fade-out/--no-duck/--gain/...) still wins over the
            // sugar, same precedence rule as kit defaults vs explicit flags.
            const sfx = Boolean(flags.sfx);
            return edit({
                op: 'music-add',
                path: path.resolve(pos[0]),
                tlStart: numFlag('at', flags.at),
                duration: numFlag('duration', flags.duration),
                srcIn: numFlag('src-in', flags['src-in']),
                gain: numFlag('gain', flags.gain),
                fadeIn: numFlag('fade-in', flags['fade-in']) ?? (sfx ? 0.03 : undefined),
                fadeOut: numFlag('fade-out', flags['fade-out']) ?? (sfx ? 0.03 : undefined),
                duck: flags['no-duck'] ? false : sfx ? false : undefined,
                ...(sfx ? { role: 'sfx' } : {}),
            });
        }
        case 'music-update': {
            const id = pos[0] ?? fail('usage: vedit music-update <id> [--at ...] [--duration ...] [--src-in ...] [--gain ...] [--fade-in ...] [--fade-out ...] [--no-duck]');
            return edit({
                op: 'music-update',
                id,
                tlStart: numFlag('at', flags.at),
                duration: numFlag('duration', flags.duration),
                srcIn: numFlag('src-in', flags['src-in']),
                gain: numFlag('gain', flags.gain),
                fadeIn: numFlag('fade-in', flags['fade-in']),
                fadeOut: numFlag('fade-out', flags['fade-out']),
                duck: flags['no-duck'] ? false : undefined,
            });
        }
        case 'music-remove':
            return edit({ op: 'music-remove', id: pos[0] ?? fail('usage: vedit music-remove <id>') });
        case 'audio-mix':
            return edit({
                op: 'audio-mix',
                targetLufs: numFlag('target-lufs', flags['target-lufs']),
                duckAmount: numFlag('duck-amount', flags['duck-amount']),
                crossfadeMs: numFlag('crossfade-ms', flags['crossfade-ms']),
            });
        case 'audio-repair': {
            const preset = flags.preset;
            if (!preset || !['outdoor', 'indoor', 'wireless', 'off'].includes(preset)) {
                fail('usage: vedit audio-repair --preset outdoor|indoor|wireless|off [--deess] --base <rev>');
            }
            return edit({ op: 'audio-repair', preset, deess: flags.deess ? true : undefined });
        }
        case 'color': {
            const USAGE = 'usage: vedit color --source <id> --type hlg|pq|lut|none [--lut path] --base <rev>';
            const sourceId = flags.source;
            const type = flags.type;
            if (!sourceId || !type)
                fail(USAGE);
            if (!['hlg', 'pq', 'lut', 'none'].includes(type))
                fail(USAGE);
            if (type === 'lut' && !flags.lut)
                fail(`--lut <path> is required when --type lut\n${USAGE}`);
            console.error('色変換を設定し、プロキシを再生成しています(時間がかかることがあります)...');
            return edit({
                op: 'color-transform',
                sourceId,
                type,
                lut: flags.lut ? path.resolve(String(flags.lut)) : undefined,
            });
        }
        case 'color-adjust': {
            const sourceId = flags.source;
            if (!sourceId)
                fail('usage: vedit color-adjust --source <id> [--exposure -2..2] [--wb -100..100] [--sat 0..2] --base <rev>');
            return edit({
                op: 'color-adjust',
                sourceId,
                exposure: numFlag('exposure', flags.exposure),
                wb: numFlag('wb', flags.wb),
                sat: numFlag('sat', flags.sat),
            });
        }
        case 'color-match': {
            if (pos.length < 2)
                fail('usage: vedit color-match <基準sourceId> <対象sourceId...>');
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const [baseId, ...targetIds] = pos;
            const result = await proposeColorMatch(m, dir, baseId, targetIds);
            return out({
                ...result,
                applied: false,
                hint: '提案値は未適用です。承認後 `vedit color-adjust --source <id> --exposure .. --wb .. --sat ..` で反映してください',
            });
        }
        case 'broll-add': {
            const USAGE = 'usage: vedit broll-add <brollSourceId> [--in s --out s | --scene sX] ' +
                '(--at-word wXXXX [--source aRollSrc] | --at-src aRollSrc t | --at-tl t) ' +
                '[--audio mute|mix|replace] [--gain -18] --base <rev>';
            if (pos.length === 0)
                fail(USAGE);
            const brollSourceId = pos[0];
            if (flags.scene && (flags.in !== undefined || flags.out !== undefined))
                fail('--scene cannot be combined with --in/--out');
            const dir = projectDir();
            let inVal = numFlag('in', flags.in);
            let outVal = numFlag('out', flags.out);
            if (flags.scene) {
                const r = await resolveScene(dir, String(flags.scene), brollSourceId);
                inVal = r.t0;
                outVal = r.t1;
            }
            if (inVal === undefined || outVal === undefined)
                fail(`broll-add requires --in/--out or --scene\n${USAGE}`);
            const anchor = await resolveAnchorFlags(dir);
            if (!anchor)
                fail(`broll-add requires an anchor: --at-word / --at-src / --at-tl\n${USAGE}`);
            return edit({
                op: 'broll-add',
                sourceId: brollSourceId,
                in: inVal,
                out: outVal,
                anchor,
                audioMode: flags.audio,
                gainDb: numFlag('gain', flags.gain),
            });
        }
        case 'broll-update': {
            const id = pos[0] ?? fail('usage: vedit broll-update <id> [--in s --out s | --scene sX] [--at-word .. | --at-src .. | --at-tl ..] [--audio mute|mix|replace] [--gain -18] --base <rev>');
            if (flags.scene && (flags.in !== undefined || flags.out !== undefined))
                fail('--scene cannot be combined with --in/--out');
            const dir = projectDir();
            let inVal = numFlag('in', flags.in);
            let outVal = numFlag('out', flags.out);
            if (flags.scene) {
                const p = await Project.open(dir);
                const m = await p.manifest();
                const ov = (m.timeline.overlays ?? []).find((o) => o.id === id);
                if (!ov)
                    fail(`unknown overlay: ${id}`);
                const r = await resolveScene(dir, String(flags.scene), ov.sourceId);
                inVal = r.t0;
                outVal = r.t1;
            }
            const anchor = await resolveAnchorFlags(dir);
            return edit({
                op: 'broll-update',
                id,
                in: inVal,
                out: outVal,
                anchor,
                audioMode: flags.audio,
                gainDb: numFlag('gain', flags.gain),
            });
        }
        case 'broll-remove':
            return edit({ op: 'broll-remove', id: pos[0] ?? fail('usage: vedit broll-remove <id>') });
        // ---- overlay stack (オーバーレイ・スタック): generalizes broll-add/
        // -update/-remove above into N layers + image sources + rect/opacity/
        // fade. broll-add/-update/-remove are UNCHANGED and keep working
        // exactly as before (they always produce/target layer-1 overlays,
        // "layer 1 の別名") — use these new commands when you need more than
        // one overlay on screen at once, or a still-image overlay. See
        // docs/superpowers/specs/2026-07-18-vedit-overlay-stack.md.
        case 'overlay-add': {
            const USAGE = 'usage: vedit overlay-add <sourceId|画像ファイル> --at <アンカー> [--dur s | --in s --out s | --scene sX] ' +
                '[--rect x,y,w] [--layer N] [--opacity 0..1] [--fade-in s] [--fade-out s] ' +
                '[--audio mute|mix|replace] [--gain -18] --base <rev>';
            if (pos.length === 0)
                fail(USAGE);
            const firstArg = pos[0];
            if (flags.scene && (flags.in !== undefined || flags.out !== undefined || flags.dur !== undefined)) {
                fail(`--scene cannot be combined with --in/--out/--dur\n${USAGE}`);
            }
            if (flags.dur !== undefined && (flags.in !== undefined || flags.out !== undefined)) {
                fail(`--dur cannot be combined with --in/--out\n${USAGE}`);
            }
            const dir = projectDir();
            await ensureDaemon(dir);
            // ファイル指定時、既知の source id でなければ拡張子が画像
            // (png/jpg/jpeg/webp) かつ実在するファイルなら自動 ingest してから
            // 配置する(kind:'image' — see ingestImageFile in src/ingest/ingest.ts).
            // 既知の source id、または画像以外のファイルパスはそのまま sourceId
            // として渡す(既存の broll-add と同じ「typo は addOverlay 側の
            // "unknown B-roll source" で失敗する」規約)。
            let sourceId = firstArg;
            const p0 = await Project.open(dir);
            const m0 = await p0.manifest();
            const isKnownSource = m0.sources.some((s) => s.id === firstArg);
            if (!isKnownSource && isImageFile(firstArg) && existsSync(path.resolve(firstArg))) {
                const abs = path.resolve(firstArg);
                console.error(`画像 ${path.basename(abs)} を自動 ingest します(kind:'image')...`);
                const ingestRes = await api('/api/ingest', { method: 'POST', body: JSON.stringify({ file: abs }) });
                sourceId = ingestRes.source.id;
            }
            let inVal = numFlag('in', flags.in);
            let outVal = numFlag('out', flags.out);
            if (flags.scene) {
                const r = await resolveScene(dir, String(flags.scene), sourceId);
                inVal = r.t0;
                outVal = r.t1;
            }
            else if (flags.dur !== undefined) {
                const dur = numFlag('dur', flags.dur);
                inVal = 0;
                outVal = dur;
            }
            if (inVal === undefined || outVal === undefined)
                fail(`overlay-add requires --dur, --in/--out, or --scene\n${USAGE}`);
            const anchor = await resolveAnchorFlags(dir);
            if (!anchor)
                fail(`overlay-add requires an anchor: --at / --at-word / --at-src / --at-tl\n${USAGE}`);
            return edit({
                op: 'overlay-add',
                sourceId,
                in: inVal,
                out: outVal,
                anchor,
                audioMode: flags.audio,
                gainDb: numFlag('gain', flags.gain),
                layer: numFlag('layer', flags.layer),
                rect: flags.rect !== undefined ? parseOverlayRectFlag(String(flags.rect)) : undefined,
                opacity: numFlag('opacity', flags.opacity),
                fade: overlayFadeFromFlags(),
            });
        }
        case 'overlay-update': {
            const USAGE = 'usage: vedit overlay-update <id> [--dur s | --in s --out s | --scene sX] ' +
                '[--at / --at-word / --at-src / --at-tl] [--rect x,y,w | --no-rect] [--layer N] [--opacity 0..1] ' +
                '[--fade-in s] [--fade-out s | --no-fade] [--audio mute|mix|replace] [--gain -18] --base <rev>';
            const id = pos[0] ?? fail(USAGE);
            if (flags.scene && (flags.in !== undefined || flags.out !== undefined || flags.dur !== undefined)) {
                fail(`--scene cannot be combined with --in/--out/--dur\n${USAGE}`);
            }
            if (flags.dur !== undefined && (flags.in !== undefined || flags.out !== undefined)) {
                fail(`--dur cannot be combined with --in/--out\n${USAGE}`);
            }
            if (flags.rect !== undefined && flags['no-rect'])
                fail(`--rect and --no-rect are mutually exclusive\n${USAGE}`);
            const dir = projectDir();
            let inVal = numFlag('in', flags.in);
            let outVal = numFlag('out', flags.out);
            if (flags.scene) {
                const p = await Project.open(dir);
                const m = await p.manifest();
                const ov = (m.timeline.overlays ?? []).find((o) => o.id === id);
                if (!ov)
                    fail(`unknown overlay: ${id}`);
                const r = await resolveScene(dir, String(flags.scene), ov.sourceId);
                inVal = r.t0;
                outVal = r.t1;
            }
            else if (flags.dur !== undefined) {
                const dur = numFlag('dur', flags.dur);
                inVal = 0;
                outVal = dur;
            }
            const anchor = await resolveAnchorFlags(dir);
            const fade = flags['no-fade'] ? null : overlayFadeFromFlags();
            return edit({
                op: 'overlay-update',
                id,
                in: inVal,
                out: outVal,
                anchor,
                audioMode: flags.audio,
                gainDb: numFlag('gain', flags.gain),
                layer: numFlag('layer', flags.layer),
                rect: flags['no-rect'] ? null : flags.rect !== undefined ? parseOverlayRectFlag(String(flags.rect)) : undefined,
                opacity: numFlag('opacity', flags.opacity),
                fade,
            });
        }
        case 'overlay-remove':
            return edit({ op: 'overlay-remove', id: pos[0] ?? fail('usage: vedit overlay-remove <id> --base <rev>') });
        case 'intent-add': {
            const USAGE = 'usage: vedit intent-add <sourceId> <t0> <t1> --label "余韻" [--kind quiet|hold] --base <rev>';
            if (pos.length < 3)
                fail(USAGE);
            const kind = flags.kind;
            if (kind !== undefined && kind !== 'quiet' && kind !== 'hold')
                fail(`--kind must be "quiet" or "hold"\n${USAGE}`);
            if (!flags.label)
                fail(`--label は必須です\n${USAGE}`);
            return edit({
                op: 'intent-add',
                sourceId: pos[0],
                t0: numArg('t0', pos[1]),
                t1: numArg('t1', pos[2]),
                label: flags.label,
                kind,
            });
        }
        case 'intent-remove':
            return edit({ op: 'intent-remove', id: pos[0] ?? fail('usage: vedit intent-remove <id> --base <rev>') });
        case 'kit-init': {
            const dir = path.resolve(pos[0] ?? fail('usage: vedit kit-init <dir> [--name n]'));
            const name = flags.name ?? path.basename(dir);
            const result = await scaffoldKit(dir, name);
            return out({
                ok: true, dir, ...result,
                hint: `assets/{characters,backgrounds,props} にPNGを置いて \`vedit kit-scan ${dir}\`、その後 \`vedit kit-link ${dir} --base <rev>\``,
            });
        }
        case 'kit-link':
            return edit({ op: 'kit-link', path: path.resolve(pos[0] ?? fail('usage: vedit kit-link <dir> --base <rev>')) });
        case 'kit-unlink':
            return edit({ op: 'kit-unlink' });
        case 'kit': {
            // Read-only display — reads project.json + kit.json directly, like
            // `resume`/`sources`, no daemon required.
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            if (!m.kit) {
                return out({ linked: false, hint: 'キット未リンク — `vedit kit-init <dir>` → `vedit kit-link <dir> --base <rev>`' });
            }
            let kit;
            try {
                kit = await readKitFile(m.kit.path);
            }
            catch (e) {
                return out({ linked: true, path: m.kit.path, error: e?.message ?? String(e) });
            }
            return out({
                linked: true,
                path: m.kit.path,
                recognizedSections: recognizedKitSections(kit),
                profile: kitProfileHighlights(kit),
                styles: (kit.styles ?? []).map((s) => ({ id: s.id, label: s.label, use_for: s.use_for })),
                assetCount: (kit.assets ?? []).length,
                defaults: kit.defaults,
            });
        }
        case 'kit-scan': {
            let dir;
            if (pos[0]) {
                dir = path.resolve(pos[0]);
            }
            else {
                const projDir = projectDir();
                const p = await Project.open(projDir);
                const m = await p.manifest();
                if (!m.kit)
                    fail('usage: vedit kit-scan <dir> (or link a kit first: `vedit kit-link <dir> --base <rev>`)');
                dir = m.kit.path;
            }
            const kit = await readKitFile(dir);
            const result = await scanKit(dir, kit, { force: Boolean(flags.force) });
            await writeKitFile(dir, result.kit);
            return out({
                ok: true, dir,
                added: result.added, scanned: result.scanned, skipped: result.skipped,
                ...(result.warnings.length ? { warnings: result.warnings } : {}),
            });
        }
        case 'kit-assets': {
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            if (!m.kit)
                fail('no kit linked; run `vedit kit-link <dir> --base <rev>` first');
            const kit = await readKitFile(m.kit.path);
            const results = searchKitAssets(kit.assets, {
                tag: flags.tag,
                emotion: flags.emotion,
            });
            return out(packKitAssets(results));
        }
        case 'sprite-add': {
            const USAGE = 'usage: vedit sprite-add <assetId> (--at t [composition] | --at-word wXXXX [--source aRollSrc] | --at-src aRollSrc t | --at-tl t) ' +
                '[--pos x,y] [--scale 0..1] [--opacity 0..1] [--duration s] [--flip] ' +
                '[--enter slide-left|slide-right|hop-in|pop|fade] [--loop sway|bob|hop|breathe|none] [--exit ...] [--emote-at "t:assetId,..."] --base <rev>';
            const assetId = pos[0] ?? fail(USAGE);
            const dir = projectDir();
            const anchor = await resolveAnchorFlags(dir);
            if (!anchor)
                fail(`sprite-add requires an anchor: --at / --at-word / --at-src / --at-tl\n${USAGE}`);
            let position;
            if (flags.pos !== undefined) {
                const [xs, ys] = String(flags.pos).split(',');
                position = { x: numArg('--pos x', xs), y: numArg('--pos y', ys) };
            }
            return edit({
                op: 'sprite-add',
                assetId,
                anchor,
                duration: numFlag('duration', flags.duration),
                position,
                scale: numFlag('scale', flags.scale),
                opacity: numFlag('opacity', flags.opacity),
                flip: flags.flip ? true : undefined,
                motion: spriteMotionFromFlags(),
            });
        }
        case 'sprite-update': {
            const id = pos[0] ??
                fail('usage: vedit sprite-update <id> [--pos x,y] [--scale ..] [--opacity ..] [--duration s] [--flip|--no-flip] ' +
                    '[--enter ..] [--loop ..] [--exit ..] [--emote-at "t:assetId,..."] [--no-motion] [anchor flags] --base <rev>');
            const dir = projectDir();
            const anchor = await resolveAnchorFlags(dir);
            let position;
            if (flags.pos !== undefined) {
                const [xs, ys] = String(flags.pos).split(',');
                position = { x: numArg('--pos x', xs), y: numArg('--pos y', ys) };
            }
            return edit({
                op: 'sprite-update',
                id,
                anchor,
                duration: numFlag('duration', flags.duration),
                position,
                scale: numFlag('scale', flags.scale),
                opacity: numFlag('opacity', flags.opacity),
                flip: flags.flip ? true : flags['no-flip'] ? false : undefined,
                motion: flags['no-motion'] ? null : spriteMotionFromFlags(),
            });
        }
        case 'sprite-remove':
            return edit({ op: 'sprite-remove', id: pos[0] ?? fail('usage: vedit sprite-remove <id>') });
        case 'preset-save': {
            const name = pos[0] ?? fail('usage: vedit preset-save <name> [--data \'{"k":"v"}\']');
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const extra = flags.data ? JSON.parse(String(flags.data)) : undefined;
            return out({ ok: true, preset: await savePreset(name, m.captions, extra) });
        }
        case 'preset-apply': {
            // Reuses the existing `captions` edit op — presets currently only
            // carry caption settings, so no new daemon op is needed.
            const name = pos[0] ?? fail('usage: vedit preset-apply <name>');
            const preset = await loadPreset(name);
            return edit({ op: 'captions', patch: preset.captions });
        }
        case 'preset-list':
            return out(await listPresets());
        case 'undo': {
            // Unlike other mutating commands, undo doesn't need --base/--latest —
            // it always bases itself on whatever the current revision is, since
            // "undo" inherently means "from here, go back one step". Without
            // --rev this is the LOGICAL undo (E-1): resolveUndoTarget replays the
            // revision log's shape (see core/project.ts) so repeated `vedit undo`
            // correctly walks further back each time instead of bouncing between
            // two states ("undo の undo"). `--rev N` bypasses resolution entirely
            // and jumps straight to an explicit old revision — a "manual" restore
            // (same as before this feature), which also discards any pending
            // redo, same as any other edit would.
            const dir = projectDir();
            await ensureDaemon(dir);
            const state = await api('/api/state');
            if (flags.rev !== undefined) {
                return editRaw(Number(state.revision), { op: 'restore', rev: numFlag('rev', flags.rev) });
            }
            const revs = await api('/api/revisions');
            const target = resolveUndoTarget(revs);
            return editRaw(Number(state.revision), { op: 'restore', rev: target, cause: 'undo' });
        }
        case 'redo': {
            // Mirror of undo(): only valid immediately after an undo, with
            // nothing else (no ordinary edit, no manual restore) committed since
            // — see resolveRedoTarget/core/project.ts. Always bases itself on the
            // current revision, same as undo (never needs --base).
            const dir = projectDir();
            await ensureDaemon(dir);
            const state = await api('/api/state');
            const revs = await api('/api/revisions');
            const target = resolveRedoTarget(revs);
            return editRaw(Number(state.revision), { op: 'restore', rev: target, cause: 'redo' });
        }
        case 'revisions': {
            const dir = projectDir();
            await ensureDaemon(dir);
            const revs = await api('/api/revisions');
            return out(revs.map((r) => `r${r.rev} [${r.actor}] ${r.op}: ${r.summary}`).join('\n'));
        }
        case 'compact': {
            // Maintenance command, purely local file rewrite — no daemon needed
            // (like ingest-batch's pre-daemon reads), and no --base/revision
            // bump: it's a bookkeeping pass over revisions.jsonl, not a manifest
            // edit, so it never shows up as a new revision itself.
            const dir = projectDir();
            const p = await Project.open(dir);
            const res = await p.compact({ dryRun: Boolean(flags['dry-run']) });
            return out({
                ...res,
                hint: res.dryRun
                    ? `${res.snapshotsDropped}件のスナップショットを削減見込み(${res.bytesBefore}B → ${res.bytesAfter}B)。実行するには --dry-run を外して再実行`
                    : `完了(バックアップ: ${path.join(dir, 'revisions.jsonl.bak')})`,
            });
        }
        case 'gc': {
            // 同上、daemon 不要のローカル操作。既定は dry-run(一覧+合計バイト数のみ)。
            const dir = projectDir();
            const p = await Project.open(dir);
            const res = flags.yes ? await runGc(p, { yes: true }) : await planGc(p);
            return out({
                orphans: res.orphans,
                totalBytes: res.totalBytes,
                deleted: res.deleted,
                hint: res.deleted
                    ? `${res.orphans.length}件削除しました(${res.totalBytes}B)`
                    : res.orphans.length
                        ? `孤児 ${res.orphans.length}件・計${res.totalBytes}B(dry-run)。削除するには --yes を付けて再実行`
                        : '孤児なし',
            });
        }
        case 'show': {
            const USAGE = 'usage: vedit show range <t0> <t1> | show words <w1 w5..w9 ...> [--source id] | show candidate <id> | show compare <revA> <revB> | show source <id> [--at s] | show takes <sourceId> <groupId>';
            const sub = pos[0];
            const dir = projectDir();
            await ensureDaemon(dir);
            if (sub === 'range') {
                if (pos.length < 3)
                    fail(USAGE);
                return out(await api('/api/show', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'range', tlStart: numArg('t0', pos[1]), tlEnd: numArg('t1', pos[2]) }),
                }));
            }
            if (sub === 'words') {
                const ids = pos.slice(1);
                if (ids.length === 0)
                    fail(USAGE);
                return out(await api('/api/show', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'words', ids, sourceId: flags.source }),
                }));
            }
            if (sub === 'candidate') {
                const id = pos[1] ?? fail(USAGE);
                return out(await api('/api/show', { method: 'POST', body: JSON.stringify({ kind: 'candidate', id }) }));
            }
            if (sub === 'compare') {
                if (pos.length < 3)
                    fail(USAGE);
                return out(await api('/api/show', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'compare', revA: pos[1], revB: pos[2] }),
                }));
            }
            if (sub === 'source') {
                const id = pos[1] ?? fail(USAGE);
                return out(await api('/api/show', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'source', sourceId: id, at: numFlag('at', flags.at) }),
                }));
            }
            if (sub === 'takes') {
                if (pos.length < 3)
                    fail(USAGE);
                return out(await api('/api/show', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'takes', sourceId: pos[1], groupId: pos[2] }),
                }));
            }
            fail(USAGE);
            return;
        }
        case 'view': {
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            let sourceId = flags.source;
            let from = numFlag('from', flags.from);
            let to = numFlag('to', flags.to);
            let domain = flags.domain ?? 'timeline';
            if (flags.scene) {
                if (flags.from !== undefined || flags.to !== undefined)
                    fail('--scene cannot be combined with --from/--to');
                const r = await resolveScene(dir, String(flags.scene), sourceId);
                sourceId = r.sourceId;
                from = r.t0;
                to = r.t1;
                domain = 'source'; // scenes are addressed in source time (cut-away material is a valid target)
            }
            const v = await renderView(m, dir, {
                domain,
                sourceId,
                from,
                to,
                cols: numFlag('cols', flags.cols),
                rows: numFlag('rows', flags.rows),
            });
            return out({ ...v, hint: 'Read the png to inspect frames; grid maps cells to source times' });
        }
        case 'qc': {
            // Read-only (no --base): manifest-level staticChecks always run;
            // --render additionally ffmpeg-probes an already-rendered file
            // (probeRenderedFile) for black/silence/loudness/clipping — intent
            // zones (Manifest.intentZones) are mapped from source time onto that
            // render's timeline via sourceRangeToTimeline before being handed to
            // qc.ts, since qc.ts's IntentZone is deliberately timeline-domain
            // (see its doc comment) while Manifest.intentZones is source-domain.
            // A linked kit additionally gets tempoContractLite (display-only, no
            // verdict). --report writes buildQcReport's self-contained HTML.
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const transcripts = [];
            for (const s of m.sources)
                if (s.transcribed)
                    transcripts.push(await p.transcript(s.id));
            const sceneFiles = [];
            for (const s of m.sources) {
                const f = await p.scenes(s.id);
                if (f.scenes.length)
                    sceneFiles.push(f);
            }
            const candidates = await p.candidates();
            let kitProfile = null;
            let kitAssets;
            if (m.kit) {
                try {
                    const kitFile = await readKitFile(m.kit.path);
                    kitProfile = kitFile.profile ?? null;
                    kitAssets = kitFile.assets;
                }
                catch { /* kit unreadable — proceed without kitProfile/kitAssets, same degrade-not-fail convention as `vedit kit` */ }
            }
            const staticReport = await staticChecks(m, transcripts, sceneFiles, { candidates, kitProfile, kitAssets });
            let probe;
            if (flags.render) {
                const renderPath = path.resolve(String(flags.render));
                const intentZones = (m.intentZones ?? [])
                    .map((z) => {
                    const tl = sourceRangeToTimeline(m, z.sourceId, z.t0, z.t1);
                    return tl ? { t0: tl.tlStart, t1: tl.tlEnd, reason: z.label } : null;
                })
                    .filter((z) => z !== null);
                probe = await probeRenderedFile(renderPath, { intentZones, targetLufs: m.audioMix?.targetLufs });
            }
            let tempo;
            if (m.kit && kitProfile) {
                const peaksBySource = await loadPeaksBySource(p, m);
                tempo = tempoContractLite(m, kitProfile, { peaksBySource });
            }
            const result = {
                static: staticReport,
                ...(probe ? { probe } : {}),
                ...(tempo ? { tempo } : {}),
            };
            if (flags.report) {
                const reportPath = path.resolve(String(flags.report));
                const html = buildQcReport({ title: `QC Report — ${m.name}`, staticReport, probe, tempo });
                await fs.writeFile(reportPath, html);
                result.report = reportPath;
            }
            return out(result);
        }
        case 'export': {
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const kind = pos[0];
            const dest = pos[1] ?? fail('usage: vedit export <otio|render|fcp7xml|srt|ass> <outfile>');
            const transcriptsOf = async () => {
                const t = [];
                for (const s of m.sources)
                    if (s.transcribed)
                        t.push(await p.transcript(s.id));
                return t;
            };
            if (kind === 'otio') {
                try {
                    await writeOtio(m, path.resolve(dest));
                    // OTIO has no cue-list concept, so captions would silently vanish on
                    // import; write a sidecar .srt next to it so Resolve/Premiere still
                    // get the subtitles.
                    const parsed = path.parse(path.resolve(dest));
                    const srtPath = path.join(parsed.dir, parsed.name + '.srt');
                    await writeSrt(m, await transcriptsOf(), srtPath);
                    const warnings = [];
                    if (hasReframe(m)) {
                        const w = 'Resolve 側でリフレームは再現されません(メタデータとして記録)';
                        console.error(w);
                        warnings.push(w);
                    }
                    if (hasOverlayTransform(m)) {
                        const w = 'オーバーレイの位置/不透明度/フェードは再現されません(メタデータとして記録)';
                        console.error(w);
                        warnings.push(w);
                    }
                    await recordExportResult(dir, { kind: 'otio', file: dest, ok: true, revision: m.revision, ...(warnings.length ? { warnings } : {}) });
                    return out({
                        ok: true,
                        file: dest,
                        srt: srtPath,
                        hint: 'DaVinci Resolve: File > Import > Timeline (18.5+, free version OK). 字幕は File > Import > Subtitle で .srt を読み込んでください',
                    });
                }
                catch (e) {
                    await recordExportResult(dir, { kind: 'otio', file: dest, ok: false, revision: m.revision, error: e?.message ?? String(e) });
                    throw e;
                }
            }
            if (kind === 'render') {
                // One optimistic-lock checked capture owns every mutable render input.
                // If an edit lands between the manifest read above and this call, fail
                // stale instead of combining an old timeline with newer transcript or
                // motion sidecars.
                const inputs = await p.captureRenderInputs(m.revision);
                const renderManifest = inputs.manifest;
                const capturedMotionSpecs = renderManifest.timeline.motion.length > 0
                    ? inputs.motionSpecs
                    : undefined;
                let presetRaw = flags.preset;
                // kit defaults.export_preset (W8): consulted only when --preset is
                // omitted AND a kit is linked — never overrides an explicit flag.
                if (presetRaw === undefined && renderManifest.kit) {
                    try {
                        const kit = await readKitFile(renderManifest.kit.path);
                        if (kit.defaults?.export_preset)
                            presetRaw = kit.defaults.export_preset;
                    }
                    catch { /* kit unreadable — fall back to no preset */ }
                }
                if (presetRaw !== undefined && !['youtube', 'shorts', 'x'].includes(presetRaw)) {
                    fail(`unknown --preset: ${presetRaw} (use youtube, shorts, or x)`);
                }
                // 範囲下見レンダー(roadmap "範囲指定の下見レンダー"): 既存パイプ
                // ラインをタイムライン範囲 [a,b) に制約するだけ(sliceTimelineRange,
                // core/ops.ts)で、音・色・字幕の変更を数秒で A/B できる。下見品質
                // (720p級/veryfast/1-passloudnorm)固定 — --preset 等の通常書き出し
                // オプションとは独立(組み合わせ不可)。
                if (flags.range) {
                    const rangeRaw = String(flags.range);
                    const rangeMatch = /^(-?[\d.]+)\.\.(-?[\d.]+)$/.exec(rangeRaw);
                    if (!rangeMatch)
                        fail(`--range must look like "<a>..<b>" in seconds (got ${JSON.stringify(rangeRaw)})`);
                    const a = numArg('range a', rangeMatch[1]);
                    const b = numArg('range b', rangeMatch[2]);
                    console.error(`rendering range preview [${a}s..${b}s] (下見品質)...`);
                    const options = { range: rangeRaw };
                    const finalPath = path.resolve(dest);
                    const partialPath = projectRenderPartialPath(finalPath);
                    try {
                        const res = await renderRangePreview(renderManifest, inputs.transcripts, partialPath, { a, b }, {
                            noBurnCaptions: Boolean(flags['no-burn-captions']),
                            noRepair: Boolean(flags['no-repair']),
                            ...(capturedMotionSpecs ? { motionSpecs: capturedMotionSpecs } : {}),
                        });
                        await commitRenderedPartial(partialPath, finalPath);
                        await recordExportResult(dir, {
                            kind: 'render-preview', file: dest, ok: true, revision: renderManifest.revision, options,
                            warnings: res.warnings,
                        });
                        return out({ ok: true, file: dest, range: res.range, warnings: res.warnings });
                    }
                    catch (e) {
                        await recordExportResult(dir, { kind: 'render-preview', file: dest, ok: false, revision: renderManifest.revision, options, error: e?.message ?? String(e) });
                        throw e;
                    }
                    finally {
                        await fs.rm(partialPath, { force: true }).catch(() => { });
                    }
                }
                if (renderManifest.composition) {
                    console.error('rendering composition (background + sprites + dialogue)...');
                }
                else {
                    console.error('rendering from original sources (this encodes the full timeline)...');
                }
                // Captions now burn by DEFAULT whenever captions.enabled + there's
                // something to caption — --no-burn-captions opts out (clean hand-off
                // render for an NLE/editor). --burn-captions is accepted for
                // backward compatibility but is a no-op now that burning is the
                // default; it no longer needs to be passed to opt in.
                const noBurnCaptions = Boolean(flags['no-burn-captions']);
                const noRepair = Boolean(flags['no-repair']);
                const fastLoudnorm = Boolean(flags['fast-loudnorm']);
                const res = await renderProjectMp4Atomic(p, path.resolve(dest), {
                    manifest: renderManifest,
                    transcripts: inputs.transcripts,
                    ...(capturedMotionSpecs ? { motionSpecs: capturedMotionSpecs } : {}),
                    preset: presetRaw,
                    noBurnCaptions,
                    noRepair,
                    fastLoudnorm,
                });
                if (res.captionsBurned) {
                    console.error(`字幕を焼き込み(${res.captionCueCount} cues)`);
                }
                else if (noBurnCaptions) {
                    console.error('字幕は焼き込みなし(--no-burn-captions)');
                }
                else if (!renderManifest.composition && !renderManifest.captions.enabled) {
                    console.error('字幕は焼き込みなし(captions.enabled=false)');
                }
                else if (!renderManifest.composition) {
                    console.error('字幕は焼き込みなし(cue 0件 — transcript未取得等)');
                }
                if (res.dialogueBurned) {
                    console.error(`セリフを焼き込み(${res.dialogueCount}件)`);
                }
                return out({ ok: true, file: dest, ...(res.warnings.length ? { warnings: res.warnings } : {}) });
            }
            if (kind === 'fcp7xml') {
                const otioTmp = path.resolve(dest) + '.otio';
                try {
                    await writeOtio(m, otioTmp);
                    try {
                        await run('uvx', ['--from', 'opentimelineio', '--with', 'otio-fcp-adapter', 'otioconvert', '-i', otioTmp, '-o', path.resolve(dest)]);
                    }
                    catch (e) {
                        throw new Error(`fcp7xml conversion failed (needs uv + python): ${e.message}\nThe .otio file was written to ${otioTmp}; Resolve can import it directly.`);
                    }
                    await fs.rm(otioTmp, { force: true });
                    const warnings = [];
                    if (hasReframe(m)) {
                        const w = 'Resolve 側でリフレームは再現されません(メタデータとして記録)';
                        console.error(w);
                        warnings.push(w);
                    }
                    if (hasOverlayTransform(m)) {
                        const w = 'オーバーレイの位置/不透明度/フェードは再現されません(メタデータとして記録)';
                        console.error(w);
                        warnings.push(w);
                    }
                    await recordExportResult(dir, { kind: 'fcp7xml', file: dest, ok: true, revision: m.revision, ...(warnings.length ? { warnings } : {}) });
                    return out({ ok: true, file: dest, hint: 'Premiere: File > Import (FCP7 XML)' });
                }
                catch (e) {
                    await recordExportResult(dir, { kind: 'fcp7xml', file: dest, ok: false, revision: m.revision, error: e?.message ?? String(e) });
                    fail(e?.message ?? String(e));
                }
            }
            if (kind === 'srt') {
                try {
                    await writeSrt(m, await transcriptsOf(), path.resolve(dest));
                    await recordExportResult(dir, { kind: 'srt', file: dest, ok: true, revision: m.revision });
                    return out({ ok: true, file: dest });
                }
                catch (e) {
                    await recordExportResult(dir, { kind: 'srt', file: dest, ok: false, revision: m.revision, error: e?.message ?? String(e) });
                    throw e;
                }
            }
            if (kind === 'ass') {
                try {
                    let kit = null;
                    const warnings = [];
                    if (m.kit) {
                        try {
                            kit = await readKitFile(m.kit.path);
                        }
                        catch (e) {
                            const w = `kit: ${e?.message ?? e} — キットスタイルなしで書き出します`;
                            console.error(`警告: ${w}`);
                            warnings.push(w);
                        }
                    }
                    await fs.writeFile(path.resolve(dest), toAss(m, await transcriptsOf(), kit));
                    await recordExportResult(dir, { kind: 'ass', file: dest, ok: true, revision: m.revision, ...(warnings.length ? { warnings } : {}) });
                    return out({ ok: true, file: dest });
                }
                catch (e) {
                    await recordExportResult(dir, { kind: 'ass', file: dest, ok: false, revision: m.revision, error: e?.message ?? String(e) });
                    throw e;
                }
            }
            fail(`unknown export kind: ${kind}`);
            return;
        }
        case 'publish-pack': {
            const outdir = path.resolve(pos[0] ?? fail('usage: vedit publish-pack <outdir> [--thumbs 6] [--render <file>]'));
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const transcripts = [];
            for (const s of m.sources)
                if (s.transcribed)
                    transcripts.push(await p.transcript(s.id));
            const thumbs = numFlag('thumbs', flags.thumbs) ?? 6;
            // --render: an already-rendered output file (same path.resolve pattern
            // as `vedit qc --render`) — a composition (W-ANIME) project has no
            // original source to extract thumbnails from, so publishPack pulls
            // them from this file instead; without it, thumbnail extraction is
            // skipped and thumbnailsSkipped (below) explains why.
            const renderedFile = flags.render ? path.resolve(String(flags.render)) : undefined;
            const options = { thumbs, ...(renderedFile ? { renderedFile } : {}) };
            let res;
            try {
                res = await publishPack(p, m, transcripts, outdir, { thumbs, renderedFile });
            }
            catch (e) {
                await recordExportResult(dir, { kind: 'publish-pack', file: outdir, ok: false, revision: m.revision, options, error: e?.message ?? String(e) });
                throw e;
            }
            const warnings = [res.chaptersReason, res.thumbnailsReason].filter((w) => Boolean(w));
            await recordExportResult(dir, { kind: 'publish-pack', file: outdir, ok: true, revision: m.revision, options, ...(warnings.length ? { warnings } : {}) });
            return out({
                ok: true,
                outdir,
                files: res.files,
                ...(res.chaptersReason ? { chaptersSkipped: res.chaptersReason } : {}),
                ...(res.thumbnailsReason ? { thumbnailsSkipped: res.thumbnailsReason } : {}),
                hint: 'タイトル/説明文は materials.json と transcript を材料に会話で起草する(モデル創作コピーはユーザー承認後のみ書き込む)',
            });
        }
        case 'retro': {
            const csvPath = pos[0] ?? fail('usage: vedit retro <csv> [--render-duration 秒]');
            const dir = projectDir();
            const p = await Project.open(dir);
            const m = await p.manifest();
            const csvText = await fs
                .readFile(path.resolve(csvPath), 'utf8')
                .catch((e) => fail(`retro: could not read ${csvPath}: ${e?.message ?? e}`));
            const points = parseRetentionCsv(csvText);
            const renderDurationSeconds = numFlag('render-duration', flags['render-duration']) ?? timelineDuration(m);
            const transcripts = [];
            for (const s of m.sources)
                if (s.transcribed)
                    transcripts.push(await p.transcript(s.id));
            const sceneFiles = [];
            for (const s of m.sources) {
                const f = await p.scenes(s.id);
                if (f.scenes.length)
                    sceneFiles.push(f);
            }
            // Chapter context (publish.ts's chaptersFromMotion, per the spec) —
            // reads each motion sidecar directly, same pattern publishPack itself uses.
            const motionEntries = [];
            for (const item of m.timeline.motion) {
                try {
                    const spec = (await p.readMotionSpec(item.id));
                    const text = typeof spec.params?.text === 'string' ? spec.params.text : undefined;
                    motionEntries.push({ tlStart: item.tlStart, type: spec.type, text });
                }
                catch { /* sidecar missing/unreadable; skip this overlay for chapter purposes */ }
            }
            const chapters = chaptersFromMotion(motionEntries);
            const retro = buildRetrospective(points, renderDurationSeconds, m, transcripts, sceneFiles, chapters);
            return out({ ...retro, summary: formatRetrospective(retro) });
        }
        case 'doctor': {
            const checks = {};
            for (const [bin, args] of [
                ['ffmpeg', ['-version']],
                ['ffprobe', ['-version']],
                ['whisper-cli', ['--help']],
            ]) {
                try {
                    const o = await run(bin, args);
                    checks[bin] = 'ok ' + (o.split('\n')[0]?.slice(0, 60) ?? '');
                }
                catch (e) {
                    checks[bin] = 'MISSING — ' + (bin === 'whisper-cli' ? 'brew install whisper-cpp' : `brew install ${bin === 'ffprobe' ? 'ffmpeg' : bin}`);
                }
            }
            checks['ffmpeg (resolved)'] = `${ffmpegBin()} — drawtext:${ffmpegHasFilter('drawtext') ? 'ok' : 'NO (view timecodes off)'} ass:${ffmpegHasFilter('ass') ? 'ok' : 'NO (caption burn off; brew install ffmpeg-full)'}`;
            let model = await findWhisperModel();
            if (flags['download-model']) {
                const name = typeof flags['download-model'] === 'string' ? flags['download-model'] : 'ggml-large-v3-turbo';
                console.error(`downloading ${name} ...`);
                model = await downloadWhisperModel(name);
            }
            checks['whisper model'] = model ?? 'MISSING — run `vedit doctor --download-model` (large-v3-turbo, ~1.6GB) or --download-model ggml-small (~470MB)';
            try {
                await run('uvx', ['--version']);
                checks['uv (for fcp7xml export)'] = 'ok';
            }
            catch {
                checks['uv (for fcp7xml export)'] = 'missing (optional) — brew install uv';
            }
            return out(checks);
        }
        default:
            fail(`unknown command: ${cmd}\n${HELP}`);
    }
}
main().catch((e) => fail(e?.message ?? String(e)));
