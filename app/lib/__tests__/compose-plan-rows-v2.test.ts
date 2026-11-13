// npx tsx app/lib/__tests__/compose-plan-rows-v2.test.ts
//   点検役の実例（line_watch_turns 12362・12562・12838・12196・12164・11865・12680・12348）を、名前と値を伏せた形で行ごとの正解にする
import assert from "node:assert/strict";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan } from "../compose-sentence-plan";
import { asksFactsOf } from "../compose-asks-facts";
import { buildPlanRowsV2, planRowsV2Note, planRowsV2Digest, composePlanRowsV2On, rowsPresence, subShareFor, rowsV2SubOn, rowsV2SubRoleOn, trustEmbedsShown, trustEmbedLogFields } from "../compose-plan-rows-v2";

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
console.log(`compose-plan-rows-v2: ${n} pass`);
