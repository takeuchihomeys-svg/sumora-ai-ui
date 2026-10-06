// app/lib/__tests__/hooked-arrival-learning.test.ts
// 刺さった新着1件を採点の学習に入れる純関数（hooked-arrival-learning.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/hooked-arrival-learning.test.ts
//
// 確かめること: 特徴の帯／お客様の型／型 × 特徴の数と lift／古い半分で学び新しい半分で確かめる／加点は足すだけ（刺さらない物を減点しない）／
//   スタッフの選択に当てた前後（下がる・変わらない・小さい改善は入れない）／1つずつ外す／事実の埋め方（実物の🌟の本文の値・結び違いの画像を使わない）
import {
  hookFeatureBits, hookCustomerTypeOf, hookTypeKeys, hookCells, learnHookLeans, hookLeanTable, hookLeanBonus, evaluateHookBonus, pruneHookTable,
  fillArrivalFacts, hookFeatsOfFacts, isNewArrivalSnapshot, splitHookRecords, HOOK_LEARN_CONFIG,
  type HookRecord, type HookEvalEpisode, type HookCustomerType,
} from "../hooked-arrival-learning";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const ONE: HookCustomerType = { household: false, initial: false };
const ONE_INIT: HookCustomerType = { household: false, initial: true };
const HH: HookCustomerType = { household: true, initial: false };

console.log("■ 特徴の帯");
{
  const b = hookFeatureBits({ rent_ratio: 0.95, area_sqm: 26, building_age: 12, walk: 5, zero_zero: 1 }, ONE);
  t("家賃 0.95 は上限寄り・8割未満ではない", b.rent_upper === 1 && b.rent_low === 0);
  t("敷礼0・徒歩5・築12", b.zero_zero === 1 && b.walk_near === 1 && b.age_new === 1 && b.age_old === 0);
  t("広さの線は型で変わる（一人 25・二人以上 40）", b.area_wide === 1 && hookFeatureBits({ area_sqm: 26 }, HH).area_wide === 0);
  const n = hookFeatureBits({}, ONE);
  t("分からない物は null（数えない）", Object.values(n).every((v) => v === null));
  t("家賃 1.15 は上限寄りに入れない", hookFeatureBits({ rent_ratio: 1.15 }, ONE).rent_upper === 0);
}

console.log("■ お客様の型");
{
  t("1LDK の希望は二人以上", hookCustomerTypeOf({ floor_plan: "1LDK" }).household === true);
  t("「1K、1LDK」は一人の型に残す（householdLayoutOf と同じ）", hookCustomerTypeOf({ floor_plan: "1K、1LDK" }).household === false);
  t("初期費用の上限があれば初期費用の型", hookCustomerTypeOf({ initial_cost_limit: 200000 }).initial === true);
  t("条件が無ければ 一人・初期費用なし", JSON.stringify(hookCustomerTypeOf(null)) === JSON.stringify({ household: false, initial: false }));
  t("型の鍵: 全体＋一人＋初期費用＋組み合わせ", JSON.stringify(hookTypeKeys(ONE_INIT)) === JSON.stringify(["全体", "一人", "初期費用", "一人×初期費用"]));
  t("型の鍵: 初期費用なしは2つ", JSON.stringify(hookTypeKeys(HH)) === JSON.stringify(["全体", "二人以上"]));
}

/** n 件の送った新着（hooked の数と、敷礼0 を持つ数を指定） */
function recs(start: number, n: number, opt: { hookedZero: number; hookedOther: number; sentZero: number; type?: HookCustomerType }): HookRecord[] {
  const out: HookRecord[] = [];
  const type = opt.type ?? ONE;
  let i = 0;
  const at = () => new Date(Date.UTC(2026, 0, 1) + (start + i++) * 3600_000).toISOString();
  for (let k = 0; k < opt.hookedZero; k++) out.push({ at: at(), hooked: true, type, feats: { zero_zero: 1 } });
  for (let k = 0; k < opt.hookedOther; k++) out.push({ at: at(), hooked: true, type, feats: { zero_zero: 0 } });
  const restZero = opt.sentZero - opt.hookedZero;
  for (let k = 0; k < restZero; k++) out.push({ at: at(), hooked: false, type, feats: { zero_zero: 1 } });
  while (out.length < n) out.push({ at: at(), hooked: false, type, feats: { zero_zero: 0 } });
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

console.log("■ 型 × 特徴の数と lift");
{
  const r = recs(0, 40, { hookedZero: 9, hookedOther: 1, sentZero: 16 });
  const c = hookCells(r).find((x) => x.type === "全体" && x.feature === "zero_zero")!;
  // 刺さった 10 のうち 9（90%）÷ 送った 40 のうち 16（40%）= 2.25
  t("lift＝刺さった物の中の割合 ÷ 送った物の中の割合", c.sent === 40 && c.hooked === 10 && c.hookedWith === 9 && c.sentWith === 16 && c.lift === 2.25, JSON.stringify(c));
  const { train, confirm } = splitHookRecords([...r].reverse());
  t("古い半分で学び新しい半分で確かめる（時刻の順）", train.length === 20 && confirm.length === 20 && train[19].at < confirm[0].at);
}

console.log("■ 学ぶ（古い半分で線を越え・新しい半分でも同じ向き）");
{
  // 古い 40・新しい 40 とも 刺さった物の9割が敷礼0（送った物の4割）
  const both = [...recs(0, 40, { hookedZero: 9, hookedOther: 1, sentZero: 16 }), ...recs(100, 40, { hookedZero: 9, hookedOther: 1, sentZero: 16 })];
  const L = learnHookLeans(both, { ...HOOK_LEARN_CONFIG, minSent: 30 });
  t("両方の半分で多い特徴は学ぶ", L.leans.some((l) => l.type === "全体" && l.feature === "zero_zero"), JSON.stringify(L.skipped.slice(0, 4)));
  // 新しい半分では刺さった物に敷礼0が少ない
  const flip = [...recs(0, 40, { hookedZero: 9, hookedOther: 1, sentZero: 16 }), ...recs(100, 40, { hookedZero: 1, hookedOther: 9, sentZero: 16 })];
  const L2 = learnHookLeans(flip);
  t("新しい半分で向きが変わる物は学ばない", !L2.leans.length && L2.skipped.some((s) => /確かめられない/.test(s.reason)));
  // 刺さった数が少ない
  const few = [...recs(0, 40, { hookedZero: 4, hookedOther: 0, sentZero: 8 }), ...recs(100, 40, { hookedZero: 4, hookedOther: 0, sentZero: 8 })];
  t("刺さった数が線より少ない物は学ばない", !learnHookLeans(few).leans.length && learnHookLeans(few).skipped.some((s) => /刺さった数が少ない/.test(s.reason)));
  // 送った数が少ない型（一人×初期費用 が 10件）は学ばない
  const small = [...both, ...recs(300, 10, { hookedZero: 5, hookedOther: 0, sentZero: 5, type: ONE_INIT })];
  const L3 = learnHookLeans(small);
  t("回の少ない型は学ばない", !L3.leans.some((l) => l.type === "一人×初期費用"));
  { const tb = hookLeanTable(L.leans); t("表の形（型 → 特徴）", Object.keys(tb).sort().join() === ["一人", "全体"].sort().join() && tb["全体"].join() === "zero_zero" && tb["一人"].join() === "zero_zero", JSON.stringify(tb)); }
}

console.log("■ 加点は足すだけ（刺さらない物を減点しない）");
{
  const table = { 全体: ["zero_zero" as const], 一人: ["zero_zero" as const, "walk_near" as const] };
  const a = hookLeanBonus(table, ONE, { zero_zero: 1, walk: 3 });
  t("当たる特徴ごとに +5・同じ特徴は1回", a.bonus === 10 && a.hits.length === 2);
  t("当たらない候補は 0（負にしない）", hookLeanBonus(table, ONE, { zero_zero: 0, walk: 20 }).bonus === 0);
  t("分からない特徴は 0", hookLeanBonus(table, ONE, {}).bonus === 0);
  t("上限 +10", hookLeanBonus({ 全体: ["zero_zero", "walk_near", "age_new"] }, ONE, { zero_zero: 1, walk: 3, building_age: 5 }).bonus === 10);
  t("表に無い型には効かない（二人以上には 一人 の特徴を足さない）", hookLeanBonus({ 一人: ["walk_near"] }, HH, { walk: 3 }).bonus === 0);
  t("表が無ければ 0", hookLeanBonus(null, ONE, { zero_zero: 1 }).bonus === 0);
}

console.log("■ スタッフの選択に当てた前後");
{
  // 選んだ物が敷礼0・同点の相手は敷礼0でない → 加点で1位に
  const mk = (i: number, chosenZero: number, otherZero: number, src = "snapshot"): HookEvalEpisode => ({
    id: `e${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), source: src, type: ONE,
    cands: [{ chosen: true, score: 60, feats: { zero_zero: chosenZero } }, { chosen: false, score: 60, feats: { zero_zero: otherZero } }, { chosen: false, score: 55, feats: {} }],
  });
  const good = Array.from({ length: 12 }, (_, i) => mk(i, 1, 0));
  const r = evaluateHookBonus(good, { 全体: ["zero_zero"] });
  t("選んだ物に多い特徴は 1位一致が上がり use", r.use && r.withBonus.top1 > r.base.top1 && r.pairs.newOnly === 12 && r.pairs.oldOnly === 0, r.reason);
  const bad = Array.from({ length: 12 }, (_, i) => mk(i, 0, 1));
  const r2 = evaluateHookBonus(bad, { 全体: ["zero_zero"] });
  t("選ばなかった物に付く特徴は下がるので使わない", !r2.use && /下がる/.test(r2.reason), r2.reason);
  const none = evaluateHookBonus(good, { 二人以上: ["zero_zero"] });
  t("加点が付かない表は使わない", !none.use && /付く候補が無い/.test(none.reason));
  // 材料ごと: snapshot では上がるが pool では下がる → 使わない
  const mixed = [...good, ...Array.from({ length: 12 }, (_, i) => mk(100 + i, 0, 1, "pool")), ...Array.from({ length: 30 }, (_, i) => mk(200 + i, 1, 0))];
  const r3 = evaluateHookBonus(mixed, { 全体: ["zero_zero"] });
  t("材料（snapshot・pool）のどれかで下がれば使わない", !r3.use && /材料ごと/.test(r3.reason), r3.reason);
  // 小さい改善（100回中1回だけ上がる）は入れない
  const tiny = [mk(0, 1, 0), ...Array.from({ length: 99 }, (_, i) => ({ ...mk(1 + i, 0, 0), cands: [{ chosen: true, score: 70, feats: {} }, { chosen: false, score: 60, feats: {} }] }))];
  const r4 = evaluateHookBonus(tiny, { 全体: ["zero_zero"] }, { ...HOOK_LEARN_CONFIG, minGain: 0.05 });
  t("改善が線より小さく1位も変わらない物は入れない（1位が上がる時は入れる）", r4.withBonus.top1 > r4.base.top1 ? r4.use : !r4.use, r4.reason);
  const tiny2: HookEvalEpisode[] = Array.from({ length: 200 }, (_, i) => ({
    id: `x${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), source: "snapshot", type: ONE,
    cands: [{ chosen: true, score: 50, feats: { zero_zero: i === 0 ? 1 : 0 } }, { chosen: false, score: 70, feats: {} }, { chosen: false, score: 52, feats: {} }, { chosen: false, score: 54, feats: {} }],
  }));
  const r5 = evaluateHookBonus(tiny2, { 全体: ["zero_zero"] });
  t("1位が変わらない小さな改善は『良くなる量が小さい』", !r5.use && /小さい/.test(r5.reason), r5.reason);
}

console.log("■ 1つずつ確かめて外す");
{
  const eps: HookEvalEpisode[] = Array.from({ length: 12 }, (_, i) => ({
    id: `e${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), source: "snapshot", type: ONE,
    cands: [{ chosen: true, score: 60, feats: { zero_zero: 1, walk: 15 } }, { chosen: false, score: 60, feats: { zero_zero: 0, walk: 3 } }],
  }));
  const pr = pruneHookTable(eps, { 全体: ["zero_zero", "walk_near"] });
  t("下げる特徴（駅近が選ばなかった物に付く）は外し、上げる特徴は残す", JSON.stringify(pr.table) === JSON.stringify({ 全体: ["zero_zero"] }) && pr.dropped.length === 1 && pr.dropped[0].feature === "walk_near", JSON.stringify(pr));
}

console.log("■ 事実の埋め方（実物: 2026-10-06 エスフィールド 202 の🌟の本文の値）");
{
  const star = { rent: 84000, floor: 2, station: "十三", stations: [{ line: "・阪急京都線", walk: 13, station: "十三" }], equipment: ["オートロック", "宅配ボックス", "独立洗面台", "対面キッチン", "ネット無料"], floor_plan: "1LDK", walk_minutes: 13, admin_fee_yen: 6000, deposit_months: 0, key_money_months: 0 };
  const cand = { name: "エスフィールド", room_no: "202", is_star: true, image_url: "https://x/a.jpg" };
  const f = fillArrivalFacts({
    name: "エスフィールド", room: "202", sentAt: "2026-10-06T09:57:35.751Z", starTextFacts: star, cand,
    imageByUrl: (u) => (u === "https://x/a.jpg" ? { image_url: u, property_name: "エスフィールド", room_no: "202", facts: { room_no: "202", area_sqm: 38, built_ym: "2014-03", rent: 99999 } } : null),
    convImages: [{ image_url: "https://x/b.jpg", property_name: "エスフィールド", room_no: "202", facts: { room_no: "305", structure: "木造" } }],
    rentObservation: { rent: 84000, admin_fee: 6000, structure: "RC", ad_yen: 84000 },
  });
  t("🌟の本文の値が先（家賃は画像の読みで上書きしない）", f.rent === 84000 && f._src.rent === "🌟の本文");
  t("本文に無い広さ・築年は送った画像から", f.area_sqm === 38 && f._src.area_sqm === "送った画像" && f.building_age === 12);
  t("号室が違う画像の読み（結び違い）は使わない＝構造は相場の部屋の RC", f.structure === "RC" && f._src.structure === "相場の部屋");
  t("AD は相場の部屋の AD 円 ÷ 家賃", f.ad_months === 1);
  const ft = hookFeatsOfFacts(f, 120000);
  t("家賃÷上限は (家賃＋管理費)÷上限（採点の rent_ratio と同じ）", ft.rent_ratio === 0.75 && ft.zero_zero === 1 && ft.walk === 13);
  t("上限が分からなければ家賃の比は null", hookFeatsOfFacts(f, null).rent_ratio === null);
  const g = fillArrivalFacts({ name: "エスフィールド", room: "202", sentAt: "2026-10-06T00:00:00Z", pickups: [{ property_name: "エスフィールド", room_no: "202", summary_text: null, terms: { buildingAge: 12, deposit: 0, keyMoney: 1 } }, { property_name: "別の建物", room_no: "202", terms: { buildingAge: 40 } }] });
  t("売上サポの行は同じ物件だけ（築年・敷礼）", g.building_age === 12 && g.key_money_months === 1);
  t("新着1件の🌟の見分け: 候補1件以下", isNewArrivalSnapshot({ star_name: "A", candidate_count: 1, star_text: "🌟A\n…" }));
  t("新着1件の🌟の見分け: 本文の2行目が新着", isNewArrivalSnapshot({ star_name: "A", candidate_count: 5, star_text: "🌟A 202\n1件新着でかなりオススメ" }));
  t("束の🌟は新着でない", !isNewArrivalSnapshot({ star_name: "A", candidate_count: 5, star_text: "🌟A 202\n今回お送りした中でも" }));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
