---
name: vedit
description: 会話型ローカル動画編集(NLE)。vlog・ショート・実況素材のカット編集、無音/フィラー除去、字幕、チャプターカード等のモーション演出、ブラウザでのライブプレビュー、DaVinci Resolve/Premiere へのタイムライン書き出し。トリガー例:「動画を編集して」「無音をカットして」「字幕つけて」「Resolveに持っていきたい」「この動画の言い直し削って」
---

# vedit — 会話型ローカルNLE

ローカル動画を非破壊で編集する。元素材は絶対に変更されない。編集状態は
プロジェクトディレクトリの manifest が唯一の真実で、すべての変更は
revision 履歴に残り undo できる。プレビューはブラウザでリアルタイム
(修正のたびのエンコードは発生しない)。

## セットアップ(初回のみ)

```bash
cd /Users/ht/dev/video-edit-skill && npm run build   # ビルド
node dist/cli.js doctor                               # 依存チェック
# whisper model が MISSING なら:
node dist/cli.js doctor --download-model ggml-large-v3-turbo  # 高精度 ~1.6GB
```

`vedit` が PATH にあればそれを使う。なければ `node /Users/ht/dev/video-edit-skill/dist/cli.js` を `vedit` として読み替える。

## 基本ワークフロー

```bash
vedit create <dir> --name <名前>          # 1. プロジェクト作成
vedit ingest <video.mp4> --language ja    # 2. 取り込み(プロキシ+文字起こし。数分かかる)
vedit open                                # 3. プレビューURLをユーザーに案内(必ず伝える)
vedit transcript                          # 4. packed transcript を読む(これが編集の主戦場)
vedit detect                              # 5. 無音・フィラー候補を検出
vedit status                              # 現在の revision / duration / 状態
```

すべてのコマンドは `--project <dir>`(または env `VEDIT_PROJECT`)でプロジェクトを指定する。

## 編集の鉄則

1. **タイムコードを自分で計算しない。** カットは単語 id で指示する:
   `vedit remove-words w0120..w0134 --base <rev>`
2. **mutating コマンドには必ず `--base <直近で読んだ revision>` を付ける。**
   409 REJECTED が返ったらユーザーが UI で編集した印。`vedit status` で
   再読取りしてから続ける。勝手に上書きしない。
3. **検出候補は自分で全承認しない。** 明白なもの(長い無音)は
   `vedit approve <id...>`、判断が割れるものは UI の提案タブに残して
   ユーザーに委ねる。まとめて承認は `vedit approve all`(1 revision に
   まとまるので undo も一発)。
4. 削りすぎたら `vedit undo`。履歴は `vedit revisions`。
5. 破壊的な依頼(大量カット)の前に、何秒消えるかを言葉で確認する。

## 目で確認する

動画は直接見られないので、**`vedit view` の PNG を Read する**のが基本:

```bash
vedit view                          # タイムライン全体のフィルムストリップ
vedit view --from 30 --to 45        # 区間指定(タイムライン時間)
vedit view --domain source          # カット前のソースを見る
```

各コマの左下にソースタイムコードが焼き込まれる。ブラウザペインの
スクリーンショットは UI 確認用の補助。

## 字幕とモーション

字幕はトランスクリプトから自動生成され、カットに自動追従する:

```bash
vedit captions --style clean --max-chars 24   # スタイル調整
vedit captions --enabled false                 # オフ
```

モーション部品(プレビューに即時反映、いつでも再編集可能):

```bash
vedit motion-add --type chapter-card --text "素材の取り込み" --subtitle "STEP 1" --at 5.5 --duration 3 --base <rev>
vedit motion-update <id> --text "新しい文言" --base <rev>
vedit motion-remove <id> --base <rev>
```

type: `chapter-card` `lower-third` `callout` `cta`。プリセットで足りない
表現だけ `--type custom-html --html '<div>...</div>'`(スタイルはインラインで)。
詳細は references/motion-catalog.md。

## 提案の出し方

「テンポ重視」「丁寧め」のような複数案を出すときは:

1. `vedit transcript` を読み、案ごとに「削る単語範囲のリスト+意図+削減秒数」を会話で提示
2. ユーザーが選んだ案だけを適用(候補キュー経由 or remove-words)
3. 迷いどころは `vedit detect` の候補として UI に積み、ユーザーに委ねる

## 仕上げ

```bash
vedit export otio out.otio            # DaVinci Resolve: File > Import > Timeline(無料版OK)
vedit export fcp7xml out.xml          # Premiere Pro: File > Import
vedit export render final.mp4 --burn-captions   # 完成動画(ここで初めて全編エンコード)
```

Resolve/Premiere に渡す場合、モーションはマーカー+spec サイドカー
(project/motion/*.json)として伝わる。詳細は references/export-guide.md。

## トラブル時

- `vedit doctor` で依存を確認(ffmpeg のビルドによっては drawtext/ass 欠如
  → `brew install ffmpeg-full` を案内)
- daemon は初回コマンドで自動起動(port 7799)。挙動不審なら
  `pkill -f "dist/cli.js serve"` 後に再実行
- どうしても生 ffmpeg が必要な加工(回転、ノイズ除去等)は、**元素材を
  加工した別ファイルを作って ingest し直す**。元素材の上書きは絶対にしない
