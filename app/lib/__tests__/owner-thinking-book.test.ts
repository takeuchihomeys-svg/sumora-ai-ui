// 2026-11-11 作業員9「竹内さんの考え方の本」（owner-thinking-book.ts）: 札・近さの下限・漏れ・理由と逆向きの切り出し
// 実行: npx tsx app/lib/__tests__/owner-thinking-book.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { pickBook, bookBlock, ruleOf, whyOf, dontOf, isBookCandidate, leakOverlap, toUnit, type BookRow } from "../owner-thinking-book";

let passed = 0, failed = 0; const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; failures.push(`${name} ${detail}`); } }

// 2次元の埋め込みで近さを作る（今の番は [1,0]）
const vec = (sim: number) => toUnit([sim, Math.sqrt(Math.max(0, 1 - sim * sim))]);
const row = (id: string, o: Partial<BookRow> & { sim: number }): BookRow => ({
  id: `${id}0000-0000`, title: o.title ?? `竹内さんの決定: ${id}`, insight: o.insight ?? "お客様への返信の決まり。", rationale: o.rationale ?? null,
  tags: o.tags ?? ["竹内さんの決定"], priority: o.priority ?? 1, created_at: o.created_at ?? "2026-10-20T00:00:00Z", embedding: vec(o.sim),
});
const turn = { turnEmb: [1, 0], turnText: "全部見て今日中にまた連絡します！家族とも相談してみます" };

// ① 題・理由・逆向き
ok("題の頭を外す", ruleOf("竹内さんの決定（11/05・No.40）: 物件を指した費用の不満は気に入り具合で分ける") === "物件を指した費用の不満は気に入り具合で分ける");
ok("【決定】を外す", ruleOf("【決定】リノベーション物件は築年数が古くても大丈夫") === "リノベーション物件は築年数が古くても大丈夫");
ok("なぜは根拠の頭", whyOf({ insight: "x", rationale: "本日と返すと催促に聞こえる。信用を頂く場面。三つ目。" }) === "本日と返すと催促に聞こえる。信用を頂く場面。");
ok("根拠が無ければ本文の『ため』の文", whyOf({ insight: "竹内さん 10/20「…」。名前を入れると覚えてくれていると伝わるため信頼になる。", rationale: null }).includes("ため"));
ok("しないは題の句から", dontOf({ title: "お客様の『今日中に連絡します』に『本日』を返さない — 名前を入れてサポートの姿勢", insight: "" }) === "お客様の『今日中に連絡します』に『本日』を返さない");
ok("引用の切れ端・数えは逆向きにしない", dontOf({ title: "x", insight: "竹内さん「ピックアップ出来次第ではない。」 何卒は 3%・付けない。" }) === "");

// ② 候補（P0・仕組みの行は外す）
ok("P0 は外す（別の枠）", !isBookCandidate(row("p0", { sim: 0.9, priority: 0 })));
ok("試験の行は外す", !isBookCandidate(row("ex", { sim: 0.9, title: "竹内さんの決定: 試験の費用を抑える", tags: ["竹内さんの決定", "試験"] })));
ok("番の決まりは入る", isBookCandidate(row("ok", { sim: 0.9 })));

// ③ 近さの下限・場面の札
const rows = [
  row("aaaa", { sim: 0.60, tags: ["竹内さんの決定", "場面:検討中"] }),
  row("bbbb", { sim: 0.50, tags: ["竹内さんの決定", "場面:検討中"] }), // 下限 0.52 未満
  row("cccc", { sim: 0.70, tags: ["竹内さんの決定", "場面:内覧"] }), // 別の場面の札
  row("dddd", { sim: 0.58, tags: ["竹内さんの決定"] }), // 札なし: 0.56 以上なら入る
  row("eeee", { sim: 0.54, tags: ["竹内さんの決定"] }), // 札なし: 0.56 未満
];
const ids = pickBook(rows, { scene: "considering", ...turn }).map((c) => c.id8.slice(0, 4));
ok("近さの下限と場面の札で選ぶ", JSON.stringify(ids) === JSON.stringify(["aaaa", "dddd"]), JSON.stringify(ids));
ok("短い文は札なしの下限が上がる", pickBook(rows, { scene: "considering", turnEmb: [1, 0], turnText: "よろしくお願いします" }).every((c) => c.id8.slice(0, 4) !== "dddd"));
ok("上限の枚数", pickBook([...rows, row("ffff", { sim: 0.65, tags: ["竹内さんの決定", "場面:検討中"] }), row("gggg", { sim: 0.66, tags: ["竹内さんの決定", "場面:検討中"] })], { scene: "considering", ...turn, max: 2 }).length === 2);
ok("場面が other でも札なしの行は近ければ入る", pickBook(rows, { scene: "other", ...turn }).map((c) => c.id8.slice(0, 4)).join() === "dddd");

// ④ 答えの漏れ: 今の番の文が本文に入っている行は外す
ok("重なりの見分け", leakOverlap("例: お客様『全部見て今日中にまた連絡します！』に本日を返さない", "全部見て今日中にまた連絡します！家族とも相談してみます"));
ok("短い文は重なりと見ない", !leakOverlap("よろしくお願いします", "よろしく"));
const leak = [row("hhhh", { sim: 0.8, tags: ["竹内さんの決定", "場面:検討中"], insight: "例『全部見て今日中にまた連絡します！』" })];
ok("漏れの行は入れない", pickBook(leak, { scene: "considering", ...turn }).length === 0);
ok("時刻の線（before）より後の行は入れない", pickBook([row("iiii", { sim: 0.8, tags: ["竹内さんの決定", "場面:検討中"], created_at: "2026-11-01T00:00:00Z" })], { scene: "considering", ...turn, before: "2026-10-01T00:00:00Z" }).length === 0);

// ⑤ 塊
ok("無ければ空", bookBlock([]) === "");
const blk = bookBlock(pickBook([row("jjjj", { sim: 0.7, title: "【決定】本日を返さない — 名前を入れる", rationale: "催促に聞こえるため。", tags: ["竹内さんの決定", "場面:検討中"] })], { scene: "considering", ...turn }));
ok("見出しに当てはまる時だけ", blk.includes("当てはまる時だけ参考にする・状況が違えば使わない"));
ok("決まり・なぜ・しないが揃う", blk.includes("決まり: 本日を返さない") && blk.includes("なぜ: 催促に聞こえるため。") && blk.includes("しない: 本日を返さない"), blk);

console.log(`owner-thinking-book: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("FAIL", f); process.exit(1); }
