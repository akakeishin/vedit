// e2e テスト用の daemon/プロジェクト起動ヘルパー。
//
// 方針(docs/HANDOFF.md §5/§6 準拠):
// - ユーザーの実 daemon(port 7799, プロジェクト shibuya-final)には絶対に
//   触れない。空きポート(OS 割当の一時ポート)+vedit 専用の隔離状態パス+
//   隔離プロジェクトディレクトリを毎回新規に用意する。
// - daemon は `serve` を直接 spawn して自前で所有する(detached にしない)。
//   CLI コマンド(`vedit create`等)の ensureDaemon() は「未起動なら detached
//   で立ち上げる」ため、そちらに任せると teardown で確実に kill できない
//   orphan プロセスが残る。先に自前の daemon を起動しておけば、以後の CLI
//   呼び出しは daemonUp()===true を見て単に POST /api/open するだけになる。
// - 文字起こしは whisper を実行せず、Transcript 保存形式(src/core/types.ts
//   の Transcript/Word、src/core/project.ts の `transcript-<sourceId>.json`)
//   に合わせた合成データを直接書き込む。captions.enabled は既定で true
//   (Project.create 参照)だが、タスクの指示どおり明示的にも有効化する。
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

export interface CueFixture {
  key: string;
  text: string;
  tlStart: number;
  tlEnd: number;
}

export interface VeditFixture {
  port: number;
  baseURL: string;
  dir: string;
  stateDir: string;
  sourceId: string;
  projectName: string;
  cueA: CueFixture;
  cueB: CueFixture;
  env: NodeJS.ProcessEnv;
  daemon: ChildProcessWithoutNullStreams;
}

/** Identity precondition required by every write-method daemon API. */
export function projectIdentityHeaders(projectDir: string): Record<string, string> {
  return { 'x-vedit-project-dir': encodeURIComponent(path.resolve(projectDir)) };
}

/** An OS-assigned ephemeral TCP port — never 7799 (either the real daemon already holds it, so the OS won't hand it out, or we retry defensively). */
async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          const p = addr.port;
          srv.close(() => resolve(p));
        } else {
          srv.close(() => reject(new Error('failed to allocate a free port')));
        }
      });
    });
    if (port !== 7799) return port;
  }
  throw new Error('could not allocate a free port avoiding 7799');
}

function runCli(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
}

async function waitForPing(baseURL: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseURL}/api/ping`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon did not respond at ${baseURL}/api/ping within ${timeoutMs}ms: ${String(lastErr)}`);
}

/** 4〜8秒の testsrc(映像)+sine(音声)素材を ffmpeg lavfi で生成(実ファイル取り込み経路を素通しするため、whisper だけを避ける)。 */
function genSyntheticClip(outPath: string, seconds = 6): void {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-shortest',
      outPath,
    ],
    { stdio: 'ignore' },
  );
}

/**
 * 合成 transcript(2文・2 cue 分)。captionCues のグルーピング規則
 * (src/core/captions.ts: 語間ギャップ>0.6s または句読点で flush)に合わせて
 * 意図的に「こんにちは世界。」「字幕編集テスト。」の2文を離して配置し、
 * cue の tl 窓を予測可能にしてある(下記 cueA/cueB のコメント参照)。
 */
const SYNTHETIC_WORDS = [
  { id: 'w0000', text: 'こんにちは', t0: 0.5, t1: 1.1, p: 0.95 },
  { id: 'w0001', text: '世界。', t0: 1.1, t1: 1.6, p: 0.95 },
  { id: 'w0002', text: '字幕編集', t0: 3.0, t1: 3.6, p: 0.95 },
  { id: 'w0003', text: 'テスト。', t0: 3.6, t1: 4.1, p: 0.95 },
] as const;

export async function setupVedit(label: string): Promise<VeditFixture> {
  const port = await findFreePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), `vedit-e2e-state-${label}-`));
  const workRoot = mkdtempSync(path.join(tmpdir(), `vedit-e2e-work-${label}-`));
  const projectName = `vedit-e2e-${label}`;
  const projectDir = path.join(workRoot, projectName);
  mkdirSync(projectDir, { recursive: true });
  const mediaPath = path.join(workRoot, 'clip.mp4');
  genSyntheticClip(mediaPath, 6);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VEDIT_REGISTRY_PATH: path.join(stateDir, 'registry', 'projects.json'),
    VEDIT_PRESETS_PATH: path.join(stateDir, 'presets', 'presets.json'),
    VEDIT_MODEL_DIR: path.join(stateDir, 'models'),
    VEDIT_PORT: String(port),
  };
  const baseURL = `http://localhost:${port}`;

  // Own the daemon process directly (not detached) so afterAll can kill it
  // deterministically — see the module doc above.
  const daemon = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--project', projectDir], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let daemonOutput = '';
  daemon.stdout.on('data', (d) => (daemonOutput += String(d)));
  daemon.stderr.on('data', (d) => (daemonOutput += String(d)));
  daemon.on('error', (e) => {
    daemonOutput += `\n[spawn error] ${String(e)}`;
  });

  try {
    await waitForPing(baseURL);
  } catch (e) {
    throw new Error(`${String(e)}\n---- daemon output ----\n${daemonOutput}`);
  }

  // 単一素材を取り込み(scenes/transcribe はスキップ — このスイートには不要で、
  // 実 whisper 起動を避けるという task brief の指示にも合う)。
  const ingestOut = runCli(['ingest', mediaPath, '--project', projectDir, '--no-scenes'], env);
  const ingestRes = JSON.parse(ingestOut);
  const sourceId: string = ingestRes.source.id;

  // Transcript は保存形式(Transcript: {sourceId, language, words}, 各 word は
  // {id, text, t0, t1, p} — src/core/types.ts)に合わせて直接書き込む。
  writeFileSync(
    path.join(projectDir, `transcript-${sourceId}.json`),
    JSON.stringify({ sourceId, language: 'ja', words: SYNTHETIC_WORDS }),
  );

  // manifest.sources[].transcribed を立てる正規の経路は「実際に whisper を
  // 走らせる」(vedit transcribe / ingest --transcribe)以外に存在しない
  // (POST /api/transcribe は本物の transcribe() を呼ぶ)。task brief は
  // whisper を避けて合成データを直接書き込むことを明示許可しているため、
  // ここも project.json を直接パッチする。Project.manifest() は毎回
  // ディスクから読み直す(src/core/project.ts、インメモリキャッシュ無し)ので、
  // daemon 再起動なしに次のリクエストから反映される。
  const manifestPath = path.join(projectDir, 'project.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.sources = manifest.sources.map((s: any) => (s.id === sourceId ? { ...s, transcribed: true } : s));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // captions.enabled は Project.create() の既定で true だが、task brief の
  // 指示どおり明示的にも有効化しておく(正規の commit 経路、--latest で
  // 現在の revision を都度解決させる)。
  runCli(['captions', '--enabled', 'true', '--latest', '--project', projectDir], env);

  return {
    port,
    baseURL,
    dir: projectDir,
    stateDir,
    sourceId,
    projectName,
    // captionCues の計算(src/core/captions.ts flush 規則)を手計算した窓。
    // tlStart = 先頭語の中点、tlEnd = 末尾語の中点 + 半幅 + 0.15(最小 0.6s)。
    cueA: { key: `${sourceId}:w0000`, text: 'こんにちは世界。', tlStart: 0.8, tlEnd: 1.75 },
    cueB: { key: `${sourceId}:w0002`, text: '字幕編集テスト。', tlStart: 3.3, tlEnd: 4.25 },
    env,
    daemon,
  };
}

export async function teardownVedit(fx: VeditFixture): Promise<void> {
  await new Promise<void>((resolve) => {
    fx.daemon.once('exit', () => resolve());
    fx.daemon.kill();
    // Fallback in case 'exit' never fires (shouldn't happen, but don't hang teardown forever).
    setTimeout(resolve, 3000);
  });
  rmSync(path.dirname(fx.dir), { recursive: true, force: true });
  rmSync(fx.stateDir, { recursive: true, force: true });
}

/** "0:08.4" 形式(web/app.js の fmt())を秒数へ。テストのタイムコード検証で使う。 */
export function parseTc(text: string | null): number {
  if (!text) return NaN;
  const m = text.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
