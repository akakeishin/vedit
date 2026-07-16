# vedit B-roll V2 トラック — ミニ仕様(W3)

日付: 2026-07-17。Codex コンサル提案3の採用版。実装は Sonnet、契約は本書。

## 目的

話者の音声(A-roll)を続けたまま風景・手元・移動映像(B-roll)を重ねる、
vlog 編集の最頻出パターンを成立させる。汎用マルチトラックは作らない —
**重複不可の V2 一層のみ**。

## データモデル(後方互換、optional)

```ts
// Timeline に追加
overlays?: OverlayClip[];

interface OverlayClip {
  id: string;                 // freshId('ov')
  sourceId: string;           // B-roll 素材
  srcIn: number;              // B-roll 内の使用範囲
  srcOut: number;
  anchor: { sourceId: string; srcTime: number };  // ← 設計の肝(下記)
  audioMode: 'mute' | 'mix' | 'replace';          // 既定 mute
  gainDb?: number;            // mix/replace 時、既定 -18
}
```

## アンカー規則(最重要)

オーバーレイは**A-roll ソースの瞬間**(sourceId + srcTime)に張り付く。
タイムライン位置は毎回 `sourceTimeToTimeline(anchor)` で導出する。

- A-roll をリップル編集(カット・並べ替え)しても、アンカーの発話・瞬間が
  生き残っていれば B-roll は自動追従する(絶対 tlStart 保存の motion/music が
  持つ「カット後にズレる」問題を仕様レベルで回避)
- アンカーの瞬間がカットで消えたら **orphan**: manifest には残すが
  render/preview/OTIO から除外し、status と resume に
  `orphanedOverlays: [{id, 理由}]` として警告。再アンカーはユーザー操作
- 語 id / シーン id はアンカーの糖衣(`--at-word w0042` → その語の t0、
  `--scene s0003` → シーン t0 に解決してから保存)
- 解決後の区間 [tlStart, tlStart+dur) が他のオーバーレイと重なる追加・更新は
  400(V2 は一層、重複不可)。dur = srcOut - srcIn

## ops(純関数+テスト)

- addOverlay / updateOverlay / removeOverlay(検証: 有限、srcIn<srcOut、
  B-roll ソース存在、アンカーソース存在、重複なし)
- `resolveOverlays(m): {overlay, tlStart: number|null}[]`(null = orphan)

## CLI / daemon

```
vedit broll-add <brollSourceId> [--in 秒 --out 秒 | --scene sX]
  (--at-word w0042 [--source <aRollSrc>] | --at-src <aRollSrc> <秒> | --at-tl <秒>)
  [--audio mute|mix|replace] [--gain -18] --base <rev>
vedit broll-update <id> [同フラグ] --base / vedit broll-remove <id> --base
```

- `--at-tl` は現在のタイムライン時刻を (sourceId, srcTime) に逆解決して保存
- daemon op: 'broll-add' | 'broll-update' | 'broll-remove'
- status / resume に overlays 数と orphan 警告

## render

- B-roll ソースを追加入力にし、各 overlay を
  `trim → setpts(tlStart オフセット) → scale/pad(output 解像度、crop 適用)` →
  `overlay=enable='between(t,tlStart,tlEnd)'`(フルフレーム置き — PiP ではない)
- audioMode:
  - mute: A-roll 音声そのまま(B-roll 音は使わない)
  - mix: B-roll 音声を gainDb で amix
  - replace: overlay 区間だけ A-roll 音声を `volume=0:enable=between(...)` で
    落とし、B-roll 音声を adelay で重ねる
- overlay なしのプロジェクトは従来グラフと完全一致(回帰テスト必須)

## web プレビュー(最小)

- タイムラインに V2 行(クリップ行の上、細め、青緑系)
- 再生: 第二 `<video>`(G2 のソースプレビュー基盤を流用)を overlay 区間だけ
  前面表示。audioMode=mute は main の音声継続(第二 video は muted)。
  mix/replace は近似(第二 video の volume 制御)でよい
- orphan は V2 行に警告色で表示(クリックで理由トースト)

## view / OTIO

- view: timeline ドメインのサンプル点が overlay 区間内なら B-roll のフレームを
  描画(= レンダー結果と一致する見た目)。grid 凡例に overlay 由来と明記
- OTIO: V2 ビデオトラック(Gap + Clip.1、resolved tlStart 基準)。
  audioMode/gain は metadata。orphan は出力せず console 警告

## SKILL.md / playbook

- 「クリップ構成」の後に「B-roll(V2)」節: コマンド例+
  「アンカーは発話に張り付く(カットしても追従)。orphan 警告が出たら再アンカー」
- editorial-playbook: B-roll 挿入の判断基準1行(「話が続く区間の視覚的な
  単調さを補う。発話の意味と無関係な良い画はショート素材に回す」)

## テスト

アンカー追従(カット前後で tlStart が正しく再解決)、orphan 化、重複拒否、
audioMode 3種のフィルタグラフ、overlay なし回帰、OTIO V2。
