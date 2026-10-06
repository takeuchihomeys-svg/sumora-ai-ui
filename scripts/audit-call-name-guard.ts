// scripts/audit-call-name-guard.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-call-name-guard.ts [--days=180] [--show=20]
// 2026-10-06 ⑫ 竹内「名前間違えているの絶対にいれない」（あ・「森本様」）
//   ① AI の下書き・AIX の文（ai_reply_examples.ai_draft）に、会話に出てこない名前の呼びかけが何通あったか（call-name-guard.enforceCallName が直す数）
//   ② 人の送信（messages のスタッフの手打ち）に同じ出口を当てた時に変わる通（0 であるべき）。会話はその送信より前の文だけを手がかりにする
// 読み取りのみ。名前は伏せて出す（先頭1字＋＊）。
import { createClient } from "@supabase/supabase-js";
import { enforceCallName, lockedCallName } from "../app/lib/call-name-guard";
import { staffCalledName } from "../app/lib/aix-staff-called-name";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "20"));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const maskName = (s: string) => s.replace(/^(.)(.*?)(様|さん|さま)$/, (_m, a: string, b: string, h: string) => `${a}${"＊".repeat(b.length)}${h}`);

async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); if (!data?.length) break; out.push(...data); if (data.length < 1000) break; }
  return out;
}

async function main() {
  type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
  const convs = await pageAll<{ id: string; customer_name: string | null }>((a, b) => sb.from("conversations").select("id, customer_name").range(a, b));
  const convName = new Map(convs.map((c) => [c.id, c.customer_name ?? ""]));
  const msgs = await pageAll<M>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").range(a, b));
  const ex = await pageAll<{ conversation_id: string | null; ai_draft: string | null; created_at: string; entry_source: string | null }>((a, b) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, created_at, entry_source").gte("created_at", since).not("ai_draft", "is", null).range(a, b));
  const byConv = new Map<string, M[]>();
  for (const m of msgs) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m]);
  const nameAt = (conv: string, at: string) => {
    const before = (byConv.get(conv) ?? []).filter((m) => m.created_at < at);
    const human = before.filter((m) => m.sender !== "customer" && !m.is_aix_generated).map((m) => ({ sender: "staff", text: m.text }));
    return { name: lockedCallName({ staffCalled: staffCalledName(human) }).name, ctx: before.map((m) => m.text), allow: [convName.get(conv) ?? ""] };
  };
  // ① AI の文
  let aiN = 0, aiFixed = 0; const aiEx: string[] = [];
  for (const e of ex) {
    if (!e.conversation_id || !e.ai_draft) continue;
    aiN++;
    const { name, ctx, allow } = nameAt(e.conversation_id, e.created_at);
    const f = enforceCallName(e.ai_draft, name, ctx, allow);
    if (f.replaced.length) { aiFixed++; if (aiEx.length < show) aiEx.push(`${e.created_at.slice(0, 10)} ${e.entry_source ?? "-"} 呼び名=${name ? maskName(name + "さん") : "（なし）"} 直した=${f.replaced.map(maskName).join("・")}`); }
  }
  // ② 人の送信
  let humanN = 0, humanFixed = 0; const humanEx: string[] = [];
  for (const [conv, list] of byConv) {
    for (const m of list) {
      if (m.sender === "customer" || m.is_aix_generated || !m.text) continue;
      humanN++;
      const { name, ctx, allow } = nameAt(conv, m.created_at);
      const f = enforceCallName(m.text, name, ctx, allow);
      if (f.replaced.length) { humanFixed++; if (humanEx.length < show) humanEx.push(`${m.created_at.slice(0, 10)} 呼び名=${name ? maskName(name + "さん") : "（なし）"} 直した=${f.replaced.map(maskName).join("・")} | ${m.text.replace(/\n/g, " / ").replace(/[一-鿿ぁ-んァ-ヶ]{1,8}(?=様|さん)/g, (w) => w[0] + "＊".repeat(w.length - 1)).slice(0, 90)}`); }
    }
  }
  console.log(`=== ① AI の下書き・AIX の文 ${aiN}通（${days}日）のうち、会話に出てこない名前の呼びかけを直す: ${aiFixed}通 ===`);
  for (const x of aiEx) console.log("  " + x);
  console.log(`\n=== ② 人の送信 ${humanN}通に同じ出口を当てて変わる: ${humanFixed}通（0 であるべき・目で読む）===`);
  for (const x of humanEx) console.log("  " + x);
}
main().catch((e) => { console.error(e); process.exit(1); });
