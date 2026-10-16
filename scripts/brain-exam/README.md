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
npx tsx scripts/exam-brain.ts --ledger [--id=q153]                                                   # 試験の台帳
npx tsx --env-file=.env.local scripts/exam-brain.ts --model-check --conv=YUMA4 [--types=..] [--n=8]   # flash と pro の比べ（型ごとに累計）
npx tsx --env-file=.env.local scripts/exam-brain.ts --cleanup --conv=YUMA2 --label=<止まった label> [--apply]  # 止まった実行の残り
```

| 決める事 | 決め方 |
|---|---|
| どの問題 | RAG の選び（直したファイル・差分の言葉・変えた知見・前に落ちた・新しい・名指し）＋必ず流す（`--name`・札「お手本」「竹内さんの番」・毎日の弱い所 weak-spots の知見に紐付く問題）。試験の道具・設定を直した／分からない時は全部 |
| 何回 | 直しの確かめは全部1回 → 1回目が前（main）と違った問題だけ3回まで足す（揺れか本当かを分ける・はっきり良い時は良くなった問題だけ）。最後の関所は揺れる問題だけ3回。brain-exam に `--reps-file` で渡す |
| どこまで | 1段目＝全部を stage=brain。2段目＝下書きに効くファイルを直した時は下書きの意味がある全部・それ以外は判断（道・合否・道の符号）が前と変わった問題だけ（関所も同じ） |
| いつ | `--when=auto`: 関所・見込み $1 以上は DeepSeek の安い時間（JST 1:30〜9:30・llm-price の混雑の外）に予約（`--wait` で待って流す） |
| 途中で止める | 最初の4問以上で前より悪い問題が3問（良くなった分を引く・揺れる問題は数えない）→ `EXAM_STOP_FILE` で次の問題の前に止める（片付けはいつも通り） |
| 使い回し | 問題ごとの鍵＝問題の hash・段・効くファイルの中身（ブレイン／下書きの入口から辿れる app と設定の blob）・試験の道具の中身・構成・モデル・紐付く知見の版。同じなら前の結果（7日まで）。置き場 `.claude/exam-cache/exam-brain/results/` |
| 採点 | 既定 `--judge=lazy`（道が外れ・本質の道も決まりで出る時は判定を呼ばない＝合否は同じ）。判定の並べ替え（rubric）は既定にしない（下の確かめ）。束ねる採点は入れていない（判定は1問回 約 $0.0005・費用の大半はブレイン） |
| モデル | 既定 pro。`--model=auto` は model-check で3問以上・道が同じ9割以上・合う数が pro 以上の型だけ flash（判定は pro のまま） |
| 台帳 | `.claude/exam-cache/exam-brain/ledger.jsonl`（問題×実行×版×前との比べ×揺れか本当か）＋揺れの記録 |

確かめ（10/17）:
- 同じ3問（q112・q113・q129）を旧のやり方（--stage=draft・判定 全部）と試験のブレイン（2段・lazy・回数・判定の並び as-is）で: 1回目の道・合否・下書きは全部同じ。判定の並び rubric では q113 の下書きの合否が 2/3→0/3 に変わった＝並べ替えは判定の答えを変える（既定は as-is）。
- brain-exam の main の子は Windows で shell を通して回すのに引数を囲んでいなかった（置き場のパスの空白「竹内 悠馬」で --reps-file が切れた）→ 囲む。
- 録音の鍵は別クラウドへ振り替える前の要求＝DEEPSEEK_MODEL を替えても pro の答えを返していた（モデルの比べが全部「同じ」）→ 既定と違うモデルの時だけ鍵にモデルを足す。
- flash の比べ（8問・ブレインだけ）: 道が同じ 7/8・合否・本質の道は 3〜4問で違う → まだ flash にしない。flash のブレインは1回 約 $0.0023（pro 約 $0.009）。
- 揺れる問題は 150問中 66問（44%）→ 直しの確かめで最初から3回にすると今より高くなる＝前と違った時だけ足す。
- 1日の見込み（10/13〜16 の llm_usage_logs の試験 env を決まりで計算し直し）: 今 1日 $21 → 試験のブレイン（pro）約 $10〜14 → 型ごとの比べが通って直しの確かめを flash にできれば 約 $4。残りの大半は「別々の直しの確かめ」が1日 28〜63回あること。
- 材料の長さ: ブレイン1回 約44kトークンのうち前置き（キャッシュ・$0.022/M）が 約36k・毎回変わる所が 約8k（入力の費用の 65%）・出力 約1k（25%）。前置きを削っても1回 約 $0.0008 しか減らない／変わる所（会話・台帳）を削ると答えが変わる＝この回は削っていない。
