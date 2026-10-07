// scripts/audit-r7-scene-words.ts — 7巡目: reply-scene の語の足し（REPLY_SCENE_R7）で場面が変わるお客様の番を全部並べる（読むだけ・LLM なし）
//   番 = お客様の連投（つないだ文）。前（REPLY_SCENE_R7=off）と後で場面が違う番と、その時のスタッフの最初の手打ちの返事を出す
// 実行: npx tsx --env-file=.env.local scripts/audit-r7-scene-words.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null }>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const by = new Map<string, typeof msgs>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  let n = 0; const changed: string[] = []; const moves = new Map<string, number>();
  for (const [, list] of by) for (let i = 0; i < list.length; i++) {
    if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
    let j = i; while (j + 1 < list.length && list[j + 1].sender === "customer") j++;
    const text = list.slice(i, j + 1).map((m) => m.text ?? "").join("\n"); n++;
    process.env.REPLY_SCENE_R7 = "off"; const a = resolveReplyScene({ customerText: text });
    delete process.env.REPLY_SCENE_R7; const b = resolveReplyScene({ customerText: text });
    if (a.scene === b.scene) continue;
    const st = list.slice(j + 1).find((x) => x.sender !== "customer" && !x.is_aix_generated && (x.text ?? "").trim() && !/^\[/.test(x.text ?? ""));
    const k = `${a.scene}→${b.scene}`; moves.set(k, (moves.get(k) ?? 0) + 1);
    changed.push(`${k} C「${text.replace(/\n/g, " ").slice(0, 60)}」→ 人「${(st?.text ?? "（返事なし／AIX）").replace(/\n/g, "⏎").slice(0, 70)}」`);
  }
  console.log(`番 ${n}・変わる ${changed.length}: ${[...moves].map(([k, v]) => `${k} ${v}`).join("・")}`);
  for (const c of changed) console.log(`  ${c}`);
})();
