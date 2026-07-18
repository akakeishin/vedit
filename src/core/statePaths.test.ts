import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolvePresetsPath,
  resolveRegistryPath,
  resolveWhisperModelDir,
} from './statePaths.js';

describe('vedit state paths', () => {
  const fakeHome = path.resolve('/example', 'home');

  it('retains the historical HOME-relative defaults', () => {
    expect(resolveRegistryPath({}, fakeHome))
      .toBe(path.join(fakeHome, '.cache', 'vedit', 'projects.json'));
    expect(resolvePresetsPath({}, fakeHome))
      .toBe(path.join(fakeHome, '.config', 'vedit', 'presets.json'));
    expect(resolveWhisperModelDir({}, fakeHome))
      .toBe(path.join(fakeHome, '.cache', 'vedit', 'models'));
  });

  it('uses independent app-specific overrides without consulting HOME', () => {
    const env = {
      VEDIT_REGISTRY_PATH: './scratch/registry.json',
      VEDIT_PRESETS_PATH: './scratch/presets.json',
      VEDIT_MODEL_DIR: './scratch/models',
    };
    expect(resolveRegistryPath(env, '/must/not/be/used'))
      .toBe(path.resolve('./scratch/registry.json'));
    expect(resolvePresetsPath(env, '/must/not/be/used'))
      .toBe(path.resolve('./scratch/presets.json'));
    expect(resolveWhisperModelDir(env, '/must/not/be/used'))
      .toBe(path.resolve('./scratch/models'));
  });

  it('treats blank overrides as unset', () => {
    const env = {
      VEDIT_REGISTRY_PATH: '   ',
      VEDIT_PRESETS_PATH: '',
      VEDIT_MODEL_DIR: '\t',
    };
    expect(resolveRegistryPath(env, fakeHome))
      .toBe(path.join(fakeHome, '.cache', 'vedit', 'projects.json'));
    expect(resolvePresetsPath(env, fakeHome))
      .toBe(path.join(fakeHome, '.config', 'vedit', 'presets.json'));
    expect(resolveWhisperModelDir(env, fakeHome))
      .toBe(path.join(fakeHome, '.cache', 'vedit', 'models'));
  });
});
