// scripts/test-compose-decided.ts — 決めた事を書き手まで届ける配線（COMPOSE_DECIDED・既定 off）と届き方の表・下の欄の表のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-compose-decided.ts
import assert from "node:assert/strict";
import { composeDecidedOn, basisLabelOf, latentKindLine, LATENT_TO_FOCUS_SUB, FOCUS_SUB_VALUES, factCertaintyOf, askPartsOf } from "../app/lib/compose-decided";
import { LATENT_KINDS } from "../app/lib/compose-sentence-plan";
import { writerNoteOf, deliveryOfTurn, DELIVERY_FIELDS } from "./lib/delivery-table";
import { SUB_FIELDS, SENTENCE_ROLES_FOR_SUB, subsForRole, nearParts, subValuesOf, SUB_ROLE_TO_SENTENCE_ROLES } from "../app/lib/decided-subfields";
import { SENTENCE_ROLES } from "../app/lib/takeuchi-anatomy-roles";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const withEnv = (v: string | undefined, f: () => void) => { const p = process.env.COMPOSE_DECIDED; if (v === undefined) delete process.env.COMPOSE_DECIDED; else process.env.COMPOSE_DECIDED = v; try { f(); } finally { if (p === undefined) delete process.env.COMPOSE_DECIDED; else process.env.COMPOSE_DECIDED = p; } };

// 主の行が作れない番（問いも依頼も無い・気持ちと重点と近い番だけ）
const emptyPlanMeta = { conductor_focus: { focus: "relation", why: "お礼だけ" }, customer_mindset: { state: "迷い", anxiety: { target: "費用", direction: "前向き" } }, near_opinion: "似た番で竹内さんは新着の約束を添えた" };
const factMeta = { turn_contract: { asks: [{ quote: "初期費用はいくら", kind: "question", route: "reply", basis: "company_fact", answer: "仲介手数料0円です" }] } };

t("既定 off: 書き手への注記は今と同じ（出所・下の種類・近い番の行は出ない・空の番は空のまま）", () => withEnv(undefined, () => {
  assert.equal(composeDecidedOn(), false);
  assert.equal(writerNoteOf(emptyPlanMeta).compose, "");
  const w = writerNoteOf(factMeta).writer;
  assert.ok(w.includes("仲介手数料0円です") && !w.includes("［出所:"), w);
}));

t("on ①: 主の行が無い番でも、重点・気持ち・近い番の意見の行が書き手に出る", () => withEnv("on", () => {
  const c = writerNoteOf(emptyPlanMeta).compose;
  assert.match(c, /受け取ったブレインの読み/);
  assert.match(c, /統括の重点: relation＝お礼だけ/);
  assert.match(c, /近い番の意見（竹内さんの似た番）: 似た番で竹内さんは新着の約束を添えた/);
  const d = deliveryOfTurn(emptyPlanMeta);
  assert.equal(d.focus.writer, "ok");
}));

t("on ②: 本質の帯の依頼ごとの行に出所（会社の事実／資料の値／スタッフしか知らない）", () => withEnv("on", () => {
  assert.match(writerNoteOf(factMeta).writer, /仲介手数料0円です［出所: 会社の知識・言い切れる］/);
  assert.equal(basisLabelOf("material", "reply"), "資料の値");
  assert.equal(basisLabelOf(null, "promise"), "スタッフしか知らない");
  assert.equal(basisLabelOf(null, "reply"), null);
}));

t("on ③: 潜在の下の種類（作業員5 の ease の下の種類に読み替え）", () => withEnv("on", () => {
  assert.match(writerNoteOf(emptyPlanMeta).compose, /潜在の下の種類（ブレインの読み）: 費用（ease:cost）/);
  for (const k of Object.keys(LATENT_TO_FOCUS_SUB)) assert.ok((LATENT_KINDS as readonly string[]).includes(k), k);
  for (const v of Object.values(LATENT_TO_FOCUS_SUB)) if (v) assert.ok(FOCUS_SUB_VALUES.ease.includes(v), v);
  assert.equal(latentKindLine("審査"), "審査（ease:screening）");
  assert.equal(latentKindLine("先に取られる"), "先に取られる");
}));

t("届き方の表: 欄は統括役の頼みの物を全部持ち、静的の理由は a〜d だけ", () => {
  for (const k of ["focus", "promise", "asks", "fact_source", "our_side", "latent_feeling", "latent_kind", "hooked", "near", "aim"]) assert.ok(DELIVERY_FIELDS.some((f) => f.key === k), k);
  for (const f of DELIVERY_FIELDS) for (const v of Object.values(f.wiring)) assert.ok(v === true || ["a", "b", "c", "d"].includes(v), f.key);
});

t("下の欄の表: 役目は8つ・どの下の欄も役目が1つ以上・名前が重ならない", () => {
  assert.equal(SENTENCE_ROLES_FOR_SUB.length, 8);
  assert.equal(new Set(SUB_FIELDS.map((x) => x.sub)).size, SUB_FIELDS.length);
  for (const x of SUB_FIELDS) assert.ok(x.roles.length && x.from, x.sub);
  for (const r of SENTENCE_ROLES_FOR_SUB) assert.ok(subsForRole(r).length, r);
  // 作業員16 の5段と作業員5 の下の種類の名前
  for (const k of ["object", "concern", "reason", "expect", "feeling", "src"]) assert.ok(SUB_FIELDS.some((x) => x.sub === `latent.${k}`), k);
  assert.ok(SUB_FIELDS.some((x) => x.sub === "focus.sub" && /focus_sub/.test(x.from)));
});
t("欄の無かった3つ: 確かさ（79cf95c8 の基本的に・名前は作業員10 と同じ）・近い番のなぜ・申込までの残り", () => {
  assert.equal(factCertaintyOf({ basis: "company_fact", quote: "入居の何日前に申込できますか", answer: "ご入居日の30日前から" }), "basically");
  assert.equal(factCertaintyOf({ basis: "company_fact", quote: "手数料は", answer: "0円です" }), "assertable");
  assert.equal(factCertaintyOf({ basis: "material", answer: "2階" }), "assertable");
  assert.equal(factCertaintyOf({ route: "promise", answer: "確認させて頂きます" }), "needs_check");
  assert.equal(factCertaintyOf({ route: "promise" }, { checkResultReady: true }), "assertable");
  const line = "【入口の意見・近い竹内さんの番（11/07）】この番に近い竹内さんの過去の番 7件のうち 6件（86%）で、竹内さんの最初の一手は AIX【property_send】。一番近い番: 条件の言い直しの後";
  assert.deepEqual(nearParts(line), { type: "条件の言い直しの後", move: "AIX【property_send】", why: "近い番 7件中 6件（86%）が同じ一手" });
  assert.deepEqual(nearParts(null), { type: null, move: null, why: null });
  const v = subValuesOf({ conductor_brief_inputs: { info: { node: "viewing", cells: [{ key: "area", state: "known" }, { key: "viewing_date", state: "unknown" }] } } });
  assert.equal(v["aim.to_apply"], "viewing・残り1");
  for (const k of ["fact.certainty", "near.why", "aim.to_apply"]) assert.notEqual(SUB_FIELDS.find((x) => x.sub === k)!.now, "none", k);
  for (const k of ["our.checked", "hook.point", "fact.value", "fact.source", "fact.for_ask"]) assert.ok(subsForRole("press").includes(k), k);
});
t("役目の名前は作業員10 の SentenceRole（13種）に写せる・作業員10 の使う下の欄が全部その役目にある", () => {
  for (const rs of Object.values(SUB_ROLE_TO_SENTENCE_ROLES)) for (const r of rs) assert.ok((SENTENCE_ROLES as readonly string[]).includes(r), r);
  const W10: Record<string, string[]> = { head: ["our.sent", "our.open_promise"], press: ["fact.value", "fact.source", "fact.for_ask", "our.checked"], trust: ["our.checked", "our.open_promise", "near.type"],
    latent: ["latent.object", "latent.concern", "latent.reason", "latent.expect", "latent.feeling", "latent.src"], bridge: ["focus.kind", "focus.sub", "hook.degree", "hook.point", "aim.to_apply", "aim.plant"], close: ["hook.degree", "our.viewing", "aim.turn"] };
  for (const [r, subs] of Object.entries(W10)) for (const k of subs) assert.ok(subsForRole(r as never).includes(k), `${r} ${k}`);
});
t("実例 12643 の形: 「鍵交換は必須か」は今言える・「外せるか」は管理会社（確認が要る）＝聞かれた事ごとに出所と分け", () => {
  // 竹内さんは「必須です」と即答し「交渉します」と続けた。2つの依頼に分かれた時・1つの依頼の答えに混ざった時の両方
  const two = askPartsOf([
    { quote: "鍵交換は必須ですか", basis: "company_fact", route: "reply", answer: "鍵交換は必須となります。" },
    { quote: "外すことはできますか", basis: null, route: "promise", answer: "管理会社に交渉させて頂きます" },
  ]);
  assert.deepEqual(two.map((p) => [p.source, p.certainty, !!p.now, !!p.check]), [["company", "assertable", true, false], ["staff_only", "needs_check", false, true]]);
  const one = askPartsOf([{ quote: "鍵交換は必須ですか？外せますか？", basis: "company_fact", route: "reply", answer: "鍵交換は必須となります。外せるかは管理会社に交渉させて頂きます" }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].now, "鍵交換は必須となります。");
  assert.match(one[0].check ?? "", /管理会社に交渉させて頂きます/);
  withEnv("on", () => {
    const w = writerNoteOf({ turn_contract: { asks: [{ quote: "鍵交換は必須ですか？外せますか？", kind: "question", route: "reply", basis: "company_fact", answer: "鍵交換は必須となります。外せるかは管理会社に交渉させて頂きます" }] } }).writer;
    assert.match(w, /［出所: 会社の知識・言い切れる／今言える: 鍵交換は必須となります。／確認が要る: 外せるかは管理会社に交渉させて頂きます］/);
  });
  // 1通に聞かれた事が4つ（実例 12548 の形）＝依頼ごとに1つずつ
  const four = askPartsOf([1, 2, 3, 4].map((i) => ({ quote: `問い${i}`, basis: i % 2 ? "material" : "conversation", route: "reply", answer: "はい" })));
  assert.equal(four.length, 4);
  assert.deepEqual(four.map((p) => p.source), ["material", "conversation", "material", "conversation"]);
});
console.log(`\n${n} 件 ok`);
