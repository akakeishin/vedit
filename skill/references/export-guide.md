# Export ガイド

## タイムライン構成(OTIO)

`vedit export otio` が書き出す .otio の中身:

- **V1 / A1**: 本編(A-roll)のカット構造。V1 がビデオクリップ列、A1 が対応する音声。
  ビデオのみの区間(音声なし素材)は A1 側が Gap で埋まり、後続クリップの位置がずれない
- **V2**: B-roll(生成されている場合のみ)。アンカーが有効な(生きている)オーバーレイだけが
  Clip として並び、隙間は Gap
- **A2**: BGM(生成されている場合のみ)。曲(MusicItem)ごとに 1 Clip、頭出し位置は Gap で維持
- マーカー: モーション部品(紫)・スプライト(ピンク)は実クリップではなく V1 上のマーカーとして届く

## DaVinci Resolve(推奨ルート)

```bash
vedit export otio project.otio
```

Resolve 18.5 以降(無料版含む)で File > Import > Timeline から .otio を
選ぶ。カット構造(V1/A1 のクリップ列)がそのまま乗る。
**字幕は同時に生成される同名 .srt を File > Import > Subtitle で読み込む**
(OTIO 単体には字幕が乗らない)。

注意: `vedit reframe` のクロップは OTIO では再現されない(クリップの
metadata.vedit.crop に記録されるのみ)。縦ショートの完成は
`vedit export render` で行い、Resolve へは横のまま渡して向こうで
リフレームし直すのが確実。

- メディアが「オフライン」になったら: Media Pool で右クリック →
  Relink Media で元素材の場所を指す(B-roll 素材(V2)がオフラインになった
  場合も同じ手順)

### BGM(A2)の制限

BGM の音量(gain)・フェードイン/アウト・自動ダッキング(会話中の自動減衰)は
vedit のレンダー(ffmpeg)でのみ実際に適用される処理で、OTIO 自体には
音量/フェード/ダッキングという概念がない。そのため A2 クリップの
`metadata.vedit`(gain / fadeIn / fadeOut / duck)には値が記録されるが、
**Resolve 側では反映されず、A2 は生音量・フェードなし・ダッキングなしで
インポートされる**。

推奨ワークフロー:

- 意図した音のバランス(BGM の音量感、フェード、ダッキングの効き方)は
  先に `vedit export render` で書き出したファイルを聴いて確認する
- Resolve 側で最終ミックスまで仕上げたい場合は、A2 トラックの音量・
  フェード・ダッキング(サイドチェインコンプ等)を手動で設定し直す。
  具体的な数値が必要なときは .otio ファイル内の該当クリップの
  `metadata.vedit`(gain dB / fadeIn・fadeOut 秒 / duck 有無)を参照する
- 音のバランス自体は vedit の書き出しで確定させ、Resolve では絵(カット・
  リフレーム・カラー等)だけを仕上げる、という役割分担がもっとも事故が
  少ない

### B-roll(V2)の引き渡し

B-roll は V2(video のみのトラック)に、アンカー(A-roll 上の紐付け位置)が
生きているオーバーレイだけが Clip として並ぶ。アンカー先が編集でカットされ
「孤立」した B-roll は OTIO には一切書き出されない(書き出し時にコンソールへ
警告が出る)。

各クリップには `audioMode`(mute / mix / replace)と `gainDb` が
metadata.vedit として記録されるが、これは **記録されるだけで Resolve が
自動的に音声のミックスを再現するわけではない**。vedit 自身のレンダーでの
意味は次の通り:

- `mute`(既定値): B-roll 音声は使わない。本編(A1)の音声はそのまま
- `mix`: B-roll 音声を `gainDb`(既定 -18dB)で本編に重ねる。本編音声は
  そのまま
- `replace`: その区間だけ本編(A1)の音声を無音化し、B-roll 音声を
  `gainDb` で流す

Resolve 側でこの意図を再現したい場合は、`metadata.vedit.audioMode` /
`gainDb` の値を見ながら該当区間の A1/V2 の音量を手動で調整する。B-roll
素材がオフラインになったら Media Pool の Relink Media で元素材を指し直す
(上記と同じ手順)。

### スプライト

W8 キットのスプライトは実クリップではなく、V1 上のピンクのマーカー
(`sprite:<id>`)として届く。位置・スケール・不透明度・左右反転は
metadata.vedit(position / scale / opacity / flip)に記録される。

**素材(PNG など)そのものは OTIO に一切埋め込まれない・配布されない** —
キット素材の再配布条件を尊重するため、意図的に metadata 記録のみに
とどめている。したがって Resolve 上ではマーカーが見えるだけで、
キャラクター/小物の絵そのものは表示されない。画としてスプライトが必要な
場合は、`vedit export render` のレンダー出力(スプライトは焼き込まれる)を
最終成果物として使うか、Resolve 側でキット素材ファイルを別途持ち込んで
マーカーの metadata の位置情報をもとに手動配置する。

### モーション

モーション部品(chapter-card / lower-third / callout / cta など)は実
クリップではなく、V1 上の紫のマーカー(`motion:<id>`)として届く。マーカー
自体には見た目は乗らず、`metadata.vedit.spec` にはプロジェクトの
`motion/` 配下にある MotionSpec JSON への相対パスが記録されているだけ。

レンダリング(`vedit export render`)でモーションが実際に焼き込まれるかは
実装のバージョンによって変わりうるため、ここでは断定しない。焼き込み
対応の有無は都度 `vedit export render` の出力を確認すること。焼き込まれ
ない場合は、Resolve/Premiere 側でマーカーの位置とタイミングを見ながら
テロップ/カード等を作り直す必要がある。

## Premiere Pro

```bash
vedit export fcp7xml project.xml   # 内部で OTIO → FCP7 XML 変換(uv 必要)
```

File > Import で .xml を選ぶ。変換に `uv`(brew install uv)が必要。
失敗した場合は .otio が残るので、Premiere の OTIO import(Beta 版に搭載)
か Resolve 経由で。

fcp7xml は内部でいったん書き出した .otio を FCP7 XML に変換しているだけ
なので、BGM(A2)・B-roll(V2)・スプライト/モーション(マーカー)が
metadata 止まりで実ミックス/実描画に反映されないという制限は、上記
DaVinci Resolve の各節と同じ発想で当てはまる。ただし変換後にトラック名や
マーカーの色がそのまま保持されるかまでは未検証なので、Premiere に
取り込んだ後は実際の構造(トラック数・マーカー)を確認すること。

## 完成動画のレンダリング

```bash
vedit export render final.mp4                  # 素の書き出し
vedit export render final.mp4 --burn-captions  # 字幕焼き込み
```

- 元素材(プロキシではない)から libx264 CRF18 でエンコード
- 全編エンコードはここが唯一。編集中は一切エンコードしない
- BGM のミックス(音量/フェード/ダッキング)、B-roll の audioMode
  (mute/mix/replace)、スプライトはこのレンダーには正しく反映される
  (OTIO 経由の NLE handoff とは違い、ここは vedit 自身の最終ミックス)
- モーション部品(chapter-card/lower-third/callout/cta 等)の焼き込み
  対応状況は変わりうるため断定しない。都度レンダー出力を確認し、
  焼き込まれていなければ Resolve/Premiere 側で仕上げるか、対応バージョンを
  待つ

## 検証のしかた

エクスポート後、以下で構造を確認できる:

```bash
uvx --from opentimelineio python -c "
import opentimelineio as otio
t = otio.adapters.read_from_file('project.otio')
print(t.name, t.duration())
for tr in t.tracks: print(tr.kind, len(tr))"
```
