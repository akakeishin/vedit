# vedit ハンドオフ文書 — 後続エージェント向け

最終更新: 2026-07-18。対象読者: UI・ユーザビリティ・単発機能の修正/レビューを
行う、このセッションの文脈を持たないエージェント。**作業前にこの文書と
参照先を読むこと。**

---

## 1. これは何か(30秒)

**vedit** = Claude Code/Cowork 上で動く会話型ローカル動画編集(NLE)スキル。
マニフェスト(project.json)+追記型 revision ログが真実源。ブラウザで
ライブプレビュー、ffmpeg で最終レンダー、OTIO+SRT で DaVinci Resolve へ
引き渡し。実写(vlog/ショート)と「ゆる紙芝居」コンポジション(キットの
スプライトアニメ)の両方を扱う。

- 起動: `node dist/cli.js open --project <dir>` → http://localhost:7799
- テスト: `npx vitest run`(2026-07-18 時点 全 green)+
  `npm run smoke:export` / `npm run smoke:compose`(実 ffmpeg/OTIO 統合)
- スキル本体: skill/SKILL.md + skill/references/

## 2. 絶対に守る運用原則

1. **製品の賭け「感覚は UI、構造は会話」**(docs/product-bet-sensory-vs-structural.md)
   — UI は知覚チューニング(再生・字幕の見た目・音量・位置・採否)に完全、
   構造編集(カット構成・ハイライト選定・書き出し実行)は会話側 Claude の仕事。
   UI に書き出し実行ボタン・razor・compose 構築 UI を**作らないこと**。
   構造系の行き止まりには「Cowork に頼む」コピーチップを置く。
2. **デザインの正 = Claude Design ハンドオフ**
   (scratchpad/design-feedback/design_handoff_vedit_nle_redesign/ の
   「vedit Pro v2.dc.html」+ README.md。scratchpad 消失時は
   ~/Downloads/アプリ・スキルのデザイン改善.zip が原本)。トークン(#131315系、
   IBM Plex、白プライマリ)・レイアウト(左300px/中央/右344px)・
   意味色規律(--pending 琥珀=確認待ちドットのみ、--ok=接続のみ、
   装飾グラデ禁止)はここに従う。乖離の指摘一覧: docs/design-review-codex.md。
3. **体制**: ディレクター(Fable/Opus 級)が原因確定・設計・レビュー、
   実装は Sonnet サブエージェント(ファイル所有権を割って並列)、
   Codex は節目の第二の目。ユーザー指示によりコード編集はサイズを問わず
   サブエージェントへ。
4. **検証は本番**(docs/verification-plan.md / verification-log.md)—
   修正したら同シナリオを頭から再走。「実レンダーでしか出ないバグ」が
   このプロジェクトの主敵(実績: loudnorm 未接続出力、breathe 未消費、
   whisper 幻覚字幕、キット素材のラベル違い)。モックを信じない。
5. **--base(revision)必須**の楽観ロック。409 が出たら state を読み直す。
   undo は復元 op。テストは HOME 隔離済み(test/setup.ts)— 壊さない。

## 3. 何をやったか(要約と参照)

- **M1〜M4+機能波**: 取り込み(リンク優先/SHA-256/シーン先行・転写は遅延)、
  無音/フィラー検出(適応閾値)、カリング/Selects、B-roll V2、BGM+ダッキング+
  2-pass loudnorm、会話リペア、色管理、QC、公開パック、OTIO/SRT/fcp7xml、
  キット(vedit-kit/v1)、コンポジション(W-ANIME: 背景トラック/スプライト
  モーション/セリフ吹き出し)、`vedit shift`(間の一括調整)、`--sfx`、
  編集メモ(`vedit note`+resume)、書き出し結果記録(cache/export-results.json
  + GET /api/export-results)。
- **UI**: 情報設計 v2(spec: docs/superpowers/specs/2026-07-17-vedit-ui-ia-v2.md)
  → Claude Design ハンドオフ実装(W-DESIGN)→ 仕上げ(W-POLISH、
  docs/design-review-codex.md 消化)。右パネルは
  claude|clip|caption|export の4モード排他。show 指示はインスペクタより優先。
  mutation 状態機械(saved-but-refresh-failed を正直表示)。全ブロック
  キーボード到達可。シークは同期描画(rAF 待ちにしない — app.js の
  renderPlaybackFrame 参照)。
- **本番検証ループ**: 全6シナリオ合格(docs/verification-log.md が一次資料。
  発見→修正→再走の記録つき)。
- 今日の主な根治: compose 再実行の背景消失(P0)、字幕/セリフの書き出し既定、
  再生の物理終端スタック、emote 二重描画、whisper 幻覚タグの字幕化、
  シーク表示断線、レジストリ汚染。

## 4. 未完了・次にやるべきこと(優先順)

1. **検証ログの残項目**(docs/verification-log.md):
   - per-cue テキスト編集(ステージ cue ダブルクリック)の実操作確認
     (検証ツールの入力配送制約で未確認。人手で1回)
   - キット素材の焼き込み文字(erashasu)差し替え/0.1s 断片クリップの吸収
     (F-s1-1)/発話なし素材への detect 適用ヒント(F-s1-3)
2. **規律層(タスク#34、検証済みなので今が導入適期)**: Capability Registry
   (uiExposure 5分類を単一の正にして daemon/CLI/web の露出を CI 照合)、
   Parity 契約 fixtures、mutation エンベロープ統一。分類の材料は
   docs/ui-reachability-audit.md(53能力の格子)。
3. **ロードマップ v3 の機能波**(docs/polish-backlog.md): W6 派生フォーク、
   W10 アーカイブ、music/motion のソースアンカー化、クリップ単位音声、
   B-roll クロップ、範囲下見レンダー、dialogue --pos+重なり警告、
   コンポジション編集 UI(波3、claude-only の設計判断済み)。
4. **MCP サーバー化(M5)**: 右パネル「会話」タブは現在 **revision ログからの
   合成表示**であり、本物の Cowork 会話ミラーではない。MCP 接続が本丸。
5. デザインシステム同期の更新: claude.ai/design「vedit Design System」は
   旧テーマのカード。W-DESIGN 後のトークンで再抽出・再同期すると
   Claude Design との往復が継続できる(手順: 過去の vedit-ds/ 生成→DesignSync)。

## 5. 実は考慮していない/浅いところ(正直な議論)

**性能・スケール**
- 実検証は**総素材 82 秒・3ファイル・タイムライン 48 秒まで**。30分素材×10本、
  1000 クリップ、数百 cue での挙動(タイムライン描画は毎回全再構築、
  revisions.jsonl は全量スナップショット追記で肥大、transcript の DOM も
  全量描画)は未測定。preview のシーク計測基盤(backlog 記載)も未着手。
- プロキシ/キャッシュの削除戦略がない(cache/ は増える一方)。
- ズームスライダーは「今後対応」の正直 disabled のまま(長尺で必須になる)。

**環境**
- **macOS 専用の前提が散在**: ffmpeg-full の Homebrew パス、mdfind
  (D&D の再リンク)、OS フォント列挙。Windows/Linux は動かない可能性が高い。
- daemon は localhost 平文 HTTP・認証なし(単一ユーザー前提)。LAN 公開や
  マルチユーザーは設計外。パス封じ込めはあるが敵対的入力の監査はしていない。
- 複数プロジェクト同時編集・複数ブラウザタブの WS 競合は未検証
  (検証中も daemon の向き先取り合いが実際に起きた)。

**品質の既知の妥協**
- whisper は ggml-small(large-v3-turbo 未導入 — ユーザー保留中)。幻覚タグは
  cue 生成で除外するが、**誤起こし本文はそのまま**(用語集プロンプト未対応)。
- プレビュー≠最終出力の残り: リペア/実波形ダッキング/色変換ラグ/モーションの
  ASS 近似(Parity 契約で「自己申告」する方針だが網羅は未完 —
  docs/ui-reachability-audit.md 表2)。
- 通常(実写)プロジェクトのスプライトモーションはレンダーで静止のまま
  (警告も未実装)。composition のみ動く。
- 日本語の文節折返し(budou 系)未対応。字幕の禁則は素朴。

**テストの穴**
- web/ は純ロジック 2 ファイル以外 **DOM テストゼロ**。今回の回帰
  (rAF 断線・pointer 配線)は全部ここで起きた。Playwright 等の導入価値大。
- スクリーンリーダー実査なし(キーボード/aria はあるが VoiceOver 未確認)。
  reduced-motion は主要箇所のみ。
- 検証はすべて「私(エージェント)が操作」— 生身のユーザーテストは未実施。
  特に「Cowork に頼む」チップの実運用感(コピー→貼り付けの摩擦)は仮説のまま。

**設計上の未決**
- キット形式(vedit-kit/v1)の後方互換ポリシー未定義(フィールド追加は
  optional 運用だが、破壊的変更の手順がない)。キット素材の検品
  (背景が本当に full-bleed か等)は kit-scan で警告する仕組みができたが
  kit-init 時のガイドは薄い。
- shift はスプライト相対の emoteAt を動かさない(仕様として明文化したが、
  跨るスプライトの表情とセリフがずれる編集ケースの UX は未解決)。
- 「編集判例帳ライト」「静寂スコア」「撮り足しコンパス」等 Phase 3 構想は
  未着手。編集知性(「いい感じ」)の実力は playbook + モデル頼み —
  発話のある素材での本格的なハイライト選定シナリオは未検証
  (検証②は無発話素材だった)。
- フォント: IBM Plex は Google Fonts 依存(オフライン時はシステムフォールバック
  で成立するが見た目が変わる)。同梱ライセンス整理はしていない。

## 6. 作業の作法(後続エージェントへ)

- 修正前に docs/verification-log.md と本書 §5 を確認 — 既知か新規かを区別する。
- web を触ったら: `node --check web/app.js`、コンソールエラーゼロ、
  対象プロジェクトの revision を変えたら必ず元へ(検証用プロジェクト:
  scratchpad/verify-s1(実写)/ verify-s6-anime(コンポジション、キット付き)
  — scratchpad はセッション消滅で消えるため、恒久検証素材が要るなら
  ~/Movies/Claude_Vlog/projects/2026-07-10/ から作り直す)。
- src を触ったら: `npm run build` + 関連 vitest + 影響があれば smoke 2種。
- ユーザー可視文言: 内部 ID・CLI 構文・英日混在禁止。「Claude/Cowork に
  伝えてください」の導線で締める。
- コミットメッセージは「何を・なぜ」を本文に(このリポジトリの慣行に合わせる)。
