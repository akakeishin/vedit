import { expect, test } from '@playwright/test';
import path from 'node:path';
import { setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('project identity precondition', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('project-identity');
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  test('Aで描画済みの操作を保留中にBへ切り替えてもBへcommitしない', async ({ page }) => {
    await page.goto(fx.baseURL);
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });

    let capture!: (route: import('@playwright/test').Route) => void;
    const captured = new Promise<import('@playwright/test').Route>((resolve) => { capture = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/edit', async (route) => {
      capture(route);
      await held;
      await route.continue();
    });

    // The handler is wired globally even while the caption inspector is
    // closed. Dispatching it lets the test hold the exact request emitted by
    // the production api()/mutate() path, not a test-crafted substitute.
    await page.evaluate(() => {
      const toggle = document.getElementById('capEnabledToggle') as HTMLInputElement;
      toggle.checked = !toggle.checked;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const staleRoute = await captured;
    expect(staleRoute.request().headers()['x-vedit-project-dir']).toBe(encodeURIComponent(fx.dir));

    const projectB = path.join(path.dirname(fx.dir), 'project-b');
    const opened = await page.request.post(`${fx.baseURL}/api/open`, {
      data: { dir: projectB, name: 'Project B' },
    });
    expect(opened.ok()).toBeTruthy();
    const beforeB = await (await page.request.get(`${fx.baseURL}/api/state`)).json();

    const responsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/edit') && response.request().method() === 'POST'
    ));
    release();
    const response = await responsePromise;
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe('PROJECT_IDENTITY_MISMATCH');
    await page.unroute('**/api/edit');

    const afterB = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    expect(afterB.revision).toBe(beforeB.revision);
    expect(afterB.sources).toEqual([]);
    await expect(page.locator('#projName')).toHaveText('Project B', { timeout: 10_000 });
  });
});
