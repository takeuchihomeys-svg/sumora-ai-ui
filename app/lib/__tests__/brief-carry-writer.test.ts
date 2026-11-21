// 前の番の要件の続きを書き手へ（BRIEF_CARRY_TO_WRITER・作業員M 2026-11-22・台帳 #595）
// 実行: npx tsx app/lib/__tests__/brief-carry-writer.test.ts
import { buildConductorBrief, briefSectionsForRole, briefCarryToWriterOn } from "../conductor-brief";
import { briefLineForRole } from "../compose-brief-roles";
export {};
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) pass++; else { fail++; console.error("NG", n, x ?? ""); } };
const meta = { ask_carry: { from_seen: "2026-11-22T00:00:00Z", open: ["qa1"], promised: ["qb2"], items: [
  { ask_id: "qa1", quote: "駐車場は空いていますか", state: "open", route: "reply", aix: null },
  { ask_id: "qb2", quote: "〇〇の募集状況", state: "promised", route: "aix", aix: "property_check_result" },
] } };
const b = buildConductorBrief(meta);
ok("指示書の carry_asks に要件の言葉（記録）", b.carry_asks?.quotes?.length === 2 && b.carry_asks.quotes[0].quote === "駐車場は空いていますか", b.carry_asks);
ok("既定 off: 書き手の役目に carry_asks は入らない", !briefCarryToWriterOn({}) && !briefSectionsForRole("head").includes("carry_asks"));
ok("on: 頭・信頼・AIX の2通目の役目に入る", briefSectionsForRole("head", { BRIEF_CARRY_TO_WRITER: "on" }).includes("carry_asks") && briefSectionsForRole("aix2", { BRIEF_CARRY_TO_WRITER: "on" }).includes("carry_asks"));
process.env.BRIEF_CARRY_TO_WRITER = "on";
const line = briefLineForRole({ conductor_brief: b }, "head") ?? "";
delete process.env.BRIEF_CARRY_TO_WRITER;
ok("on: 書き手の1行に前の番の続き（まだ答えていない／約束して結果がまだ）", line.includes("まだ答えていない要件 「駐車場は空いていますか」") && line.includes("約束して結果がまだ 「〇〇の募集状況」"), line);
ok("off: 書き手の1行に出ない", !(briefLineForRole({ conductor_brief: b }, "head") ?? "").includes("前の番の続き"));
console.log(`brief-carry-writer: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
