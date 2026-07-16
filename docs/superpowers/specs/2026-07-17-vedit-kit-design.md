# vedit キット(プロジェクト横断の制作設定) — ミニ仕様(W8 改)

日付: 2026-07-17。目的: **シリーズ/チャンネルごとの「設定フォルダ」を一度作れば、
毎回の動画の見た目・トーン・テンポが安定する**こと。ぽんしゃすの制作設定
(video-production-profile/v1 等)は参考例であり、互換対象は取り込みで扱う。

## 概念

**キット** = プロジェクトの外にある制作設定ディレクトリへの**参照**(コピーしない)。
1つのキットを複数プロジェクトが共有し、キット更新は全プロジェクトに効く。

```ts
Manifest.kit?: { path: string }   // キットのルート(絶対パス)
```

## vedit 標準キット形式(これが主)

`vedit kit-init <dir> --name <シリーズ名>` が雛形を生成:

```text
<kit>/
├─ kit.json          # 下記スキーマ(vedit-kit/v1)
├─ GUIDE.md          # 制作ガイド(自由記述、ディレクターが Read する)
├─ fonts/            # フォントファイル
└─ assets/
   ├─ characters/  ├─ backgrounds/  └─ props/
```

kit.json(vedit-kit/v1)のセクション — **すべて optional、書いた分だけ効く**:

- `profile`: { tone_tags, language, duration_seconds{min,target,max},
  pacing{average_shot_seconds}, spine[](構成ビートの語彙),
  quiet_pause_policy } — 機械強制せずディレクターの判断材料
- `styles`: [{ id, label, use_for[], palette{text,outline,box,accent},
  caption{font,size_1080p,outline_width,background_opacity},
  title{同}, motion{entry,duration_seconds} }] — 字幕/ASS/web に反映
- `assets`: [{ id, path, type: sprite|background|prop, tags[], emotion?,
  intensity?, visible_bounds_normalized?, ground_anchor_normalized?, sha256? }]
  — bounds/anchor 未記入なら `vedit kit-scan` が PNG のアルファから自動計算して
  kit.json に書き戻す(手作業ゼロで素材を足せる)
- `audio`: { music_dir?, default_gain, duck_amount, target_lufs,
  repair_preset } — audio-mix / audio-repair の既定値
- `defaults`: { captions_style, export_preset, reframe_focus }

## 既存スキーマの取り込み(互換レイヤ、二次)

`vedit kit-import <srcDir> <kitDir>`: 既知スキーマ
(video-production-profile/v1、*-video-design-presets/v1、
video-character-asset-pack/v1、GUIDE md)を認識して vedit-kit/v1 に**変換**
(元ファイルは不変、assets はパス参照のまま)。ぽんしゃす設定はこれで一発移行。

## 1. デザインプリセット → 字幕/タイトルスタイル

- `vedit kit-link <dir> --base <rev>` / `kit-unlink` / `vedit kit`(内容表示)。
  link 時に kit.json を検証し、認識したセクションと defaults の適用結果を返す
- `vedit captions --style <kitStyleId> --base`: キットの style id を
  既存 style と同列に指定可能に。kit の defaults.captions_style は
  プロジェクト作成/リンク時の初期値になる
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
  assetId: string;               // kit.json assets の id
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
