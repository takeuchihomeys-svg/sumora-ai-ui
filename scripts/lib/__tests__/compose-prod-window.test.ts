// scripts/lib/compose-prod-window.ts の単体テスト（DB も LLM も使わない）
// 実行: npx tsx scripts/lib/__tests__/compose-prod-window.test.ts
import { parseWriters, writerMatches, parseFix, windowsAround } from "../compose-prod-window";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 書き手の切り口
ok("既定は竹内さん本人", parseWriters(undefined) === "takeuchi" && parseWriters("") === "takeuchi");
ok("all", parseWriters("all") === "all");
const names = parseWriters("takeuchi,yunamaru");
ok("名前の並び", typeof names === "object" && names.names.join() === "takeuchi,yunamaru");
ok("takeuchi は本人だけ", writerMatches({ writer: "takeuchi", aix: false }, "takeuchi") && !writerMatches({ writer: "yunamaru", aix: false }, "takeuchi"));
ok("all はスタッフ全員・書き手不明も", writerMatches({ writer: "yunamaru", aix: false }, "all") && writerMatches({ writer: null, aix: false }, "all"));
ok("AIX の通は数えない", !writerMatches({ writer: "takeuchi", aix: true }, "all") && !writerMatches({ writer: "takeuchi", aix: true }, "takeuchi"));
ok("番の書き手が読めない（null）は数えない", !writerMatches(null, "all"));
ok("名前の並びに無い書き手は数えない", !writerMatches({ writer: "x", aix: false }, { names: ["takeuchi"] }) && !writerMatches({ writer: null, aix: false }, { names: ["takeuchi"] }));

// 直した物
const f = parseFix("SENT_SHAPE_NANITOZO_LEN@2026-11-19T01:40");
ok("時差なしは JST", "atMs" in f && f.atMs === Date.parse("2026-11-19T01:40+09:00"), JSON.stringify(f));
const f2 = parseFix("RAG_HNSW@2026-11-18T15:20:00Z");
ok("Z 付きはそのまま", "atMs" in f2 && f2.atMs === Date.parse("2026-11-18T15:20:00Z"));
const fd = parseFix("X@2026-11-19");
ok("日付だけは JST 0時", "atMs" in fd && fd.atMs === Date.parse("2026-11-19T00:00:00+09:00"));
ok("形が違えば error", "error" in parseFix("NANITOZO") && "error" in parseFix("X@きのう"));

// 窓
const at = Date.parse("2026-11-19T01:40+09:00");
const now1 = at + 30 * 3_600_000;
const w1 = windowsAround({ name: "x", atMs: at }, 7, now1);
ok("on から30時間なら前も30時間にそろえる", !!w1 && w1.spanH === 30 && w1.before[0] === at - 30 * 3_600_000 && w1.after[1] === now1, JSON.stringify(w1));
const w2 = windowsAround({ name: "x", atMs: at }, 7, at + 20 * 86_400_000);
ok("十分たてば days 日ずつ", !!w2 && w2.spanH === 7 * 24);
ok("6時間より短ければまだ測れない", windowsAround({ name: "x", atMs: at }, 7, at + 3 * 3_600_000) === null);

console.log(`compose-prod-window: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
