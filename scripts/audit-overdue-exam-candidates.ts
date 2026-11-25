// scripts/audit-overdue-exam-candidates.ts — 台帳 #725: 統括の段の試験の問題（期日超えの約束を含む番）の候補を、B1 の overdue・late の約束から選ぶ（読むだけ・LLM なし）
// 2026-11-25 作業員L（統括役の割り振り）。今ある試験で期日超えの約束を含む番は 8問だけ（audit-promise-lifecycle の目安）。
//   選び方: B1 の行（--b1 の json・既にある数え）の overdue・late の約束ごとに、期日を過ぎてから果たすまで（overdue は今まで）の間の最初のお客様の番＝
//     統括が「期日を過ぎた約束がある」と知って動くべき番。1会話1番・試験に既にある会話は外す・申込以降（status・申込の時刻の後）は外す。
//   DB は会話と時刻で絞った軽い読み（会話ごとに messages を期日〜果たした時刻の間だけ）。出すのは会話の頭8字と時刻だけ（文は出さない）
// 実行: npx tsx --env-file=.env.local scripts/audit-overdue-exam-candidates.ts --b1=<b1.json> [--spec=scripts/brain-exam/spec.json] [--max=20]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { promiseDeadlineMs, type PromiseKindName } from "../app/lib/promise-drop-watch";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conv: string; at: string; kind: PromiseKindName; state: string; deadlineBy: string; fulfilledAt?: string | null; by?: string | null; writer: string };
const POST_APPLY = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "won"]);

(async () => {
  const b1 = JSON.parse(readFileSync(arg("b1"), "utf8")) as { rows: Row[] };
  const specFile = arg("spec", "scripts/brain-exam/spec.json");
  const specTxt = existsSync(specFile) ? readFileSync(specFile, "utf8") : "";
  const rows = b1.rows.filter((r) => r.state === "overdue" || r.state === "late");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  // B1 の json は会話の頭8字＝会話の id を引く（会話の表を頭8字の範囲で1件ずつ・軽い）
  const full = new Map<string, { id: string; status: string | null }>();
  for (const c8 of [...new Set(rows.map((r) => r.conv))]) {
    const { data } = await sb.from("conversations").select("id, status").gte("id", `${c8}-0000-0000-0000-000000000000`).lte("id", `${c8}-ffff-ffff-ffff-ffffffffffff`).limit(2);
    if (data?.length === 1) full.set(c8, data[0] as { id: string; status: string | null });
  }
  const out: Array<{ conv8: string; kind: string; state: string; promisedAt: string; dueAt: string; turnAt: string; hoursOver: number; inExam: boolean }> = [];
  const skip = { inExam: 0, postApply: 0, noTurn: 0, noConv: 0 };
  const seen = new Set<string>();
  for (const r of rows.sort((a, b) => a.at.localeCompare(b.at))) {
    if (seen.has(r.conv)) continue;
    const c = full.get(r.conv);
    if (!c) { skip.noConv++; continue; }
    if (POST_APPLY.has(String(c.status ?? ""))) { skip.postApply++; continue; }
    const inExam = specTxt.includes(c.id) || specTxt.includes(r.conv);
    if (inExam) { skip.inExam++; continue; }
    // 期日は B1 と同じ決め（約束の文は読まない＝既定の72時間か B1 の deadlineBy が words の時は B1 に合わせて72時間で下に見積もる）
    const due = promiseDeadlineMs("", Date.parse(r.at), r.kind).ms;
    const end = r.fulfilledAt ? Date.parse(r.fulfilledAt) : Date.now();
    if (!(end > due)) { skip.noTurn++; continue; }
    const { data: m } = await sb.from("messages").select("sender, created_at").eq("conversation_id", c.id).eq("sender", "customer").gt("created_at", new Date(due).toISOString()).lt("created_at", new Date(end).toISOString()).order("created_at").limit(1);
    const turn = (m ?? [])[0] as { created_at: string } | undefined;
    if (!turn) { skip.noTurn++; continue; }
    // 申込より後の番は外す（申込の時刻・deal_outcomes）
    const { data: d } = await sb.from("deal_outcomes").select("applied_at").eq("conversation_id", c.id).not("applied_at", "is", null).lte("applied_at", turn.created_at).limit(1);
    if (d?.length) { skip.postApply++; continue; }
    seen.add(r.conv);
    out.push({ conv8: r.conv, kind: r.kind, state: r.state, promisedAt: r.at, dueAt: new Date(due).toISOString(), turnAt: turn.created_at, hoursOver: Math.round((Date.parse(turn.created_at) - due) / 36e5), inExam });
  }
  const max = Number(arg("max", "20"));
  console.log(`# 期日超えの約束を含む番の候補（B1 の overdue・late ${rows.length}約束・${new Set(rows.map((r) => r.conv)).size}会話）`);
  console.log(`外した: 試験に既にある ${skip.inExam}・申込以降 ${skip.postApply}・期日の後にお客様の番が無い ${skip.noTurn}・会話を引けない ${skip.noConv}\n`);
  console.log("| 会話 | 種類 | B1 | 約束 | 期日 | お客様の番 | 期日から |\n|---|---|---|---|---|---|---|");
  const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 36e5).toISOString().slice(5, 16).replace("T", " ");
  for (const x of out.slice(0, max)) console.log(`| ${x.conv8} | ${x.kind} | ${x.state} | ${jst(x.promisedAt)} | ${jst(x.dueAt)} | ${jst(x.turnAt)} | ${x.hoursOver}時間 |`);
  console.log(`\n候補 ${out.length}（上の ${Math.min(max, out.length)}）`);
})().catch((e) => { console.error(e); process.exit(1); });
