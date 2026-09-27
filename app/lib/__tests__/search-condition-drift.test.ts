// app/lib/__tests__/search-condition-drift.test.ts
// 検索の点検「登録の条件 ↔ 入った値」（search-condition-drift.ts・2026-09-27 v2.5.31）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/search-condition-drift.test.ts（全 PASS で exit 0）
//
// 材料は実物: YUMA のテスト顧客（509cd061）の本番の点検 search_audits 22（古い条件で検索した回）・23（広げての回・見張りで止まった）の
//   customer_snapshot・intended・filled をそのまま使う（名前・電話は元から入っていない）。
import { conditionDrift, customerWards, normWard, planSet, toYen } from "../search-condition-drift";
import { runSearchAuditChecks, causeTitle, type AuditInput } from "../search-audit-check";
import { intendedFilledDiff, buildDiagnoseUserText } from "../search-audit-diagnose";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const NOW = Date.parse("2026-09-27T11:00:00+09:00");

// ── 実物（search_audits 22・23 の欄のまま）──
const SNAP = { status: "active", rent_max: 80000, area_mode: "auto", floor_plan: "1K、1DK、1LDK", preferences: "バストイレ別・オートロック", building_age: 20, desired_area: "大阪市浪速区、大阪市天王寺区", walk_minutes: 10 };
const A22: AuditInput = {
  site: "realpro", trigger: "web_brain", is_wide: false, area_mode: "auto", status: "finished", created_at: "2026-09-27T01:42:06.069303+00:00",
  customer_snapshot: SNAP,
  intended: { is_wide: false, rent_max: 75000, rent_min: null, area_mode: "ward", route_ids: [], city_codes: ["27108", "27106", "27111", "27109"], floor_plan: "1K、1DK", detail_area: null, detail_ward: null, building_age: 30, walk_minutes: 10, station_names: [], rp_update_days: 1, unknown_tokens: null },
  filled: { v: 1, form: { age: "30", walk: "10", lines: [], wards: ["大阪市西区", "大阪市大正区", "大阪市天王寺区", "大阪市浪速区"], layouts: ["1K", "1DK"], rent_max: "75000", rent_min: "-1", stations: [], update_days: "1" },
    fallback: null, area_path: "area", reset_fail: null, click_fails: [], stations_ok: [], lines_missing: [], search_clicked: true, stations_missing: [] },
  result: { pages: 2, read_rows: 48, sent_count: 34, sendable_rows: 48, count_text: null, count_number: null, zero_reason: null },
};
const A23: AuditInput = {
  site: "realpro", trigger: "web_brain", is_wide: true, area_mode: "auto", status: "finished", created_at: "2026-09-27T01:49:07.040673+00:00",
  customer_snapshot: { ...SNAP, last_property_sent_at: "＊＊＊T01:43:55.734+00:00" },
  intended: { is_wide: true, rent_max: 85000, rent_min: null, area_mode: "ward", route_ids: [], city_codes: ["27111", "27109", "27128", "27106"], floor_plan: "1K、1DK、1LDK", building_age: 25, walk_minutes: 10, station_names: [], rp_update_days: 1, unknown_tokens: null },
  filled: { v: 1, form: null, fallback: null, area_path: "area", reset_fail: null, click_fails: [], stations_ok: [], lines_missing: [], search_clicked: null, stations_missing: [] },
  result: { batch_timed_out: true },
  error: "watchdog-timeout: 85秒以内に条件入力が完了しませんでした（全件検索防止のため中止）",
};

console.log("── ① 小さな道具");
t("「浪速区」→ 大阪市浪速区", normWard("浪速区") === "大阪市浪速区");
t("「大阪府大阪市西区」→ 大阪市西区", normWard("大阪府大阪市西区") === "大阪市西区");
t("大阪市に無い「北見区」は区にしない", normWard("北見区") === null);
t("「吹田市」は市のまま", normWard("吹田市") === "吹田市");
t("町名は区にしない（喜連西）", normWard("喜連西") === null);
{
  const w = customerWards(SNAP.desired_area);
  t("希望エリア → 浪速区・天王寺区（全部が区の書き方）", w.wards.join() === "大阪市浪速区,大阪市天王寺区" && w.allWards, JSON.stringify(w));
  const w2 = customerWards("大阪市西区　大阪市浪速区・4階のお部屋・11階のお部屋・西中島南方");
  t("駅名・言葉が混ざると「全部が区」ではない（余分な区は言わない）", w2.wards.length === 2 && !w2.allWards, JSON.stringify(w2));
}
t("間取り「1K、1DK、1LDK」", planSet("1K、1DK、1LDK").plans.join() === "1K,1DK,1LDK");
t("「1LDK以上」は範囲", planSet("1LDK以上").ranged);
t("金額: 8（万）・\"75000\"・\"8.5万\"", toYen(8) === 80000 && toYen("75000") === 75000 && toYen("8.5万") === 85000);
t("金額: -1・空は null", toYen("-1") === null && toYen("") === null);

console.log("── ② 点検 22（古い条件で検索した回）: 区の混ざり・間取りの欠け・家賃・築年を全部言う");
{
  const d = conditionDrift({ site: "realpro", is_wide: false, customer: SNAP, intended: A22.intended as Record<string, unknown>, form: A22.filled!.form as Record<string, unknown> });
  const keys = d.items.map((x) => `${x.field}:${x.kind}`).sort();
  t("ずれ: 区の余分・間取りの欠け・家賃が低い・築年が広い", keys.join() === "age:higher,floor_plan:missing,rent:lower,ward:extra", keys.join());
  t("区の余分は西区・大正区", d.items.some((x) => x.field === "ward" && /西区・大正区/.test(x.title)), d.items.map((x) => x.title).join("／"));
  t("間取りの欠けは 1LDK", d.items.some((x) => x.field === "floor_plan" && /1LDK/.test(x.title)));
  t("家賃は「登録=8万・入った=7.5万」", d.items.some((x) => x.field === "rent" && /登録=8万・入った=7.5万/.test(x.detail)), d.items.map((x) => x.detail).join("／"));
  t("読み戻しで比べた（source=form）", d.items.every((x) => x.source === "form"));
  t("4項目ずれ → 古い条件のおそれ", d.stale);
  const v = runSearchAuditChecks(A22, NOW);
  t("点検の札: CONDITION_STALE（bad）が一番上", v.checks[0].code === "CONDITION_STALE" && v.severity === "bad", v.checks.map((c) => c.code).join(","));
  t("点検の札: CONDITION_DRIFT 4つ", v.checks.filter((c) => c.code === "CONDITION_DRIFT").length === 4);
  t("家賃は2回言わない（condition_misread:rent_lower を出さない）", !v.cause_keys.includes("condition_misread:realpro:rent_lower"), v.cause_keys.join(","));
  t("原因の鍵 condition_stale:realpro", v.cause_key === "condition_stale:realpro");
  t("原因の鍵の見出し", causeTitle("condition_drift:realpro:ward:extra") === "リアプロ: 登録の条件と違う（ward・extra）" && causeTitle("condition_stale:realpro") === "リアプロ: 古い条件で検索したおそれ");
}

console.log("── ③ 点検 23（広げての回）: 決まりの幅（家賃+5千・築+5年・難波の3区）は食い違いにしない");
{
  const d = conditionDrift({ site: "realpro", is_wide: true, customer: A23.customer_snapshot as Record<string, unknown>, intended: A23.intended as Record<string, unknown>, form: null });
  t("ずれなし（中央区・西区は浪速区の難波の3区）", d.items.length === 0, d.items.map((x) => x.title).join("／"));
  const v = runSearchAuditChecks(A23, NOW);
  t("点検は見張りの時間切れだけ", v.checks.map((c) => c.code).join() === "ERROR_WATCHDOG", v.checks.map((c) => c.code).join());
  const narrow = conditionDrift({ site: "realpro", is_wide: false, customer: A23.customer_snapshot as Record<string, unknown>, intended: A23.intended as Record<string, unknown>, form: null });
  t("同じ値をピンポイントの回で入れたら「区の混ざり・家賃が高い・築年が広い」", narrow.items.map((x) => `${x.field}:${x.kind}`).sort().join() === "age:higher,rent:higher,ward:extra", narrow.items.map((x) => `${x.field}:${x.kind}`).join());
  const unknown = conditionDrift({ site: "realpro", is_wide: null, customer: A23.customer_snapshot as Record<string, unknown>, intended: A23.intended as Record<string, unknown>, form: null });
  t("広げてか分からない（null）時は両方を許す", unknown.items.length === 0, unknown.items.map((x) => x.title).join("／"));
}

console.log("── ④ 登録どおりの回（新しい条件で入った）は何も言わない");
{
  const form = { age: "20", walk: "10", lines: [], wards: ["大阪市天王寺区", "大阪市浪速区"], layouts: ["1K", "1DK", "1LDK"], rent_max: "80000", rent_min: "-1", stations: [], update_days: "1" };
  const intended = { ...A22.intended, rent_max: 80000, city_codes: ["27111", "27109"], floor_plan: "1K、1DK、1LDK", building_age: 20 };
  const d = conditionDrift({ site: "realpro", is_wide: false, customer: SNAP, intended, form });
  t("ずれなし", d.items.length === 0 && !d.stale, d.items.map((x) => x.title).join("／"));
  const v = runSearchAuditChecks({ ...A22, intended, filled: { ...A22.filled, form } }, NOW);
  t("点検に CONDITION_* が無い", !v.checks.some((c) => /^CONDITION_/.test(c.code)), v.checks.map((c) => c.code).join());
  // リアプロの選択肢は切り上げ: 登録 7.2万 → 7.5万・築 12年 → 15年
  const d2 = conditionDrift({ site: "realpro", is_wide: false, customer: { ...SNAP, rent_max: 72000, building_age: 12 }, intended, form: { ...form, rent_max: "75000", age: "15" } });
  t("選択肢への切り上げ（7.2万→7.5万・12年→15年）は同じ", !d2.items.some((x) => x.field === "rent" || x.field === "age"), d2.items.map((x) => x.title).join("／"));
}

console.log("── ⑤ 欠け・狭い（欲しい物件が漏れる）は bad");
{
  const form = { age: "15", walk: "7", wards: ["大阪市浪速区"], layouts: ["1K", "1DK", "1LDK"], rent_max: "80000", stations: [] };
  const d = conditionDrift({ site: "realpro", is_wide: false, customer: SNAP, intended: { area_mode: "ward", city_codes: ["27111"] }, form });
  const by = (f: string) => d.items.find((x) => x.field === f);
  t("天王寺区が入っていない → bad", by("ward")?.kind === "missing" && by("ward")?.severity === "bad" && /天王寺区/.test(by("ward")!.title));
  t("築年が狭い（20→15）→ bad", by("age")?.kind === "lower" && by("age")?.severity === "bad");
  t("徒歩が狭い（10→7）→ bad", by("walk")?.kind === "lower" && by("walk")?.severity === "bad");
}

console.log("── ⑥ 範囲の書き方・駅で入れた回・上書きの回は比べない所がある");
{
  const d = conditionDrift({ site: "realpro", is_wide: false, customer: { ...SNAP, floor_plan: "1LDK以上" }, intended: {}, form: { layouts: ["1LDK", "2K", "2DK", "2LDK"] } });
  t("「1LDK以上」→ 2K などは余分と言わない", !d.items.some((x) => x.field === "floor_plan"), d.items.map((x) => x.title).join("／"));
  const st = conditionDrift({ site: "realpro", is_wide: false, customer: SNAP, intended: { area_mode: "station", station_names: ["難波"] }, form: { stations: ["難波"], wards: [] } });
  t("駅で入れた回は区を比べない", !st.items.some((x) => x.field === "ward"));
  const ov = conditionDrift({ site: "realpro", is_wide: false, customer: { ...SNAP, _search_override: { floor_plan: "1LDK", rent_max: 90000 } }, intended: {}, form: { layouts: ["1LDK"], rent_max: "90000" } });
  t("メモの上書きで変えた項目（間取り・家賃）は比べない", !ov.items.some((x) => x.field === "floor_plan" || x.field === "rent"), ov.items.map((x) => x.title).join("／"));
  const mixed = conditionDrift({ site: "realpro", is_wide: false, customer: { ...SNAP, desired_area: "大阪市浪速区・難波駅" }, intended: { area_mode: "ward", city_codes: ["27111", "27128"] }, form: null });
  t("希望エリアに駅名が混ざる時は「余分な区」を言わない", !mixed.items.some((x) => x.field === "ward"), mixed.items.map((x) => x.title).join("／"));
  const ld = conditionDrift({ site: "realpro", is_wide: true, customer: { ...SNAP, floor_plan: "1LDK" }, intended: {}, form: { layouts: ["1LDK", "1DK"] } });
  t("広げての回の「1LDK → 1DK」は決まりの内", !ld.items.some((x) => x.field === "floor_plan"));
}

console.log("── ⑦ こだわり（検索の画面に入れる物だけ）");
{
  const pet = conditionDrift({ site: "realpro", customer: { ...SNAP, preferences: "小型犬を飼っています・オートロック" }, intended: { pet_ok: false, shikirei_free: false }, form: null });
  t("ペットの希望があるのに pet_ok=false → warn", pet.items.some((x) => x.field === "pet" && x.severity === "warn"));
  const sk = conditionDrift({ site: "realpro", customer: { ...SNAP, ng_points: "敷金礼金なし希望" }, intended: { pet_ok: false, shikirei_free: false }, form: null });
  t("敷金礼金なしの希望があるのに入っていない → warn", sk.items.some((x) => x.field === "shikirei"));
  const none = conditionDrift({ site: "realpro", customer: SNAP, intended: { pet_ok: false, shikirei_free: false }, form: null });
  t("バストイレ別・オートロックは検索で絞らない（言わない）", none.items.length === 0, none.items.map((x) => x.title).join("／"));
}

console.log("── ⑧ 見張りで止まった時の様子（拡張 v2.5.31 の stall）を見立ての材料に");
{
  const stall = { stage: "cities", stage_detail: "4", since_stage_ms: 83000, elapsed_ms: 85000, visibility: "hidden", has_focus: false, hidden_ms: 85000,
    queue_len: 9, queue_busy: true, queue_next: "city_code[]:27109", ops_done: 5, late_max: 59000, late_over_1s: 2, modal_open: false, city_checked: 1, form: { rent_max: "85000" } };
  const lines = intendedFilledDiff(A23.intended, { ...A23.filled, stall });
  const line = lines.find((l) => l.startsWith("止まった時の様子"));
  t("止まった時の様子の1行（段・タブ・列の残り・タイマーの遅れ）", !!line && /段=cities/.test(line) && /タブ=hidden/.test(line) && /残り9件/.test(line) && /最大59000ms/.test(line), String(line));
  const user = buildDiagnoseUserText({ site: "realpro", checks: [], intended: A23.intended, filled: { ...A23.filled, stall } });
  t("見立ての材料に入る", /止まった時の様子/.test(user));
  const v = runSearchAuditChecks({ ...A23, filled: { ...A23.filled, stall } }, NOW);
  t("stall の読み戻し（入れ終わっていない値）は点検の比べに使わない", v.checks.map((c) => c.code).join() === "ERROR_WATCHDOG", v.checks.map((c) => c.code).join());
}

console.log("── ⑨ 更新日は「登録の条件のずれ」に入れない（v2.5.34 反証の検証で外した）— UPDATE_DAYS だけが言う");
{
  // 反証: 自動便（今日の新着＝1日）で手で決めた 7 があると「更新日が登録より狭い（bad）」が毎回出て、CONDITION_STALE の数にも入った（リアプロにも効いた）
  const C7 = { ...SNAP, rp_update_days: 7 };
  const rpAuto = conditionDrift({ site: "realpro", customer: C7, intended: { rp_update_days: 1 }, form: { update_days: "1" } });
  t("リアプロの自動便（登録 7・入れた 1・入った 1）→ drift に更新日を出さない", !rpAuto.items.some((x) => (x.field as string) === "update_days"));
  const itAuto = conditionDrift({ site: "itandi", customer: C7, intended: { rp_update_days: 1 }, form: { update_days: "1" } });
  t("itandi の自動便も同じ → drift に更新日を出さない", !itAuto.items.some((x) => (x.field as string) === "update_days"));
  const v = runSearchAuditChecks({ site: "realpro", customer_snapshot: C7, created_at: "2026-09-27T02:00:00Z", intended: { rp_update_days: 1, rent_max: 80000 }, filled: { search_clicked: true, form: { update_days: "1", rent_max: "80000" } }, result: { read_rows: 5 } }, NOW);
  t("点検: 自動便のリアプロで更新日の bad が出ない（決まりと違うは warn の differs だけ）", !v.checks.some((c) => c.severity === "bad" && /update_days/.test(c.cause_key)) && v.checks.some((c) => c.cause_key === "update_days:realpro:differs" && c.severity === "warn"), v.checks.map((c) => c.cause_key).join());
  const v2 = runSearchAuditChecks({ site: "itandi", customer_snapshot: C7, created_at: "2026-09-27T02:00:00Z", intended: { rp_update_days: 7, rent_max: 80000 }, filled: { search_clicked: true, form: { update_days: "" } }, result: { read_rows: 5 } }, NOW);
  t("itandi で入らなかった時は UPDATE_DAYS not_filled が1回だけ言う", v2.checks.filter((c) => c.cause_key.includes("update_days")).map((c) => c.cause_key).join() === "update_days:itandi:not_filled", v2.checks.map((c) => c.cause_key).join());
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
