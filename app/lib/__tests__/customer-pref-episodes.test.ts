// app/lib/__tests__/customer-pref-episodes.test.ts
// 送った物件を起点にした学習の材料（customer-pref-episodes.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/customer-pref-episodes.test.ts
//
// 値は本番の形そのまま（2026-09-29 の property_pickups の札・拡張の回の候補の鍵・sent_properties の source/channel）。物件名・お客様は仮名。
import {
  PREF_CONFIG, bundleSends, candKey, sendMatchesCand, sendMatchesPickup, episodeFromBundle, sentFamilyFit, prefStrength,
  learnableByFamily, learnableByCode, materialSummary, conditionsReadableAt, type SendRow, type PrefEpisode,
} from "../customer-pref-episodes";
import { buildContext } from "../scoring-learning-episodes";
import { customerStrength } from "../recommend-score-drift";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// ─── 送付の束 ────────────────────────────────────────────────────────────────
console.log("■ 送付の束");
{
  const sends: SendRow[] = [
    { property_name: "エスリード難波VALORE", room_no: "404", sent_at: "2026-09-26T02:10:00Z", source: "aix:property_send", channel: "pickup", delivery: "customer", pickup_id: 701 },
    { property_name: "Luxe難波西2", room_no: "1009", sent_at: "2026-09-26T02:12:00Z", source: "aix:property_send", channel: "pickup", delivery: "customer", pickup_id: 702 },
    { property_name: "レジア大今里", room_no: "203", sent_at: "2026-09-26T02:50:00Z", source: "vision", channel: null, delivery: "customer" },   // 38分後＝別の束
    { property_name: "共有だけ", room_no: "101", sent_at: "2026-09-26T02:11:00Z", source: "line_group", channel: "extension_group", delivery: "shared" }, // 共有は外す
    { property_name: "古い行", room_no: "1", sent_at: "2026-09-25T00:00:00Z", source: "vision", channel: null, delivery: null },                   // delivery NULL は source から（vision＝お客様）
  ];
  const b = bundleSends(sends);
  t("束は3つ（共有の行は外す・30分を超えると別の束）", b.length === 3, JSON.stringify(b.map((x) => x.sends.length)));
  t("時刻順で最初は delivery NULL の vision の行", b[0].sends[0].property_name === "古い行");
  t("2つ目の束は2件・経路 pickup", b[1].sends.length === 2 && b[1].vias.join() === "pickup", JSON.stringify(b[1].vias));
  t("3つ目の束は vision（経路が分からない）＝other", b[2].vias.join() === "other");
  t("束の start/end", b[1].start === "2026-09-26T02:10:00Z" && b[1].end === "2026-09-26T02:12:00Z");
}

// ─── 照合 ─────────────────────────────────────────────────────────────────────
console.log("■ 照合");
{
  t("候補の鍵は建物＋号室（号室の 0 埋め・『号室』を落とす）", candKey("Luxe難波西2", "0403号室") === candKey("Luxe難波西2 403号室", null), `${candKey("Luxe難波西2", "0403号室")} vs ${candKey("Luxe難波西2 403号室", null)}`);
  t("送付 → 拡張の候補: 建物と号室が同じ", sendMatchesCand({ property_name: "Luxe難波西2", room_no: "1009" }, { name: "Ｌｕｘｅ難波西２", room_no: "1009" }));
  t("送付 → 拡張の候補: 号室が違えば別", !sendMatchesCand({ property_name: "Luxe難波西2", room_no: "1009" }, { name: "Luxe難波西2", room_no: "1010" }));
  t("送付 → 拡張の候補: 候補に号室が無ければ建物で当てる", sendMatchesCand({ property_name: "Luxe難波西2", room_no: "1009" }, { name: "Luxe難波西2", room_no: null }));
  t("送付 → 売上サポ: pickup_id で結ぶ", sendMatchesPickup({ property_name: "違う名前", room_no: "1", sent_at: "", pickup_id: 829 }, { id: 829, property_name: "エスリード難波VALORE", room_no: "404" }));
  t("送付 → 売上サポ: 名前＋号室（pickup_id なし）", sendMatchesPickup({ property_name: "エスリード難波VALORE", room_no: "404", sent_at: "" }, { id: 1, property_name: "エスリード難波VALORE", room_no: "0404" }));
  t("送付 → 売上サポ: 同じ建物の別の部屋は当てない", !sendMatchesPickup({ property_name: "エスリード難波VALORE", room_no: "404", sent_at: "" }, { id: 1, property_name: "エスリード難波VALORE", room_no: "405" }));
}

// ─── 1束 → 1回（売上サポの回・札は保存済み） ───────────────────────────────────
console.log("■ 1束 → 1回（売上サポの回）");
const CUST = { id: "c1", rent_max: 70000, floor_plan: "1K", walk_minutes: 10, preferences: "オートロック必須\n1階NG", ng_points: "敷礼あり", desired_area: "難波" } as Record<string, unknown>;
const ctx = buildContext(CUST, [], [], "2026-09-28T03:00:00Z");
// 2026-09-28 の実物の札（id 1103・829）と、その並びの3件
const pickups = [
  { id: 1103, created_at: "2026-09-28T02:20:00Z", batch_id: "物件まとめ_2026-9-28_1790566234329.pdf", complete_group_id: "cg_60be5b3d_1097", rank: 2, complete_rank: 7, property_name: "A棟", room_no: "302", score: 62, reason_codes: ["RENT_OK", "WALK_OK", "BUILDING_AGE_WIDE", "MOVE_IN_LATE", "EQUIP_PET_ASK", "AREA_STATION_MATCH", "AD_UNDER_1M"], status: "pending", sent_at: null },
  { id: 829, created_at: "2026-09-28T02:21:00Z", batch_id: "物件まとめ_2026-9-28_1790561489399.pdf", complete_group_id: "cg_60be5b3d_1097", rank: 1, complete_rank: 19, property_name: "B棟", room_no: "1201", score: 72, reason_codes: JSON.stringify(["RENT_OK", "INITIAL_COST_NOT_ZERO", "FLOOR_PLAN_MATCH", "AD_1M_HELD", "MOVE_IN_OK", "WALK_NEAR_N", "SEARCH_PINPOINT_HELD"]), status: "pending", sent_at: null },
  { id: 830, created_at: "2026-09-28T02:21:30Z", batch_id: "物件まとめ_2026-9-28_1790561489399.pdf", complete_group_id: "cg_60be5b3d_1097", rank: 3, complete_rank: 1, property_name: "C棟", room_no: "501", score: 163, reason_codes: ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "WALK_OK", "AD_HIGH", "MOVE_IN_OK", "EQUIP_AUTOLOCK_MUST_OK", "EQUIP_FLOOR2_OK", "FIT_ALL"], status: "pending", sent_at: null },
  { id: 831, created_at: "2026-09-28T02:22:00Z", batch_id: "物件まとめ_2026-9-28_1790561489399.pdf", complete_group_id: "cg_60be5b3d_1097", rank: 4, complete_rank: 2, property_name: "C棟", room_no: "501", score: 150, reason_codes: ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "AD_HIGH", "MOVE_IN_OK", "EQUIP_AUTOLOCK_MUST_OK"], status: "pending", sent_at: null }, // 同じ部屋の2行（itandi）
];
{
  const b = bundleSends([{ property_name: "A棟", room_no: "302", sent_at: "2026-09-28T03:00:00Z", source: "aix:property_send", channel: "pickup", delivery: "customer", pickup_id: 1103 },
    { property_name: "候補の外の物件", room_no: "1", sent_at: "2026-09-28T03:01:00Z", source: "vision", delivery: "customer" }])[0];
  const e = episodeFromBundle({ bundle: b, customerKey: "abcd1234", pickups, pools: [], ctx });
  t("売上サポの回から1回できる", !!e && e.source === "pickup", e?.source);
  t("候補は3件（同じ部屋の2行は1つ・点の高い方）", e?.cands.length === 3 && e.cands.find((c) => c.key === "C棟 501")?.feats.score === 163, JSON.stringify(e?.cands.map((c) => [c.key, c.feats.score])));
  t("選んだ物＝送付に当たった A棟 302（pickup_id で結ぶ）", e?.cands.filter((c) => c.chosen).map((c) => c.key).join() === "A棟 302");
  t("reason_codes が文字列でも読む（B棟）", (e?.cands.find((c) => c.key === "B棟 1201")?.codes ?? []).includes("FLOOR_PLAN_MATCH"));
  t("送付 2件のうち候補に当たった 1件", e?.sent === 2 && e?.matched === 1);
  t("条件の種類（segments）は条件から", !!e && e.segments.includes("plan_want") && e.segments.includes("equip_want") && e.segments.includes("low_initial"), JSON.stringify(e?.segments));
  t("id にお客様の見分けと束の時刻", !!e && e.id.startsWith("pickup:abcd1234:2026-09-28T03:00:"));
  const none = episodeFromBundle({ bundle: bundleSends([{ property_name: "候補の外の物件", room_no: "1", sent_at: "2026-09-28T03:00:00Z", source: "vision", delivery: "customer" }])[0], customerKey: "abcd1234", pickups, pools: [], ctx });
  t("送付が候補に1つも当たらなければ null", none === null);
  const late = episodeFromBundle({ bundle: bundleSends([{ property_name: "A棟", room_no: "302", sent_at: "2026-10-02T03:00:00Z", source: "vision", delivery: "customer" }])[0], customerKey: "abcd1234", pickups, pools: [], ctx: null });
  t("72時間より前の回は候補にしない（ctx 無しなら拡張の回も使えず null）", late === null);
}

// ─── 1束 → 1回（拡張の回をまとめて付け直す） ─────────────────────────────────
console.log("■ 1束 → 1回（拡張の回）");
{
  // 実物の候補の鍵（2026-09 の property_candidate_pools: src・name・rank・facts_v・floor_plan・ad_months。家賃は無い）
  const pools = [
    { id: "p-old", sent_at: "2026-09-27T09:00:00Z", candidates: [{ src: { name: "ext" }, name: "ハイツ大国町", room_no: "201", rank: 1, facts_v: 2, floor_plan: "1K", ad_months: 2 }, { src: { name: "ext" }, name: "メゾン桜川", room_no: "305", rank: 2, facts_v: 2, floor_plan: "1DK", ad_months: 1 }] },
    { id: "p-new", sent_at: "2026-09-28T02:50:00Z", candidates: JSON.stringify([{ src: { name: "ext" }, name: "ハイツ大国町", room_no: "201", rank: 1, facts_v: 2, floor_plan: "1K", ad_months: 2 }, { src: { name: "ext" }, name: "コーポ芦原橋", room_no: "102", rank: 2, facts_v: 2, floor_plan: "2DK", ad_months: null }]) },
    { id: "p-after", sent_at: "2026-09-28T04:00:00Z", candidates: [{ src: { name: "ext" }, name: "後の回", room_no: "1", rank: 1, facts_v: 2, floor_plan: "1K", ad_months: 2 }] },
  ];
  const b = bundleSends([{ property_name: "ハイツ大国町", room_no: "201", sent_at: "2026-09-28T03:00:00Z", source: "vision", delivery: "customer" }])[0];
  const e = episodeFromBundle({ bundle: b, customerKey: "abcd1234", pickups: [], pools, ctx });
  t("拡張の回から1回できる（売上サポの回が無い時）", !!e && e.source === "pool", e?.source);
  t("72時間の窓の2回をまとめ、後の回は入れない（候補 3件・同じ部屋は1つ）", e?.cands.length === 3 && e.poolsMerged === 2, JSON.stringify(e?.cands.map((c) => c.key)));
  t("選んだ物＝ハイツ大国町 201", e?.cands.filter((c) => c.chosen).map((c) => c.key).join() === "ハイツ大国町 201");
  const chosen = e?.cands.find((c) => c.chosen);
  t("今の判定で付け直した札（間取り一致・AD 2ヶ月・家賃は読めない）", !!chosen && chosen.codes.includes("FLOOR_PLAN_MATCH") && chosen.codes.includes("AD_HIGH") && chosen.codes.includes("RENT_UNKNOWN"), chosen?.codes.join(" "));
  const other = e?.cands.find((c) => c.key === "コーポ芦原橋 102");
  t("1K の希望に 2DK は「希望より広い間取り」（judgeProperty の線）で AD 不明", !!other && other.codes.includes("FLOOR_PLAN_LARGER") && other.codes.includes("AD_UNKNOWN"), other?.codes.join(" "));
  t("売上サポの回があればそちらを優先", episodeFromBundle({ bundle: bundleSends([{ property_name: "A棟", room_no: "302", sent_at: "2026-09-28T03:00:00Z", source: "vision", delivery: "customer" }])[0], customerKey: "x", pickups, pools, ctx })?.source === "pickup");
}

// ─── こだわりの強さ（送った物件がその条件を満たす率） ─────────────────────────
console.log("■ こだわりの強さ");
{
  const mk = (id: string, chosenCodes: string[], otherCodes: string[]): PrefEpisode => ({
    id, at: "2026-09-20T00:00:00Z", source: "pickup", segments: [], customerKey: "k1", vias: ["pickup"], sent: 1, matched: 1,
    cands: [{ key: "a", chosen: true, codes: chosenCodes, feats: {} }, { key: "b", chosen: false, codes: otherCodes, feats: {} }],
  });
  const eps = [
    mk("e1", ["EQUIP_AUTOLOCK_MUST_OK", "ZERO_ZERO_MATCH", "RENT_OK"], ["EQUIP_AUTOLOCK_MUST_NG", "INITIAL_COST_NOT_ZERO", "RENT_OK"]),
    mk("e2", ["EQUIP_AUTOLOCK_MUST_OK", "INITIAL_COST_NOT_ZERO", "RENT_UNKNOWN"], ["EQUIP_AUTOLOCK_UNLISTED", "ZERO_ZERO_MATCH", "RENT_OK"]),
    mk("e3", ["EQUIP_AUTOLOCK_MUST_OK", "ZERO_ZERO_MATCH"], ["EQUIP_AUTOLOCK_MUST_OK", "ZERO_ZERO_MATCH"]),
    mk("e4", ["EQUIP_AUTOLOCK_MUST_OK", "INITIAL_COST_UNKNOWN", "AD_HIGH"], ["EQUIP_AUTOLOCK_ASK", "ZERO_ZERO_MATCH", "AD_1M"]),
  ];
  const fit = sentFamilyFit(eps);
  t("オートロック: 4件とも満たす（分かった 4・満たす 4）", fit["equip:autolock"]?.known === 4 && fit["equip:autolock"].ok === 4 && fit["equip:autolock"].rate === 1);
  t("初期費用: 分かった 3・満たす 2（_UNKNOWN は数えない）", fit.initial_cost?.known === 3 && fit.initial_cost.ok === 2, JSON.stringify(fit.initial_cost));
  t("家賃: 分かった 1（RENT_UNKNOWN は数えない）", fit.rent?.known === 1 && fit.rent.rate === 1);
  // 条件欄「オートロック」だけ（stated・自由文 +1）、初期費用は書いていない（none）
  const base = customerStrength({ conditions: { preferences: "オートロックがあれば嬉しい" } });
  t("元の強さ: オートロック stated・初期費用 none", base.byFamily["equip:autolock"]?.level === "stated" && !base.byFamily.initial_cost, JSON.stringify(base.byFamily));
  const p = prefStrength(base, fit);
  t("送った物件が 4/4 で満たす stated の条件は strong に上がる", p.level["equip:autolock"] === "strong" && p.raisedBySentFit.join() === "equip:autolock", JSON.stringify(p.level));
  t("書いていない条件（初期費用）は送付の偏りでは上げない（none のまま）", p.level.initial_cost === "none");
  t("分かった数が線（3）未満なら上げない", prefStrength(customerStrength({ conditions: { preferences: "家賃は抑えたい" } }), fit).level.rent === "stated");
  const strongBase = customerStrength({ conditions: { preferences: "オートロック必須", ng_points: "オートロックなし" } });
  t("元から strong の条件はそのまま（raised に入れない）", prefStrength(strongBase, fit).raisedBySentFit.length === 0 && prefStrength(strongBase, fit).level["equip:autolock"] === "strong");
  t("線は PREF_CONFIG（3件・0.85）", PREF_CONFIG.fitMinKnown === 3 && PREF_CONFIG.fitStrongRate === 0.85);

  // 学べる件数
  const strengthOf = (_e: PrefEpisode, f: string) => p.level[f] ?? "none";
  const fam = learnableByFamily(eps, strengthOf);
  const auto = fam.find((r) => r.family === "equip:autolock" && r.level === "all");
  t("オートロック: 学べる回は e1 だけ（e2/e4 は相手が分からない・e3 は同じ）", auto?.rounds === 1 && auto.customers === 1, JSON.stringify(auto));
  t("オートロック: strong の段にも同じ 1回", fam.find((r) => r.family === "equip:autolock" && r.level === "strong")?.rounds === 1);
  const init = fam.find((r) => r.family === "initial_cost" && r.level === "all");
  t("初期費用: 学べる回は e1・e2 の 2回（e4 は選んだ側が分からない）", init?.rounds === 2 && init.chosenOk === 0.5, JSON.stringify(init));
  t("条件の種類: AD は学ばないので出ない（e4 は AD_HIGH と AD_1M で違う）", !fam.some((r) => r.family === "ad"));
  const codes = learnableByCode(eps, strengthOf);
  t("札ごと: AD の札は凍結で出ない", !codes.some((r) => r.code.startsWith("AD_")));
  const zz = codes.find((r) => r.code === "ZERO_ZERO_MATCH" && r.level === "all");
  t("ZERO_ZERO_MATCH は e1・e2・e4 の3回（選んだ方が持つ率 1/3）", zz?.rounds === 3 && zz.winRate === 0.333, JSON.stringify(zz));
  const unk = codes.find((r) => r.code === "RENT_UNKNOWN");
  t("材料の欠けの札（RENT_UNKNOWN）は出ない", !unk);
  const s = materialSummary(eps);
  t("まとめ: お客様 1・回 4・候補 8・選んだ 4", s.customers === 1 && s.rounds === 4 && s.candidates === 8 && s.chosen === 4 && s.bySource.pickup.rounds === 4, JSON.stringify(s));
  t("まとめ: 条件が読めている候補の数（オートロック 6＝_UNLISTED・_ASK を除く）", s.familyCoverage["equip:autolock"] === 6, JSON.stringify(s.familyCoverage));
}


console.log("■ その回の時点で読める条件（未来の情報を混ぜない・2026-09-29 反証レビュー）");
{
  const cond = { rent_max: 80000, floor_plan: "1K", desired_area: "浪速区", ng_points: "1階NG", preferences: "バストイレ別必須", pet: false, raw_format_text: "" };
  const upd = "2026-09-25T00:00:00Z";
  const a = conditionsReadableAt(cond, "2026-09-01T00:00:00Z", upd);
  t("9/1 の回: 家賃・間取り・エリアは履歴で戻せる（8/20〜）・NG・こだわりは履歴が無く行が後で変わった＝読めない", a.c.rent_max === 80000 && a.c.floor_plan === "1K" && a.c.ng_points === null && a.c.preferences === null && JSON.stringify(a.unreadable) === JSON.stringify(["preferences", "ng_points"]), JSON.stringify(a));
  const b = conditionsReadableAt(cond, "2026-09-28T00:00:00Z", upd);
  t("9/28 の回: 行がその前から変わっていない＝全部読める", b.unreadable.length === 0 && b.c.ng_points === "1階NG");
  const c = conditionsReadableAt(cond, "2026-08-15T00:00:00Z", "2026-09-28T01:00:00Z");
  t("8/15 の回（履歴の前）: 行が後で変わった＝値のある欄は全部読めない", c.unreadable.length === 5 && c.c.rent_max === null && c.c.desired_area === null, JSON.stringify(c.unreadable));
  const d = conditionsReadableAt({ ng_points: "1階NG" }, "2026-09-28T00:00:00Z", "2026-09-28T05:00:00Z");
  t("9/27 から履歴に残る NG は 9/28 の回なら読める（行が後で変わっても）", d.unreadable.length === 0);
  const e = conditionsReadableAt({ ng_points: "1階NG" }, "2026-09-01T00:00:00Z", null);
  t("updated_at が無ければ履歴の無い欄は読めない", e.unreadable.length === 1);
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
