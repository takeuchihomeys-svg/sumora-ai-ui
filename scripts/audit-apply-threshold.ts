// scripts/audit-apply-threshold.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-threshold.ts
//
// 2026-09-20 竹内「テストしながらおねがい」:
//   detectApplyReadiness の閾値を**実データ**で決める。
//   群A=申込に到達（申込AIXの直前7日）／群B=未到達（最後のやり取りの直前7日）で点数を出し、
//   閾値ごとに「当たり（群Aを hot と言えた率）」と「空振り（群Bを hot と言ってしまう率）」を並べる。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { detectApplyReadiness, type ApplyMsg } from "../app/lib/apply-readiness";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLIED = ["applying", "application_push", "screening", "closed_won"];
const APPLY_AIX = ["application_push", "application_confirm"];

async function msgsBefore(convId: string, beforeIso: string): Promise<ApplyMsg[]> {
  const { data } = await sb.from("messages")
    .select("sender, text, created_at").eq("conversation_id", convId)
    .lt("created_at", beforeIso).order("created_at", { ascending: false }).limit(200);
  return ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>)
    .map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
}

async function main() {
  const convs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("conversations").select("id, customer_name, status, updated_at").range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    convs.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const A: Array<{ name: string; score: number; reason: string }> = [];
  const B: Array<{ name: string; score: number; reason: string }> = [];

  for (const c of convs.filter((x) => APPLIED.includes(String(x.status ?? "")))) {
    const { data: ap } = await sb.from("aix_usage_logs")
      .select("created_at").eq("conversation_id", c.id as string).in("aix_type", APPLY_AIX)
      .not("sent_at", "is", null).order("created_at", { ascending: true }).limit(1);
    if (!ap?.length) continue;
    const base = Date.parse(String(ap[0].created_at));
    const r = detectApplyReadiness(await msgsBefore(String(c.id), new Date(base).toISOString()), base);
    A.push({ name: String(c.customer_name), score: r.score, reason: r.reason });
  }
  // 2026-09-20 監査で見つけた測り方の誤り:
  //   「未到達」をそのまま対照群にすると、**まだ進行中の会話**（今日 内覧日程を送った人など）が
  //   高得点で「空振り」に数えられる。実際に群Bの上位は YUYA・まりあ・Hina で、どれも進行中だった。
  //   → 対照群は「**最後のやり取りから STALE_D 日以上経っていて申込していない**」＝実質の失注に絞る。
  const STALE_D = Number((process.argv.find((a) => a.startsWith("--stale=")) ?? "--stale=30").split("=")[1]);
  for (const c of convs.filter((x) => !APPLIED.includes(String(x.status ?? "")) && ["proposing", "viewing", "hearing", "property_recommendation", "condition_hearing", "availability_check", "estimate_request"].includes(String(x.status ?? "")))) {
    const base = Date.parse(String(c.updated_at ?? ""));
    if (!Number.isFinite(base)) continue;
    if (Date.now() - base < STALE_D * 86400_000) continue;   // まだ進行中の会話は対照にしない
    const ms = await msgsBefore(String(c.id), new Date(base + 1000).toISOString());
    const r = detectApplyReadiness(ms, base);
    if (r.windowCount < 4) continue;
    B.push({ name: String(c.customer_name), score: r.score, reason: r.reason });
  }
  console.log(`=== 群A 申込に到達 ${A.length}件 / 群B 未到達 ${B.length}件 ===\n`);

  console.log(`--- 閾値ごとの当たり・空振り ---`);
  console.log(`  ${"閾値".padStart(5)} ${"群Aを拾えた".padStart(12)} ${"群Bを誤って拾う".padStart(15)} ${"当たりの割合".padStart(13)}`);
  for (const th of [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]) {
    const a = A.filter((x) => x.score >= th).length;
    const b = B.filter((x) => x.score >= th).length;
    const prec = a + b > 0 ? (100 * a) / (a + b) : 0;
    console.log(`  ${String(th).padStart(5)} ${`${a}/${A.length} (${((100 * a) / Math.max(A.length, 1)).toFixed(0)}%)`.padStart(12)} ${`${b}/${B.length} (${((100 * b) / Math.max(B.length, 1)).toFixed(0)}%)`.padStart(15)} ${`${prec.toFixed(0)}%`.padStart(13)}`);
  }

  const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log(`\n  群A の点数: 中央値 ${med(A.map((x) => x.score))} / 最小 ${Math.min(...A.map((x) => x.score))} / 最大 ${Math.max(...A.map((x) => x.score))}`);
  console.log(`  群B の点数: 中央値 ${med(B.map((x) => x.score))} / 最小 ${Math.min(...B.map((x) => x.score))} / 最大 ${Math.max(...B.map((x) => x.score))}`);

  console.log(`\n--- 群B で点数が高い（誤って hot になる）実例 5件 ---`);
  B.sort((x, y) => y.score - x.score).slice(0, 5).forEach((x) => console.log(`  ${String(x.score).padStart(3)}点 ${x.name.padEnd(14)} ${x.reason}`));
  console.log(`\n--- 群A で点数が低い（取りこぼす）実例 5件 ---`);
  A.sort((x, y) => x.score - y.score).slice(0, 5).forEach((x) => console.log(`  ${String(x.score).padStart(3)}点 ${x.name.padEnd(14)} ${x.reason || "（合図なし）"}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
