# vedit キット(プロジェクト横断の制作設定) — ミニ仕様(W8 改)

日付: 2026-07-17。実データ: ぽんしゃすの制作設定
(/Users/ht/Documents/Codex/ぽんしゃす_まとめ/06_動画制作設定/)を第一級の
対応対象とする。既存スキーマをそのまま読む(移行作業をユーザーに課さない)。

## 概念

**キット** = プロジェクトの外にある制作設定ディレクトリへの**参照**(コピーしない)。
1つのキットを複数プロジェクトが共有し、キット更新は全プロジェクトに効く。

```ts
Manifest.kit?: { path: string }   // キットのルート(絶対パス)
```

`vedit kit-link <dir> --base <rev>` / `vedit kit-unlink --base` / `vedit kit`(内容表示)。
link 時に既知スキーマを走査して認識結果を返す:

| ファイル(スキーマ) | 対応 |
|---|---|
| `*video-profile.json`(video-production-profile/v1) | 制作プロファイル |
| `*design-presets.json`(*-video-design-presets/v1) | 文字・色・装飾プリセット |
| `*asset-pack.json`(video-character-asset-pack/v1) | タグ付き素材パック |
| `*GUIDE*.md` | 制作ガイド(ディレクター向け) |

## 1. デザインプリセット → 字幕/タイトルスタイル

- `vedit captions --style <kitPresetId> --base`: キットの preset id
  (room-warmth 等)を既存 style と同列に指定可能に
- ASS 生成: palette(text/outline/box/accent)、font(ファイルパス →
  ASS の fontname + `--attach` は使わず ffmpeg `ass` フィルタの
  `fontsdir=` でフォントディレクトリを渡す)、font_size_1080p
  (出力解像度に比例スケール)、outline_width、background_opacity を反映
- web プレビュー: daemon が `/media/kit/fonts/<name>` でフォントを配信し
  @font-face 動的登録、CSS 変数に palette を注入(パス封じ込め: kit root 内のみ)
- motion(chapter-card 等)の accent/palette もキットの palette を既定値に

## 2. スプライトオーバーレイ(新機能)

キャラ静止画をタイムラインに置く。B-roll(動画)とは別の軽量レイヤー。

```ts
Timeline.sprites?: SpriteItem[];
interface SpriteItem {
  id: string;                    // freshId('sp')
  assetId: string;               // asset-pack の id(例 'ponshasu-neutral')
  anchor: { sourceId: string; srcTime: number };  // B-roll と同じソース瞬間アンカー
  duration: number;
  position: { x: number; y: number };  // 0..1(ground_anchor_normalized を置く位置)
  scale: number;                  // 出力高さに対する表示高さの割合(0..1)
  opacity: number;                // 0..1
  flip?: boolean;
}
```

- 配置計算は asset-pack の `visible_bounds_normalized` と
  `ground_anchor_normalized` を使用(足元基準で置ける — render/web/view で共通の
  純関数 `spriteGeometry(asset, position, scale, outputWH)`)
- render: `-i <png>` + `overlay=enable=between(...)`(scale2ref 相当の事前 scale、
  opacity は format=rgba,colorchannelmixer=aa=)
- web: 絶対配置 `<img>`(kit 配信経由)、fade は CSS
- CLI: `vedit sprite-add <assetId> --at-word w0042 [--pos 0.85,0.9] [--scale 0.25]
  [--duration 3] --base` / sprite-update / sprite-remove
- `vedit kit-assets [--tag quiet] [--emotion happy]`: タグ・感情で素材検索
  (分析エージェント/ディレクターが「この場面に合う立ち絵」を選ぶ材料)
- asset-pack の distribution.redistribution_allowed=false を尊重:
  export otio では sprite を metadata 記録のみ(素材の再配布はしない)。
  render には焼き込む(ユーザー自身の成果物)

## 3. プロファイル/ガイド → ディレクターの編集判断へ

コードは解釈しない(機械的強制はしない)。露出方法:

- `vedit kit` と `vedit resume` に profile の要点(tone_tags、duration target、
  pacing、spine)を含める
- delegation.md テンプレート2に「キットがあれば `vedit kit` を読み、
  profile の spine/pacing を分析の評価軸に使う。GUIDE md があれば Read する」を追記
- editorial-playbook に「キットの spine(honest_hook → … → quiet_aftertaste)が
  あるときは方針宣言の『約束/見せ場/余韻』をそれに合わせる」

## セキュリティ

- kit path は link 時に実在検証。`/media/kit/*` 配信は resolveWithinDir(kitRoot)
- asset-pack の sha256 が記録されている素材は配信/レンダー前に検証(改竄検知、
  不一致は警告)

## テスト

kit-link のスキーマ認識(実スキーマの縮小フィクスチャ)、spriteGeometry
(ground anchor 配置・scale・flip)、ASS へのプリセット反映、sprite の
アンカー追従/orphan(B-roll と同じ規則)、kit フォント/素材のパス封じ込め。

## 非目標

キットの編集 UI(JSON はユーザー/別ツールが管理)、キャラの部位アニメ
(render_model.independent_parts が空である前提)、素材の自動生成。
