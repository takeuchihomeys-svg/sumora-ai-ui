// 試験の問題の帳面（exam-problem-ledger-core）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-problem-ledger.test.ts
import { kbIdsOf, ledgerSummary } from "../exam-problem-ledger-core";
let fail = 0, pass = 0;
function ok(name: string, cond: boolean, d = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${d ? `\n   ${d}` : ""}`); } }
const spec = [
  { id: "q1", type: "出し切り", conv: "c1", at: "2026-10-01T00:00:00Z", why: "竹内さんの決定 KB P1 a504029a と KB 1d2400c6" },
  { id: "q2", type: "出し切り", conv: "c2", at: "2026-10-01T00:00:00Z", source: "見張り" },
  { id: "q3", type: "内覧", conv: "c3", at: "2026-10-01T00:00:00Z", basis: { kb: "KB 5e006794" } },
];
ok("KB の id8 を拾う", kbIdsOf(spec[0]).join(",") === "a504029a,1d2400c6", kbIdsOf(spec[0]).join(","));
ok("basis（物）の中も拾う", kbIdsOf(spec[2]).join(",") === "5e006794");
const s = ledgerSummary(spec, { writerOf: (id) => (id === "q1" ? "takeuchi" : id === "q2" ? "employee" : null), gatedOf: (id) => (id === "q2" ? "申込へ押下の後" : null), retired: new Set(["5e006794"]) });
ok("書き手の数", s.takeuchi === 1 && s.employee === 1 && s.unknown === 1);
ok("申込以降", s.gated.length === 1 && s.gated[0].id === "q2");
ok("退役した根拠", s.retired.length === 1 && s.retired[0].id === "q3");
ok("手入れの案が3つ", s.lines.filter((l) => l.startsWith("- ") && /外す|書き直す|置き換える/.test(l)).length === 3, s.lines.join("\n"));
console.log(fail ? `FAIL ${fail}（PASS ${pass}）` : `ALL PASS ${pass}`);
process.exit(fail ? 1 : 0);
