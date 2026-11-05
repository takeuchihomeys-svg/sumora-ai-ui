// 試験の写しの確かめ（scripts/lib/exam-copy-check.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-copy-check.test.ts（全 PASS で exit 0）
import { leftoverBefore, verifyLedgerCounts, verifyMessages, verifyCopy } from "../exam-copy-check";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

ok("残り: 0 なら無し", leftoverBefore({ sent_properties: 0, aix_usage_logs: 0 }).length === 0);
ok("残り: 11/05 の YUMA2 の形（349件）を出す", leftoverBefore({ sent_properties: 349 })[0]?.detail.includes("349") === true);
ok("数: 同じ", verifyLedgerCounts({ sent_properties: 13, aix_usage_logs: 4 }, { sent_properties: 13, aix_usage_logs: 4 }).length === 0);
{
  const r = verifyLedgerCounts({ sent_properties: 13 }, { sent_properties: 32, aix_usage_logs: 3 });
  ok("数: 他の回の行が入った（13→32・写しに無い表）", r.length === 2 && r[0].kind === "count");
}
const t0 = Date.parse("2026-11-05T01:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
{
  const orig = [{ at: at(0) }, { at: at(300) }, { at: at(600) }];
  ok("通: 元の間で写した→無し", verifyMessages(orig, [{ at: at(10) }, { at: at(310) }, { at: at(610) }]).length === 0);
  const r = verifyMessages(orig, [{ at: at(0) }, { at: at(90) }, { at: at(180) }]);
  ok("通: 90秒おきに詰めた（11/05 q212 の穴）→ gap", r.length === 1 && r[0].kind === "gap", JSON.stringify(r));
  ok("通: 数が違う", verifyMessages(orig, orig.slice(0, 2))[0]?.kind === "messages");
  ok("通: 順が逆", verifyMessages(orig, [{ at: at(0) }, { at: at(-10) }, { at: at(600) }])[0]?.kind === "gap");
  const short = [{ at: at(0) }, { at: at(30) }];
  ok("通: 元が90秒未満の間は見ない", verifyMessages(short, [{ at: at(0) }, { at: at(5) }]).length === 0);
}
{
  const orig = [{ at: at(0), id: "a" }, { at: at(200), id: "b", quoteOf: "a" }];
  ok("引用: 先がある", verifyMessages(orig, orig).length === 0);
  const r = verifyMessages(orig, [{ at: at(0), id: "x" }, { at: at(200), id: "y", quoteOf: "a" }]);
  ok("引用: 先が落ちた（古い引用の先が落ちる穴）", r.some((i) => i.kind === "quote"));
}
{
  const v = verifyCopy({ leftover: { sent_properties: 0 }, expected: { sent_properties: 2 }, observed: { sent_properties: 2 } });
  ok("まとめ: 揃えば流す", v.ok);
  const v2 = verifyCopy({ leftover: { sent_properties: 5 }, expected: { sent_properties: 2 }, observed: { sent_properties: 7 } });
  ok("まとめ: ずれは流さない", !v2.ok && v2.issues.length === 2);
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
