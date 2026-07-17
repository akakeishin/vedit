import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// fonts.ts walks real font directories (system font dirs, a kit's fonts/)
// and shells out to `fc-list` — both mocked here so the parsing/caching
// logic is tested in isolation, deterministically, regardless of what's
// actually installed on the test host (spec: "フォント一覧のパース(fsモック)").
// resolveWithinDir (used internally by resolveKitFontFile) still calls the
// REAL fs.realpath — harmless here since it always ENOENTs against these
// made-up paths, which resolveWithinDir already tolerates (string-level
// containment check is all a not-yet-existing path needs).

interface FakeEntry {
  name: string;
  dir: boolean;
}
const fakeDirs = new Map<string, FakeEntry[]>();
const fakeFiles = new Map<string, string>();

function enoent(): NodeJS.ErrnoException {
  const e = new Error('ENOENT') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return e;
}

function addDir(dirPath: string, entries: FakeEntry[]) {
  fakeDirs.set(path.resolve(dirPath), entries);
}
function addFile(filePath: string, content = '') {
  fakeFiles.set(path.resolve(filePath), content);
}
function resetFakeFs() {
  fakeDirs.clear();
  fakeFiles.clear();
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = {
    readdir: async (dir: string, _opts?: unknown) => {
      const entries = fakeDirs.get(path.resolve(String(dir)));
      if (!entries) throw enoent();
      return entries.map((e) => ({ name: e.name, isDirectory: () => e.dir, isFile: () => !e.dir }));
    },
    access: async (p: string) => {
      const abs = path.resolve(String(p));
      if (fakeFiles.has(abs)) return;
      for (const [dir, entries] of fakeDirs) {
        for (const e of entries) {
          if (!e.dir && path.join(dir, e.name) === abs) return;
        }
      }
      throw enoent();
    },
    readFile: async (p: string, _enc?: string) => {
      const abs = path.resolve(String(p));
      if (fakeFiles.has(abs)) return fakeFiles.get(abs)!;
      throw enoent();
    },
    writeFile: async (p: string, data: unknown) => {
      fakeFiles.set(path.resolve(String(p)), String(data));
    },
    mkdir: async () => undefined,
    realpath: actual.promises.realpath,
  };
  return { ...actual, promises };
});

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

/** Simulate `fc-list` not being installed at all (the common case on a bare macOS box). */
function fcListMissing() {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(new Error('spawn fc-list ENOENT'), '');
  });
}
/** Simulate `fc-list :file family` succeeding with the given file->family pairs. */
function fcListSucceeds(pairs: [string, string][]) {
  const stdout = pairs.map(([file, family]) => `${file}: ${family}`).join('\n');
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(null, stdout);
  });
}

let fontsMod: typeof import('./fonts.js');

beforeEach(async () => {
  resetFakeFs();
  execFileMock.mockReset();
  fcListMissing();
  vi.resetModules(); // fonts.ts's memCache/fcListCache are module-level — force a fresh module per test
  fontsMod = await import('./fonts.js');
});
afterEach(() => {
  fontsMod._resetFontCacheForTests();
});

describe('scanSystemFonts', () => {
  it('lists deduped family names from the system font directories, falling back to the filename (extension stripped) when fc-list is unavailable', async () => {
    addDir('/System/Library/Fonts', [
      { name: 'Helvetica.ttc', dir: false },
      { name: 'Zapfino.ttf', dir: false },
      { name: 'readme.txt', dir: false }, // non-font extension: ignored
    ]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const fonts = await fontsMod.scanSystemFonts();
    expect(fonts).toEqual([{ family: 'Helvetica' }, { family: 'Zapfino' }]); // sorted
  });

  it('uses fc-list family names over the filename guess when fc-list is available', async () => {
    const helveticaPath = path.resolve('/System/Library/Fonts/Helvetica.ttc');
    addDir('/System/Library/Fonts', [{ name: 'Helvetica.ttc', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    fcListSucceeds([[helveticaPath, 'Helvetica Neue, Bold']]); // fc-list can list multiple comma-separated aliases; first wins
    const fonts = await fontsMod.scanSystemFonts();
    expect(fonts).toEqual([{ family: 'Helvetica Neue' }]);
  });

  it('recurses into subdirectories', async () => {
    addDir('/System/Library/Fonts', [{ name: 'Sub', dir: true }]);
    addDir('/System/Library/Fonts/Sub', [{ name: 'Nested.otf', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const fonts = await fontsMod.scanSystemFonts();
    expect(fonts).toEqual([{ family: 'Nested' }]);
  });

  it('a missing font directory contributes nothing, without throwing', async () => {
    // Only register two of the three well-known dirs — the third stays
    // entirely absent from fakeDirs, so readdir ENOENTs for it.
    addDir('/System/Library/Fonts', [{ name: 'OnlyOne.ttf', dir: false }]);
    addDir('/Library/Fonts', []);
    const fonts = await fontsMod.scanSystemFonts();
    expect(fonts).toEqual([{ family: 'OnlyOne' }]);
  });

  it('dedupes families shared by multiple font files (e.g. regular + bold weights)', async () => {
    addDir('/System/Library/Fonts', [{ name: 'Arial.ttf', dir: false }, { name: 'Arial-Bold.ttf', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const arial = path.resolve('/System/Library/Fonts/Arial.ttf');
    const arialBold = path.resolve('/System/Library/Fonts/Arial-Bold.ttf');
    fcListSucceeds([[arial, 'Arial'], [arialBold, 'Arial']]);
    const fonts = await fontsMod.scanSystemFonts();
    expect(fonts).toEqual([{ family: 'Arial' }]);
  });
});

describe('scanKitFonts', () => {
  it('lists font files under <kitRoot>/fonts/ as {name, path}, name = basename without extension', async () => {
    addDir('/kit1/fonts', [{ name: 'MyFont-Bold.ttf', dir: false }]);
    const fonts = await fontsMod.scanKitFonts('/kit1');
    expect(fonts).toEqual([{ name: 'MyFont-Bold', family: undefined, path: 'fonts/MyFont-Bold.ttf' }]);
  });

  it('includes the fc-list family when available', async () => {
    addDir('/kit1/fonts', [{ name: 'MyFont-Bold.ttf', dir: false }]);
    fcListSucceeds([[path.resolve('/kit1/fonts/MyFont-Bold.ttf'), 'My Font']]);
    const fonts = await fontsMod.scanKitFonts('/kit1');
    expect(fonts).toEqual([{ name: 'MyFont-Bold', family: 'My Font', path: 'fonts/MyFont-Bold.ttf' }]);
  });

  it('returns an empty list when the kit has no fonts/ directory at all', async () => {
    const fonts = await fontsMod.scanKitFonts('/kit-with-no-fonts-dir');
    expect(fonts).toEqual([]);
  });

  it('sorts by name and walks subfolders (e.g. a kit organizing fonts by weight)', async () => {
    addDir('/kit1/fonts', [{ name: 'Weights', dir: true }, { name: 'Zeta.ttf', dir: false }]);
    addDir('/kit1/fonts/Weights', [{ name: 'Alpha.ttf', dir: false }]);
    const fonts = await fontsMod.scanKitFonts('/kit1');
    expect(fonts.map((f) => f.name)).toEqual(['Alpha', 'Zeta']);
    expect(fonts.find((f) => f.name === 'Alpha')!.path).toBe('fonts/Weights/Alpha.ttf');
  });
});

describe('listSystemFonts caching', () => {
  it('scans once, then serves subsequent calls (within the TTL) from the in-memory cache without re-scanning', async () => {
    addDir('/System/Library/Fonts', [{ name: 'A.ttf', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const first = await fontsMod.listSystemFonts(null);
    expect(first).toEqual([{ family: 'A' }]);

    // Mutate the fake filesystem — if the second call rescanned, it would see this.
    addDir('/System/Library/Fonts', [{ name: 'A.ttf', dir: false }, { name: 'B.ttf', dir: false }]);
    const second = await fontsMod.listSystemFonts(null);
    expect(second).toEqual([{ family: 'A' }]); // still the cached result, not rescanned
  });

  it('persists to a disk cache file when a path is given, and reuses it after the in-memory cache is reset (simulating a daemon restart)', async () => {
    addDir('/System/Library/Fonts', [{ name: 'A.ttf', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const cachePath = '/project/cache/fonts.json';
    await fontsMod.listSystemFonts(cachePath);
    expect(fakeFiles.has(path.resolve(cachePath))).toBe(true);

    // Simulate a fresh process: drop the in-memory cache, and change the
    // filesystem underneath so a rescan (if it happened) would be visible.
    fontsMod._resetFontCacheForTests();
    addDir('/System/Library/Fonts', [{ name: 'A.ttf', dir: false }, { name: 'B.ttf', dir: false }]);
    const second = await fontsMod.listSystemFonts(cachePath);
    expect(second).toEqual([{ family: 'A' }]); // came from the disk cache, not a rescan
  });

  it('rescans when the disk cache is older than the 1-day TTL', async () => {
    const cachePath = '/project/cache/fonts.json';
    addFile(cachePath, JSON.stringify({ at: Date.now() - 25 * 60 * 60 * 1000, system: [{ family: 'Stale' }] }));
    addDir('/System/Library/Fonts', [{ name: 'Fresh.ttf', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const fonts = await fontsMod.listSystemFonts(cachePath);
    expect(fonts).toEqual([{ family: 'Fresh' }]);
  });

  it('rescans (without crashing) when the disk cache file is corrupt JSON', async () => {
    const cachePath = '/project/cache/fonts.json';
    addFile(cachePath, '{not json');
    addDir('/System/Library/Fonts', [{ name: 'Fresh.ttf', dir: false }]);
    addDir('/Library/Fonts', []);
    addDir(path.join(os.homedir(), 'Library', 'Fonts'), []);
    const fonts = await fontsMod.listSystemFonts(cachePath);
    expect(fonts).toEqual([{ family: 'Fresh' }]);
  });
});

describe('resolveKitFontFile', () => {
  it('resolves an exact filename', async () => {
    addDir('/kit1/fonts', [{ name: 'MyFont-Bold.ttf', dir: false }]);
    const resolved = await fontsMod.resolveKitFontFile('/kit1', 'MyFont-Bold.ttf');
    expect(resolved).toBe(path.resolve('/kit1/fonts/MyFont-Bold.ttf'));
  });

  it('resolves an extension-less reference by trying known font extensions', async () => {
    addDir('/kit1/fonts', [{ name: 'MyFont-Bold.otf', dir: false }]);
    const resolved = await fontsMod.resolveKitFontFile('/kit1', 'MyFont-Bold');
    expect(resolved).toBe(path.resolve('/kit1/fonts/MyFont-Bold.otf'));
  });

  it('returns null when nothing under fonts/ matches', async () => {
    addDir('/kit1/fonts', [{ name: 'Other.ttf', dir: false }]);
    const resolved = await fontsMod.resolveKitFontFile('/kit1', 'NoSuchFont');
    expect(resolved).toBeNull();
  });

  it('returns null (never throws) for a path-traversal attempt instead of escaping the kit directory', async () => {
    const resolved = await fontsMod.resolveKitFontFile('/kit1', '../../etc/passwd');
    expect(resolved).toBeNull();
  });
});
