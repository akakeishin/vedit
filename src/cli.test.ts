import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from './core/project.js';
import type { Word } from './core/types.js';

/**
 * CLI output-format tests for the READ-ONLY commands added in this change
 * (`qc`, `takes`, `retro`) — spawned as real subprocesses via `tsx` (a
 * project dependency; `node` alone can't run this codebase's `.js`-suffixed
 * NodeNext imports against `.ts` source, see src/cli.ts's own
 * ensureDaemon()) rather than imported in-process, since cli.ts calls
 * `main().catch(...)` at module load time based on `process.argv` and calls
 * `process.exit()` on failure — neither is safely interceptable from inside
 * the shared vitest worker.
 *
 * Deliberately scoped to commands that never call `ensureDaemon()` (Project
 * .open() reads directly, same as `vedit sources`/`vedit kit`) — a mutating
 * command like `intent-add` would need the daemon self-spawn, which only
 * works when invoked as compiled `dist/cli.js` under plain `node` (see
 * ensureDaemon's `process.execPath` re-spawn); that wiring is covered
 * end-to-end instead via server/daemon.test.ts's in-process startDaemon().
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts');

function runCli(args: string[], env?: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(TSX_BIN, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('cli: vedit qc', () => {
  let dir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-qc-'));
    dir = path.join(root, 'proj');
    await Project.create(dir, 'qc-cli');
  });

  it('prints a StaticCheckReport (no probe/tempo) as JSON for a project with nothing to flag', () => {
    const { status, stdout, stderr } = runCli(['qc', '--project', dir]);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.static).toEqual({ issues: [], counts: { errors: 0, warnings: 0, infos: 0 } });
    expect(body.probe).toBeUndefined();
    expect(body.tempo).toBeUndefined();
    expect(body.report).toBeUndefined();
  });

  it('--report writes a self-contained HTML file and includes its path in the JSON output', () => {
    const reportPath = path.join(dir, 'qc.html');
    const { status, stdout, stderr } = runCli(['qc', '--project', dir, '--report', reportPath]);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.report).toBe(reportPath);
    expect(body.static).toBeDefined();
  });
});

describe('cli: vedit qc surfaces a missing source file', () => {
  it('reports a source-missing error for a source whose path does not exist on disk', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-qc-missing-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'qc-missing');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: path.join(root, 'nope.mp4'), duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    }));
    const { status, stdout, stderr } = runCli(['qc', '--project', dir]);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.static.issues.some((i: any) => i.category === 'source-missing')).toBe(true);
    expect(body.static.counts.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('cli: vedit takes', () => {
  it('fails with a clear error when no source is transcribed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-takes-empty-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'takes-empty');
    const { status, stderr } = runCli(['takes', '--project', dir]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/no transcribed source/);
  });

  it('prints packTakes text for a source with a detected retake group', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-takes-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'takes-cli');
    // "hello there friend" said twice, 1.5s apart -> one 2-utterance retake group.
    const words: Word[] = [
      { id: 'w0', text: 'hello', t0: 0, t1: 0.5, p: 0.9 },
      { id: 'w1', text: 'there', t0: 0.5, t1: 1.0, p: 0.9 },
      { id: 'w2', text: 'friend', t0: 1.0, t1: 1.5, p: 0.9 },
      { id: 'w3', text: 'hello', t0: 3.0, t1: 3.5, p: 0.9 },
      { id: 'w4', text: 'there', t0: 3.5, t1: 4.0, p: 0.9 },
      { id: 'w5', text: 'friend', t0: 4.0, t1: 4.5, p: 0.9 },
    ];
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
    }));
    const { status, stdout, stderr } = runCli(['takes', '--project', dir, '--source', 's1']);
    expect(status, stderr).toBe(0);
    expect(stdout).toMatch(/multi-take groups \(1 detected/);
    expect(stdout).toMatch(/★/); // recommendation marker
    expect(stdout).not.toMatch(/^\{/); // packTakes text, not JSON — out() prints strings verbatim
  });
});

/**
 * W7: `export render` must load motion sidecars (loadMotionSpecs) and pass
 * them to renderFinal/renderComposition. These spawn the real CLI like every
 * other test in this file, but point $VEDIT_FFMPEG at a tiny stub script (a
 * real render is neither needed nor wanted here): the stub answers the
 * `-filters` capability probe (drawtext + ass, so ffmpegBin resolution and
 * the motion burn's ffmpegHasFilter('ass') gate both pass) and logs every
 * other invocation's argv to $FFMPEG_ARGS_LOG. `export` never touches the
 * daemon (Project.open reads directly), so this stays within this file's
 * "no ensureDaemon commands" scope.
 */
describe('cli: vedit export render wires motion sidecars into the render (W7)', () => {
  let stub: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-ffstub-'));
    stub = path.join(root, 'ffmpeg-stub.sh');
    await fsp.writeFile(
      stub,
      '#!/bin/bash\n' +
        'if [ "$1" = "-hide_banner" ] && [ "$2" = "-filters" ]; then\n' +
        '  printf " T.. drawtext          Draw text\\n T.. ass               Render ASS\\n"\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [ -n "$FFMPEG_ARGS_LOG" ]; then printf "%s\\n" "$@" >> "$FFMPEG_ARGS_LOG"; fi\n' +
        'if [ -n "$ASS_CAPTURE_LOG" ] && [ -n "$ASS_CAPTURE_DIR" ]; then\n' +
        '  shopt -s nullglob dotglob\n' +
        '  for f in "$ASS_CAPTURE_DIR"/*.vedit-*.ass; do cat "$f" >> "$ASS_CAPTURE_LOG"; done\n' +
        'fi\n' +
        'last="${@: -1}"\n' +
        'if [[ "$last" == *.mp4 ]]; then printf "stub mp4" > "$last"; fi\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
  });

  it('renderFinal path: a custom-html motion item surfaces the 焼き込み対象外 warning in the CLI JSON output', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-render-motion-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'render-motion');
    await fsp.writeFile(path.join(dir, 'motion', 'm1.json'), JSON.stringify({ id: 'm1', type: 'custom-html', params: {}, html: '<div/>' }));
    await project.commit(0, 'system', 'setup', {}, 'seed', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: {
        ...m.timeline,
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }],
        motion: [{ id: 'm1', spec: 'motion/m1.json', tlStart: 0, duration: 2 }],
      },
    }));
    const { status, stdout, stderr } = runCli(
      ['export', 'render', path.join(root, 'out.mp4'), '--project', dir],
      { VEDIT_FFMPEG: stub },
    );
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.ok).toBe(true);
    // The warning ONLY exists when cli.ts actually loaded the sidecar and
    // passed opts.motionSpecs through — with the pre-wiring behavior
    // (motionSpecs omitted) this render is warning-free by design.
    expect(body.warnings).toContain('custom-html は焼き込み対象外(1件)');
  });

  it('renderComposition path: a burnable motion item lands a .vedit-motion.ass ass filter in the ffmpeg graph', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-render-comp-motion-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'comp-motion');
    await fsp.writeFile(path.join(dir, 'motion', 'm1.json'), JSON.stringify({ id: 'm1', type: 'cta', params: { text: 'Subscribe' } }));
    await project.commit(0, 'system', 'setup', {}, 'seed', (m) => ({
      ...m,
      width: 1080,
      height: 1920,
      composition: { duration: 5, background: { type: 'color', hex: '#000000' } },
      timeline: { ...m.timeline, motion: [{ id: 'm1', spec: 'motion/m1.json', tlStart: 1, duration: 2 }] },
    }));
    const argsLog = path.join(root, 'ffmpeg-args.log');
    const { status, stdout, stderr } = runCli(
      ['export', 'render', path.join(root, 'out.mp4'), '--project', dir],
      { VEDIT_FFMPEG: stub, FFMPEG_ARGS_LOG: argsLog },
    );
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    const logged = await fsp.readFile(argsLog, 'utf8');
    expect(logged).toMatch(/\.vedit-motion\.ass/); // the burn filter reached ffmpeg — motionSpecs were wired through
  });

  it('renders transcript and motion sidecars from the same captured revision, not newer loose files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-render-pinned-inputs-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'pinned-inputs');
    const transcriptV1 = {
      sourceId: 's1',
      language: 'en',
      words: [{ id: 'w0', text: 'CAPTURED_CAPTION', t0: 1, t1: 2, p: 0.99 }],
    };
    const motionV1 = { id: 'm1', type: 'callout', params: { text: 'CAPTURED_MOTION' } };
    await project.commit(
      0,
      'system',
      'seed-pinned-render',
      {},
      'seed pinned render inputs',
      (m) => ({
        ...m,
        sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
        timeline: {
          ...m.timeline,
          video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }],
          motion: [{ id: 'm1', spec: 'motion/m1.json', tlStart: 0, duration: 2 }],
        },
      }),
      { m1: motionV1 },
      { s1: transcriptV1 },
    );

    // Simulate a loose/newer sidecar becoming visible without a matching
    // manifest revision. A revision-pinned export must use the committed V1
    // snapshot for both kinds instead of mixing these values into revision 1.
    await project.writeTranscript({
      ...transcriptV1,
      words: [{ id: 'w0', text: 'NEWER_CAPTION', t0: 1, t1: 2, p: 0.99 }],
    });
    await fsp.writeFile(
      project.motionSpecPath('m1'),
      JSON.stringify({ ...motionV1, params: { text: 'NEWER_MOTION' } }),
    );

    const assLog = path.join(root, 'captured-ass.txt');
    const outFile = path.join(root, 'out.mp4');
    const { status, stdout, stderr } = runCli(
      ['export', 'render', outFile, '--project', dir],
      { VEDIT_FFMPEG: stub, ASS_CAPTURE_DIR: root, ASS_CAPTURE_LOG: assLog },
    );

    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    const burned = await fsp.readFile(assLog, 'utf8');
    expect(burned).toContain('CAPTURED_CAPTION');
    expect(burned).toContain('CAPTURED_MOTION');
    expect(burned).not.toContain('NEWER_CAPTION');
    expect(burned).not.toContain('NEWER_MOTION');
  });
});

/**
 * Critical trap fix: `vedit export render` used to require the opt-in
 * `--burn-captions` flag even when `captions.enabled` was true — omitting it
 * (the common/default invocation) silently produced a video with NO
 * subtitles AND no dialogue (speech-bubble lines), since both lived behind
 * the same `opts.burnCaptions && captions.enabled` gate in render.ts. Fixed
 * spec: captions.enabled=true burns by DEFAULT now; `--no-burn-captions`
 * opts out for a clean NLE hand-off render; dialogue always burns
 * regardless of the captions gate (it has no other output path). These
 * tests exercise the real CLI end-to-end (same ffmpeg-stub approach as the
 * W7 describe block above) and assert both the JSON result and the
 * stderr status line the spec calls for ("字幕を焼き込み(N cues)" /
 * "字幕は焼き込みなし(...)").
 */
describe('cli: vedit export render — caption/dialogue default-burn gate (Critical trap fix)', () => {
  let stub: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-ffstub2-'));
    stub = path.join(root, 'ffmpeg-stub.sh');
    await fsp.writeFile(
      stub,
      '#!/bin/bash\n' +
        'if [ "$1" = "-hide_banner" ] && [ "$2" = "-filters" ]; then\n' +
        '  printf " T.. drawtext          Draw text\\n T.. ass               Render ASS\\n"\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [ -n "$FFMPEG_ARGS_LOG" ]; then printf "%s\\n" "$@" >> "$FFMPEG_ARGS_LOG"; fi\n' +
        'last="${@: -1}"\n' +
        'if [[ "$last" == *.mp4 ]]; then printf "stub mp4" > "$last"; fi\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
  });

  async function seedProjectWithCaptionableTranscript(name: string): Promise<{ root: string; dir: string; project: Project }> {
    const root = mkdtempSync(path.join(tmpdir(), `vedit-cli-burngate-${name}-`));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, name);
    const words: Word[] = [{ id: 'w0', text: 'Hello.', t0: 1.0, t1: 2.0, p: 0.95 }];
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { ...m.timeline, video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }] },
    }));
    return { root, dir, project };
  }

  it('captions.enabled=true with NO --burn-captions flag burns captions by default and reports the cue count', async () => {
    const { root, dir } = await seedProjectWithCaptionableTranscript('default-burn');
    const argsLog = path.join(root, 'ffmpeg-args.log');
    const { status, stdout, stderr } = runCli(
      ['export', 'render', path.join(root, 'out.mp4'), '--project', dir],
      { VEDIT_FFMPEG: stub, FFMPEG_ARGS_LOG: argsLog },
    );
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).toMatch(/字幕を焼き込み\(\d+ cues\)/);
    const logged = await fsp.readFile(argsLog, 'utf8');
    expect(logged).toMatch(/\.vedit-captions\.ass/);
  });

  it('--no-burn-captions opts out of the caption burn but dialogue on the timeline still burns', async () => {
    const { root, dir, project } = await seedProjectWithCaptionableTranscript('no-burn-captions');
    await project.commit(1, 'system', 'setup', {}, 'add dialogue', (m) => ({
      ...m,
      timeline: { ...m.timeline, dialogue: [{ id: 'dl1', text: 'hi', tlStart: 0, duration: 2 }] },
    }));
    const argsLog = path.join(root, 'ffmpeg-args.log');
    const { status, stdout, stderr } = runCli(
      ['export', 'render', path.join(root, 'out.mp4'), '--project', dir, '--no-burn-captions'],
      { VEDIT_FFMPEG: stub, FFMPEG_ARGS_LOG: argsLog },
    );
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).toMatch(/字幕は焼き込みなし\(--no-burn-captions\)/);
    expect(stderr).toMatch(/セリフを焼き込み\(1件\)/);
    const logged = await fsp.readFile(argsLog, 'utf8');
    expect(logged).toMatch(/\.vedit-captions\.ass/); // ass filter still present — burned for dialogue
  });

  it('captions.enabled=false with dialogue on the timeline still burns the dialogue (the trap this fix closes)', async () => {
    const { root, dir, project } = await seedProjectWithCaptionableTranscript('disabled-with-dialogue');
    await project.commit(1, 'system', 'setup', {}, 'disable captions + add dialogue', (m) => ({
      ...m,
      captions: { ...m.captions, enabled: false },
      timeline: { ...m.timeline, dialogue: [{ id: 'dl1', text: 'hi', tlStart: 0, duration: 2 }] },
    }));
    const argsLog = path.join(root, 'ffmpeg-args.log');
    const { status, stdout, stderr } = runCli(
      ['export', 'render', path.join(root, 'out.mp4'), '--project', dir],
      { VEDIT_FFMPEG: stub, FFMPEG_ARGS_LOG: argsLog },
    );
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).toMatch(/字幕は焼き込みなし\(captions\.enabled=false\)/);
    expect(stderr).toMatch(/セリフを焼き込み\(1件\)/);
    const logged = await fsp.readFile(argsLog, 'utf8');
    expect(logged).toMatch(/\.vedit-captions\.ass/); // ass filter present for dialogue despite captions disabled
  });

  it('legacy --burn-captions flag alone still works exactly as before (backward compatible, now a no-op)', async () => {
    const { root, dir } = await seedProjectWithCaptionableTranscript('legacy-flag');
    const argsLog = path.join(root, 'ffmpeg-args.log');
    const { status, stdout, stderr } = runCli(
      ['export', 'render', path.join(root, 'out.mp4'), '--project', dir, '--burn-captions'],
      { VEDIT_FFMPEG: stub, FFMPEG_ARGS_LOG: argsLog },
    );
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).toMatch(/字幕を焼き込み\(\d+ cues\)/);
    const logged = await fsp.readFile(argsLog, 'utf8');
    expect(logged).toMatch(/\.vedit-captions\.ass/);
  });
});

/**
 * 「書き出し結果カード」バックエンド(cache/export-results.json)の CLI 統合
 * テスト。docs/product-bet-sensory-vs-structural.md: 構造系(書き出し)に
 * 必要なのは操作ではなく結果の可視化——`vedit export *` が成功・失敗どちら
 * でも記録を残すことを、実プロセス起動(spawnSync)+ffmpeg スタブという
 * このファイルの通常の流儀のまま確認する。
 */
describe('cli: vedit export records to cache/export-results.json', () => {
  let okStub: string;
  let failStub: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-exportresults-stub-'));
    okStub = path.join(root, 'ffmpeg-ok.sh');
    await fsp.writeFile(
      okStub,
      '#!/bin/bash\n' +
        'if [ "$1" = "-hide_banner" ] && [ "$2" = "-filters" ]; then\n' +
        '  printf " T.. drawtext          Draw text\\n T.. ass               Render ASS\\n"\n' +
        '  exit 0\n' +
        'fi\n' +
        'last="${@: -1}"\n' +
        'if [[ "$last" == *.mp4 ]]; then printf "stub mp4" > "$last"; fi\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
    failStub = path.join(root, 'ffmpeg-fail.sh');
    await fsp.writeFile(
      failStub,
      '#!/bin/bash\n' +
        'if [ "$1" = "-hide_banner" ] && [ "$2" = "-filters" ]; then\n' +
        '  printf " T.. drawtext          Draw text\\n T.. ass               Render ASS\\n"\n' +
        '  exit 0\n' +
        'fi\n' +
        'last="${@: -1}"\n' +
        'if [[ "$last" == *.mp4 ]]; then printf "incomplete new export" > "$last"; fi\n' +
        'echo "synthetic encode failure" >&2\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
  });

  async function seedSimpleProject(name: string): Promise<{ root: string; dir: string }> {
    const root = mkdtempSync(path.join(tmpdir(), `vedit-cli-exportresults-${name}-`));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, name);
    await project.commit(0, 'system', 'setup', {}, 'seed', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { ...m.timeline, video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }] },
    }));
    return { root, dir };
  }

  async function readResults(dir: string): Promise<any[]> {
    return JSON.parse(await fsp.readFile(path.join(dir, 'cache', 'export-results.json'), 'utf8'));
  }

  it('a successful `export render` appends an ok:true record with revision/options/warnings', async () => {
    const { root, dir } = await seedSimpleProject('render-ok');
    const outFile = path.join(root, 'out.mp4');
    const { status, stderr } = runCli(
      ['export', 'render', outFile, '--project', dir, '--preset', 'youtube', '--fast-loudnorm'],
      { VEDIT_FFMPEG: okStub },
    );
    expect(status, stderr).toBe(0);
    const results = await readResults(dir);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'render', file: outFile, ok: true, revision: 1 });
    expect(results[0].options).toMatchObject({ preset: 'youtube', fastLoudnorm: true });
    expect(typeof results[0].ts).toBe('string');
    expect(new Date(results[0].ts).toString()).not.toBe('Invalid Date');
    await expect(fsp.readFile(outFile, 'utf8')).resolves.toBe('stub mp4');
    expect((await fsp.readdir(root)).filter((name) => name.includes('.vedit-partial-'))).toEqual([]);
  });

  it('a failed `export render` (ffmpeg exits non-zero) appends an ok:false record with the error, and the CLI itself still fails', async () => {
    const { root, dir } = await seedSimpleProject('render-fail');
    const outFile = path.join(root, 'out.mp4');
    await fsp.writeFile(outFile, 'previous good export');
    const { status, stderr } = runCli(
      ['export', 'render', outFile, '--project', dir],
      { VEDIT_FFMPEG: failStub },
    );
    expect(status).toBe(1); // export failure must still fail the CLI command itself
    const results = await readResults(dir);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'render', file: outFile, ok: false });
    expect(results[0].error).toMatch(/synthetic encode failure|failed/);
    expect(stderr).toBeTruthy();
    await expect(fsp.readFile(outFile, 'utf8')).resolves.toBe('previous good export');
    expect((await fsp.readdir(root)).filter((name) => name.includes('.vedit-partial-'))).toEqual([]);
  });

  it('a failed range preview also preserves an existing destination and cleans its partial', async () => {
    const { root, dir } = await seedSimpleProject('range-fail');
    const outFile = path.join(root, 'range.mp4');
    await fsp.writeFile(outFile, 'previous range preview');
    const { status, stderr } = runCli(
      ['export', 'render', outFile, '--project', dir, '--range', '0..2'],
      { VEDIT_FFMPEG: failStub },
    );

    expect(status).toBe(1);
    expect(stderr).toMatch(/synthetic encode failure|failed/);
    await expect(fsp.readFile(outFile, 'utf8')).resolves.toBe('previous range preview');
    expect((await fsp.readdir(root)).filter((name) => name.includes('.vedit-partial-'))).toEqual([]);
    expect((await readResults(dir))[0]).toMatchObject({ kind: 'render-preview', file: outFile, ok: false, revision: 1 });
  });

  it('`export otio` (no ffmpeg involved) also records ok:true', async () => {
    const { root, dir } = await seedSimpleProject('otio-ok');
    const outFile = path.join(root, 'out.otio');
    const { status, stderr } = runCli(['export', 'otio', outFile, '--project', dir]);
    expect(status, stderr).toBe(0);
    const results = await readResults(dir);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'otio', file: outFile, ok: true, revision: 1 });
  });

  it('a second export prepends a new record, most-recent first', async () => {
    const { root, dir } = await seedSimpleProject('two-exports');
    await runCli(['export', 'srt', path.join(root, 'a.srt'), '--project', dir]);
    await runCli(['export', 'srt', path.join(root, 'b.srt'), '--project', dir]);
    const results = await readResults(dir);
    expect(results).toHaveLength(2);
    expect(results[0].file).toBe(path.join(root, 'b.srt'));
    expect(results[1].file).toBe(path.join(root, 'a.srt'));
  });
});

describe('cli: vedit retro', () => {
  it('outputs structured JSON (introDropPct/dips/spikes) plus a fact-only human-readable summary', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-retro-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'retro-cli');
    const csvPath = path.join(root, 'retention.csv');
    const rows = ['Video position (%),Audience retention (%)'];
    for (let pct = 0; pct <= 100; pct += 10) rows.push(`${pct},${100 - pct * 0.5}`);
    await fsp.writeFile(csvPath, rows.join('\n') + '\n');

    const { status, stdout, stderr } = runCli(['retro', csvPath, '--project', dir, '--render-duration', '300']);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(typeof body.introDropPct).toBe('number');
    expect(Array.isArray(body.dips)).toBe(true);
    expect(Array.isArray(body.spikes)).toBe(true);
    expect(body.summary).toMatch(/視聴者維持率ふりかえり/);
    expect(body.summary).toMatch(/仮説を出しません/);
  });

  it('fails with a clear error for an unrecognized CSV format', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-retro-bad-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'retro-bad-cli');
    const csvPath = path.join(root, 'bad.csv');
    await fsp.writeFile(csvPath, 'foo,bar\n1,2\n');
    const { status, stderr } = runCli(['retro', csvPath, '--project', dir]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/unrecognized retention CSV format/);
  });
});
