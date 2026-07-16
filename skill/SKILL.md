---
name: vedit
description: 会話型ローカル動画編集(NLE)。vlog・ショート・実況素材のカット編集、無音/フィラー除去、字幕、チャプターカード等のモーション演出、ブラウザでのライブプレビュー、9:16リフレーム、DaVinci Resolve/Premiere へのタイムライン書き出し。トリガー例:「動画を編集して」「いい感じに切って」「無音をカットして」「字幕つけて」「ショートにして」「Resolveに持っていきたい」
---

# vedit — 会話型ローカルNLE

ローカル動画を非破壊で編集する。元素材は絶対に変更しない。source of truth は
プロジェクトの manifest 一つで、全変更が revision 履歴に残り undo できる。
プレビューはブラウザでリアルタイム(編集中のエンコードはゼロ)。

**運用モデル: あなた(メイン会話)は編集ディレクター。** 機械的な作業
(ingest 監視、transcript 精読、一括適用、QA)は Sonnet サブエージェントに
委譲し、あなたは意図の解釈・構成判断・レビューに徹する。
→ 分業表と委譲プロンプト: references/delegation.md

**「いい感じに切って」等の曖昧指示は編集判断の仕事。** 分析→方針宣言→
カットリスト提示→承認→適用の段取りと判断基準:
→ references/editorial-playbook.md

## セットアップ(初回のみ)

```bash
cd /Users/ht/dev/video-edit-skill && npm run build
vedit doctor        # 依存チェック(ffmpeg / whisper / モデル)
# モデルが MISSING なら(実用品質は large-v3-turbo 推奨、~1.6GB):
vedit doctor --download-model ggml-large-v3-turbo
```

`vedit` が PATH に無ければ `node /Users/ht/dev/video-edit-skill/dist/cli.js` を使う。

## 基本フロー

```bash
vedit create <dir> --name <名前>
vedit ingest <files...> --language ja     # 4K素材で約26秒/分。複数本は ingest エージェントに委譲
vedit open                                # プレビューURLを必ずユーザーに伝える
vedit status                              # revision / duration / sources(全コマンドの起点)
vedit transcript                          # packed transcript(編集判断の主材料)
vedit detect                              # 無音(波形+単語ギャップ)・フィラー候補
```

プロジェクト指定は `--project <dir>` または env `VEDIT_PROJECT`。

**セッション再開**(週をまたぐ場合): `vedit projects` で一覧 → `vedit open` →
`vedit status` で現在 revision を取得 → `vedit revisions` の actor 列で
前回以降のユーザー編集([ui])を確認 → `vedit candidates --all` で
承認済み/保留の候補を再確認してから編集を再開する。

Web UI には「素材」タブ(ポスター・使用状況バー・ソースプレビュー・
シーン展開からの区間追加)がある。`--no-add` で取り込んだ素材の選定は
ユーザーにこのタブを案内するとよい。

## 編集の鉄則

1. **タイムコードを手計算しない。** カットは単語 id(`remove-words w0120..w0134`)、
   クリップ操作は clipId で指示する。
2. **mutating コマンドは `--base <直近で読んだ revision>` が必須。**
   409 REJECTED = ユーザーが UI で編集した印。`vedit status` で再読取りし、
   意図を確認してから続ける。`--latest` は「競合チェック不要」と確信できる
   直後の連続操作だけに使う。
3. **ソースが2つ以上ある時は `--source <id>` 必須**(単語 id はソースごとに
   w0000 から振られ衝突する)。packed transcript の各セクション見出しに
   ソース id が出る。
4. **検出候補を全承認しない。** 候補一覧は `vedit candidates`(--all で決定済みも)。
   明白な無音だけ `vedit approve <id...> --base <rev>`。
   `(transcript disagrees — preview before approving)` ラベル付き候補は
   必ずプレビューか view で確認してから判断。迷うものは UI の提案タブに残し
   ユーザーに委ねる。
5. 削りすぎたら `vedit undo`(1つ戻る。undo だけは --base 不要)。
   特定 revision へは `vedit undo --rev N`。履歴は `vedit revisions` —
   **actor 列(`[ui]`=ユーザーの手動編集 / `[claude]`)で誰の編集かが分かる**。
6. 大きく削る前に「何秒→何秒になるか」を言葉で確認する。

## 目で確認する

```bash
vedit view                        # タイムライン全体のフィルムストリップPNG(Read する)
vedit view --from 30 --to 45      # 区間指定
vedit view --domain source --source <id>   # カット前のソースを見る
```

各コマにソースタイムコード焼き込み。カット適用後は必ず view で境界を確認する。

しゃべりのない素材(B-roll・風景)は `vedit scenes detect` → `vedit scenes sheet` で
シーンごとのサムネ格子を作り、それを Read して各シーンに一言注釈
(`vedit scenes note s0003 "..." --by model`)を付けると、単語 id と同じ感覚で
`--scene s0003` を clip-add / remove-range / view に渡せる。

## クリップ構成(取捨選択・並べ替え)

```bash
vedit sources                                  # 素材プール一覧と使用状況
vedit ingest <file> --no-add                   # プールに置くだけ(選定前の素材)
vedit clip-add <sourceId> --in 5 --out 20 --at 2 --base <rev>
vedit clip-remove <clipId> --base <rev>        # タイムラインから外す(素材は残る)
vedit clip-move <clipId> --before <clipId|end> --base <rev>
```

多数クリップの取捨選択は: 全部 `--no-add` で ingest → 分析エージェントに
transcript+view で「使う/使わない」推薦を作らせる → ユーザー承認 → clip-add。

## 縦ショート(9:16)

```bash
vedit reframe 9:16 --focus center --base <rev>   # 出力を縦に、全クリップをクロップ
vedit clip-crop <clipId> --x 0.3 --base <rev>    # 個別に切り出し位置を調整
```

「このvlogからショートを作って」の段取りは editorial-playbook.md 参照
(ハイライト3案→ユーザー選択→新プロジェクトに clip-add → reframe)。

## 字幕とモーション

```bash
vedit captions --style clean --max-chars 24    # 字幕は transcript から自動生成・カット追従
vedit motion-add --type chapter-card --text "..." --subtitle "..." --at 5.5 --duration 3 --base <rev>
vedit motion-update <id> --text "..." --base <rev> / vedit motion-remove <id> --base <rev>
```

- モーション type: chapter-card / lower-third / callout / cta(詳細と custom-html の
  逃げ道: references/motion-catalog.md)
- **文言の出典ルール(捏造禁止)**: カード・テロップの文言はユーザー提供か
  transcript 由来のみ。モデル創作のコピーは提案として見せ、承認後に入れる
- スタイルの再利用: `vedit preset-save <name>` / `vedit preset-apply <name> --base <rev>`

## 仕上げ

レンダー前チェックリスト(editorial-playbook.md)を通してから:

```bash
vedit export otio out.otio        # Resolve 18.5+(無料版OK): File > Import > Timeline
                                  # 字幕は隣に生成される out.srt を Import Subtitle で
vedit export srt out.srt / ass out.ass
vedit export fcp7xml out.xml      # Premiere(uv 必要)
vedit export render final.mp4 --burn-captions   # 唯一の全編エンコード
```

注意: リフレーム(crop)は render には反映されるが OTIO には乗らない
(メタデータ記録のみ)。プレビューと view は品質保証ではない —
公開判断は render の実ファイルで。

## トラブル時

- `vedit doctor`: 依存確認(drawtext/ass 無しの ffmpeg は ffmpeg-full を案内)
- daemon は自動起動(port 7799)。コード更新後や挙動不審時:
  `pkill -f "dist/cli.js serve"` → 次のコマンドで再起動
- 文字起こしが崩れている(タイムスタンプ詰め配置、末尾縮退)場合:
  より大きいモデルで ingest し直すのが最短(`--language ja` 明示も有効)
- 生 ffmpeg が必要な加工は、加工済みの**別ファイルを作って** ingest する。
  元素材の上書きは絶対にしない
