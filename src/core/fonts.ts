import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveWithinDir } from './project.js';

/**
 * Font enumeration (W-CAP "NLE 内での字幕編集"): lists a linked kit's font
 * FILES and this machine's installed SYSTEM font families, for the web
 * caption style popover's font <select> (grouped kit/system — GET
 * /api/fonts in server/daemon.ts) and for export/render.ts's "font not
 * found anywhere" render-time warning.
 *
 * Kit fonts are re-scanned fresh on every call (a kit's fonts/ directory is
 * small — same "read fresh every time" convention as readKitFile in
 * kit.ts). System font scanning walks /System/Library/Fonts +
 * /Library/Fonts + ~/Library/Fonts, which can be slow (hundreds of files)
 * the first time — see listSystemFonts's memory+disk cache.
 */

export interface KitFontEntry {
  /** Font FILE's basename without extension — the ASS Fontname / CaptionSettings.overrides.font convention (matches kitAssStyle in export/render.ts). */
  name: string;
  /** Resolved via `fc-list` when available; absent when fc-list isn't installed or didn't recognize the file. */
  family?: string;
  /** Kit-root-relative path (POSIX separators), e.g. "fonts/MyFont-Bold.ttf". */
  path: string;
}

export interface SystemFontEntry {
  family: string;
}

export interface FontList {
  kit: KitFontEntry[];
  system: SystemFontEntry[];
}

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];
const FONT_EXTENSION_SET = new Set(FONT_EXTENSIONS);

function systemFontDirs(): string[] {
  return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

async function walkFontFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFontFiles(full)));
    } else if (e.isFile() && FONT_EXTENSION_SET.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `fc-list :file family` -> Map<absolute file path, family name>, or null
 * when `fc-list` isn't installed (fontconfig isn't a macOS default; common
 * on Linux/CI, or via `brew install fontconfig`) — callers fall back to the
 * font file's basename (extension stripped) as the family guess. Cached for
 * the process lifetime: fc-list's own cache already makes repeat calls
 * cheap, but this avoids re-spawning the process on every font list.
 */
let fcListCache: Map<string, string> | null | undefined;
async function fcListFamilies(): Promise<Map<string, string> | null> {
  if (fcListCache !== undefined) return fcListCache;
  fcListCache = await new Promise<Map<string, string> | null>((resolve) => {
    execFile('fc-list', [':', 'file', 'family'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const map = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        const m = /^(.+?):\s*(.+)$/.exec(line.trim());
        if (!m) continue;
        const family = m[2].split(',')[0].trim();
        if (family) map.set(m[1], family);
      }
      resolve(map);
    });
  });
  return fcListCache;
}

function familyForFile(file: string, fc: Map<string, string> | null): string {
  return fc?.get(file) ?? path.basename(file, path.extname(file));
}

/** Uncached filesystem walk of the system font directories -> deduped, sorted family names. */
export async function scanSystemFonts(): Promise<SystemFontEntry[]> {
  const files: string[] = [];
  for (const dir of systemFontDirs()) files.push(...(await walkFontFiles(dir)));
  const fc = await fcListFamilies();
  const families = new Set<string>();
  for (const f of files) families.add(familyForFile(f, fc));
  return [...families].sort((a, b) => a.localeCompare(b)).map((family) => ({ family }));
}

/** Every font file under `<kitRoot>/fonts/` (walked recursively, so a kit that organizes fonts into weight/family subfolders still gets picked up). */
export async function scanKitFonts(kitRoot: string): Promise<KitFontEntry[]> {
  const files = await walkFontFiles(path.join(kitRoot, 'fonts'));
  const fc = await fcListFamilies();
  return files
    .map((f) => ({
      name: path.basename(f, path.extname(f)),
      family: fc?.get(f),
      path: path.relative(kitRoot, f).split(path.sep).join('/'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface FontCacheShape {
  at: number;
  system: SystemFontEntry[];
}
let memCache: FontCacheShape | null = null;

/**
 * System fonts with memory + (when `cacheFilePath` is given) disk caching,
 * 1-day TTL — the filesystem walk can be slow the first time (hundreds of
 * files under /System/Library/Fonts), so repeat calls within the TTL reuse
 * the cached list instead of rescanning ("非同期・初回のみ重くて可").
 * `cacheFilePath` is the daemon's per-project `cache/fonts.json` (see GET
 * /api/fonts in daemon.ts), which also survives a daemon restart; a
 * one-shot caller with no project handle (export/render.ts's font-not-found
 * warning) passes null and gets memory-only caching (no benefit across
 * process restarts, but still avoids rescanning twice in one process).
 */
export async function listSystemFonts(cacheFilePath: string | null): Promise<SystemFontEntry[]> {
  const now = Date.now();
  if (memCache && now - memCache.at < CACHE_TTL_MS) return memCache.system;
  if (cacheFilePath) {
    try {
      const raw = JSON.parse(await fs.readFile(cacheFilePath, 'utf8')) as FontCacheShape;
      if (raw && typeof raw.at === 'number' && now - raw.at < CACHE_TTL_MS && Array.isArray(raw.system)) {
        memCache = raw;
        return raw.system;
      }
    } catch {
      // no cache yet, or corrupt/stale — fall through to a fresh scan
    }
  }
  const system = await scanSystemFonts();
  memCache = { at: now, system };
  if (cacheFilePath) {
    try {
      await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
      await fs.writeFile(cacheFilePath, JSON.stringify(memCache));
    } catch {
      // disk cache is a best-effort speedup, never fatal
    }
  }
  return system;
}

/**
 * Resolve a `CaptionSettings.overrides.font` value against
 * `<kitRoot>/fonts/`, trying it as-is first, then every known font
 * extension when it has none (so "MyFont-Bold" resolves the same as
 * "MyFont-Bold.ttf"). Returns the validated absolute path, or null when
 * nothing under fonts/ matches — the caller (renderFinal) then treats the
 * value as a system font family name instead (libass/CoreType resolve it
 * directly at render time; no fontsdir needed).
 */
export async function resolveKitFontFile(kitRoot: string, fontRef: string): Promise<string | null> {
  const candidates = path.extname(fontRef) ? [fontRef] : FONT_EXTENSIONS.map((ext) => `${fontRef}${ext}`);
  for (const name of candidates) {
    let abs: string;
    try {
      abs = await resolveWithinDir(kitRoot, path.posix.join('fonts', name));
    } catch {
      continue; // escapes the kit dir — not a valid candidate
    }
    try {
      await fs.access(abs);
      return abs;
    } catch {
      // this candidate doesn't exist; try the next extension
    }
  }
  return null;
}

/** Test-only: reset the module-level caches so tests don't leak state across cases. */
export function _resetFontCacheForTests(): void {
  memCache = null;
  fcListCache = undefined;
}
