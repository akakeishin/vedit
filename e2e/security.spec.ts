import { expect, test } from '@playwright/test';
import { projectIdentityHeaders, setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('local daemon browser security', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('security');
    const state = await (await fetch(`${fx.baseURL}/api/state`)).json();
    const marker = '/api/edit?custom-html-onerror=1';
    const hostileHtml = [
      '<div id="custom-safe" style="position:absolute;inset:20%;display:grid;place-items:center;background:#123;color:#fff">',
      '<strong>SAFE CUSTOM MARKUP</strong></div>',
      `<img src="/missing-custom-html-image" onerror="fetch('${marker}',{method:'POST',headers:{'content-type':'application/json','x-vedit-project-dir':'${encodeURIComponent(fx.dir)}'},body:JSON.stringify({actor:'ui',baseRev:${state.revision},op:'captions',patch:{style:'attacker'}})})">`,
      `<script>fetch('${marker}',{method:'POST'})</script>`,
    ].join('');
    const added = await fetch(`${fx.baseURL}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectIdentityHeaders(fx.dir) },
      body: JSON.stringify({
        actor: 'ui',
        baseRev: state.revision,
        op: 'motion-add',
        tlStart: 0,
        duration: 6,
        spec: { type: 'custom-html', params: {}, html: hostileHtml },
      }),
    });
    if (!added.ok) throw new Error(await added.text());
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  test('custom-html keeps safe visuals but cannot execute onerror/script or call daemon APIs', async ({ page }) => {
    const attemptedApiCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('custom-html-onerror=1')) attemptedApiCalls.push(request.url());
    });

    const revisionBefore = (await (await page.request.get(`${fx.baseURL}/api/state`)).json()).revision;
    await page.goto(fx.baseURL);
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });

    const frame = page.locator('#motionLayer iframe.motionCustomHtml');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', '');
    const srcdoc = await frame.getAttribute('srcdoc');
    expect(srcdoc).not.toContain('onerror');
    expect(srcdoc).not.toContain('<script');
    await expect(page.frameLocator('#motionLayer iframe.motionCustomHtml').locator('#custom-safe')).toContainText('SAFE CUSTOM MARKUP');

    // Give both the deliberately broken image and any event handler enough
    // time to fire. A request carrying the marker would prove active markup
    // escaped the visual-only surface.
    await page.waitForTimeout(500);
    expect(attemptedApiCalls).toEqual([]);
    expect((await (await page.request.get(`${fx.baseURL}/api/state`)).json()).revision).toBe(revisionBefore);
  });
});
