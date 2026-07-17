# vedit コンポジション(ゆるキャラアニメ) — ミニ仕様(W-ANIME)

日付: 2026-07-17。要件: キットのスプライト(ぽんしゃす等)が**緩く動く**
ショートを、会話+プレビューで作れる。目標はゆる紙芝居+であり、
アニメ制作ツールではない。

## コンポジションプロジェクト

`vedit compose <dir> --name X --duration 30 --size 1080x1920 [--kit <dir>]`:
映像ソースなしの製作モード。manifest に `composition: { duration, background }`。

- background: 単色(hex)、キット背景画像、またはループ動画(パス参照)
- ambient レイヤー(任意): キット assets の `type: 'ambient'`(ループ動画/連番)を
  背景の上に低 opacity で重ねる(漂う花・粒子。無ければ無し)。
  参照見本: 「ぽんしゃすと まるい暮らし」の部屋の空気感
- タイムラインは通常と同じ revision/undo/409。カット(シーン替え)は
  `bg-set --at <t> --to <背景>` で背景を切り替える紙芝居構造
- 既存機能はそのまま乗る: sprites(拡張)、music/SE、captions は使わない
  代わりに **dialogue**(下記)、motion(チャプターカード等)、export presets

## スプライトのモーションプリセット(拡張)

SpriteItem に `motion?: { enter?: MotionName; loop?: LoopName; exit?: MotionName; emoteAt?: [{t, assetId}] }`。

- MotionName: `slide-left|slide-right|hop-in|pop|fade`(enter/exit 対称)
- LoopName: `sway`(ゆらゆら)|`bob`(ぷかぷか)|`hop`(ぴょこぴょこ)|
  `breathe`(呼吸: scale ±1.2%、ぽんしゃすの maximum_scale_pulse_fraction 由来)|`none`
- `emoteAt`: 表情差分の切替(同キットの別 assetId へ、フェード 0.15s)
  — 感情タグ検索(`kit-assets --emotion`)と組で「うれしそうに」が通る
- **コンポジション内ではアンカーは絶対 tl 時刻**(anchor.sourceId='__comp__' 規約
  か optional 化 — 実装判断に任せるが、通常プロジェクトのソースアンカーは不変)
- render: overlay の x/y/scale/alpha を t の式で(例 sway:
  `x='X + 8*sin(2*PI*(t-t0)/3)'`)。プレビュー: 同じプリセットを CSS
  keyframes で対応(парity は「見た目近似で可」— 秒単位のタイミングのみ厳密)

## セリフ(dialogue)

- `vedit dialogue-add "今日は雨…" --sprite <spriteItemId> --at 3 --duration 2.5 --base`
- 吹き出しスタイル(キット style に `speech-bubble` 変種を自動派生: box角丸+
  しっぽはスプライトの ground anchor 方向)。ASS では丸角ボックス近似
  (BorderStyle=3+大きめ margin)で可
- 音声は任意: `--voice <audioファイル>` で SE と同じ経路に配置(TTS は外部で
  用意してもらう — vedit は生成しない)

## CLI/所作

```
vedit compose ~/anime/ep1 --duration 20 --size 1080x1920 --kit ~/kits/ponshasu
vedit sprite-add ponshasu-neutral --at 1 --pos 0.3,0.9 --scale 0.35 \
  --enter hop-in --loop sway --base 1
vedit dialogue-add "今日は雨…" --sprite sp01 --at 2 --duration 3 --base 2
vedit music-add rain.mp3 --gain -18 --base 3
vedit export render ep1.mp4 --preset shorts
```

編集プレイブック追記: コンポジション依頼(「〜なシーン作って」)は
シーン割り(背景+登場+セリフ+間)を方針宣言してから配置する。
セリフ文言はユーザー承認(出典ルールの適用対象)。

## 非目標(固定)

キーフレームエディタ、部位アニメ・リップシンク・物理、スプライト自動生成、
長尺(3分超)構成。プレビューとレンダーのアニメ曲線のピクセル一致
(タイミングのみ一致保証)。

## テスト

compose プロジェクト作成/検証、モーションプリセット→ffmpeg 式の純関数
(全プリセット)、emoteAt の切替、dialogue→ASS/web、既存(ソースあり)
プロジェクトの完全回帰。
