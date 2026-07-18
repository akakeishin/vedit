import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Project } from './project.js';

/**
 * セッションまたぎの編集メモ(`NOTES.md`)。revision ログ(project.ts の
 * revisions.jsonl)は「何をしたか」を op ごとに完全記録しているので、この
 * モジュールは**なぜ/次に何を**だけを担う——重複記録はしない。
 *
 * 保存形式はプロジェクト直下の追記型 Markdown:
 *
 *   ## [2026-07-17 14:05] policy (rev 12)
 *   前半はテンポ重視で0.5s以上の間を全部詰める。笑いの間だけ守る。
 *
 *   ## [2026-07-17 14:20] todo
 *   - [ ] BGMの候補を3曲ユーザーに出す
 *
 * 論理的な書き込みは追記のみ(`appendNote`)——既存の見出し・本文のbytesを
 * 保った次内容をproject lock下でatomic renameする。唯一の内容変更が
 * `markTodoDone` で、該当する `- [ ]` 行だけを `- [x]` に置換する
 * (その1行以外は触らない)。パースは寛容: 手編集された
 * NOTES.md(見出し崩れ、未知の type、チェックボックス以外の本文)でも
 * 例外を投げず、読めるものだけ拾う。
 */

export type NoteType = 'policy' | 'decision' | 'todo' | 'pref';

export interface NoteTodoItem {
  done: boolean;
  text: string;
}

export interface NoteEntry {
  /** 見出しに書かれた表示用タイムスタンプそのまま ("YYYY-MM-DD HH:MM")。 */
  ts: string;
  /** 既知の4種のいずれか、または手編集で入った任意の文字列(寛容パース)。 */
  type: string;
  /** 記録時点の manifest revision。読めなかった/古い形式の見出しには無い。 */
  rev?: number;
  /** 本文そのまま(todo エントリでも `- [ ] ...` 行を含む生テキスト)。 */
  text: string;
  /** 本文中のチェックボックス行(`- [ ]`/`- [x]`)。1つも無ければ省略。 */
  todos?: NoteTodoItem[];
}

export interface AppendNoteInput {
  type: NoteType;
  text: string;
  /** 分かるなら現在の revision(呼び出し側が読んで渡す — このモジュールは manifest を読まない)。 */
  rev?: number;
}

function notesPath(projectDir: string): string {
  return path.join(projectDir, 'NOTES.md');
}

/** "2026-07-17 14:05" — ローカル時刻(会話中の実感覚に合わせる。ISO/UTCではない)。 */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function readRaw(projectDir: string): Promise<string> {
  try {
    return await fs.readFile(notesPath(projectDir), 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
}

async function replaceRawLocked(projectDir: string, raw: string): Promise<void> {
  const target = notesPath(projectDir);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmp, raw);
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * todo 本文の整形: `text` を改行で割り、各行を `- [ ] <line>` にする
 * (既に `- [ ]`/`- [x]` で始まる行はそのまま——手編集済みテキストを二重に
 * 装飾しない)。1件も残らなければ元の text をそのまま1行として扱う。
 */
function toTodoBody(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const items = lines.length > 0 ? lines : [text.trim()];
  return items.map((l) => (/^- \[[ xX]\]/.test(l) ? l : `- [ ] ${l}`)).join('\n');
}

/**
 * NOTES.md に1エントリを追記する。既存内容は一切読み替えない —
 * 直前のエントリがどう終わっていても(手編集で改行が崩れていても)、
 * 新エントリの前に空行が1つだけ入るよう調整するためだけに既存末尾を覗く。
 * read/append publicationはprojectのcross-process lock下で一つのtransaction。
 */
export async function appendNote(projectDir: string, note: AppendNoteInput): Promise<void> {
  const heading = `## [${formatTimestamp(new Date())}] ${note.type}${note.rev !== undefined ? ` (rev ${note.rev})` : ''}`;
  const body = note.type === 'todo' ? toTodoBody(note.text) : note.text.trim();
  const block = `${heading}\n${body}\n`;

  const project = new Project(path.resolve(projectDir));
  await project.withPersistenceLock(async () => {
    const existing = await readRaw(project.dir);
    const prefix = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await replaceRawLocked(project.dir, existing + prefix + block);
  });
}

interface InternalTodo extends NoteTodoItem {
  /** raw テキストを split('\n') した配列内の絶対行番号(markTodoDone がピンポイントで書き換えるため)。 */
  lineIndex: number;
}

interface InternalEntry {
  ts: string;
  type: string;
  rev?: number;
  text: string;
  todos: InternalTodo[];
}

const HEADING_RE = /^## \[(.+?)\]\s+(\S+)(?:\s+\(rev\s+(\d+)\))?\s*$/;
const TODO_LINE_RE = /^- \[([ xX])\]\s?(.*)$/;

/**
 * 生テキストを見出し単位でエントリに分解する。見出し行にマッチしない限り
 * "本文" として現在のエントリに積まれるだけなので、見出し崩れ・未知の
 * type・見出し前の余談があっても例外を投げない(寛容パース)。
 */
function parseNotes(raw: string): InternalEntry[] {
  const lines = raw.split('\n');
  const entries: InternalEntry[] = [];
  let current: { ts: string; type: string; rev?: number; bodyStart: number } | null = null;

  const flush = (endExclusive: number) => {
    if (!current) return;
    let start = current.bodyStart;
    let end = endExclusive;
    while (start < end && lines[start].trim() === '') start++;
    while (end > start && lines[end - 1].trim() === '') end--;
    const todos: InternalTodo[] = [];
    for (let i = start; i < end; i++) {
      const m = TODO_LINE_RE.exec(lines[i]);
      if (m) todos.push({ done: m[1] !== ' ', text: m[2], lineIndex: i });
    }
    entries.push({ ts: current.ts, type: current.type, rev: current.rev, text: lines.slice(start, end).join('\n'), todos });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) {
      flush(i);
      current = { ts: m[1], type: m[2], rev: m[3] !== undefined ? Number(m[3]) : undefined, bodyStart: i + 1 };
    }
  }
  flush(lines.length);
  return entries;
}

/** NOTES.md を古い順に読む。ファイルが無い/空なら `[]`(例外を投げない)。 */
export async function readNotes(projectDir: string): Promise<NoteEntry[]> {
  const raw = await readRaw(projectDir);
  if (!raw.trim()) return [];
  return parseNotes(raw).map((e) => ({
    ts: e.ts,
    type: e.type,
    ...(e.rev !== undefined ? { rev: e.rev } : {}),
    text: e.text,
    ...(e.todos.length ? { todos: e.todos.map(({ done, text }) => ({ done, text })) } : {}),
  }));
}

/**
 * `readNotes` が返す未完了 todo の連番(ファイル全体を通し、上から出現順に
 * 数える——エントリの type ラベルに関わらず本文中のチェックボックス行を
 * 全て対象にする)で index 番目のものを完了(`- [x]`)にする。該当行だけを
 * 文字単位で置換し、他のバイトには触れない。
 */
export async function markTodoDone(projectDir: string, index: number): Promise<{ text: string }> {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`todo index must be a positive integer (got ${index})`);
  }
  const project = new Project(path.resolve(projectDir));
  return project.withPersistenceLock(async () => {
    const raw = await readRaw(project.dir);
    if (!raw.trim()) throw new Error('NOTES.md not found (or empty) — nothing to mark done');

    const entries = parseNotes(raw);
    const pending = entries.flatMap((e) => e.todos.filter((t) => !t.done));
    const target = pending[index - 1];
    if (!target) throw new Error(`no incomplete todo #${index} (${pending.length} pending)`);

    const lines = raw.split('\n');
    lines[target.lineIndex] = lines[target.lineIndex].replace(/^-\s\[ \]/, '- [x]');
    await replaceRawLocked(project.dir, lines.join('\n'));
    return { text: target.text };
  });
}
