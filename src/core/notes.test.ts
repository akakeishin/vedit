import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendNote, markTodoDone, readNotes } from './notes.js';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vedit-notes-'));
}

async function readRawFile(dir: string): Promise<string> {
  return fsp.readFile(path.join(dir, 'NOTES.md'), 'utf8');
}

describe('notes: readNotes on a missing/empty NOTES.md', () => {
  it('returns [] when NOTES.md does not exist at all', async () => {
    const dir = freshDir();
    expect(await readNotes(dir)).toEqual([]);
  });

  it('returns [] when NOTES.md exists but is empty (or whitespace-only)', async () => {
    const dir = freshDir();
    await fsp.writeFile(path.join(dir, 'NOTES.md'), '   \n\n  ');
    expect(await readNotes(dir)).toEqual([]);
  });
});

describe('notes: appendNote / readNotes round trip', () => {
  it('records type/rev/text and formats the heading as "## [ts] type (rev N)"', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'policy', text: '前半はテンポ重視で0.5s以上の間を全部詰める。', rev: 12 });
    const raw = await readRawFile(dir);
    expect(raw).toMatch(/^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] policy \(rev 12\)\n/);

    const notes = await readNotes(dir);
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('policy');
    expect(notes[0].rev).toBe(12);
    expect(notes[0].text).toBe('前半はテンポ重視で0.5s以上の間を全部詰める。');
    expect(notes[0].ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(notes[0].todos).toBeUndefined();
  });

  it('omits "(rev N)" from the heading and leaves rev undefined when no rev is given', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'pref', text: 'BGMは静かめが好み' });
    const raw = await readRawFile(dir);
    expect(raw).toMatch(/^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] pref\n/);
    const notes = await readNotes(dir);
    expect(notes[0].rev).toBeUndefined();
  });

  it('type=todo: a single-line text becomes one unchecked checklist item', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: 'BGMの候補を3曲ユーザーに出す' });
    const notes = await readNotes(dir);
    expect(notes[0].todos).toEqual([{ done: false, text: 'BGMの候補を3曲ユーザーに出す' }]);
  });

  it('type=todo: a multi-line text becomes multiple unchecked checklist items, blank lines dropped', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: 'BGMの候補を3曲出す\n\n冒頭カードの文言を承認もらう\n' });
    const notes = await readNotes(dir);
    expect(notes[0].todos).toEqual([
      { done: false, text: 'BGMの候補を3曲出す' },
      { done: false, text: '冒頭カードの文言を承認もらう' },
    ]);
  });

  it('type=todo: lines already looking like "- [ ] ..." are not double-prefixed', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: '- [ ] 既にチェックボックス形式の行' });
    const raw = await readRawFile(dir);
    expect(raw).not.toContain('- [ ] - [ ]');
    const notes = await readNotes(dir);
    expect(notes[0].todos).toEqual([{ done: false, text: '既にチェックボックス形式の行' }]);
  });

  it('appends without ever rewriting previously written bytes (existing content stays a strict prefix)', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'policy', text: '最初の方針', rev: 1 });
    const after1 = await readRawFile(dir);
    await appendNote(dir, { type: 'decision', text: '2件目の判断', rev: 2 });
    const after2 = await readRawFile(dir);
    expect(after2.startsWith(after1)).toBe(true);
    // exactly one blank line between the two entries, not zero or two+
    expect(after2).toBe(`${after1}\n## [${after2.match(/\[(.+?)\] decision/)![1]}] decision (rev 2)\n2件目の判断\n`);
  });

  it('preserves entry order (oldest first) across three appends of mixed types', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'policy', text: 'p', rev: 1 });
    await appendNote(dir, { type: 'todo', text: 't' });
    await appendNote(dir, { type: 'pref', text: 'f' });
    const notes = await readNotes(dir);
    expect(notes.map((n) => n.type)).toEqual(['policy', 'todo', 'pref']);
  });

  it('keeps every entry from concurrent writers instead of losing a read-modify-write update', async () => {
    const dir = freshDir();
    const count = 24;
    await Promise.all(Array.from({ length: count }, (_, index) => (
      appendNote(dir, { type: 'decision', text: `decision-${index}`, rev: index })
    )));
    const notes = await readNotes(dir);
    expect(notes).toHaveLength(count);
    expect(new Set(notes.map((note) => note.text))).toEqual(
      new Set(Array.from({ length: count }, (_, index) => `decision-${index}`)),
    );
  });
});

describe('notes: tolerant parsing of a hand-edited NOTES.md', () => {
  it('parses a well-formed entry plus a hand-added entry with an unrecognized type and no rev, without throwing', async () => {
    const dir = freshDir();
    await fsp.writeFile(
      path.join(dir, 'NOTES.md'),
      [
        '## [2026-07-17 09:00] policy (rev 3)',
        '最初は落ち着いたトーンで。',
        '',
        '## [2026-07-17 09:30] memo',
        '手編集で追加した謎のtype',
        '- [ ] 一応チェックボックスっぽい行',
        '',
      ].join('\n'),
    );
    const notes = await readNotes(dir);
    expect(notes).toEqual([
      { ts: '2026-07-17 09:00', type: 'policy', rev: 3, text: '最初は落ち着いたトーンで。' },
      {
        ts: '2026-07-17 09:30',
        type: 'memo',
        text: '手編集で追加した謎のtype\n- [ ] 一応チェックボックスっぽい行',
        todos: [{ done: false, text: '一応チェックボックスっぽい行' }],
      },
    ]);
  });

  it('ignores a stray preamble before the first real heading instead of throwing', async () => {
    const dir = freshDir();
    await fsp.writeFile(
      path.join(dir, 'NOTES.md'),
      ['# 手書きのタイトル', 'なんとなく書いた雑談メモ', '', '## [2026-07-17 09:00] decision (rev 1)', '最初のエントリ', ''].join('\n'),
    );
    const notes = await readNotes(dir);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({ ts: '2026-07-17 09:00', type: 'decision', rev: 1, text: '最初のエントリ' });
  });

  it('does not throw on a file with no headings at all', async () => {
    const dir = freshDir();
    await fsp.writeFile(path.join(dir, 'NOTES.md'), 'ただの雑談\n見出しは一つも無い\n');
    await expect(readNotes(dir)).resolves.toEqual([]);
  });
});

describe('notes: markTodoDone', () => {
  it('flips the Nth pending todo (counted across the whole file, in document order) to done, leaving others untouched', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'policy', text: '方針だけのエントリ(todoなし)', rev: 1 });
    await appendNote(dir, { type: 'todo', text: '一つ目のtodo\n二つ目のtodo' });
    await appendNote(dir, { type: 'decision', text: '判断エントリ(todoなし)' });
    await appendNote(dir, { type: 'todo', text: '三つ目のtodo' });

    const result = await markTodoDone(dir, 2);
    expect(result.text).toBe('二つ目のtodo');

    const notes = await readNotes(dir);
    const todoEntries = notes.filter((n) => n.todos);
    expect(todoEntries[0].todos).toEqual([
      { done: false, text: '一つ目のtodo' },
      { done: true, text: '二つ目のtodo' },
    ]);
    expect(todoEntries[1].todos).toEqual([{ done: false, text: '三つ目のtodo' }]);
    // non-todo entries are completely untouched
    expect(notes[0].text).toBe('方針だけのエントリ(todoなし)');
    expect(notes[2].text).toBe('判断エントリ(todoなし)');
  });

  it('marking one todo done does not renumber the remaining pending todos out from under a second markTodoDone call', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: 'a\nb\nc' });
    await markTodoDone(dir, 1); // done: a
    const result = await markTodoDone(dir, 1); // now the first PENDING one is b
    expect(result.text).toBe('b');
    const notes = await readNotes(dir);
    expect(notes[0].todos).toEqual([
      { done: true, text: 'a' },
      { done: true, text: 'b' },
      { done: false, text: 'c' },
    ]);
  });

  it('throws a clear error when the index is out of range', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: 'only one' });
    await expect(markTodoDone(dir, 2)).rejects.toThrow(/no incomplete todo #2/);
  });

  it('throws on a non-positive or non-integer index without touching the file', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: 'x' });
    const before = await readRawFile(dir);
    await expect(markTodoDone(dir, 0)).rejects.toThrow();
    await expect(markTodoDone(dir, -1)).rejects.toThrow();
    await expect(markTodoDone(dir, 1.5)).rejects.toThrow();
    expect(await readRawFile(dir)).toBe(before);
  });

  it('throws a clear error when NOTES.md does not exist yet', async () => {
    const dir = freshDir();
    await expect(markTodoDone(dir, 1)).rejects.toThrow(/NOTES\.md/);
  });

  it('serializes todo completion with a concurrent preference append so neither update disappears', async () => {
    const dir = freshDir();
    await appendNote(dir, { type: 'todo', text: '仕上げを確認する' });
    await Promise.all([
      markTodoDone(dir, 1),
      appendNote(dir, { type: 'pref', text: '余韻は長めに残す' }),
    ]);
    const notes = await readNotes(dir);
    expect(notes.find((note) => note.type === 'todo')?.todos).toEqual([
      { done: true, text: '仕上げを確認する' },
    ]);
    expect(notes.some((note) => note.type === 'pref' && note.text === '余韻は長めに残す')).toBe(true);
  });
});
