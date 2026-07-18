# vedit

会話型ローカル NLE。Codex / Claude Code などのAIエージェントを編集ディレクターに、
ローカル動画を非破壊でカット・字幕・モーション演出し、ブラウザでライブプレビュー、
DaVinci Resolve / Premiere へタイムラインごと書き出す。

```text
AI agent ──CLI/HTTP──> vedit daemon(Node/TS)──WS──> Web NLE(ブラウザ)
                       ├ manifest + revision log(source of truth)
                       ├ ingest: proxy / waveform / whisper 文字起こし
                       └ export: OTIO / FCP7 XML / ffmpeg render
```

## 誰のためのアプリか

主ペルソナは、**作品の意味や好みは自分で決めたいが、検出・反復・整合確認は
AIへ委任したい個人クリエイター**。AIを隠すのでも、すべてを質問にするのでもなく、
次の境界で使う。

- 低リスク・可逆で、文字起こしと波形など独立した根拠が一致する処理は、AIが
  1 revisionの初稿として先に進め、根拠・短縮量・Undoを示す
- 意味・好み、証拠不足/衝突、冒頭末尾、断片化リスクは、AI側から前後の文脈と
  選択肢を添えて人間へ聞く
- 保護済み、無効、現在版に効果なし、判断済みの項目は質問へ水増ししない
- ローカルMP4はアプリ内の「MP4をこのMacに書き出す」ボタンで人間が開始する
- YouTube等への外部送信・公開は未実装。将来もローカル書き出しと別の明示操作にする

AIは編集判断を支援する主体だが、作者の意味判断を推測で上書きする主体ではない。

## クイックスタート

```bash
npm install && npm run build && npm link
vedit doctor --download-model ggml-large-v3-turbo   # 初回のみ(~1.6GB)
vedit create ~/edits/myvlog --name myvlog
vedit open        # → 素材がまだ0件でも、まずアプリを表示
vedit ingest ~/Movies/raw.mp4   # 既定: プロキシ+波形+シーン検出、文字起こしはしない
vedit scenes      # まず素材構造を確認

# 発話が主役の素材だけ、裏で文字起こしを開始
vedit transcribe all --language ja
vedit status      # sources[].transcribed=true で完了を確認
vedit transcript  # packed transcript を見てカット判断
```

### AIエージェントから使う

- **Codex**: このリポジトリをワークスペースとして開く。ルートの
  `AGENTS.md` と `.agents/skills/vedit/SKILL.md` が検出され、後者から共有の
  `skill/SKILL.md` を読む。CLIを別ディレクトリから使う場合も、最初にこの
  リポジトリで `npm link` を実行しておく。
- **Claude Code**: 共有Skillを `~/.claude/skills/vedit` にsymlinkする。

```bash
ln -sfn "$(pwd)/skill" ~/.claude/skills/vedit
```

どちらも同じ `skill/SKILL.md` をsource of truthとして使い、プロバイダー固有の
モデル名やツール名を前提にしない。対象プロジェクトで編集を始める依頼では、
エージェントが `vedit open` を実行し、利用可能ならアプリ内ブラウザ/プレビュー
ペインへ自動表示する。素材は後から追加してよく、空プロジェクトでも `create`
直後に表示する。ヘルプ・仕様相談・診断だけの依頼では表示しない。

## 設計

[docs/superpowers/specs/2026-07-16-vedit-design.md](docs/superpowers/specs/2026-07-16-vedit-design.md) 参照。要点:

- **非破壊**: 元素材は不変。編集は manifest(JSON)の書き換えのみ。
  修正のたびのエンコードはゼロ、プレビューはプロキシのマッピング再生
- **revision log / 履歴操作**: UI と会話の編集が同じ履歴に載る。stale base は
  409 拒否。ヘッダーの「戻す / やり直す」は320px幅でも常に到達でき、
  Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z、Ctrl+Yにも対応する
- **scenes-first / transcript-on-demand**: 既定はシーンと波形から構造を把握。
  発話中心の素材は裏ジョブで文字起こしし、単語 id
  (`remove-words w0120..w0134`) でカットを指示。無音候補は波形と
  語間が一致する低リスク範囲だけ自律初稿の対象
- **モーションは再編集可能な spec**: DOM/CSS で即時プレビュー。
  標準4種は最終レンダーに近似焼き込みし、`custom-html` はプレビューのみ
- **interchange**: OTIO(Resolve 18.5+ 無料版ネイティブ)+ FCP7 XML(Premiere)

## 開発

```bash
npm test          # core ユニットテスト(vitest)
npm run build     # tsc
node dist/cli.js serve --project <dir>   # daemon をフォアグラウンドで
```

テストや組み込み環境で vedit のグローバル状態だけを隔離する場合は、
`HOME` を変更せず次の専用環境変数を使う。未指定時の既定パスは従来どおり。

- `VEDIT_REGISTRY_PATH`: プロジェクト一覧 (`~/.cache/vedit/projects.json`)
- `VEDIT_PRESETS_PATH`: 字幕プリセット (`~/.config/vedit/presets.json`)
- `VEDIT_MODEL_DIR`: whisper モデルディレクトリ (`~/.cache/vedit/models`)

## 実素材で確認した範囲

2026-07-18の技術検証では、素材サイト等から取得した**93本、約7.58時間、
約2.50 GiB**の動画を一括取り込みし、93/93本で元ファイルとのSHA-256、
メタデータ、プロジェクト参照の整合を独立確認した。Web UIでは93素材の段階描画、
検索、7.6時間の時間軸、320/390/768px幅を確認し、78分38.6秒の素材では
文字起こしの再読込復帰・中止・再試行を実行した。

3種類の実素材をつないだ編集では、論理尺14.0109秒に対し、最終ファイルは
映像14.040秒・音声14.011秒、48 kHz stereo、-14.38 LUFSだった。4区間の
ソース整合SSIMは0.9789 / 0.9506 / 0.9547 / 0.9313。これはレンダー経路と
境界の技術検証であり、編集の面白さや自然さを人間が評価した結果ではない。

npm配布tarballも隔離先へ実インストールし、同梱Web UIアセットがHTTP 200で
取得できることを確認した。詳細、ASR・シーン検出の数値、機械fixtureとの区別、
未達条件は
[AI-first実験・検証結果](docs/ai-first-validation-2026-07-18.md)を参照。

このfreezeの自動回帰はVitest 1,556/1,556、Playwright 31/31。配布closureは
56 filesのbrowser dependency closureとして検証した（正確なtarball byte数は
検証記録に固定し、README更新による自己参照を避ける）。
これらは機能回帰と配布内容の検証であり、生身の利用者による操作性・編集品質の
評価ではない。

ローカルdaemonはloopback上で、Host / Origin / Sec-Fetch-Siteと表示中projectの
identityを照合する。これはcross-site要求やproject取り違えを抑える防御であり、
ユーザー認証や通信暗号化ではない。信頼できない同一マシン利用者との共有や、
LAN/インターネットへの公開を想定していない。

## 商用リリースまでの既知の未達

- 生身のクリエイターによる操作性評価と、完成編集のブラインド品質比較
- 検証素材を含む素材権利・利用条件・attributionの完全なinventory
- Windows/Linuxでの実動作、配布・更新・互換versioningの検証
- support方針、privacy表記、third-party notices、障害時の復旧手順
- VoiceOver実査、キーボード操作の網羅、ディスク不足・容量逼迫時の実機試験

したがって現状は**商用品質へ向けた技術検証版**であり、一般向け商用releaseの
完了を宣言する段階ではない。

## その他の既知の制限(次フェーズ候補)

- 提案ブランチ(複数編集案の並行比較 UI)は未実装(M5)
- MCP サーバーは同梱していない。Codex / Claude Code はCLIを使い、Web NLEは
  daemonのローカルHTTP/WebSocket APIを使う
- 標準4種のモーション(chapter-card / lower-third / callout / cta)は
  `export render` で最終映像へ焼き込む。ブラウザ表示の近似であり、
  任意HTMLの `custom-html` は焼き込み対象外(書き出し時に警告)
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
- シーン索引: しゃべりのない素材に単語 id 相当のシーン id を付ける
  `vedit scenes detect` / `scenes sheet` / `scenes note`。`--scene <id>` で
  clip-add / remove-range / view に直接渡せる(タイムライン上にも境界マーカー)
