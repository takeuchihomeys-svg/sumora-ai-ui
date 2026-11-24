// scripts/check-writer-chars-leak.ts — v3-chars（長さの目安を数字で）が、その問題の正解の文（竹内さんの実送信）から字数を出していないかの確かめ（作業員L・2026-11-24・#670 の子）
//   録音（llm-cassette）にある書き手の要求から【⭐ 実際の返信例】の竹内さんの通を取り出し、問題の正解の文（problems.json の staffText）と比べる。
//   正解の文と同じ（近さ 0.9 以上）例が入っていれば「漏れ」＝その問題は目安の数字に正解の長さが入る（例の選び方の側の漏れ・v3 の前からある）。
//   出す物: 問題ごとの例の数・漏れの有無・目安の字数と正解の字数の比（数だけ・文は出さない）
// 実行: npx tsx scripts/check-writer-chars-leak.ts --labels=l-oaw-luna-note,l-oaw-v2-sol-med
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exampleRepliesOf, charsHintOf } from "../app/lib/provider-profile";
import { examCacheRoot } from "./lib/llm-cassette";
import { dice } from "./audit-provider-fit";

const argv = process.argv.slice(2);
const labels = (argv.find((a) => a.startsWith("--labels="))?.slice(9) ?? "").split(",").filter(Boolean);
const R = join("scripts", "brain-exam", "results");
const probs = new Map((JSON.parse(readFileSync(join("scripts", "brain-exam", "problems.json"), "utf8")) as Array<{ id: string; staffText?: string }>).map((p) => [p.id, p]));
const casDir = join(examCacheRoot(), "llm-cassette");
const len = (t: string) => String(t ?? "").replace(/\s/g, "").length;
let n = 0, leak = 0, noEx = 0;
const seen = new Set<string>();
for (const label of labels) {
  const f = join(R, `${label}.jsonl`);
  if (!existsSync(f)) continue;
  for (const r of readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; llmCalls?: Array<{ action: string | null; key: string }> })) {
    if (seen.has(r.id)) continue;
    const staff = probs.get(r.id)?.staffText ?? "";
    for (const c of r.llmCalls ?? []) {
      if (c.action) continue;
      const cf = join(casDir, c.key.slice(0, 2), `${c.key}.json`);
      if (!existsSync(cf)) continue;
      let body: { messages?: Array<{ role: string; content: unknown }>; stream?: boolean } = {};
      try { body = JSON.parse((JSON.parse(readFileSync(cf, "utf8")) as { normBody: string }).normBody); } catch { continue; }
      if (!body.stream) continue; // 書き手は1文字ずつの形
      const userText = (body.messages ?? []).filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
      const ex = exampleRepliesOf(userText);
      const hint = charsHintOf(userText);
      const sims = ex.map((e) => dice(e, staff));
      const leaked = sims.some((x) => x >= 0.9);
      const hintN = Number(/約(\d+)字/.exec(hint ?? "")?.[1] ?? NaN);
      n++; if (leaked) leak++; if (!ex.length) noEx++;
      seen.add(r.id);
      console.log(JSON.stringify({ id: r.id, examples: ex.length, maxSimToAnswer: +(Math.max(0, ...sims)).toFixed(2), leaked, hintChars: Number.isFinite(hintN) ? hintN : null, answerChars: len(staff) }));
      break;
    }
  }
}
console.log(JSON.stringify({ problems: n, leaked: leak, noExamples: noEx }));
