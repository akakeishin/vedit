import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // See test/setup.ts: points HOME at a scratch dir for every test file
    // so nothing in the suite can write into the developer's real
    // ~/.cache/vedit/projects.json or ~/.config/vedit/presets.json.
    setupFiles: ['./test/setup.ts'],
  },
});
