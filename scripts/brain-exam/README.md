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

- `--baseline=main`: 前の取り置きに無い問題は `.claude/worktrees/brain-exam-main`（main の commit に合わせた作業ツリー・今の試験の道具を写す）で子として回してから、今の方を回す（同時1本）。
  構成（試験に効く環境変数 BRAIN_*/TWO_STAGE_*/SEARCH_*/LLM_TEST_MODE 等・層・台帳・stage・回数・判定の回数）か問題の中身が変われば別の取り置き。`--baseline-refresh` で回し直す。
  失敗した問題は取り置かない。`--baseline=<label>` は今まで通り（その label の結果と比べる）。
- `--replay`: 鍵は宛先＋名札＋本文（日時・UUID・時刻は伏せる）。録音が無い・本文が変わった呼び出しだけ本当に呼んで録る。
  `--repeat=3` の n 回目は n 番目の録音（足りなければ呼んで足す＝揺れは今まで通り測れる）。判定（DeepSeek）も同じく再生される。
  - 伏せる物を足す: `LLM_CASSETTE_MASK=<正規表現>,...`／伏せない: `LLM_CASSETTE_KEY=exact`／録らない: `--no-record`
  - strict で止まった問題の答案は失敗になる。出た「変わった所」が直した所（材料・指示）なら正しい → `--replay` で回す。直していない所が変わっていたら、毎回変わる物（伏せ漏れ）か混ざり。
- `--stage=auto`: 問題の `stage`（spec.json）→ `scripts/brain-exam/stage-by-type.json`（例 `{"約束": "draft", "*": "brain"}`）→ brain。`--draft` は `--stage=draft` と同じ。
- 数えは `results/<label>.cost.json` にも残る（問題ごと・名札ごと・変わった所）。前の取り置きはこれで「回していたら幾ら」を出す。
- 共通の入口（`scripts/lib/llm-test-harness.ts`）に入れたので、他のテスト（yuma-* 等）も `LLM_CASSETTE=record|replay|strict` で同じ録音・再生が使える。

## 前後の見込み（10/13〜14 の llm_usage_logs の実測から）

| 試験 | 今まで（前＋今を毎回） | 新しい道具（2回目から） |
|---|---|---|
| 7問・ブレインまで（ab1014-s7: 前30回＋今28回 $0.41・判定 14回） | 約72回 $0.42 | 前 0（使い回し）＋今: 決まりだけの直し 0〜7回（判定のみ）／ブレインの指示の直し 約28回 $0.2 |
| 6問・下書きあり（ar1015 型: 1問 約7.5回 $0.035） | 約90回 $0.42 | 前 0＋今: 決まりだけ 0回／返信の指示の直し 約27回（返信と最終チェックだけ）。`--stage=brain` の問題は 1問 約4回 |
| 同じ直しを 3〜5回 回し直す（deepcheck: 5回 239回 $1.86） | 毎回 前＋今 | 前 1回分＋変わった所だけ |

初回（録音も取り置きも無い時）は今までと同じだけ呼ぶ。2回目から減る。
