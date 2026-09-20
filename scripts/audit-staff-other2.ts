// 行動台帳を渡したら「直前スタッフ発言が other」はどこまで減るか（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？」
// audit-staff-other.ts は台帳を渡さずに測って 36.0% だった（上限値）。
// classifyLastStaffTurn は ⓪で `opts.ledger.facts.lastStaffEntry` を最優先に見る設計なので、
// 台帳が届いていれば救える。本番と同じ条件（台帳あり）で測り直し、
// **台帳でも救えない分**＝本当の穴を出す。
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn } from "../app/lib/reply-context";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const days = Number(process.env.DAYS ?? 30);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null }> = [];
  for (let p = 0; p < 24; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const aix: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 8; p++) {
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    aix.push(...r);
    if (r.length < 1000) break;
  }
  const { data: taskData } = await sb.from("line_tasks").select("conversation_id, task_type, status, created_at, result").gte("created_at", since).limit(3000);
  const tasks = (taskData ?? []) as unknown as Array<Record<string, unknown>>;

  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  const aixByConv = new Map<string, LedgerAixRow[]>();
  for (const a of aix) {
    const c = String(a.conversation_id ?? "");
    if (!aixByConv.has(c)) aixByConv.set(c, []);
    aixByConv.get(c)!.push({ aix_type: String(a.aix_type ?? ""), created_at: String(a.created_at ?? ""), sent_at: (a.sent_at as string | null) ?? null, generated_text: (a.generated_text as string | null) ?? null });
  }
  const taskByConv = new Map<string, LedgerTask[]>();
  for (const t of tasks) {
    const c = String(t.conversation_id ?? "");
    if (!taskByConv.has(c)) taskByConv.set(c, []);
    taskByConv.get(c)!.push({ task_type: String(t.task_type ?? ""), status: String(t.status ?? ""), created_at: String(t.created_at ?? ""), result: (t.result as string | null) ?? null } as LedgerTask);
  }

  // 「お客様の発言の直前のスタッフ発言」を本番と同じ形で分類する（＝返信生成が起きる場面）
  let total = 0, otherNoLedger = 0, otherWithLedger = 0;
  const savedBy = new Map<string, number>();
  const stillOther: Array<{ text: string; cust: string }> = [];
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      let k = i - 1;
      while (k >= 0 && list[k].sender === "customer") k--;
      if (k < 0) continue;
      const lastStaff = list[k];
      const text = lastStaff.text ?? "";
      if (!text) continue;
      total++;

      const ledger = buildActionLedger({
        recentAixRows: aixByConv.get(cid) ?? [],
        messages: list.slice(0, i).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at } as LedgerMessage)),
        lineTasks: taskByConv.get(cid) ?? [],
        lastCustomerAt: m.created_at,
        now: Date.parse(m.created_at),
      });
      const a = classifyLastStaffTurn(text, { recentAixRows: [], lastStaffAt: lastStaff.created_at });
      const b = classifyLastStaffTurn(text, { recentAixRows: [], lastStaffAt: lastStaff.created_at, ledger });
      if (a.kind === "other") otherNoLedger++;
      if (b.kind === "other") {
        otherWithLedger++;
        if (stillOther.length < 18) stillOther.push({ text: text.replace(/\n/g, " ／ ").slice(0, 88), cust: (m.text ?? "").replace(/\n/g, " ").slice(0, 40) });
      } else if (a.kind === "other") {
        savedBy.set(b.kind, (savedBy.get(b.kind) ?? 0) + 1);
      }
    }
  }
  const p = (n: number) => total ? `${((n / total) * 100).toFixed(1)}%` : "-";
  console.log(`=== 直近${days}日「お客様が返信した場面」 ${total}件（＝返信生成が起きる回数）===\n`);
  console.log(`  台帳なしで直前スタッフ発言が other : ${otherNoLedger}件 (${p(otherNoLedger)})`);
  console.log(`  **台帳ありでも other**            : ${otherWithLedger}件 (${p(otherWithLedger)})  ← 本当の穴`);
  console.log(`  台帳が救った                      : ${otherNoLedger - otherWithLedger}件`);
  console.log(`\n--- 台帳が救った内訳 ---`);
  for (const [k, n] of [...savedBy.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}件  → ${k}`);
  console.log(`\n--- 台帳でも other のまま（本当の穴）の実例 ---`);
  for (const s of stillOther) {
    console.log(`  店「${s.text}」`);
    console.log(`     → 客「${s.cust}」`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
