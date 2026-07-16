# MotionSpec カタログ

モーション部品は宣言的 JSON(project/motion/*.json)。プレビューでは
Web NLE が DOM/CSS で即時描画する。焼き込みは行われない(NLE export 時は
マーカー+この JSON がサイドカーとして渡る)。

## プリセット共通パラメータ

| param | 意味 | 例 |
|---|---|---|
| `text` | メイン文言 | "素材の取り込み" |
| `subtitle` | サブ文言(chapter-card / lower-third) | "STEP 1" |
| `palette` | アクセント色(CSS color) | "#ff6b4a" |

配置は manifest 側: `tlStart`(タイムライン秒)+ `duration`(秒)。

## プリセット

### chapter-card
全画面の章タイトル。暗いグラデ背景+大きな title + アクセントバー + subtitle。
フェードイン。vlog の章区切り、ショートの冒頭フックに。

### lower-third
画面左下の名前・補足テロップ。左からスライドイン。人物紹介、場所名に。

### callout
画面右上の枠付き強調。ポップイン。「ここ重要」「※注意」系に。

### cta
画面下中央の丸ボタン風。チャンネル登録・フォロー誘導に。

### custom-html
`html` フィールドに HTML フラグメントをそのまま描画。プリセットで
表現できないときの逃げ道。注意:
- スタイルはインライン or `<style>` を含める(外部リソース参照は不可)
- ルート要素は `position:absolute` で配置を自分で決める
- アニメは CSS animation で(プレビューはリアルタイム描画)

## 例

```bash
vedit motion-add --type lower-third --text "山田さん" --subtitle "ゲスト" --at 12 --duration 5 --base 7
vedit motion-add --type custom-html --at 3 --duration 2 --base 8 \
  --html '<div style="position:absolute;top:10%;left:50%;transform:translateX(-50%);font-size:48px;color:#fff;text-shadow:0 2px 8px #000">🎉 100万回再生</div>'
```
