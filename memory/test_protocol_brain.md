# テストのやり方（ブレイン・返信・AIX）— テストの前に必ず読む

最終更新: 2026-10-01（竹内「テスト行う際必ずこのやりかた（ブレインのぶぶん）読むようにしたらいける。1～4すべて改善する。設計知見と協力して改善する」）

YUMA でブレイン・返信・AIX を試す時は、**毎回この順番**で行う。どの担当（エージェント・Workflow の実測役）も同じ。
指示文でテストを頼む時は「memory/test_protocol_brain.md を読んでから」と必ず書く（口頭の申し送りは守られなかった＝9/23・10/01）。

---

## 0. 必ず守る8つ（ここだけは読み飛ばさない）

1. **YUMA だけ**（`dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7`・竹内さん本人のテスト用 LINE）。他の会話で LLM を呼ばない・書かない。
2. **起動の印を必ず付ける**: 試行錯誤は `LLM_TEST_MODE=deepseek-all`、最後の Claude は `LLM_TEST_FINAL_CLAUDE=1`。どちらも無いとスクリプトは止まる。`.env.local` には書かない。
3. **スクリプトは共通の入口** `scripts/lib/llm-test-harness.ts` の `setupLlmTest()` を最初に呼ぶ。LLM を呼ぶモジュール（brain-core 等）はその**後に** dynamic import。終わりは `finally` で `h.finish()`。
4. **試行錯誤は全部 DeepSeek**（ブレインも返信も判定も最終チェックも）。Claude に行こうとした呼び出しは**止まる**（黙って払わない）。
5. **最後の Claude は場面ごとに1〜2回**だけ（`LLM_TEST_FINAL_CLAUDE=1`）。方向が決まってから。
6. **他の実行と混ぜない**: 場面は未来の時刻に置き、流す前に他の実行の行（未来の時刻の行も）が無いか見る。混ざった回は数えない。
7. **個人情報を材料に入れない**: 本番の会話から作る場面・再生は、申込の書類・本人確認書類・収入の書類・個人の値（携帯番号・生年月日・メール・年収）の**手前で切り**、名前・番号を伏せる。申込以降の会話は対象外。
8. **片付けは自分が作った物だけ・名前を並べて消す**。共有のフォルダでワイルドカード削除（`rm scripts/tmp-*.ts` 等）をしない。消す前に `git status` を見る。報告には必ず **model・回数・費用** を書く。

---

## 1. YUMA だけ

- テスト用の会話の id は `app/lib/test-conversations.ts` の `YUMA_CONVERSATION_ID` が正。
- 歯止め（2026-10-01）: テストの間（deepseek-all／final-claude）は、**会話 ID が YUMA 以外の LLM 呼び出しを出口で断る**
  （`llm-alt-provider`＝DeepSeek 側・`llm-usage-recorder`＝Claude 側・`jev-client`＝Jev）。スクリプトでは `h.assertYuma(id)` を書き込みの前に呼ぶ。
- お客様の会話で試したい時は、直接流さず **YUMA に写す**:
  `LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/replay-brain-readonly.ts --copy-to-yuma=<会話id> [--last=12] [回数]`
  （元の会話は読むだけ・申込以降の状態は写さない・書類の手前で切る・お客様の名前は「YUMA」・他の名前と番号は maskPII・写した通は終わったら消す）
- LLM を呼ばない読み取りだけの監査（`scripts/audit-*.ts`）は本番の会話を読んでよい（入口は使わない）。**LLM を呼ぶ物は必ず入口を通す**。
- YUMA の状態（`conversations.status` 等）を変える物は、前後に `scripts/yuma-snapshot.ts save` / `restore`。
- YUMA は申込へ押下の記録がある → `status_manual_back_at` を最新にしないと申込以降扱い＝DeepSeek に回せない（deepseek-all では止まる）。

## 2. 混ざり（同時に走る他の実行）

- 他の担当も同じ時間に YUMA に場面を入れる。**自分の場面は未来の時刻**に置く（`h.sceneTimes(n)`＝最後の通を今＋2分・20秒刻み）。
- 流す前に `await h.waitUntilYumaQuiet(自分の行id)`（他の実行の行が無くなるまで最大10分待つ・過ぎたら止まる）。
  `h.foreignYumaRows(自分の行id)` は**今から10分以内と未来の時刻の行**を他人の物として返す（10/01 ⑤の未来の行が⑦の3巡目に混ざった）。
- 混ざった回の結果は数えない（報告に「混ざり N 回・除外」と書く）。見積書の引き継ぎのテスト（`yuma-estimate-handoff-test.ts`）の「他の場面の混入を数えて飛ばす」形も同じ。
- 再生（本番の場面を YUMA で流す）は `REPLAY_FLOOR_FILE` で YUMA の過去の記録を読まない（`app/lib/test-replay-floor.ts`）。

## 3. 試行錯誤＝全部 DeepSeek（`LLM_TEST_MODE=deepseek-all`・厳密）

```
# スクリプト
LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-aix-scene-brain-test.ts 1 estimate
# 開発サーバ（HTTP で /api/generate-reply 等を叩くテスト）も同じ印で起動する
#   （LINE に送らないよう LINE_*_CHANNEL_ACCESS_TOKEN=invalid LINE_STAFF_GROUP_ID=invalid も付ける）
LLM_TEST_MODE=deepseek-all LINE_STAFF_GROUP_ID=invalid … npx next dev --webpack -p 3463
```
- 2026-10-01 から deepseek-all は**ブレイン（brain_fresh / brain_full / 戦略の整理 brain_strategy / セーブデータ brain_checkpoint / 取り直し brain_fresh_claude）も含めて全部** DeepSeek。
  `LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full` を足す必要はもう無い（足しても害は無い）。
- **Claude に行こうとした呼び出しは例外で止まる**（日本語で名札・理由・直し方がログに出る・llm_usage_logs に `error_type=test_blocked` の行・費用0）。止まる理由:
  画像つき（DeepSeek は文字だけ。例 `extract_estimate`）／申込以降の会話／他の会話／時刻の線の印が blocked／個人の値／DeepSeek の包みが無い。
  - 画像の読み取りなどどうしても Claude で回す名札だけ `LLM_TEST_ALLOW_CLAUDE=extract_estimate` のように名前ごとに通す（`*` は不可・費用は報告に書く）。
  - 呼び出し側が失敗を飲み込む（fail-open）所でも、止めた事はログと終わりの集計（`h.finish()`）に必ず出て、終了コードが 1 になる。
- スクリプトは deepseek-all の間 `ANTHROPIC_API_KEY` を偽の値にする → 入口を通らずに作った SDK（静的 import 等）は 401 で必ず落ちる。
- 開発サーバは Next の HMR で fetch の包みが外れる（resetFetch）→ 2026-10-01 から instrumentation の見張りがその場で包み直す。それでも**印を付け外ししたら必ず再起動**。
- ⚠ DeepSeek のブレインは揺れる（自分同士の一致 action 7/10・intent 4/10・していない約束を書く）。結果がぶれたら、揺れか直した所の効果かを分けて読む。方向の確定は最後の Claude で。
- DeepSeek が失敗しても Claude に戻さない（失敗は失敗として出す）。

## 4. 最後の確かめ＝Claude（`LLM_TEST_FINAL_CLAUDE=1`）

```
LLM_TEST_FINAL_CLAUDE=1 npx tsx --env-file=.env.local scripts/yuma-aix-scene-brain-test.ts 1 estimate
LLM_TEST_FINAL_CLAUDE=1 npx next dev --webpack -p 3463     # 開発サーバも付け直して再起動
```
- **本番と同じ組み合わせ**（返信の本文は DeepSeek＝.env.local の `LLM_ALT_ACTIONS=reply_generate`、ブレイン・判定・最終チェックは Claude）。
  Sonnet は本番と同じ 5.5 に自動でそろう（`.env.local` に CLAUDE_SONNET_* が無い時だけ `claude-sonnet-5-5`・`*` を入れる）。
- **回数: 場面ごとに1〜2回まで**。方向が deepseek-all で決まってから。全場面を何周も回さない（9/23 午後のテスト1回が本番8日分＝$22）。
- 費用の目安（10/01 実測）: ブレイン1回 $0.04（キャッシュが温まっている時）／手元のコードが本番と違う・その日最初の1回は前置きの書き込みで $0.20。
- 両方の印を同時に付けると止まる。`LLM_TEST_FINAL_CLAUDE=1` の間も YUMA 以外は断る・個人の値は送らない。
- 記録の env 列は `local:final-claude`（試行錯誤は `local:deepseek-all`・印なしは `local`）。

## 5. 共通の入口（スクリプトは必ずこれ）

```ts
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
async function main() {
  h = await setupLlmTest("yuma-xxx-test");                         // 印の確認・包み（絵文字→記録→DeepSeek）・route=script:yuma-xxx-test
  const { analyzeConversation } = await import("../app/lib/brain-core"); // ← 必ず後で dynamic import（静的 import は包む前の fetch を握る）
  await h.waitUntilYumaQuiet([]);
  h.assertSceneSafe(texts, "場面id");                               // 書類・個人の値が無いか
  const times = h.sceneTimes(texts.length);                          // 未来の時刻
  // … YUMA に入れる → 判断 → 自分の id だけ消す …
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { /* 自分の行を消す */ if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
```
- **開発サーバを HTTP で叩くスクリプト**（2026-10-02 竹内「テストはテストやで」）は、最初のリクエストの前に
  `await requireTestServer(BASE, "名前")`（`scripts/lib/dev-server-test-guard.ts`）。手元（localhost）以外の URL・`GET /api/test/llm-mode`（開発サーバだけが答える・本番は 404）で
  テストの印が無いサーバ・スクリプトとサーバの印の食い違いは止める。終わる時に開発サーバの行（env=local:<印>・script: 以外の route）を model・回数・費用で出す（他の担当の行を含みうる）。
  10/02 に yuma-* の HTTP のスクリプト 37本に入れた（yuma-trim-send-test は本番の API を確かめる物なので外した）。
- `h.finish()` は記録の書き込みを待ってから、この回の行（route=`script:<名前>`）を model・回数・費用で出す。deepseek-all で Claude があれば・止めた呼び出しがあれば終了コード 1。
- 開発サーバ経由（/api/...）の呼び出しは route が `/api/...` になるので、`scripts/test-llm-usage.ts --since=<h.t0>` で数える。
- 2026-10-01 に入口へ載せ替えたスクリプト: yuma-aix-scene-brain-test・yuma-brain-1001-test・yuma-estimate-handoff-test・yuma-first-reply-echo-test・yuma-replay-scenarios・
  replay-brain-readonly・yuma-brain-decision・yuma-procedure-question-test・yuma-strategy-refresh・yuma-jev-materials-test。新しく LLM を呼ぶスクリプトを作る時も同じ形。

## 6. 個人情報（本番の会話から材料を作る時）

- 本番の会話から場面・再生を作る時は、**最初の申込の書類・本人確認書類・収入の書類・個人の値の手前で切る**（`app/lib/test-pii-guard.ts` の `cutBeforeApplicationMaterial`・1通ずつ `applicationMaterialReason`）。
  「申込へ を押す前」だけで切らない（10/01 会話 ae321772: 申込へ を押さずに記入済みの申込フォーム＝氏名・生年月日・住所・勤務先・年収が届いていて、2場面の前の通に入り DeepSeek に渡った）。
- 名前は「YUMA」、他の名前・電話・メールは maskPII で伏せる。
- 出口の網（テストの間だけ）: DeepSeek・Claude に送る本文全体に**個人の値**（携帯番号・2010年以前の生年月日・メール・記入済みの申込フォーム）があれば止める。
  空の申込フォーマット（スタッフが送る形）は止めない。書類の指紋（語の組）は本文全体には使わない（指示文に当たって全部止まるため）＝1通ずつの判定は材料を作る側で。
- 申込以降の会話・場面は今の改善・テストの対象外（審査落ち→別物件への切り替えだけは対象）。

## 7. 確かめ方（model・回数・費用）

```
npx tsx --env-file=.env.local scripts/test-llm-usage.ts --since=<開始の ISO>      # env=local* を env×route×action×model で・漏れ・止めた・YUMA 以外
npx tsx --env-file=.env.local scripts/test-llm-usage.ts --route=script:yuma-xxx-test --since=<開始>
```
SQL（MCP が使える時）:
```sql
-- この回の行（試行錯誤で Claude が 0 か）
SELECT env, route, action, model, count(*), sum(input_uncached) uin, sum(cache_read) rd, sum(cache_write_5m+cache_write_1h) wr, sum(output_tokens) out
FROM llm_usage_logs WHERE created_at >= '<開始の ISO>' AND env LIKE 'local%'
GROUP BY 1,2,3,4 ORDER BY 1,2,3;
-- 漏れ（deepseek-all で Claude）
SELECT created_at, route, action, model FROM llm_usage_logs
WHERE created_at >= '<開始>' AND env = 'local:deepseek-all' AND model LIKE 'claude%' AND status BETWEEN 1 AND 399;
-- 止めた呼び出し
SELECT created_at, route, action FROM llm_usage_logs WHERE created_at >= '<開始>' AND error_type = 'test_blocked';
-- YUMA 以外（テストの env）
SELECT created_at, env, action, conversation_id FROM llm_usage_logs
WHERE created_at >= '<開始>' AND env LIKE 'local:%' AND conversation_id IS NOT NULL AND conversation_id <> 'dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7';
```
- 金額は `app/lib/llm-price.ts` の単価（Sonnet 5/5.5 は入力 $2・出力 $10・1h 書き ×2・読み ×0.1／DeepSeek は JST 10-13・15-19 の平日は倍）。
  実額はコンソール（platform.claude.com/cost）が正。DB は割合を見るのに使う（9/18 実測で DB が約25%高い）。
- **実行した回数と行の数が合わない時は記録の穴（＝経路が外れている）を疑う**（10/01 の aix_template 約27回・ブレイン 19回が記録0）。

## 8. 報告に必ず書くこと（費用の書き方）

```
テストの費用（llm_usage_logs・<開始>〜<終わり>）
- 試行錯誤（local:deepseek-all）: DeepSeek N回 $x.xx ／ Claude 0回（漏れ 0・止めた N回: 理由）
- 最後の確かめ（local:final-claude）: Claude N回 $x.xx（ブレイン n・判定 n・最終チェック n）＋ DeepSeek N回 $x.xx
- YUMA 以外の会話: 0 ／ 混ざり: N回（除外）／ 片付け: YUMA の行 N件を消した（id を控えて）
```
- Claude が 0 でない試行錯誤・記録の無い回・YUMA 以外の行があれば、隠さずに先頭に書く。

## 9. 片付けと共有のフォルダ

- **ワイルドカードで消さない**（10/01 `rm scripts/tmp-*.ts` で他の担当の tmp スクリプト約50本＋未追跡のファイルを消した。追跡済みは git checkout で戻した）。
  消すのは自分が作ったファイルだけ・名前を1つずつ並べて・消す前に `git status --short` を見る。
- YUMA の行は**自分が入れた行の id を控えて**その id だけ消す（`.in("id", ids)`）。時刻や送り手で範囲を消さない（他の実行の行を消す）。
- 一時の scripts は `scripts/_tmp-<自分の作業>-*.ts` のように名前で分け、終わったら名前を並べて消す。

## 9.5 LINE に実際に送る確かめ・人の文で出口を測る（2026-10-02）

- **LINE の実送信**は `scripts/yuma-real-line-send-test.ts`（写しの開発サーバ＋本番の `/api/send-line-message`）。試行錯誤（deepseek-all）は送らない。`--send` は `LLM_TEST_FINAL_CLAUDE=1` の時だけ通る。
  送る直前に毎回 DB から宛先を読み直す（id・名前「YUMA」・line_user_id が1会話だけ）。送った後に本番が YUMA に書く記録（sent_facts・calendar_events・line_tasks・sent_image_properties）は**自分の送信の line id・時刻の物だけ** id を並べて消す。
- **繰り返しの実送信（2026-10-02 竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって…自動で繰り返し続ける」）**: `scripts/yuma-replay-scenarios.ts --send`（本番の会話の場面・一連の流れ `--file=`・`--prefix=` で他の担当の場面と分ける）は**竹内さんの指示で deepseek-all の文も送る**（上の「最後だけ」の例外・送り先は YUMA だけ）。
  部品 `scripts/lib/yuma-line-send.ts`: 宛先を毎回読み直す・LINE の月の上限（quota を読むだけ。手元の .env.prod は LINE の鍵が空＝聞けない時は上限 5,000 と今月の送信で控えめに見積もる・送った後の残りが上限の30%・本番の見込みを下回るなら送らない・この道具の今月の送信 `scripts/.replay-out/yuma-sends-YYYY-MM.json` も足す）・1巡の上限 `--send-cap`（40 まで）。
  **送らない物**: スタッフの宣言（確認・見積書・ピックアップの約束＝本番の送信 API が YUMA でブレインを分析し直し AIX要対応を売上番長グループへ通知する）・スタッフの確認が要る AIX の仮の文（staff_confirm）・未置換。後片付けは自分の line id の sent_facts と、送信の本文で「済み」にされた YUMA の要対応（id で戻す）。
  ⚠ 再生の日付のずれ: 3週間前の場面は今日から見て内覧日が過去になる → 10/02 から `yuma-replay-scenarios.ts` が場面の文の日付を今日にずらす（`scripts/lib/scenario-date-shift.ts`・7日の倍数＝曜日はそのまま・`--no-date-shift` で止める）。「明日」等の言葉はずらさない。朝9時前に流すと「本日、管理会社の営業開始後に…」の指示が入る
- **送る文にテストの印・ラベルを入れない**（2026-10-02 竹内「テスト送信入っている。紛れないように」: 【テスト送信…】の通が YUMA の LINE に届いた）。送信 API（/api/send-line-message）と手元の送信の道具（yuma-line-send.ts・yuma-real-line-send-test.ts）は app/lib/outgoing-residue.ts でテストの印・JSON の名残を止める
- 出口（返信の本文を書き換える決定論）を足す・直す時は、**人の実送信で何通変わるか**を `scripts/audit-exits-vs-human.ts` で数える（LLM を呼ばない・入口不要）。前の出口を通った後の形で測る（出口の玉突きはこれでしか見えない）。設計知見「弱い部分の見つけ方と強化のしかた」。

## 9.6 場面の網羅（2026-10-02 竹内「テストの会話でaixの待ち合わせ場所で待ち合わせ決めるパターンがはいっていない。ほかにも抜けている会話あるからちゃんと色んなパターンでおこなう」）

- **巡を回す前に網羅の表を見る**: `npx tsx --env-file=.env.local scripts/yuma-coverage-matrix.ts`（AIX のボタン×ピッカー／場面を aix-pickers.ts から作り、場面のファイルが覆っているかを ○× で出す）。
  覆っていないマスがあれば `--keys-out=<file>` で本番の押下から場面の鍵を作り、`scripts/replay-scenarios-mine.ts --days=200 --per=1 --pick=<file> --pick-out=scripts/.replay-out/scen-covN.json` で場面にして流す。
- 待ち合わせまで行く一連の流れ: `replay-scenarios-mine.ts --flows=2 --flows-need=meeting_place --flows-max-turns=16`（他の AIX でも --flows-need=<aix>）。
- **本番で押された事が無いマス**（電話終了後・専任物件だった・日程変更 等）は場面を作れない＝作り話の場面は入れない（表に「本番で押下なし」と出る）。
- 掘った場面に申込以降・申込の書類・第三者の名前（紹介者 等）が残っていないかを読んでから流す（伏せ字は「〇〇」）。
- 報告に網羅の数（前→後）を書く。

## 10. 知られている落とし穴（2026-10-01 に起きた事）

| 起きた事 | 原因 | 今の歯止め |
|---|---|---|
| deepseek-all のつもりで Claude 46回（brain_fresh 33・extract_estimate 7・brain_fresh_claude 3・戦略/セーブデータ/全体 各1） | ①ブレインは切り替えの対象外だった（戦略・セーブデータ・取り直しは LLM_ALT_ACTIONS に書けず Claude）②スクリプトが時刻の線の印を置かずに呼ぶと「印なし」で黙って Claude（08:03 の brain_fresh 30回）③画像つきは黙って Claude | deepseek-all はブレインも全部 DeepSeek・YUMA の印なしは「全部渡してよい」・Claude に行く物は例外で止める |
| コンソールと DB の差 約$1.8（記録の無い Claude） | ①開発サーバの HMR で fetch の包みが外れ、付け直しの無い入口（aix-template-generate 約27回）が素の fetch で Claude ②スクリプトが包みを入れずに/包む前に brain-core を静的 import（07:50〜07:59 のブレイン 19回・Sonnet 5 で記録0）③`setTimeout(process.exit, 500)` で書き込みが落ちる事がある | instrumentation の見張りがその場で包み直す・共通の入口・`h.finish()` が書き込みを待つ・deepseek-all は偽の鍵 |
| 和樹さんの会話でテストの LLM 3回 | replay-brain-readonly が本番の会話 ID をそのまま流した | 出口で YUMA 以外を断る・replay は YUMA か --copy-to-yuma だけ |
| 記入済みの申込フォームが DeepSeek へ（2場面） | 場面を「申込へ押下の前」だけで切った | 書類の手前で切る・出口で個人の値を止める |
| ⑤の未来の時刻の行が⑦の3巡目に混ざった | 他の実行の行を「今より前」だけで見ていた | 未来の時刻の行も他人の物として数える・waitUntilYumaQuiet |
| 他の担当の tmp スクリプト約50本を消した | `rm scripts/tmp-*.ts` | ワイルドカード削除の禁止・名前を並べて消す |
| 最後の確かめが Sonnet 5（本番は 5.5） | .env.local に CLAUDE_SONNET_* が無い | final-claude の時は本番と同じ 5.5 を自動で入れる |

関連: 設計知見（タグ `汎用`＋`点検表`＋`API費用`＋`YUMA`）「テストのやり方は1枚の手順書と1つの入口に」／memory `feedback_test_generation_deepseek.md`／`reference_yuma_test_account.md`／`dept_line_reply.md`
