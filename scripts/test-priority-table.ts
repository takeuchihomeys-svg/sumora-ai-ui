// scripts/test-priority-table.ts — 場面×状態ごとの優先度の表（PRIORITY_TABLE 既定 off）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-priority-table.ts
// 実例5番（前＝今のブレインの下書き・後＝表の行。名前と物件名は伏せた）: 12548・12362・11865・12196・12643
import assert from "node:assert/strict";
import { PRIORITY_ROWS, PRIORITY_WHY, PRIORITY_WHY_TO_V2, priorityRowFor, priorityDigest, whyOrderLine, priorityTableOn, priorityCuesFromMeta, priorityTableRecord } from "../app/lib/priority-table";
import { PRIORITY_KINDS, DEPTH_KINDS } from "../app/lib/judge-basis-types";
import { CHECK_ORDER_TYPES } from "../app/lib/check-order";
import { ANSWER_SOURCES } from "../app/lib/brain-now-later";
import { PART_CERTAINTIES } from "../app/lib/ask-parts";
import { SEND_COMBO_ROWS } from "../app/lib/send-combo-table";
import { SUB_FIELDS, subValuesOf } from "../app/lib/decided-subfields";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const row = (type: string, cues = {}) => priorityRowFor(type, cues)!.row;

t("既定 off（shadow・on で有効）", () => {
  assert.equal(priorityTableOn({}), false);
  assert.equal(priorityTableOn({ PRIORITY_TABLE: "shadow" }), true);
  assert.equal(priorityTableOn({ PRIORITY_TABLE: "off" }), false);
});

t("どの行も6つの欄となぜの札を持ち、名前は1か所の語彙（Priority・BasisDepth・型 id・answer_source・certainty・SendCombo）", () => {
  const types = new Set(CHECK_ORDER_TYPES.map((x) => x.id));
  const combos = new Set(SEND_COMBO_ROWS.map((x) => x.combo));
  for (const r of PRIORITY_ROWS) {
    assert.ok(types.has(r.type), r.type);
    assert.ok((PRIORITY_KINDS as readonly string[]).includes(r.first.need), r.first.need);
    assert.ok((PRIORITY_WHY as readonly string[]).includes(r.first.why_tag), r.first.why_tag);
    assert.ok((DEPTH_KINDS as readonly string[]).includes(r.checks.depth));
    assert.ok((ANSWER_SOURCES as readonly string[]).includes(r.now_vs_later.answer_source), r.state);
    assert.ok(combos.has(r.combo), r.combo);
    assert.ok(r.first.why.length > 10 && r.order.main && r.checks.steps.length && r.ask_parts.length && r.tags.length && r.count, r.state);
    for (const p of r.ask_parts) {
      assert.ok((ANSWER_SOURCES as readonly string[]).includes(p.source) && (PART_CERTAINTIES as readonly string[]).includes(p.certainty), `${r.state} ${p.part}`);
      if (p.source === "staff_only") assert.ok(p.who, `${r.state} ${p.part} の who`);
    }
    // 確かめる段は道より前の段だけ（route・focus・aim・roles を持たない）
    for (const s of r.checks.steps) assert.ok(!["route", "focus", "aim", "roles"].includes(s), `${r.state} ${s}`);
  }
  // 同じ型の中で手がかりの無い（受けの）行は1つまで
  for (const ty of new Set(PRIORITY_ROWS.map((r) => r.type))) assert.ok(PRIORITY_ROWS.filter((r) => r.type === ty && !r.match).length <= 1, ty);
});

t("なぜの札 → 設計図の why_order（compose-plan-rows-v2 の V2WhyOrder）", () => {
  const V2 = new Set(["greet_first", "asked_order", "ease_first", "after_answer", "keep_last"]);
  for (const w of PRIORITY_WHY) assert.ok(V2.has(PRIORITY_WHY_TO_V2[w]), w);
  assert.equal(PRIORITY_WHY_TO_V2.worry_first, "ease_first");
});

// 実例5番: 前（今のブレインの下書きの形）と後（表の行）
t("12548（4つの問い）: 前＝入居日が先で、空き・色は確認の約束に倒れた／後＝物件の中身の問いが先・答えの出所で分け・白基調の別物件は AIX", () => {
  const before = { first: "入居日", deferredToPromise: ["白フローリング", "603以外の空室"] };
  const r = row("T2_question_fact", { multiAsks: true });
  assert.match(r.order.main, /空いている部屋・色/);
  assert.notEqual(before.first, "空いている部屋・色");
  assert.equal(r.ask_parts.find((p) => p.part.includes("空いている"))?.route, "reply");
  assert.equal(r.ask_parts.find((p) => p.part.includes("入居日"))?.source, "company_fact");
  assert.equal(r.combo, "reply_then_aix_quick");
  assert.equal(r.first.why_tag, "decider_first");
});

t("12362（抑えられる部屋）: 前＝202の答えだけ／後＝同じ通で他の号室は2番手以降・202も取られる可能性まで（不安が先）", () => {
  const r = row("T12_hooked_comparing_taken");
  assert.ok(r.order.subs.some((s) => /2番手/.test(s)) && r.order.subs.some((s) => /取られ|申込が入る/.test(s)));
  assert.equal(PRIORITY_WHY_TO_V2[r.first.why_tag], "ease_first");
});

t("11865（おとり物件か）: 前＝約束が先・答えが後／後＝答えが先・約束は後の通（reply_reply）", () => {
  const r = row("T2_question_fact", { askedAgain: true });
  assert.equal(r.first.need, "answer");
  assert.equal(r.combo, "reply_reply");
  assert.ok(r.order.deferred.some((d) => /ピックアップ/.test(d.what)));
});

t("12196（外す）: 前＝言っていない条件（白基調・リフォーム済み）を足した／後＝やらない事に入れる・受けが先", () => {
  const r = row("T1_conditions_first", { notHooked: true });
  assert.ok(r.avoid.no_touch.some((x) => /言っていない条件/.test(x)));
  assert.equal(r.first.why_tag, "receive_first");
  assert.equal(priorityRowFor("T1_conditions_first", {}), null, "外す手がかりが無い T1 は表に無い（決め打ちしない）");
});

t("12643（鍵交換）: 言える部分（必須か）を答え、外せるかは管理会社に確かめる約束（両にらみにしない）", () => {
  const r = row("T8_cost", { splitParts: true });
  assert.deepEqual(r.ask_parts.map((p) => p.route), ["reply", "promise"]);
  assert.equal(r.ask_parts[1].who, "mgmt");
});

t("手がかり: meta の check_order.cues・turn_contract.asks・our_send_uptake から（返信か AIX かは読まない）", () => {
  const c = priorityCuesFromMeta({
    check_order: { cues: ["hasQuestion", "customerSentProperty"] },
    turn_contract: { asks: [{ kind: "question", parts: [{ source: "material_value" }, { source: "staff_only" }] }, { kind: "question" }] },
    our_send_uptake: [{ kind: "asked_again" }, { hook: "not_hooked" }],
    reply_mode: "aix", action: "property_send",
  });
  assert.deepEqual([c.multiAsks, c.splitParts, c.askedAgain, c.notHooked, c.broughtUnchecked, c.hasQuestion], [true, true, true, true, true, true]);
});

t("弱い所 brain:aix-before-asks: 表は返信が先なのにブレインの最初の1通が AIX＝印 aix_before_asks（道は変えない）", () => {
  const base = { check_order_type: "T2_question_fact", turn_contract: { asks: [{ kind: "question" }, { kind: "question" }] } };
  const rec = priorityTableRecord({ ...base, reply_mode: "aix", action: "property_send", now_vs_later: { this_turn: "deliver", answer_source: "material_value" } })!;
  assert.ok(rec.conflicts.includes("aix_before_asks"));
  assert.ok(rec.conflicts.includes("this_turn:deliver>answer"));
  assert.equal(rec.hit, "state");
  // send_sequence で返信が先なら印は立たない（T11 の初回: 返信→数秒後に AIX）
  const ok = priorityTableRecord({ check_order_type: "T11_first_contact_hearing", reply_mode: "aix", action: "hearing", send_sequence: [{ slot: "reply", role: "answer" }, { slot: "aix", aix: "hearing", role: "form" }] })!;
  assert.deepEqual(ok.conflicts, []);
  // ブレインの優先順位の段の1番が AIX
  const p = priorityTableRecord({ ...base, priorities: [{ rank: 2, handling: "answer_now" }, { rank: 1, handling: "aix" }] })!;
  assert.ok(p.conflicts.includes("priority1_aix"));
  // 結果が手元の番に返信を先にした
  assert.ok(priorityTableRecord({ check_order_type: "T10_result_ready" })!.conflicts.includes("reply_before_result"));
});

t("記録の印・why_order・届き方の表の優先度の欄", () => {
  const r = row("T2_question_fact", { multiAsks: true });
  assert.equal(priorityDigest(r), "first=answer|why=decider_first|combo=reply_then_aix_quick|defer=1|depth=deep");
  assert.match(whyOrderLine(r) ?? "", /^先に: .*決め手の問いが先/);
  assert.equal(priorityRowFor("T99"), null);
  assert.equal(priorityDigest(null), null);
  const rec = priorityTableRecord({ check_order_type: "T8_cost", turn_contract: { asks: [{ kind: "question", parts: [{ source: "material_value" }, { source: "staff_only" }] }] } })!;
  assert.match(priorityDigest(rec) ?? "", /^first=answer\|why=now_part_first\|combo=promise_then_aix_later/);
  const sv = subValuesOf({ check_order: { priority: rec } });
  assert.equal(sv["priority.first"], "answer");
  assert.equal(sv["priority.why_order"], "asked_order");
  assert.equal(sv["priority.now"], "answer/material_value");
  assert.equal(sv["priority.combo"], "promise_then_aix_later");
  assert.equal(sv["priority.defer"], "1");
  assert.equal(sv["priority.avoid"], "1");
  assert.equal(subValuesOf({})["priority.first"], null);
  for (const k of ["first", "why", "why_order", "now", "defer", "combo", "avoid"]) assert.ok(SUB_FIELDS.some((x) => x.sub === `priority.${k}`), k);
});

t("行の id（row_id）: 全行で重ならない・空でない・型 id で始まる・記録に row_id が残る", () => {
  const ids = PRIORITY_ROWS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of PRIORITY_ROWS) assert.ok(r.id && r.id.startsWith(`${r.type}.`) && /^[A-Za-z0-9_.]+$/.test(r.id), r.id);
  assert.equal(priorityTableRecord({ check_order_type: "T8_cost", turn_contract: { asks: [{ kind: "question", parts: [{ source: "material_value" }, { source: "staff_only" }] }] } })!.row_id, "T8_cost.split_parts");
});

console.log(`全部 ${n} 件 ok`);
