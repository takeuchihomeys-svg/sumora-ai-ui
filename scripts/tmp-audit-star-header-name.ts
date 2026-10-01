// tmp: 物件オススメの本文の「🌟建物 号室」が、その会話の売上サポの資料の物件名と字が違う（似ているが一致しない）件数を数える
import { supabase as sb } from "../app/lib/supabase";
import { normalizePropertyName, similarity } from "../app/lib/property-name-match";
async function main() {
  const since = new Date(Date.now() - 21 * 86400000).toISOString();
  const { data: ms } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").eq("is_aix_generated", true).like("text", "🌟%").gte("created_at", since).limit(2000);
  let total = 0, exact = 0, near = 0, none = 0; const ex: string[] = [];
  for (const m of (ms ?? []) as Array<{ conversation_id: string; text: string }>) {
    const first = m.text.split("\n")[0].replace(/^🌟\s*/, "");
    const b = first.replace(/[\s　]*[A-Za-zＡ-Ｚ]?[0-9０-９]{1,5}[A-Za-zＡ-Ｚ]?\s*(号室)?\s*$/, "").trim();
    if (b.length < 2) continue;
    const { data: pk } = await sb.from("property_pickups").select("property_name").eq("conversation_id", m.conversation_id).limit(500);
    const names = [...new Set(((pk ?? []) as Array<{ property_name: string }>).map((p) => p.property_name))];
    if (!names.length) continue;
    total++;
    const nb = normalizePropertyName(b);
    if (names.some((n) => normalizePropertyName(n) === nb)) { exact++; continue; }
    const best = names.map((n) => ({ n, s: similarity(n, b) })).sort((x, y) => y.s - x.s)[0];
    if (best && best.s >= 0.6) { near++; ex.push(`${b} ← 資料「${best.n}」 ${best.s.toFixed(2)}`); } else none++;
  }
  console.log({ total, exact, near, none }); console.log(ex.slice(0, 40).join("\n"));
}
main();
