# vedit ハンドオフ文書 — 後続エージェント/レビュアー向け

最終更新: 2026-07-18(第2版 — IA v3・賭けの改訂・オーバーレイ積層まで反映)。
対象読者: このセッションの文脈を持たない後続エージェント、および
**opencode(別モデル)での UI 根本再検討**の実施者(専用プロンプト:
docs/opencode-review-prompt.md)。作業前にこの文書と参照先を読むこと。

---

## 1. これは何か(30秒)

**vedit** = Claude Code/Cowork 上で動く会話型ローカル動画編集(NLE)スキル。
マニフェスト(project.json)+追記型 revision ログが真実源。ブラウザで
ライブプレビュー、ffmpeg で最終レンダー、OTIO+SRT で DaVinci Resolve へ
引き渡し。実写(vlog/ショート)と「ゆる紙芝居」コンポジション(キットの
スプライトアニメ)の両方を扱う。

- 起動: `node dist/cli.js open --project <dir>` → http://localhost:7799
  (**7799 はユーザーの実 daemon が使う。検証は必ず別ポート**:
  `serve --port <n>`。隔離環境の作り方は e2e/fixtures.ts が完全な手本)
- テスト: `npx vitest run`(33ファイル/1336+件)+ `npm run test:e2e`
  (Playwright 11本)+ smoke:export / smoke:compose / smoke:overlay(実 ffmpeg)
- スキル本体: skill/SKILL.md + skill/references/

## 2. 絶対に守る運用原則

1. **製品の賭け(2026-07-18 改訂版)**: 旧「感覚は UI、構造は会話」から
   **操作制限側を撤回**(ユーザー指示「普通の NLE みたいに使いやすく」)。
   タイムライン上の直接操作(分割/複製/複数選択/ショートカット/undo·redo
   等)は商用 NLE 級に完備する方針(仕様 specs/2026-07-18-vedit-nle-operability.md、
   src 側実装済み・web 側は意図的未実装 — §4)。会話側に残るのは「構造の
   生成」(選定・構成・演出判断・書き出し実行)と面倒作業の代行。
   不変: アプリ内チャット入力なし/書き出し実行ボタンなし/ローカル完結。
2. **デザインの正 = docs/design-refs/d4-cuesheet.html/png**「調整室と
   キューシート」(旧 Claude Design ハンドオフを上書き)。二面構成:
   部屋=暗い計器(#0F1013系・ヘアライン・銘板・読み出し窓・タリー)、
   右パネル=紙(#F5EF系・インク・朱=確認待ち/赤入れのみ)。
   **フォントはシステムゴシック+ui-monospace 固定**(ユーザー指示。
   Web フォント禁止)。意味色: 暗部=琥珀(確認待ち)/緑(接続のみ)、
   紙面=朱。装飾グラデ禁止、reduced-motion 対応必須。
3. **体制**: ディレクター(Fable/Opus 級)が原因確定・設計・レビュー、
   実装は Sonnet サブエージェント(ファイル所有権を割って並列)。
   **新機能・デザイン・エージェント設計の案出しは andashi スキル
   (密封 Scout+凍結+別文脈 Challenger)で Fable が行う**(記録:
   docs/andashi-2026-07-18.md — 採用/却下と理由)。**根本的な見直しは
   ユーザー自身が opencode(別モデル)で行う** — こちらの仕事は
   引き渡し品質(全 green・文書最新)。
4. **検証は本番**(docs/verification-plan.md / verification-log.md)。
   実レンダー・実操作でしか出ないバグがこのプロジェクトの主敵
   (実績: loudnorm 未接続、breathe 未消費、whisper 幻覚字幕、rAF 断線、
   pointerdown の click 喪失、**スプライト合成の永久ハング** — すべて
   実行検証だけが捕まえた)。モックを信じない。
5. **--base(revision)必須**の楽観ロック。409 は state 再読。undo/redo は
   restore の cause タグ+ログ再生導出(project.ts)。テストは HOME 隔離
   (test/setup.ts)— 壊さない。web の既存 DOM id は削除しない
   (変えるなら e2e を同時更新し同等カバレッジ維持)。

## 3. 何をやったか(要約と参照)

**〜2026-07-17**(第1版から): M1〜M4+機能波(取り込み/検出/カリング/
B-roll V2/BGM+ダッキング+loudnorm/リペア/色管理/QC/公開パック/OTIO/
キット/コンポジション/shift/--sfx/note+resume/書き出し結果記録)、
UI 情報設計 v2 → Claude Design 実装(W-DESIGN/W-POLISH)、
本番検証ループ全6シナリオ合格(verification-log.md)。

**2026-07-18(本日の大改修)**:
- **N1**: 検証残の根治(0.35s断片吸収/同一素材2回配置の字幕/dialogue --pos
  +重なり警告/detect断片化ヒント/静的スプライト警告)+ **Playwright e2e
  基盤**(隔離fixture、per-cue編集を実DOMで検証済み)+キット erashasu 修正
- **N2 計器盤**: 計器列・タリーランプ・**K6「押している間、直前」**
  (GET /api/manifest-at+ゴースト video で同一プレイヘッド比較)・
  **pointerdown 全再構築による click 喪失バグの根治**・システムフォント化
- **N3**: `vedit fork`(cache hardlink 流用)/`export render --range`
  (下見レンダー)/whisper 用語集/`compact`(revision 世代圧縮)/
  `vedit gc`/クリップ単位 gainDb·muted — CLI+daemon 両配線済み
- **N6 オーバーレイ積層**: OverlayClip の layer/rect/opacity/fade、
  画像ソース(kind:'image')、z順合成、OTIO V2..Vn。
  **既存バグ発見・修正: スプライト合成が実レンダーで永久ハング**
  (ループ静止画+shortest未指定)。scripts/smoke-overlay-stack.mjs で
  ピクセル検証
- **波E-1**: splitClip/duplicateClip/論理 undo·redo(ログ再生導出、
  バウンス根治)— CLI+daemon 配線済み(/api/undo|redo)
- **IA v3 波A**: 右パネルのキューシート化(lastSeen 新着区切り・
  **未決保護**・白紙にしない机=作業記録+書き出しカード+メモ+次の一手)
  +**時刻同期スリムバー**(再生中に候補区間で承認、右ペインと同一状態)
  +ドリルイン文法(← 戻る(文脈))
- **IA v3 波B**: 二面意匠の全面適用(上記 §2.2)+ GET /api/notes
- **意思決定記録**: docs/andashi-2026-07-18.md(機能8案・UI構造9案・
  意匠3案の採否と Opus 反証2本の要旨 — 「フィード=ホーム」を反証で棄却し
  常設ワークスペース+キューシートに修正した経緯を含む)

## 4. 意図的に未実装のもの(opencode 再検討待ち — 欠陥ではない)

ユーザーが opencode(Kimi K3)で UI を根本再検討する予定のため、
以下は**仕様だけ書いて意図的に止めている**(再検討結果と統合して実装):
1. **波E-2〜4** NLE 操作性の web 側(ショートカット/右クリックメニュー/
   複数選択/ズーム実機能化/undo·redo ボタン)—
   specs/2026-07-18-vedit-nle-operability.md
2. **波C i18n**: UI 文字列辞書化+日本語コピー全面推敲+en 切替 —
   specs/2026-07-18-vedit-ia-v3.md §3-4(コピー規範と対照表あり)
3. **波D オーバーレイ UI**: タイムラインの重ね行+rect/opacity シート —
   同 §5(src/daemon は実装済みなので web だけ)

その他の残課題(優先順): 規律層(#34: Capability Registry CI 照合+
Parity fixtures — docs/ui-reachability-audit.md が材料)/ DS 再同期
(claude.ai/design「vedit Design System」は旧テーマのまま)/ MCP 化(M5 —
右パネル「会話」タブは revision ログからの合成表示であり本物のミラーではない)。

## 5. 実は考慮していない/浅いところ(正直な議論)

- **性能**: 実検証は総素材82秒・3ファイルまで。長尺・多クリップでの
  タイムライン全再構築/transcript 全描画/revisions 肥大(compact は
  実装したが自動実行しない)は未測定。ズームは波E-2〜4 待ち。
- **環境**: macOS 前提が散在(ffmpeg パス、mdfind、OS フォント列挙)。
  daemon は localhost 平文・認証なし。複数タブ/複数プロジェクト同時の
  WS 競合は未検証。
- **品質の既知の妥協**: whisper は ggml-small(large-v3-turbo はユーザー
  保留中)。誤起こし本文はそのまま(用語集は次回転写から効く)。
  プレビュー≠最終出力の残り(リペア/実波形ダッキング/色変換/モーション
  ASS 近似)は Parity 契約(#34)で自己申告予定。K6 直前比較は映像のみ
  (字幕・スプライトは現行版のまま)+composition では disabled。
  サーバー生成文字列(revision 要約等)は i18n 対象外のまま。
- **テスト**: e2e 11本は主要回帰クラスのみ。VoiceOver 実査なし。
  生身のユーザーテスト未実施(「Cowork に頼む」チップの実運用感は仮説)。
- **設計上の未決**: キット後方互換ポリシー/shift と emoteAt/編集知性の
  実力(発話あり素材のハイライト選定シナリオ未検証 — K1「素材理解シート」
  弱形の probe も未実施。andashi 記録参照)。

## 6. 作業の作法(後続エージェントへ)

- 修正前に verification-log.md と本書 §5 を確認 — 既知か新規かを区別。
- web を触ったら: `node --check web/app.js`、コンソールエラーゼロ、
  **`npm run test:e2e` green 維持**(id を変えるならテストも同時更新)。
- src を触ったら: `npm run build`+関連 vitest+影響があれば smoke 3種。
- ユーザー可視文言: 内部 ID・CLI 構文・英日混在禁止。コピー規範は
  ia-v3.md §4。フォントはシステムスタック固定。
- port 7799 とユーザー実データ(~/Movies 等)に触らない。検証用
  プロジェクトの revision を変えたら必ず元へ。
- コミットは「何を・なぜ」を本文に。大きな方向転換は andashi 記録に追記。
