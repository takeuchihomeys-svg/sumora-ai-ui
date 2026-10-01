import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data } = await sb.from("messages").select("created_at, sender, is_aix_generated, text").eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").order("created_at", { ascending: false }).limit(10);
  for (const m of data ?? []) console.log(m.created_at, m.sender, m.is_aix_generated, String(m.text ?? "").slice(0, 40).replace(/\n/g, " "));
  // 実送信全体: 物件オススメの1通目（🌟）の直後のスタッフの文が is_aix_generated=true の割合
  const out: any[] = [];
  for (let p = 0; p < 200; p++) { const { data: d } = await sb.from("messages").select("conversation_id, sender, is_aix_generated, text, created_at").order("conversation_id").order("created_at").range(p * 1000, p * 1000 + 999); out.push(...(d ?? [])); if ((d ?? []).length < 1000) break; }
  let n = 0, aixNext = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    if (a.conversation_id !== b.conversation_id || a.sender !== "staff" || !a.is_aix_generated || !/^\s*🌟/.test(a.text ?? "")) continue;
    if (b.sender !== "staff" || !b.text || b.text === "[画像]") continue;
    n++; if (b.is_aix_generated) aixNext++;
  }
  console.log({ firstThenStaff: n, nextIsAix: aixNext });
}
main();
