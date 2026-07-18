// IA v3「調整室とキューシート」波A(構造)の DOM 回帰テスト。
// docs/superpowers/specs/2026-07-18-vedit-ia-v3.md §1.1-1.3、受け入れ基準
// 1〜4/7 が対象。既存の e2e/vedit.spec.ts とは別ファイル(このスイート専用の
// 状態遷移 — lastSeenRevision の localStorage・候補検出・revision の直接
// 操作を行うため、既存6テストの共有プロジェクト状態を乱さないよう分離した)。
//
// 4テストを1つの daemon/プロジェクトで describe.serial 実行する(ffmpeg
// 取り込みをテストごとにやり直すのは重いため — e2e/vedit.spec.ts と同じ
// 方針)。実行順に依存関係がある:
//   A) 定常状態(候補ゼロ・新着ゼロ)を最初に検証 — 以降のテストが候補を
//      作ってしまうと定常状態ではなくなるため必ず先頭。
//   B) /api/detect で候補を1件作り、新着区切り+未決保護を検証(候補は
//      承認/却下しないまま残す)。
//   C) B が残した候補をスリムバー側から承認して消費する。
//   D) ドリルインシートの戻り文脈(他テストの状態に依存しない)。
import { expect, test } from '@playwright/test';
import { projectIdentityHeaders, setupVedit, teardownVedit, type VeditFixture } from './fixtures';

let fx: VeditFixture;

test.describe.serial('IA v3 波A: キューシート/スリムバー/ドリルイン文法', () => {
  test.beforeAll(async () => {
    fx = await setupVedit('ia-v3-wave-a');
  });

  test.afterAll(async () => {
    if (fx) await teardownVedit(fx);
  });

  async function openApp(page: import('@playwright/test').Page) {
    await page.goto(fx.baseURL);
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
  }

  async function apiState(page: import('@playwright/test').Page): Promise<{ revision: number }> {
    return (await page.request.get(`${fx.baseURL}/api/state`)).json();
  }

  // ---- A: 「紙を白紙にしない」定常状態 ----
  test('定常状態: 候補ゼロ・新着ゼロでもキューシートに作業記録が載る(白紙にならない)', async ({ page }) => {
    await openApp(page);

    // まだ /api/detect を一度も呼んでいないプロジェクト = 「Claude の編集提案」
    // は4状態のうち「まだ作られていません」(既存文言、維持)。
    const emptyMsg = page.locator('#candidatesSection .inboxEmpty');
    await expect(emptyMsg).toBeVisible();
    await expect(emptyMsg).toContainText('編集提案はまだ作られていません');

    // それでも右ペイン(キューシート)は白紙ではない — 常設内容
    // (#queueSheetDesk)が表示される。
    const desk = page.locator('#queueSheetDesk');
    await expect(desk).toBeVisible();

    // (1) 直近の作業記録: setupVedit の ingest/captions 有効化で既に
    // revision ログが積まれている(revision>=2)ので最低1件は載る。
    const recentRows = page.locator('#deskRecentList .queueRevRow');
    await expect(recentRows.first()).toBeVisible();
    expect(await recentRows.count()).toBeGreaterThan(0);

    // (4) 次の一手チップ: 素材は文字起こし済み。BGMは作品意図なしに
    // blanket推奨しないため、機械的な「次の一手」は出さない。
    const chips = page.locator('#deskNextChips .askChip');
    await expect(chips).toHaveCount(0);
    await expect(page.locator('#deskNextChips')).not.toContainText('文字起こしを頼む');
    await expect(page.locator('#deskNextChips')).not.toContainText('BGMを頼む');
  });

  // ---- B: 新着区切り + 未決保護 ----
  test('新着表示: 「前回から N件」は操作でのみ進み、未決の候補はlastSeenに関わらず常に表示される', async ({ page }) => {
    // 1件だけ候補ができる条件(SYNTHETIC_WORDS の唯一の1.4s語間ギャップ)。
    // detect() 自体は revision を進めない(candidates.json は revision ログ外)。
    const detectRes = await page.request.post(`${fx.baseURL}/api/detect`, {
      headers: projectIdentityHeaders(fx.dir),
      data: {},
    });
    expect(detectRes.ok()).toBeTruthy();
    const r0 = (await apiState(page)).revision;

    // 初回オープン(このプロジェクトをこのブラウザコンテキストで初めて開く
    // — localStorage に保存値なし)。実装判断: 「開いた瞬間に全履歴が新着
    // 扱いになる」フラッディングを避けるため、初回は静かに現在地を基準点と
    // して記録する(ensureQueueSeenLoaded in app.js)。そのため直後は新着
    // 区切りが出ない。
    await openApp(page);
    await expect(page.locator('#queueNewSummary')).toBeHidden();

    // 候補自体は(新着/既読に関わらず)必ず1件見える — 未決保護。
    const candRows = page.locator('#inboxList .cand');
    await expect(candRows).toHaveCount(1);
    // lastSeen は候補の表示可否を変えない。新着ドットによる強調も廃止済み。
    await expect(candRows.first()).not.toHaveClass(/candNew/);

    // 文字起こしも同じ候補状態を使い、その場で即決できるチップを持つ。
    await page.locator('#tab-transcriptPanel').click();
    await expect(page.locator('#words .transcriptDecision')).toHaveCount(1);

    // タイムラインのズームは実機能。拡大後は時間面だけがスクロールし、
    // 「全体表示」で等倍へ戻る。
    await page.locator('#tlZoomRange').fill('60');
    await expect.poll(() => page.locator('#timelineViewport').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.locator('#tlFitBtn').click();
    await expect.poll(() => page.locator('#timelineTracks').evaluate((el) => {
      const viewport = document.getElementById('timelineViewport')!;
      return Math.abs(el.getBoundingClientRect().width - viewport.clientWidth) <= 2 && viewport.scrollLeft === 0;
    })).toBe(true);

    // 何か操作する(中立なテキストをクリック — 決定/シークを伴わない)。
    // これは基準点をR0に据え直すだけなので見た目には変化なし(冪等)。
    await page.locator('#candidatesSection .inboxHeading').click();

    // Claude が1手実行したことにする(実際の /api/edit — captions patch)。
    // revision ログに「行為者つき人間語要約」が1件積まれる。
    const editRes = await page.request.post(`${fx.baseURL}/api/edit`, {
      headers: projectIdentityHeaders(fx.dir),
      data: { op: 'captions', patch: { maxChars: 30 }, baseRev: r0, actor: 'claude' },
    });
    expect(editRes.ok()).toBeTruthy();
    const r1 = (await apiState(page)).revision;
    expect(r1).toBe(r0 + 1);

    // ただ開いただけ(操作なし)のリロード: 新着区切りが「前回の確認から
    // 1件」で現れる。かつ、未決の候補はここでも変わらず表示され続ける
    // (既読≠既決 — 反証2の「決定の喪失」対策)。
    await page.reload();
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
    const newSummary = page.locator('#queueNewSummary');
    await expect(newSummary).toBeVisible();
    await expect(newSummary).toHaveText('前回から 1件');

    await expect(candRows).toHaveCount(1); // 未決保護: まだ消えていない
    await expect(candRows.first()).not.toHaveClass(/candNew/); // 候補自体は基準点スナップショット内 = 新着扱いではない

    // 操作する(クリック) → 基準点が r1 へ進む。
    await page.locator('#candidatesSection .inboxHeading').click();

    // もう一度、素のリロード(操作なし): 新着区切りは消えている
    // (=「開いただけでは進まない、操作で進む」の両方向を確認できた)。
    await page.reload();
    await expect(page.locator('#projName')).toHaveText(fx.projectName, { timeout: 10_000 });
    await expect(page.locator('#queueNewSummary')).toBeHidden();

    // それでも未決の候補は変わらず表示され続ける(未決保護は lastSeen が
    // どれだけ進んでも解除されない)。
    await expect(candRows).toHaveCount(1);
  });

  // ---- C: スリムバーの出現と承認同期 ----
  test('スリムバー: 再生で予告→承認ボタンが現れ、承認するとキューシート側からも同時に消える', async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 820 });
    await openApp(page);
    const before = await apiState(page);

    // 1120pxでは紙はオーバーレイシート。ヘッダータリーで開閉できる。
    await expect(page.locator('#rightPanel')).toHaveAttribute('aria-hidden', 'true');
    await page.locator('#claudeStatus').click();
    await expect(page.locator('#rightPanel')).toHaveAttribute('aria-hidden', 'false');

    // 全体設定は棚ではなく設定シートに集約され、ドリルイン中も未決数が残る。
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#settingsView')).toBeVisible();
    await expect(page.locator('#settingsView #audioPanel')).toBeVisible();
    await expect(page.locator('#settingsView #reframeSelect')).toBeVisible();
    await expect(page.locator('#settingsView .pendingTally')).toContainText('確認待ち');
    await page.locator('#settingsBackBtn').click();

    const candRow = page.locator('#inboxList .cand').first();
    await expect(candRow).toBeVisible();

    // 候補レーンと紙キューは同じcandidate id。レーンから紙の該当行を展開する。
    const marker = page.locator('#candLane .candMarker').first();
    await expect(marker).toBeVisible();
    await marker.click();
    await expect(candRow).toHaveClass(/expanded/);

    // スリムバーは既存の同期描画経路(renderPlaybackFrame)から駆動される
    // ので、実際に再生させて確認する。候補行の「前後を再生」ボタンは
    // candidateTl(t0-1) から再生開始・candidateTl(t1+1) で自動停止 —
    // ちょうどスリムバーの「予告→通過中→通過後1秒で消灯」の全区間を
    // 1操作でなぞる。
    await candRow.locator('.btn-preview').click();
    await page.locator('#rightPanelClose').click();
    await expect(page.locator('#rightPanel')).toHaveAttribute('aria-hidden', 'true');

    const slimBar = page.locator('#slimBar');
    const slimBarText = page.locator('#slimBarText');
    const slimBarActions = page.locator('#slimBarActions');

    // 予告: 再生開始直後(区間の2秒以内手前)は forecast 状態。
    await expect(slimBar).toHaveClass(/slimBar-forecast/, { timeout: 2_000 });
    await expect(slimBarText).toContainText('まもなく');
    await expect(slimBarActions).toBeHidden();

    // 通過中: プレイヘッドが区間へ入ると [カットする][残す] が現れる。
    await expect(slimBar).toHaveClass(/slimBar-active/, { timeout: 3_000 });
    await expect(slimBarActions).toBeVisible();
    const cutBtn = page.locator('#slimBarCut');
    await expect(cutBtn).toBeVisible();

    // スリムバー側の「カットする」で承認 — キューシートの候補カードと
    // 同一データ・同一アクション(decide())なので、両方から同時に消える。
    await cutBtn.click();

    await expect
      .poll(async () => (await apiState(page)).revision, { timeout: 5_000 })
      .toBeGreaterThan(before.revision);
    await expect(page.locator('#inboxList .cand')).toHaveCount(0, { timeout: 3_000 });
    await expect(page.locator('#candLane .candMarker')).toHaveCount(0);
    // 対象が消えたのでスリムバーも空(通過後1秒待たずとも、対象自体がもう
    // S.candidates に存在しないため次フレームで空に戻る)。
    await expect(slimBarActions).toBeHidden({ timeout: 3_000 });
  });

  // ---- D: ドリルインシートの戻り文脈 ----
  test('ドリルイン文法統一: inspector/caption/exportのどのシートも「← 決めるへ戻る」で必ず決定面へ戻る', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#claudeView')).toBeVisible();

    // 1) クリップ選択 → インスペクタ。
    const clip = page.locator('#clips .clip').first();
    await expect(clip).toBeVisible();
    await clip.click();
    await expect(page.locator('#inspectorView')).toBeVisible();
    await expect(page.locator('#inspectorBack')).toHaveText('← 決めるへ戻る');
    await expect(page.locator('#inspectorTitle')).not.toBeEmpty();
    await page.locator('#inspectorBack').click();
    await expect(page.locator('#claudeView')).toBeVisible();
    await expect(page.locator('#inspectorView')).toBeHidden();

    // 2) cue クリック → 字幕スタイル(対象ラベルは cue の文言を反映)。
    await page.locator('#tab-transcriptPanel').click();
    await page.locator(`#words .w[data-src="${fx.sourceId}"][data-id="w0000"]`).click();
    const cue = page.locator('#captionLayer .cue');
    await expect(cue).toBeVisible();
    await cue.click();
    await expect(page.locator('#captionView')).toBeVisible({ timeout: 1_000 });
    await expect(page.locator('#captionBackBtn')).toHaveText('← 決めるへ戻る');
    await expect(page.locator('#captionViewTitle')).toContainText(fx.cueA.text.slice(0, 10));
    await page.locator('#captionBackBtn').click();
    await expect(page.locator('#claudeView')).toBeVisible();
    await expect(page.locator('#captionView')).toBeHidden();

    // 3) ヘッダー「書き出し」→ 書き出しビュー。
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportView')).toBeVisible();
    await expect(page.locator('#exportBackBtn')).toHaveText('← 決めるへ戻る');
    await expect(page.locator('.rightViewTitle', { hasText: '書き出し' })).toBeVisible();
    await page.locator('#exportBackBtn').click();
    await expect(page.locator('#claudeView')).toBeVisible();
    await expect(page.locator('#exportView')).toBeHidden();
  });
});
