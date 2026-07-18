# オーバーレイ・スタック(複数画像・素材の重ね)ミニ仕様

日付: 2026-07-18。動機(ユーザー): 「文字以外にも画像とか素材を複数重ねる
ことは普通にあるよねー」。現行の V2 B-roll は重複不可の一層のみで、画像や
素材を複数枚重ねる普通の演出(ロゴ+写真+スタンプ等)ができない。

## 原則(戦略との整合)

- これは**装飾オーバーレイの積層**であり、汎用マルチトラック NLE 化ではない。
  各オーバーレイは本編タイムラインに従属する(独立した編集単位を持たない)。
- 音声を持つのは従来どおり V2 B-roll(動画、audioMode)だけ。画像
  オーバーレイは無音。
- キーフレームは作らない(モーションは既存 motion プリセットの領分)。

## モデル

- OverlayClip に `layer?: number`(既定 1 = 現行 V2)。昇順に本編の上へ
  合成(数字が大きいほど手前)。**同一 layer 内は重複不可**(現行規則を
  レイヤー単位に緩和)、レイヤー間は自由。
- 画像ソース: PNG/JPEG(アルファ対応)を `vedit ingest` で kind:'image' の
  Source として取り込み(probe で寸法、proxy/波形/転写はスキップ)。
  キットのアセット参照も可(既存キット参照の流儀に合わせる)。
- 配置: `rect?: {x, y, w}`(0..1 正規化、縦は元比率維持)、
  `opacity?: number`(0..1)、`fade?: {in?: 秒, out?: 秒}`(既定なし)。
  rect 未指定の動画 B-roll は現行挙動(全面)を維持=後方互換。
- アンカー: 既存の clipId/wordId/sceneId+offset / tlStart 機構をそのまま使う
  (リップル編集への追従・orphan 規則も既存のまま)。

## レンダー

- ffmpeg の overlay チェーンを layer 昇順に構築。scale は rect.w×出力幅、
  アルファ尊重。fade は fade=alpha。
- 警告: タイムライン終端をはみ出すオーバーレイ/出力比率と極端に合わない
  画像(縦長画像を 16:9 全面に等)は warnings[] へ。
- 通常プロジェクト・composition 両方で動作(composition のスプライトは
  別系統のまま — 関係を docs コメントで明記)。

## CLI

- `vedit overlay-add <sourceId|ファイル> --at <アンカー> --dur <秒>
  [--rect x,y,w] [--layer N] [--opacity a] [--fade-in s] [--fade-out s] --base <rev>`
  (ファイル指定時は画像なら自動 ingest してから配置)
- `vedit overlay-update <id> ...` / `vedit overlay-remove <id> --base <rev>`
- 既存 broll 系コマンドは無変更で動く(layer 1 の別名として整合)。

## OTIO

- layer ごとに V2..Vn トラックとして出力(画像は external reference)。
  otio.ts で自然に表現できない場合は V2 のみ出力+warnings で明示
  (省略をパリティとして自己申告)。

## やらないこと

- オーバーレイ独自の音声・速度・色調整/キーフレーム/UI のドラッグ配置
  (web の rect 調整は IA v3 のドリルイン・シートで数値+プリセット位置から)。

## 検証

- vitest: layer 検証(同層重複エラー・層間許容)、rect 正規化、後方互換
  (layer 未指定の既存 manifest)。
- 実 ffmpeg: 画像2枚(アルファあり/なし)+B-roll 1本を重ねてフレーム抽出し
  z 順と透過を目視確認できるテスト成果物を作る。
