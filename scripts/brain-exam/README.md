# ブレインの試験 — API を節約して回す（2026-10-15）

竹内さん「テストの時 API 使いすぎてる。もっと質高く重点的に API も節約してテストを回す」。
手順そのもの（YUMA・同時1本・片付け）は今まで通り `memory/test_protocol_brain.md`。ここは**呼ぶ回数を減らす**4つの道具だけ。

| 道具 | 付け方 | 何が減るか |
|---|---|---|
| 前（main）の使い回し | `--baseline=main`（`main@<ref>` も可） | 「前」を毎回回さない。main の commit×構成ごとに問題単位で取り置き、無い問題だけ回す |
| LLM の録音と再生 | 録音は既定。`--replay`／`--replay=strict` | 要求（プロンプト）が同じ呼び出しは録った答えを返す＝呼ばない |
| 回す所を絞る | `--stage=brain`／`--stage=draft`／`--stage=auto` | 下書き（返信の生成＋最終チェック 約5回/問）を要る問題だけに |
| 数と費用 | 毎回の終わりに自動 | 新しく呼んだ・再生で済んだ・使い回した、の数と $ |

置き場（全部の作業ツリーで共有・.gitignore・伏せた会話と答案が入るので倉庫に上げない）:
`<倉庫の根>/.claude/exam-cache/llm-cassette/`（録音）・`.claude/exam-cache/brain-exam-baseline/<commit>-<構成>/`（前の取り置き）。`EXAM_CACHE_DIR` で変える。

## よく使う形

```bash
# 直した後の確かめ（前は main の取り置き・今は変わった所だけ呼ぶ）
REPLAY_FLOOR_FILE=scripts/.replay-out/brain-exam-floor-fix1.json LLM_TEST_MODE=deepseek-all \
  npx tsx --env-file=.env.local scripts/brain-exam.ts --label=fix1 --types=出し切り --baseline=main --replay --stage=brain

# 決まり・出口・材料の選び方だけの直し → API 0回で確かめる（要求が変わったら呼ばずに「どこが変わったか」を出す）
... scripts/brain-exam.ts --label=fix1-s --only=q001,q002 --baseline=main --replay=strict --stage=brain

# 計画だけ（何問を使い回し・何問を main で回すか）
... scripts/brain-exam.ts --label=x --types=出し切り --baseline=main --baseline-dry
```

- `--baseline=main`: "main" は origin/main を取り直し、手元の main の枝より先なら origin/main の commit を使う（手元の main は誰も進めない・10/15 に 158 commit 古かった）。前の取り置きに無い問題は `.claude/worktrees/brain-exam-main`（main の commit に合わせた作業ツリー・今の試験の道具を写す）で子として回してから、今の方を回す（同時1本）。
  構成（試験に効く環境変数 BRAIN_*/TWO_STAGE_*/SEARCH_*/LLM_TEST_MODE 等・層・台帳・stage・回数・判定の回数）か問題の中身が変われば別の取り置き。`--baseline-refresh` で回し直す。
  失敗した問題は取り置かない。`--baseline=<label>` は今まで通り（その label の結果と比べる）。
- `--replay`: 鍵は宛先＋名札＋本文（日時・UUID・時刻は伏せる）。録音が無い・本文が変わった呼び出しだけ本当に呼んで録る。
  `--repeat=3` の n 回目は n 番目の録音（足りなければ呼んで足す＝揺れは今まで通り測れる）。判定（DeepSeek）も同じく再生される。
  - 伏せる物を足す: `LLM_CASSETTE_MASK=<正規表現>,...`／伏せない: `LLM_CASSETTE_KEY=exact`／録らない: `--no-record`
  - 10/15: 読むだけの似た物探し（Supabase の RPC `match_*`＝RAG・手本・勝ちパターン・テンプレ）も録って返す。旧は RAG が DB の時間切れで空になる回と当たる回で
    ブレインの材料が変わり、同じコードの2回目でも再生が外れていた（q025・q153 で 2回目 8回中4回が新しい呼び出し → 直した後は 0回）。止める: `LLM_CASSETTE_RPC=off`
  - 外れた理由を調べる: `npx tsx scripts/audit-cassette-misses.ts --since=<時刻> --action=brain_full`（同じ問題・名札の録音の組で、本文の最初に違う所を出す）
  - strict で止まった問題の答案は失敗になる。出た「変わった所」が直した所（材料・指示）なら正しい → `--replay` で回す。直していない所が変わっていたら、毎回変わる物（伏せ漏れ）か混ざり。
- `--stage=auto`: 問題の `stage`（spec.json）→ `scripts/brain-exam/stage-by-type.json`（例 `{"約束": "draft", "*": "brain"}`）→ brain。`--draft` は `--stage=draft` と同じ。
- 数えは `results/<label>.cost.json` にも残る（問題ごと・名札ごと・変わった所）。前の取り置きはこれで「回していたら幾ら」を出す。
- 共通の入口（`scripts/lib/llm-test-harness.ts`）に入れたので、他のテスト（yuma-* 等）も `LLM_CASSETTE=record|replay|strict` で同じ録音・再生が使える。

## 追加の4つ（2026-10-15 夜・竹内さん「API 節約が最優先・質は落とさない」）

| 道具 | 付け方（止め方） | 何が減るか |
|---|---|---|
| ① 段の自動選び | `--stage=diff`（使わなければ今まで通り） | origin/main との分かれ目から変わったファイルを、試験が読むコードの線（import）で分ける。ブレインだけ → `brain`（下書き 約5回/問 を作らない）／下書きだけ・両方・試験の道具・設定・分からない → `draft`（安全側＝両方）／どこからも読まれない → `brain` の最小。決めた段と理由（ファイルごと）を最初に出す。main の子には決めた段を渡す |
| ② 比べる相手の版 | 既定で入る（`--baseline-key=commit` か `EXAM_BASELINE_KEY=commit` で旧の commit ごと） | 「前」の取り置きを main の commit ではなく**試験に効く所の中身の鍵**（ブレイン・下書き・試験の道具から辿れる app のファイルと設定の blob）で置く（`v-<鍵>-<構成>`）。main が進んでも試験に効く所が同じなら回さない・変わっていれば新しい main で回す（古い main の答案は使わない）。前回と比べて「main が進んだ・試験に効く所が同じ／変わった（app のファイル）」を出す。同じ commit の旧の置き場も読む |
| ③ 問題の共有 | 既定で入る（`EXAM_SHARED_PROBLEMS=off` で止める） | 問題を `.claude/exam-cache/brain-exam-problems/<id>/<正解の hash>.json` に1問1ファイルで共有（一時ファイル → rename・同時に書いても壊れない・.gitignore）。手元の problems.json が無い・正解が古い時は共有の物を使う（手元に無い問題は手元の problems.json が無い時か `--only` で名指しした時だけ足す＝回す問題は今まで通り）。`brain-exam-add.ts --rebuild` も共有にある問題は DB から作り直さない（`--fresh` で作り直す）。`--share` で手元の物を置くだけ |
| ④ 揺れる問題だけ繰り返す | `--repeat=3 --repeat-flaky`（`--majority --repeat-flaky`） | 揺れの記録（`.claude/exam-cache/brain-exam-flake/<id>/`）から: 同じコードで答えが割れた問題 → 3回／ずっと同じ答えの問題 → 1回（1回目がいつもと違えば3回まで足す）／分からない → 2回（割れたら3回）。毎回の答えを自動で記録（`EXAM_FLAKE_RECORD=off` で止める・録音の再生だけの回は安定の証拠に数えない）。旧の結果は `npx tsx scripts/brain-exam-flake.ts --import` で取り込む（`--show` で一覧） |
| ⑤ 写しの使い回し（DB の書き込みを減らす） | 10/28 から既定で入る（`--no-reuse-fixture` か `EXAM_REUSE_FIXTURE=off` で止める）・`--pc-skip-same`（`EXAM_PC_SKIP_SAME=on`・既定 off）・数だけ `--count-writes` | **同じ会話（YUMA2〜5）を使う他の担当の試験は、1問の繰り返し（--repeat の全部の回）が終わるまで待つ**（前は回の間に入れた）。同じ問題の繰り返しの間は通・台帳の写し・条件の行を消さずに次の回で使い回す（2層の問題は今回の発言の通だけ回ごとに書き直す・使い回す回は `scripts/lib/exam-clock.ts` で時計を1回目の写しの時まで戻す＝経過の分が変わらない）。10/28 実測（q048・q152・q125 ×3回）: 書いた行 1,056 → 556（通 120→66・台帳 900→430・条件の行 18→13）・q048／q152 は on でも全部の呼び出しが off の録音どおり（--replay=strict で止めた 0）。`--pc-skip-same` は毎回ブレインが要約を書き戻すので省けた 0 |

- 問題の hash から作った時刻（builtAt）を外した: 作業ツリーごとに problems.json を作り直すと中身が同じでも builtAt が違い、「前」の取り置きが作業ツリーをまたいで一度も使い回せていなかった（q150: 6つの作業ツリーで中身の hash は同じ・旧の hash は4通り）。旧の hash の取り置きも読む。
- 10/15 夜の取り込み（144問・deepseek-all）: 揺れる 39・道だけで安定 25・分からない 80 → `--repeat=3` の 432回 が初回 約300回、記録が溜まるほど減る。

## 調べで見つけた穴の歯止め（app/lib・本番では全部「何もしない」）

- **最後の Claude の1日の上限**: `LLM_TEST_FINAL_CLAUDE=1` の Claude の出口（開発サーバ /api/* もスクリプトも）で、今日（JST）の env=local:final-claude の Claude の行＋この process の分が上限に達したら止める。既定 60回・`LLM_TEST_FINAL_CLAUDE_DAILY_MAX=<回数|off>`。
- **最終チェックは選んだ物だけ Claude**: `LLM_TEST_FINAL_CHECK_CLAUDE=final_check_rule_check,final_check_verify` → それ以外の final_check_* は DeepSeek（`none`＝全部 DeepSeek・無い/`all`＝今までどおり）。ブレインと返信の本文は Claude のまま。
- **その日の合計**: 共通の入口の終わりに、final-claude なら今日の env=local:final-claude の合計（Claude／DeepSeek の回数・$・上限の残り）を出す（開発サーバの分も含む）。
- **入口を通らないテストは止める**: スクリプトの process で `setupLlmTest` を通らずに、テストの印（LLM_TEST_MODE／LLM_TEST_FINAL_CLAUDE）か YUMA・テスト専用の会話で LLM（Anthropic・DeepSeek・Jev・OpenAI 等）を呼ぶと止める（llm-usage-recorder を読んだ時に入る網）。単体テスト（__tests__）と `LLM_TEST_HARNESS_GUARD=off` は外す。

## 前後の見込み（10/13〜14 の llm_usage_logs の実測から）

| 試験 | 今まで（前＋今を毎回） | 新しい道具（2回目から） |
|---|---|---|
| 7問・ブレインまで（ab1014-s7: 前30回＋今28回 $0.41・判定 14回） | 約72回 $0.42 | 前 0（使い回し）＋今: 決まりだけの直し 0〜7回（判定のみ）／ブレインの指示の直し 約28回 $0.2 |
| 6問・下書きあり（ar1015 型: 1問 約7.5回 $0.035） | 約90回 $0.42 | 前 0＋今: 決まりだけ 0回／返信の指示の直し 約27回（返信と最終チェックだけ）。`--stage=brain` の問題は 1問 約4回 |
| 同じ直しを 3〜5回 回し直す（deepcheck: 5回 239回 $1.86） | 毎回 前＋今 | 前 1回分＋変わった所だけ |

初回（録音も取り置きも無い時）は今までと同じだけ呼ぶ。2回目から減る。

## RAG で選ぶ・並べ方・期限・設計知見との連動（2026-10-16）

竹内さん「試験の問題を DB にためて RAG 検索で選ぶ」「試験と設計知見（KB）をちゃんと連動させる」。LLM は呼ばない（埋め込みと KB の検索だけ・1回 $0.0001 未満）。

| 道具 | 付け方（止め方） | 何をする |
|---|---|---|
| 問題の札 | `scripts/exam-rag.ts --index`（`--select=rag` も無い札は自動で作る） | 問題ごとに 場面・言葉（伏せた物）・効く部品（段・入口のファイル・録音で見た名札）・正解（竹内さんの実送信・伏せた物）・関係する知見 id（埋め込みの近さの候補）を持つ。文が変わった問題だけ埋め直す（144問で 53,084トークン $0.001） |
| RAG で選ぶ | `--select=rag [--select-n=12] [--select-q="言葉"]`（付けなければ今まで通り） | 差分の言葉の近さの上位 N 問＋必ず入れる問題（下）。選んだ理由を1問ずつ出す。main の「前」も選んだ問題だけ |
| 並べ方 | 既定（`--order=as-is`・`EXAM_ORDER=as-is` で旧） | 段（ブレインだけ → 下書きまで）→ 録音で見た前置きの印 → 型。答えは問題 id で束ねて比べる＝順番で結果は変わらない |
| 判定の前置き | `--judge-prefix=rubric`（既定は旧の並び） | 判定の user を「正解の依頼・言ってはいけない事 → 場面 → 答案」に（文は変えない）。入れると判定の録音は1回取り直し |
| 比べる相手の期限 | 既定 7日（`--baseline-max-age=<日|off>`・`EXAM_BASELINE_MAX_AGE_DAYS`） | main の取り置きの savedAt が古ければ流し直す（DB の中身・モデル側の変化は鍵に入らない） |
| 知見の決まりの採点 | 既定 show（`--kb-rules=score` で下書きの合格に入れる・`off`） | 決まりで判定できる知見（駅の名前は確かめた出どころだけ 015f2950・相場は根拠がある時だけ d94a966c）の違反を知見の id と出す。足す口は `scripts/lib/exam-kb-rules.ts` の KB_RULES |
| 直して通った紐付け | `--link-kb=<知見 id|id8|title:題>`（または `exam-rag.ts --link --problem= --kb=`） | 全部の回で合格した問題をその知見に「固定」で結ぶ。まだ KB に無い題は控え、親の kb-insert の後の `--index` で id に解く |

必ず入れる問題（`--select=rag`）:
- 差分・`--select-q`・（`--select-range` の時は commit の文）に問題 id（q112 等）が書いてある
- 前に落ちた＝直前の2回は道が合っていたのに一番新しい答えで道が外れた（`EXAM_RAG_FAILED=last` で「一番新しい道が外れ」全部・`off` で入れない）。ずっと外れの問題（解けていない）は言葉が近ければ入る
- 新しい問題（揺れの記録が無い・足して7日以内）＝竹内さんの新しいお手本は `brain-exam-add.ts --add ... --tags=お手本` で足すと次の回に必ず入る（例: KAORI さん 10/12 21:01 の物件オススメ2通目）
- 入れた・変えた・退役した知見（前の控え kb-snapshot と比べる）に紐付く問題・紐付けの無い新しい知見に近い問題
- 差分の言葉で KB を引いて当たった知見に紐付く問題・当たった上位3件の知見に近い問題（0.45 以上・2問まで）

全部にする（安全側）: 試験の道具・設定・消した app のコードを直した／main との分かれ目が分からない／差分の埋め込みが取れない／埋め込みの無い問題が半分を超える。
下書きだけの変更はブレインだけの問題を選ばない。試験に効く変更が無ければ必ず入れる問題だけ。

落ちた・前より悪くなった問題には、結果に「関係する知見（固定 → 近さ順の上位3件・id・題・決めた事）」を出す（根本原因を探す入口）。

```bash
# 選び方だけ見る（試験は回さない）。過去の直しで試す: --select-range=<a>..<b>
npx tsx --env-file=.env.local scripts/exam-rag.ts --select [--select-range=07a14f43~1..07a14f43]
# 直した後の確かめ（選んだ問題だけ・前は main の取り置き）
... scripts/brain-exam.ts --label=fix1 --select=rag --baseline=main --replay --stage=diff --conv=YUMA4
# 通ったら知見に結ぶ（親が kb-insert した後に --index で解く）
npx tsx --env-file=.env.local scripts/exam-rag.ts --link --problem=q151 --kb=title:<題>
```

注意: RAG の選びは直しの途中の確かめ用。差分の言葉の近さは 0.45〜0.6 に固まりやすい（10/16 の試し: 07a14f43 の直しで q112 は近さの上位 40 に入らず、commit の文の名指しで入った）。
入れる前の最後の関所は今まで通り全部（または `--types=` の型ごと）で回す。直す人は `--select-q` か差分のコメントに対象の問題 id と場面の言葉を書く。

置き場: 表（`exam_problem_index`・`exam_problem_kb_links`・設計 `scripts/exam-rag-migration.sql`・竹内さんの OK まで作らない）があれば表、無ければ
`<倉庫の根>/.claude/exam-cache/brain-exam-rag/`（cards.json・kb-links.json・kb-snapshot.json・prefix.json・kb-links-pending.json）。表を作ると自動で表に切り替わる（`EXAM_RAG_STORE=local` で止める）。ただし `SUPABASE_SERVICE_ROLE_KEY` がある時だけ（表は RLS で方針なし＝anon の鍵では 0 行に見え書けない → 手元の置き場のまま）。表への書き込みが失敗しても試験は止めず手元の置き場に書く・`--select=rag` が失敗したら全部で回す。

## 引用返信を写す（2026-10-16）

旧の写し（ExamMsg）は引用が無く、引用返信の番（「こちらの物件気になります」）でブレインが「どれか未特定」と読んでいた（q156・本番は引用で1件に決まる）。
引用した通（`q`）・引用された通（`lm`）・こちらの画像の URL（`img`・こちらの画像だけ）を問題に持ち、YUMA に写す時に新しい id でつなぐ（台帳の sent_properties の image_url と照らして「引用返信→スタッフが送った物件資料〈物件名〉」が本番と同じく出る）。
引用の無い問題の中身は変わらない。引用のある古い問題に入れるには `brain-exam-add.ts --rebuild --only=<id> --fresh`（共有の置き場の同じ正解の物は上書きしないので、古いファイルを消してから）。

## 試験のブレイン（2026-10-17・設計知見 4c91ffd9「判断する所はブレインにまとめて、質を高く節約する」）

入口は1つ: `npx tsx --env-file=.env.local scripts/exam-brain.ts`（計画を先に出してから brain-exam.ts を子で回す・今の brain-exam.ts の引数は壊さない）。
決め方は `scripts/lib/exam-brain.ts`（純関数・単体テスト `scripts/lib/__tests__/exam-brain.test.ts`）、読み書きは `scripts/lib/exam-brain-io.ts`。

```bash
npx tsx --env-file=.env.local scripts/exam-brain.ts --plan --conv=YUMA4               # 計画だけ（選んだ問題と理由・段・回数・使い回し・見込み・いつ）
npx tsx --env-file=.env.local scripts/exam-brain.ts --conv=YUMA4 [--select-q="言葉 q112"] [--name=q153]   # 直した後の確かめ
npx tsx --env-file=.env.local scripts/exam-brain.ts --gate --conv=YUMA5 [--types=..] [--wait]          # 最後の関所（昼なら安い時間に予約）
npx tsx --env-file=.env.local scripts/exam-brain.ts --warm-main --conv=YUMA5                          # 本番に入れた版の答えを夜中に取り置く
npx tsx --env-file=.env.local scripts/exam-brain.ts --run-queue                                       # 予約を流す（JST 1:30〜9:30 だけ）
npx tsx --env-file=.env.local scripts/exam-brain.ts --warm-main --warm-plan --conv=YUMA4             # 10/22 取り置きの見込み（AI を呼ばない下見だけ・違う問題の数と $）
npx tsx scripts/exam-brain.ts --ledger [--id=q153]                                                   # 試験の台帳
npx tsx --env-file=.env.local scripts/exam-brain.ts --model-check --conv=YUMA4 [--types=..] [--n=8]   # flash と pro の比べ（型ごとに累計）
npx tsx --env-file=.env.local scripts/exam-brain.ts --cleanup --conv=YUMA2 --label=<止まった label> [--apply]  # 止まった実行の残り
```

| 決める事 | 決め方 |
|---|---|
| どの問題 | RAG の選び（直したファイル・差分の言葉・変えた知見・前に落ちた・新しい・名指し）＋必ず流す（`--name`・札「お手本」「竹内さんの番」・毎日の弱い所 weak-spots の知見に紐付く問題）。試験の道具・設定を直した／分からない時は全部 |
| 何回 | 直しの確かめは全部1回 → 1回目が前（main）と違った問題だけ3回まで足す（揺れか本当かを分ける・はっきり良い時は良くなった・悪くなった問題だけ）。最後の関所は揺れる問題だけ3回。brain-exam に `--reps-file` で渡す |
| どこまで | 1段目＝全部を stage=brain。2段目＝下書きに効くファイルを直した時は下書きの意味がある全部・それ以外は判断（道・合否・道の符号・turn_contract の形＝依頼ごとの route と aix・close_only・ack_form・気持ちを受けるか。自由文の欄は比べない）が前と変わった問題だけ。最後の関所は直した所が何でも下書きの意味がある全部（下書きはブレインの meta を丸ごと受け取る＝判断が同じでも変わり得る・2026-10-17 穴②） |
| いつ | `--when=auto`: 関所・見込み $1 以上は DeepSeek の安い時間（JST 1:30〜9:30・llm-price の混雑の外）に予約（`--wait` で待って流す） |
| 途中で止める | 最初の4問以上で前より悪い問題が3問（良くなった分を引く・揺れる問題は数えない）→ `EXAM_STOP_FILE` で次の問題の前に止める（片付けはいつも通り） |
| 使い回し | 問題ごとの鍵＝問題の hash・段・効くファイルの中身（ブレイン／下書きの入口から辿れる app と設定の blob）・試験の道具の中身・構成・モデル・紐付く知見の版・その段が読む DB の表の指紋（ai_reply_knowledge・ai_prompt_rules・ai_reply_examples・trigger_action_rules・ai_prompts・adaptation_improvement_rules・phrase_dictionary 等 19表の件数・最終の時刻・小さい表は中身の hash。試験の始めに1回読む・読めない表がある段は使い回さない。一覧は exam-brain-io.ts の DB_FINGERPRINT_TABLES・2026-10-17 穴③）。同じなら前の結果（7日まで）。置き場 `.claude/exam-cache/exam-brain/results/` |
| 採点 | 既定 `--judge=lazy`（道が外れ・本質の道も決まりで出る時は判定を呼ばない＝合否は同じ）。判定の並べ替え（rubric）は既定にしない（下の確かめ）。束ねる採点は入れていない（判定は1問回 約 $0.0005・費用の大半はブレイン） |
| モデル | 既定 pro。`--model=auto` は model-check で5回以上・道が同じ9割以上・合う数が pro 以上の型だけ flash（判定は pro のまま） |
| 台帳 | `.claude/exam-cache/exam-brain/ledger.jsonl`（問題×実行×版×前との比べ×揺れか本当か）＋揺れの記録 |
| 2段（10/17） | 直しの途中＝**小さな確かめ**（名指し→前に落ちた→直した所に近い順→お手本で5〜8問・繰り返し2回まで）。同じ版（効くファイル・道具・構成・DB の鍵）の小さな確かめが悪化なしで通ったら、同じ命令で**仕上げ**（今の選び全部）。関所・選びが8問以下は仕上げ。`--phase=small\|final\|off`（`EXAM_PHASE`・off＝旧）。記録 `.claude/exam-cache/exam-brain/phase-log.jsonl` |
| 1日の上限（10/17） | 今日（JST）の試験 env（env != production）の DeepSeek＋Claude（llm-price）＋この実行の見込みが `EXAM_DAILY_CAP_USD`（既定 10・off）を超えたら、守る線（名指し・前に落ちた・お手本・竹内さんの番）を今・残りは夜中の予約（JST 1:40 の SumoraExamNight の `--run-queue`）。守る線だけでも超える時は全部夜中（`--over-cap` で今）。夜中の実行は実行した日の分。`--warm-main` も数える |
| 2倍の時間（10/17） | 平日 JST 10〜13・15〜19 は計画に警告。仕上げ（関所でない・`--when=auto`）は夜中に回す。小さな確かめは今（急ぐ）。関所は今まで通り。見込みの値段は本当の値段（2倍の時間だけ高い） |
| 分け合う（10/17） | 置き場は全部の作業ツリーで共有・鍵にパスは入らない。会話: YUMA2〜5 は効く所（会話の行・条件の行の CONV_CTX_FIELDS・線で隠せない表の件数）が同じ＝鍵に足さない（別の会話の結果も使う）。違う会話（YUMA 本体）は会話の指紋を鍵に。`EXAM_REUSE_CONV=off`＝旧 |

確かめ（10/17）:
- 同じ3問（q112・q113・q129）を旧のやり方（--stage=draft・判定 全部）と試験のブレイン（2段・lazy・回数・判定の並び as-is）で: 1回目の道・合否・下書きは全部同じ。判定の並び rubric では q113 の下書きの合否が 2/3→0/3 に変わった＝並べ替えは判定の答えを変える（既定は as-is）。
- brain-exam の main の子は Windows で shell を通して回すのに引数を囲んでいなかった（置き場のパスの空白「竹内 悠馬」で --reps-file が切れた）→ 囲む。
- 録音の鍵は別クラウドへ振り替える前の要求＝DEEPSEEK_MODEL を替えても pro の答えを返していた（モデルの比べが全部「同じ」）→ 既定と違うモデルの時だけ鍵にモデルを足す。
- flash の比べ（8問・ブレインだけ）: 道が同じ 7/8・合否・本質の道は 3〜4問で違う → まだ flash にしない。flash のブレインは1回 約 $0.0023（pro 約 $0.009）。
- 揺れる問題は 150問中 66問（44%）→ 直しの確かめで最初から3回にすると今より高くなる＝前と違った時だけ足す。
- 1日の見込み（10/13〜16 の llm_usage_logs の試験 env を決まりで計算し直し）: 今 1日 $21 → 試験のブレイン（pro）約 $10〜14 → 型ごとの比べが通って直しの確かめを flash にできれば 約 $4。残りの大半は「別々の直しの確かめ」が1日 28〜63回あること。
- 材料の長さ: ブレイン1回 約44kトークンのうち前置き（キャッシュ・$0.022/M）が 約36k・毎回変わる所が 約8k（入力の費用の 65%）・出力 約1k（25%）。前置きを削っても1回 約 $0.0008 しか減らない／変わる所（会話・台帳）を削ると答えが変わる＝この回は削っていない。

## ブレインの自己点検（2026-10-18・竹内さん 10/16 OK「ブレイン同士で会話させて自己改善する輪」）

輪: 毎日拾うブレイン（`scripts/edited-turn-miner.ts`）→ 試験のブレイン（`scripts/exam-brain.ts`）→ **自己点検（`scripts/brain-self-review.ts`）＝なぜ外れたかを説明し、直しの案を出す** → 試験のブレインが確かめる。直しの案は自動で入れない（貯めて竹内さんに見せる）。決め方は `scripts/lib/brain-self-review.ts`（単体テスト `scripts/lib/__tests__/brain-self-review.test.ts`）。

| 事 | 形 |
|----|----|
| 回す | `npx tsx --env-file=.env.local scripts/brain-self-review.ts [--from=exam\|miner\|both] [--max=10]`（試験の台帳の落ちた問題・前より悪くなった問題＋毎日拾った弱い所） |
| 1回の答案から | `--label=dg1016-b [--ids=q157,q158] [--results=<dir\|file>]`（作業ツリーの `scripts/brain-exam/results` から探す） |
| 見るだけ | `--dry`（見込みと材料の大きさ）・`--show-packet=q158`（渡す材料＝伏せた物を手元に出す・LLM に出さない）・`--report`（今日の説明から一覧と朝の1行を作り直す） |
| 1つにまとめる物 | 問題と正解（竹内さんの実送信・伏せた物）・ブレインの最初の出力（turn_contract）・決まり・出口の後と trace・下書きと判定・材料（録音の brain_fresh と下書きの要求を、問題の言葉・ブレインの札（ack_form・rule:）・【…（材料）】の塊・下書きの指示の行（締め・足さない）で抜いた物）・関係する設計知見。全部に L 番号 |
| 説明の語 | どこで: 材料に無かった／材料にあったのに読めなかった／判断は合っていて下書きで崩れた／決まり・出口が上書きした／人しか知らない事（AIX の番）／採点・問題の側／分けられない。直し: 知識を足す／材料をつなぐ／決まりを変える／出口を直す／お手本を足す／竹内さんに聞く |
| 根拠 | L 番号＋その行からの引用。引用が行に無い説明は「根拠なし」（確かさは低） |
| 束ね | 直しの種類・外れの場所が同じで、原因の名前の芯（「の見落とし」等の語尾を外す）が近い物。数の多い順。竹内さんの決定が要る物は「竹内さんに聞く」に分ける |
| 置き場 | `.claude/exam-cache/self-review/<日付>/`（explanations.jsonl・proposals.json・report.md・morning-line.txt）・`self-review/latest.md`。表の設計は `scripts/brain-self-review-migration.sql`（まだ流さない） |
| 費用 | DeepSeek（試験の判定と同じ: v4-pro・温度0・推論なし・json）1件 約 $0.013〜0.024。1日の上限は試験のブレインと同じ（`EXAM_DAILY_CAP_USD`・既定 $10）＝ `readDailySpend` が `local-llm-spend.jsonl`（DB に書かない LLM の費用）も足す。平日 JST 10〜13・15〜19 は流さない（`--allow-peak`） |
| 個人情報 | maskExamText → maskForEmbedding → 部屋番号 の2重・申込の書類の印の行と alt-pii-gate の行は落とす・申込以降の会話（`loadDeepseekCutoff` の線の外＝今申込以降の会話）は出さない。止める: `BRAIN_SELF_REVIEW=off` |

## 試験のブレインの司令塔と読み手（2026-10-20・設計知見 ea215526・487b8921・98bca000・5be49dda・c0884407）

LINE のブレインと同じ組み方: 読み手（flash・短い仕事）→ 決まった形の表（外れの型・つなぎの線 L1〜L6・申込までの地図）→ 司令塔（pro・短い JSON）→ 決まった計算で上限に収める。
今の試験のブレイン（RAG の選び・使い回し・1日の上限・2倍の時間）はそのまま使い、司令塔はその上で「重点」を決める。決め方は `scripts/lib/exam-conductor.ts`（単体テスト `scripts/lib/__tests__/exam-conductor.test.ts`）、読み書き・LLM は `scripts/lib/exam-conductor-io.ts`。

```bash
# 司令塔の計画だけ（LLM は読み手 flash 1回＋司令塔 pro 1回＝約 $0.01。試験は流さない）
npx tsx --env-file=.env.local scripts/exam-brain.ts --conduct --conv=YUMA4 [--cap-usd=0.5] [--range=<a>..<b>] [--judge-tier]
# 計画どおり流す → 結果を外れの型で返す・前（main）と並べる・次の重点の候補（次の --conduct の材料）
npx tsx --env-file=.env.local scripts/exam-brain.ts --run-plan=<計画の label> --conv=YUMA4
# 外れの型の地図（既定は本番に入れた版 main の答案。--source=latest で作業の結果も）・試験の地図（覆いと空き）— どちらも LLM なし
npx tsx --env-file=.env.local scripts/exam-brain.ts --miss-map
npx tsx --env-file=.env.local scripts/exam-brain.ts --coverage [--json]
```

- 司令塔の材料: 直した中身（変えたファイルと段・コミットの文・設計知見の id・伏せ字の差分）／読み手の読み（効く所・外れの型・線・段・探す言葉＝RAG の言葉に足す）／外れの型の地図／前の結果の次の重点／候補（RAG の選び＋読み手の型・線に当たる今の外れ・最大40問）。
- 決まった計算で守る事: 候補に無い id は捨てる・回は1〜3・下書きは下書き可の問題だけ・flash は model-check で確かめた型だけ・名指しと前に落ちた問題は必ず入れる・上限（--cap-usd と1日の上限の残りの小さい方）に収める（見張りの回→重点の回→見張りを削る→守らない重点を削る）。
- お手本・竹内さんの番は強い候補として渡すが必ずは入れない（直しの途中の確かめ＝小さな確かめの代わり）。本番に入れる前の仕上げは今まで通り `--phase=final` か `--gate`。
- 判定の段（`EXAM_JUDGE_TIER=on`・既定 off）: 機械の照らし（AIX だけの依頼で答案に AIX が無い＝✕ 等）→ flash を並びを変えて2回 → 揃った項目は確定・割れた項目がある時だけ pro。構成の鍵に入る（前（main）の取り置きも段の判定で作り直し）ので、司令塔は勧めるだけ・使うのは `--judge-tier` の時。
- 個人情報: DeepSeek に送る本文は1行ずつ伏せ字（maskExamText）にし、個人の値（携帯・生年月日・メール・申込フォーム）が残る行は捨て、送る前に test-pii-guard の網（piiValueSignal・testPiiRefusal）。費用は local-llm-spend.jsonl に足す（1日の上限に数える）。
- 置き場: `<倉庫の根>/.claude/exam-cache/exam-brain/conductor/`（`<label>.plan.json`・`<label>.result.json`・`missmap-*.json`・`coverage-*.json`）。

## LINE のブレインの組み方に寄せた8つ（2026-10-20・設計知見 0ed6c13d「試験のブレインを最優先で改善する」）

読み手（flash）＋司令塔（pro）＋自信で深さを決める＋キャッシュの並び＋外れの理由を読む。決まった所は純関数（単体テスト `scripts/lib/__tests__/exam-brain-like-line.test.ts`）。

| # | 何を | 付け方（止め方） |
|---|---|---|
| COST① | main の答えは版ごとに1回。今の置き場に無い問題は、同じ構成の前の main の置き場から「その問題の段（ブレインだけ／下書きまで）に効くファイルの鍵」が今の main と同じ答えを持ち越す。`EXAM_AUTO_WARM=on` の時だけ、今の main の版の取り置きが無ければ夜中の `--run-queue` に `--warm-main` を自動で予約（同じ版は1回・`exam-brain/warm-log.json`・既定は入れない＝竹内さんの OK 待ち）。持ち越しの鍵は試験の道具が直接読む app も含む（鍵の版 sk2）。夜中は残りの額で回せる数だけ（`--baseline-limit`）回して続きは次の夜。結果に「使い回した・持ち越した・今 main で解いた・夜に回した」を出す | 持ち越しは既定で入る（止める `EXAM_BASELINE_CARRY=off`）。自動の取り置きは既定で入らない（入れる `EXAM_AUTO_WARM=on`）。昼に答えの無い問題を解かず夜に回す: `--main-missing=night`（`EXAM_MAIN_MISSING=night`） |
| COST② | 自信の気づき: 全部1回 → 2回目は自信が低い問題だけ（前（main）と違った／前が無くて外れた・揺れる）→ 3回目は1回目と2回目が割れた問題だけ（揃えば止める）。1回目が前と同じ答え＝前と2つ揃った＝自信が高いので、外れ・揺れる問題でも回さない。main の取り置きは揺れる問題だけ2回 | 既定（`--reps=wide`＝外れ・揺れる問題は前と同じでも2回目・4日の台帳で確かめの回が旧の約1.6倍になるので既定にしない／旧は `--reps=old`） |
| COST③ | `--model` の既定を auto に: model-check で道が pro と同じだった型（5回以上・9割以上・合う数が pro 以上。見張りで道が違えば型の回数にも足す）と、その問題だけで2回以上いつも同じだった問題は flash。その問題で道が違った問題・直しの的（名指し・前に落ちた・司令塔の fix）・最後の関所は pro。flash の「前」は flash の main で取り置く | 既定（旧は `--model=pro`）。model-check は問題ごと（byId）にも残す |
| COST④ | キャッシュの並び: 司令塔の材料は変わりにくい物（外れの型・線・単価・flash の型・前の外れの理由）を先・実行ごとに変わる物（直した中身・上限・候補）を後ろ。外れの理由の読み手は system 固定・user は「問題と正解 → 前の答案 → 今の答案」。判定に `--judge-prefix=stable`（場面 → 採点の決まり → 答案）。判定の入力のキャッシュの当たり・外れを cost.json と結果に出し、判定の費用を local-llm-spend.jsonl に足す（旧は1日の上限に入っていなかった） | 判定の並びの既定は旧のまま（as-is）。stable は測ってから |
| QUALITY⑤ | 外れの理由の読み手（flash・短い JSON）: 落ちた問題ごとに 道の取り違え／依頼の抜け／注記・材料に引っ張られた／言ってはいけない事／正解が揺れている／判定の誤り と1行の根拠。決まりで決まる物は呼ばない。結果に型ごとの数・保存 `conductor/<label>.reasons.json`・`reasons-latest.json` → 次の `--conduct` の材料（型の数・候補の理由） | 既定（`--no-reasons`／`EXAM_REASONS=off`・上限 `--reasons-max=10`） |
| QUALITY⑥ | 正解の食い違い: `npx tsx --env-file=.env.local scripts/exam-gold-check.ts`。場面の印（お客様の発言の種類×直前のこちらの送信の種類）・札・発言の近さで似た問題を集め、どちらの正解の道で答えても相手で外れる組を出す（相手の言ってはいけない道に当たる＝強い）。関係しそうな設計知見を並べて「竹内さんへの確認」の一覧に。外れの理由の読み手が「似た場面の正解」を手がかりに使う | 置き場 `exam-brain/gold-check/`（latest.json・<日付>.md）。正解は直さない |
| QUALITY⑦ | 本番の外れから問題の候補: `npx tsx --env-file=.env.local scripts/exam-question-candidates.ts [--days=2] [--max=20]`。見張りの道の外れ・edited-turn-miner の直された番（draft-diff-types は main に入ったら）を、個人情報の網・もう入っている番・重なりを外して並べる。spec.json には足さない | 置き場 `exam-brain/question-candidates/`（.md・.json・.add-batch.json＝読んで brain-exam-add.ts --add-batch） |
| NIGHT①（10/22） | 差分だけの取り置き: main の答えを作る時、回す問題を15問ずつ（`EXAM_BASELINE_CHUNK`）に分け、塊ごとに下見（AI を呼ばない・前の main の答えの控えで新しい main の入力を組む）→ 入力が全部の回で同じ問題はその答案を取り置く（0円）→ 違う問題だけ本当に回す。`--baseline-limit` は本当に回す数に当てる。塊の間で時間の予算（`--baseline-budget-min`・取り置きは `EXAM_WARM_BUDGET_MIN` 既定 90分）と main の進み（進んだら古い main の答えを作り続けない）を見る。`--warm-plan` で見込みだけ | 止める `EXAM_BASELINE_INCREMENTAL=off` |
| NIGHT⑤（10/22） | 予約は1本ずつ: 比べを先（作った順）→ 取り置きは最後に1本だけ（古い版・重なりの取り置きは理由を出して捨てる・夜の作業ツリーの今のコードで流す）。取り置きは予算で切って続きを予約し直す（30分おきの回で比べが先）。1回の上限 `EXAM_QUEUE_MAX_MIN`（既定 300分）・1本の上限 `EXAM_QUEUE_ITEM_MAX_MIN`（既定 240分・超えたら子の木ごと止める）。止まった実行の条件の行の控え（.brain-exam-…-pc-backup.json）は、持ち主の pid が止まっている／pid の無い古い形で `EXAM_STALE_LOCK_HOURS`（既定 6）時間より古く同じ label が動いていない時に `<名前>.stale-<JST の時刻>` へ寄せる（消さない・ログに1行） | scripts/lib/exam-night.ts |
| QUALITY②（10/22） | 場面の今: 曜日・週の言い方が無い問題はちょうど実行日へずらす（試験の時計と場面の日付が揃う＝q181 の「明日」）。ある問題は今まで通り7日の倍数 | 旧 `EXAM_DATE_SHIFT=week` |
| QUALITY⑧ | 見張りの釣り合い: 直す的ごとに今合っている周りの問題（同じ型 → 同じ段・同じ線 → 同じ段）を見張りの候補に足し、司令塔が付けなければ1つ足す（上限に入らなければ見張りから削る） | `--conduct` で既定 |

## AIX の文の段（2026-10-22・試験のブレインの穴「押した後の文を測る段が無い」）

ブレインの試験はボタンを選ぶ所まで。押した後の文（1通目＝AIX の本文・2通目／✨この会話に合った文）は測れていなかった（前は `yuma-r11-aix-text.ts --toggle` で竹内さんの2通目 22本を手で比べた）。
物差しは**竹内基準**（竹内さんが実際に送った AIX の通・`messages.staff_writer='takeuchi'`）。

| 段 | ファイル | 中身 |
|---|---|---|
| 問題 | `scripts/exam-aix-text-build.ts` | 本番の竹内さんの AIX の番（`audit-r9s2-aix-cases.ts --fixed`＋`audit-r11-aix-second-cases.ts`・書類の手前で切る・名前は YUMA・maskPII）→ 個人の値・書類・**審査の事情（本番は Claude に固定）**・お客様の名前の関所 → ボタン×ピッカーを散らして 30問。置き場 `.claude/exam-cache/aix-text-exam/questions.json`（倉庫に上げない） |
| 生成 | `scripts/exam-aix-text.ts` | 本番と同じ入口（`aix/action`・`aix-template-generate` の POST を同じプロセスで）。after() は空の箱＝試験の会話に行を残さない・LINE に送らない。`--switch=NAME=値` |
| 採点 | `scripts/lib/exam-aix-text.ts`（単体テスト `__tests__/exam-aix-text.test.ts`） | 決まった物差し: ①中身（竹内さんの文にあり入力にもある金額・号室・日付・時刻・物件名・訴求・ご査収・締め・呼びかけ）②作り事（入力に無い事実・物件名）③形（行の段の並び LCS）④近さ（dice）⑤スタッフだけが知る事（募集中・募集終了・退去予定・入居時期・内覧可否・割引・確認済み: 入力にあって竹内さんも書いた物の抜け／どこにも無い物の断定）。曖昧な時だけ LLM の判定（DeepSeek flash・伏せた2つの文だけ・`--judge=lazy`） |
| 節約 | 録音と再生＋入力の差 | 同じ要求は録った答え（`LLM_CASSETTE=replay` が既定）。main と同じコード×既定のスイッチの回は main の取り置き（`aix-text-exam/baseline/main-<commit>.json`）→ 後の回は main と同じ要求に main の答え（問題ごとに「入力が main と同じ」） |
| 上限 | | 1日 `EXAM_DAILY_CAP_USD`（この回の止める線は残りまで）・1回 `--budget`（既定 `EXAM_RUN_CAP_USD` と $5 の小さい方）・同時2本（`aix-text-exam/slots`）・空きメモリ 800MB |

```bash
npx tsx --env-file=.env.local scripts/exam-aix-text-build.ts [--since=2026-08-01] [--reuse-raw]      # 問題を作る（LLM なし）
npx tsx --env-file=.env.local scripts/exam-aix-text.ts --label=main                                 # main の基準（取り置きになる）
npx tsx --env-file=.env.local scripts/exam-aix-text.ts --label=fix1 [--switch=AIX_TAKEUCHI_FORM=off] # 直した後・スイッチの比べ（main と並べる）
npx tsx --env-file=.env.local scripts/exam-aix-text.ts --label=fix1 --plan                          # 下見（呼ばない・入力が main と違う問題を数える）
npx tsx --env-file=.env.local scripts/exam-brain.ts --aix-text -- --label=fix1 --buttons=見積書,待ち合わせ  # 試験のブレインから
```
- 絞る: `--only=<id>`・`--buttons=見積書,物件オススメ,物件確認した,ピックアップ,内覧日調整,待ち合わせ,申込へ`・`--kinds=aix,tpl,second`・会話 `--conv=YUMA2〜5`（既定 YUMA4・YUMA は申込以降＝✨の文が止まる）
- 結果: `aix-text-exam/results/<label>-<時刻>.json`（伏せた生成の文・点・抜け・作り事・入力の差）
- 竹内さんの文にあって入力に無い物（その場でスタッフが足した事実）は「作れない」に分けて点に入れない（unreachable）
- 採点し直し（物差しを直した時・LLM なし・$0）: `--rescore=baseline`／`--rescore=<結果の json>`。竹内さんが送った時の時（JST）に `TEST_CLOCK_JST_HOUR` をそろえる（時刻の挨拶）
- 既定の会話は YUMA4（YUMA は申込以降＝✨この会話に合った文が Claude に固定されて DeepSeek の試験で止まる）
- main の基準（2026-10-22・main 01e22e5・30問・DeepSeek）: 合格 13/30・平均 75.5点（待ち合わせ 4/4 92.8・見積書 3/5 81.2・物件確認した 3/5 73.6・内覧日調整 1/4 73.5・ピックアップ 1/5 73.0・物件オススメ 1/5 69.2・申込へ 0/2 57.5）。費用 約 $0.32（作り直し込み）
- 2026-10-23 試験の穴の直し（確かめる人）: ①内覧日調整・待ち合わせは本文・会話・正解・入力の日付を今日以降へずらす（7の倍数・「明日」「今日」がある問題はちょうど今日へ）。ずらした問題は録音の鍵で日付を伏せない（`LLM_CASSETTE_KEY=exact`＝前の日の答えを再生しない）。結果の行に `shiftDays`（採点し直しも同じだけずらす）
  ②申込へ（format）は本番どおり入口を呼ばず記入欄を組む（`buildApplicationFormat`・LLM なし）③【緊急連絡先欄】等の欄の見出しを物件名に数えない。直した後の main の基準: 合格 16/30・平均 78.6点（内覧日調整 2/4・申込へ 2/2）。内覧日調整は同じ入力でも回ごとに揺れる（b3215fa2 が 94点→27点）
