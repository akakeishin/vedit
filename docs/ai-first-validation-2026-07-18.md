# AI-first 実験・商用品質検証結果(2026-07-18 現時点)

## 結論

**AIが明白な低リスク作業を自律的に進め、意味・好み・証拠不足だけを人間へ
聞く製品境界は、実装と実素材の技術検証では成立した。一方、生身の利用者に
とって高品質で使いやすい商用品であることは、まだ証明していない。**

93本・約7.58時間の実素材を取り込み、長尺文字起こし、独立シーン検出、
93素材を持つWeb UI、実編集、実ffmpeg書き出し、配布tarballの隔離installまで
通し、短い合成fixtureだけだった検証範囲を実素材・長尺・配布物へ広げた。

ただし、ここで測ったのは破損しないこと、状態が復元すること、境界と尺が合う
こと、配布物が起動することなどの**機能的・技術的な整合**である。編集の自然さ、
質問の分かりやすさ、完成映像の魅力を人間が評価した結果ではない。素材権利の
完全なinventory、macOS外、アクセシビリティ、support/privacy/noticesも未達で
あり、現時点の判定は**商用品質へ向けた技術検証版 / 一般向け商用release未達**。

## 製品仮説と人間・AIの境界

主ペルソナは「作品判断は自分で行うが、検出・反復・整合確認はAIへ委任したい
個人クリエイター」。AIを目立たせること自体ではなく、人間の判断時間を意味の
ある箇所へ集中させることを狙う。

| 変更の性質 | 製品の振る舞い |
|---|---|
| 低リスク・可逆・独立した根拠が一致 | AIが1 revisionの初稿として先に適用し、件数・短縮量・根拠・Undoを示す |
| 意味・好み、証拠不足/衝突、冒頭末尾、断片化 | AI側から前後の文脈・理由・得失・原則2択を添えて人間へ聞く |
| 保護済み、不正、現在版に効果なし、判断済み | 自動編集も質問もせず、診断として除外する |
| ローカルMP4 | 人間がアプリ内の明示ボタンで開始する。表示revisionを固定する |
| 外部送信・公開 | 未実装。将来もローカル書き出しと分け、宛先・アカウント・内容を示す別操作にする |

自律初稿の現行ゲートは意図的に狭い。`silence`、未判断、正の区間、文字起こしの
語間と波形の二重根拠、transcript conflictなし、intent外、冒頭/末尾以外、
現在のタイムラインへ実効果あり、0.35秒未満の断片吸収なしをすべて満たす場合だけ
自動対象にする。二重根拠は「音響的に静か」の証拠であって、「作品上不要」の
証明ではない。意味のある間を保護する素材理解は人間またはAI編集ディレクターの
別の責任である。

## 検証スナップショット

| 面 | 実測結果 | 言えること / 言えないこと |
|---|---|---|
| 実素材コーパス | 93本、27,293.7秒(7:34:53.7、約7.58時間)、2,686,926,547 bytes(約2.50 GiB) | 多素材・長尺の技術経路を通した。商用利用権を一括証明したものではない |
| integrity | 93/93で元SHA-256、project参照、寸法、音声有無、尺を独立照合。尺差max 0 | 取り込み・再開で素材を取り違えていない |
| Web UI | 93素材、初回40行の段階描画、検索、7.6時間ruler、320/390/768px | 大量素材と狭幅で主要情報へ到達できる。人間の使いやすさ評価ではない |
| ASR | 640.306秒、1,361 timed words。参照subtitle 1,372語との正規化edit disagreement 11.95% | 実ASR経路と時刻語を確認。参照自体が人手ground truthではなく、human WERではない |
| 長尺job | 78分38.6秒素材でreload復帰・cancel・retry、partialなし | 長尺transcribeの中断復帰を実行。長尺renderやdisk-fullは別問題 |
| scene | 27シーン。独立ffmpeg結果と件数一致、境界差max 0.467 ms | 検出器との再現整合。シーン分割の創作上の良さは未評価 |
| 実編集 | 論理尺14.0109秒。最終video 14.040秒 / audio 14.011秒、48 kHz stereo、-14.38 LUFS | 尺・音声・loudness経路の整合。作品品質の採点ではない |
| 映像整合 | 4区間SSIM 0.9789 / 0.9506 / 0.9547 / 0.9313 | 期待ソース区間との画素類似。美的品質の尺度ではない |
| 配布 | npm tarballを隔離先へ実install、同梱UI assetsがHTTP 200 | source treeだけでなく配布物からUIを起動できる |

## 実験1: 実素材コーパスの取得・一括取り込み

### 取得と構成

再生成可能な一時clone、生成物、古い検証用動画を初回に約74.7 GiB削除し、
空いた領域へ約2.50 GiBの技術検証コーパスを取得した。最終監査では、さらに
3〜4日前の`/tmp/staticvr180-*` clean clone、Cargo build target、検証corpus、
派生10秒clipについて、稼働processなしとcloneのdirty変更なしを確認して削除し、
その時点の空き容量を59 GiBから165 GiBへ増やした。削除は復元不能だが、対象は
再取得・再生成可能なtemp/outputであり、ユーザーの`~/Movies`等の素材と、今回
取得した93本のvedit corpusは残した。

正式Deep監査の引き渡し後は、reportが削除可とした4つの複製state約4.7 GiBと
隔離package smokeを追加削除した。一次証跡は約5.9 MiBへ縮約済み。実素材を持つ
`vedit-commercial-audit-project-20260718`と`vedit-accuracy-audit-20260718`
（合計約2.4 GiB）は、安全審査の境界に従って保持した。

取得した93本の内訳は次のとおり。

- Mixkit: 9カテゴリ、72本
- Wikimedia Commons: 8本
- Internet Archive: 13本
- 音声あり21本、縦13本、正方形1本を含む
- H.264中心だが、MPEG-4 Part 2、Theora、VP8、VP9も含む

これはcodec・寸法・音声・尺のばらつきを作るための技術検証集合であり、製品へ
同梱する素材集ではない。各素材の利用条件、attribution要否、派生物の扱いを
release inventoryとして確定していないため、**権利確認なしにデモ・広告・
テンプレートへ転用してはならない**。

### batch結果

95 targetに対し93本を取り込み、破損ファイル1本を隔離し、同一内容のhardlink
1本を重複としてskipした。再実行では完了済み93本をSHA-256一致に基づいてskip。
独立probeと再hashで93/93本のpath、dimension、audio、duration、SHA-256を照合し、
元ファイルとprojectの対応に不一致はなかった。

この結果は、大量取り込み、破損隔離、重複排除、中断後再開、source非破壊の
技術契約を支持する。数百〜数千本、ネットワークドライブ、読み取り中に変化する
素材、ディスク不足までは証明しない。

## 実験2: 93素材Web UIと長尺job

実ブラウザで93素材を持つprojectを開き、次を確認した。

1. 最初の40行を描画し、続きは段階的に表示してメイン操作を塞がない
2. 大文字小文字をまたぐ検索、0件表示、clear後の復帰
3. 約7.6時間のtimeline rulerと93-source state
4. 音声あり/なし素材のpreview
5. 320 / 390 / 768pxで横overflowなし。主要操作と右キューへ到達可能
6. 1120pxでは右キューを開いたまま設定・候補レーン・プレビューを操作可能
7. 1280pxの実商用projectで設定、キット依頼ボタン、文書全体のoverflowなし
8. ヘッダーの「戻す / やり直す」は1120pxで文言付き、320pxでも操作可能な形で
   表示され、履歴の有無に応じたdisabled状態と横overflowなしを確認

音声付き素材の「再生」は、実Playwrightの初回クリックで`paused=false`、
`readyState=4`となり、二度押しを要求しないことも回帰化した。ブラウザ自動操作の
user activationなしで出た再生拒否は、製品の実クリックとは分離して扱った。

78分38.6秒のInternet Archive素材では、transcribe中にページをreloadしても
processing状態とcancel操作を復元できた。cancel後はterminal状態になり、
transcript revisionやtempを残さず、再試行は1 jobだけを開始した。

初期probeでは、文字起こしのない視覚主体92素材にも波形fallbackから3,909件の
質問を生成しており、AI-firstの意図に反していた。timed transcript wordがない
素材では発話編集候補を作らないよう契約を修正した結果、質問は転写済み素材由来の
89件だけになり、未転写素材由来は0件になった。これは「分からないことを全部
人間へ聞く」のではなく、必要な分析がない領域を質問で水増ししないための修正。

人間が93素材から目的の映像を素早く見つけられるか、40行chunkの体感、mobileで
快適に編集できるかは、実利用者のtask completionで別途測る必要がある。

## 実験3: 実ASRとシーン検出

### ASR

`ia006`(640.306秒)を実際のtranscribe経路へ通し、1,361 timed wordsを生成した。
公開subtitleを正規化した1,372語とのtoken sequence edit disagreementは11.95%。
このsubtitleは独立した人手校正ground truthとして監査しておらず、話者分離、
句読点、固有名詞、意味保持を人間が採点していない。したがって11.95%を
「WER 11.95%」や「88.05%正確」と表現しない。

同素材の最初のtranscribeはcancelし、temp・transcript・revisionを残さないことを
確認後、retryを完了した。長尺の`ia009`では前節のreload/cancel/retryを確認した。

### scene

`ia006`をsensitivity 0.25、min duration 0.5秒で検出して27 rangeを得た。
独立したffmpeg scene検出・range mergeも27件で、対応境界の差はmax 0.467 ms
(mean 0.242 ms)。生成thumbnailも実画像として確認した。

これは実装が独立ffmpeg基準を再現する証拠であり、「27分割が編集上最善」だと
人間が判断した結果ではない。

## 実験4: 実編集と最終レンダー

3種類の実素材から区間を選び、14.0109167秒のlogical timelineを作成した。
明示的に-14 LUFS、48 kHz stereoを指定し、最終MP4は次の結果になった。

- video duration: 14.040秒、351 frames
- audio duration: 14.011秒、48 kHz stereo
- container上のvideo/audio差: 29.083 ms、1 frame未満
- measured loudness: -14.38 LUFS
- source区間とのSSIM: 0.9789 / 0.9506 / 0.9547 / 0.9313
- cut境界に黒frameなし。意図した無音/有音区間を独立確認

これにより、複数source mapping、cut境界、音声sample rate/channel、duration
bound、loudnormが実出力へ反映されることを確認した。SSIMは圧縮後の対応区間が
期待素材に近いかを測るもので、カットのリズム、物語、見やすさの評価ではない。

## 実験5: 機械fixture 12自動 / 3質問

60秒・1 clipの合成manifestへ、内側の1秒無音12件に
`transcriptGap=true`、`waveform=true`、`transcriptConflict=false`をseedし、
好みで変わるfiller 3件を別候補として与えた。このfixtureはポリシーと状態遷移を
分離検証するもので、実音声から12件を検出したものではない。

| 観測 | 結果 |
|---|---|
| 自律適用 | 12件をAI actorの1 revisionへ集約 |
| 人間への質問 | 3件、すべてpreference-required |
| 尺 | 60.000秒 → 48.000秒 |
| 再実行 | 自律0件、revision増加なし、判断済みIDの重複適用を拒否 |
| Undo | 1回で60秒、15件すべてproposedへ復元 |
| Redo | 1回で48秒、12 approved + 3 proposedへ復元 |

この実験で証明したのは、明白と仮定した12件を1件ずつ質問せず、3件だけを
構造化質問へ分け、映像と判断状態を同じUndo/Redo単位で扱えること。
**実素材で12件が安全、現実の分布が12/3、人間が3質問を答えやすい、とは
証明していない。**

旧shibuya fixtureの12無音候補は、保存peaksへ現行検出を再適用すると0件で、
波形根拠のないlegacy候補だった。現行policyは自律0、証拠不足の質問12、
好み質問3、判断済み除外1となる。このfixtureを実編集品質の成功例として数えない。

## 実験6: AIから人間へ聞くUIと外部作用

実ブラウザとE2E fixtureで次を確認した。

- 自律編集の件数、根拠、実短縮量、Undoを表示
- 質問は理由・前後再生・残す/カットを持ち、protected/no-opを混ぜない
- 1回答だけをcommitし、残り質問を保持。高速二重押しは1判断/1 revision
- manifest、候補、transcriptを同じ論理Undo/Redoへ固定
- ヘッダーからUndo/Redoへ常に到達でき、Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z、Ctrl+Yで
  同じ履歴を操作できる。テキスト入力中はブラウザの標準編集を奪わない
- project切替時に前projectの候補、job、結果card、遅延fetch/WSを持ち越さない
- UIを開いただけでは編集も書き出しも開始しない

ローカルMP4はWeb UIの「MP4をこのMacに書き出す」ボタンから開始し、表示中の
revisionをimmutable snapshotとして`<project>/exports/`へ書き出す。AIは編集、
設定、QCまで準備できるが、通常フローでこのボタンを代理押下しない。

YouTube、SNS、cloud storage等への外部送信・公開は実装していない。「勝手に
送信しない」は現在、送信経路が存在しないことによる境界であり、将来機能を追加
した時点で宛先・account・内容・明示確認を再検証する必要がある。

## 安全性・競合・配布のハードニング

実素材probeとblind-spot監査で、green testだけでは見落としやすい面を追加した。

| 面 | 現在の契約 |
|---|---|
| project identity | mutating APIは表示projectのidentityを要求し、遅延応答もprojectDir不一致なら破棄 |
| loopback request | HTTP/WSでHost、Origin、Sec-Fetch-Siteを検証し、cross-site起動を拒否 |
| upload | tokenとpathだけでなくinode/size identityを照合。置換されたpathは削除しない |
| candidate/scene state | process間lock、atomic rename、detect markerとcandidate publishの整合、壊れたsidecarを上書きしない |
| transcribe/scene job | cancelで子processへsignalし、tempを掃除。reload後もjob truthを復元 |
| export | revision snapshot、単一claim、lease owner、cancel/recovery、symlink containment、terminal state再保存 |
| package | index.htmlからJS/CSS import closureを検証し、必要Web moduleのtarball欠落を防止 |

localhost daemonは「無保護」ではないが、Host/Origin/project identityは認証・
暗号化ではない。同一マシン上で任意コードを実行できる攻撃者、信頼できない
multi-user環境、LAN/インターネット公開を防御する製品ではない。loopbackの
開発・個人利用境界を越えるなら、認証、TLSまたはOS IPC、権限分離が別途必要。

## 配布物と自動回帰

`npm pack`相当の配布tarballをsource tree外の隔離先へinstallし、CLIとWeb UIを
起動、HTMLから参照されるUI assetsがHTTP 200で返ることを確認した。package検証は
top-level file listだけでなく、browser entryからのimport/CSS依存closureを追う。

最終freeze後の回帰状況は次のとおり。自動回帰の件数はこのfreezeに対する
実測値であり、将来テスト追加後も固定の製品指標として扱わない。

| 検証 | 状態 |
|---|---|
| `npm run build` | PASS |
| `npm test -- --run` | PASS、1,556/1,556 |
| `npm run test:e2e` | PASS、31/31。実ブラウザ・実daemon |
| `npm run verify:package` | PASS、56 files / 469,401 packed bytes / 1,572,776 unpacked bytes。browser dependency closureを含む |
| 配布tarball隔離install + UI asset HTTP | 最終freeze（SHA-1 `aa33dda440a7746106c15c9a8bb98a5caf485bcf`）を空環境へinstallしPASS。CLI create/statusとHTML + browser依存9資産がすべてHTTP 200 |
| 実ffmpeg smoke | `smoke:export` / `smoke:compose` / `smoke:overlay`の3種すべてPASS |
| formal experience run | `bounded-partial`、schema-v2 validator PASS。REVIEWはexercised、AUTONOMY/EXPORT/RETURNは原因を固定したgap。人間評価の代替ではない |

自動回帰がgreenでも、人間の使いやすさ、質問への信頼、編集品質、商用素材の
権利を証明しない。失敗・skipを隠していないが、未実施の実機条件は後述の
商用release前検証として残す。

最終再実行では、cross-process export leaseテストの子process合図が、存在確認と
JSON書込の間で競合するテスト側のflaky failureを1回検出した。合図をtempからの
atomic renameへ変更し、該当テストを20回連続と全1,556件で再実行してPASSした。
製品のlease実装失敗として数えず、検証harnessの欠陥として修正した。

## 実験7: 独立行動方針によるDeep監査

最終runtime（`dist/` + `web/` SHA-256
`c41c71d7c3fe40d49ba5bad744acfc450ea852c694f7b959a9abfb235ba2a209`）を
固定し、知識・計画幅・損失許容を変えた4方針で、操作traceと製品状態を分けて
監査した。機械可読bundleはschema-v2 validatorを通過した。最終statusは
`bounded-partial`であり、gapを成功へ繰り上げていない。

| 方針 | 正式結果 | 境界 |
|---|---|---|
| AUTONOMY | gap | 2素材・rev4の最終stateは残ったが、独立runner自身のreceiptを回収できず非計上 |
| REVIEW | exercised | 1120×800の可視操作だけで1候補をKeepし、Undo/Redoで状態を完全往復 |
| EXPORT | gap | 版・保存先・外部送信なし・明示ボタンまで確認。追加MP4はexact-confirmation権限で停止 |
| RETURN | gap | locator較正が同じstateへ混入したためtraceをinvalid化し、製品不具合の初期推論を撤回 |

REVIEWのledgerは、`rev94 / header 90 / AI 89 / 候補あり` → Keepで
`rev95 / 89 / 88 / 候補なし` → Undoで`rev96 / 90 / 89 / 候補復元` →
Redoで`rev97 / 89 / 88 / 候補なし`。candidate membership、2つの件数、
Redo可否が同時に往復した。これは「理由と得失を見て一件判断し、同じ場所から
回復できる」という機能的invariantをmedium confidenceで支持する。ただしKeep
一件だけであり、Cut、bulk、残り88件、長期利用へ一般化しない。

体験予測は独立challengerをagent-thread上限で起動できなかったため
`unresolved`のまま残した。人間の信頼、理解、疲労、満足を測ったとは扱わない。
最小の次段階は3ペルソナ×2人、各30分で、取込→AI初稿→質問3件→Undo/Redo→
reload→明示ローカルMP4を同一課題として観測すること。

詳細は[/tmp/vedit-experience-final/report.md](/tmp/vedit-experience-final/report.md)、
機械可読証跡は
[/tmp/vedit-experience-final/audit-bundle.json](/tmp/vedit-experience-final/audit-bundle.json)。

## 現時点の合否

| 製品仮説 | 判定 | 根拠 |
|---|---|---|
| 一件の意味判断を安全に戻し、同じ結果へ戻せる | PASS(狭い機能範囲) | 独立REVIEW traceでKeep→Undo→Redo、候補・件数・可否が完全往復 |
| AIが明白な処理を1件ずつ聞かず進める | 条件付きPASS | 12/3 fixtureと実候補水増し修正。実編集の人間採点なし |
| 意味・好みだけを人間へ聞く | 条件付きPASS | 理由付き質問と診断除外を実装。質問理解の人間評価なし |
| 長尺・多数素材でも状態を失わない | 条件付きPASS | 93本/7.58時間、78:38.6 job。さらに大規模・disk-fullは未検証 |
| 実素材を正しく取り込み・レンダーする | PASS(技術整合) | 93/93 integrity、実編集尺・音声・SSIM・LUFS |
| アプリ内ボタンからローカルMP4 | PASS | 明示操作、revision snapshot、実ffmpeg、結果card |
| 外部送信を勝手にしない | PASS(非実装境界) | 外部送信経路なし。実装時に再審査が必要 |
| 配布tarballからUIが動く | PASS | 隔離install、UI assets HTTP 200 |
| 人間にとって高品質で使いやすい | 未検証 | 生身のtask test、理解度、比較編集、満足度を未測定 |
| 一般向け商用releaseの準備が整った | FAIL / 未達 | 権利、複数OS、support/privacy/notices、a11y、fault試験が未完 |

## 商用release前に必要な次の検証

1. 権利のある5〜10本以上で、人間編集とのblind比較、境界の自然さ、意味保持、
   Undo率、部分修正率を測る
2. 初見ユーザーに「AIが何をしたか」「なぜ質問したか」を説明してもらい、
   task completion、回答時間、誤操作、信頼回復を観測する
3. 素材ごとのlicense、取得URL、author、attribution、再配布可否をinventory化し、
   third-party noticesと製品同梱物を監査する
4. Windows/Linux、VoiceOver、キーボードのみ、低メモリ、disk-full、daemon kill、
   長時間render中断、複数tab/project競合を実機で試す
5. support、privacy、versioning/migration、更新失敗時rollback、ログの扱いを決める
6. 3本以上で同じ好みが安定した場合だけ、自然文prefを安全なseries policyへ
   構造化する。モデルpersonaや合成scoreを人間の感想として扱わない

誤削除、意味のある間の破壊、説明不能、Undo率の高さが反復するなら、自律範囲を
広げず狭める。AI-firstは質問を減らすことではなく、**根拠のある反復を委任し、
作者にしか決められない判断を、答えられる形で返すこと**を成功条件とする。
