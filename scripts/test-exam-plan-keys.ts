// scripts/test-exam-plan-keys.ts — 試験の答案に残す欄の一覧（scripts/lib/exam-plan-keys.ts）のテスト（決定論・LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-exam-plan-keys.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLAN_KEYS, planOf } from "./lib/exam-plan-keys";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ROUTER = ["conductor_allocation", "check_order", "check_order_type", "conductor_brief", "judge_next"] as const;

t("統括の記録の5つの鍵が一覧にある・重複が無い", () => {
  for (const k of ROUTER) assert.ok((PLAN_KEYS as readonly string[]).includes(k), k);
  assert.equal(new Set(PLAN_KEYS).size, PLAN_KEYS.length);
});

t("答案に残る: meta に配分・型・指示書・次の行き先があれば planOf の結果（答案の brain）にそのまま入る", () => {
  const meta = {
    action: "property_send", reply_mode: "aix",
    conductor_allocation: { name: "T4_property_shared/d", parts: ["judge", "fetch", "deep"], est_usd: 0.193, max_usd: 0.241, from: "type", depth_from: "default" },
    check_order: { type: "T4_property_shared", cands: ["T4_property_shared"], why: "物件が届いた", scene: "property_share", cues: ["customerSentProperty"] },
    check_order_type: "T4_property_shared",
    conductor_brief: { notYet: ["customer_part"], doubts: [], sure: { level: "high", score: 0, cues: [], handoff: false } },
    judge_next: { dest: "viewing", held: false, quote: null },
    not_in_list: "x",
  };
  const b = planOf(meta);
  for (const k of ROUTER) assert.deepEqual(b[k], (meta as Record<string, unknown>)[k], k);
  assert.ok(!("not_in_list" in b));
  // 答案の行は JSON で保存される（brain-exam の results/<label>.jsonl）＝JSON にしても残る
  const row = JSON.parse(JSON.stringify({ id: "q1", brain: b })) as { brain: Record<string, unknown> };
  for (const k of ROUTER) assert.ok(row.brain[k] !== undefined, k);
});

t("既定 off（meta に欄が無い）の時は答案に何も足さない＝今と同じ", () => {
  const b = planOf({ action: null, reply_mode: "auto_reply", conductor_allocation: undefined, check_order: null, conductor_brief: "" });
  for (const k of ROUTER) assert.ok(!(k in b), k);
  assert.deepEqual(planOf(null), {});
});

t("brain-exam.ts は一覧を自分で持たず、この lib を読む（二重に持たない）", () => {
  const src = readFileSync(resolve(__dirname, "brain-exam.ts"), "utf8");
  assert.ok(!/const PLAN_KEYS\s*=/.test(src));
  assert.match(src, /from "\.\/lib\/exam-plan-keys"/);
});
console.log(`\n${n} 件 ok`);
