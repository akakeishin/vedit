# Export ガイド

## DaVinci Resolve(推奨ルート)

```bash
vedit export otio project.otio
```

Resolve 18.5 以降(無料版含む)で File > Import > Timeline から .otio を
選ぶ。カット構造(V1/A1 のクリップ列)がそのまま乗る。

- メディアが「オフライン」になったら: Media Pool で右クリック →
  Relink Media で元素材の場所を指す
- モーション部品はビデオトラックの紫マーカー(`motion:<id>`)として届く。
  spec 本体は project/motion/<id>.json

## Premiere Pro

```bash
vedit export fcp7xml project.xml   # 内部で OTIO → FCP7 XML 変換(uv 必要)
```

File > Import で .xml を選ぶ。変換に `uv`(brew install uv)が必要。
失敗した場合は .otio が残るので、Premiere の OTIO import(Beta 版に搭載)
か Resolve 経由で。

## 完成動画のレンダリング

```bash
vedit export render final.mp4                  # 素の書き出し
vedit export render final.mp4 --burn-captions  # 字幕焼き込み
```

- 元素材(プロキシではない)から libx264 CRF18 でエンコード
- 全編エンコードはここが唯一。編集中は一切エンコードしない
- 現時点の制限: モーション部品はレンダーに焼き込まれない(プレビュー+
  NLE handoff 用)。焼き込みが必要なら Resolve/Premiere 側で仕上げるか、
  今後の headless Chromium バージョンを待つ

## 検証のしかた

エクスポート後、以下で構造を確認できる:

```bash
uvx --from opentimelineio python -c "
import opentimelineio as otio
t = otio.adapters.read_from_file('project.otio')
print(t.name, t.duration())
for tr in t.tracks: print(tr.kind, len(tr))"
```
