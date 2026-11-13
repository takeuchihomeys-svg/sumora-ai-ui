// npx tsx app/lib/__tests__/compose-plan-rows-v2.test.ts
//   点検役の実例（line_watch_turns 12362・12562・12838・12196・12164・11865・12680・12348）を、名前と値を伏せた形で行ごとの正解にする
import assert from "node:assert/strict";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan } from "../compose-sentence-plan";
import { asksFactsOf } from "../compose-asks-facts";
import { priorityTableRecord, PRIORITY_ROWS } from "../priority-table";
import { buildPlanRowsV2, planRowsV2Note, planRowsV2Digest, composePlanRowsV2On, rowsPresence, subShareFor, rowsV2SubOn, rowsV2SubRoleOn, priorityForRowsV2, trustEmbedsShown, trustEmbedLogFields } from "../compose-plan-rows-v2";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
function rows(meta: Record<string, unknown>, o: { scene: string; customerText: string; recentStaff?: Array<{ text: string; aix?: boolean }>; staffOnlyTurn?: boolean }) {
  const u = readTurnUnderstanding(meta), s7 = readSevenFields(meta);
  const plan = buildSentencePlan(u, s7, { scene: o.scene });
  return { plan, ...buildPlanRowsV2({ plan, s7, meta, scene: o.scene, customerText: o.customerText, facts: asksFactsOf(meta), closing: null, recentStaff: o.recentStaff ?? [], staffOnlyTurn: o.staffOnlyTurn }) };
}
const roleSeq = (r: ReturnType<typeof rows>) => r.rows.map((x) => `${x.role}.${x.sub}`);

t("12362 型（抑えられる部屋の問い）: 少なさの信頼の行が立つ・事実の値つき", () => {
  const meta = { turn_contract: { asks: [{ quote: "抑えられるのは送ってもらった間取りですか", kind: "question", route: "reply", answer: "抑えられるのは1LDKの202号室・他は申込が入っており2番手", basis: "material" }], lead_with: 0 } };
  const r = rows(meta, { scene: "apply", customerText: "抑えられるところは送ってもらった間取りですか？", recentStaff: [{ text: "🌟（物件）202", aix: true }] });
  const tr = r.rows.find((x) => x.role === "trust");
  assert.ok(tr, roleSeq(r).join(","));
  assert.equal(tr!.sub, "scarcity");
  assert.ok(tr!.uses.some((u) => u.field === "fact.value" && /2番手/.test(u.value)));
  assert.equal(r.rows.find((x) => x.role === "press")?.source, "material");
});
t("12562 型（検討して来週連絡）: 締めはお客様の言った時期を使う・最後", () => {
  const meta = { turn_contract: { asks: [{ quote: "検討して来週連絡します", kind: "report", route: "reply", answer: "ゆっくり検討してもらう", basis: "conversation" }], lead_with: 0 }, turn_read: { intent: "検討する・保留・相談" } };
  const r = rows(meta, { scene: "considering", customerText: "少し検討して来週ご連絡します", recentStaff: [{ text: "🌟（物件）101", aix: true }] });
  const last = r.rows[r.rows.length - 1];
  assert.equal(last.role, "close");
  assert.equal(last.sub, "their_timing");
  assert.deepEqual(last.uses, [{ field: "latent.expect", value: "来週" }]);
  assert.equal(r.rows[0].role, "head");
});
t("12348 型（スタッフしか知らない番）: 潜在の行を立てない", () => {
  const meta = { turn_contract: { asks: [{ quote: "空いてますか", kind: "question", route: "aix", answer: null, basis: "judgement", aix: "property_check" }], lead_with: 0 }, seven_read: { latent: { what: "埋まってしまう不安" } } };
  const r = rows(meta, { scene: "question", customerText: "このお部屋まだ空いてますか？", staffOnlyTurn: true });
  assert.ok(!r.rows.some((x) => x.role === "latent"));
  assert.ok(r.dropped.some((d) => d.role === "latent" && /staff_only_no_latent/.test(d.why)));
});
t("12196 型（条件の言い直し）: 前の条件を全部繰り返さない印", () => {
  const meta = { turn_contract: { asks: [{ quote: "この物件は外してください", kind: "request", route: "promise", answer: "家賃12万以内でピックアップしてお送りする", basis: "conversation", about: "search_condition" }], lead_with: 0 } };
  const r = rows(meta, { scene: "conditions", customerText: "この物件は外してください。家賃は12万以内で", recentStaff: [{ text: "西区周辺全域から家賃8万〜12万・1LDK・36㎡以上でピックアップしてお送りさせて頂きます", aix: false }] });
  assert.ok(r.rows.some((x) => x.stand.some((s) => s.startsWith("no_full_repeat"))), JSON.stringify(r.rows.map((x) => x.stand)));
});
t("11865 型（継続の約束）: 継続の約束は主の答えの後の最後", () => {
  const meta = { turn_contract: { asks: [{ quote: "他のサイトの物件は本当にあるのか", kind: "question", route: "reply", answer: "ポータルにはおとり物件がある場合がある", basis: "general" }], lead_with: 0 }, seven_read: { lead: "keep" } };
  const r = rows(meta, { scene: "question", customerText: "他のサイトに載ってる物件は本当にあるんですか？" });
  const pi = r.rows.findIndex((x) => x.role === "press"), ci = r.rows.findIndex((x) => x.role === "close");
  assert.ok(pi >= 0 && ci > pi, roleSeq(r).join(","));
  assert.equal(r.rows[pi].certainty, "basically");
});
t("竹内さんの並びの表・digest・既定 off", () => {
  assert.ok((rowsPresence("conditions", "keep")?.roles.get("close")?.share ?? 0) >= 0.9);
  const meta = { turn_contract: { asks: [{ quote: "q", kind: "question", route: "reply", answer: "a", basis: "material" }], lead_with: 0 } };
  const r = rows(meta, { scene: "question", customerText: "q？" });
  assert.match(planRowsV2Digest(r.rows), /^r2:press\.conclusion\|fact\.value\|material\|assertable\|asked_order\|/);
  assert.equal(composePlanRowsV2On({}), false);
  assert.equal(planRowsV2Note(r.rows, {}), "");
  assert.match(planRowsV2Note(r.rows, { COMPOSE_PLAN_ROWS_V2: "on" }), /^- 1文ずつの設計図/);
});
t("check_estimate（確認と見積の両方の約束）: 押さえ（確認の約束）とつなぎ（見積へ）の2行で受ける", () => {
  const meta = { turn_contract: { asks: [{ quote: "この物件まだ空いてますか？初期費用も知りたいです", kind: "question", route: "promise", answer: "募集状況を確認し、最大限割引の御見積書とあわせてお送りする", basis: "judgement" }], lead_with: 0 }, conductor_focus: { focus: "promise_make", focus_sub: "check_estimate" } };
  const r = rows(meta, { scene: "property_sent", customerText: "この物件まだ空いてますか？初期費用も知りたいです", recentStaff: [] });
  assert.ok(r.rows.some((x) => x.role === "press" && x.sub === "split_known_check" && x.certainty === "needs_check"), roleSeq(r).join(","));
  assert.ok(r.rows.some((x) => x.role === "bridge" && x.sub === "estimate"), roleSeq(r).join(","));
  // 下の役目の割合で立てるのを止めると（COMPOSE_ROWS_V2_SUB=off）focus_sub を読まない
  process.env.COMPOSE_ROWS_V2_SUB = "off";
  try { const r0 = rows(meta, { scene: "property_sent", customerText: "この物件まだ空いてますか？初期費用も知りたいです", recentStaff: [] }); assert.ok(!r0.rows.some((x) => x.stand.some((s) => s.startsWith("focus_sub")))); }
  finally { delete process.env.COMPOSE_ROWS_V2_SUB; }
});
t("下の役目の割合: 表から引ける・場面が3番未満なら * に落とす", () => {
  assert.equal(subShareFor("question", "answer", "press.answer"), 1);
  assert.equal(subShareFor(null, null, "press.answer"), null);
  assert.ok((subShareFor("no-such-scene", "answer", "close.fixed") ?? -1) >= 0);
  assert.equal(rowsV2SubOn({}), true);
  assert.equal(rowsV2SubOn({ COMPOSE_ROWS_V2_SUB: "off" }), false);
  // つなぎは既定で割合の線を当てない（当たり 17→13 に減る）・押さえと締めは当てる
  assert.equal(rowsV2SubRoleOn("bridge", {}), false);
  assert.equal(rowsV2SubRoleOn("bridge", { COMPOSE_ROWS_V2_SUB_BRIDGE: "on" }), true);
  assert.equal(rowsV2SubRoleOn("close", {}), true);
  assert.equal(rowsV2SubRoleOn("press", { COMPOSE_ROWS_V2_SUB: "off" }), false);
});
t("信頼の添えの印: 作業員9 の4つ目の段が数える名前・出たかは竹内さんの札付けと同じ物差し", () => {
  const rs = [{ role: "press", embeds: [{ kind: "effort", share: 0.5 }, { kind: "deadline", share: 0.45 }] }, { role: "bridge", embeds: [{ kind: "flexible", share: 0.4 }] }];
  const s = trustEmbedsShown("管理会社に確認させて頂きます。いつでもご都合の良い日をお知らせください", rs);
  assert.deepEqual(s.map((x) => [x.mark, x.shown]), [["trust_embed_effort", true], ["trust_embed_deadline", false], ["trust_embed_flexible", true]]);
  assert.deepEqual(trustEmbedLogFields(s), { embeds: 3, embeds_shown: 2, embeds_missing: ["trust_embed_deadline"] });
  assert.deepEqual(trustEmbedsShown("x", null), []);
  // 書き手への注記に添えが出る
  const row = { role: "press" as const, sub: "conclusion" as const, uses: [], source: "conversation" as const, certainty: "assertable" as const, how: null, why_order: "asked_order" as const, length: "normal" as const, stand: [], share: null, embeds: [{ kind: "effort" as const, share: 0.5 }] };
  assert.match(planRowsV2Note([row], { COMPOSE_PLAN_ROWS_V2: "on" }), /この文の中でこちらの手間を見せる/);
});
t("押さえの細分化 q112 型（探して送る約束）: 押さえを立てず締めの継続の約束で受ける", () => {
  const meta = { turn_contract: { asks: [{ quote: "お願いします！", kind: "feeling", route: "promise", answer: "条件でお部屋をピックアップしてお送りする", basis: "judgement" }], lead_with: 0 }, action: "property_send" };
  const r = rows(meta, { scene: "ack", customerText: "お願いします！" });
  assert.ok(!r.rows.some((x) => x.role === "press"), roleSeq(r).join(","));
  assert.equal(r.rows.find((x) => x.role === "close")?.sub, "keep_promise");
  assert.ok(r.dropped.some((d) => d.role === "press" && /探して送る/.test(d.why)));
});
t("押さえの細分化 q055 型（見積の約束）: 押さえを立てずつなぎの見積へで受ける", () => {
  const meta = { turn_contract: { asks: [{ quote: "（物件）気になります！", kind: "feeling", route: "promise", answer: "最大限割引の御見積書を作成しお送り", basis: "conversation" }], lead_with: 0 } };
  const r = rows(meta, { scene: "other", customerText: "ありがとうございます！（物件）気になります！" });
  assert.ok(!r.rows.some((x) => x.role === "press"), roleSeq(r).join(","));
  assert.ok(r.rows.some((x) => x.role === "bridge" && x.sub === "estimate"), roleSeq(r).join(","));
});
t("押さえの細分化 q141 型（報告だけの番）: 会話の事実しか無ければ答えの押さえを立てない・確認の約束はそのまま", () => {
  const meta = { turn_contract: { asks: [{ quote: "17時からお願いします！", kind: "report", route: "reply", answer: "本日17時で承知した旨", basis: "conversation" }, { quote: "行きたい場所決まったらまた言います", kind: "report", route: "none", answer: null, basis: "conversation" }], lead_with: 0 } };
  const r = rows(meta, { scene: "viewing", customerText: "17時からお願いします！\n行きたい場所決まったらまた言います！" });
  assert.ok(!r.rows.some((x) => x.role === "press"), roleSeq(r).join(","));
  // 質問の番は今まで通り押さえを立てる
  const q = rows({ turn_contract: { asks: [{ quote: "q", kind: "question", route: "reply", answer: "a", basis: "material" }], lead_with: 0 } }, { scene: "question", customerText: "q？" });
  assert.ok(q.rows.some((x) => x.role === "press"));
  // 確認の約束（check）は押さえのまま
  const c = rows({ turn_contract: { asks: [{ quote: "空いてますか", kind: "question", route: "promise", answer: "募集状況を確認させて頂きご連絡", basis: "judgement" }], lead_with: 0 } }, { scene: "question", customerText: "空いてますか？" });
  assert.ok(c.rows.some((x) => x.role === "press" && x.sub === "split_known_check"), roleSeq(c).join(","));
  // COMPOSE_ROWS_V2_SUB=off で前の立て方
  process.env.COMPOSE_ROWS_V2_SUB = "off";
  try { assert.ok(rows(meta, { scene: "viewing", customerText: "17時からお願いします！" }).rows.some((x) => x.role === "press")); } finally { delete process.env.COMPOSE_ROWS_V2_SUB; }
});
// ── 作業員16 の優先度の表（meta.check_order.priority）を主の行の why_order・並べ順・立てない条件に（11/13 統括役）──
const withPriority = (meta: Record<string, unknown>) => ({ ...meta, check_order: { priority: priorityTableRecord(meta) } });
t("12548（決め手が先）: 後に聞かれた物件の中身の問いが主の行で頭の次・触れない話題と繰り返さない条件は注記に", () => {
  const meta = withPriority({ check_order_type: "T2_question_fact", turn_contract: { asks: [
    { quote: "入居日はいつ頃になりますか", kind: "question", route: "reply", answer: "審査後2週間程度", basis: "company_fact" },
    { quote: "白っぽいお部屋は空いてますか", kind: "question", route: "reply", answer: "空いているのは201号室で白基調", basis: "material" },
  ], lead_with: 1 } });
  assert.equal((meta.check_order as { priority: { why_tag: string } }).priority.why_tag, "decider_first");
  const r = rows(meta, { scene: "question", customerText: "入居日はいつ頃になりますか？白っぽいお部屋は空いてますか？" });
  const ps = r.rows.filter((x) => x.role === "press");
  assert.ok(ps.length >= 1 && ps[0].uses.some((u) => /201/.test(u.value)), JSON.stringify(ps.map((x) => x.uses)));
  assert.ok(ps[0].stand.includes("主の文") && ps[0].stand.includes("priority:decider_first"), JSON.stringify(ps.map((x) => x.stand)));
  assert.equal(ps[0].why_order, "asked_order");
  assert.equal(r.rows[0].role === "head" ? r.rows[1] : r.rows[0], ps[0]);
  assert.match(planRowsV2Note(r.rows, { COMPOSE_PLAN_ROWS_V2: "on" }), /触れない: 聞かれていない募集状況以外の条件.*繰り返さない: 事情（異動）は受けを1回だけ/);
});
t("12362（不安が先）: 主の答えのすぐ後に少なさの信頼・聞かれていない内覧の日程は立てない", () => {
  const meta = withPriority({ check_order_type: "T12_hooked_comparing_taken", seven_read: { lead: "viewing" }, turn_contract: { asks: [{ quote: "抑えられるのは送ってもらった間取りですか", kind: "question", route: "reply", answer: "抑えられるのは1LDKの202号室・他は申込が入っており2番手", basis: "material" }], lead_with: 0 } });
  const r = rows(meta, { scene: "apply", customerText: "抑えられるところは送ってもらった間取りですか？", recentStaff: [{ text: "🌟（物件）202", aix: true }] });
  const seq = roleSeq(r);
  const pi = r.rows.findIndex((x) => x.role === "press" && x.stand.includes("主の文"));
  assert.equal(r.rows[pi].why_order, "ease_first", seq.join(","));
  assert.equal(r.rows[pi + 1]?.role, "trust", seq.join(","));
  assert.equal(r.rows[pi + 1]?.sub, "scarcity");
  assert.ok(!r.rows.some((x) => x.role === "bridge" && x.sub === "viewing"), seq.join(","));
  assert.ok(r.dropped.some((d) => d.role === "bridge" && /触れない話題/.test(d.why)));
  // 優先度の表を止めると内覧へのつなぎは今まで通り立つ
  process.env.COMPOSE_ROWS_V2_PRIORITY = "off";
  try { const r0 = rows(meta, { scene: "apply", customerText: "抑えられるところは送ってもらった間取りですか？", recentStaff: [{ text: "🌟（物件）202", aix: true }] }); assert.ok(!r0.dropped.some((d) => /触れない話題/.test(d.why))); }
  finally { delete process.env.COMPOSE_ROWS_V2_PRIORITY; }
});
t("11865（疑問が先・新着の約束は後の通）: 答えが主で先・継続の約束の締めはこの返信に立てない", () => {
  const base = { turn_contract: { asks: [{ quote: "他のサイトの物件は本当にあるのか", kind: "question", route: "reply", answer: "ポータルにはおとり物件がある場合がある", basis: "general" }], lead_with: 0 }, seven_read: { lead: "keep" } };
  const meta = withPriority({ ...base, check_order_type: "T2_question_fact", our_send_uptake: [{ kind: "asked_again" }] });
  assert.equal((meta.check_order as { priority: { why_tag: string } }).priority.why_tag, "doubt_first");
  const r = rows(meta, { scene: "question", customerText: "他のサイトに載ってる物件は本当にあるんですか？" });
  const seq = roleSeq(r);
  assert.ok(!r.rows.some((x) => x.role === "close" && x.sub === "keep_promise"), seq.join(","));
  const p0 = r.rows.find((x) => x.role !== "head");
  assert.equal(p0?.role, "press", seq.join(","));
  assert.ok(p0!.stand.includes("priority:doubt_first"));
  // 表が無い番（同じ材料）は継続の約束が最後に立つ（前のテスト 11865 型と同じ）
  assert.ok(rows(base, { scene: "question", customerText: "他のサイトに載ってる物件は本当にあるんですか？" }).rows.some((x) => x.role === "close" && x.sub === "keep_promise"));
});
t("優先度の表の行は row_id で引く・引けない時は注記に残す（静かに落とさない）", () => {
  const base = { check_order_type: "T12_hooked_comparing_taken", seven_read: { lead: "viewing" }, turn_contract: { asks: [{ quote: "抑えられるのは送ってもらった間取りですか", kind: "question", route: "reply", answer: "抑えられるのは1LDKの202号室・他は申込が入っており2番手", basis: "material" }], lead_with: 0 } };
  const rec = priorityTableRecord(base)!;
  // 表に無い row_id: 文字が合っていても引かない（id が正）・注記に「表の行が引けない」
  const bad = { ...base, check_order: { priority: { ...rec, row_id: "no_such_row" } } };
  assert.equal(priorityForRowsV2(bad)?.missing, "row_id=no_such_row");
  const r = rows(bad, { scene: "apply", customerText: "抑えられるところは送ってもらった間取りですか？" });
  assert.ok(r.dropped.some((d) => /表の行が引けない/.test(d.why)));
  assert.match(planRowsV2Note(r.rows, { COMPOSE_PLAN_ROWS_V2: "on" }), /優先度の表の行が引けない（row_id=no_such_row）/);
  // row_id の無い古い記録で state の文字が変わった: 引けない印
  const old = { ...base, check_order: { priority: { ...rec, row_id: undefined, state: "（文を直した）" } } };
  assert.equal(priorityForRowsV2(old)?.missing, "type=T12_hooked_comparing_taken");
  // 表の行に id がある時は row_id で引く
  const idOf = (PRIORITY_ROWS.find((x) => x.type === rec.type && x.state === rec.state) as { id?: string } | undefined)?.id;
  if (idOf) assert.equal(priorityForRowsV2({ check_order: { priority: { ...rec, row_id: idOf, state: "（文を直した）" } } })?.via, "row_id");
  else assert.equal(priorityForRowsV2({ check_order: { priority: rec } })?.via, "type_state");
});
console.log(`compose-plan-rows-v2: ${n} pass`);
