import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
/** 保持する最大件数(直近何件を cache/export-results.json に残すか)。 */
const EXPORT_RESULTS_LIMIT = 20;
function exportResultsPath(projectDir) {
    return path.join(projectDir, 'cache', 'export-results.json');
}
async function withExportResultsLock(projectDir, fn) {
    const dir = path.join(projectDir, 'cache');
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, 'export-results.lock');
    let handle = null;
    for (let attempt = 0; attempt < 500; attempt++) {
        try {
            handle = await fs.open(lockPath, 'wx');
            break;
        }
        catch (e) {
            if (e?.code !== 'EEXIST')
                throw e;
            try {
                const stat = await fs.stat(lockPath);
                if (Date.now() - stat.mtimeMs > 30_000)
                    await fs.rm(lockPath, { force: true });
            }
            catch { /* another writer released it */ }
            await delay(10 + Math.floor(Math.random() * 10));
        }
    }
    if (!handle)
        throw new Error('timed out waiting for export result history lock');
    try {
        return await fn();
    }
    finally {
        await handle.close().catch(() => { });
        await fs.rm(lockPath, { force: true }).catch(() => { });
    }
}
/**
 * レコードとして最低限の形をしているかだけを見る緩い型ガード。手編集や
 * 将来のフィールド追加/削除で壊れた要素は黙って捨てる(readNotes と同じ
 * 「読めるものだけ拾う」寛容パース方針)。
 */
function looksLikeRecord(v) {
    return (typeof v === 'object' &&
        v !== null &&
        typeof v.ts === 'string' &&
        typeof v.kind === 'string' &&
        typeof v.file === 'string' &&
        typeof v.ok === 'boolean');
}
/**
 * cache/export-results.json を読む。ファイルが無い、JSON として壊れている、
 * トップレベルが配列でない、のいずれでも例外を投げず `[]` を返す。
 */
export async function readExportResults(projectDir) {
    let raw;
    try {
        raw = await fs.readFile(exportResultsPath(projectDir), 'utf8');
    }
    catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
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
export async function appendExportResult(projectDir, record) {
    await withExportResultsLock(projectDir, async () => {
        const existing = await readExportResults(projectDir);
        const next = [record, ...existing].slice(0, EXPORT_RESULTS_LIMIT);
        const target = exportResultsPath(projectDir);
        const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        try {
            await fs.writeFile(tmp, JSON.stringify(next, null, 2));
            await fs.rename(tmp, target);
        }
        finally {
            await fs.rm(tmp, { force: true }).catch(() => { });
        }
    });
}
