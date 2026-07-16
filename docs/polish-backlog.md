# 磨き込みバックログ

更新: 2026-07-16(Codex 4観点レビュー後の triage で「今回見送り」とした項目)。
「ループ全体で勝ち、単機能で失望させない」ための継続改善リスト。
上から費用対効果順。着手時は各項目を1エージェント1仕事で切り出す。

## プレビュー体験(Codex 採点 2/5)

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

- [ ] golden export テスト: 23.976/29.97/30、混在 fps、44.1/48kHz、
      音声なし素材の .otio を固定化し、otio ライブラリ再読込を CI に
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
