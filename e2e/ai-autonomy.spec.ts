import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectIdentityHeaders, setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('AI-first: 自律初稿・例外質問・アプリ内書き出し', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('ai-autonomy');
    const safe = [
      ['safe1', 0.8, 1.2],
      ['safe2', 2.4, 2.8],
      ['safe3', 4.0, 4.4],
    ].map(([id, t0, t1]) => ({
      id, kind: 'silence', sourceId: fx.sourceId, t0, t1, wordIds: [],
      label: '0.6s silence after "x"', status: 'proposed',
      evidence: { transcriptGap: true, waveform: true, transcriptConflict: false, edge: 'interior' },
    }));
    const fillers = [
      ['filler1', 1.5, 1.7],
      ['filler2', 3.1, 3.3],
      ['filler3', 4.8, 5.0],
    ].map(([id, t0, t1], i) => ({
      id, kind: 'filler', sourceId: fx.sourceId, t0, t1, wordIds: [`wf${i}`],
      label: 'filler "えーと"', status: 'proposed',
      evidence: { transcriptGap: true, waveform: false, transcriptConflict: false, edge: 'interior' },
    }));
    writeFileSync(path.join(fx.dir, 'candidates.json'), JSON.stringify([...safe, ...fillers], null, 2));
    const state = await (await fetch(`${fx.baseURL}/api/state`)).json();
    const res = await fetch(`${fx.baseURL}/api/first-draft`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...projectIdentityHeaders(fx.dir) },
      body: JSON.stringify({ actor: 'claude', baseRev: state.revision }),
    });
    if (!res.ok) throw new Error(await res.text());
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  async function openApp(page: import('@playwright/test').Page) {
    await page.goto(fx.baseURL);
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
  }

  test('AIが低リスク編集を先に実行し、本当に曖昧な3件だけボタンで質問する', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fx.baseURL });
    await openApp(page);
    const summary = page.locator('#aiWorkSummary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('AIが3箇所を自律編集しました');
    await expect(summary).toContainText('文字起こし＋波形で二重確認');
    await expect(page.locator('#candidatesHeadingLabel')).toHaveText('AIから確認');
    await expect(page.locator('#candidateQuestionIntro')).toBeVisible();
    await expect(page.locator('#inboxList .cand')).toHaveCount(3);
    await expect(page.locator('#inboxList .candReason')).toHaveCount(3);
    // The batch simulation may discover a concrete fragment-absorption risk
    // before the filler preference rationale. Both are canonical reasons to
    // stop autonomy; the UI must explain one of that closed taxonomy rather
    // than promising that every filler stays a pure taste question.
    const reasons = await page.locator('#inboxList .candReason').allTextContents();
    expect(reasons.every((reason) => /好み|根拠|一致していません|冒頭・末尾|短い断片/.test(reason))).toBe(true);
    await expect(page.locator('#decisionCutAll')).toBeHidden();
    await expect(page.locator('#decisionKeepAll')).toBeVisible();

    // AI's companion-channel pointer must carry the judgment context with
    // it. A floating card that only says "candidate filler1" would force the
    // user to hunt through the queue before they can answer the question.
    const shown = await page.request.post(`${fx.baseURL}/api/show`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { kind: 'candidate', id: 'filler1' },
    });
    expect(shown.ok()).toBeTruthy();
    const shownCard = page.locator('#candidateCard');
    await expect(shownCard).toBeVisible();
    await expect(shownCard.locator('.showCandidateReason')).toContainText('AIが確認を求める理由');
    await expect(shownCard.locator('.showCandidateTradeoff')).toContainText('カット:');
    await expect(shownCard.locator('.showCandidateTradeoff')).toContainText('残す:');
    await expect(shownCard.getByRole('button', { name: 'カットする' })).toBeVisible();
    await expect(shownCard.getByRole('button', { name: '残す' })).toBeVisible();
    await shownCard.getByRole('button', { name: '閉じる' }).click();

    await page.locator('#openCoworkBtn').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`対象のveditプロジェクト: ${fx.dir}`);
    expect(copied).toMatch(/画面表示時の版: \d+/);
    expect(copied).toContain('実行前に対象パスのproject.jsonを読み直して最新の版を確認');
    expect(copied).toContain('根拠不足または根拠衝突');
    expect(copied).toContain('保護済みintent、不正区間、現在版に効果がない候補、判断済み候補は質問にせず');

    // The transcript/slim shortcuts must not bypass the reason gate that
    // deliberately stopped AI autonomy. They navigate to the canonical
    // question card and do not mutate the revision.
    const beforeShortcut = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    await page.getByRole('tab', { name: '文字起こし' }).click();
    const questionChip = page.locator('#words .transcriptDecision').filter({ hasText: '確認' }).first();
    await expect(questionChip).toBeVisible();
    await questionChip.click();
    await expect(page.locator('#inboxList .cand.expanded')).toHaveCount(1);
    const afterShortcut = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    expect(afterShortcut.revision).toBe(beforeShortcut.revision);

    // One-click rollback restores both timeline and candidate queue.
    page.once('dialog', (dialog) => dialog.accept());
    await summary.getByRole('button', { name: 'この自動編集を戻す' }).click();
    await expect(page.locator('#inboxList .cand')).toHaveCount(6);
    await summary.getByRole('button', { name: 'この自動編集をやり直す' }).click();
    await expect(page.locator('#inboxList .cand')).toHaveCount(3);
    await expect(summary).toContainText('AIが3箇所を自律編集しました');
    await expect(summary.getByRole('button', { name: 'この自動編集を戻す' })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await summary.getByRole('button', { name: 'この自動編集を戻す' }).click();
    await expect(page.locator('#inboxList .cand')).toHaveCount(6);
  });

  test('質問ボタンは子要素のEnterを二重処理せず、1件だけ回答して残り2件を保つ', async ({ page }) => {
    // Prior test intentionally exercises the native confirmation. Ensure a
    // first draft is active regardless of whether that dialog was accepted
    // by re-running the idempotent route against the current revision.
    const state = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    await page.request.post(`${fx.baseURL}/api/first-draft`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { actor: 'claude', baseRev: state.revision },
    });
    await openApp(page);
    await expect(page.locator('#inboxList .cand')).toHaveCount(3);
    const before = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    const first = page.locator('#inboxList .cand').first();
    await first.click();
    const keep = first.locator('.btn-wash');
    await expect(keep).toBeVisible();
    await keep.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#inboxList .cand')).toHaveCount(2);
    await expect(page.locator('#aiWorkSummary')).toContainText('判断が必要 2件');
    const after = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    expect(after.revision).toBe(before.revision + 1);
  });

  test('人の判断直後に1120pxでも戻す/やり直すが見え、ボタンと標準ショートカットで往復できる', async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 800 });
    await openApp(page);
    await expect(page.locator('#inboxList .cand')).toHaveCount(2);
    const before = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    const undo = page.getByRole('button', { name: '元に戻す' });
    const redo = page.getByRole('button', { name: 'やり直す' });

    await expect(undo).toBeVisible();
    await expect(undo).toBeEnabled();
    await expect(undo).toContainText('戻す');
    await expect(redo).toBeVisible();
    await expect(redo).toBeDisabled();

    await undo.click();
    await expect(page.locator('#inboxList .cand')).toHaveCount(3);
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(page.locator('#inboxList .cand')).toHaveCount(2);

    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('#inboxList .cand')).toHaveCount(3);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('#inboxList .cand')).toHaveCount(2);

    await page.setViewportSize({ width: 320, height: 800 });
    await expect(undo).toBeVisible();
    await expect(redo).toBeVisible();
    expect(await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headerOverflow: document.querySelector('header')!.scrollWidth - document.querySelector('header')!.clientWidth,
    }))).toEqual({ documentOverflow: 0, headerOverflow: 0 });

    const after = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    expect(after.revision).toBe(before.revision + 4);
  });

  test('候補ボタンの高速二重押しを1回の判断として扱う', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#inboxList .cand')).toHaveCount(2);
    const before = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    const row = page.locator('#inboxList .cand').first();
    await row.click();
    const cut = row.getByRole('button', { name: /カットする/ });
    await cut.evaluate((button) => { button.click(); button.click(); });
    await expect(page.locator('#inboxList .cand')).toHaveCount(1);
    const after = await (await page.request.get(`${fx.baseURL}/api/state`)).json();
    expect(after.revision).toBe(before.revision + 1);
  });

  test('明示ボタンで現在版をローカルMP4へ書き出し、結果カードまで到達する', async ({ page }) => {
    await openApp(page);
    await page.locator('#exportBtn').click();
    const button = page.getByRole('button', { name: /MP4をこのMacに書き出す|最新の版をもう一度書き出す/ });
    await expect(button).toBeVisible();
    await expect(page.locator('#exportAskRow')).toContainText('外部には送信しません');
    await button.click();
    await expect(page.locator('#exportJobCard')).toContainText(/準備中|書き出し中|確定中/, { timeout: 5_000 });
    await expect(page.locator('#exportJobCard')).toContainText('MP4を書き出しました', { timeout: 30_000 });
    await expect(page.locator('#exportResultCard')).toContainText('MP4書き出し', { timeout: 5_000 });
    const job = (await (await page.request.get(`${fx.baseURL}/api/export-job`)).json()).job;
    expect(job.status).toBe('success');
    expect(job.file.startsWith(path.join(fx.dir, 'exports') + path.sep)).toBe(true);
  });

  test('別プロジェクトへ切り替えると前の書き出し結果や候補を持ち越さない', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#exportResultCard')).toContainText('MP4書き出し', { timeout: 5_000 });

    const nextDir = path.join(path.dirname(fx.dir), 'empty-project-b');
    mkdirSync(nextDir, { recursive: true });
    const opened = await page.request.post(`${fx.baseURL}/api/open`, {
      data: { dir: nextDir, name: 'Project B' },
    });
    expect(opened.ok()).toBe(true);
    await expect(page.locator('#projName')).toHaveText('Project B', { timeout: 10_000 });
    await expect(page.locator('#exportResultCard')).toBeHidden();
    await expect(page.locator('#deskExportCard')).toBeHidden();
    await expect(page.locator('#inboxList .cand')).toHaveCount(0);
  });
});
