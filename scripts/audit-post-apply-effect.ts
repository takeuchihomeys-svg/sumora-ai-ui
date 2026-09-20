// 申込後の3場面を足した効果を全件で測る（読み取りのみ）
//
// 2026-09-20 竹内「直す」の全件監査（CLAUDE.md 手順7: 変換の前後を**目で読む**。件数だけ見ない）
// 直す前（audit-staff-other2.ts）: 返信生成が起きる場面 2,459件のうち
//   台帳ありでも直前スタッフ発言が other ＝ **674件（27.4%）**
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn, analyzeSubstance, classifyCustomerResponse, resolveTurnPair } from "../app/lib/reply-context";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage, type LedgerTask } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const NEW_KINDS = new Set(["docs_request", "apply_done", "screening_wait"]);

async function main() {
  const days = Number(process.env.DAYS ?? 30);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 28; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
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

  let total = 0, other = 0, withRule = 0;
  const byKind = new Map<string, number>();
  const newOnes: Array<{ kind: string; staff: string; cust: string; rule: string }> = [];
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      let k = i - 1;
      while (k >= 0 && list[k].sender === "customer") k--;
      if (k < 0) continue;
      const staffText = list[k].text ?? "";
      if (!staffText) continue;
      total++;
      const ledger = buildActionLedger({
        recentAixRows: aixByConv.get(cid) ?? [],
        messages: list.slice(0, i).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at } as LedgerMessage)),
        lineTasks: [] as LedgerTask[], lastCustomerAt: m.created_at, now: Date.parse(m.created_at),
      });
      const st = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: list[k].created_at, ledger });
      byKind.set(st.kind, (byKind.get(st.kind) ?? 0) + 1);
      if (st.kind === "other") other++;
      const sub = analyzeSubstance(m.text, undefined, { staffAskedQuestion: st.kind === "question_to_customer" });
      const cust = classifyCustomerResponse(sub, st, { ledger });
      const pair = resolveTurnPair(st, cust, sub, staffText, { ledger, customerName: "" });
      if (pair.ruleId) withRule++;
      if (NEW_KINDS.has(st.kind) && newOnes.length < 900) {
        newOnes.push({ kind: st.kind, staff: staffText.replace(/\n/g, " ／ ").slice(0, 80), cust: (m.text ?? "").replace(/\n/g, " ").slice(0, 34), rule: pair.ruleId ?? "(なし)" });
      }
    }
  }
  const p = (n: number) => total ? `${((n / total) * 100).toFixed(1)}%` : "-";
  console.log(`=== 直近${days}日「お客様が返信した場面」 ${total}件 ===\n`);
  console.log(`  直前スタッフ発言が other : ${other}件 (${p(other)})   ← 直す前は 674件 (27.4%)`);
  console.log(`  往復文脈のセルが選ばれた : ${withRule}件 (${p(withRule)})`);
  console.log(`\n--- 分類の内訳 ---`);
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    const mark = NEW_KINDS.has(k) ? " ★新" : "";
    console.log(`  ${String(n).padStart(4)}件 (${p(n).padStart(5)})  ${k}${mark}`);
  }

  const newTotal = newOnes.length;
  console.log(`\n=== ★ 新しく分類された ${newTotal}件（全部目で読む・誤分類が1件でもあれば入れない）===`);
  const byNew = new Map<string, typeof newOnes>();
  for (const n of newOnes) {
    if (!byNew.has(n.kind)) byNew.set(n.kind, []);
    byNew.get(n.kind)!.push(n);
  }
  for (const [k, list] of byNew) {
    console.log(`\n── ${k}（${list.length}件）──`);
    const seen = new Set<string>();
    let shown = 0;
    for (const n of list) {
      if (seen.has(n.staff)) continue;   // 同じスタッフ発言の重複は1回だけ見る
      seen.add(n.staff);
      if (shown++ >= 20) break;
      console.log(`  [rule=${n.rule}] 店「${n.staff}」`);
      console.log(`                    → 客「${n.cust}」`);
    }
    console.log(`  （ユニークなスタッフ発言 ${seen.size}件のうち先頭 ${Math.min(shown, seen.size)}件）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
