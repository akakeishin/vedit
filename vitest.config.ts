import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // See test/setup.ts: points vedit-specific state paths at a scratch dir
    // for every test file without changing HOME.
    setupFiles: ['./test/setup.ts'],
    // e2e/**/*.spec.ts are Playwright specs (import '@playwright/test', run
    // via `npm run test:e2e`) — vitest's default include glob matches
    // *.spec.ts too, so without this exclude vitest would also try to
    // collect them here and fail on the unresolvable import.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
