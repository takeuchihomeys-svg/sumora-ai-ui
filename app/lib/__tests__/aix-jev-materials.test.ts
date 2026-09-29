// 2026-09-29 竹内「材料は渡す・答えは渡さない」— AIX 用の Jev の材料（aix-jev-materials）と、材料がある時の質問のテスト
// 実行: npx tsx app/lib/__tests__/aix-jev-materials.test.ts
import { buildAixJevMaterials, SUMMARY_FIELDS_WITHHELD, SUMMARY_FIELDS_FOR_JEV } from "../aix-jev-materials";
import {
  buildJevState, buildAixJevQuestions, buildPickerQuestion, evaluateAixWithJev, evaluatePickerWithJev,
  JEV_AIX_OPTIONS, JEV_AIX_OPTIONS_WITH_MATERIALS, AIX_PICKER_CATALOG, PICKER_OPTIONS_WITH_MATERIALS, JEV_MATERIALS_HINT,
} from "../aix-jev";
import { buildActionLedger } from "../action-ledger";
import { emptyCustomerState } from "../customer-state";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}

const NOW = Date.parse("2026-09-29T06:00:00Z");
const mask = (s: string) => s.replace(/山田花子|山田/g, "〇〇");
const customer = {
  desired_area: "大阪市西区 山田さんの職場の近く", area_mode: "ward", floor_plan: "1K", rent_max: 70000, rent_min: null,
  floor_area_min: 23, walk_minutes: 10, commute_station: "梅田", commute_minutes: 30, move_in_time: "11月初旬", pet: false,
  initial_cost_limit: 150000, building_age: 10, preferences: "独立洗面台", ng_points: "1階不可", other_requests: "オートロック",
  ai_summary_json: {
    situation: "山田花子さんは見積書を待っている", requirements: ["家賃7万以下", "西区"], opinions: ["慎重"], emotion: "不安", urgency: "今月中",
    next_action: "御見積書を送る", winning_pattern: "即日で見積", purchase_signal_level: "peak", personality_profile: "慎重派",
  },
};
const ledger = buildActionLedger({
  messages: [
    { sender: "staff", text: "オススメのお部屋ピックアップしてお送りさせて頂きます！！", createdAt: "2026-09-28T01:00:00Z" },
    { sender: "customer", text: "お願いします", createdAt: "2026-09-28T02:00:00Z" },
  ],
  now: NOW,
});
const state = {
  ...emptyCustomerState("proposing"), stage: "proposing" as const, stageLabel: "提案中",
  focusKey: "k1",
  properties: [{
    key: "k1", name: "エストレーラ 305号室", building: "エストレーラ", room: "305", status: "estimate_sent" as const, statusLabel: "見積済",
    vacating: false, estimateSent: true, customerInterest: true, sentByUs: true, firstAt: "2026-09-27T00:00:00Z", lastAt: "2026-09-29T03:00:00Z", events: [], maybeSameAs: [],
  }],
};

console.log("── ★ 材料: 渡す物が入り、ブレインの結論は入らない");
{
  const m = buildAixJevMaterials({
    now: NOW, customer, state, ledger: ledger.facts, mask,
    recentAix: [
      { aix_type: "estimate_sheet", check_pattern: null, created_at: "2026-09-29T05:00:00Z", sent_at: "2026-09-29T05:00:00Z" },
      { aix_type: "property_send", created_at: "2026-09-29T04:00:00Z", sent_at: null },   // 送っていない → 入れない
      { aix_type: "property_check_result", check_pattern: "interior_photo", created_at: "2026-09-28T04:00:00Z", sent_at: "2026-09-28T04:00:00Z" },
      { aix_type: "property_send", created_at: "2026-09-27T04:00:00Z", sent_at: "2026-09-27T04:00:00Z" },
      { aix_type: "condition_hearing", created_at: "2026-09-26T04:00:00Z", sent_at: "2026-09-26T04:00:00Z" },
    ],
    latestCustomerText: "今回だけ家賃8万まで上げた場合の物件も見たいです",
  });
  t("★ 何か材料があれば null でない", m !== null);
  const json = JSON.stringify(m);
  for (const k of SUMMARY_FIELDS_WITHHELD) t(`★ 要約の結論の欄「${k}」は入らない`, !json.includes(`"${k}"`) && !json.includes(String((customer.ai_summary_json as Record<string, unknown>)[k])), m?.customer_summary);
  t("★ 要約の材料の欄（状況・希望・こだわり・温度感・時期感）は入る", SUMMARY_FIELDS_FOR_JEV.every((k) => m?.customer_summary && k in m.customer_summary), m?.customer_summary);
  t("★ 名前は伏せる（要約・条件の文とも mask を通る）", !json.includes("山田") && json.includes("〇〇"), json.slice(0, 300));
  const rc = m?.registered_conditions as Record<string, unknown>;
  t("★ 登録の条件: 家賃の上限は万で（「家賃を上げて」の元の上限が分かる）", rc?.rent_max === "7万", rc);
  t("★ 登録の条件: NG・通勤の到達時間・初期費用の上限・築年数", rc?.ng === "1階不可" && rc?.commute === "梅田まで30分以内" && rc?.initial_cost_max === "15万" && rc?.building_age_max === "10年以内", rc);
  t("★ 段階と主のお部屋（状態・見積済・こちらが送った）", (m?.stage as Record<string, unknown>)?.stage === "提案中" && ((m?.stage as Record<string, { status: string; estimate_sent: boolean }>)?.focus_room?.status === "見積済"), m?.stage);
  t("★ 台帳: 送った物件の数・見積書・約束の未実行", typeof (m?.records as Record<string, unknown>)?.properties_sent === "number" && Array.isArray((m?.records as Record<string, unknown>)?.promised_not_done), m?.records);
  t("★ 直近の AIX: 送った物だけ・3件まで・新しい順・ピッカーも", m?.recent_aix?.length === 3 && m.recent_aix[0].aix === "estimate_sheet" && m.recent_aix[1].check_pattern === "interior_photo" && m.recent_aix.every((r) => r.aix !== "condition_hearing"), m?.recent_aix);
  t("★ 直近の AIX の時刻は「どれだけ前か」", m?.recent_aix?.[0].when === "60分前" || m?.recent_aix?.[0].when === "1時間前", m?.recent_aix?.[0]);
  t("★ 今回だけの語（condition-change-scope の決定論）", !!m?.condition_scope_cue?.temporary && m.condition_scope_cue.permanent === null, m?.condition_scope_cue);
  t("★ ブレインの答えの名前（suggested・action・send_mode・scope）が入らない", !/suggested|"action"|send_mode|condition_change_scope|reply_mode|current_phase/.test(json), json.slice(0, 300));
}

console.log("── ★ 材料が無い時は null（state は今までと同じ）");
{
  t("★ 何も無ければ null", buildAixJevMaterials({ mask }) === null);
  const s0 = buildJevState({ messages: [{ sender: "customer", text: "x" }] });
  t("★ 材料なしの state に customer_materials は無い", !("customer_materials" in s0));
  const m = buildAixJevMaterials({ mask, customer: { rent_max: 80000 } });
  const s1 = buildJevState({ messages: [{ sender: "customer", text: "x" }], materials: m });
  t("★ 材料ありの state に customer_materials が入る", (s1.customer_materials as { registered_conditions: { rent_max: string } }).registered_conditions.rent_max === "8万", s1);
  t("★ 空の要約・空の条件の欄は入れない", !("customer_summary" in (m ?? {})) && Object.keys((m?.registered_conditions ?? {})).length === 1, m);
  const cue = buildAixJevMaterials({ mask, latestCustomerText: "やっぱり西区で探してます" });
  t("★ 切り替えの語", !!cue?.condition_scope_cue?.permanent && cue.condition_scope_cue.temporary === null, cue);
}

console.log("── ★ 質問: 材料がある時だけ材料の読み方と説明の差し替え（選択肢は増やさない）");
{
  const q0 = buildAixJevQuestions();
  const q1 = buildAixJevQuestions({ withMaterials: true });
  t("★ 材料なしは今までの文・今までの説明", q0.next_aix.type === "choice" && !q0.next_aix.instructions.includes("customer_materials") && q0.next_aix.criteria === JEV_AIX_OPTIONS);
  t("★ 材料ありは読み方の一文が付く", q1.next_aix.type === "choice" && q1.next_aix.instructions.includes(JEV_MATERIALS_HINT));
  t("★ 材料ありの選択肢のキーは同じ（増減なし）", JSON.stringify(Object.keys(JEV_AIX_OPTIONS_WITH_MATERIALS).sort()) === JSON.stringify(Object.keys(JEV_AIX_OPTIONS).sort()));
  t("★ 待ち合わせは直近の内覧日調整を、初期費用についてはは見積書の後を名指し", /viewing_invite/.test(JEV_AIX_OPTIONS_WITH_MATERIALS.meeting_place) && /estimate_sent/.test(JEV_AIX_OPTIONS_WITH_MATERIALS.cost_breakdown));
  for (const [btn, over] of Object.entries(PICKER_OPTIONS_WITH_MATERIALS)) {
    t(`★ ピッカーの差し替え（${btn}）は元の選択肢のキーの中だけ`, Object.keys(over).every((k) => k in AIX_PICKER_CATALOG[btn].options) && Object.keys(over).length === Object.keys(AIX_PICKER_CATALOG[btn].options).length);
  }
  const p0 = buildPickerQuestion("property_send")!;
  const p1 = buildPickerQuestion("property_send", { withMaterials: true })!;
  t("★ ピッカー: 材料なしは今までの説明", p0.type === "choice" && p0.criteria === AIX_PICKER_CATALOG.property_send.options);
  t("★ ピッカー: 材料ありは送った数を名指し（新規＝0・新着＝1件以上）", p1.type === "choice" && /properties_sent が 0/.test(p1.criteria.normal) && /1件以上/.test(p1.criteria.new_arrival) && p1.instructions.includes(JEV_MATERIALS_HINT));
  const pc1 = buildPickerQuestion("property_check_result", { withMaterials: true })!;
  t("★ 差し替えの無いボタンは説明はそのまま・読み方の一文だけ", pc1.type === "choice" && pc1.criteria === AIX_PICKER_CATALOG.property_check_result.options && pc1.instructions.includes(JEV_MATERIALS_HINT));
}

console.log("── ★ 呼び出し: 材料は state に・質問は材料ありの形で届く");
(async () => {
  const bodies: Array<{ state: Record<string, unknown>; questions: Record<string, { instructions: string; criteria: Record<string, string> }> }> = [];
  const fakeFetch = (async (_u: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const qs = Object.keys(bodies[bodies.length - 1].questions ?? {});
    const answers: Record<string, unknown> = {};
    for (const q of qs) answers[q] = q === "photo_request" ? { type: "noul", noul: 0.1 } : q === "picker" ? { type: "choice", choice: "new_arrival", probabilities: { new_arrival: 0.9 } } : { type: "choice", choice: q === "next_aix" ? "property_send" : "none", probabilities: {} };
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const materials = buildAixJevMaterials({ mask, customer: { rent_max: 80000 }, ledger: ledger.facts });
  const ev = await evaluateAixWithJev({ messages: [{ sender: "customer", text: "他のお部屋も見たいです" }], materials, env: { TYPESAFE_API_KEY: "k" }, fetchImpl: fakeFetch });
  t("★ 全ボタンの問い: 答えが返る", ev?.decision.aix === "property_send", ev?.decision);
  const b0 = bodies[0];
  const stateObj = typeof b0?.state === "string" ? JSON.parse(b0.state as unknown as string) : b0?.state;
  t("★ state に customer_materials が届く", !!stateObj?.customer_materials, Object.keys(stateObj ?? {}));
  t("★ 質問は材料ありの形（読み方の一文）", String(b0?.questions?.next_aix?.instructions ?? "").includes("customer_materials"), b0?.questions?.next_aix?.instructions);
  const pk = await evaluatePickerWithJev({ aixType: "property_send", messages: [{ sender: "customer", text: "他のお部屋も見たいです" }], materials, env: { TYPESAFE_API_KEY: "k" }, fetchImpl: fakeFetch });
  t("★ ピッカー: 答えが返る", pk?.decision.picker === "new_arrival", pk?.decision);
  const b1 = bodies[1];
  t("★ ピッカー: 差し替えた説明で届く", /1件以上/.test(String(b1?.questions?.picker?.criteria?.new_arrival ?? "")), b1?.questions?.picker);

  console.log(`\n合計: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
