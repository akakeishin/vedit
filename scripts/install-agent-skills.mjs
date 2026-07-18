#!/usr/bin/env node

import { lstat, mkdir, readlink, rename, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const known = new Set(['--all', '--codex', '--claude', '--force', '--help']);
const unknown = [...args].filter((arg) => !known.has(arg));

if (args.has('--help')) {
  console.log(`Usage: vedit-install-skills [--all|--codex|--claude] [--force]

Installs the bundled vedit skill for Codex and/or Claude Code.
The default is --all. Existing non-symlink installs are preserved unless
--force is given; forced replacements are moved to a timestamped backup.`);
  process.exit(0);
}

if (unknown.length) {
  console.error(`unknown option: ${unknown.join(', ')}`);
  process.exit(2);
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(packageRoot, 'skill');
const explicitSelection = args.has('--codex') || args.has('--claude');
const targets = [
  ...(!explicitSelection || args.has('--codex')
    ? [{ name: 'Codex', root: process.env.VEDIT_CODEX_SKILLS_DIR ?? path.join(homedir(), '.codex', 'skills') }]
    : []),
  ...(!explicitSelection || args.has('--claude')
    ? [{ name: 'Claude Code', root: process.env.VEDIT_CLAUDE_SKILLS_DIR ?? path.join(homedir(), '.claude', 'skills') }]
    : []),
];

async function statOrNull(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function backupSuffix() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

for (const target of targets) {
  await mkdir(target.root, { recursive: true });
  const destination = path.join(target.root, 'vedit');
  const existing = await statOrNull(destination);

  if (existing?.isSymbolicLink()) {
    const linked = path.resolve(path.dirname(destination), await readlink(destination));
    if (linked === source) {
      console.log(`${target.name}: already installed (${destination})`);
      continue;
    }
  }

  if (existing) {
    if (!args.has('--force')) {
      console.error(`${target.name}: ${destination} already exists; rerun with --force to preserve it as a backup and install vedit`);
      process.exitCode = 1;
      continue;
    }
    const backup = `${destination}.backup-${backupSuffix()}`;
    await rename(destination, backup);
    console.log(`${target.name}: preserved existing install at ${backup}`);
  }

  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`${target.name}: installed ${destination} -> ${source}`);
}
