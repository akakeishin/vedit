// vedit web/ の DOM 回帰テスト(Playwright, 実 CDP イベント)。
//
// docs/HANDOFF.md §5「web/ は DOM テストゼロ」の恒久固定と、検証ログ
// (docs/verification-log.md シナリオ3)の残項目「per-cue テキスト編集
// (ステージ cue ダブルクリック)」の実操作確認が目的。
//
// 1ファイル1 daemon/1プロジェクトを describe.serial で共有する(テストごとに
// ffmpeg 取り込みをやり直すのは重い上、ミューテーションを跨いだ実データで
// 検証したいテスト(e/f)もあるため)。各テストは必ず新しい page で開始し、
// フロント側の状態(S オブジェクト)は毎回まっさらになる — バックエンドの
// project.json/revision だけがテスト間で引き継がれる。ミューテーションを
// 行うテスト(e: per-cue 編集、f: pending 状態)は他のテストの前提を壊さない
// 位置(末尾)に置いてある。
import { expect, test } from '@playwright/test';
import { parseTc, setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('vedit web UI', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('main');
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  async function openApp(page: import('@playwright/test').Page) {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    await page.goto(fx.baseURL);
    // reload() 完了の合図: #projName がプレースホルダ("vedit")から実名に変わる。
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
    return consoleErrors;
  }

  async function openTranscriptTab(page: import('@playwright/test').Page) {
    await page.locator('#tab-transcriptPanel').click();
    await expect(page.locator('#transcriptPanel')).toHaveClass(/active/);
  }

  function wordLocator(page: import('@playwright/test').Page, wordId: string) {
    return page.locator(`#words .w[data-src="${fx.sourceId}"][data-id="${wordId}"]`);
  }

  // ---- a: 起動 ----
  test('起動: プロジェクト名がヘッダに表示され、コンソールエラーがゼロ', async ({ page }) => {
    const consoleErrors = await openApp(page);
    await expect(page.locator('#projName')).toHaveText(fx.projectName);
    // 素材1本が読み込まれ、初期状態の空文言が出ていないことも合わせて確認
    // (ロード自体が壊れていれば #stageEmpty が out になる)。
    await expect(page.locator('#stageEmpty')).toBeHidden();
    // rAF ループ・WS接続など非同期の初期化が一巡する時間を与えてからエラーを判定。
    await page.waitForTimeout(800);
    expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('素材プレビュー: 音声付き素材の「再生」は初回クリックだけで実際に再生を開始する', async ({ page }) => {
    await openApp(page);
    const playSource = page.getByRole('button', { name: 'clip.mp4 を再生' });
    await expect(playSource).toBeVisible();
    await playSource.click();
    await expect(page.locator('#previewBanner')).toBeVisible();
    await expect.poll(
      () => page.locator('#video').evaluate((el: HTMLVideoElement) => ({ paused: el.paused, readyState: el.readyState })),
      { timeout: 5_000 },
    ).toMatchObject({ paused: false, readyState: 4 });
    await expect(page.locator('#toast')).not.toContainText('再生できませんでした');
    await page.locator('#previewBannerExit').click();
    await expect(page.locator('#previewBanner')).toBeHidden();
  });

  // ---- b: シーク同期(F-s3-2/3 回帰) ----
  test('シーク同期: 文字起こしタブで単語クリック→現在タイムコードが即時更新される', async ({ page }) => {
    await openApp(page);
    await openTranscriptTab(page);
    const word = wordLocator(page, 'w0000'); // t0=0.5 t1=1.1 → tl中点 0.8s
    await expect(word).toBeVisible();
    // N2 計器盤 #7 実バグ修正: 以前はここで通常の .click() が使えず、専用の
    // clickWord ワークアラウンド(押す→#words内の別地点へ動かす→離す)が
    // 必要だった(pointerdown ハンドラが同期的に #words を全再構築するため、
    // 動かさずに離すと Chromium の implicit pointer capture が壊れた要素を
    // 掴んだままになり pointerup/click が配送されない、実機診断で確認済み
    // の挙動)。#words の選択更新を全再構築からクラス差分更新(
    // updateWordSelectionUI)へ直したことで、素の .click() がそのまま通る
    // ようになった(直接の回帰確認はテスト「その場クリック」を参照)。
    await word.click();
    // rAF 待ちに戻っていないか(F-s3-3 の再発防止)= リトライなしでも
    // ほぼ即時に反映されることを短いタイムアウトで確認する。
    await expect
      .poll(async () => Math.abs(parseTc(await page.locator('#headerTc').textContent()) - fx.cueA.tlStart), {
        timeout: 1_000,
        intervals: [50, 100, 150],
      })
      .toBeLessThan(0.2);
    // #tc内の現在時刻表示(tcNow)も同期していること。
    await expect
      .poll(async () => Math.abs(parseTc(await page.locator('#tcNow').textContent()) - fx.cueA.tlStart), { timeout: 1_000 })
      .toBeLessThan(0.2);
  });

  // ---- b2: その場クリック(#7 実バグ修正の直接回帰テスト) ----
  // clickWord ワークアラウンド(旧 e2e/interactions.ts)が要らなくなった
  // ことを、そのワークアラウンドが避けていた「動かさずに離す」手順そのもの
  // で直接確認する — mouse.move を1回だけ行い、down/up の間はカーソルを
  // 一切動かさない(実際の「その場クリック」と同じ入力パターン)。
  test('その場クリック: マウスを動かさずに単語を押して離しても選択+シークが効く', async ({ page }) => {
    await openApp(page);
    await openTranscriptTab(page);
    const word = wordLocator(page, 'w0001'); // t0=1.1 t1=1.6 → tl中点 1.35s(cueA内の別語 — テストbの選択状態と独立)
    await expect(word).toBeVisible();
    const box = await word.boundingBox();
    if (!box) throw new Error('word not visible/attached');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    // 選択(#7 が差分更新に直した経路)とシーク(pointerup ハンドラ、#7 の
    // 修正前は「その場」だと一切発火しなかった)の両方が効くことを見る。
    await expect(word).toHaveClass(/\bsel\b/);
    await expect
      .poll(async () => Math.abs(parseTc(await page.locator('#tcNow').textContent()) - 1.35), { timeout: 1_000 })
      .toBeLessThan(0.2);
  });

  // ---- c: 右パネル排他(rightMode) ----
  test('右パネル排他: クリップ選択→インスペクタ、cueクリック→字幕スタイル、←で確認タブへ復帰', async ({ page }) => {
    await openApp(page);

    // 既定は確認(claude)タブ。
    await expect(page.locator('#claudeView')).toBeVisible();
    await expect(page.locator('#inspectorView')).toBeHidden();

    // 1) クリップ選択 → インスペクタ表示。
    const clip = page.locator('#clips .clip').first();
    await expect(clip).toBeVisible();
    await clip.click();
    await expect(page.locator('#inspectorView')).toBeVisible();
    await expect(page.locator('#claudeView')).toBeHidden();
    await expect(page.locator('#captionView')).toBeHidden();

    // 2) cue をクリック(シングルクリック)→ 字幕スタイルビュー。cue が
    // ステージに出るよう、まず transcript の単語クリックで cueA の窓へシーク。
    await openTranscriptTab(page);
    await wordLocator(page, 'w0000').click();
    const cue = page.locator('#captionLayer .cue');
    await expect(cue).toBeVisible();
    await cue.click();
    await expect(page.locator('#captionView')).toBeVisible({ timeout: 1_000 });
    await expect(page.locator('#inspectorView')).toBeHidden();
    await expect(page.locator('#claudeView')).toBeHidden();

    // 3) 「← 戻る」→ 確認(claude)タブへ復帰。選択もこのタイミングで
    // クリアされる仕様(openCaptionStylePopover)なので clip モードへは戻らない。
    await page.locator('#captionBackBtn').click();
    await expect(page.locator('#claudeView')).toBeVisible();
    await expect(page.locator('#captionView')).toBeHidden();
    await expect(page.locator('#inspectorView')).toBeHidden();
  });

  // ---- d: キーボード到達性(makeBlockKeyboardActivatable 回帰) ----
  test('キーボード: クリップブロックへフォーカス→Enterで活性化(選択+インスペクタ表示)', async ({ page }) => {
    await openApp(page);
    const clip = page.locator('#clips .clip').first();
    await expect(clip).toBeVisible();

    // tabIndex=0 で到達できること自体を確認してからフォーカスし、Enter で
    // activate される(selectClip → インスペクタ表示)ことを見る。
    await expect(clip).toHaveAttribute('tabindex', '0');
    await clip.focus();
    await expect(clip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(clip).toHaveClass(/\bsel\b/);
    await expect(page.locator('#inspectorView')).toBeVisible();
  });

  // ---- e: per-cue テキスト編集(検証ログ シナリオ3の残項目) ----
  test('per-cue編集: ステージcueダブルクリック→テキスト編集→確定でrevision増加とテキスト更新', async ({ page }) => {
    const before = await (await page.request.get(`${fx.baseURL}/api/state`)).json();

    await openApp(page);
    await openTranscriptTab(page);
    await wordLocator(page, 'w0000').click(); // seek into cueA's window
    const cue = page.locator('#captionLayer .cue');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveText(fx.cueA.text);

    const NEW_TEXT = '編集済みテキストです';
    await cue.dblclick();
    // dblclick ハンドラが contentEditable=true にし、全選択した状態にする
    // (startCaptionTextEdit)。念のため明示的に select-all してから入力する。
    await expect(async () => {
      expect(await cue.evaluate((el) => (el as HTMLElement).isContentEditable)).toBe(true);
    }).toPass({ timeout: 1_000 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(NEW_TEXT);
    await page.keyboard.press('Enter');

    // revision が増加(caption-text op がコミットされた)。
    await expect
      .poll(async () => (await (await page.request.get(`${fx.baseURL}/api/state`)).json()).revision, { timeout: 5_000 })
      .toBeGreaterThan(before.revision);

    // ステージ上の表示テキストも新しい内容へ更新される。
    await expect(cue).toContainText(NEW_TEXT, { timeout: 3_000 });
    // 「✎修正済み」マーカーが付くこと(caption-text override 適用の視覚確認)。
    await expect(cue.locator('.cueEditedMark')).toBeVisible();

    // API 側でも captionTextOverrides に反映されていること(表示だけでなく
    // 実データが変わったことの根拠)。
    const after = await (await page.request.get(`${fx.baseURL}/api/project`)).json();
    expect(after.manifest.captionTextOverrides?.[fx.cueA.key]).toBe(NEW_TEXT);
  });

  // ---- f: mutation pending 状態(可能なら) ----
  test('mutation状態: 変更確定中はトリガーボタンが無効化され、成功で復帰する', async ({ page }) => {
    await openApp(page);
    await openTranscriptTab(page);
    await wordLocator(page, 'w0002').click(); // cueB の窓へシーク(cueA は前テストで編集済みのため別 cue を使う)
    const cue = page.locator('#captionLayer .cue');
    await expect(cue).toBeVisible();
    await cue.click(); // シングルクリック → 字幕スタイルビュー
    await expect(page.locator('#captionView')).toBeVisible({ timeout: 1_000 });

    // /api/edit を意図的に遅延させ、pending ウィンドウを引き伸ばして観測する。
    await page.route('**/api/edit', async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });

    const boldBtn = page.locator('#capStylePresetBtns .capPresetBtn', { hasText: 'ボールド' });
    await expect(boldBtn).toBeVisible();
    await boldBtn.click();

    // pending: トリガー(このボタン自身)が disabled になる(mutate() の
    // trigger.disabled=true — setCaptionStyle 参照)。
    await expect(boldBtn).toBeDisabled({ timeout: 1_000 });
    // 成功後: 遅延が解けたら disabled が外れ、プリセットが適用済み表示になる
    // (reload() が populateCaptionStylePresetControls を作り直すので、DOM
    // ノード自体が差し替わる — Locator は再クエリするので追従できる)。
    await expect(boldBtn).toBeEnabled({ timeout: 5_000 });
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true');

    await page.unroute('**/api/edit');
  });
});
