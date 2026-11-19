// scripts/test-next-move-concrete.ts — 次の一手を番ごとの中身に（NEXT_MOVE_CONCRETE 既定 off・作業員16・LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-next-move-concrete.ts [--print]
// 実例3番（名前と物件名は伏せた）: 12643（外した額の御見積書・管理会社の確認の後）・11865（新着のピックアップ・後の通）・12562（来週の連絡を待つ）
import assert from "node:assert/strict";
import { concreteNextMove, concreteNextDigest, nextMoveConcreteOn } from "../app/lib/next-move-concrete";
import { priorityRowFor, PRIORITY_ROWS } from "../app/lib/priority-table";
import { buildConductorBrief, BRIEF_NONE, briefSectionsForRole } from "../app/lib/conductor-brief";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const PRINT = process.argv.includes("--print");
const WEEKDAY_14 = Date.parse("2026-11-12T05:00:00Z"); // 木 14時（JST）＝管理会社の営業時間
const WEEKDAY_19 = Date.parse("2026-11-12T10:00:00Z"); // 木 19時（JST）＝管理会社の営業時間外

t("既定 off", () => {
  assert.equal(nextMoveConcreteOn({}), false);
  assert.equal(nextMoveConcreteOn({ NEXT_MOVE_CONCRETE: "on" }), true);
});

t("12643: 前＝型の表の keep_send・新着／後＝AIX 見積書（外した額の御見積書）・いつ＝管理会社の確認出来次第（営業時間内）／営業時間外は明日一番に", () => {
  const before = { dest: "keep_send", offer: "new_arrival" };
  const row = priorityRowFor("T8_cost", { splitParts: true })!.row;
  const c = concreteNextMove({ meta: {}, row, combo: "reply_only", nowMs: WEEKDAY_14 });
  assert.equal(c.from, "deferred");
  assert.equal(c.steps.length, 1);
  assert.deepEqual([c.steps[0].route, c.steps[0].aix, c.steps[0].what, c.steps[0].item], ["aix", "estimate_sheet", "estimate", "外した額の御見積書"]);
  assert.equal(c.steps[0].when.word, "確認出来次第");
  assert.equal(c.steps[0].when.from, "mgmt_hours");
  assert.notEqual(c.steps[0].what, before.offer);
  const night = concreteNextMove({ meta: {}, row, nowMs: WEEKDAY_19 });
  assert.match(night.steps[0].when.word ?? "", /管理会社営業時間外.*明日一番に/);
  assert.equal(c.combo, "reply_only", "組の正は send_combo_table（渡された物）");
  assert.equal(c.comboRef, "promise_then_aix_later", "優先度の表の組は参考");
  if (PRINT) console.log(JSON.stringify({ before, after: c, night: night.steps[0].when }, null, 1));
});

t("11865: 後＝答えの後の別の通で新着の約束（返信）→ 新着で募集に出次第 AIX 物件を送る（2段の並び）", () => {
  const row = priorityRowFor("T2_question_fact", { askedAgain: true })!.row;
  const c = concreteNextMove({ meta: {}, row, nowMs: WEEKDAY_14 });
  assert.deepEqual(c.steps.map((s) => [s.route, s.aix]), [["reply", null], ["aix", "property_send"]]);
  assert.equal(c.steps[0].when.word, "答えの後の別の通");
  assert.equal(c.steps[1].when.word, "新着で募集に出次第");
  assert.equal(c.steps[1].item, "新着のピックアップ");
  assert.equal(concreteNextDigest(c), "deferred|reply@答えの後の別の通(priority_row)>aix:property_send@新着で募集に出次第(promise_deadline)");
  if (PRINT) console.log(JSON.stringify(c, null, 1));
});

t("12562: 後＝お客様が『来週ご連絡します』＝待つ番（AIX なし・押さない・いつ＝来週＝お客様の言葉）", () => {
  const meta = { turn_contract: { asks: [{ quote: "来週また連絡します", kind: "report", route: "reply" }] }, check_order: { cues: ["considering"] } };
  const c = concreteNextMove({ meta, row: null, nowMs: WEEKDAY_14 });
  assert.equal(c.from, "customer_wait");
  assert.deepEqual([c.steps[0].route, c.steps[0].aix, c.steps[0].what, c.steps[0].when.word, c.steps[0].when.from], ["reply", null, "wait_contact", "来週", "customer"]);
  if (PRINT) console.log(JSON.stringify(c, null, 1));
});

t("開いている約束は約束の順（確認の結果→見積→ピックアップ）・送れる候補・材料が無い時は型の表の受け（作らない）", () => {
  const c = concreteNextMove({ meta: { action_ledger: { facts: { pickupPromisedUnfulfilled: true, confirmationPromisedUnfulfilled: true, confirmationPromisedObject: "室内写真" } } }, nowMs: WEEKDAY_14 });
  assert.equal(c.from, "open_promise");
  assert.deepEqual(c.steps.map((s) => [s.aix, s.item]), [["property_check_result", "室内写真"], ["property_send", "約束したピックアップ"]]);
  assert.equal(concreteNextMove({ meta: { now_vs_later: { ready_now: ["送れる物件"] } } }).steps[0].aix, "property_send");
  const none = concreteNextMove({ meta: {}, typeDest: "keep_send" });
  assert.deepEqual([none.from, none.steps[0].what, none.steps[0].item], ["type_table", "none", "keep_send"]);
  // 時計が無い時は期日の言葉を作らない（行の材料の言葉だけ）
  const row = PRIORITY_ROWS.find((r) => r.id === "T8_cost.split_parts")!;
  assert.deepEqual([concreteNextMove({ meta: {}, row }).steps[0].when.word, concreteNextMove({ meta: {}, row }).steps[0].when.from], ["管理会社の答えの後", "priority_row"]);
});

t("統括の指示書: NEXT_MOVE_CONCRETE=on の時だけ next_concrete（off は欄が無い）・役目は bridge・close・aix2 へ", () => {
  const meta = { analyzed_msg_ts: "2026-11-12T05:00:00Z", check_order_type: "T8_cost", turn_contract: { asks: [{ quote: "鍵交換は必須ですか、外せますか", kind: "question", basis: "material", route: "reply", answer: "x", parts: [{ part: "必須か", source: "material_value", certainty: "assertable", route: "reply" }, { part: "外せるか", source: "staff_only", who: "mgmt", certainty: "needs_check", route: "promise" }] }] } };
  assert.equal("next_concrete" in buildConductorBrief(meta), false);
  const prev = process.env.NEXT_MOVE_CONCRETE; process.env.NEXT_MOVE_CONCRETE = "on";
  try {
    const b = buildConductorBrief(meta);
    assert.ok(b.next_concrete && b.next_concrete !== BRIEF_NONE && b.next_concrete.steps[0].aix === "estimate_sheet" && b.next_concrete.steps[0].when.word === "確認出来次第", JSON.stringify(b.next_concrete));
  } finally { if (prev === undefined) delete process.env.NEXT_MOVE_CONCRETE; else process.env.NEXT_MOVE_CONCRETE = prev; }
  for (const r of ["bridge", "close", "aix2"] as const) assert.ok(briefSectionsForRole(r).includes("next_concrete"), r);
});

console.log(`全部 ${n} 件 ok`);
