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

ingest 自体(プロキシ+波形+シーン検出)は whisper モデル不要。モデルが
要るのは `vedit transcribe`(または `vedit ingest --transcribe`)を
実際に使うときだけ。

`vedit` が PATH に無ければ `node /Users/ht/dev/video-edit-skill/dist/cli.js` を使う。

## 基本フロー(scenes-first)

```bash
vedit create <dir> --name <名前>
vedit ingest <file>                       # 既定: プロキシ+波形+シーン検出まで(文字起こしはしない)
vedit ingest-batch <dir> --plan           # 複数本(撮影カード等)は事前確認してから ingest エージェントに委譲
vedit open                                # プレビューURLを必ずユーザーに伝える
vedit status                              # revision / duration / sources(全コマンドの起点)
vedit scenes                              # packed scene list — まずここで構造を把握する(hasSpeech/energy)
vedit scenes sheet                        # シーンごとのサムネ格子(視覚で把握)
```

**主用途は「映像が主役」の素材**(歩き vlog 等)。whisper の文字起こしは
ingest 時間の大半を占めがちな割に、映像が主役の素材では必須ではない —
ingest の既定は**シーン検出まで**で止まり、文字起こしはしない。

- 発話が内容の中心と分かったら(トーク系vlog・インタビュー等)、
  `vedit transcribe <sourceId|all> --language ja` を実行して初めて
  文字起こしが走る(非同期の裏ジョブ。次章)
- 「字幕つけて」「この発言をカットして」等トーク系の指示を受けたら、
  ディレクターは**まず `vedit transcribe` を裏で起動してから**分析や
  他の作業を続ける(完了を待たずに指示を受け付けてよい)
- ingest 時点で発話中心と分かっている場合は `vedit ingest --transcribe`
  で旧来どおり即時に文字起こしまで済ませてよい

`ingest-batch` は撮影カード/フォルダの一括取り込み用: SHA-256 で重複を検出して
スキップ、`--copy <destDir>` でプロジェクト外の素材保管先へコピー後に検証
(既定は `--link` = 元パス参照)、処理は `<project>/ingest-journal.json` に
記録され中断後の再実行で完了済みをスキップして再開する。`--plan` は
読み取り専用の下見(ファイル数・合計尺・コーデック/VFR/音声/色警告)。

プロジェクト指定は `--project <dir>` または env `VEDIT_PROJECT`。

**セッション再開**(週をまたぐ場合): `vedit resume --project <dir>` 1コマンドで
revision・直近セッションの履歴・ユーザー([ui])による編集有無・保留候補の
件数内訳・色警告・機械的に導ける次の一手までまとめて返る(読み取り専用、
--base 不要)。resume が使えないとき: `vedit projects` → `vedit open` →
`vedit status` → `vedit revisions` の actor 列を確認 → `vedit candidates --all`。

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
7. **特定の箇所について話すときは、必ず直前に `vedit show` で画面をその場所へ動かす。**
   ユーザーは隣の Web UI 画面を見ながら会話している——「相棒」の演出チャンネル。
   `vedit show range <t0> <t1>` / `show words <w1..w9> [--source id]` /
   `show candidate <id>` / `show compare <rA> <rB>` / `show source <id> [--at s]`。
   revision は作らず `--base` も不要(いつでも呼んでよい)。

## 目で確認する

```bash
vedit view                        # タイムライン全体のフィルムストリップPNG(Read する)
vedit view --from 30 --to 45      # 区間指定
vedit view --domain source --source <id>   # カット前のソースを見る
```

各コマにソースタイムコード焼き込み。カット適用後は必ず view で境界を確認する。

シーンは ingest 時点で自動検出済み(`--no-scenes` で無効化可。再検出したい
ときだけ `vedit scenes detect --sensitivity ..`)。しゃべりのない素材
(B-roll・風景)は `vedit scenes sheet` でシーンごとのサムネ格子を作り、
それを Read して各シーンに一言注釈(`vedit scenes note s0003 "..." --by model`)
を付けると、単語 id と同じ感覚で `--scene s0003` を clip-add / remove-range /
view に渡せる。

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

しゃべりのない素材の大量選別は3状態カリング(未確認/keep/reject)を使う
(シーンは ingest 時点で検出済み): 分析エージェントが `scenes sheet` を見て
keep/reject を推薦 → ユーザー確認 → `vedit review <sceneId...> keep|reject --base <rev>`
→ `vedit selects --confirm --base <rev>` で keep シーンだけの仮タイムラインに置換
(`--confirm` 無しはプレビューのみ。既存タイムラインは丸ごと置き換わるので
undo で戻せることを伝える)。進捗確認は `vedit review-status`。

## B-roll(V2)

```bash
vedit broll-add <brollSourceId> --scene s0003 --at-word w0042 --base <rev>
vedit broll-add <brollSourceId> --in 4 --out 9 --at-src <aRollSrc> 12.5 --audio mix --gain -18 --base <rev>
vedit broll-update <id> --at-tl 30.2 --base <rev>   # 再アンカー
vedit broll-remove <id> --base <rev>
```

アンカーは発話に張り付く(sourceId+srcTime を保存し、位置は毎回そこから
再計算する)ので、A-roll をカット・並べ替えしても B-roll は自動追従する。
アンカーの瞬間そのものがカットで消えたら orphan になり(`vedit status` /
`vedit resume` / web の V2 行に警告)、render・preview・OTIO から自動的に
除外される — orphan 警告が出たら `broll-update --at-word/--at-src/--at-tl`
で再アンカーする。V2 は重複不可の一層のみ(オーバーラップする追加・更新は
400)。audioMode は既定 mute(B-roll音声は使わない); mix/replace で
B-roll側の音を使う場合は `--gain`(既定 -18dB)を調整する。

## キット(プロジェクト横断の制作設定)

シリーズ/チャンネルごとの「設定フォルダ」(プロジェクトの外にある参照。
コピーしない — 更新は全リンク先プロジェクトに効く)。字幕/タイトルの
スタイル・立ち絵素材・プロファイル(トーン・尺目標・構成の型)をまとめる。

```bash
vedit kit-init <dir> --name <シリーズ名>   # 雛形生成(kit.json + GUIDE.md + fonts/ + assets/{characters,backgrounds,props})
# assets/ 配下に PNG(立ち絵・背景・小物)を置いたら:
vedit kit-scan <dir>                       # アルファ境界・足元アンカーを自動計算して kit.json に書き戻す(手作業ゼロ)
vedit kit-link <dir> --base <rev>          # プロジェクトにリンク(kit.json 検証 + defaults.captions_style を初期適用)
vedit kit                                  # 内容表示(profile 要点・styles・素材数・defaults)
vedit kit-unlink --base <rev>              # 解除
```

- `vedit captions --style <kitStyleId> --base <rev>`: キットのスタイルを既存
  プリセットと同列に指定できる。ASS書き出し・レンダー時の字幕焼き込みにも
  palette/フォント/サイズが反映される(web プレビューは近似)
- `vedit kit-assets [--tag quiet] [--emotion happy]`: 素材をタグ・感情で検索
  (「この場面に合う立ち絵」を選ぶ材料。read-only)
- `vedit kit` と `vedit resume` に profile の要点(tone_tags・尺目標・
  pacing・spine)が出る。GUIDE.md は自由記述 — Read して口調やNG事項を把握する
- `vedit export render` の `--preset`、`vedit reframe` の `--focus` は
  省略時にキットの `defaults.export_preset` / `defaults.reframe_focus`
  があればそれを使う(明示フラグは常に優先)

### スプライト(立ち絵オーバーレイ)

```bash
vedit sprite-add <assetId> --scene s0003 --at-word w0042 [--pos 0.85,0.9] [--scale 0.25] --base <rev>
vedit sprite-add <assetId> --at-src <aRollSrc> 12.5 [--opacity 0.9] [--flip] --base <rev>
vedit sprite-update <id> --at-tl 30.2 --base <rev>   # 再アンカー
vedit sprite-remove <id> --base <rev>
```

B-roll と同じアンカー規則(発話に張り付き、自動追従。アンカーが消えたら
orphan — `vedit status`/`resume`/web に警告、`sprite-update` で再アンカー)
だが、V2 と違い**重複可**(複数キャラを同時表示できる)。`--pos` は
`ground_anchor_normalized`(素材の足元)を置く出力キャンバス上の位置
(0..1)、`--scale` は素材の可視領域の高さが出力高さに占める割合。

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

### 字幕の見た目・テキスト修正(W-CAP)

字幕の見た目(フォント・色・サイズ・縁・背景・縦位置)や個々のテロップの
誤字修正は、**Web UI から直接いじれる**——プレビュー上の字幕をクリックで
スタイルのポップオーバー(フォント/文字色/縁色/背景色/サイズ/縁の太さ/
背景の透過)、ドラッグで縦位置、ダブルクリックでテキストのインライン修正
(Enterで確定、Escでキャンセル)。修正済みの箇所には小さな「✎修正済み」
マークが付く(ホバーで元テキストを確認できる)。同じ操作は CLI からも可能:

```bash
vedit captions --font "Noto Sans JP" --text-color "#ffffff" --outline-color "#000000" \
  --box-color "#000000" --size-scale 1.2 --outline-width 3 --bg-opacity 0.6 --position-v 0.9 --base <rev>
vedit caption-text <sourceId:wordId> "正しいテキスト" --base <rev>   # 誤字修正(元の書き起こしは変えない)
vedit caption-text <sourceId:wordId> --clear --base <rev>           # 修正を解除
vedit fonts   # キット内 + システムのフォント一覧(read-only)
```

- **文字起こしの誤り(聞き取りミスの字幕テロップ)を直すのは `caption-text`
  であって、transcript の再文字起こしではない** — transcript.words は
  カット判断の材料としてそのまま残し、字幕表示だけをピンポイントで直す。
  空文字を渡すとそのカットの字幕を非表示にできる
- スタイルの微調整(色・サイズ等)は `--style <preset|kitStyleId>` の上に
  重ねがけされる差分(overrides)——キットや既存プリセットの見た目自体は
  変えない。ASS書き出し・レンダー時の字幕焼き込みにも同じ overrides が反映される

## BGM と音声仕上げ

```bash
vedit music-add <file> --at 0 --gain -12 --base <rev>   # 尺省略時は音源/タイムラインの短い方まで
vedit music-update <id> --gain -8 --base <rev> / vedit music-remove <id> --base <rev>
vedit audio-mix --target-lufs -14 --duck-amount -10 --crossfade-ms 12 --base <rev>
```

- `--no-duck` で自動ダッキング(発話中に自動で下げる)を無効化。既定は有効
- レンダー時のみ音声を仕上げる(発話音声のクリック防止フェード・ダッキング・
  2-passラウドネス正規化)。プレビューは `<audio>` + 簡易フェードの近似
- **BGM ファイルの権利はユーザー責任**(出典ルールと同様、勝手に生成・DLしない)

```bash
vedit audio-repair --preset outdoor --base <rev>    # 屋外ノイズ想定(highpass+ノイズ抑制+コンプレッサ)
vedit audio-repair --preset indoor --deess --base <rev>
vedit audio-repair --preset off --base <rev>        # 補正なし(既定)
vedit export render final.mp4 --no-repair           # 乾音A/B比較(この書き出しだけ補正を無効化)
vedit export render final.mp4 --fast-loudnorm       # 2-passラウドネス正規化を1-passに落とす(高速だが精度は劣る)
```

会話音声リペアは録音環境が悪い(屋外風切り音・部屋鳴り・ワイヤレスマイクの
こもり)ときだけ使う。効果は必ず `--no-repair` の乾音と聴き比べてから確定する。

## 仕上げ

レンダー前チェックリスト(editorial-playbook.md)を通してから、レンダー前後で
`vedit qc` を標準手順にする(チェックリストと重複する項目もあるが、qc は
機械的な検出、チェックリストは編集判断——両方通す):

```bash
vedit qc                                        # レンダー前: 静的チェック(未処理候補・orphan・字幕重複・素材欠落・kit尺乖離)
vedit export otio out.otio        # Resolve 18.5+(無料版OK): File > Import > Timeline
                                  # 字幕は隣に生成される out.srt を Import Subtitle で
vedit export srt out.srt / ass out.ass
vedit export fcp7xml out.xml      # Premiere(uv 必要)
vedit export render final.mp4 --burn-captions   # 唯一の全編エンコード
vedit export render final.mp4 --preset youtube  # crf18/aac256k/loudnorm-14, 解像度そのまま
vedit export render short.mp4 --preset shorts   # 1080x1920固定, 縦でなければエラー(reframe案内)
vedit export render clip.mp4 --preset x         # 長辺1280に縮小, 尺140s超は警告のみ
vedit qc --render final.mp4 --report qc.html    # レンダー後: 実ファイルの暗転・無音・ラウドネス/クリッピングも実測。HTMLレポートをRead可
```

注意: リフレーム(crop)は render には反映されるが OTIO には乗らない
(メタデータ記録のみ)。プレビューと view は品質保証ではない —
公開判断は render の実ファイルで(`vedit qc --render` はその実測を補うが、
判断そのものは代替しない)。

## 振り返り(公開後)

YouTube Studio から「視聴者維持率」を CSV エクスポートし、`vedit retro` で
現在のタイムライン/transcript/シーン/チャプターに突き合わせる(事実のみ・
仮説は出さない設計 — src/core/analytics.ts 参照):

```bash
vedit retro retention.csv                        # --render-duration 省略時は現在のタイムライン尺を使う
vedit retro retention.csv --render-duration 312   # 公開時の尺が今と違う場合は明示
```

出力は落ち込み/伸びの位置・タイムライン時刻・近傍の引用・チャプターだけの
構造化データ + 人間向けサマリテキスト。**「なぜ落ちたか」の断定はしない**
——ディレクター(あなた)がユーザーと対話しながら次回への学びを整理する。

```bash
vedit publish-pack outdir --thumbs 6   # chapters.txt + thumbnails/ + materials.json(読み取り専用)
```

公開素材一式を生成(タイトル・説明文は起草しない — 起草手順は
editorial-playbook.md の「公開パックの起草手順」参照)。

## 色管理(Log/HLG素材)

ingest 時に「要色変換」警告(`vedit status`/`vedit sources` の
`colorWarning`、web パネルの赤バッジ)が出たら、そのソースは
Log/HLG/PQ 素材でプレビュー・レンダーの色が浅く見える。対処:

```bash
vedit color --source <id> --type hlg --base <rev>          # HLG(transfer=arib-std-b67)
vedit color --source <id> --type pq  --base <rev>          # PQ(transfer=smpte2084)
vedit color --source <id> --type lut --lut <DJIの公式LUT>.cube --base <rev>   # D-Log 等
```

`vedit color` はプロキシを自動で再生成する(プレビューが正しい見た目に
なるまで少し時間がかかる)。D-Log のような Log プロファイルはコンテナの
transfer メタデータに出ないことが多く自動判定できない —
警告が出たら撮影者/ディレクターにカメラ機種と Log プロファイルを確認し、
メーカー公式 LUT の所在を聞いてから `--type lut --lut <path>` で指定する。

複数ショット間で肌色や明るさがズレる場合は、まず提案(read-only)を見てから:

```bash
vedit color-match <基準sourceId> <対象sourceId...>          # signalstats差分から exposure/wb/sat を提案
vedit color-adjust --source <id> --exposure 0.3 --wb -10 --sat 1.1 --base <rev>   # 承認した値を適用
```

`color-match` は何も書き込まない。提案を確認してから `color-adjust`
で反映すること — 自動適用はしない。

## トラブル時

- `vedit doctor`: 依存確認(drawtext/ass 無しの ffmpeg は ffmpeg-full を案内)
- daemon は自動起動(port 7799)。コード更新後や挙動不審時:
  `pkill -f "dist/cli.js serve"` → 次のコマンドで再起動
- 文字起こしが崩れている(タイムスタンプ詰め配置、末尾縮退)場合:
  より大きいモデルで ingest し直すのが最短(`--language ja` 明示も有効)
- 生 ffmpeg が必要な加工は、加工済みの**別ファイルを作って** ingest する。
  元素材の上書きは絶対にしない
