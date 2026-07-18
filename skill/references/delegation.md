# 委譲テンプレート — ディレクターと手足の分業

vedit はメイン会話(ディレクター)が判断を握り、機械的な作業を実行環境で
利用できるワーカー/サブエージェントへ委譲して使う。特定のモデル名や
プロバイダー固有ツールは必須ではない。
ディレクターのコンテキストは「ユーザーの意図」「構成判断」「レビュー」に温存する。

## 役割分担

| 作業 | 担当 | 理由 |
|---|---|---|
| ユーザーとの対話・意図の解釈 | ディレクター | 会話の文脈を持つ |
| 編集方針の宣言・構成の最終判断 | ディレクター | 編集品質の中核 |
| ingest 実行・監視(複数クリップ) | ワーカー | 長時間の babysitting |
| transcript 精読 → 構造化分析 | ワーカー | 長文読解はトークンが重い |
| 根拠ゲート済み自律初稿の一括適用+検証 | ワーカー | 機械的(楽観ロック・一括検証)。1件ずつ承認待ちにしない |
| 意味・好みで割れる箇所の構造化質問 | ディレクター | 会話文脈と作品責任が必要 |
| view PNG での品質チェック | ワーカー | 画像確認の作業量が多い |
| export前QA・設定確認 | ワーカー | 定型。通常のローカルMP4開始はアプリボタン |
| モーションの文言・デザイン | ディレクター | クリエイティブ+出典管理 |
| サブエージェント成果のレビュー | ディレクター | 手綱 |

原則: 1〜2コマンドで済む操作はインラインでよい。3コマンド超、長時間、
または transcript 全文読みが必要な作業は委譲する。ワーカーを使えない環境では
インラインにフォールバックする(その場合も packed transcript を使い、--full の
全文読みは避ける)。

自律度は担当モデルの格ではなく、変更の性質で決める。低リスク・可逆・
根拠ありならユーザーの編集依頼の範囲で先に実行し、意味・好みで答えが変わる
場合だけ質問する。ローカルMP4はWebアプリの明示ボタン、外部送信・公開は
将来もアプリ内の別ボタンに宛先・アカウント・内容を示す明示確認が境界であり、
サブエージェントへ委譲しない。

## テンプレート1: ingest エージェント

```
vedit プロジェクト <dir> に以下を取り込んでください。
対象: <撮影カード/フォルダのパス、または個別ファイルのリスト>

手順:
1. まず `vedit ingest-batch <対象> --project <dir> --plan` で下見(ファイル数・
   合計サイズ・合計尺・コーデック/VFR/音声/色警告)を確認し、要約を報告してから
   本実行の許可を待つ(コーデック/色警告が出た素材があれば特に明記)
2. 承認後: `vedit ingest-batch <対象> --project <dir>` で本実行(SHA-256
   重複検出→スキップ、プロキシ生成+シーン検出は2本まで並行、進捗は stderr
   に出る)。**文字起こしはしない**(既定; トーク主体と分かっている場合のみ
   `--transcribe --language ja` を付ける)。プロジェクト外に元素材を集約
   したい場合のみ `--copy <destDir>` を付ける(既定は `--link` = 元パス参照のまま)
3. 一部失敗しても処理は続く(ingest-journal.json に記録される)。全件完了後
   コマンドの出力(ingested/failed/skippedDuplicates 件数)をそのまま報告
4. failed が残っていれば、原因を doctor で確認したうえで同じコマンドを
   再実行(ジャーナルにより ingested 済みはスキップされ、failed のみ再試行)
5. 最後に `vedit status` と各ソースの `vedit scenes` (packed scene list)
   冒頭を報告。`--transcribe` を付けていた場合は packed transcript 冒頭20行も

単発ファイル1本だけなら `vedit ingest <file> --project <dir>` で
このテンプレートを使わずインラインでよい(トーク主体なら `--transcribe --language ja` を追加)。
コードの編集・git 操作は禁止。
```

## テンプレート2: transcript 分析エージェント(編集判断の材料作り)

```
vedit プロジェクト <dir> の素材を分析し、編集判断の材料を作ってください。
編集の目的: <ユーザーの意図をそのまま>(例: 3分のテンポいい vlog に)

手順:
1. `vedit status --project <dir>` で全ソース確認
2. `vedit scenes --project <dir>` で packed scene list を読み、
   `vedit scenes sheet` のサムネ格子を Read して素材全体の構造(視覚的な
   山・単調な区間)を把握する(シーンは ingest 時点で検出済み)。
   **「映像が主役」の素材はこの2手順だけで報告に十分なことが多い**
3. 発話が内容の中心と分かった場合のみ: 対象ソースが未転写なら
   `vedit transcribe <sourceId|all> --project <dir> --language ja` を実行して
   完了を待ち(`vedit status` の sources[].transcribed で確認)、
   `vedit transcript --project <dir>` で packed transcript を読む(全ソース)。
   末尾の語などに ⟨id⟩ が無いときは `vedit transcript --full --source <id>`
4. 文字起こし済みソースがあれば `vedit detect --project <dir>` を実行する。
   意味のある間(見せ場直後/反応/オチの前/冒頭末尾)を pauses と risks へ特定し、
   ディレクターが先に intent zone を記録できる材料を返す。detectは候補ファイルを
   更新するがtimelineは変えない。自律適用はテンプレート3側で行う
5. **言い直しが多い素材は `vedit takes [--source id] --project <dir>` を確認し、
   テイク選択(★推薦テイクとその理由、残りは削除候補)を推薦に含める**
   (言い直し全体の判断であって、個々の無音/フィラー候補とは別枠)
6. 判断に迷う箇所は `vedit view --domain source --source <id> --from X --to Y` の
   PNG を Read(**transcript の時刻はソース時刻**。timeline ドメインに渡さない)
7. transcript が全体的に崩れているソース(誤認識だらけ、"?" 多発)は、
   その旨を risks に書き、`vedit scenes sheet` で視覚ベースの分析に切り替える
8. しゃべりのない素材(B-roll等)の keep/reject は `vedit scenes sheet` の
   サムネ格子を Read して各シーンに推薦する
9. キットがあれば `vedit kit` を読み、profile の spine/pacing を分析の評価軸に使う。
   GUIDE.md があれば Read する

次の構造で報告(これ以外の長文は書かない):
- durations: [{sourceId, 収録秒数}] と削減見込み合計(方針宣言の「何秒→何秒」用)
- chapters: [{title, sourceId, おおよその範囲(語id), 一言要約}]
- highlights: [{sourceId, 語id範囲, 引用, 残すべき理由(フック/感情の山/見せ場)}]
- autoEligible: [{candidateId, sourceId, 秒数, 根拠コード}]
  - 自律対象は **文字起こし語間+波形一致、conflictなし、intent外、内側、
    断片吸収なし** の無音だけ。legacy/片証拠は安全側で質問へ倒す
- needsDecision: [{candidateId/ids, sourceId, 引用, 秒数, reasonCode,
  質問文, options:[残す,カット]}]
  - フィラーは検出confidenceが高くても削除すると話者の印象が変わるので、
    明示済みシリーズ方針がなければ preference-required。証拠不足/衝突、
    冒頭末尾、短い断片の巻き込み、低信頼区間もここへ入れる
- excludedDiagnostics: [{candidateId, reasonCode, 理由}]
  - protected-intent / invalid-range / no-timeline-effect / already-decided。
    これらは人間が決める対象ではないので質問文やoptionsを作らず、監査情報として
    だけ返す。保護した意味のある間を再質問しない
- pauses: [{sourceId, t0, t1, 秒数, 判定: 意味のある間(残す)|だれ場(切る)|判断保留}]
- takes: [{sourceId, groupId, 推薦テイク(引用+語id範囲)、他テイクの扱い(削除候補として wordIds)、理由}]
  (`vedit takes` で言い直しグループが検出された素材のみ。適用はディレクター側でユーザー承認後)
- sceneReview: [{sourceId, sceneId, 推薦: keep|reject, 理由}]
  (シーン検出済みソースのみ。`vedit review` の適用はディレクター側でユーザー承認後)
- risks: [切ると文脈が壊れる箇所、音声が不明瞭で transcript が信用できない箇所]

引用は packed transcript から逐語(20字以内、"?" マークも保持)。
誤認識疑いの引用には(誤認識?)を付す。
コードの編集・カットの適用は禁止。分析のみ。
単一ソース・短尺(〜2分)なら
このテンプレートを使わずディレクターがインラインで分析してよい。
```

## テンプレート3: 実行エージェント(自律初稿+回答済み例外の適用)

```
vedit プロジェクト <dir> に根拠ゲート済みの自律初稿を適用してください。
分析済みの意味のある間: <intent zoneとして保護済みの一覧、または「なし(分析済み)」>
回答済み例外(任意): [{candidateId, decision: approve|reject, 理由}, ...]

手順:
1. `vedit status --project <dir>` で現在 revision を取得。意味のある間が
   分析済みか不明なら適用せず、intent zoneの確認をディレクターへ返す
2. `vedit first-draft --project <dir>` を1回実行する。これは再検出したうえで、
   transcript語間+波形一致、conflictなし、intent外、内側、断片吸収なしの
   無音だけを1 revisionへまとめる。残った質問候補には手を付けない。
   protected/invalid/no-effect/already-decidedは診断除外であり質問に戻さない
3. 回答済み例外があれば、そのIDだけを `vedit approve` / `vedit reject` で
   順に適用する。各コマンドに `--base <直前に確認した revision>` を付け、
   リスト外の候補や自然文の好みから推測した候補へ広げない
4. 409 が返ったら: `vedit status` で再取得し、直前の自分の操作以外で
   revision が進んでいたら**中断して報告**(ユーザーが UI で編集した可能性)
5. 全適用後: `vedit view` で全体、各カット位置周辺を `vedit view --from --to` で確認
6. 適用後、主要な変更点を `vedit show range <t0> <t1>` で1箇所見せる
   (ユーザーは隣の Web UI 画面を見ながら会話している — revision は作らず --base も不要)
7. 報告: 自律適用件数、**実際に回答可能な**質問件数、rev 遷移、
   実際の削減秒数、根拠、診断除外(異常がある場合だけ)、
   回答済み例外の結果、view で見つけた違和感、
   caption の状態(`vedit captions`(引数なし)で cue 一覧を確認 —
   クランプ超過や重複がないか)
自律ゲート外・回答リスト外の編集はしない。戻すときは `vedit undo`
(--base 不要、特定 rev へは --rev N)。自律初稿は映像と候補状態が1回で戻る。
意味・好みで迷うものは勝手に決めず、質問としてディレクターへ返す。
```

## テンプレート4: QA・書き出し準備エージェント

```
vedit プロジェクト <dir> を、ユーザーがアプリ内ボタンからローカルMP4へ
書き出せる状態まで仕上げ検証してください。
1. `vedit view` で全体のフィルムストリップを確認(黒フレーム、意図しないジャンプ)
2. `vedit qc --project <dir>`、`vedit status --project <dir>`、
   `vedit captions --project <dir>` で欠損、未処理候補、尺、字幕を確認
   (`vedit candidates --all` のexcluded診断を未処理候補として数えない)
3. Resolve等への引き渡しが明示されている場合だけ、`vedit export otio
   <dir>/out.otio` → uvx --from opentimelineio で構造検証する
4. 通常フローでは `vedit export render` を実行しない。合格したrevisionと
   書き出し設定を報告し、ユーザー自身がWebアプリの
   「MP4をこのMacに書き出す」ボタンで開始できる状態にする。開始時に
   manifest・文字起こし・モーションが同じrevisionへ固定される
5. 自動化テスト・比較・障害対応としてCLIレンダーを明示された場合だけ
   `vedit export render` と ffprobe を実行し、ローカル成果物を検証する
6. 報告: 合否、対象revision、発見した問題、必要なら成果物のパス。
   書き出し中に別プロジェクトへ切り替えても、開始元のジョブ/結果だけを扱う

外部送信・公開は実行しない。別途依頼されても、宛先・アカウント・内容を
ディレクターがユーザーへ示して明示確認するまで委譲しない。
```
