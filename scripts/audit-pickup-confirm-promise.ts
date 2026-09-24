// 監査（読み取りだけ）: 物件ピックアップの送付の文（スタッフの実送信）に「駐車場・ペット・保証会社・審査 … 確認させて頂きます」の約束が何通あるか。
//   0通なら、AIX【物件ピックアップした】の出口でこの行を落としても誤削除0（設計知見「出口は誤削除0の時だけ」）
// 使い方: npx tsx --env-file=.env.local scripts/audit-pickup-confirm-promise.ts [--days=365] [--out=ファイル]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isPastPickupSend, findUncheckedClaimInPickupLine } from "../app/lib/pickup-send-facts";
import { findUnkeptConfirmPromiseLines } from "../app/lib/property-send-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const DAYS = Number(arg("days") ?? 365);
const OUT = arg("out");

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  let pickupSends = 0, humanSends = 0, aixSends = 0;
  const humanHits: string[] = [], aixHits: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("messages").select("text, created_at, is_aix_generated, conversation_id")
      .eq("sender", "staff").gte("created_at", since).not("text", "is", null)
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ text: string; created_at: string; is_aix_generated: boolean | null; conversation_id: string }>;
    for (const r of rows) {
      if (!isPastPickupSend("staff", r.text)) continue;
      pickupSends++;
      if (r.is_aix_generated) aixSends++; else humanSends++;
      // 出口で落とす行（確認の約束）＋注意に出す句（ピックアップ行の「駐車場の空き状況も含めて」）
      const claim = findUncheckedClaimInPickupLine(r.text);
      const hits = [...findUnkeptConfirmPromiseLines(r.text), ...(claim ? [`[注意の句] ${claim}`] : [])];
      if (hits.length === 0) continue;
      const line = `[${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)}${r.is_aix_generated ? " AIX" : ""}] ${hits.join(" ／ ")}`;
      (r.is_aix_generated ? aixHits : humanHits).push(line);
    }
    if (rows.length < 1000) break;
    from += 1000;
  }
  const text = [
    `物件ピックアップの送付 ${pickupSends}通（${DAYS}日・手打ち ${humanSends}／AIX ${aixSends}）`,
    `手打ち（スタッフの実文）で当たった行: ${humanHits.length}通`, ...humanHits,
    ``, `AIX の送付で当たった行: ${aixHits.length}通`, ...aixHits,
  ].join("\n");
  if (OUT) writeFileSync(OUT, text, "utf8"); else console.log(text);
}
main().catch((e) => { console.error(e); process.exit(1); });
