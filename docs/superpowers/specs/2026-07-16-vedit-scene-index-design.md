# vedit シーン索引 — 設計(Wave B 後の実装候補)

日付: 2026-07-16
状態: 設計確定・実装待ち。トーク素材の packed transcript と対になる、
映像素材(B-roll・風景・音楽乗せ)への住所付け機構。

## 目的

「エスカレーターのカットを使って」「s3 と s7 を頭に持ってきて」が通じるように、
しゃべりのない素材に**単語 id 相当の視覚単位(シーン id)**を与える。

## データモデル

```text
<project>/scenes-<sourceId>.json
{
  sourceId,
  scenes: [{
    id: "s0001",            // ソース内で安定、再検出でも変わらない採番
    t0, t1,                  // ソース時間
    thumb: "cache/sc-....jpg",
    hasSpeech: boolean,      // transcript の kept words と重なるか
    energy: number,          // 波形 peaks の平均(動きの proxy として音量を流用)
    note?: { text, by: "user"|"model", at }   // 後付け注釈(出典を記録)
  }]
}
```

- 検出は決定論(core)、**注釈はモデル/人間の層**に分離(出典ルール準拠)
- 元素材は不変。thumbs は cache/(再生成可能)

## 検出(core、決定論)

1. ffmpeg シーンチェンジ検出(proxy に対して `select='gt(scene,0.30)'`)
2. 長回し対策: 検出間隔が maxLen(デフォルト 12s)を超える区間は等分割
   (DJI vlog は1テイク1ショットが多く、シーン検出だけでは粗すぎる)
3. minLen(デフォルト 1.5s)未満の断片は隣に併合
4. 各シーンの中間フレームをサムネ化(160px、JPEG)

## CLI

```bash
vedit scenes detect [--source id] [--sensitivity 0.3] [--max-len 12]  # 生成(ingest 時オプトインも可)
vedit scenes [--source id]              # packed scene list(テキスト、id+尺+hasSpeech+note)
vedit scenes sheet [--source id]        # コンタクトシートPNG(サムネ格子+id焼き込み)→ Read する
vedit scenes note s0003 "エスカレーター上りの追い撮り" --by model   # 注釈
```

既存操作への糖衣(シーンは (sourceId, t0, t1) に解決されるだけ):

```bash
vedit clip-add <sourceId> --scene s0003 --base <rev>
vedit remove-range --scene s0007 --base <rev>
vedit view --scene s0003
```

## ワークフロー(スキルへの組み込み)

1. ingest(--no-add)→ `vedit scenes detect` → `vedit scenes sheet`
2. **分析エージェント(Sonnet)がシートを Read し、各シーンに一言注釈を
   `scenes note --by model` で記録**(視覚版 packed transcript の完成)
3. ディレクターは注釈付きシーンリストだけ読んで構成を組み、
   `clip-add --scene` で並べる → 以降は既存のカット・微調整フロー
4. UI: タイムライン下にシーン境界マーカー、ソースドロワー(サムネ一覧、
   クリックでプレビュー、✓/✕ の二値選別)— **これが素材選定(culling)UI を兼ねる**
   (伝統NLE調査の Favorite/Reject 縮約案と統合)

## 実装フェーズ

- **MVP**: detect + scenes/sheet + 注釈 + --scene 糖衣 + タイムラインマーカー
- **後続**: ソースドロワーUI(culling)、音声エネルギー以外の動き量指標、
  ingest 時の自動検出オプション

## 非目標

- 顔認識・物体検出などの重い視覚解析(注釈はモデルの目視で足りる)
- シーン単位の自動編集(判断は常にディレクター+ユーザー)
