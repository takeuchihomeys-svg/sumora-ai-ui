// scripts/audit-combo-vs-takeuchi.ts — 竹内さん本人の番で「返信と AIX の組」を、竹内さんの実送信とブレインの組（決まった道＋send-combo-table）で並べる（読むだけ・LLM なし・費用 0）
//   2026-11-13 作業員7b（統括役の頼み ②・竹内さん 11/13「返信と AIX の組み合わせも、ちゃんと行っていけるように。そこの部分も判断して改善していく」・KB 9caa48ea・8a29dc07）
//   竹内さんの組（番の後24時間・次のお客様の発言まで・こちらの通の時刻と AIX の印で読む）:
//     返信だけ（R）／返信→返信（RR・10分以内）／返信→数秒〜2分の AIX（組 RA）／約束の返信→2分より後の AIX（2段）／AIX→返信（AR・10分以内）／AIX→AIX（AA）／AIX だけ（A）
//   ブレインの組: 見張りの行の道（brain_action・decision_source の2段）から send-combo-table.pickSendCombo（型は無し・手がかりは初回だけ）で選ぶ（本番は SEND_COMBO_TABLE が off＝ブレインは組を出していない＝道から引く組）
//   営業時間（JST 9〜22時）は流さない（--force で 1日だけの確かめ）。名前・本文は出さない（場面と組の数だけ）。
//   実行: npx tsx --env-file=<鍵のある .env> scripts/audit-combo-vs-takeuchi.ts [--days=14] [--out=<json>] [--force]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns, readDecisionSources, aixFamily } from "./lib/prod-yardstick-db";
import { pickSendCombo } from "../app/lib/send-combo-table";
import { takeuchiCombo, type StaffMove } from "./lib/combo-of-moves";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const force = argv.includes("--force");
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (!force && jstHour >= 9 && jstHour < 22) { console.error("営業時間（JST 9〜22時）は流さない（--force で 1日だけ）"); process.exit(1); }
const days = force ? Math.min(Number(arg("days", "1")) || 1, 1) : Number(arg("days", "14")) || 14;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  const msgs = new Map<string, StaffMove[]>();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, staff_writer, is_aix_generated").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", since).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = msgs.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), aix: !!r.is_aix_generated, writer: (r.staff_writer as string | null) ?? null, customer: r.sender === "customer" });
        msgs.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const src = await readDecisionSources(sb, [...new Set(turns.map((t) => t.decision_id).filter((x): x is string => !!x))]);
  const table = new Map<string, { n: number; same: number; pairs: Map<string, number> }>();
  let n = 0;
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    const after = (msgs.get(t.conversation_id) ?? []).filter((m) => m.at > at);
    const first = after.find((m) => !m.customer);
    if (!first || first.writer !== "takeuchi") continue;
    const tc = takeuchiCombo(at, after);
    if (!tc) continue;
    const ds = t.decision_id ? src.get(String(t.decision_id)) ?? "" : "";
    const route: "reply" | "two_stage" | "aix" = /two_stage_promise/.test(ds) ? "two_stage" : aixFamily(t.brain_action) !== "返信" ? "aix" : "reply";
    const bp = pickSendCombo({ type: null, route, cues: { firstContact: /condition_hearing/.test(String(t.scene_key ?? "")) } });
    const bc = bp?.combo ?? (route === "aix" ? "aix_only" : route === "two_stage" ? "promise_then_aix_later" : "reply_only");
    const k = String(t.scene_key ?? "（場面なし）");
    const row = table.get(k) ?? { n: 0, same: 0, pairs: new Map() };
    row.n++; if (bc === tc) row.same++;
    const pk = `${tc}←${bc}`; row.pairs.set(pk, (row.pairs.get(pk) ?? 0) + 1);
    table.set(k, row); n++;
  }
  const out = [...table].sort((a, b) => b[1].n - a[1].n).map(([scene, r]) => ({ scene, n: r.n, same: r.same, pairs: Object.fromEntries([...r.pairs].sort((a, b) => b[1] - a[1])) }));
  console.log(`# 竹内さんの組 × ブレインの組（直近 ${days}日・竹内さんの番 ${n}・本文なし）`);
  for (const r of out) console.log(`- ${r.scene}: 同じ ${r.same}/${r.n}｜${Object.entries(r.pairs).map(([k, v]) => `${k} ${v}`).join("・")}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
