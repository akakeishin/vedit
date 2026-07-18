import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePresetsPath } from './statePaths.js';
async function readAll() {
    try {
        return JSON.parse(await fs.readFile(resolvePresetsPath(), 'utf8'));
    }
    catch {
        return {};
    }
}
async function writeAll(presets) {
    const p = resolvePresetsPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(presets, null, 2));
}
export async function savePreset(name, captions, extra) {
    const all = await readAll();
    const preset = { name, captions, extra, savedAt: new Date().toISOString() };
    all[name] = preset;
    await writeAll(all);
    return preset;
}
export async function loadPreset(name) {
    const preset = (await readAll())[name];
    if (!preset)
        throw new Error(`unknown preset: ${name}`);
    return preset;
}
export async function listPresets() {
    return Object.values(await readAll());
}
