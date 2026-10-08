// scripts/audit-viewing-morning-greeting.ts — 内覧当日の朝の挨拶の要対応を過去の朝に当てる（読むだけ・LLM なし・登録/通知しない）
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-morning-greeting.ts [--days=30]
//   毎朝 JST 9:15 の時点で runViewingMorningGreeting（dryRun・その時刻より後の材料は読まない）が「立てる」と決めた会話について、
//   その日にスタッフが実際に当日の挨拶（本日…よろしく 等）を送ったか・お客様の発言より先か・送らなかったかを数える。
import { runViewingMorningGreeting } from "../app/lib/viewing-morning-greeting-server";
import { VIEWING_DAY_GREETING_DONE_RE } from "../app/lib/aix-item-cleanup";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);
const DAY = 86_400_000;

async function main() {
  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const tally: Record<string, number> = {};
  const outcome: Record<string, number> = {};
  const lines: string[] = [];
  for (let d = days; d >= 0; d--) {
    const ymd = new Date(Date.parse(`${todayJst}T00:00:00Z`) - d * DAY).toISOString().slice(0, 10);
    const nowMs = Date.parse(`${ymd}T09:15:00+09:00`);
    if (nowMs > Date.now()) continue;
    const r = await runViewingMorningGreeting({ nowMs, dryRun: true, ignorePending: true });
    for (const row of r.rows) tally[row.why] = (tally[row.why] ?? 0) + 1;
    for (const row of r.rows.filter((x) => x.why === "due")) {
      const dayEnd = new Date(Date.parse(`${ymd}T00:00:00+09:00`) + DAY).toISOString();
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", row.conversationId)
        .gt("created_at", new Date(nowMs).toISOString()).lt("created_at", dayEnd).order("created_at").limit(60);
      const ms = (data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
      const gi = ms.findIndex((m) => m.sender !== "customer" && VIEWING_DAY_GREETING_DONE_RE.test(String(m.text ?? "").normalize("NFKC")));
      const ci = ms.findIndex((m) => m.sender === "customer");
      const kind = gi < 0 ? (ci < 0 ? "挨拶なし・お客様の発言なし" : "挨拶なし・お客様の発言あり") : ci >= 0 && ci < gi ? "挨拶あり（お客様の発言の後）" : "挨拶あり（お客様より先）";
      outcome[kind] = (outcome[kind] ?? 0) + 1;
      lines.push(`${ymd}\t${row.conversationId.slice(0, 8)}\t${row.appointment ?? ""}\t${kind}${gi >= 0 ? `\t「${String(ms[gi].text ?? "").replace(/\s+/g, " ").slice(0, 40)}」${ms[gi].created_at.slice(11, 16)}Z` : ""}`);
    }
  }
  console.log(`=== ${days}日の朝 9:15 の判定 ===`); console.log(tally);
  console.log("=== 立てた番のその日の実際 ==="); console.log(outcome);
  for (const l of lines) console.log(l);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
