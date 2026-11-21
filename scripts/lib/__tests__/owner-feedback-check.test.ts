// scripts/lib/__tests__/owner-feedback-check.test.ts — 指摘の型の点検の純関数（2026-11-21 作業員N）
//   実行: npx tsx scripts/lib/__tests__/owner-feedback-check.test.ts
import { multiMeaningKeys } from "../../owner-feedback-check";
import { weakLinksOf } from "../../check-linkage";
import { missOf } from "../../check-conductor";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const mm = multiMeaningKeys([
  { id: "a", key: "property_pickups", readers: ["x"] }, { id: "b", key: "property_pickups", readers: ["y", "z"] },
  { id: "c", key: "meta.one", readers: ["p", "q", "r", "s"] }, { id: "d", key: "meta.two", readers: ["p"] },
]);
t("同じ欄を2行が使う", mm.some((m) => m.key === "property_pickups" && m.ids.length === 2));
t("読む側4つ以上", mm.some((m) => m.key === "meta.one"));
t("1行・読む側1つは出さない", !mm.some((m) => m.key === "meta.two"));

const wl = weakLinksOf(
  [{ id: "r1", status: "connected", why: "", fill: 0.9 }, { id: "r2", status: "parent_off", why: "off", fill: null }, { id: "r3", status: "unknown", why: "", fill: null }],
  [{ key: "f1", val: 10, writerOk: 2, inDraft: 1 }, { key: "f2", val: 10, writerOk: 9, inDraft: 1 }, { key: "f3", val: 0, writerOk: 0, inDraft: 0 }],
  () => "作業員L",
);
t("つながりの割合は測れた行だけ", wl.score === 50 && wl.measured === 2);
t("届いていない欄と使われていない欄", wl.weak.some((w) => w.id === "writer.f1" && w.kind === "not_delivered") && wl.weak.some((w) => w.id === "writer.f2" && w.kind === "delivered_unused"));
t("値の無い欄は出さない", !wl.weak.some((w) => w.id === "writer.f3"));

t("ブレイン返信・竹内さん AIX＝AIX の番を返信", missOf("different", "auto_reply", null, { staff_aix: ["property_check_result"] })?.cause === "aix_turn_as_reply");
t("ブレイン AIX・竹内さん返信＝読み違い", missOf("different", "aix", "estimate_sheet", { staff_aix: [] })?.type === "aix_not_reply");
t("返信どうしで事実の食い違い＝材料", missOf("different", "auto_reply", null, { reason: "fact_conflict" })?.cause === "material");
t("一致は外れにしない", missOf("same", "aix", "x", {}) === null);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
