// 2026-10-23 優先順位の段（brain-priority.ts）: 整え・抜けの確かめ・AIX とのそろえ・書く役への行・取り寄せの選び
// 実行: npx tsx app/lib/__tests__/brain-priority.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { normalizePriorities, ensureAsksCovered, reconcilePrioritiesWithAix, renderPrioritiesNote, priorityStepOn, priorityRetrievalOn, renderPulledBlock, askCovered, priorityKbP1On } from "../brain-priority";
import { pickPulledRows, isReplyP0, isReplyP1Decision } from "../brain-priority-server";
import type { RagRow } from "../design-knowledge-rag";

let passed = 0, failed = 0; const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; failures.push(`${name} ${detail}`); } }

// スイッチ
ok("既定 off", !priorityStepOn({}));
ok("on", priorityStepOn({ BRAIN_PRIORITY_STEP: "on" }));
ok("取り寄せは STEP に従う", priorityRetrievalOn({ BRAIN_PRIORITY_STEP: "on" }) && !priorityRetrievalOn({}) && !priorityRetrievalOn({ BRAIN_PRIORITY_STEP: "on", BRAIN_PRIORITY_RETRIEVAL: "off" }));

// 整え
const raw = [
  { rank: 2, kind: "asked", item: "駐車場の有無", quote: "駐車場ありますか？", handling: "aix", aix: "property_check_result", reason: "空きはスタッフしか知らない" },
  { rank: 1, kind: "asked", item: "初期費用", quote: "初期費用いくらですか", handling: "confirm", aix: "x", reason: "見積は作る" },
  { rank: 3, kind: "convey", item: "内覧のお誘い", quote: "null", handling: "weird", aix: null, reason: "申込の前の駅" },
  null, { item: "" },
];
const n = normalizePriorities(raw);
ok("並べ直す", n.map((p) => p.item).join(",") === "初期費用,駐車場の有無,内覧のお誘い", JSON.stringify(n));
ok("順位を振り直す", n.map((p) => p.rank).join(",") === "1,2,3");
ok("aix 以外はキー無し", n[0].aix === null && n[1].aix === "property_check_result");
ok("型の外れは answer_now", n[2].handling === "answer_now" && n[2].quote === null && n[2].kind === "convey");
ok("配列でなければ空", normalizePriorities({}).length === 0);

// 抜けの確かめ
ok("同じ文", askCovered("駐車場ありますか？", n));
const cov = ensureAsksCovered(n, [{ quote: "駐車場ありますか", route: "aix", aix: "property_check_result" }, { quote: "ペットは飼えますか？", route: "promise" }]);
ok("抜けは1つ", cov.dropped === 1 && cov.total === 2, JSON.stringify(cov));
ok("抜けは後ろに足す", cov.items[cov.items.length - 1].quote === "ペットは飼えますか？" && cov.items[cov.items.length - 1].handling === "confirm" && cov.items[cov.items.length - 1].added === true);

// AIX とそろえる
const r1 = reconcilePrioritiesWithAix(n, null);
ok("AIX が無くなれば約束に", r1.toConfirm === 1 && r1.items[1].handling === "confirm" && r1.items[1].aix === null);
const r2 = reconcilePrioritiesWithAix(n, "estimate_sheet");
ok("違うキーは数えるだけ", r2.mismatch === 1 && r2.items[1].aix === "property_check_result");
const r3 = reconcilePrioritiesWithAix(n.filter((p) => p.handling !== "aix"), "estimate_sheet");
ok("AIX があるのに項目なし", r3.noItem);
ok("ピッカーつきは同じ", reconcilePrioritiesWithAix(n, "property_check_result/mgmt_parking").mismatch === 0);

// 書く役への行
const note = renderPrioritiesNote(n);
ok("行に順位と扱い", note.includes("1. 聞かれた事: 「初期費用いくらですか」") && note.includes("AIX で送る") && note.includes("理由: 申込の前の駅"), note);
ok("空なら空", renderPrioritiesNote([]) === "" && renderPrioritiesNote(undefined) === "");

// 取り寄せ
const row = (id: string, title: string, priority: number, tags: string[], created = "2026-10-20T00:00:00Z"): RagRow => ({ id: id.padEnd(36, "0"), title, insight: `${title}の本文`, priority, tags, is_current: true, created_at: created });
const rows: RagRow[] = [
  row("p0a", "AIX と返信の分け方", 0, ["AIX", "絶対・最優先"]),
  row("p0b", "RLS を最優先", 0, ["セキュリティ", "絶対・最優先"]),
  row("p0c", "点検の数", 0, ["AIX", "監査"]),
  row("d1", "【決定】内覧の日にちの指定は AIX【内覧へ】", 1, ["竹内さんの決定", "場面:内覧"]),
  row("d2", "【決定】内覧の当日の挨拶", 1, ["竹内さんの決定", "場面:内覧"]),
  row("d3", "【決定】やることリストの並び", 1, ["竹内さんの決定", "やることリスト", "場面:内覧"]),
  row("d4", "実装の知見", 2, ["場面:内覧"]),
];
ok("P0 の選び", isReplyP0(rows[0]) && !isReplyP0(rows[1]) && !isReplyP0(rows[2]));
ok("P1 の選び", isReplyP1Decision(rows[3]) && !isReplyP1Decision(rows[5]) && !isReplyP1Decision(rows[6]));
const picked0 = pickPulledRows(rows, "viewing", "土曜に内覧できますか", "2026-10-23T00:00:00Z", { p1: false });
ok("既定は P0 だけ（P1 の決定は引かない）", picked0.length === 1 && picked0[0].id.startsWith("p0a"), JSON.stringify(picked0.map((p) => p.id.slice(0, 3))));
const picked = pickPulledRows(rows, "viewing", "土曜に内覧できますか", "2026-10-23T00:00:00Z", { p1: true });
ok("P0 が先頭", picked[0].id.startsWith("p0a") && picked[0].priority === 0, JSON.stringify(picked.map((p) => p.id.slice(0, 3))));
ok("仕組みの行は引かない", !picked.some((p) => /^(p0b|p0c|d3|d4)/.test(p.id)));
ok("場面の決定を引く", picked.some((p) => p.id.startsWith("d1")) && picked.some((p) => p.id.startsWith("d2")));
const blk = renderPulledBlock("viewing", picked, { promise: true, sentProps: 2, customerMemory: false, examples: 3, judgeExamples: 1, timing: true, applyRoute: false });
ok("ブロックに★と目次", blk.includes("★AIX と返信の分け方") && blk.includes("送った物件=2件") && blk.includes("場面: viewing"), blk);
ok("P0 は題だけ（本文を切って入れない）", !blk.includes("AIX と返信の分け方の本文"), blk);
ok("P1 は参考の枠", blk.includes("状況が同じ時だけ当てる") && blk.includes("【決定】内覧の日にちの指定は AIX【内覧へ】"), blk);
// お礼だけの番の伝える事の AIX は後の番・聞かれた事は約束
const ackItems = normalizePriorities([{ rank: 1, kind: "convey", item: "ピックアップを送る", handling: "aix", aix: "property_send", reason: "約束の続き" }, { rank: 2, kind: "asked", item: "空き", quote: "空いてますか", handling: "aix", aix: "property_check_result", reason: "スタッフしか知らない" }]);
const ra = reconcilePrioritiesWithAix(ackItems, null, { ackOnly: true });
ok("お礼だけの番の伝える事は later", ra.items[0].handling === "later" && ra.toLater === 1 && ra.items[1].handling === "confirm" && ra.toConfirm === 1, JSON.stringify(ra));
ok("依頼がある番の伝える事は約束のまま", reconcilePrioritiesWithAix(ackItems, null).items[0].handling === "confirm");
ok("P1 のスイッチは既定 off", !priorityKbP1On({}) && priorityKbP1On({ BRAIN_PRIORITY_KB_P1: "on" }));

console.log(`brain-priority: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("FAIL", f); process.exit(1); }
