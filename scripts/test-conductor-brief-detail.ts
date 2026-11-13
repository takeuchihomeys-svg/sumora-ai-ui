// scripts/test-conductor-brief-detail.ts — 統括の指示書を今日の名前で具体に（作業員16・2026-11-13・LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-conductor-brief-detail.ts [--print]
// 実例3番（点検役の 12548・12643・11865 の形。名前と物件名は伏せた）。前＝CHECK_ORDER_TABLE が off の本番の meta（型の id が無い）で 型・組・次の一手が「未」／後＝指示書の中で型を作り、優先度・出所・確かさ・取りに行く先まで埋まる
import assert from "node:assert/strict";
import { buildConductorBrief, conductorBriefDigest, briefForRole, briefSectionsForRole, BRIEF_SECTION_SUBS, BRIEF_NONE } from "../app/lib/conductor-brief";
import { SUB_FIELDS, SENTENCE_ROLES_FOR_SUB } from "../app/lib/decided-subfields";
import { BASIS_ROUTE_WORD_RE } from "../app/lib/brain-judge-basis";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const PRINT = process.argv.includes("--print");

// 12548: 1通に問い4つ（空き・色・入居日・事情）。本番の meta には check_order_type が無い（CHECK_ORDER_TABLE=off）
const m12548 = {
  reply_mode: "auto_reply", action: null,
  customer_questions: ["他に空いている部屋", "床の色", "入居日"],
  turn_contract: { asks: [
    { quote: "他に空いている部屋はありますか", kind: "question", basis: "judgement", route: "promise", answer: "管理会社に確認させて頂きます" },
    { quote: "床は白ですか", kind: "question", basis: "material", route: "reply", answer: "資料ではホワイト系のフローリングです" },
    { quote: "いつから入居できますか", kind: "question", basis: "company_fact", route: "reply", answer: "最短でお申込日から10日〜2週間程です" },
  ] },
  material_missing: ["他の号室の空き", "床の色"],
  judge_basis: { purpose: "answer", key_point: "この物件で良いかの確かめ" },
};
// 12643: 鍵交換は必須か／外せるか（1つの依頼に今言える部分と確認が要る部分）
const m12643 = {
  reply_mode: "auto_reply", action: null, check_order_scene: "cost",
  turn_contract: { asks: [{ quote: "鍵交換は必須ですか、外せますか", kind: "question", basis: "material", route: "reply", answer: "鍵交換は必須となっております。外せるかは管理会社に交渉させて頂きます",
    parts: [{ part: "必須か", source: "material_value", certainty: "assertable", route: "reply" }, { part: "外せるか", source: "staff_only", who: "mgmt", certainty: "needs_check", route: "promise" }] }] },
  turn_aims: { midAim: "外した額の御見積書" },
};
// 11865: こちらの送信（掲載終了）への問い返し「おとり物件ですか」。ブレインは AIX を先に出した形（弱い所 aix-before-asks）
const m11865 = {
  reply_mode: "aix", action: "property_send",
  customer_questions: ["おとり物件ということですか"],
  turn_contract: { asks: [{ quote: "おとり物件ということですか", kind: "question", basis: "company_fact", route: "reply", answer: "ポータルは掲載の更新に時差がございます" }, { quote: "掲載の物件も見たい", kind: "question", basis: "company_fact", route: "reply", answer: "お送り頂ければ確認致します" }] },
  our_send_uptake: [{ kind: "asked_again", part: "掲載終了の報告" }],
  now_vs_later: { this_turn: "deliver", answer_source: "company_fact", asked_now: ["おとりか"], our_open: null, ready_now: [] },
};

const old = (b: ReturnType<typeof buildConductorBrief>) => ({ type: b.type === BRIEF_NONE ? "未" : b.type.id, combine: b.combine === BRIEF_NONE ? "未" : b.combine.combo, next: b.next === BRIEF_NONE ? "未" : b.next.dest, facts: b.facts === BRIEF_NONE ? "未" : b.facts.map((f) => f.from) });

t("12548: 前＝型・組・次の一手が未（型の id が meta に無い）／後＝指示書の中で型 T2・優先度は決め手が先・出所と確かさ・取りに行く先（他の号室の空き＝スタッフだけ・床の色＝資料）", () => {
  const before = { type: "未", combine: "未", next: "未" };
  const b = buildConductorBrief(m12548);
  assert.ok(b.type !== BRIEF_NONE && b.type.id === "T2_question_fact" && b.type.from === "brief");
  assert.notDeepEqual(old(b).type, before.type);
  assert.ok(b.order && b.order !== BRIEF_NONE && b.order.first === "answer" && b.order.why_tag === "decider_first" && b.order.why_order === "asked_order");
  assert.ok(b.facts !== BRIEF_NONE && b.facts.some((f) => f.source === "material" && f.certainty === "assertable") && b.facts.some((f) => f.source === "company_fact"));
  assert.ok(b.split && b.split !== BRIEF_NONE && b.split.some((p) => p.check) && b.split.some((p) => p.now));
  assert.deepEqual(b.fetch, [{ label: "他の号室の空き", to: "staff" }, { label: "床の色", to: "property_doc" }]);
  assert.ok(b.combine !== BRIEF_NONE && b.combine.priority === "reply_then_aix_quick");
  if (PRINT) console.log(JSON.stringify({ before, after: b }, null, 1));
});

t("12643: 後＝依頼の部分（必須か＝資料で今言える／外せるか＝管理会社）・優先度は言える部分が先・中期は外した額の御見積書", () => {
  const b = buildConductorBrief(m12643);
  assert.ok(b.type !== BRIEF_NONE && b.type.id === "T8_cost");
  assert.ok(b.order && b.order !== BRIEF_NONE && b.order.why_tag === "now_part_first" && b.order.this_turn === "answer");
  assert.ok(b.split && b.split !== BRIEF_NONE && b.split[0].now === "必須か" && b.split[0].check === "外せるか", JSON.stringify(b.split));
  assert.equal(b.aim.mid, "外した額の御見積書");
  assert.ok(b.combine !== BRIEF_NONE && b.combine.priority === "promise_then_aix_later");
  if (PRINT) console.log(JSON.stringify(b, null, 1));
});

t("11865: 後＝優先度は疑問が先・ブレインは AIX が先＝ずれの印 aix_before_asks（道は変えない）・digest に w:doubt_first!aix_before_asks", () => {
  const b = buildConductorBrief(m11865);
  assert.ok(b.type !== BRIEF_NONE && b.type.id === "T2_question_fact");
  assert.ok(b.order && b.order !== BRIEF_NONE && b.order.why_tag === "doubt_first" && b.order.conflicts.includes("aix_before_asks") && b.order.conflicts.includes("this_turn:deliver>answer"));
  assert.match(conductorBriefDigest(b) ?? "", /\|w:doubt_first!aix_before_asks$/);
  assert.equal(m11865.reply_mode, "aix", "meta の道は変えない");
  if (PRINT) console.log(JSON.stringify(b, null, 1));
});

t("指示書の欄に返信か AIX かを決める言葉を入れない（事実の値・組の表の文・依頼の部分の文は照らす対象の外）", () => {
  for (const m of [m12548, m12643, m11865]) {
    const b = buildConductorBrief(m);
    const own = JSON.stringify({ ...b, facts: [], split: [], decided: [], combine: BRIEF_NONE, main: BRIEF_NONE, fetch: [], aim: { ...b.aim, mid: "" }, type: b.type === BRIEF_NONE ? b.type : { ...b.type, why: "" } });
    assert.ok(!BASIS_ROUTE_WORD_RE.test(own), own);
  }
});

t("役目ごとに要る欄だけ（decided-subfields の下の欄×役目の表から）・未の欄は渡さない", () => {
  const subs = new Set(SUB_FIELDS.map((x) => x.sub));
  for (const [k, list] of Object.entries(BRIEF_SECTION_SUBS)) for (const s of list) assert.ok(subs.has(s), `${k} ${s}`);
  for (const r of SENTENCE_ROLES_FOR_SUB) assert.ok(briefSectionsForRole(r).length, r);
  assert.ok(briefSectionsForRole("head").includes("order") && briefSectionsForRole("head").includes("main"));
  assert.ok(briefSectionsForRole("press").includes("facts") && briefSectionsForRole("press").includes("split"));
  assert.ok(!briefSectionsForRole("close").includes("facts"));
  const b = buildConductorBrief(m12643);
  const forPress = briefForRole(b, "press");
  assert.ok("split" in forPress && "order" in forPress && !("alloc" in forPress) && !("doubts" in forPress));
  assert.ok(!("open" in briefForRole(b, "head")), "未の欄（open）は渡さない");
});

console.log(`全部 ${n} 件 ok`);
