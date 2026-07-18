import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const root = new URL('..', import.meta.url);

const cache = mkdtempSync(join(tmpdir(), 'vedit-npm-pack-'));
let raw;
try {
  raw = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
    },
  );
} finally {
  rmSync(cache, { recursive: true, force: true });
}
const report = JSON.parse(raw)[0];
const files = report.files.map(({ path }) => path);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const requiredFiles = [
  'bin/vedit.js',
  'dist/cli.js',
  'LICENSE',
  'scripts/install-agent-skills.mjs',
  'web/app.js',
  'web/index.html',
  'web/style.css',
  'skill/SKILL.md',
];
const missing = requiredFiles.filter((path) => !files.includes(path));

// The agent skill is the executable integration point for presenting the Web
// NLE: a CLI process cannot portably surface an AI client's browser pane.
// Keep the launch contract in the shipped package so an npm install does not
// silently regress to a background-only editing session.
const skillText = readFileSync(new URL('skill/SKILL.md', root), 'utf8');
const requiredSkillContracts = [
  '### 編集セッション開始時のアプリ自動表示',
  '`vedit open --project <dir>`',
  'アプリ内ブラウザ/プレビューペイン',
  '起動条件はプロジェクトの確定であり、素材の有無ではない',
  'ヘルプ、仕様相談、設計レビュー、単なる一覧・診断・レポート取得では自動表示',
];
const missingSkillContracts = requiredSkillContracts.filter((contract) => !skillText.includes(contract));

const expectedBins = {
  vedit: './bin/vedit.js',
  'vedit-install-skills': './scripts/install-agent-skills.mjs',
};
const missingBins = Object.entries(expectedBins).filter(([name, target]) => packageJson.bin?.[name] !== target);
const forbiddenRuntimeDependencies = ['tsx', 'typescript', 'vitest'];
const leakedRuntimeDependencies = forbiddenRuntimeDependencies.filter((name) => packageJson.dependencies?.[name]);

/** Resolve the browser's local static dependency closure from index.html.
 * A hand-maintained npm `files` allowlist is otherwise liable to ship app.js
 * without one of its imported modules — development/E2E stays green while
 * every installed package opens a blank UI. */
function localRefs(file) {
  const full = new URL(file, root);
  if (!existsSync(full)) return [];
  const text = readFileSync(full, 'utf8');
  const refs = [];
  const add = (raw) => {
    const ref = raw.trim().replace(/[?#].*$/, '');
    if (!ref || /^(?:[a-z]+:|\/\/|#|data:)/i.test(ref)) return;
    const resolved = posix.normalize(posix.join(posix.dirname(file), ref));
    if (resolved === '..' || resolved.startsWith('../')) {
      throw new Error(`Browser dependency escapes package root: ${file} -> ${raw}`);
    }
    refs.push(resolved);
  };
  if (file.endsWith('.html')) {
    for (const match of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
    for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?["']([^"']+)["']/g)) add(match[1]);
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1]);
  } else if (file.endsWith('.css')) {
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1]);
  }
  return refs;
}

const browserClosure = new Set(['web/index.html']);
const pending = ['web/index.html'];
while (pending.length) {
  const current = pending.pop();
  for (const dependency of localRefs(current)) {
    if (browserClosure.has(dependency)) continue;
    browserClosure.add(dependency);
    pending.push(dependency);
  }
}
const missingBrowserSources = [...browserClosure].filter((file) => !existsSync(new URL(file, root)));
const missingBrowserPackageFiles = [...browserClosure].filter((file) => !files.includes(file));

const forbidden = files.filter((path) =>
  /(^|\/)(?:e2e|test-results|playwright-report|audits?)(?:\/|$)/i.test(path)
  || /(?:^|\/).*\.(?:test|spec)\.[cm]?[jt]s$/i.test(path)
  || /(?:^|\/)docs\//i.test(path),
);

if (missing.length || missingBins.length || leakedRuntimeDependencies.length || missingSkillContracts.length || missingBrowserSources.length || missingBrowserPackageFiles.length || forbidden.length) {
  if (missing.length) console.error(`Missing package files: ${missing.join(', ')}`);
  if (missingBins.length) console.error(`Missing package bins: ${missingBins.map(([name, target]) => `${name} -> ${target}`).join(', ')}`);
  if (leakedRuntimeDependencies.length) console.error(`Development tools leaked into runtime dependencies: ${leakedRuntimeDependencies.join(', ')}`);
  if (missingSkillContracts.length) console.error(`Missing shipped skill contracts: ${missingSkillContracts.join(', ')}`);
  if (missingBrowserSources.length) console.error(`Missing browser dependency sources: ${missingBrowserSources.join(', ')}`);
  if (missingBrowserPackageFiles.length) console.error(`Browser dependencies omitted from package: ${missingBrowserPackageFiles.join(', ')}`);
  if (forbidden.length) console.error(`Forbidden package files: ${forbidden.join(', ')}`);
  process.exit(1);
}

console.log(
  `Package contents verified: ${files.length} files, ${report.size} packed bytes, `
  + `${report.unpackedSize} unpacked bytes.`,
);
