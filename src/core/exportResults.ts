import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * 書き出し結果カードのバックエンド永続化。
 *
 * CLI とアプリ内ローカルMP4ジョブが書き出しの都度この記録を残し、daemon
 * の GET /api/export-results が web の確認面へ返す。公開・外部送信を行う
 * 記録ではなく、あくまでプロジェクト内で完了した成果物の台帳。
 *
 * 保存先: `<projectDir>/cache/export-results.json`。新しい順(先頭が最新)、
 * 直近 EXPORT_RESULTS_LIMIT 件で切り詰め。書き込みは tmp→rename の原子的
 * 置換。読み取りは壊れたJSON/存在しないファイルに耐性がある(空配列を返す
 * だけで例外を投げない)——記録の欠損より書き出し自体の成功が優先。
 */

export type ExportKind = 'render' | 'render-preview' | 'otio' | 'srt' | 'ass' | 'fcp7xml' | 'publish-pack';

export interface ExportResultRecord {
  /** ISO timestamp。CLI 側で取得して渡す(このモジュールは時計を持たない)。 */
  ts: string;
  kind: ExportKind;
  /** 書き出し先ファイル(render/otio/srt/ass/fcp7xml)またはディレクトリ(publish-pack)。 */
  file: string;
  ok: boolean;
  /** 書き出し時点の manifest revision。 */
  revision: number;
  /** kind ごとの要点(render の preset/noBurnCaptions/fastLoudnorm 等、publish-pack の thumbs 等)。 */
  options?: Record<string, unknown>;
  warnings?: string[];
  captionsBurned?: boolean;
  captionCueCount?: number;
  dialogueBurned?: boolean;
  dialogueCount?: number;
  /** ok=false のときの失敗理由。 */
  error?: string;
}

/** 保持する最大件数(直近何件を cache/export-results.json に残すか)。 */
const EXPORT_RESULTS_LIMIT = 20;

function exportResultsPath(projectDir: string): string {
  return path.join(projectDir, 'cache', 'export-results.json');
}

async function withExportResultsLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.join(projectDir, 'cache');
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, 'export-results.lock');
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) await fs.rm(lockPath, { force: true });
      } catch { /* another writer released it */ }
      await delay(10 + Math.floor(Math.random() * 10));
    }
  }
  if (!handle) throw new Error('timed out waiting for export result history lock');
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * レコードとして最低限の形をしているかだけを見る緩い型ガード。手編集や
 * 将来のフィールド追加/削除で壊れた要素は黙って捨てる(readNotes と同じ
 * 「読めるものだけ拾う」寛容パース方針)。
 */
function looksLikeRecord(v: unknown): v is ExportResultRecord {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as any).ts === 'string' &&
    typeof (v as any).kind === 'string' &&
    typeof (v as any).file === 'string' &&
    typeof (v as any).ok === 'boolean'
  );
}

/**
 * cache/export-results.json を読む。ファイルが無い、JSON として壊れている、
 * トップレベルが配列でない、のいずれでも例外を投げず `[]` を返す。
 */
export async function readExportResults(projectDir: string): Promise<ExportResultRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(exportResultsPath(projectDir), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(looksLikeRecord);
}

/**
 * 1件を先頭に追記し、直近 EXPORT_RESULTS_LIMIT 件に切り詰めて保存する
 * (新しい順)。cache/ ディレクトリが無ければ作る。tmp→rename の原子的
 * 置換なので、書き込み途中のプロセス終了でも既存ファイルは壊れない。
 *
 * 呼び出し側(CLI)の契約: この関数が投げた例外は書き出しコマンド自体を
 * 失敗させてはいけない——呼び出し側で catch して stderr に注記するだけに
 * とどめる(書き出し結果の記録は best-effort)。
 */
export async function appendExportResult(projectDir: string, record: ExportResultRecord): Promise<void> {
  await withExportResultsLock(projectDir, async () => {
    const existing = await readExportResults(projectDir);
    const next = [record, ...existing].slice(0, EXPORT_RESULTS_LIMIT);
    const target = exportResultsPath(projectDir);
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(next, null, 2));
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
}
