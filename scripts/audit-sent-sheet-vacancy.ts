// scripts/audit-sent-sheet-vacancy.ts — 送った資料の現況をブレインの送った物件の行に載せた時の形を、本物のデータで読むだけで確かめる（LLM なし・書かない）
// 2026-10-24 q053 型（BRAIN_SENT_SHEET_VACANCY）。物件名は出すが、お客様の名前・文は出さない。
//   npx tsx --env-file=.env.local scripts/audit-sent-sheet-vacancy.ts [--days=60] [--convs=8] [--conv=<id>]
import { createClient } from "@supabase/supabase-js";
import { buildSentProps, buildSentPropsText, attachSheetVacancy } from "../app/lib/sent-props-text";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const days = Number(arg("days", "60")), maxConvs = Number(arg("convs", "8")), one = arg("conv", "");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let convIds: string[] = [];
  if (one) convIds = [one];
  else {
    const { data } = await sb.from("sent_properties").select("conversation_id").eq("delivery", "customer").not("image_url", "is", null).is("recruitment_status", null).gte("sent_at", since).order("sent_at", { ascending: false }).limit(400);
    convIds = [...new Set((data ?? []).map((r) => String(r.conversation_id)).filter((x) => x && x !== "null"))].slice(0, maxConvs);
  }
  let totalProps = 0, totalAttached = 0, before = 0;
  for (const cid of convIds) {
    const { data: rows } = await sb.from("sent_properties")
      .select("property_name, room_no, sent_at, rent, recruitment_status, applicant_rank, customer_reaction, source, channel, delivery, pickup_id, image_url")
      .eq("conversation_id", cid).or("source.is.null,source.neq.line_group").order("sent_at", { ascending: false }).limit(20);
    const props = buildSentProps({ customerRows: (rows ?? []) as never, imageRows: [], sharedRows: [] });
    const urls = [...new Set(props.flatMap((p) => p.image_urls ?? []))];
    const { data: det } = urls.length ? await sb.from("image_details").select("image_url, lines").in("image_url", urls) : { data: [] };
    const n = attachSheetVacancy(props, new Map(((det ?? []) as Array<{ image_url: string; lines: unknown }>).map((d) => [d.image_url, d.lines])));
    totalProps += props.length; totalAttached += n; before += props.filter((p) => p.recruitment_status).length;
    console.log(`\n=== 会話 ${cid.slice(0, 8)}: 送った物件 ${props.length}・状態あり（今） ${props.filter((p) => p.recruitment_status).length}・資料の現況を付けた ${n}`);
    console.log(buildSentPropsText(props).split("\n").filter((l) => l.startsWith("- ") || l.startsWith("※「")).join("\n"));
  }
  console.log(`\n合計: 会話 ${convIds.length}・送った物件 ${totalProps}・状態あり（今） ${before}・資料の現況を付けた ${totalAttached}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
