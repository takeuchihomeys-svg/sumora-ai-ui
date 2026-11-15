// scripts/exam-problem-ledger.ts — 試験の問題の帳面（読むだけ・LLM なし・費用0）
//   2026-11-15 作業員I（統括役の穴7・竹内さん 11/15「実際のブレインに質の高いデータを渡せるように」）:
//   問題（spec.json）を3つの目で数え、手入れの案を出す（直すのは統括役の OK の後・ここでは何も書き換えない）:
//     ① 竹内さん本人の番から作った問題の割合（その番の後の最初のこちらの手打ちの送信の書き手＝messages.staff_writer・sure）
//     ② 申込以降の番が混ざっていないか（turn-application-gate を番の時刻で引く・gateCheckSpecs）
//     ③ 正解の根拠に挙げた設計知見（KB の id8）が退役している（is_current=false）問題＝正解が古い決まりのままの疑い
//   DB は会話ごとに少し読む＝営業時間（JST 9〜22）の外に流す。
// 実行: npx tsx --env-file=<サーバーの鍵の .env> scripts/exam-problem-ledger.ts [--spec=scripts/brain-exam/spec.json] [--out=<md>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gateCheckSpecs } from "./lib/exam-application-gate";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { ledgerSummary, kbIdsOf, type LedgerProblem } from "./lib/exam-problem-ledger-core";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const specFile = resolve(arg("spec", "scripts/brain-exam/spec.json"));
const raw = JSON.parse(readFileSync(specFile, "utf8")) as unknown;
const spec = (Array.isArray(raw) ? raw : (raw as { problems: unknown[] }).problems) as LedgerProblem[];

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  // ① 番の後の最初のこちらの手打ちの送信の書き手
  const writerOf = new Map<string, string | null>();
  for (const p of spec) {
    const { data } = await sb.from("messages").select("staff_writer, staff_writer_confidence, is_aix_generated, created_at").eq("conversation_id", p.conv).eq("sender", "staff").gt("created_at", p.at).order("created_at").limit(4);
    const m = (data ?? []).find((x) => !x.is_aix_generated) ?? (data ?? [])[0];
    writerOf.set(p.id, m && m.staff_writer_confidence === "sure" ? (m.staff_writer as string) : null);
  }
  // ② 申込以降
  const gated = new Map((await gateCheckSpecs(spec, (conv) => loadTurnApplicationRecords(sb as never, conv))).map((x) => [x.id, x.reason]));
  // ③ 退役した設計知見
  const ids8 = [...new Set(spec.flatMap((p) => kbIdsOf(p)))];
  const retired = new Set<string>();
  for (const id8 of ids8) {
    const { data } = await sb.from("system_design_thinking").select("id, is_current").like("id", `${id8}%`).limit(2);
    if ((data ?? []).length && (data ?? []).every((r) => r.is_current === false)) retired.add(id8);
  }
  const s = ledgerSummary(spec, { writerOf: (id) => writerOf.get(id) ?? null, gatedOf: (id) => gated.get(id) ?? null, retired });
  const md = s.lines.join("\n");
  const out = arg("out");
  if (out) writeFileSync(out, md); else console.log(md);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
