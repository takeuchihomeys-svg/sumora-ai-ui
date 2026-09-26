// 2026-09-25 竹内「画像で分析必要なお客さんなら画像で分析の点、画像で分析不要なお客さんは判定した点」
//            「最後にスタッフモードで指定したお客さん…10分たてば自動的に送られた物件まとめて…まとめて判定する」
// 👑 のお客様ごとの決め方（pickup-best）と 10分の自動まとめ（pickup-complete）のテスト。
// 実行: npx tsx app/lib/__tests__/pickup-auto-complete.test.ts
// 形は実例（リアプロの回＋数分あけて itandi の回）。お客様の情報は無い
import { pickCustomerBest, bestBasisFor, customerImageNeed, bestPointLabel, type BestCandidateRow } from "../pickup-best";
import { joinableGroupId } from "../pickup-complete";
import { pickAutoTargets, type AutoRow } from "../pickup-auto-targets";
import { rankCompleteGroup, autoCompleteDue, isQuietFor, lastOpenAt, completeGroupId, selectCompleteTargets, AUTO_COMPLETE_QUIET_MS, AUTO_COMPLETE_QUIET_MINUTES, type CompleteRankRow, type AutoCompleteRow } from "../pickup-complete";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const row = (id: number, batch: string, at: string, rank: number, opts: { match?: number | null; score?: number | null; verdict?: string; recommended?: number; status?: string } = {}): BestCandidateRow & CompleteRankRow => ({
  id, batch_id: batch, created_at: at, rank, status: opts.status ?? "pending", recommended: opts.recommended ?? 0, property_name: `物件${id}`,
  verdict: opts.verdict ?? "pass", score: opts.score ?? null,
  image_analysis: opts.match === undefined ? null : { match: opts.match, match_raw: opts.match },
});
const RP = "2026-09-25T02:00:00Z", IT = "2026-09-25T02:04:00Z";

console.log("\n■ お客様の決まり（画像で分析が必要か）");
{
  // 2026-09-25 竹内「総合的に判定されたのみにする」: 画像で分析が要るお客様でも 👑 は総合の判定の点
  t("recommended でも → score（総合の判定の点）", bestBasisFor({ level: "recommended" }) === "score");
  t("optional → score", bestBasisFor({ level: "optional" }) === "score");
  t("none → score", bestBasisFor({ level: "none" }) === "score");
  t("分からない（null）→ score", bestBasisFor(null) === "score");
  const wic = customerImageNeed([], { preferences: "ウォークインクローゼットがある部屋", ng_points: null, other_requests: null, additional_conditions: null });
  t("条件欄に WIC → recommended（画像で分析が必要）", wic.level === "recommended" && wic.from === "conditions", wic);
  const none = customerImageNeed([], { preferences: null, ng_points: null, other_requests: null, additional_conditions: null });
  t("条件欄が空 → 画像で分析は不要", bestBasisFor(none) === "score", none);
  const saved = customerImageNeed([{ image_analysis: { wants: [{ id: "w1", source: "条件", text: "対面キッチン", topics: ["キッチン"], ng: false, must: false }] } }], null);
  t("分析済みの回の希望があればそれを使う（from=analysis）", saved.from === "analysis" && saved.level === "recommended", saved);
}

console.log("\n■ 👑: 画像で分析が必要なお客様（画像の点）");
{
  // リアプロ: 判定の点が高いが画像の点は低い／itandi: 判定の点は低いが画像の点が高い
  const rows = [
    row(1, "rp", RP, 1, { score: 90, match: 60 }),
    row(2, "rp", RP, 2, { score: 70, match: null }),
    row(3, "it", IT, 1, { score: 50, match: 95 }),
    row(4, "it", IT, 2, { score: 85 }), // まだ分析していない
  ];
  const b = pickCustomerBest(rows, { basis: "image" });
  t("画像の点が一番の物件（判定の点が低くても）", b?.id === 3 && b.basis === "image", b);
  t("画像の点が無い物件は判定の点が高くても 👑 にしない", b?.id !== 4 && b?.id !== 1);
  t("点の出し方は画像の点", b ? bestPointLabel(b) === "95点" : false, b);
  const tie = pickCustomerBest([row(1, "rp", RP, 1, { score: 60, match: 90 }), row(2, "it", IT, 1, { score: 80, match: 90 })], { basis: "image" });
  t("画像の点が同じなら判定の点", tie?.id === 2, tie);
  const noImg = pickCustomerBest([row(1, "rp", RP, 1, { score: 60 }), row(2, "it", IT, 1, { score: 80 })], { basis: "image" });
  t("画像の点が1件も無ければ判定の点で補う（basis=score）", noImg?.id === 2 && noImg.basis === "score", noImg);
  const hold = pickCustomerBest([row(1, "rp", RP, 1, { score: 90, match: 100, verdict: "hold", recommended: 2 }), row(2, "it", IT, 1, { score: 50, match: 100 })], { basis: "image" });
  t("同じ画像の点なら保留（🌟★）より通す物件（前の決まり）", hold?.id === 2, hold);
}

console.log("\n■ 👑: 画像で分析が不要なお客様（判定の点）");
{
  const rows = [
    row(1, "rp", RP, 1, { score: 90, match: 40 }),
    row(2, "rp", RP, 2, { score: 70, match: 100 }),
    row(3, "it", IT, 1, { score: 88 }),
  ];
  const b = pickCustomerBest(rows, { basis: "score" });
  t("判定の点が一番の物件（画像の点が高い物件より）", b?.id === 1 && b.basis === "score", b);
  t("点の出し方は「判定 N点」", b ? bestPointLabel(b) === "判定 90点" : false, b);
  const star = pickCustomerBest([row(1, "rp", RP, 1, { score: 80 }), row(2, "rp", RP, 2, { score: 80, recommended: 1 })], { basis: "score" });
  t("同じ判定の点なら 🌟", star?.id === 2, star);
  const newer = pickCustomerBest([row(1, "rp", RP, 1, { score: 80 }), row(2, "it", IT, 1, { score: 80 })], { basis: "score" });
  t("同じ判定の点・🌟 も同じなら新しい回", newer?.id === 2, newer);
  const hold = pickCustomerBest([row(1, "rp", RP, 1, { score: 80, verdict: "hold", recommended: 2 }), row(2, "rp", RP, 2, { score: 80 })], { basis: "score" });
  t("同じ判定の点なら保留（🌟★）より通す物件", hold?.id === 2, hold);
  const drop = pickCustomerBest([row(1, "rp", RP, 1, { score: 95, verdict: "drop" }), row(2, "rp", RP, 2, { score: 40 })], { basis: "score" });
  t("外す候補は判定の点が高くても 👑 にしない", drop?.id === 2, drop);
  const sent = pickCustomerBest([row(1, "rp", RP, 1, { score: 95, status: "sent" }), row(2, "rp", RP, 2, { score: 40 })], { basis: "score" });
  t("送った物件は 👑 にしない", sent?.id === 2, sent);
  const old = pickCustomerBest([row(1, "rp", RP, 1, { match: 70 }), row(2, "rp", RP, 2, { match: 90 })], { basis: "score" });
  t("判定の点が無い古い行だけなら画像の点で補う", old?.id === 2 && old.basis === "image", old);
  t("どちらの点も無ければ null", pickCustomerBest([row(1, "rp", RP, 1)], { basis: "score" }) === null);
  const pref = pickCustomerBest(rows, { basis: "score", preferId: 3 });
  t("まとめの best_id（preferId）が候補ならそれ", pref?.id === 3, pref);
  const prefGone = pickCustomerBest([row(1, "rp", RP, 1, { score: 90 }), row(3, "it", IT, 1, { score: 88, status: "sent" })], { basis: "score", preferId: 3 });
  t("best_id を送った後は並び直した一番", prefGone?.id === 1, prefGone);
}

console.log("\n■ まとめ（完了の API）の 👑 と順位も同じ関数");
{
  const rows = [
    row(1, "rp", RP, 1, { score: 90, match: 60 }),
    row(2, "rp", RP, 2, { score: 70, match: 100 }),
    row(3, "it", IT, 1, { score: 88 }),
  ];
  const img = rankCompleteGroup(rows, { basis: "image" });
  t("画像が要るお客様: best_id は画像の点の一番", img.bestId === 2 && img.bestBasis === "image", img);
  t("👑 はまとめの順位でも1番", img.order[0]?.id === 2, img.order);
  const sc = rankCompleteGroup(rows, { basis: "score" });
  t("画像が要らないお客様: best_id は判定の点の一番", sc.bestId === 1 && sc.bestBasis === "score", sc);
  t("画面（pickCustomerBest）とまとめ（rankCompleteGroup）が同じ 👑", pickCustomerBest(rows, { basis: "score", windowHours: 49 })?.id === sc.bestId && pickCustomerBest(rows, { basis: "image", windowHours: 49 })?.id === img.bestId);
}

console.log("\n■ 10分の判定（境目）");
{
  const last = Date.parse("2026-09-25T02:04:00Z");
  // 2026-09-26 10分 → 3分（分かれて届く間隔の実測 最大122秒・後から届いた回は joinableGroupId で前のまとめに足す）
  t(`${AUTO_COMPLETE_QUIET_MINUTES}分`, AUTO_COMPLETE_QUIET_MINUTES === 3 && AUTO_COMPLETE_QUIET_MS === 180_000);
  t("2分59秒999 はまだ", !isQuietFor(last, last + 179_999));
  t("ちょうど3分でまとめる", isQuietFor(last, last + 180_000));
  t("3分1秒もまとめる", isQuietFor(last, last + 181_000));
  t("分かれて届く最大の間（122秒）ではまとめない", !isQuietFor(last, last + 122_000));
  t("未来の時刻（時計のずれ）はまとめない", !isQuietFor(last + 60_000, last));
  t("時刻が読めなければまとめない", !isQuietFor(NaN, last));
  t("最後に届いた時刻はまとめていない行の一番新しい物", lastOpenAt([
    { created_at: "2026-09-25T02:00:00Z", complete_group_id: null },
    { created_at: "2026-09-25T02:04:00Z", complete_group_id: null },
    { created_at: "2026-09-25T02:09:00Z", complete_group_id: "cg_x_1" },
  ]) === last);
  t("まとめていない行が無ければ null", lastOpenAt([{ created_at: "2026-09-25T02:09:00Z", complete_group_id: "cg_x_1" }]) === null);
}

console.log("\n■ 自動でまとめるお客様の選び方");
{
  const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002", C = "cccccccc-0000-0000-0000-000000000003";
  const now = Date.parse("2026-09-25T02:14:00Z");
  const rows: AutoCompleteRow[] = [
    // A: リアプロ 02:00・itandi 02:04 → 02:14 でちょうど10分 → まとめる
    { id: 1, created_at: "2026-09-25T02:00:00Z", property_customer_id: A, complete_group_id: null },
    { id: 2, created_at: "2026-09-25T02:04:00Z", property_customer_id: A, complete_group_id: null },
    // B: リアプロ 02:00・itandi 02:08 → まだ6分 → 待つ（due_at 02:18）
    { id: 3, created_at: "2026-09-25T02:00:00Z", property_customer_id: B, complete_group_id: null },
    { id: 4, created_at: "2026-09-25T02:08:00Z", property_customer_id: B, complete_group_id: null },
    // C: もうまとめてある → 何もしない
    { id: 5, created_at: "2026-09-25T01:00:00Z", property_customer_id: C, complete_group_id: "cg_cccccccc_5" },
    // お客様の無い行・24時間より前の行は拾わない
    { id: 6, created_at: "2026-09-25T01:00:00Z", property_customer_id: null, complete_group_id: null },
    { id: 7, created_at: "2026-09-24T01:00:00Z", property_customer_id: C, complete_group_id: null },
  ];
  // この例は 10分の静けさで書いた例（quietMs を渡す）。既定の3分は上の境目のテスト
  const Q10 = 600_000;
  const r = autoCompleteDue(rows, now, Q10);
  t("A はまとめる（2件）", r.due.length === 1 && r.due[0].property_customer_id === A && r.due[0].open === 2, r.due);
  t("B は待つ（最後の itandi から10分＝02:18）", r.waiting.length === 1 && r.waiting[0].property_customer_id === B && r.waiting[0].due_at === "2026-09-25T02:18:00.000Z", r.waiting);
  t("まとめ済み・お客様なし・24時間より前は拾わない", !r.due.concat(r.waiting).some((x) => x.property_customer_id === C));
  const later = autoCompleteDue(rows, Date.parse("2026-09-25T02:18:00Z"), Q10);
  t("02:18 には B もまとめる", later.due.map((x) => x.property_customer_id).join(",") === [A, B].join(","), later.due);
}

console.log("\n■ 冪等（Cron・拡張の alarm・画面が同時に動いても同じまとめ）");
{
  const PC = "aaaaaaaa-0000-0000-0000-000000000001";
  const now = Date.parse("2026-09-25T02:14:00Z");
  const src = [
    { id: 101, created_at: "2026-09-25T02:00:00Z", batch_id: "rp", site: "realpro", status: "pending", complete_group_id: null },
    { id: 102, created_at: "2026-09-25T02:04:00Z", batch_id: "it", site: "itandi", status: "pending", complete_group_id: null },
  ];
  const a = selectCompleteTargets(src, now), b = selectCompleteTargets(src, now + 90_000);
  t("別の入口が別の時刻に選んでも同じまとめ ID", completeGroupId(PC, a.ids) === completeGroupId(PC, b.ids) && completeGroupId(PC, a.ids) === "cg_aaaaaaaa_101");
  const after = selectCompleteTargets(src.map((r) => ({ ...r, complete_group_id: "cg_aaaaaaaa_101" })), now);
  t("まとめた後は対象 0件（2回目は何もしない）", after.ids.length === 0 && after.latestGroupId === "cg_aaaaaaaa_101", after);
  const next = selectCompleteTargets([...src.map((r) => ({ ...r, complete_group_id: "cg_aaaaaaaa_101" })), { id: 130, created_at: "2026-09-25T03:00:00Z", batch_id: "rp2", site: "realpro", status: "pending", complete_group_id: null }], Date.parse("2026-09-25T03:10:00Z"));
  t("後から届いた回は別のまとめ（新しい ID）", completeGroupId(PC, next.ids) === "cg_aaaaaaaa_130", next);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
