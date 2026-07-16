import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { resolveWithinDir } from './project.js';
import { run, runBinary } from '../ingest/run.js';
import { sha256File } from '../ingest/ingest.js';
import type { KitAsset, KitFile, KitProfile, Manifest } from './types.js';

/**
 * W8 "kit" — a cross-project production-settings directory (see
 * docs/superpowers/specs/2026-07-17-vedit-kit-design.md). This module hosts
 * everything that isn't a plain Manifest edit: kit.json read/write/validate,
 * scaffolding (`kit-init`), the PNG-alpha scan (`kit-scan`), and asset
 * search (`kit-assets`). Sprite CRUD + placement geometry live in ops.ts
 * next to the B-roll overlay section they mirror (see SpriteItem in
 * types.ts); this module is where THOSE ops' `assetId` gets resolved
 * against a loaded kit.
 */

export const KIT_VERSION = 'vedit-kit/v1' as const;

const KIT_SECTIONS = ['profile', 'styles', 'assets', 'audio', 'defaults'] as const;

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- kit.json read/write/validate (impure I/O + pure validation) ----

/**
 * Light shape validation, not a full schema check — every section is
 * optional ("書いた分だけ効く"), so this only rejects clearly-wrong shapes
 * (wrong version, styles/assets missing their required `id`/`path`) rather
 * than enumerating every allowed field. Pure — takes already-parsed JSON.
 */
export function validateKitFile(parsed: unknown, sourceLabel = 'kit.json'): KitFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourceLabel}: expected a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== KIT_VERSION) {
    throw new Error(`${sourceLabel}: unrecognized version ${JSON.stringify(raw.version)} (expected "${KIT_VERSION}")`);
  }
  if (raw.styles !== undefined) {
    if (!Array.isArray(raw.styles) || raw.styles.some((s: any) => !s || typeof s.id !== 'string')) {
      throw new Error(`${sourceLabel}: styles must be an array of objects each with a string "id"`);
    }
  }
  if (raw.assets !== undefined) {
    if (
      !Array.isArray(raw.assets) ||
      raw.assets.some((a: any) => !a || typeof a.id !== 'string' || typeof a.path !== 'string')
    ) {
      throw new Error(`${sourceLabel}: assets must be an array of objects each with a string "id" and "path"`);
    }
  }
  return raw as unknown as KitFile;
}

/** Read + parse + validate a kit directory's kit.json. Throws a clear, actionable error on any failure. */
export async function readKitFile(kitRoot: string): Promise<KitFile> {
  const p = path.join(kitRoot, 'kit.json');
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new Error(`no kit.json in ${kitRoot} (run \`vedit kit-init ${kitRoot}\` first, or check the path)`);
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${p} is not valid JSON`);
  }
  return validateKitFile(parsed, p);
}

/** Atomic write (tmp + rename), matching Project's write convention. */
export async function writeKitFile(kitRoot: string, kit: KitFile): Promise<void> {
  const p = path.join(kitRoot, 'kit.json');
  const tmp = `${p}.tmp-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(kit, null, 2));
  await fs.rename(tmp, p);
}

/** Top-level sections present in a kit file, for `kit-link`/`vedit kit`'s "認識したセクション" report. */
export function recognizedKitSections(kit: KitFile): string[] {
  return KIT_SECTIONS.filter((k) => kit[k] !== undefined);
}

// ---- defaults application (pure) ----

/**
 * Apply a kit's `defaults` to a manifest at link time. Only `captions_style`
 * maps onto a real stored Manifest field today — `export_preset`/
 * `reframe_focus` have no persistent manifest slot (they're per-invocation
 * CLI flags), so those are consulted directly by the CLI at the point of use
 * (see `vedit export render` / `vedit reframe`) rather than applied here.
 */
export function applyKitDefaults(m: Manifest, kit: KitFile): { manifest: Manifest; applied: string[] } {
  const applied: string[] = [];
  let manifest = m;
  const style = kit.defaults?.captions_style;
  if (style) {
    manifest = { ...manifest, captions: { ...manifest.captions, style } };
    applied.push(`captions_style -> ${style}`);
  }
  return { manifest, applied };
}

// ---- profile highlights (pure) — surfaced by `vedit kit` / `vedit resume` ----

export interface KitProfileHighlights {
  tone_tags?: string[];
  duration_seconds?: KitProfile['duration_seconds'];
  pacing?: KitProfile['pacing'];
  spine?: string[];
  quiet_pause_policy?: string;
}

/** Non-empty profile fields only, or null when the kit has no profile section at all (or every field is empty). */
export function kitProfileHighlights(kit: KitFile | null | undefined): KitProfileHighlights | null {
  const profile = kit?.profile;
  if (!profile) return null;
  const out: KitProfileHighlights = {};
  if (profile.tone_tags?.length) out.tone_tags = profile.tone_tags;
  if (profile.duration_seconds) out.duration_seconds = profile.duration_seconds;
  if (profile.pacing) out.pacing = profile.pacing;
  if (profile.spine?.length) out.spine = profile.spine;
  if (profile.quiet_pause_policy) out.quiet_pause_policy = profile.quiet_pause_policy;
  return Object.keys(out).length ? out : null;
}

// ---- kit-init scaffolding (impure) ----

const GUIDE_TEMPLATE = (name: string) => `# ${name} — 制作ガイド

このファイルはディレクター(Claude)が \`vedit kit\` / \`vedit resume\` の際に
Read する自由記述のガイドです。kit.json の profile では表現しきれない
ニュアンス(NGワード、口調の具体例、構成の型の運用ルールなど)をここに書く。
コードはこのファイルを解釈しません(機械的強制はしない)。

## トーン

<!-- 例: 淡々としつつ時々ボケる。煽り系のテロップは使わない -->

## 構成の型(spine)

<!-- 例: 掴み(honest_hook) → 展開 → 見せ場 → 余韻(quiet_aftertaste) -->

## NG事項

<!-- 例: BGMは著作権フリーのみ。顔出しNGのカットは使わない -->

## キャラクター/素材の使い方

<!-- assets/ 以下のキャラ・背景・小物の組み合わせルールや使いどころ -->
`;

/**
 * `vedit kit-init <dir> --name <name>`: create the standard kit directory
 * tree (kit.json, GUIDE.md, fonts/, assets/{characters,backgrounds,props}).
 * Idempotent and non-destructive — an existing kit.json/GUIDE.md is left
 * untouched (re-running kit-init on a populated kit never clobbers scanned
 * assets/authored guide text); only missing pieces are created.
 */
export async function scaffoldKit(dir: string, name: string): Promise<{ created: string[]; existed: string[] }> {
  const created: string[] = [];
  const existed: string[] = [];
  const dirs = [
    dir,
    path.join(dir, 'fonts'),
    path.join(dir, 'assets', 'characters'),
    path.join(dir, 'assets', 'backgrounds'),
    path.join(dir, 'assets', 'props'),
  ];
  for (const d of dirs) await fs.mkdir(d, { recursive: true });

  const kitJsonPath = path.join(dir, 'kit.json');
  if (await pathExists(kitJsonPath)) {
    existed.push('kit.json');
  } else {
    await writeKitFile(dir, { version: KIT_VERSION, name });
    created.push('kit.json');
  }

  const guidePath = path.join(dir, 'GUIDE.md');
  if (await pathExists(guidePath)) {
    existed.push('GUIDE.md');
  } else {
    await fs.writeFile(guidePath, GUIDE_TEMPLATE(name));
    created.push('GUIDE.md');
  }

  return { created, existed };
}

// ---- kit-scan: PNG alpha -> visible_bounds_normalized / ground_anchor_normalized (pure math + impure I/O) ----

export interface AlphaGeometry {
  visible_bounds_normalized: { x0: number; y0: number; x1: number; y1: number };
  ground_anchor_normalized: { x: number; y: number };
}

/** Alpha values at/below this (0..255) count as "transparent" — filters out PNG's near-invisible anti-aliasing fringe. */
export const DEFAULT_ALPHA_THRESHOLD = 10;

/**
 * Pure alpha-geometry math: given a decoded RGBA buffer, find the bounding
 * box of alpha-visible pixels (`visible_bounds_normalized`) and the
 * alpha-weighted centroid of its BOTTOM-most visible row — the character's
 * "feet" (`ground_anchor_normalized`) — both normalized 0..1 against the
 * full image. Returns null for a fully-transparent (or zero-sized) image.
 */
export function computeAlphaGeometry(
  width: number,
  height: number,
  rgba: Uint8Array,
  threshold = DEFAULT_ALPHA_THRESHOLD,
): AlphaGeometry | null {
  if (width <= 0 || height <= 0) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const a = rgba[(rowBase + x) * 4 + 3];
      if (a > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent

  let sumX = 0;
  let sumW = 0;
  const bottomRowBase = maxY * width;
  for (let x = 0; x < width; x++) {
    const a = rgba[(bottomRowBase + x) * 4 + 3];
    if (a > threshold) {
      sumX += x * a;
      sumW += a;
    }
  }
  const anchorX = sumW > 0 ? sumX / sumW : (minX + maxX) / 2;

  return {
    visible_bounds_normalized: { x0: minX / width, y0: minY / height, x1: (maxX + 1) / width, y1: (maxY + 1) / height },
    ground_anchor_normalized: { x: anchorX / width, y: (maxY + 1) / height },
  };
}

async function probeImageDims(absPath: string): Promise<{ width: number; height: number }> {
  const out = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    absPath,
  ]);
  const [w, h] = out.trim().split('x').map(Number);
  if (!w || !h) throw new Error(`could not determine image dimensions: ${absPath}`);
  return { width: w, height: h };
}

/**
 * Decode a PNG's alpha channel via ffmpeg (rawvideo rgba pipe — no PNG
 * decoder dependency added) and compute its alpha geometry. Returns null
 * for a fully-transparent image (nothing to anchor).
 */
export async function scanAssetAlpha(absPath: string): Promise<(AlphaGeometry & { width: number; height: number }) | null> {
  const { width, height } = await probeImageDims(absPath);
  const buf = await runBinary('ffmpeg', ['-v', 'error', '-i', absPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const rgba = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const geo = computeAlphaGeometry(width, height, rgba);
  return geo ? { ...geo, width, height } : null;
}

// ---- asset discovery (impure fs walk) + id/type inference (pure) ----

async function walkPngs(dir: string, base: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkPngs(full, base)));
    } else if (e.isFile() && /\.png$/i.test(e.name)) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Every PNG under `<kitRoot>/assets/`, recursively, as kit-root-relative POSIX paths (e.g. "assets/characters/foo.png"). */
export async function listAssetPngs(kitRoot: string): Promise<string[]> {
  return walkPngs(path.join(kitRoot, 'assets'), kitRoot);
}

/** assets/characters -> sprite, assets/backgrounds -> background, anything else under assets/ -> prop. */
export function inferAssetType(relPath: string): KitAsset['type'] {
  const top = relPath.split('/')[1];
  if (top === 'characters') return 'sprite';
  if (top === 'backgrounds') return 'background';
  return 'prop';
}

/** Filename (no extension), sanitized to a safe id charset, deduped against `existingIds` with a numeric suffix. */
export function deriveAssetId(relPath: string, existingIds: ReadonlySet<string>): string {
  const stem = path.basename(relPath, path.extname(relPath));
  const base = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

export interface ScanKitResult {
  kit: KitFile;
  /** New KitAsset entries auto-registered from a PNG with no existing entry. */
  added: string[];
  /** Existing entries whose bounds/anchor/width/height were (re)computed. */
  scanned: string[];
  /** Existing entries already fully scanned, left untouched (unless `force`). */
  skipped: string[];
  warnings: string[];
}

/**
 * Full `vedit kit-scan` pipeline: discover PNGs under assets/ not yet
 * present in kit.json (auto-register them — "手作業ゼロで素材を足せる"),
 * then compute visible_bounds_normalized/ground_anchor_normalized/width/
 * height for every asset missing them (or every asset when `force`).
 * Returns the updated KitFile; the caller (CLI) writes it back so this stays
 * a pure-ish orchestration step callers can inspect before committing.
 */
export async function scanKit(kitRoot: string, kit: KitFile, opts: { force?: boolean } = {}): Promise<ScanKitResult> {
  const assets = [...(kit.assets ?? [])];
  const byPath = new Map(assets.map((a) => [a.path, a]));
  const existingIds = new Set(assets.map((a) => a.id));
  const added: string[] = [];

  const pngs = await listAssetPngs(kitRoot);
  for (const rel of pngs) {
    if (byPath.has(rel)) continue;
    const id = deriveAssetId(rel, existingIds);
    existingIds.add(id);
    const asset: KitAsset = { id, path: rel, type: inferAssetType(rel) };
    assets.push(asset);
    byPath.set(rel, asset);
    added.push(id);
  }

  const scanned: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const hasBoth = Boolean(a.visible_bounds_normalized && a.ground_anchor_normalized && a.width && a.height);
    if (hasBoth && !opts.force) {
      skipped.push(a.id);
      continue;
    }
    let abs: string;
    try {
      abs = await resolveWithinDir(kitRoot, a.path);
    } catch {
      warnings.push(`asset ${a.id}: path escapes kit directory (${a.path}); skipped`);
      continue;
    }
    let geo: (AlphaGeometry & { width: number; height: number }) | null;
    try {
      geo = await scanAssetAlpha(abs);
    } catch (e: any) {
      warnings.push(`asset ${a.id}: could not scan (${e?.message ?? e})`);
      continue;
    }
    if (!geo) {
      warnings.push(`asset ${a.id}: fully transparent image; bounds/anchor left unset`);
      continue;
    }
    assets[i] = {
      ...a,
      visible_bounds_normalized: geo.visible_bounds_normalized,
      ground_anchor_normalized: geo.ground_anchor_normalized,
      width: geo.width,
      height: geo.height,
    };
    scanned.push(a.id);
  }

  return { kit: { ...kit, assets }, added, scanned, skipped, warnings };
}

// ---- kit-assets search + packed listing (pure) ----

export function searchKitAssets(assets: KitAsset[] | undefined, opts: { tag?: string; emotion?: string } = {}): KitAsset[] {
  return (assets ?? []).filter((a) => {
    if (opts.tag && !(a.tags ?? []).includes(opts.tag)) return false;
    if (opts.emotion && a.emotion !== opts.emotion) return false;
    return true;
  });
}

export function packKitAssets(assets: KitAsset[]): string {
  if (assets.length === 0) return '(no matching assets; add PNGs under assets/ and run `vedit kit-scan`)';
  const lines = assets.map((a) => {
    const tags = a.tags?.length ? ` tags=${a.tags.join(',')}` : '';
    const emo = a.emotion ? ` emotion=${a.emotion}` : '';
    const unscanned = a.visible_bounds_normalized && a.ground_anchor_normalized ? '' : ' [unscanned]';
    return `${a.id} [${a.type}] ${a.path}${tags}${emo}${unscanned}`;
  });
  return [`# kit assets (${assets.length})`, `# id [type] path tags emotion [unscanned = run \`vedit kit-scan\`]`, ...lines].join('\n');
}

// ---- resolving assetId -> validated absolute path (impure; used at render/serve time) ----

export interface ResolvedKitAsset extends KitAsset {
  /** Validated absolute path (resolveWithinDir(kitRoot, asset.path)). */
  absPath: string;
}

/**
 * Resolve a set of KitAsset ids to validated absolute paths, for render/web
 * use. Never throws for a single bad asset — an unknown id, an escaping
 * path, or (when the asset carries a sha256) a content mismatch each produce
 * a warning and are simply left out of the result map, so one stale kit
 * entry doesn't take down a whole render (spec: sha256 mismatch is a
 * warning, not a hard failure — asset-pack redistribution is respected by
 * never embedding the asset bytes into exported project files, see otio.ts).
 */
export async function resolveKitAssets(
  kitRoot: string,
  kit: KitFile,
  assetIds: Iterable<string>,
): Promise<{ resolved: Map<string, ResolvedKitAsset>; warnings: string[] }> {
  const byId = new Map((kit.assets ?? []).map((a) => [a.id, a]));
  const resolved = new Map<string, ResolvedKitAsset>();
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const id of assetIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const asset = byId.get(id);
    if (!asset) {
      warnings.push(`kit asset ${id}: not found in kit.json`);
      continue;
    }
    let abs: string;
    try {
      abs = await resolveWithinDir(kitRoot, asset.path);
    } catch {
      warnings.push(`kit asset ${id}: path escapes kit directory (${asset.path})`);
      continue;
    }
    if (asset.sha256) {
      try {
        const actual = await sha256File(abs);
        if (actual !== asset.sha256) {
          warnings.push(`kit asset ${id}: sha256 mismatch (file changed since \`vedit kit-scan\`?) — using it anyway`);
        }
      } catch {
        warnings.push(`kit asset ${id}: file unreadable (${abs})`);
        continue;
      }
    }
    resolved.set(id, { ...asset, absPath: abs });
  }
  return { resolved, warnings };
}
