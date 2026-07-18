// DOM 操作ヘルパー。
//
// 単語(`#words .w`)クリックだけ特別扱いが要る: web/app.js の
// `$('words').addEventListener('pointerdown', ...)` はハンドラの中で
// `renderTranscript()` を同期的に呼び、#words のサブツリーを丸ごと
// 作り直す(押した瞬間のクリック対象 <span> がその場で DOM から外れる)。
// この状態で(カーソルを動かさずに)そのままボタンを離すと、Chromium の
// implicit pointer capture が「もう存在しない要素」を掴んだままになり、
// pointerup が一切配送されない(mouseup すら来ない)— 実機診断で確認済み:
// pointerdown/mousedown はそれぞれ検出できるが、その後 pointerup/mouseup/
// click が一切発火しないまま止まる。カーソルを(同じ要素の外へ)動かして
// からボタンを離すと、ヒットテストが再計算されて配送が復帰する。
//
// これは Playwright 固有の癖ではなく Chromium 自体の挙動(同期 DOM 置換を
// 伴う pointerdown ハンドラという、このアプリ固有のパターンで踏み抜く
// エッジケース)。単語一覧以外の要素(.clip/.cue/ボタン類)は該当ハンドラ
// 内で自分自身を同期的に置き換えないため、通常の locator.click()/
// dblclick() で問題なく動く(このファイルの他ヘルパー不要な理由)。
import type { Locator, Page } from '@playwright/test';

/**
 * 文字起こしパネルの単語 <span class="w"> を「クリックして選択+シーク」
 * する。上記の理由で通常の `.click()` は使わず、押す→(同じ #words 内の
 * 別の安全な地点へ動かす)→離す、という手順を踏む。アプリ側の選択ロジック
 * は最終カーソル位置ではなく「ドラッグが起きたか」だけを見る
 * (pointerover で始めて延長しない限り selWords.size===1 のまま)ため、
 * この動きは実際の「その場でクリック」と同じ状態を生む。
 */
export async function clickWord(page: Page, word: Locator): Promise<void> {
  const box = await word.boundingBox();
  if (!box) throw new Error('clickWord: target word is not visible/attached');
  const wordsBox = await page.locator('#words').boundingBox();
  if (!wordsBox) throw new Error('clickWord: #words panel is not visible');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // #words 自体のパディング隅(語のどれとも重ならない安全地点)まで動かして
  // から離す — パネル外(タイムライン/ステージ側)へ出て別のドラッグ機構を
  // 誤って刺激しないよう、意図的に同じ #words の中に留める。
  await page.mouse.move(wordsBox.x + 3, wordsBox.y + 3, { steps: 5 });
  await page.mouse.up();
}
