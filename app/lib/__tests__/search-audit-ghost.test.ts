// 実行: npx tsx app/lib/__tests__/search-audit-ghost.test.ts
// 2026-09-30 v2.5.48 幽霊の行（一括の行の直後に同じお客様・同じサイトで出た trigger=single＝同じ自動入力の2本目）を
//   前回の検索・まとめを待つ判定で数えない／点検に DOUBLE_FILL（bad）の札・見張りの規則に double_fill。
//   本番の行（search_audits 9/30）の時刻・種類そのまま。
import { ghostSourceOf, isGhostSingle, dropGhostSingles, GHOST_WINDOW_MS, type GhostRowLite } from "../search-audit-ghost";
import { searchHold, type HoldAudit, type HoldCommand } from "../pickup-complete";
import { runSearchAuditChecks, causeTitle } from "../search-audit-check";
import { detectScreenState } from "../screen-watch";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "OK " : "NG "} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}
const jst = (hms: string) => new Date(`2026-09-30T${hms}+09:00`).toISOString();
const YUMA = "509cd061-60cc-49a9-8c5a-4f356c4a5f88", HIYO = "42a89f52", NOA = "587503e4";
const row = (id: number, pc: string, site: string, trigger: string, hms: string, cmd: string | null): GhostRowLite & { id: number } =>
  ({ id, property_customer_id: pc, site, trigger, created_at: jst(hms), command_id: cmd, run_id: `sa_${id}` });

console.log("── 本番の行: 一括の行の 6〜13秒後の single は幽霊");
{
  const rows = [
    row(248, YUMA, "realpro", "web_brain", "16:22:28", "90aee87c"),
    row(249, YUMA, "itandi", "web_brain", "16:22:53", "90aee87c"),
    row(250, YUMA, "itandi", "single", "16:23:06", null),
    row(252, HIYO, "itandi", "bulk_queue", "16:29:30", "86aeb80b"),
    row(253, HIYO, "itandi", "single", "16:29:40", null),
    row(269, NOA, "itandi", "bulk_queue", "17:37:30", "119d655e"),
    row(270, NOA, "itandi", "single", "17:37:36", null),
  ];
  eq("250 は 249 の幽霊", (ghostSourceOf(rows[2], rows) as { id: number } | null)?.id, 249);
  eq("253 は 252 の幽霊", (ghostSourceOf(rows[4], rows) as { id: number } | null)?.id, 252);
  eq("270 は 269 の幽霊（6秒）", isGhostSingle(rows[6], rows), true);
  eq("一括の行そのものは幽霊でない", [isGhostSingle(rows[0], rows), isGhostSingle(rows[1], rows)], [false, false]);
  eq("幽霊を除いた一覧", dropGhostSingles(rows).map((r) => r.id), [248, 249, 252, 269]);
}

console.log("── 幽霊にしない（迷ったら数える側）");
{
  const batch = row(1, YUMA, "itandi", "bulk_queue", "10:00:00", "c1");
  eq("別のサイトの single", isGhostSingle(row(2, YUMA, "realpro", "single", "10:00:08", null), [batch]), false);
  eq("別のお客様の single", isGhostSingle(row(2, HIYO, "itandi", "single", "10:00:08", null), [batch]), false);
  eq("窓の外（41秒後＝スタッフが手で検索し直した）", isGhostSingle(row(2, YUMA, "itandi", "single", "10:00:41", null), [batch]), false);
  eq("窓ちょうど（40秒）は幽霊", isGhostSingle(row(2, YUMA, "itandi", "single", "10:00:40", null), [batch]), true);
  eq("一括の行より前の single", isGhostSingle(row(2, YUMA, "itandi", "single", "09:59:55", null), [batch]), false);
  eq("手の検索だけ（一括の行が無い）", isGhostSingle(row(2, YUMA, "itandi", "single", "10:00:08", null), [row(3, YUMA, "itandi", "single", "10:00:00", null)]), false);
  eq("命令のある行は幽霊でない", isGhostSingle(row(2, YUMA, "itandi", "single", "10:00:08", "c9"), [batch]), false);
  eq("お客様の分からない行", isGhostSingle({ site: "itandi", trigger: "single", created_at: jst("10:00:08") }, [batch]), false);
  eq("時刻の読めない行", isGhostSingle({ property_customer_id: YUMA, site: "itandi", trigger: "single", created_at: "x" }, [batch]), false);
  eq("サイトの書き方の違い（realnetpro と realpro）は同じサイト", isGhostSingle(row(2, YUMA, "realnetpro", "single", "10:00:08", null), [row(1, YUMA, "realpro", "aix", "10:00:00", "c1")]), true);
  eq("窓の定数", GHOST_WINDOW_MS, 40_000);
}

console.log("── まとめを待つ判定（searchHold）: 幽霊の行で待たない・数えない");
{
  const now = Date.parse(jst("16:24:00"));
  const cmdRun: HoldCommand[] = [{ id: "90aee87c", status: "running", sites: ["realnetpro", "itandi"] }];
  const a = (site: string, trigger: string, hms: string, status: string, fin: string | null, cmd: string | null): HoldAudit => ({ site, trigger, created_at: jst(hms), status, finished_at: fin ? jst(fin) : null, command_id: cmd });
  // 幽霊の行だけが started のまま残っている（本物は終わっている）
  const ghostOpen = [a("itandi", "single", "16:23:06", "started", null, null), a("itandi", "web_brain", "16:22:53", "finished", "16:23:40", "90aee87c"), a("realpro", "web_brain", "16:22:28", "finished", "16:22:50", "90aee87c")];
  eq("幽霊の行が started でも待たない（両サイトとも本物は終わっている）", searchHold(ghostOpen, cmdRun, now).hold, false);
  // 本物が started なら今まで通り待つ
  const realOpen = [a("itandi", "single", "16:23:06", "started", null, null), a("itandi", "web_brain", "16:22:53", "started", null, "90aee87c")];
  eq("本物の行が started なら待つ", [searchHold(realOpen, cmdRun, now).hold, searchHold(realOpen, cmdRun, now).reason], [true, "searching:itandi"]);
  // 最後に終わった行が幽霊（命令なし）でも、次のサイトの待ちは本物の行で決める
  const cmd2: HoldCommand[] = [{ id: "c2", status: "running", sites: ["itandi", "realnetpro"] }];
  const lastGhost = [a("itandi", "single", "16:23:06", "finished", "16:23:50", null), a("itandi", "bulk_queue", "16:22:53", "finished", "16:23:40", "c2")];
  eq("最後に終わったのが幽霊でも、まだ始まっていないリアプロを待つ", searchHold(lastGhost, cmd2, now).reason, "next_site:realpro");
  // trigger の無い古い行（列を読まない呼び方）は今まで通り
  const legacy: HoldAudit[] = [{ site: "itandi", created_at: jst("16:23:06"), status: "started", finished_at: null, command_id: null }];
  eq("trigger の無い行は今まで通り（待つ）", searchHold(legacy, [], now).hold, true);
  // 手の検索（一括の行が無い single）は今まで通り待つ
  eq("手の検索の started は待つ", searchHold([a("itandi", "single", "16:23:06", "started", null, null)], [], now).hold, true);
}

console.log("── 点検の札（DOUBLE_FILL・bad）と見張りの規則");
{
  const v = runSearchAuditChecks({ site: "itandi", status: "finished", trigger: "single", error: "watchdog-timeout", ghost_of: { trigger: "bulk_queue", gap_ms: 10_000 } });
  const c = v.checks.find((x) => x.code === "DOUBLE_FILL");
  eq("幽霊の行には DOUBLE_FILL（bad）", [c?.severity, c?.cause_key], ["bad", "double_fill:itandi"]);
  eq("札の文に元の種類と間", /bulk_queue.*10秒後/.test(String(c?.detail)), true);
  eq("幽霊でない行には付かない", runSearchAuditChecks({ site: "itandi", status: "finished", trigger: "single" }).checks.some((x) => x.code === "DOUBLE_FILL"), false);
  eq("原因の見出し", causeTitle("double_fill:itandi").includes("同じ自動入力が2本走った"), true);
  const d = detectScreenState({ checkpoint: "done", site: "itandi", checks: [{ code: "DOUBLE_FILL", severity: "bad", title: "同じ自動入力が2本走った" }] } as never);
  eq("見張りの規則に double_fill", d.rules.includes("double_fill"), true);
  eq("札が無ければ規則に出ない", detectScreenState({ checkpoint: "done", site: "itandi", checks: [] } as never).rules.includes("double_fill"), false);
}

console.log("── 配線（読む列・除く所）");
{
  const upd = readFileSync("app/lib/search-update-days-server.ts", "utf8");
  eq("前回の検索は trigger・command_id を読み、幽霊を除いてから数える", [/result, trigger, command_id"\)/.test(upd), /for \(const r of dropGhostSingles\(\(data \?\? \[\]\) as AuditLite\[\]\)\)/.test(upd)], [true, true]);
  const pcs = readFileSync("app/lib/pickup-complete-server.ts", "utf8");
  eq("まとめを待つ判定は trigger を読む", /select\("created_at, finished_at, status, site, command_id, trigger"\)/.test(pcs), true);
  const sas = readFileSync("app/lib/search-audit-server.ts", "utf8");
  eq("回の終わりに幽霊かを確かめて点検に渡す", /const ghost = await ghostContextFor\(merged\);\s*const auditIn = toAuditInput\(merged, \{ \.\.\.upd, \.\.\.sentCtx, \.\.\.ghost \}\);/.test(sas), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
