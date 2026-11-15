// scripts/lib/ask-route-of.ts の純関数のテスト（DB なし）。実行: npx tsx scripts/test-audit-ask-route.ts
import { tcMix, sendShape, outlierOf, aixBundleFamily } from "./lib/ask-route-of";
let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "  ✓" : "  ✗"} ${n}`); if (!c) bad++; };
ok("tcMix", JSON.stringify(tcMix("3:r1p0a2n0:c")) === JSON.stringify({ r: 1, p: 0, a: 2, n: 0 }) && tcMix(null) === null);
ok("sendShape", sendShape([{ aix: true }, { aix: true }, { aix: false }]) === "AR");
ok("物件の束", aixBundleFamily("property_send/x") === aixBundleFamily("property_recommendation") && aixBundleFamily("estimate_sheet/with_appeal") === "estimate_sheet");
ok("AIX 側の取りこぼし", outlierOf({ r: 1, p: 0, a: 0 }, "RA", 1) === "取りこぼし（AIX 側）" && outlierOf({ r: 0, p: 0, a: 0 }, "A", 1) === "取りこぼし（AIX 側）");
ok("2つ目の AIX", outlierOf({ r: 0, p: 0, a: 1 }, "A", 2) === "取りこぼし（2つ目の AIX）");
ok("AIX→返信", outlierOf({ r: 0, p: 0, a: 1 }, "R", 0) === "取り違え（AIX→返信）");
ok("返信→AIX", outlierOf({ r: 1, p: 0, a: 0 }, "A", 1) === "取り違え（返信→AIX）" && outlierOf({ r: 1, p: 0, a: 0 }, "RA", 1) === "取りこぼし（AIX 側）");
ok("重ねの候補", outlierOf({ r: 1, p: 0, a: 1 }, "A", 1) === "重ねの候補（1通で両方）");
ok("合う", outlierOf({ r: 0, p: 1, a: 0 }, "R", 0) === "合う" && outlierOf(null, "R", 0) === "要件の記録なし");
console.log(bad ? `${bad} failed` : "all ok"); if (bad) process.exit(1);
