// scripts/audit-r9-replay-score.ts — 9巡目: 学習ルールの重ね off／on／stage2 の前後を採点する（読むだけ・LLM なし）
//   入力: scripts/yuma-r9-replay.ts（本番の過去の番・staff あり）か scripts/yuma-r9-scenes.ts（作った場面・期待の文）の書き出し。
//   出す物（版ごと・場面ごと）:
//     ①文: 完全一致・近い（芯の Dice 0.8 以上）・似ている度（app/lib/text-diff-types.diffTexts・7巡目と同じ物差し）＝再生だけ
//     ②道: ブレインが返信か AIX か（再生はスタッフの実際＝staffPath と比べる）・選んだ AIX
//     ③作り事: 下書きの最終の文で findStaffOnlyFact（空き・見積の金額・待ち合わせの住所・内覧の確定・電話）＋STAFF_RESULT_RES（管理会社の回答・交渉の結果・
//        撮影・入居可能日）＝P0 の監査（scripts/audit-p0-staff-only-facts.ts）と同じ線／最終チェックの1回目の FABRICATED_*・FREE_RENT_UNGROUNDED
//     ④最終チェック: 1回目の指摘の RULE_VIOLATION の数（誤発火の目安）・直し・作り直しの回数
// 実行: npx tsx scripts/audit-r9-replay-score.ts <jsonl> [<jsonl> …] [--versions=off,on,stage2] [--detail]
import { readFileSync } from "node:fs";
import { diffTexts } from "../app/lib/text-diff-types";
import { findStaffOnlyFact, STAFF_RESULT_RES } from "../app/lib/staff-confirm-facts";

const args = process.argv.slice(2);
const VERSIONS = (args.find((a) => a.startsWith("--versions="))?.slice(11) ?? "off,on,stage2").split(",");
const DETAIL = args.includes("--detail");
const files = args.filter((a) => !a.startsWith("--"));
type Fc = { codes?: string[]; first?: string[]; rv?: string[]; revised?: number; regen?: number } | null;
type Rec = Record<string, unknown> & { id?: string; scene: string; group?: string; staff?: string; staffPath?: string[] | null; ver?: string };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const NEAR = 0.8;

function staffOnlyHits(t: string): string[] {
  const out: string[] = [];
  const f = findStaffOnlyFact(t);
  if (f) out.push(`${f.kind}「${f.text.slice(0, 50)}」`);
  for (const s of String(t ?? "").split(/(?<=[。！!？?\n])/)) {
    for (const r of STAFF_RESULT_RES) { if (r.re.test(s) && !(r.exclude && r.exclude.test(s)) && !out.some((x) => x.startsWith(r.kind))) out.push(`${r.kind}「${s.trim().slice(0, 50)}」`); }
  }
  // 9巡目で見つけた型: 値下げ・割引の打ち切りの言い切り（交渉していないのに「これ以上は難しい」「最安値」）＝交渉の結果の作り事（P0）
  const m = String(t ?? "").match(/[^。\n]*(?:(?:値下げ|値引き|お値引き|お安く|割引)[^。\n]{0,16}(?:難し|出来ません|できません|出来ない|できない)|最安値|これ以上[^。\n]{0,12}(?:難し|出来|でき))[^。\n]*/);
  if (m && !/確認させて|確認出来次第|でき次第|代表に/.test(m[0])) out.push(`discount_limit「${m[0].trim().slice(0, 50)}」`);
  return out;
}
const FAB_RE = /^(?:FABRICATED_|FREE_RENT_UNGROUNDED|AIX_BOUNDARY_)/;

type Row = { v: string; scene: string; id: string; draft: string; staff: string | null; path: string | null; staffPath: string[] | null; fc: Fc; action: string | null };
const rows: Row[] = [];
for (const f of files) {
  for (const l of readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Rec;
    if (r.ver) { // 場面（1行＝1版）
      rows.push({ v: String(r.ver), scene: `${r.group ?? ""}/${r.scene}`, id: `${r.scene}#${r.rep}`, draft: String(r.draft ?? ""), staff: null, path: String(r.reply_mode ?? ""), staffPath: null, fc: (r.fc as Fc) ?? null, action: (r.action as string | null) || null });
      continue;
    }
    for (const v of VERSIONS) {
      const b = r[`brain_${v}`] as { action?: string | null; reply_mode?: string | null } | undefined;
      for (const k of Object.keys(r).filter((k) => k === `draft_${v}` || k.startsWith(`draft_${v}_`))) {
        const d = r[k];
        if (typeof d !== "string" || /^（AI返信の生成に失敗/.test(d)) continue;
        rows.push({ v, scene: r.scene, id: `${r.id}${k.slice(`draft_${v}`.length)}`, draft: d, staff: (r.staff as string) ?? null, path: b?.reply_mode ?? null, staffPath: (r.staffPath as string[] | null) ?? null, fc: (r[`fc_${k}`] as Fc) ?? null, action: b?.action || null });
      }
      if (b && !Object.keys(r).some((k) => k === `draft_${v}`)) rows.push({ v, scene: r.scene, id: r.id ?? "", draft: "", staff: (r.staff as string) ?? null, path: b.reply_mode ?? null, staffPath: (r.staffPath as string[] | null) ?? null, fc: null, action: b.action || null });
    }
  }
}

const scenes = [...new Set(rows.map((r) => r.scene))].sort();
console.log(`版\t場面\tn\t完全\t近い\t似ている度\t道の一致\tAIX\t作り事(文)\t作り事(1回目の判定)\tRULE_VIOLATION(1回目)\t直し/作り直し`);
for (const sc of [...scenes, "(全体)"]) {
  for (const v of VERSIONS) {
    const l = rows.filter((r) => r.v === v && (sc === "(全体)" || r.scene === sc));
    if (!l.length) continue;
    const withStaff = l.filter((r) => r.staff && r.draft.trim());
    const ds = withStaff.map((r) => diffTexts(r.draft, r.staff!));
    const same = ds.filter((d) => d.same).length, near = ds.filter((d) => d.same || d.sim >= NEAR).length;
    const sim = ds.length ? (ds.reduce((a, d) => a + d.sim, 0) / ds.length).toFixed(2) : "-";
    const pathRows = l.filter((r) => r.staffPath && r.staffPath.length);
    const pathOk = pathRows.filter((r) => { const want = r.staffPath![0]; return want === "reply" ? r.path !== "aix" : r.action === want; }).length;
    const aix = l.filter((r) => r.path === "aix" || (r.action && r.action !== "")).length;
    const fabText = l.filter((r) => staffOnlyHits(r.draft).length).length;
    const fabFc = l.filter((r) => (r.fc?.first ?? []).some((c) => FAB_RE.test(c))).length;
    const rv = l.reduce((a, r) => a + (r.fc?.first ?? []).filter((c) => c.startsWith("RULE_VIOLATION")).length, 0);
    const rvTurns = l.filter((r) => (r.fc?.first ?? []).some((c) => c.startsWith("RULE_VIOLATION"))).length;
    const rev = l.filter((r) => (r.fc?.revised ?? 0) > 0).length, regen = l.filter((r) => (r.fc?.regen ?? 0) > 0).length;
    console.log(`${v}\t${sc}\t${l.length}\t${ds.length ? `${same}/${ds.length}` : "-"}\t${ds.length ? `${near}/${ds.length}` : "-"}\t${sim}\t${pathRows.length ? `${pathOk}/${pathRows.length}` : "-"}\t${aix}\t${fabText}\t${fabFc}\t${rv}（${rvTurns}番）\t${rev}/${regen}`);
  }
}
if (DETAIL) {
  console.log("\n=== 作り事の候補（文）と 1回目の判定の作り事・RULE_VIOLATION ===");
  for (const r of rows) {
    const h = staffOnlyHits(r.draft);
    const fab = (r.fc?.first ?? []).filter((c) => FAB_RE.test(c) || c.startsWith("RULE_VIOLATION"));
    if (!h.length && !fab.length) continue;
    console.log(`[${r.v}] ${r.scene} ${r.id}  文:${h.join("・") || "-"}  判定:${fab.join(",") || "-"}${r.fc?.rv?.length ? `  最終RV:${r.fc.rv.join(" / ")}` : ""}\n   ${r.draft.replace(/\n/g, "／").slice(0, 160)}`);
  }
}
void pct;
