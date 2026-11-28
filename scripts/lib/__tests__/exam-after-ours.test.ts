// npx tsx scripts/lib/__tests__/exam-after-ours.test.ts
// 台帳 #861（2026-11-28 作業員L）: 「こちらの通の後」の番の試験の作り。印 afterOurs の無い問題は1字も変えないことを、全部の問題の前後比べで示す（LLM・DB なし）
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sceneSliceOf, examContextText, examProdLayerOk, type CtxMsg } from "../exam-after-ours";

// 前の形（11/28 までの brain-exam-add の buildProblem 169〜173行・brain-exam の contextText と prodOk）をそのまま写した物
function oldSlice<T extends { sender: string }>(msgs: readonly T[]) {
  let end = msgs.length - 1; while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return "お客様の通が無い";
  let start = end; while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  return { ctx: msgs.slice(Math.max(0, start - 29), start), cust: msgs.slice(start, end + 1) };
}
function oldContextText(p: { customer: string; context: readonly CtxMsg[] }) {
  const lastStaff = [...p.context].reverse().filter((m) => m.s === "staff").slice(0, 2).reverse().map((m) => `${m.aix ? "【AIX】" : ""}${m.t}`.slice(0, 300));
  return `【お客様の今の発言（連投）】\n${p.customer}\n\n【直前のこちらの送信】\n${lastStaff.join("\n―\n") || "（なし＝初回）"}`;
}
const oldProdOk = (p: { context: readonly CtxMsg[] }, layer: string, burst: number) => layer === "prod" && burst > 0 && p.context.slice(0, burst).some((m) => m.s === "customer");
const burstOf = (ctx: readonly CtxMsg[]) => { let b = ctx.length; while (b - 1 >= 0 && ctx[b - 1].s === "customer") b--; return b; };

// 小さい形
const msgs = [{ sender: "staff", id: 1 }, { sender: "customer", id: 2 }, { sender: "customer", id: 3 }, { sender: "staff", id: 4 }, { sender: "staff", id: 5 }];
const a = sceneSliceOf(msgs, false) as { ctx: unknown[]; cust: unknown[]; tail: unknown[] };
assert.deepEqual(a, { ...(oldSlice(msgs) as object), tail: [] }, "印なしは前と同じ・tail は空");
const b = sceneSliceOf(msgs, true) as { ctx: Array<{ id: number }>; cust: Array<{ id: number }>; tail: Array<{ id: number }> };
assert.deepEqual(b.tail.map((m) => m.id), [4, 5], "印ありは最後のお客様の通の後のこちらの通を残す");
assert.equal(sceneSliceOf([{ sender: "staff" }, { sender: "customer" }], true), "こちらの通の後の番ではない（最後の通がお客様）");
assert.equal(sceneSliceOf([{ sender: "staff" }], false), "お客様の通が無い");
// 判定の文: 印ありは「今の発言は無い」
const silent = { customer: "よろしくお願いします", context: [{ s: "customer", t: "よろしくお願いします", ago: 3000 }, { s: "staff", t: "物件お送りします", ago: 2880 }] as CtxMsg[], afterOurs: true };
assert.match(examContextText(silent), /（無い＝こちらの通の後にお客様の返事が無い番・今はこちらの最後の通から約48時間後）/);
assert.equal(examProdLayerOk(silent, "prod", burstOf(silent.context)), false, "印ありは1層で流す");

// 全部の問題の前後比べ（手元の problems.json・場面と入力の比べだけ）
const file = "scripts/brain-exam/problems.json";
if (existsSync(file)) {
  const ps = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; customer: string; context: CtxMsg[]; afterOurs?: boolean }>;
  let n = 0;
  for (const p of ps) {
    if (p.afterOurs) continue;
    // ① 場面の切り出し: 問題の場面（伏せた通の並び）に前と今の切り出しを当てて同じ
    const ms = p.context.map((m, i) => ({ sender: m.s === "customer" ? "customer" : "staff", i }));
    const o = oldSlice(ms), nw = sceneSliceOf(ms, false);
    if (typeof o === "string") assert.equal(nw, o, `${p.id}: 切り出しの理由`);
    else { assert.ok(typeof nw !== "string"); assert.deepEqual(nw.ctx, o.ctx, `${p.id}: ctx`); assert.deepEqual(nw.cust, o.cust, `${p.id}: cust`); assert.equal(nw.tail.length, 0, `${p.id}: tail`); }
    // ② 判定役に渡す文が1字も同じ
    assert.equal(examContextText(p), oldContextText(p), `${p.id}: 判定の文`);
    // ③ 2層で流すかの決めが同じ（prod と prod でない層の両方）
    const bu = burstOf(p.context);
    for (const layer of ["prod", "fresh"]) assert.equal(examProdLayerOk(p, layer, bu), oldProdOk(p, layer, bu), `${p.id}: 2層の決め ${layer}`);
    n++;
  }
  assert.ok(n > 100, `問題を読めている（${n}）`);
  console.log(`  全部の問題の前後比べ: ${n}問・場面の切り出し／判定の文／2層の決め が全部同じ`);
} else console.log("  ⚠ problems.json が無い作業ツリー＝全部の問題の前後比べは飛ばした");
console.log("exam-after-ours ok");
