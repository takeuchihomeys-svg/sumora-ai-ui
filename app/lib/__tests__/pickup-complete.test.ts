// 2026-09-25 竹内「まとめられていない。完了ボタン押したらリアプロと itandi の全部分析されるようにする」— 完了でまとめる決まりのテスト
// 実行: npx tsx app/lib/__tests__/pickup-complete.test.ts
// 形は実例（同じお客様にリアプロ 10件＋1件・itandi 7件が別々の回で届く）。お客様の情報は無い
import { selectCompleteTargets, completeGroupId, rankCompleteGroup, compareCompleteGroup, completeAuthOk, completeToastJa, COMPLETE_WINDOW_HOURS, type CompleteSourceRow, type CompleteRankRow } from "../pickup-complete";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const NOW = Date.parse("2026-09-25T09:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const PC = "11111111-2222-3333-4444-555555555555";

console.log("\n■ 対象の選び方（前の完了より後・最大24時間・サイトを問わず全部）");
{
  const rows: CompleteSourceRow[] = [
    { id: 10, created_at: ago(30), batch_id: "old", site: "realpro", status: "pending", complete_group_id: null },       // 24時間より前 → 入れない
    { id: 20, created_at: ago(5), batch_id: "g1", site: "realpro", status: "pending", complete_group_id: "cg_x_20" },   // 前の完了 → 入れない
    { id: 30, created_at: ago(2), batch_id: "rp1", site: "realpro", status: "pending", complete_group_id: null },
    { id: 31, created_at: ago(2), batch_id: "rp1", site: "realpro", status: "sent", complete_group_id: null },           // 送った物も入れる
    { id: 40, created_at: ago(1), batch_id: "it1", site: "itandi", status: "pending", complete_group_id: null },
    { id: 41, created_at: ago(1), batch_id: "it1", site: "itandi", status: "pending", complete_group_id: null },
    { id: 50, created_at: ago(0.5), batch_id: "re1", site: "reins", status: "pending", complete_group_id: null },
  ];
  const s = selectCompleteTargets(rows, NOW);
  t("24時間より前と前の完了の行は入れない・送った行は入れる", JSON.stringify(s.ids) === JSON.stringify([30, 31, 40, 41, 50]), s.ids);
  t("回（batch）は3つ", s.batchIds.length === 3, s.batchIds);
  t("サイトごとの件数", JSON.stringify(s.sites) === JSON.stringify({ realpro: 2, itandi: 2, reins: 1 }), s.sites);
  t("前の完了の数と ID", s.alreadyGrouped === 1 && s.latestGroupId === "cg_x_20", s);
  t("窓は24時間", COMPLETE_WINDOW_HOURS === 24);
  const none = selectCompleteTargets(rows.map((r) => ({ ...r, complete_group_id: r.complete_group_id ?? "cg_y_30" })), NOW);
  t("全部まとめ済みなら 0件・一番新しいまとめを返す", none.ids.length === 0 && none.latestGroupId === "cg_y_30", none);
  t("何も無いお客様", selectCompleteTargets([], NOW).ids.length === 0);
  t("未来の日付（時計のずれ 1分超）は入れない", selectCompleteTargets([{ id: 1, created_at: new Date(NOW + 5 * 60_000).toISOString(), batch_id: "f", site: "itandi", status: "pending", complete_group_id: null }], NOW).ids.length === 0);
}

console.log("\n■ まとめ ID（二重押し・2台の PC で同じになる）");
{
  t("一番古い行の id とお客様から決まる", completeGroupId(PC, [41, 30, 40]) === "cg_11111111_30", completeGroupId(PC, [41, 30, 40]));
  t("並びが違っても同じ", completeGroupId(PC, [30, 40, 41]) === completeGroupId(PC, [41, 40, 30]));
  t("対象なしは null", completeGroupId(PC, []) === null);
  t("お客様なしは null", completeGroupId("", [1]) === null);
}

console.log("\n■ 冪等（DB の「complete_group_id が空の行だけ書く」をまねて、2台が同時に押した時）");
{
  // DB の行
  const db: CompleteSourceRow[] = [30, 31, 40, 41].map((id) => ({ id, created_at: ago(id < 40 ? 2 : 1), batch_id: id < 40 ? "rp" : "it", site: id < 40 ? "realpro" : "itandi", status: "pending", complete_group_id: null }));
  const claim = (read: CompleteSourceRow[]) => {
    const s = selectCompleteTargets(read, NOW);
    const gid = completeGroupId(PC, s.ids);
    const got: number[] = [];
    for (const r of db) if (s.ids.includes(r.id) && r.complete_group_id == null) { r.complete_group_id = gid; got.push(r.id); }
    return { gid, got };
  };
  // 2台とも書く前に読んだ（同じ対象）→ 同じ ID・行を取るのは先の1台だけ
  const snapA = db.map((r) => ({ ...r })), snapB = db.map((r) => ({ ...r }));
  const a = claim(snapA), b = claim(snapB);
  t("同じまとめ ID", a.gid === b.gid && a.gid === "cg_11111111_30", { a, b });
  t("先の1台が4件・後の1台は0件（読みもしない）", a.got.length === 4 && b.got.length === 0, { a, b });
  // 二重押し（後から読んだ）→ 0件
  const c = claim(db.map((r) => ({ ...r })));
  t("二重押しは 0件", c.got.length === 0 && c.gid === null, c);
  // 完了の後に新しい回が届いた → 次の完了で別のまとめ
  db.push({ id: 60, created_at: ago(0.1), batch_id: "it2", site: "itandi", status: "pending", complete_group_id: null });
  const d = claim(db.map((r) => ({ ...r })));
  t("次の完了は新しい回だけで別のまとめ", d.gid === "cg_11111111_60" && JSON.stringify(d.got) === "[60]", d);
}

console.log("\n■ まとめた全件での順位と 👑（リアプロと itandi をまたぐ）");
const R = (id: number, batch: string, site: string, at: string, rank: number, score: number | null, extra?: Partial<CompleteRankRow>): CompleteRankRow => ({
  id, batch_id: batch, site, created_at: at, rank, status: "pending", recommended: 0, property_name: `物件${id}`, verdict: "pass", score, image_analysis: null, ...extra,
});
{
  const rows = [
    R(30, "rp", "realpro", ago(2), 1, 80, { recommended: 2 }),   // リアプロの回の 🌟★
    R(31, "rp", "realpro", ago(2), 2, 95),
    R(32, "rp", "realpro", ago(2), 3, 20, { verdict: "drop" }),
    R(40, "it", "itandi", ago(1), 1, 105, { recommended: 2 }),   // itandi の回の 🌟★・点が一番
    R(41, "it", "itandi", ago(1), 2, null),
    R(42, "it", "itandi", ago(1), 3, 95, { verdict: "hold" }),
  ];
  const r = rankCompleteGroup(rows);
  t("点の高い順・同点は通す＞保留・点なしは後・外す候補は最後", JSON.stringify(r.order.map((o) => o.id)) === JSON.stringify([40, 31, 42, 30, 41, 32]), r.order);
  t("順位は1から", r.order[0].complete_rank === 1 && r.order[5].complete_rank === 6);
  t("画像の点が無い時の 👑 は点の一番（サイトをまたぐ）", r.bestId === 40 && r.bestBasis === "score" && r.bestScore === 105, r);
  t("回の数・件数", r.batches === 2 && r.items === 6 && r.notAnalyzed === 6);

  // 画像で分析した点がある → 画面の 👑 と同じ（pickCustomerBest）で、まとめた全件から選ぶ（リアプロの回の物件が itandi の回より上）
  const img = rows.map((x) => x.id === 31 ? { ...x, image_analysis: { match: 100, match_raw: 100, ok_count: 3 } }
    : x.id === 40 ? { ...x, image_analysis: { match: 80, match_raw: 80, ok_count: 2 } } : x);
  const r2 = rankCompleteGroup(img);
  t("👑 は画像の点の一番（別のサイトの回でも）", r2.bestId === 31 && r2.bestBasis === "image" && r2.bestMatch === 100, r2);
  t("画像の点が付いた数", r2.imageScored === 2);

  // 送った物件は 👑 にしない（未送信だけ）
  const sent = rows.map((x) => x.id === 40 ? { ...x, status: "sent" } : x);
  t("送った物件は 👑 にしない（点の一番の次）", rankCompleteGroup(sent).bestId === 31, rankCompleteGroup(sent).bestId);
  // 全部外す候補 → 👑 なし
  t("全部外す候補なら 👑 なし", rankCompleteGroup(rows.map((x) => ({ ...x, verdict: "drop" }))).bestId === null);
  t("空", rankCompleteGroup([]).bestId === null && rankCompleteGroup([]).order.length === 0);
  // 同点・同じ判定は 🌟 → 新しい回
  const tie = [R(1, "a", "realpro", ago(3), 1, 90), R(2, "b", "itandi", ago(1), 1, 90), R(3, "a", "realpro", ago(3), 2, 90, { recommended: 1 })];
  t("同点は 🌟 → 新しい回", JSON.stringify(tie.slice().sort(compareCompleteGroup).map((x) => x.id)) === "[3,2,1]", tie.slice().sort(compareCompleteGroup).map((x) => x.id));
}

console.log("\n■ 認証（アプリは内部認証・拡張は自動化の鍵）");
{
  t("内部認証で通る", completeAuthOk({ authorization: "Bearer s", automationKey: null }, { internalSecret: "s", automationKey: "k" }));
  t("拡張の鍵で通る", completeAuthOk({ authorization: null, automationKey: "k" }, { internalSecret: "s", automationKey: "k" }));
  t("鍵違いは通さない", !completeAuthOk({ authorization: "Bearer x", automationKey: "x" }, { internalSecret: "s", automationKey: "k" }));
  t("自動化の鍵が未設定のサーバーは自動化の API と同じく通す", completeAuthOk({ authorization: null, automationKey: null }, { internalSecret: "s", automationKey: null }));
}

console.log("\n■ 拡張のトースト");
{
  t("件数とサイト", completeToastJa({ claimed: 17, sites: { realpro: 10, itandi: 7 } }).startsWith("売上サポにまとめました: リアプロ 10件・itandi 7件"), completeToastJa({ claimed: 17, sites: { realpro: 10, itandi: 7 } }));
  t("もうまとめてある", completeToastJa({ claimed: 0, sites: {}, already: true }).includes("もうまとめてあります"));
  t("ブレイン OFF は出さない", completeToastJa({ claimed: 0, sites: {}, skipped: "brain_off" }) === "");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
