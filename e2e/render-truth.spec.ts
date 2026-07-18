import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectIdentityHeaders, setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('painted frame identity and sidecar cache truth', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('render-truth');
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  async function openApp(page: import('@playwright/test').Page) {
    await page.goto(fx.baseURL);
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
    await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
  }

  test('遅いreload中の古い操作は画面に見えていたrevisionで409になり、未表示の版へ着地しない', async ({ page }) => {
    await openApp(page);
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#reframeSelect')).toBeVisible();
    const before = await (await page.request.get(`${fx.baseURL}/api/state`)).json();

    let entered!: () => void;
    const childFetchEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const releaseChildFetch = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route('**/api/captions', async (route) => {
      if (held) return route.continue();
      held = true;
      entered();
      await releaseChildFetch;
      await route.continue();
    });

    const external = await page.request.post(`${fx.baseURL}/api/edit`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { actor: 'agent', baseRev: before.revision, op: 'captions', patch: { maxChars: 29 } },
    });
    expect(external.ok()).toBeTruthy();
    await childFetchEntered;
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true');

    const reframeRequest = page.waitForRequest((request) => {
      if (!request.url().endsWith('/api/edit') || request.method() !== 'POST') return false;
      try { return request.postDataJSON()?.op === 'reframe'; } catch { return false; }
    });
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#reframeSelect').selectOption('9:16');
    const staleMutation = await reframeRequest;
    expect(staleMutation.postDataJSON().baseRev).toBe(before.revision);

    const during = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    expect(during.revision).toBe(before.revision + 1);
    const currentProject = await (await page.request.get(`${fx.baseURL}/api/project`)).json();
    expect([currentProject.manifest.output?.width, currentProject.manifest.output?.height]).not.toEqual([1080, 1920]);

    release();
    await expect(page.locator('#revLabel')).toContainText(String(before.revision + 1), { timeout: 10_000 });
    await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
    await page.unroute('**/api/captions');
  });

  test('候補sidecar入替中の古い一括ボタンは描画時のexact IDsだけを送り、新候補を操作しない', async ({ page }) => {
    const candidatePath = path.join(fx.dir, 'candidates.json');
    const makeCandidate = (id: string, t0: number, t1: number) => ({
      id, kind: 'silence', sourceId: fx.sourceId, t0, t1, wordIds: [],
      label: `${(t1 - t0).toFixed(1)}s silence after "x"`, status: 'proposed',
      evidence: { transcriptGap: true, waveform: true, transcriptConflict: false, edge: 'interior' },
    });
    const oldCandidates = [makeCandidate('painted-old-a', 0.2, 0.4), makeCandidate('painted-old-b', 4.4, 4.6)];
    const replacement = [makeCandidate('unseen-new-a', 0.7, 0.9), makeCandidate('unseen-new-b', 5.0, 5.2)];
    writeFileSync(candidatePath, JSON.stringify(oldCandidates, null, 2));

    await openApp(page);
    await expect(page.locator('#inboxList .cand')).toHaveCount(2);
    await expect(page.locator('#decisionKeepAll')).toBeVisible();

    let projectReads = 0;
    let verifyEntered!: () => void;
    const secondProjectRead = new Promise<void>((resolve) => { verifyEntered = resolve; });
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    await page.route('**/api/project', async (route) => {
      projectReads++;
      if (projectReads !== 2) return route.continue();
      verifyEntered();
      await verifyGate;
      await route.continue();
    });

    writeFileSync(candidatePath, JSON.stringify(replacement, null, 2));
    const reopened = await page.request.post(`${fx.baseURL}/api/open`, { data: { dir: fx.dir, name: fx.projectName } });
    expect(reopened.ok()).toBeTruthy();
    await secondProjectRead;

    const decideRequest = page.waitForRequest((request) => request.url().endsWith('/api/candidates/decide'));
    await page.locator('#decisionKeepAll').click();
    const request = await decideRequest;
    expect(request.postDataJSON().ids).toEqual(['painted-old-a', 'painted-old-b']);

    const onDisk = JSON.parse(readFileSync(candidatePath, 'utf8'));
    expect(onDisk.map((candidate: any) => [candidate.id, candidate.status])).toEqual([
      ['unseen-new-a', 'proposed'],
      ['unseen-new-b', 'proposed'],
    ]);

    releaseVerify();
    await expect(page.locator('#inboxList .cand')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('#inboxList')).toContainText('0.2秒');
    await page.unroute('**/api/project');
  });

  test('missed transcribe完了をreloadで検出し、旧word DOMを消してから新ID/textを再取得する', async ({ page }) => {
    await openApp(page);
    await page.getByRole('tab', { name: '文字起こし' }).click();
    await expect(page.locator('#words')).toContainText('こんにちは');

    let transcriptEntered!: () => void;
    const transcriptFetch = new Promise<void>((resolve) => { transcriptEntered = resolve; });
    let releaseTranscript!: () => void;
    const transcriptGate = new Promise<void>((resolve) => { releaseTranscript = resolve; });
    let held = false;
    await page.route('**/api/transcript?**', async (route) => {
      if (held || route.request().url().includes(`source=${encodeURIComponent(fx.sourceId)}`) === false) {
        return route.continue();
      }
      held = true;
      transcriptEntered();
      await transcriptGate;
      await route.continue();
    });

    const { Project } = await import('../dist/core/project.js');
    const project = await Project.open(fx.dir);
    await project.commitTranscript({
      sourceId: fx.sourceId,
      language: 'ja',
      words: [
        { id: 'new0000', text: 'NEW_TRANSCRIPT_WORD', t0: 0.5, t1: 1.2, p: 0.99 },
        { id: 'new0001', text: '更新済み。', t0: 1.2, t1: 1.8, p: 0.99 },
      ],
    }, 'system', { sourceId: fx.sourceId, taskId: 'missed-ws-fixture' }, 'test re-transcribe');

    // Direct commit intentionally emits no WS. Reopening the same project is
    // the reconnect/missed-event path that must discover revision truth.
    const reopened = await page.request.post(`${fx.baseURL}/api/open`, { data: { dir: fx.dir, name: fx.projectName } });
    expect(reopened.ok()).toBeTruthy();
    await transcriptFetch;

    // The new frame is painted before progressive detail hydration. During
    // that gap there must be no editable word from the previous namespace.
    await expect(page.locator('#words')).not.toContainText('こんにちは');
    await expect(page.locator('#words .w')).toHaveCount(0);
    await expect(page.locator('#removeSelBtn')).toBeDisabled();

    releaseTranscript();
    await expect(page.locator('#words')).toContainText('NEW_TRANSCRIPT_WORD', { timeout: 10_000 });
    await expect(page.locator('#words')).not.toContainText('こんにちは');
    await expect(page.locator('#words .w').first()).toHaveAttribute('data-id', 'new0000');
    await page.unroute('**/api/transcript?**');
  });
});
