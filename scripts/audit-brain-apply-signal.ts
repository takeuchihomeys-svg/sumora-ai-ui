// 申込の場面で、ブレインは何と言っているか（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？実際スタッフが送る返信を生成する為にも」
// 設計知見「分析強化の原則」: **材料やルールを足す前に、届き方・鮮度を測って構造を直す**。
//
// audit-apply-intent.ts で分かったこと:
//   スタッフが申込を実行した410件のうち、顧客発言の分類は other 51% / ack_only 18%
//   申込の意思表示の**80%は「申込」の語を含まない**（regex では拾えない）
//
// reply-context.ts の型を読むと、ブレインの purchase_signal_level / checkpoint_stage は
// **conversation-scope**（会話全体の方針）で、メッセージの分類（classifyCustomerResponse）には
// 渡せない設計になっている（みく事例の汚染対策で正しい）。message-local は
// customer_questions / customer_concern / condition_change_type / hesitancy_pattern / customer_intent の5つだけ。
//
// なので問いは2つに分かれる:
//   ①ブレインは「申込の意思表示だ」と分かっているのに届いていないのか（＝配管の問題）
//   ②ブレインも分かっていないのか（＝分析の問題）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const STAFF_APPLY_DO_RE =
  /お?申込?(?:み)?(?:さ|し)せ(?:て)?(?:頂|いただ)き|お申し?込み(?:させて)?(?:頂|いただ)き|お申込み完了|申込み?番手|1番手[^\n]{0,6}(?:にて)?お申|お部屋(?:を)?(?:抑え|押さえ)させて(?:頂|いただ)き/;

async function main() {
  const days = Number(process.env.DAYS ?? 30);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }

  // 申込を実行した場面（顧客発言 → スタッフが申込実行）
  const cases: Array<{ conv: string; custAt: string; cust: string; staff: string }> = [];
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      let j = i + 1;
      while (j < list.length && list[j].sender === "customer") j++;
      if (j >= list.length) continue;
      const reply = list[j];
      if (reply.sender !== "staff" || !reply.text || !STAFF_APPLY_DO_RE.test(reply.text)) continue;
      cases.push({ conv: cid, custAt: m.created_at, cust: m.text, staff: reply.text });
    }
  }
  console.log(`=== 直近${days}日で「顧客発言 → スタッフが申込を実行」: ${cases.length}件 ===\n`);

  // その顧客発言の**後**・スタッフ返信の**前**に走ったブレインの判断を引く
  const convIds = [...new Set(cases.map((c) => c.conv))];
  const logs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < convIds.length; i += 40) {
    const { data } = await sb.from("brain_decision_logs")
      .select("conversation_id, created_at, suggested_action, conversation_status, digest")
      .in("conversation_id", convIds.slice(i, i + 40))
      .gte("created_at", since)
      .order("created_at", { ascending: true });
    logs.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
  }
  console.log(`ブレインの判断ログ ${logs.length}件\n`);

  let withBrain = 0;
  const sigCount = new Map<string, number>();
  const actionCount = new Map<string, number>();
  const intentCount = new Map<string, number>();
  const samples: string[] = [];
  for (const c of cases) {
    // 顧客発言の後で一番近いログ（±6時間）
    const cand = logs.filter((l) => l.conversation_id === c.conv
      && Date.parse(String(l.created_at)) >= Date.parse(c.custAt) - 60_000
      && Date.parse(String(l.created_at)) <= Date.parse(c.custAt) + 6 * 3600_000);
    if (cand.length === 0) continue;
    withBrain++;
    const l = cand[0];
    const d = (l.digest ?? {}) as Record<string, unknown>;
    const sig = String(d.sig ?? "-");
    const act = String(l.suggested_action ?? "なし");
    const intent = String(d.intent ?? d.customer_intent ?? "-");
    sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
    actionCount.set(act, (actionCount.get(act) ?? 0) + 1);
    intentCount.set(intent, (intentCount.get(intent) ?? 0) + 1);
    if (samples.length < 12) {
      samples.push(`  客「${c.cust.replace(/\n/g, " ").slice(0, 44)}」\n      ブレイン: action=${act} sig=${sig} intent=${intent} status=${l.conversation_status}\n      方向: ${String(d.dir ?? "").slice(0, 70)}\n      → 店「${c.staff.replace(/\n/g, " ").slice(0, 56)}」`);
    }
  }
  console.log(`=== ブレインの判断が残っている: ${withBrain}/${cases.length}件 ===`);
  const pct = (n: number) => withBrain ? `${((n / withBrain) * 100).toFixed(0)}%` : "-";

  console.log(`\n--- 購買シグナル（purchase_signal_level）---`);
  for (const [k, n] of [...sigCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}件 ${pct(n).padStart(4)}  ${k}`);
  console.log(`\n--- ブレインが出した AIX ---`);
  for (const [k, n] of [...actionCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}件 ${pct(n).padStart(4)}  ${k}`);
  console.log(`\n--- お客様の意図（customer_intent）---`);
  for (const [k, n] of [...intentCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}件 ${pct(n).padStart(4)}  ${k}`);
  console.log(`\n--- 実例 ---`);
  for (const s of samples) console.log(s + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
