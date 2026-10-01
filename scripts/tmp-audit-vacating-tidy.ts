// 出口 tidyVacatingAndClosing（前の版の一文を今の一文に戻す）が実送信のどの文に当たるか（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { tidyVacatingAndClosing, VACATING_NO_DATE_LINE } from "../app/lib/recommend-viewable";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const out: any[] = [];
  for (let p = 0; p < 200; p++) { const { data } = await sb.from("messages").select("conversation_id, text, is_aix_generated").eq("sender", "staff").order("created_at").range(p * 1000, p * 1000 + 999); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  const rows = out.filter((r) => r.text && !isTestConversation(r.conversation_id));
  let hit = 0, human = 0, deleted = 0;
  for (const r of rows) {
    const whens = new Set<string>();
    for (const m of r.text.matchAll(/(\d{1,2})月(上旬|中旬|下旬|末|\d{1,2}日)/g)) whens.add(`${Number(m[1])}月${m[2]}`);
    for (const w of whens) {
      const v = { notViewable: true, viewableFrom: null, line: VACATING_NO_DATE_LINE, source: "material" as const, moveInWhen: w };
      const res = tidyVacatingAndClosing(r.text, v);
      const changed = res.applied.filter((a) => a === "vacating_line_no_move_in" || a === "vacating_line_exact");
      if (changed.length) { hit++; if (!r.is_aix_generated) human++; console.log(r.is_aix_generated ? "[AIX]" : "[人]", w, "|", r.text.replace(/\n/g, "⏎").slice(0, 160)); console.log("   →", res.text.replace(/\n/g, "⏎").slice(0, 160)); }
      if (res.text.replace(/\s/g, "").length < r.text.replace(/\s/g, "").length - 40) deleted++;
    }
  }
  console.log({ staff: rows.length, hit, human, bigShrink: deleted });
}
main();
