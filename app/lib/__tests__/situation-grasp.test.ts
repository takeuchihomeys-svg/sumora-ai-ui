// npx tsx app/lib/__tests__/situation-grasp.test.ts
// 2026-11-15 作業員L: 現状把握の物差し（持っていた／連携／土台／食い違い）と約束の完了の数え
import assert from "node:assert/strict";
import { graspOfTurn, openPromisesOf, tallyGrasp, graspLine } from "../../../scripts/lib/situation-grasp";
import { promiseCloseTally } from "../../../scripts/lib/promise-close";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const iso = (m: number) => new Date(Date.UTC(2026, 10, 10, 0, m)).toISOString();

t("約束: 同じ種類の済みが後に無ければ開いている・2日以内に重ねたら数える", () => {
  const facts = [
    { row: { kind: "confirmation_promised", status: "promised", sent_at: iso(0) } },
    { row: { kind: "confirmation_promised", status: "promised", sent_at: iso(30) } },
    { row: { kind: "pickup_declared", status: "promised", sent_at: iso(10) } },
    { row: { kind: "properties_sent", status: "done", sent_at: iso(20) } },
  ];
  const r = openPromisesOf(facts);
  assert.deepEqual(r.open.map((o) => o.kind).sort(), ["confirmation_promised", "confirmation_promised"]);
  assert.equal(r.doubled, 1);
});

const user = [
  "【すでに送付済みの物件（2件）】", "・Aマンション 101号室（<md>）", "・Bハイツ 202号室（<md>）",
  "【まだ果たしていないこちらの約束（材料）】確認（果たすのは AIX【物件確認した】）。", "【🤝 お客様との約束】・確認の約束（3時間前）",
  "【申込までの地図（決定論の位置・材料）】本線: 物件出し", "家賃 7万円以内・エリア 難波・間取り 1K",
  "[スタッフ <md> <hm>] 確認出来次第ご連絡させて頂きます😊！", "[顧客 <md> <hm>] ありがとうございます",
].join("\n");
const prob = {
  id: "q1", source: "竹内さんの番", conv: "c1",
  context: [{ s: "staff", t: "お客様、確認出来次第ご連絡させて頂きます😊！" }, { s: "customer", t: "来週から動けます。ありがとうございます" }],
  pc: { rent_max: 70000, desired_area: "難波、日本橋", floor_plan: "1K" },
  ledger: {
    // 2026-11-21: 会話の外の行は材料と同じく 物件名|号室 で1つに数える（同じ建物をお客様に送っていれば号室なしの共有は出さない）
    sent_properties: [{ row: { conversation_id: "c1", property_name: "Aハイツ" } }, { row: { conversation_id: "c1", property_name: "Bコート" } }, { row: { conversation_id: null, property_name: "Cビル" } }, { row: { conversation_id: null, property_name: "Cビル" } }, { row: { conversation_id: null, property_name: "Aハイツ" } }],
    estimate_records: [{ row: {} }], aix_usage_logs: [],
    sent_facts: [{ row: { kind: "confirmation_promised", status: "promised", sent_at: iso(0) } }],
  },
};
t("1つの番: 持っていた・連携の切れ（見積・会話の外の送付）・土台の穴（時の言葉）", () => {
  const g = graspOfTurn(prob as never, user);
  assert.equal(g.takeuchi, true);
  assert.equal(g.f.sent_props, "held");
  assert.equal(g.f.sent_outside, "link"); assert.match(String(g.detail.sent_outside), /共有のみ 1行/);
  assert.equal(g.f.sent_props_dated, "held");
  assert.equal(g.f.estimate, "link");
  assert.equal(g.f.open_promise, "held");
  assert.equal(g.f.promise_kind, "held");
  assert.equal(g.f.promise_due, "held");
  assert.equal(g.f.cond_rent, "held"); assert.equal(g.f.cond_area, "held"); assert.equal(g.f.cond_layout, "held");
  assert.equal(g.f.last_our, "held"); // 名前（お客様）を外して比べる
  assert.equal(g.f.route_map, "held");
  assert.equal(g.f.time_words, "base");
  assert.match(graspLine(tallyGrasp([g, g, g]), 3), /把握漏れの多い欄/);
});
t("約束の完了の数え: 時間の順で結ぶ・開いたまま・2日超・重ねた", () => {
  const now = Date.parse(iso(0)) + 5 * 86_400_000;
  const r = promiseCloseTally([
    { conversation_id: "c", kind: "estimate_declared", status: "promised", sent_at: iso(0) },
    { conversation_id: "c", kind: "estimate_sent", status: "done", sent_at: iso(60) },
    { conversation_id: "c", kind: "pickup_declared", status: "promised", sent_at: iso(0) },
    { conversation_id: "c", kind: "pickup_declared", status: "promised", sent_at: iso(100) },
  ], now);
  const e = r.find((x) => x.kind === "estimate_declared")!, p = r.find((x) => x.kind === "pickup_declared")!;
  assert.equal(e.done, 1); assert.equal(e.medianH, 1); assert.equal(e.within24h, 1);
  assert.equal(p.open, 2); assert.equal(p.openOver2d, 2); assert.equal(p.redo2d, 1);
});
console.log(`${n} tests ok`);
