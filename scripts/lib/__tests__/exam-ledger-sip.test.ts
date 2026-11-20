// 送った資料の読みの写しの選び方・除き方（scripts/lib/exam-ledger-sip.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-ledger-sip.test.ts（全 PASS で exit 0）
import { filterSipRows, pickSipRowsDesc, sipBaseExcludeOf, sipExcludePrefixes, sipSourceExcluded } from "../exam-ledger-sip";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("頭の読み", JSON.stringify(sipExcludePrefixes(" aix_log, x ")) === JSON.stringify(["aix_log", "x"]) && sipExcludePrefixes(undefined).length === 0);
ok("aix_log の頭に当たる", sipSourceExcluded("aix_log:property_check_result", ["aix_log"]) && sipSourceExcluded("aix_log", ["aix_log"]));
ok("似た名前・他の source・空は当たらない", !sipSourceExcluded("aix_logger", ["aix_log"]) && !sipSourceExcluded("reading", ["aix_log"]) && !sipSourceExcluded(null, ["aix_log"]) && !sipSourceExcluded("aix_log:x", []));
const rows = [{ ago: 1, row: { source: "aix_log:estimate_sheet" } }, { ago: 2, row: { source: "reading" } }, { ago: 3, row: { source: null } }];
const f = filterSipRows(rows, ["aix_log"]);
ok("入れる前に除く", f.dropped === 1 && f.kept.length === 2 && f.kept[0].ago === 2);
ok("除きが無ければそのまま", filterSipRows(rows, []).kept.length === 3);

// 新しい順。他の行 5（上限 3）＋足した行 2（1つは範囲の中・1つは範囲より古い）
const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
const desc = [
  { id: "o1", source: "reading", created_at: t(50) },
  { id: "g1", source: "aix_log:property_recommendation", created_at: t(45) },
  { id: "o2", source: "reading", created_at: t(40) },
  { id: "o3", source: null, created_at: t(30) },
  { id: "o4", source: "reading", created_at: t(20) },
  { id: "g2", source: "aix_log:estimate_sheet", created_at: t(10) },
  { id: "o5", source: "reading", created_at: t(5) },
];
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).join(",");
ok("他の行は上限まで・足した行は範囲の中だけ", ids(pickSipRowsDesc(desc, 3, ["aix_log"])) === "o1,g1,o2,o3", ids(pickSipRowsDesc(desc, 3, ["aix_log"])));
ok("足した行を除くと、前の写し（上限3）と同じ他の行", ids(pickSipRowsDesc(desc, 3, ["aix_log"]).filter((r) => !sipSourceExcluded(r.source, ["aix_log"]))) === ids(desc.filter((r) => !String(r.source ?? "").startsWith("aix_log")).slice(0, 3)));
ok("他の行が上限に届かない時は足した行を全部", ids(pickSipRowsDesc(desc, 10, ["aix_log"])) === ids(desc));
ok("頭が無ければ今まで通り上限まで", ids(pickSipRowsDesc(desc, 3, [])) === "o1,g1,o2");
ok("前だけの除き", sipBaseExcludeOf({ EXAM_LEDGER_SIP_BASE_EXCLUDE: "aix_log" }) === "aix_log" && sipBaseExcludeOf({}) === null);

console.log(`exam-ledger-sip: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
