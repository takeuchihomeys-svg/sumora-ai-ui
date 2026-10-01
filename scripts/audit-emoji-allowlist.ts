// scripts/audit-emoji-allowlist.ts
// 2026-10-02 竹内「絵文字は入れて良い絵文字だけにする。女性の絵文字いれない」: 人の手打ち・AIX の送信・AI の下書き（90日）の絵文字を数える（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-emoji-allowlist.ts [--ctx]（--ctx は 😊😌🌟 以外の前後の文）
// 決まりは app/lib/emoji-allowlist.ts。入れてよい物以外が増えていないか・女性の絵文字が出ていないかを見る
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function all(table: string, sel: string, f: (q: any) => any) {
  const out: any[] = [];
  for (let p = 0; p < 40; p++) { const { data, error } = await f(sb.from(table).select(sel)).range(p * 1000, p * 1000 + 999); if (error) { console.log(error.message); break; } out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}
const EMO = /\p{Extended_Pictographic}(?:️|‍(?:\p{Extended_Pictographic}|[♀♂])️?|[\u{1F3FB}-\u{1F3FF}])*|[♀♂]️?/gu;
function count(texts: string[]) { const c: Record<string, number> = {}; let msgs = 0; for (const t of texts) { const m = (t ?? "").match(EMO); if (m) { msgs++; for (const e of m) c[e] = (c[e] ?? 0) + 1; } } return { c, msgs }; }
async function main() {
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  const staff = await all("messages", "conversation_id, text, is_aix_generated", (q) => q.eq("sender", "staff").gte("created_at", since));
  const ex = await all("ai_reply_examples", "sent_reply, ai_draft, was_ai_used, was_ai_modified", (q) => q.gte("created_at", since).eq("entry_source", "line_reply"));
  const aiAsIs = new Set(ex.filter((e) => e.was_ai_used && !e.was_ai_modified).map((e) => (e.sent_reply ?? "").replace(/\s+/g, "").slice(0, 40)));
  const human = staff.filter((m) => !m.is_aix_generated && m.text && !m.text.startsWith("[画像]") && m.conversation_id !== "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" && !aiAsIs.has(m.text.replace(/\s+/g, "").slice(0, 40)));
  const aix = staff.filter((m) => m.is_aix_generated && m.text && !m.text.startsWith("[画像]"));
  const H = count(human.map((m) => m.text));
  console.log(`human sends ${human.length} (with emoji ${H.msgs})`);
  for (const [e, n] of Object.entries(H.c).sort((a, b) => b[1] - a[1])) console.log(`  H ${String(n).padStart(5)} ${e}  ${[...e].map((ch) => ch.codePointAt(0)!.toString(16)).join(" ")}`);
  const A = count(aix.map((m) => m.text));
  console.log(`AIX sent ${aix.length} (with emoji ${A.msgs})`);
  for (const [e, n] of Object.entries(A.c).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  X ${String(n).padStart(5)} ${e}`);
  const D = count(ex.map((e) => e.ai_draft ?? ""));
  console.log(`AI drafts ${ex.length} (with emoji ${D.msgs})`);
  for (const [e, n] of Object.entries(D.c).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  D ${String(n).padStart(5)} ${e}`);
  const fem = (t: string) => /♀|\u{1F469}/u.test(t);
  const femD = ex.filter((e) => fem(e.ai_draft ?? "")); const femX = aix.filter((m) => fem(m.text)); const femH = human.filter((m) => fem(m.text));
  console.log(`female: drafts ${femD.length} / AIX sent ${femX.length} / human ${femH.length}`);
  for (const e of femD.slice(0, 5)) console.log("   D:", (e.ai_draft ?? "").replace(/\s+/g, " ").slice(0, 120));
  for (const m of femX.slice(0, 5)) console.log("   X:", m.text.replace(/\s+/g, " ").slice(0, 120));
  for (const m of femH.slice(0, 8)) console.log("   H:", m.text.replace(/\s+/g, " ").slice(0, 120));
}
if (!process.argv.includes("--ctx")) main();
export async function ctx() {
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  const staff = await all("messages", "text, is_aix_generated", (q) => q.eq("sender", "staff").gte("created_at", since));
  const core = new Set(["😊", "😌", "🌟"]);
  const seen: Record<string, number> = {};
  for (const m of staff) {
    const t: string = m.text ?? ""; if (t.startsWith("[画像]")) continue;
    for (const mm of t.matchAll(EMO)) {
      const e = mm[0]; if (core.has(e)) continue;
      const i = mm.index!; const c = t.slice(Math.max(0, i - 14), i + e.length + 6).replace(/\s+/g, " ");
      const k = `${m.is_aix_generated ? "X" : "H"} ${e}`; if ((seen[k] = (seen[k] ?? 0) + 1) > 4) continue;
      console.log(`${k} …${c}…`);
    }
  }
}
if (process.argv.includes("--ctx")) ctx();
