// scripts/audit-contact-promise.ts — 連絡の日の約束（contact-promise.parseContactPromise）を実送信の全期間に当てて、拾った文を目で読む（LLM なし・読むだけ）
// 2026-10-08 竹内さん「連絡する期間を約束したらカレンダーに入れる」
// 実行: npx tsx --env-file=.env.local scripts/audit-contact-promise.ts [--all]（--all で拾った文を全部出す）
import { createClient } from "@supabase/supabase-js";
import { parseContactPromise, ymdStr } from "../app/lib/contact-promise";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const rows: Array<{ id: string; conversation_id: string; text: string; created_at: string; staff_writer: string | null }> = [];
  // 候補: 月か「日頃」があり、こちらの動詞がある送信（全期間）
  for (const pat of ["%月%ご連絡%", "%月%お送り%", "%月%ピックアップ%", "%月%探し%", "%日頃%ご連絡%", "%日ごろ%ご連絡%", "%再相談%"]) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("messages").select("id, conversation_id, text, created_at, staff_writer").eq("sender", "staff").ilike("text", pat).order("created_at").range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < 1000) break;
    }
  }
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const hits = uniq.map((r) => ({ r, p: parseContactPromise(r.text, r.created_at) })).filter((x) => x.p);
  const by: Record<string, number> = {};
  for (const h of hits) by[h.r.staff_writer ?? "不明"] = (by[h.r.staff_writer ?? "不明"] ?? 0) + 1;
  console.log(`候補 ${uniq.length}通 → 連絡の日の約束 ${hits.length}通`, by);
  const show = process.argv.includes("--all") ? hits : hits.slice(-40);
  for (const { r, p } of show) {
    console.log(`\n[${r.created_at.slice(0, 16)} ${r.staff_writer ?? "?"} ${r.conversation_id.slice(0, 8)}] → ${ymdStr(p!.contact)}（${p!.kind}${p!.moveInLabel ? `・入居${p!.moveInLabel}` : ""}）\n  ${p!.sentence}`);
  }
  // 会社の事実「お部屋を抑えられる期間」の言い方（実送信）
  const holdRe = /(?:お?申込み?(?:いただいて|頂いて|頂いてから|いただいてから)?から\s*(?:1ヶ月|1か月|30日|40日)|抑える事が出来るのが|抑える事ができるのが|30日以上に延ばす|延ばせて40日)/;
  const { data: all } = await sb.from("messages").select("text, staff_writer").eq("sender", "staff").or("text.ilike.%1ヶ月以内%,text.ilike.%30日%,text.ilike.%40日%,text.ilike.%抑える事%").limit(5000);
  const holds = ((all ?? []) as Array<{ text: string; staff_writer: string | null }>).filter((m) => holdRe.test(m.text ?? ""));
  const n30 = holds.filter((m) => /1ヶ月|1か月|30日/.test(m.text)).length, n40 = holds.filter((m) => /40日/.test(m.text)).length;
  console.log(`\n抑えられる期間の説明 ${holds.length}通（1ヶ月・30日 ${n30}／40日 ${n40}）`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
