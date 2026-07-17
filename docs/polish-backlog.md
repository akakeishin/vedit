# 磨き込みバックログ & 機能ロードマップ

## 機能ロードマップ v3(2026-07-17 徹底棚卸し3本の統合)

入力: 実写編集棚卸し(6シナリオ机上走行)/アニメ棚卸し(45秒3シーン
ウォークスルー)/Codex 機能深度コンサル。方針: **本番検証ループの前に
「検証で確実に踏む」P0/P1 を消化**し、L サイズ提案は S/M の代替設計で痛みを
先に消す。✅=着地済み。

**Fix 波A — 検証前必須(進行中)**
- ✅ セリフ吹き出しの ASS 描画(BorderStyle=3 セマンティクス+可視上端アンカー)
- ✅ breathe がレンダー無動作(scale=eval=frame で式消費、emote も自前プラン)
- ✅ Selects が keep シーン内の word 編集を巻き戻す(交差保持、--raw で旧動作)
- ✅ export-guide 実装追随(A2 制限/V2/スプライト/マーカー)
- ✅ レジストリ汚染(テスト HOME 隔離+並列剪定)
- ✅ publish-pack がコンポジションでサムネ0枚(bg境界+登場時刻、renderedFile 抽出)
- ⏳ **P0: compose 再実行が backgroundTrack を消す**(保持スプレッド+範囲外切替点の除去)
- ⏳ **P1: スプライト z 順の web/render 不一致**(配列順=z順に統一)
- ⏳ CLI 配線残: publish-pack --render / W7 motionSpecs(loadMotionSpecs)/ selects --raw の daemon 配線
- ⏳ smoke:compose(実レンダー統合検知 — loudnorm/breathe 級のバグの恒久対策)

**再発防止の規律(Codex 3分類レビュー 2026-07-17 採用 — 検証ループ後に導入)**
- **Capability Registry**: 全機能に uiExposure
  (direct / inspector / claude-only-with-guidance / result-only / internal)
  を宣言する単一の正を作り、daemon dispatcher / CLI switch / web の露出を
  CI で照合(未分類=fail)。「入口のない機能」を構造的に再発不能に
- **Parity 契約**: 機能ごとに exact / approximate / export-only /
  omitted-on-export を宣言し、approximate 以下は UI に自己申告バッジ。
  manifest fixture でプレビュー/レンダー差分をテスト固定
- **mutation 状態機械**: 全 mutate を idle→pending→committed/syncing→
  succeeded / failed-before-commit / committed-but-refresh-failed に統一
  (「保存成功なのに再読込失敗を編集失敗と誤表示」等の解消)。
  応答エンベロープ {operationId, revision, summary, warnings, noOp} 統一

**Fix 波B — 検証前に判断(小さく効く)**
- **`vedit shift --from <t> --by <±秒>`**: t 以降の背景切替点・スプライト・セリフ・
  music tlStart を一括平行移動(Codex 提案「シーン単位リップル(L)」の S/M 代替。
  コンポジションの「間」調整の反復を1コマンド化)
- **SE 糖衣**: `music-add --sfx`(no-duck/no-fade/短フェード既定)— ゆる紙芝居の主演出
- **dialogue の `--pos` 手動指定+同時刻重なり警告**(8個置くと確実に踏む)
- **通常プロジェクトのスプライト motion**: レンダー静的描画のまま**警告を出す**
  (焼き込み対応は composition 経路の実績を見てから判断)
- 通常プロジェクトのプレビューに dialogue が出ない parity(web、UI 再設計後)

**UI 波 — 再設計「ステージと書斎」着地後に載せる**(実写監査 P1 群)
- music-add ボタン / 字幕ベースプリセット切替 / reframe・clip-crop の視覚操作
- Selects 置換ダイアログに「微修正は保持されます」の文言反映(新既定の説明)
- resume 相当の「先週ここまで」ビュー(いま タブ拡張、notes 表示)

**機能波(検証後、v2 から繰り越し+Codex 採用分)**
- W6: 横→縦の派生プロジェクト / W10: アーカイブ/再リンク(v2 のまま)
- music/motion の source アンカー化(B-roll の orphan 規則を横展開)
- クリップ/ソース単位の gain・mute・repairPreset 上書き
- B-roll V2 の個別クロップ焦点
- **範囲指定の下見レンダー**(`export render --range a..b` — 音・色の A/B を数秒で)
- エピソードテンプレ複製(composition の型を保って中身差し替え)
- 背景遷移プリセット(crossfade|dip-color、0.2〜0.6s)
- Resolve handoff mix pack(ステム書き出し、L — 需要を検証ループで確認してから)
- emoteAt の真クロスフェード(ベース側フェード、シルエット差がある素材で顕在化)

---

## 機能ロードマップ v2(2026-07-17 Codex コンサル反映)

方針: 派手な機能より「毎週の反復作業」(選別・B-roll・音声修復・派生版・
QC・アーカイブ)を先に埋める。✅=実装済み。

**完了**: ✅ I: BGM+ダッキング+loudnorm / ✅ J+M: 公開パック(チャプター+
サムネ+materials、説明文はディレクター起草)+書き出しプリセット

✅ Phase 1 完了(W1 リペア/resume/色メタ、W2 カリング、W3 B-roll V2 —
実素材で B-roll 合成・2-pass loudnorm・preset render を確認済み)

**Phase 1 — 毎週の中核ワークフロー(この順で実装)**
1. **W1: 会話音声リペア + resume + 色メタデータ捕捉** — outdoor/indoor/wireless
   の保守的プリセット(highpass/afftdn/deesser/acompressor)、音楽なしでも
   2-pass loudnorm、乾音A/B。+ `vedit resume`(再開サマリの集約)。
   + ingest 時に color_primaries/transfer/space/bit depth を Source に記録し、
   Log/HLG 素材なら status と UI に「要入力変換」警告(変換自体は W5)
2. **W2: 3状態カリング + Selects** — scene/source 単位の
   unreviewed/keep/reject(manifest 保存・undo 対象)、キーボード選別、
   残件数、「keep だけで仮タイムライン」
3. **W3: B-roll V2 トラック + J/Lカット** — 重複不可の V2 一層のみ。
   OverlayClip を clipId/wordId/sceneId+offset にアンカー、
   audioMode: mute|mix|replace。web は第二 video、render は overlay、
   OTIO は V2 出力。※最大の設計変更、着手前に Fable がミニ仕様を書く

**Phase 2 — 制作サイクルの外周**
4. W4: 検証付きインジェスト(SHA-256、copy/link、重複検出、中断再開)
5. **W5: 入力色管理**(汎用 — DJI D-Log(2)/HLG も他カメラの Log も対象):
   W1 で記録した色メタデータに基づき zscale/lut3d で Rec.709 へ入力変換
   (プロキシ生成時に適用しプレビューも正しい見た目に)、露出/WB/彩度の
   3パラメータのみ提供、代表フレームのヒストグラム差からショットマッチ候補
   を提案(承認制)。LUT はユーザー提供 or 標準変換式のみ
6. W6: 横→縦の派生プロジェクト(variant fork、revision 固定、hardlink)
7. ✅ W7: モーションの最終レンダー焼き込み(4プリセット→ASS/ffmpeg 変換のみ、
   custom-html は対象外と明示)
8. **W8: キット(プロジェクト横断の制作設定)** — 仕様確定:
   docs/superpowers/specs/2026-07-17-vedit-kit-design.md。ぽんしゃす実データ
   (profile/design-presets/asset-pack/GUIDE)をそのまま読む参照型。
   デザインプリセット→字幕/ASS/フォント、**スプライトオーバーレイ(新規)**、
   profile/ガイド→ディレクター判断へ露出。W5 の次に実施(ユーザー要望)
9. W9: 公開前QC(blackdetect/silencedetect/ebur128 → HTML レポート)
10. W10: アーカイブ/再リンク(コピー+SHA-256+相対パス化、dry-run、元素材不削除)

**Phase 3 — 差別化・分析(andashi 案出し 2026-07-17 の採用分を統合)**
- 採用: **静寂スコア**(intentZones[] で「守るべき無音」を保護、detect/BGM と衝突警告 —
  既存の「意味のある間」思想の機械化)/ **撮り足しコンパス**(ラフカットの欠損画を
  次回撮影カードに、Analytics 波と同梱)/ **編集判例帳ライト**(候補の承認/却下理由を
  自動蓄積、提案時に関連例を表示。手入力は求めない)
- W9(QC)に **テンポ契約ライト**を同梱(profile の pacing 宣言と実測カット密度の
  差分表示のみ。数値合わせの強制はしない)
- 見送り: 知覚リハーサル(バックログ末尾)、編集インバリアント(vlog は構造が毎回
  変わる)、伏線・証拠台帳(日常vlogには過剰)
11. W11: K マルチテイク選択(カリング実装後。n-gram+編集距離)
12. W12: Analytics CSV→タイムライン振り返り(比較データ3本たまってから)
13. W13: L 倍速ジャンプカット(1倍速前提を崩す高コスト変更。フリーズは保留)

**作らないもの(戦略判断)**: 汎用マルチトラック、YouTube 直接アップロード、
クラウド素材検索、フルカラーグレーディング UI、タグ自動生成(YouTube 公式が
効果を綴り補正程度と説明)、ニューラルVAD全面置換、フリーズフレーム


更新: 2026-07-16(Codex 4観点レビュー後の triage で「今回見送り」とした項目)。
「ループ全体で勝ち、単機能で失望させない」ための継続改善リスト。
上から費用対効果順。着手時は各項目を1エージェント1仕事で切り出す。

## プレビュー体験(Codex 採点 2/5)

- [ ] loudnorm 計測パスの音声専用グラフ化(現在は映像を nullsink で終端し
      decode コストだけ発生 — 長尺 4K で計測が遅い)

- [ ] シーク/境界の計測基盤: seeking/seeked/waiting/canplay を計測し
      P50/P95 とクリップ境界 gap をログ(改善の前に測る)
- [ ] 同一ソースで source-time が連続する境界では seek しない
- [ ] `<video>` 二重化による次クリップ先読み+境界スワップ
      (目標: シーク P95 < 150ms、境界 gap < 1フレーム)
- [ ] 上記でも不足なら MSE/WebCodecs フレームキューへ段階移行
- [ ] タイムラインのズーム/横スクロール(長尺での精密シーク)

## 字幕(Codex 採点 2/5 → H で CPS/スタイル一致は対応済み)

- [ ] 日本語の文節・禁則を考慮した1〜2行分割(budou-x 等の軽量ライブラリ検討)
- [ ] 同一素材を2回置いたとき字幕が1回しか出ない問題
      (sourceTimeToTimeline が最初の一致しか返さない → Segment 起点の cue 生成へ)
- [ ] スタイルプリセットの拡充(karaoke-focus 等)と Web/ASS の自動一致テスト

## 文字起こし(Codex 採点 2/5 → H でプロファイル/句読点/来歴は対応済み)

- [ ] whisper.cpp の Silero VAD オプション対応(対応ビルドの検出込み)
- [ ] packed 率・ゼロ幅語率が閾値超の素材だけ stable-ts / faster-whisper で再アライン
- [ ] 固有名詞プロンプト(用語集)を preset に保存して ingest に渡す

## 検出(Codex 採点 2/5 → H でヒステリシス/n-gram は対応済み)

- [ ] ステレオ素材で片チャンネルの発話を保護する判定
- [ ] room-tone 考慮(将来。ニューラル VAD 全面置換はやらない — 線引き済み)

## エクスポート(Codex 採点 3/5 → D で Gap/丸め/URL は対応済み)

- [x] golden export テスト(実装済み: golden.test.ts + npm run smoke:export)
- [ ] Resolve / Premiere への実 import をリリース前 smoke test として手順化

## UX(Codex レビューから見送り分)

- [ ] 論理 undo/redo スタック(現状は restore ベース+ラベル改善のみ)
- [ ] CLI `--json` グローバルフラグと `{ok,data,hint,error}` 統一封筒
- [ ] 接続断時の編集ブロック(現状は再接続表示のみ)
- [ ] ソースドロワー(シーンサムネの ✓/✕ culling UI — scene index 設計の後続)

## revision store(Wave F で対応中 → 残り)

- [ ] revisions.jsonl の世代圧縮(snapshot 全量保存の肥大対策。
      直近 N 件は全量、それ以前は間引き)

## スキル運用

- [ ] Fable サブエージェントによるスキル運用レビュー(SKILL.md を Sonnet が
      運転したときの編集品質シミュレーション)— Codex レビュー消化後に1本
- [ ] MCP サーバー化(Cowork 接続、M5)
- [ ] モーションの最終レンダー焼き込み(headless Chromium)
- [ ] 提案ブランチ比較 UI(M5)
