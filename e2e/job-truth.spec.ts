import { expect, test } from '@playwright/test';
import http from 'node:http';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectIdentityHeaders, setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('非同期処理と検査結果の状態表示', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('job-truth');
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  async function openApp(page: import('@playwright/test').Page) {
    await page.goto(fx.baseURL);
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
  }

  test('QC取得失敗を「問題なし」にせず、画面内から再試行できる', async ({ page }) => {
    await page.route('**/api/qc', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated QC outage' }),
    }));
    await openApp(page);

    const failure = page.locator('[data-qc-error="true"]');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('問題がないとは判定していません');
    await expect(page.locator('#warningsEmpty')).toBeHidden();

    await page.unroute('**/api/qc');
    await failure.getByRole('button', { name: '品質チェックを再試行' }).click();
    await expect(failure).toHaveCount(0);
  });

  test('候補ゼロの正常完了は再読み込み後も未実行と区別し、revision変更後は古い結果と示す', async ({ page }) => {
    // A previous decision remains in candidates.json by design. A newer
    // successful zero-result run must still describe the latest run as zero,
    // rather than falling back to the older "all reviewed" empty state.
    writeFileSync(path.join(fx.dir, 'candidates.json'), JSON.stringify([{
      id: 'old-reviewed-candidate',
      kind: 'silence',
      sourceId: fx.sourceId,
      t0: 0,
      t1: 0.1,
      wordIds: [],
      label: '過去の確認済み候補',
      status: 'rejected',
    }], null, 2));
    const detected = await page.request.post(`${fx.baseURL}/api/detect`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { silence: false, fillers: false },
    });
    expect(detected.ok()).toBeTruthy();
    expect((await detected.json()).detectRun.proposalCount).toBe(0);

    await openApp(page);
    const empty = page.locator('#inboxList .inboxEmpty');
    await expect(empty).toContainText('編集提案は見つかりませんでした');
    await page.reload();
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
    await expect(empty).toContainText('編集提案は見つかりませんでした');
    await expect(empty).not.toContainText('まだ作られていません');

    const state = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    const edited = await page.request.post(`${fx.baseURL}/api/edit`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { actor: 'ui', baseRev: state.revision, op: 'captions', patch: { maxChars: 31 } },
    });
    expect(edited.ok()).toBeTruthy();
    await page.reload();
    await expect(empty).toContainText('前回の候補検出後に編集内容が変わりました');
    await expect(page.locator('#detectSettings')).toBeVisible();
    await page.locator('#detectSettings > summary').click();
    await expect(page.locator('#redetectBtn')).toBeVisible();
  });

  test('取り込み失敗でスピナーとaria-busyが必ず終端し、理由を表示する', async ({ page }) => {
    await openApp(page);
    const response = await page.request.post(`${fx.baseURL}/api/ingest`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { file: path.join(fx.dir, 'missing-video.mp4'), scenes: false },
    });
    expect(response.ok()).toBeFalsy();

    await expect(page.locator('#toast')).toContainText('取り込みを完了できませんでした');
    await expect(page.locator('#claudeStrip')).toBeHidden();
    await expect(page.locator('#stage')).not.toHaveAttribute('aria-busy', 'true');
  });

  test('色変換のプロキシ再生成が成功すると処理中表示を残さない', async ({ page }) => {
    await openApp(page);
    const state = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    const response = await page.request.post(`${fx.baseURL}/api/edit`, {
      headers: projectIdentityHeaders(fx.dir),
      data: {
        actor: 'agent',
        baseRev: state.revision,
        op: 'color-transform',
        sourceId: fx.sourceId,
        // `none` still regenerates the existing proxy through the same async
        // lifecycle, without depending on optional zscale/tonemap filters on
        // the CI host's ffmpeg build.
        type: 'none',
      },
    });
    expect(response.ok()).toBeTruthy();

    await expect(page.locator('#claudeStrip')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#claudeStatus')).not.toHaveClass(/busy/);
  });

  test('色変換の設定保存後にプロキシ再生成だけ失敗した場合も、部分成功を明示して処理中表示を解除する', async ({ page }) => {
    await openApp(page);
    const invalidLut = path.join(fx.dir, 'invalid-test.cube');
    writeFileSync(invalidLut, 'this is not a valid cube LUT\n');
    const state = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    const response = await page.request.post(`${fx.baseURL}/api/edit`, {
      headers: projectIdentityHeaders(fx.dir),
      data: {
        actor: 'agent',
        baseRev: state.revision,
        op: 'color-transform',
        sourceId: fx.sourceId,
        type: 'lut',
        lut: invalidLut,
      },
    });
    expect(response.ok()).toBeFalsy();

    await expect(page.locator('#toast')).toContainText('設定は保存されましたが、プレビューを更新できませんでした');
    await expect(page.locator('#claudeStrip')).toBeHidden();
    await expect(page.locator('#claudeStatus')).not.toHaveClass(/busy/);
  });

  test('中断アップロードは自分だけを終端し、並行中の別アップロードを処理中のまま保つ', async ({ page }) => {
    await openApp(page);
    const startInterruptedUpload = (name: string) => {
      const req = http.request(`${fx.baseURL}/api/upload?${new URLSearchParams({ name })}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': 8 * 1024 * 1024,
          ...projectIdentityHeaders(fx.dir),
        },
      }, (res) => res.resume());
      req.on('error', () => {}); // expected: each request is intentionally aborted
      req.write(Buffer.alloc(64 * 1024, 0x61));
      return req;
    };

    const first = startInterruptedUpload('browser-interrupted-a.mp4');
    await expect(page.locator('#claudeStrip')).toContainText('browser-interrupted-a.mp4', { timeout: 5_000 });
    const second = startInterruptedUpload('browser-interrupted-b.mp4');
    await expect(page.locator('#claudeStrip')).toContainText('ほか1件');

    first.destroy(new Error('intentional first upload interruption'));
    await expect(page.locator('#toast')).toContainText('browser-interrupted-a.mp4');
    await expect(page.locator('#claudeStrip')).toBeVisible();
    await expect(page.locator('#claudeStrip')).toContainText('browser-interrupted-b.mp4');

    second.destroy(new Error('intentional second upload interruption'));
    await expect(page.locator('#toast')).toContainText('browser-interrupted-b.mp4');
    await expect(page.locator('#claudeStrip')).toBeHidden();
    await expect(page.locator('#claudeStatus')).not.toHaveClass(/busy/);
  });

  test('1素材の詳細取得が止まっても、別素材の文字起こしを到着順に表示する', async ({ page }) => {
    const manifestPath = path.join(fx.dir, 'project.json');
    const before = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(before);
    const secondId = 'source-detail-independent';
    const second = {
      ...manifest.sources[0],
      id: secondId,
      peaks: undefined,
      transcribed: true,
    };
    manifest.sources.push(second);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const transcriptPath = path.join(fx.dir, `transcript-${secondId}.json`);
    writeFileSync(transcriptPath, JSON.stringify({
      sourceId: secondId,
      language: 'en',
      words: [{ id: 'w0000', text: 'SECOND_SOURCE_READY', t0: 0.5, t1: 1.2, p: 0.99 }],
    }));

    // Keep only the first source's scene request pending. Before progressive
    // per-source commits, hydrateSourceDetails waited for the whole worker
    // pool and this also hid the second source's already-finished transcript.
    await page.route(`**/api/scenes?source=${fx.sourceId}&full=1`, async () => {
      await new Promise(() => {});
    });
    try {
      await openApp(page);
      await page.getByRole('tab', { name: '文字起こし' }).click();
      await expect(page.locator('#words')).toContainText('SECOND_SOURCE_READY', { timeout: 5_000 });
      await expect(page.locator('#mediaSearchStatus')).toContainText('詳細をバックグラウンドで読み込み中');
    } finally {
      writeFileSync(manifestPath, before);
      rmSync(transcriptPath, { force: true });
    }
  });

  test('切断中に文字起こしが失敗しても、再読込後に理由と再試行を復元する', async ({ page }) => {
    const manifestPath = path.join(fx.dir, 'project.json');
    const before = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(before);
    manifest.sources = manifest.sources.map((source: any) => (
      source.id === fx.sourceId ? { ...source, transcribed: false } : source
    ));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    try {
      const started = await page.request.post(`${fx.baseURL}/api/transcribe`, {
        headers: projectIdentityHeaders(fx.dir),
        data: { sourceId: fx.sourceId, language: 'ja' },
      });
      expect(started.ok()).toBeTruthy();
      await expect.poll(async () => {
        const response = await page.request.get(`${fx.baseURL}/api/transcribe-jobs`);
        const body = await response.json();
        return body.jobs.find((job: any) => job.sourceId === fx.sourceId)?.status;
      }, { timeout: 10_000 }).toBe('error');

      // This tab did not exist for the progress/error WS events. All truth
      // must therefore come from the reload snapshot, not an in-memory toast.
      await openApp(page);
      await page.getByRole('tab', { name: '文字起こし' }).click();
      const row = page.locator('.transcribeStatusRow').filter({ hasText: path.basename(manifest.sources[0].path) });
      await expect(row).toContainText('失敗');
      await expect(row).toContainText('no whisper model found');
      await expect(row.getByRole('button', { name: /再試行/ })).toBeVisible();
      await expect(page.locator('#claudeStatus')).not.toHaveClass(/busy/);
    } finally {
      writeFileSync(manifestPath, before);
    }
  });
});
