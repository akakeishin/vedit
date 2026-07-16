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
