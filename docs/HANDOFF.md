# vedit ハンドオフ文書 — 後続エージェント/レビュアー向け

最終更新: 2026-07-18(第5版 — 実素材・長尺・配布・正式Deep監査まで反映)。
対象読者: このセッションの文脈を持たない後続エージェントとレビュアー。
作業前にこの文書、製品の賭け、AI-first検証記録を読むこと。UI再検討の原文は
`/tmp/vedit-ui-rethink/REPORT.md`、採用後の正は本書とrepo内文書である。

---

## 1. これは何か(30秒)

**vedit** = Codex / Claude Code等のCLIを扱えるAIエージェントと、ブラウザUIから
使う会話型ローカル動画編集(NLE)。特定のAIプロバイダーや会話面を要求しない。
マニフェスト(project.json)+追記型 revision ログが真実源。ブラウザで
ライブプレビュー、ffmpeg で最終レンダー、OTIO+SRT で DaVinci Resolve へ
引き渡し。実写(vlog/ショート)と「ゆる紙芝居」コンポジション(キットの
スプライトアニメ)の両方を扱う。

- 起動: `node dist/cli.js open --project <dir>` → http://localhost:7799
  (**7799 はユーザーの実 daemon が使う。検証は必ず別ポート**:
  `serve --port <n>`。隔離環境の作り方は e2e/fixtures.ts が完全な手本)
- テスト: `npm test -- --run` + `npm run test:e2e` + smoke:export /
  smoke:compose / smoke:overlay(実 ffmpeg)。最終freezeの実測は
  **Vitest 1,556/1,556、Playwright 31/31、smoke 3/3 PASS**。
  `verify:package`も56 files / 469,401 packed bytes / 1,572,776 unpacked bytesの
  browser dependency closureを確認した。隔離install検証ではCLI create/statusと
  参照UI資産のHTTP 200も確認した。
  正式experience-loop監査はschema-v2 validator PASS、`bounded-partial`。
  REVIEWのKeep→Undo→Redoだけが独立traceでexercised、AUTONOMYはreceipt不足、
  EXPORTはexact-confirmation、RETURNはcalibration混入としてgapに固定した。
  詳細と未証明項目はdocs/ai-first-validation-2026-07-18.md
- スキル本体: skill/SKILL.md + skill/references/

## 2. 絶対に守る運用原則

1. **製品の賭け(2026-07-18 AI-first 改訂版)**: 主ペルソナは「編集判断は
   できるが、反復操作はAIへ任せたいクリエイター」。低リスク・可逆・
   機械可読な根拠がある編集はAIが先に1 revisionで実行し、意味・好み、
   証拠不足/衝突、冒頭末尾、断片化で結果が変わる箇所だけ構造化質問にする。
   保護済みintent、不正、効果なし、判断済みは診断除外で質問にしない。
   ローカルMP4はアプリ内の明示ボタン、
   外部送信・公開は内容と宛先を示した明示確認が境界。詳細は
   docs/product-bet-sensory-vs-structural.md と
   docs/ai-first-validation-2026-07-18.md。タイムライン直接操作を商用NLE級へ
   近づける方針も維持する——AIの判断を検証し例外を直す精密工具だからである。
   不変: アプリ内チャット入力なし/ローカル完結/UIを開くだけでは変更しない。
2. **デザインの正 = docs/design-refs/d4-cuesheet.html/png**「調整室と
   キューシート」(旧デザインハンドオフを上書き)。二面構成:
   部屋=暗い計器(#0F1013系・ヘアライン・銘板・読み出し窓・タリー)、
   右パネル=紙(#F5EF系・インク・朱=確認待ち/赤入れのみ)。
   **フォントはシステムゴシック固定、ui-monospace 不使用**(2026-07-18
   UI再検討の決定。数値は `font-variant-numeric: tabular-nums` で桁幅のみ
   揃える。Web フォント禁止)。意味色: 暗部=琥珀(確認待ち)/緑(接続のみ)、
   紙面=朱。装飾グラデ禁止、reduced-motion 対応必須。
3. **体制**: 主エージェントが原因確定・設計・レビューを担い、独立可能な実装と
   検証はファイル所有権を分けたサブエージェントへ委譲する。
   **新機能・デザイン・エージェント設計の案出しは andashi スキル
   (密封 Scout+凍結+別文脈 Challenger)で行う**(記録:
   docs/andashi-2026-07-18.md — 採用/却下と理由)。根本方針を変える場合は
   `docs/product-bet-sensory-vs-structural.md` の反転条件と、
   `docs/ai-first-validation-2026-07-18.md` の未証明項目を先に更新する。
4. **検証は本番**(docs/verification-plan.md / verification-log.md)。
   実レンダー・実操作でしか出ないバグがこのプロジェクトの主敵
   (実績: loudnorm 未接続、breathe 未消費、whisper 幻覚字幕、rAF 断線、
   pointerdown の click 喪失、**スプライト合成の永久ハング** — すべて
   実行検証だけが捕まえた)。モックを信じない。
5. **--base(revision)必須**の楽観ロック。409 は state 再読。undo/redo は
   restore の cause タグ+ログ再生導出(project.ts)。`apply-candidates` /
   `reject-candidates` もrevisionから候補状態を再構成し、映像とキューを一緒に
   戻す。文字起こし更新もrevisionへ記録し、Undo/Redoと書き出しcaptureを
   同じ版へ固定する。テストは HOME 隔離(test/setup.ts)— 壊さない。web の既存 DOM id は削除しない
   (変えるなら e2e を同時更新し同等カバレッジ維持)。

## 3. 何をやったか(要約と参照)

**〜2026-07-17**(第1版から): M1〜M4+機能波(取り込み/検出/カリング/
B-roll V2/BGM+ダッキング+loudnorm/リペア/色管理/QC/公開パック/OTIO/
キット/コンポジション/shift/--sfx/note+resume/書き出し結果記録)、
UI 情報設計 v2 → デザイン実装(W-DESIGN/W-POLISH)、
本番検証ループ全6シナリオ合格(verification-log.md)。

**2026-07-18(本日の大改修)**:
- **N1**: 検証残の根治(0.35s断片吸収/同一素材2回配置の字幕/dialogue --pos
  +重なり警告/detect断片化ヒント/静的スプライト警告)。断片化は候補単位の
  構造化質問、素材単位のカリング案内、適用後の実削減量+吸収断片表示まで配線。
  **Playwright e2e基盤**(隔離fixture、per-cue編集を実DOMで検証済み)+
  キット erashasu 修正
- **N2 計器盤**: 計器列・タリーランプ・**K6「押している間、直前」**
  (GET /api/manifest-at+ゴースト video で同一プレイヘッド比較)・
  **pointerdown 全再構築による click 喪失バグの根治**・システムフォント化
- **N3**: `vedit fork`(cache を独立した CoW clone/copy で流用)/`export render --range`
  (下見レンダー)/whisper 用語集/`compact`(revision 世代圧縮)/
  `vedit gc`/クリップ単位 gainDb·muted — CLI+daemon 両配線済み
- **N6 オーバーレイ積層**: OverlayClip の layer/rect/opacity/fade、
  画像ソース(kind:'image')、z順合成、OTIO V2..Vn。
  **既存バグ発見・修正: スプライト合成が実レンダーで永久ハング**
  (ループ静止画+shortest未指定)。scripts/smoke-overlay-stack.mjs で
  ピクセル検証
- **波E-1**: splitClip/duplicateClip/論理 undo·redo(ログ再生導出、
  バウンス根治)— CLI+daemon 配線済み(/api/undo|redo)。AI初稿要約から
  Undo→Redo→再Undoも行え、通常編集が入るとRedoを破棄する。Webヘッダーにも
  「戻す / やり直す」を常設し、Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z、Ctrl+Yを配線。
  1120pxでは文言付き、320pxでも操作とdisabled状態へ到達できる
- **IA v3 波A**: 右パネルのキューシート化(lastSeen 新着区切り・
  **未決保護**・白紙にしない机=作業記録+書き出しカード+メモ+次の一手)
  +**時刻同期スリムバー**(再生中に候補区間で承認、右ペインと同一状態)
  +ドリルイン文法(← 戻る(文脈))
- **IA v3 波B**: 二面意匠の全面適用(上記 §2.2)+ GET /api/notes
- **UI根本再検討の実装(W1〜W6)**: 1360px最小幅を撤廃し960pxまで対応、
  狭幅の右パネルをシート化、タイムラインの実ズーム/追従/候補レーン、
  文字起こし内の判断、右紙を「決める/記録」の二層へ整理、設定を棚から分離。
  レビュー原文と限界は `/tmp/vedit-ui-rethink/REPORT.md`。
- **AI-first自律初稿**: `CutCandidate.evidence`、純粋ポリシー
  `planAutonomousCandidateBatch`、`POST /api/first-draft` / `vedit first-draft`。
  文字起こし+波形が一致し、intent外・内側・断片吸収なしの無音だけを
  AI actorの1 revisionで先に適用する。フィラー、片証拠、衝突、冒頭末尾は
  「AIから確認」に残す。protected/invalid/no-effect/already-decidedは
  `aiReview=excluded` の診断だけで、質問キューへ出さない。
  候補decisionもrevision化しUndo/Redoでキューと映像を同期。
- **候補キューの耐障害化**: detect/decideを同一project lockで直列化し、
  再検出時は同じsource/kind/範囲のproposal IDを再利用。現在manifestにない
  sourceの候補は選択不可にし、Undo後は隠してRedo時に復帰する。
  timeline commit後にcandidates.json更新が失敗してもrevision logから判断を再生する。
- **文字起こしの版固定**: transcribeをmanifestと同じcommitへ記録し、
  Undo/Redoでsidecarも復元。MP4開始時はmanifest/transcript/motionを同じ
  revisionの不変snapshotとしてcaptureする。
- **アプリ内ローカルMP4**: `POST/GET/DELETE /api/export-job`、固定の
  `<project>/exports/`、表示revisionの楽観ロック、同期的な開始予約で単一ジョブ、
  symlinkを含むproject外escape拒否、中止・失敗・再試行、daemon再起動時の
  partial cleanup/確定済みsuccess判定/interrupted復旧、実ffmpeg結果カード。
  結果履歴の並行appendもlock+atomic renameで欠落を防ぐ。外部送信はしない。
- **UIのproject境界**: `/api/project` のprojectDirでreloadを再検証し、
  切替時に候補/書き出し結果/ジョブ等をreset。遅れて届くfetch/WSも開始元
  projectDirが違えば捨てる。接続表示は会話AIとの接続を装わず、実際に観測できる
  「編集エンジン接続済み/再接続中」とする。
- **実素材検証**: 93本・約7.58時間・約2.50 GiBを一括取り込みし、93/93本の
  integrityを独立確認。93素材UI、40行ずつの段階描画、検索、7.6時間ruler、
  320/390/768pxを確認した。78分38.6秒素材の文字起こしは再読込復帰・中止・
  再試行を実行。27シーンは独立ffmpeg検出と件数一致、境界差max 0.467 ms。
- **編集・配布検証**: 3種類の実素材を14.0109秒へ編集し、映像14.040秒・
  音声14.011秒、48 kHz stereo、-14.38 LUFSで出力。区間SSIMは
  0.9789 / 0.9506 / 0.9547 / 0.9313。npm tarballを隔離先へ実installし、
  同梱UI assetsのHTTP 200を確認。
- **容量整理**: 再生成可能な一時clone・生成物・古い検証動画を初回に約74.7 GiB
  削除。最終監査でも停止中かつcleanな`/tmp/staticvr180-*`等を対象確認して
  空き容量を59 GiBから165 GiBへ増やした。監査後は複製state約4.7 GiBも削除し、
  一次証跡を約5.9 MiBへ縮約。ユーザー素材、93本corpus、実素材監査projectは保持。
- **検証記録**: docs/ai-first-validation-2026-07-18.md。上記実素材検証と、
  機械可読fixtureの12自動/3質問は別の証拠として記録する。12/3はポリシーと
  状態機械のfixtureであり、実素材の分布ではない。正式Deep監査の一次記録は
  `/tmp/vedit-experience-final/report.md` と `audit-bundle.json`。人間の感情・
  使いやすさは測っておらず、次は3ペルソナ×2人の30分同一課題を行う。
- **意思決定記録**: docs/andashi-2026-07-18.md(機能8案・UI構造9案・
  意匠3案の採否と独立反証2本の要旨 — 「フィード=ホーム」を反証で棄却し
  常設ワークスペース+キューシートに修正した経緯を含む)

## 4. 残っているもの

1. **波E-2〜4の残り**: ズーム/全体表示/追従は実装したが、右クリックメニュー、
   複数選択、ショートカット体系の全面統一などは未完。
   specs/2026-07-18-vedit-nle-operability.md
2. **波C i18n**: UI 文字列辞書化+日本語コピー全面推敲+en 切替 —
   specs/2026-07-18-vedit-ia-v3.md §3-4(コピー規範と対照表あり)
3. **波D オーバーレイ UI**: タイムラインの重ね行+rect/opacity シート —
   同 §5(src/daemon は実装済みなので web だけ)
4. **外部送信/公開**: 意図的に未実装。ローカルMP4生成とYouTube等への送信を
   同じ操作にしない。将来追加する場合もアプリ内の別ボタンに宛先・内容・
   アカウントを示して明示確認する。

その他の残課題(優先順): 規律層(#34: Capability Registry CI 照合+
Parity fixtures — docs/ui-reachability-audit.md が材料)/ 旧デザインシステムの
再同期/ MCP 化(M5)。

**一般向け商用releaseの必須未達**:

- 生身のクリエイターによる操作性テストと、完成編集のブラインド品質比較
- 素材権利・利用条件・attributionの完全なinventory。技術検証コーパスを
  製品サンプルや同梱物へ転用しない
- Windows/Linux実機、配布更新、後方互換versioning、support/復旧方針
- privacy表記、third-party notices、VoiceOver実査、キーボード操作の網羅
- ディスク不足・容量逼迫、強制終了、長時間render中断の実機fault injection

これらが終わるまで「商用品質へ向けた技術検証版」であり、商用release済みとは
扱わない。

## 5. 実は考慮していない/浅いところ(正直な議論)

- **性能**: 93本・約7.58時間の取り込み、93素材UI、78分38.6秒の
  transcribe再読込/中止/再試行までは実測した。これで長時間render、数百〜数千
  素材、revisions肥大、低メモリ、ディスク不足が安全だとは言えない。
  `compact`は実装済みだが自動実行しない。
- **環境とローカル安全境界**: 現在の実機検証はmacOS。daemonはloopbackで
  Host / Origin / Sec-Fetch-Siteとproject identityを照合し、cross-site要求と
  project取り違えを防ぐ。これはユーザー認証や暗号化ではなく、信頼できない
  同一マシン利用者、LAN公開、複数OSを保証しない。複数タブが同時に別projectへ
  切替/編集する競合も未検証。
- **品質の既知の妥協**: whisper は ggml-small(large-v3-turbo はユーザー
  保留中)。誤起こし本文はそのまま(用語集は次回転写から効く)。
  プレビュー≠最終出力の残り(リペア/実波形ダッキング/色変換/モーション
  ASS 近似)は Parity 契約(#34)で自己申告予定。K6 直前比較は映像のみ
  (字幕・スプライトは現行版のまま)+composition では disabled。
  サーバー生成文字列(revision 要約等)は i18n 対象外のまま。
- **AI編集品質**: 二重検出は「音響的な無音」の根拠であって「作品上削って
  よい」の証明ではない。意味のある間は先にintent zoneへ保護する必要があり、
  その素材理解はモデル/人間に依存する。従来shibuya fixtureは人工の連続音で、
  12件の語間候補に波形根拠がない。実素材でレンダー整合は測ったが、作品としての
  自然さ、面白さ、12/3の分布、取り消し率は人間に測っていない。
- **質問の学習**: フィラー等は毎回候補単位で聞く。シリーズ方針を構造化して
  次回の自律度へ安全に反映する仕組みは未実装(NOTESのprefは自然文のみ)。
- **ASR**: 640.306秒素材で1,361 timed wordsを生成し、公開subtitle由来の
  1,372語と比べた正規化edit disagreementは11.95%。subtitle自体を人間が
  校正したground truthとして監査していないため、human WERとは呼ばない。
- **テスト**: 最終freezeでVitest 1,556/1,556、Playwright 31/31、実ffmpeg
  smoke 3/3、build、56-file package closure、空環境installがPASS。自動回帰、SSIM、
  モデルpersonaを、生身のユーザー満足度や編集品質スコアとして扱わない。
  VoiceOver実査は未実施。
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
