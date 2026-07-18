import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'vedit-install-check-'));
const packDir = path.join(scratch, 'pack');
const prefix = path.join(scratch, 'prefix');
const npmCache = path.join(scratch, 'npm-cache');
const codexSkills = path.join(scratch, 'codex-skills');
const claudeSkills = path.join(scratch, 'claude-skills');

try {
  mkdirSync(packDir, { recursive: true });
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', packDir,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  }))[0];
  const tarball = path.join(packDir, packed.filename);

  execFileSync('npm', [
    'install', '--global', tarball, '--prefix', prefix, '--ignore-scripts',
  ], {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, npm_config_cache: npmCache },
  });

  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const veditBin = path.join(binDir, process.platform === 'win32' ? 'vedit.cmd' : 'vedit');
  const installerBin = path.join(binDir, process.platform === 'win32' ? 'vedit-install-skills.cmd' : 'vedit-install-skills');
  const help = execFileSync(veditBin, ['--help'], { encoding: 'utf8' });
  if (!help.includes('vedit')) throw new Error('installed vedit --help did not identify the CLI');

  execFileSync(installerBin, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VEDIT_CODEX_SKILLS_DIR: codexSkills,
      VEDIT_CLAUDE_SKILLS_DIR: claudeSkills,
    },
  });

  for (const destination of [path.join(codexSkills, 'vedit'), path.join(claudeSkills, 'vedit')]) {
    const skillRoot = path.resolve(path.dirname(destination), readlinkSync(destination));
    if (!existsSync(path.join(skillRoot, 'SKILL.md'))) throw new Error(`installed skill is incomplete: ${destination}`);
  }

  console.log(`Install verified from ${packed.filename}: CLI + Codex skill + Claude Code skill.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
