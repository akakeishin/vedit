# vedit

会話型ローカル NLE。Claude(Fable/Sonnet)を編集ディレクターに、ローカル動画を
非破壊でカット・字幕・モーション演出し、ブラウザでライブプレビュー、
DaVinci Resolve / Premiere へタイムラインごと書き出す。

```text
Claude ──CLI/MCP──> vedit daemon(Node/TS)──WS──> Web NLE(ブラウザ)
                     ├ manifest + revision log(source of truth)
                     ├ ingest: proxy / waveform / whisper 文字起こし
                     └ export: OTIO / FCP7 XML / ffmpeg render
```

## クイックスタート

```bash
npm install && npm run build && npm link
vedit doctor --download-model ggml-large-v3-turbo   # 初回のみ(~1.6GB)
vedit create ~/edits/myvlog --name myvlog
vedit ingest ~/Movies/raw.mp4 --language ja
vedit open        # → http://localhost:7799 でプレビュー
vedit transcript  # packed transcript を見てカット開始
```

Claude Code から使う場合は `skill/` を `~/.claude/skills/vedit` に
symlink(済みなら「動画編集して」で発動)。

## 設計

[docs/superpowers/specs/2026-07-16-vedit-design.md](docs/superpowers/specs/2026-07-16-vedit-design.md) 参照。要点:

- **非破壊**: 元素材は不変。編集は manifest(JSON)の書き換えのみ。
  修正のたびのエンコードはゼロ、プレビューはプロキシのマッピング再生
- **revision log**: UI と会話の編集が同じ履歴に載る。stale base は 409 拒否
- **transcript-first**: カットは単語 id で指示(`remove-words w0120..w0134`)。
  無音・フィラーは決定論的検出 → 承認/却下キュー
- **モーションは spec のまま**: DOM/CSS で即時プレビュー、いつでも再編集可
- **interchange**: OTIO(Resolve 18.5+ 無料版ネイティブ)+ FCP7 XML(Premiere)

## 開発

```bash
npm test          # core ユニットテスト(vitest)
npm run build     # tsc
node dist/cli.js serve --project <dir>   # daemon をフォアグラウンドで
```

## 既知の制限(次フェーズ候補)

- 提案ブランチ(複数編集案の並行比較 UI)は未実装(M5)
- MCP サーバー(Cowork 接続)は未実装(M5)— daemon の HTTP API を包むだけ
- モーションの最終レンダー焼き込みは未実装(NLE handoff はマーカー+spec)
- whisper のトークン分割により複数トークンのフィラー(「えーと」)が
  filler 検出を逃すことがある(remove-words では普通に消せる)
- 長尺・複数素材はプロキシ切替時に一瞬止まる可能性(WebCodecs 移行で解消予定)

## 新機能(ワークフロー拡張)

- クリップの取捨選択・並べ替え: `vedit sources` で素材一覧、
  `vedit ingest --no-add` で素材プールにだけ追加、
  `vedit clip-add` / `clip-remove` / `clip-move` でタイムライン編集
- 9:16 などの縦ショート対応: `vedit reframe 9:16 --focus center` で
  一括リフレーム、`vedit clip-crop` で個別クリップの微調整。
  プレビュー・フィルムストリップ・最終レンダーすべてに反映(OTIO は
  メタデータ記録のみ、Resolve 側では再現されない旨を警告)
- 字幕エクスポート: `vedit export srt` / `vedit export ass` を追加。
  `vedit export otio` は同名の .srt を自動生成するようになった
  (OTIO 単体では字幕が消えていた問題への対処)
- プロジェクト一覧とスタイルプリセット: `vedit projects` で
  過去に開いたプロジェクトを一覧、`vedit preset-save` /
  `preset-apply` / `preset-list` で字幕スタイル等を使い回し
