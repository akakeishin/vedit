# vedit — 会話型ローカルNLE スキル設計

日付: 2026-07-16
状態: 承認済み設計(FABLE_DISCUSSION_BRIEF.md の議論より)

## 目的

Claude(Fable / Sonnet)を編集ディレクターとして、ローカル動画素材を非破壊で
カット・字幕・モーション演出し、ブラウザで即時プレビューし、最終的に
DaVinci Resolve / Premiere へ渡せるプロジェクトを残す。

対象: 横型 vlog(YouTube)、縦ショート、実況・解説系。汎用設計。

## 前提の確定事項

- 「Fable」はモデルであり外部サービスではない。モーション部品は
  **Claude が宣言的 spec(JSON/HTML)を書き、ローカルレンダラーが描画**する。
  外部送信なし・vendor lock-in なし(ブリーフ原則7・8を自動的に満たす)。
- 実行環境は **Claude Code 先行**。コアはローカル daemon + HTTP API とし、
  v1 は CLI(Bash)接続、v2 で同 API を包む薄い MCP(Cowork 対応)。
- interchange は **OTIO 本命**(Resolve 18.5+ が無料版含めネイティブ import)
  + **FCP7 XML 併用**(Premiere)。OTIO は実体が JSON なので TS から直接書く。
- ブラウザプレビュー v1 は単一 `<video>` +シークのマッピング再生。
  カクつきが許容外になったら WebCodecs + canvas 合成へ段階移行。
- Remotion は商用ライセンス制約により不採用。必要なら Revideo(MIT)を
  モーション描画エンジンとして限定採用できる余地を残す。

## アーキテクチャ(3プロセス)

```text
Claude (Fable/Sonnet)
├─ Skill: 手順書 + 判断基準(progressive disclosure)
└─ 接続: v1 CLI → v2 MCP(同一HTTP APIの薄いラッパー)
        ↕ HTTP (localhost)
vedit daemon (Node/TypeScript)
├─ project store: manifest + revision log + asset index
├─ ingest: ffprobe → プロキシ(1回) → 波形 → whisper.cpp 文字起こし
├─ semantic API: remove-words / remove-silence / trim / motion / propose ...
├─ export: OTIO JSON / FCP7 XML(Python otio subprocess) / 最終レンダー(ffmpeg)
└─ Web NLE 配信
        ↕ WebSocket (manifest 変更 push)
Web NLE (ブラウザ)
├─ プロキシのマッピング再生(タイムライン時間→ソース区間)
├─ 字幕・モーションの DOM/CSS リアルタイムオーバーレイ(エンコードなし)
├─ トランスクリプト・波形・タイムラインストリップ
└─ 軽操作: 再生/スクラブ、承認/却下キュー、±フレーム微調整、提案比較
```

## 固定原則(ブリーフ第4節を継承)

1. source of truth は manifest 一つ。UI 操作と会話操作は同じ revision log に書く。
2. 元素材は不変。重い素材のみ取り込み時に一度だけプロキシ生成。
3. 通常の修正ではエンコードしない。最終確定時のみ全編書き出し。
4. 全書き込み API は baseRevision 必須。古ければ 409 拒否。
5. モーションは spec のまま保持し常に再編集可能。最終動画だけでなく
   プロジェクト(OTIO + spec サイドカー)を残す。
6. 外部送信されるデータはゼロ(全処理ローカル)。

## プロジェクト構造

```text
<project>/
├─ project.json      # canonical timeline
├─ revisions.jsonl   # append-only 操作ログ
├─ transcript.json   # 単語レベル(word id, t0, t1, confidence)
├─ motion/           # MotionSpec JSON(部品ごと)
└─ cache/            # プロキシ・波形・サムネ(再生成可能)
```

manifest 骨子:

- `sources[]`: 元素材(path, probe結果, proxy参照)
- `tracks`: `video[]`(clip = sourceId + 範囲)、`captions[]`(word id リンク、
  カットに自動追従)、`motion[]`(MotionSpec 参照 + 配置)、`audio[]`
- `revision`: 現在のリビジョン番号

## Sonnet でも高性能に動く設計

賢さをモデルからシステムへ移す:

- **semantic API**: モデルはタイムコード計算をしない(`remove-words --ids w120..w134`)。
- **検出は決定論**: 無音・フィラー・言い直し候補は daemon が検出し、
  モデルは取捨選択だけ行う。
- **packed transcript**: アノテート済み圧縮テキスト(~12KB 目安)を返し、
  長尺でもコンテキストを食わない(video-use 方式)。
- **`vedit view`**: 任意区間のフィルムストリップ+波形+カットマーカーを
  1枚 PNG で返す。Claude の視覚確認はこれが基本。
- **プリフライト**: 全書き込みで実行前に影響サマリを返し、core が検証。
- **ツール数は 15〜20 に絞る** + 生 ffmpeg への脱出口 1 つ。
- 各コマンド出力に「状態サマリ + 次にやれること」を含める。

## 提案機能

- revision log 上に **ブランチ(draft)** を持つ。「60秒テンポ重視」「90秒丁寧」
  等の編集案を並行生成し、Web NLE でワンクリック切り替え比較 → merge。
- ミクロ提案: daemon 検出候補 → Claude 選別 → UI の承認/却下キュー。

## モーション部品

- MotionSpec = 宣言的 JSON。プリセット(chapter-card / lower-third /
  callout / CTA)のパラメータ埋めを基本、自由 HTML 生成は逃げ道。
- プレビュー: ブラウザが DOM/CSS で直接描画(レンダリングゼロ)。
- 最終レンダー時のみ headless Chromium キャプチャ → 透明 WebM/ProRes 4444。
  単純字幕は ASS 焼き込みに出し分け。
- NLE export 時は「焼いた透明動画 + spec サイドカー」でオーバーレイトラックへ。

## マイルストーン

1. **M1**: ingest(プロキシ+文字起こし)+ Web NLE でプロキシ再生・
   トランスクリプト表示
2. **M2**: 会話カット編集 + revision log + 承認/却下 UI ← PoC 合格ライン
3. **M3**: 字幕トラック + MotionSpec オーバーレイ(chapter-card から)
4. **M4**: OTIO export → Resolve 実 import 検証、FCP7 XML、最終レンダー
5. **M5**: 提案ブランチ UI、MCP サーバー化(Cowork)

最大リスクは M1 のマッピング再生の滑らかさ。v1 はシーク再生で妥協し、
不足なら WebCodecs へ。

## テスト方針

- manifest 操作は純関数化してユニットテスト(カット→字幕追従、revision 拒否)。
- export はスナップショットテスト + Resolve/Premiere 実 import を M4 受け入れ条件に。
- プレビュー忠実度は最終レンダーとの代表フレーム比較で確認。

## 環境(確認済み)

ffmpeg 8.1.2 / node v25.9 / whisper-cli(whisper.cpp, モデルは要DL)/
python 3.14(otio 未導入、uv で導入)/ macOS。

## 参考にした既存実装

- browser-use/video-use: transcript-first + packed text + on-demand
  timeline view PNG + 自己評価ループ
- kinocut(mcp-video): プリフライト検証・来歴レシート
- 6missedcalls/video-editing-skill: onboard(doctor)パターン、単機能スクリプト合成
- MastroMimmo/ffmpeg-skill: 少ツール + 脱出口の段階的開示
- OTIO を中間表現にした skill/MCP は空白地帯(差別化点)
