# 委譲テンプレート — ディレクターと手足の分業

vedit はメイン会話(ディレクター: Fable/Opus)が判断を握り、機械的な作業を
Sonnet サブエージェント(Agent tool, model: "sonnet")に委譲して使う。
ディレクターのコンテキストは「ユーザーの意図」「構成判断」「レビュー」に温存する。

## 役割分担

| 作業 | 担当 | 理由 |
|---|---|---|
| ユーザーとの対話・意図の解釈 | ディレクター | 会話の文脈を持つ |
| 編集方針の宣言・構成の最終判断 | ディレクター | 編集品質の中核 |
| ingest 実行・監視(複数クリップ) | Sonnet | 長時間の babysitting |
| transcript 精読 → 構造化分析 | Sonnet | 長文読解はトークンが重い |
| 承認済みカットの一括適用+検証 | Sonnet | 機械的(--base 再試行含む) |
| view PNG での品質チェック | Sonnet | 画像確認の作業量が多い |
| export + バリデーション | Sonnet | 定型 |
| モーションの文言・デザイン | ディレクター | クリエイティブ+出典管理 |
| サブエージェント成果のレビュー | ディレクター | 手綱 |

原則: 1〜2コマンドで済む操作はインラインでよい。3コマンド超、長時間、
または transcript 全文読みが必要な作業は委譲する。Agent tool が使えない
環境ではインラインにフォールバック(その場合も packed transcript を使い、
--full の全文読みは避ける)。

## テンプレート1: ingest エージェント

```
vedit プロジェクト <dir> に以下のファイルを取り込んでください。
ファイル: <リスト>
手順: 各ファイルを `vedit ingest <file> --language ja --project <dir>` で順次取り込み
(所要時間を計測)。全件完了後: `vedit status`、各ソースの packed transcript の
冒頭20行、フェーズ別 timings、エラーがあれば doctor の結果を報告。
コードの編集・git 操作は禁止。
```

## テンプレート2: transcript 分析エージェント(編集判断の材料作り)

```
vedit プロジェクト <dir> の素材を分析し、編集判断の材料を作ってください。
編集の目的: <ユーザーの意図をそのまま>(例: 3分のテンポいい vlog に)

手順:
1. `vedit status --project <dir>` で全ソース確認
2. `vedit transcript --project <dir>` で packed transcript を読む(全ソース)。
   末尾の語などに ⟨id⟩ が無いときは `vedit transcript --full --source <id>`
3. `vedit detect --project <dir>` を実行し候補を確認
   (注意: detect は候補を作成し、ユーザーの UI 提案タブにも現れる。
   副作用として報告に含めること)
4. 判断に迷う箇所は `vedit view --domain source --source <id> --from X --to Y` の
   PNG を Read(**transcript の時刻はソース時刻**。timeline ドメインに渡さない)
5. transcript が全体的に崩れているソース(誤認識だらけ、"?" 多発)は、
   その旨を risks に書き、`vedit scenes` + `vedit scenes sheet` で
   視覚ベースの分析に切り替える
6. しゃべりのない素材(B-roll等)がある場合は `vedit scenes detect` 済みか確認し、
   `vedit scenes sheet` のサムネ格子を Read して各シーンに keep/reject を推薦する

次の構造で報告(これ以外の長文は書かない):
- durations: [{sourceId, 収録秒数}] と削減見込み合計(方針宣言の「何秒→何秒」用)
- chapters: [{title, sourceId, おおよその範囲(語id), 一言要約}]
- highlights: [{sourceId, 語id範囲, 引用, 残すべき理由(フック/感情の山/見せ場)}]
- cutCandidates: [{ids: "w0120..w0134", sourceId, 引用, 理由(言い直し|脱線|だれ場|無音|フィラー), 秒数, confidence}]
  - confidence の基準: **high** = 言い直し/フィラー/波形と transcript が一致する無音。
    **low** = 脱線判断・意味のある間の可能性・"?" 付き低信頼区間に触れるもの。
    low は適用せず UI 提案タブ行きにする
- pauses: [{sourceId, t0, t1, 秒数, 判定: 意味のある間(残す)|だれ場(切る)|判断保留}]
- sceneReview: [{sourceId, sceneId, 推薦: keep|reject, 理由}]
  (シーン検出済みソースのみ。`vedit review` の適用はディレクター側でユーザー承認後)
- risks: [切ると文脈が壊れる箇所、音声が不明瞭で transcript が信用できない箇所]

引用は packed transcript から逐語(20字以内、"?" マークも保持)。
誤認識疑いの引用には(誤認識?)を付す。
コードの編集・カットの適用は禁止。分析のみ。単一ソース・短尺(〜2分)なら
このテンプレートを使わずディレクターがインラインで分析してよい。
```

## テンプレート3: 実行エージェント(承認済みカットの適用)

```
vedit プロジェクト <dir> に以下の承認済み編集を適用してください。
編集リスト: [{op, ids/range, sourceId}, ...]

手順:
1. `vedit status` で現在 revision を取得
2. リストを順に適用。各コマンドに --base <直前に確認した revision> を付ける
3. 409 が返ったら: `vedit status` で再取得し、直前の自分の操作以外で
   revision が進んでいたら**中断して報告**(ユーザーが UI で編集した可能性)
4. 全適用後: `vedit view` で全体、各カット位置周辺を `vedit view --from --to` で確認
5. 報告: 適用結果(rev 遷移、削減秒数合計)、view で見つけた違和感、
   caption の状態(`vedit captions`(引数なし)で cue 一覧を確認 —
   クランプ超過や重複がないか)
リスト外の編集は一切しない。戻すときは `vedit undo`(--base 不要、
特定 rev へは --rev N)。疑問があれば止まって報告。
```

## テンプレート4: QA・export エージェント

```
vedit プロジェクト <dir> の仕上げ検証をしてください。
1. `vedit view` で全体のフィルムストリップを確認(黒フレーム、意図しないジャンプ)
2. `vedit export otio <dir>/out.otio` → uvx --from opentimelineio で構造検証
   (トラック数、クリップ数、duration が status と一致するか)
3. (指示があれば) `vedit export render` して ffprobe で尺・ストリーム確認
4. 報告: 合否、発見した問題、成果物のパス
```
