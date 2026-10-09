// 読むだけ（LLM なし）: 御見積書の後のお客様の「安く・抑えたい」の番で、further-discount の判定（代表確認か・安いお部屋を探す形か）と
// 人の次の送信を並べる（2026-10-08 竹内さん「物件を指さない言い方は条件＝安いお部屋を探す形・このお部屋の費用を指す時だけ代表確認」）。
// 実行: npx tsx --env-file=.env.local scripts/audit-further-discount-target.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { customerAsksFurtherDiscount } from "../app/lib/further-discount";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
const WIDE = /安く|抑え|下げ|値引|割引|値下/;
(async () => {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const cust: any[] = [];
  for (let off = 0; ; off += 1000) {
    const { data } = await db.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since)
      .or("text.ilike.%安く%,text.ilike.%抑え%,text.ilike.%下げ%,text.ilike.%値引%,text.ilike.%割引%,text.ilike.%値下%").order("created_at").range(off, off + 999);
    cust.push(...(data ?? [])); if (!data || data.length < 1000) break;
  }
  const rows: string[] = []; const tally: Record<string, number> = {};
  for (const m of cust) {
    if (!WIDE.test(m.text ?? "") || /^\s*\[/.test(m.text)) continue;
    const { data: prev } = await db.from("messages").select("sender, text, created_at").eq("conversation_id", m.conversation_id).lt("created_at", m.created_at).gte("created_at", new Date(Date.parse(m.created_at) - 14 * 86400000).toISOString()).eq("sender", "staff");
    const est = (prev ?? []).some((p: any) => /御見積書|お見積書/.test(p.text ?? ""));
    if (!est) continue;
    const { data: nx } = await db.from("messages").select("sender, text, staff_writer, is_aix_generated, created_at").eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).order("created_at").limit(3);
    const staff = (nx ?? []).filter((x: any) => x.sender === "staff").slice(0, 2);
    const st = staff.map((x: any) => String(x.text)).join(" ⏎⏎ ");
    const human = /代表|申請|交渉|これ以上|最安|最大限|限界|上限/.test(st) ? "人=割引の答え" : /ピックアップ|お探し|探させ|お部屋.{0,12}(?:お送り|ご紹介)|抑えられるお部屋|安いお部屋/.test(st) ? "人=お部屋を探す" : "人=その他";
    const v = customerAsksFurtherDiscount(m.text) ? "代表確認" : "外す";
    const k = `${v}|${human}`; tally[k] = (tally[k] ?? 0) + 1;
    rows.push(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} [${v}] [${human}]\n   客: ${String(m.text).replace(/\n/g, " ⏎ ").slice(0, 160)}\n   人: ${st.replace(/\n/g, " ⏎ ").slice(0, 220)}`);
  }
  console.log(rows.join("\n"));
  console.log("\n集計（判定|人）", tally);
})();
