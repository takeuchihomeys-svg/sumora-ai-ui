// scripts/lib/__tests__/hazard-audit-core.test.ts — 危ない所の見張りの見つけ方（npx tsx scripts/lib/__tests__/hazard-audit-core.test.ts）
import { findOffSwitches, findUnpagedReads, lpMonthOk, commitsWithoutTsc } from "../hazard-audit-core";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("FAIL", name); } };

// (a)
{
  const files = [
    { file: "app/lib/x.ts", text: "// 2026-10-28 竹内さんの決定（KB 5d9e56b5）: 募集状況は…\nexport function aOn(env = process.env) {\n  return (env.MGMT_HOURS_SPLIT_1028 ?? \"\").trim().toLowerCase() === \"on\";\n}" },
    { file: "app/lib/y.ts", text: "export const bOn = () => process.env.SOME_PLAIN_FLAG === \"on\";\nexport const cOn = () => process.env.DEFAULT_ON_FLAG !== \"off\";" },
    { file: "app/lib/__tests__/z.test.ts", text: "process.env.TEST_ONLY === \"on\"" },
  ];
  const r = findOffSwitches(files);
  t("決定ありのスイッチ", r.find((s) => s.name === "MGMT_HOURS_SPLIT_1028")?.decided === true);
  t("決定なしのスイッチ", r.find((s) => s.name === "SOME_PLAIN_FLAG")?.decided === false);
  t("既定 on（!== off）は拾わない", !r.some((s) => s.name === "DEFAULT_ON_FLAG"));
  t("テストは見ない", !r.some((s) => s.name === "TEST_ONLY"));
}
// (b)
{
  const files = [{ file: "app/api/a/route.ts", text: [
    "const { data } = await sb.from(\"messages\").select(\"id, text\").gte(\"created_at\", since);",
    "const { data: d2 } = await sb.from(\"messages\").select(\"id\").gte(\"created_at\", since).limit(5000);",
    "const { data: d3 } = await sb.from(\"messages\").select(\"id\").range(f, f + 999);",
    "const { data: d4 } = await sb.from(\"messages\").select(\"id\").eq(\"conversation_id\", c);",
    "await sb.from(\"messages\").update({ x: 1 }).eq(\"id\", 1);",
    "const { data: d5 } = await sb.from(\"small_table\").select(\"*\");",
  ].join("\n") }];
  const r = findUnpagedReads(files);
  t("頁なしを拾う", r.some((u) => u.line === 1 && /頁なし/.test(u.why)));
  t("limit 5000 を拾う", r.some((u) => u.line === 2 && /limit 5000/.test(u.why)));
  t("range は拾わない", !r.some((u) => u.line === 3));
  t("会話ごとは拾わない", !r.some((u) => u.line === 4));
  t("update は拾わない", !r.some((u) => u.line === 5));
  t("小さい表は拾わない", !r.some((u) => u.line === 6));
}
// (e)
{
  const js = "(function (root, factory) { var api = factory(); if (typeof module !== 'undefined' && module.exports) { module.exports = api; } if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { api.render(); }); else api.render(); } })(undefined, function () { function evidenceFor(now) { var d = new Date(now.getTime() + 9 * 3600000); return { month: d.getUTCMonth() + 1 }; } return { evidenceFor: evidenceFor, render: function () {} }; });";
  const now = new Date("2026-11-04T03:00:00Z");
  t("今月なら ok", lpMonthOk('<span data-lp="month">11月実績</span>', js, now).ok);
  const bad = js.replace("function () { api.render(); }", "api.render");
  t("Event で render を呼ぶ形は ×", !lpMonthOk('<span data-lp="month">9月実績</span>', bad, now).ok);
}
// (f)
{
  const commits = [{ at: "2026-11-04T03:00:00+00:00", subject: "fix: a" }, { at: "2026-11-04T12:00:00+00:00", subject: "fix: b" }, { at: "2026-11-04T12:00:00+00:00", subject: "Merge x" }];
  const r = commitsWithoutTsc(commits, ["2026-11-04T02:49"]);
  t("前に tsc 0 があれば ok", !r.some((c) => c.subject === "fix: a"));
  t("6時間より前の tsc は数えない", r.some((c) => c.subject === "fix: b"));
  t("Merge は見ない", !r.some((c) => /Merge/.test(c.subject)));
}
console.log(`hazard-audit-core: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
// (d)
{
  const { rowFilterMissingCols } = require("../hazard-audit-core");
  const f = "(id <> ALL (ARRAY['d040f80a'::text, 'f7deb105'::text]))";
  const ok1 = rowFilterMissingCols(f, "d", ["id"]).length === 0;
  const ok2 = rowFilterMissingCols("(conversation_id <> 'x'::text)", "d", ["id"]).join() === "conversation_id";
  const ok3 = rowFilterMissingCols("(conversation_id <> 'x'::text)", "f", []).length === 0;
  console.log(ok1 && ok2 && ok3 ? "hazard-audit-core (d): pass" : "hazard-audit-core (d): FAIL"); if (!(ok1 && ok2 && ok3)) process.exit(1);
}
{
  const { hollowNoWorse } = require("../hazard-audit-core");
  const rows = [
    { label: "cbp1", verdict: "確かな悪化0（1本の時間の上限 40分）", planned: 10, both: 0 },
    { label: "desk-on2", verdict: "確かな悪化0（早めの打ち切り）", planned: 13, both: 11 },
    { label: "grp-reply", verdict: "確かな悪化0", planned: 20, both: 20 },
    { label: "tag-old", verdict: "確かな悪化0・合格 ?", planned: 20, both: null },
    { label: "bad", verdict: "確かな悪化 2", planned: 5, both: 0 },
  ];
  const got = hollowNoWorse(rows).map((r: { label: string }) => r.label).join(",");
  const ok = got === "cbp1,desk-on2,tag-old";
  console.log(ok ? "hazard-audit-core (g): pass" : `hazard-audit-core (g): FAIL ${got}`); if (!ok) process.exit(1);
}
{
  const { unknownsOpenLine } = require("../hazard-audit-core");
  const now = Date.parse("2026-11-05T00:00:00Z");
  const a = unknownsOpenLine({ weak_open: 40, weak_new24h: 3, unknown_rows: 60, unknown_new24h: 12, owner_open: 20 }, "2026-11-04T18:00:00Z", now);
  const b = unknownsOpenLine(null, null, now);
  const c = unknownsOpenLine({ weak_open: 1, weak_new24h: 0, unknown_rows: 1, unknown_new24h: 0, owner_open: 0 }, "2026-11-02T00:00:00Z", now);
  const ok = a.ok === true && /開いている 40（新\+3）/.test(a.line) && /新\+12/.test(a.line) && b.ok === null && c.ok === null && /古い/.test(c.line);
  console.log(ok ? "hazard-audit-core (h): pass" : "hazard-audit-core (h): FAIL"); if (!ok) process.exit(1);
}
{
  const { conductorLogHazards, laneDupConvs } = require("../hazard-audit-core");
  const log = [
    "2026-11-04T10:56:40.359Z   ⏱ 止める印から 15分で止まらない → 止める（op-on1）",
    "2026-11-04T11:28:34.734Z   ⚠ 古い brain-exam（止める印を見ない）・上限を延ばした 40→120分・古い brain-exam（レーンが同じ会話になる）・1レーンで回す・作業ツリーが origin/main より 21個古い（fmi-demote1・C:/x/w2-conductor）",
    "2026-11-03T10:00:00.000Z   ⏱ 止める印から 15分で止まらない → 止める（old-one）",
  ].join("\n");
  const h = conductorLogHazards(log, "2026-11-04T00:00:00Z");
  const dup = laneDupConvs("レーン（EXAM_CONCURRENCY=4）: 4本 YUMA2（d040f80a・線 a）・YUMA2（d040f80a・線 b）・YUMA2（x）・YUMA2（y）");
  const nodup = laneDupConvs("レーン（EXAM_CONCURRENCY=2）: 2本 YUMA3（f7deb105・線 a）・YUMA4（40f0db25・線 b）");
  const ok = h.stopKilled.join() === "op-on1" && h.oldWorktree.join() === "fmi-demote1" && dup.join() === "YUMA2" && nodup.length === 0;
  console.log(ok ? "hazard-audit-core (i)(j): pass" : `hazard-audit-core (i)(j): FAIL ${JSON.stringify({ h, dup, nodup })}`); if (!ok) process.exit(1);
}
{
  const { dupProblemIds } = require("../hazard-audit-core");
  const ok = dupProblemIds([{ id: "q212" }, { id: "q213" }, { id: "q212" }]).join() === "q212" && dupProblemIds([{ id: "a" }, { id: "b" }]).length === 0;
  console.log(ok ? "hazard-audit-core (k): pass" : "hazard-audit-core (k): FAIL"); if (!ok) process.exit(1);
}
{
  const { idContentClashes } = require("../hazard-audit-core");
  const h = (o: Record<string, unknown>) => String(o.conv) + "|" + String(o.at);
  const got = idContentClashes([{ id: "q212", conv: "a", at: "1" }, { id: "q100", conv: "b", at: "2" }, { id: "q999", conv: "c", at: "3" }], [{ id: "q212", conv: "z", at: "9" }, { id: "q100", conv: "b", at: "2" }], h);
  const ok = got.join() === "q212";
  console.log(ok ? "hazard-audit-core (l): pass" : `hazard-audit-core (l): FAIL ${got}`); if (!ok) process.exit(1);
}
