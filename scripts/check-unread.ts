// scripts/check-unread.ts — 指摘の型「読めていない（画像・物件）」の点検（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳 #472）
//   決まりは app/lib/check-unread.ts。3つの分野で「読むべき物」と「読んだ記録」を数える:
//     ① お客様が反応したこちらの画像 → image_details か sent_image_properties（物件名あり）
//     ② お客様が送った画像 → customer_image_records（11/21 から・それより前の画像は記録が無いので --days は 11/21 以降で見る）
//     ③ AIX【物件確認した】の物件名（property_names が空でない）
//   出すのは数とメッセージ・記録の id だけ（お客様の文・名前・画像の中身は出さない）。営業時間は --days=1〜3 の軽い読み、30日は 22時以降に1本。
//   実行: npx tsx --env-file=.env.local scripts/check-unread.ts [--days=7] [--json]
import { createClient } from "@supabase/supabase-js";
import { reactedOurImages, unreadLine, type CuMsg, type UnreadRow } from "../app/lib/check-unread";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

export async function checkUnread(days: number): Promise<UnreadRow[]> {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const internal = new Set<string>(STAFF_INTERNAL_CONVERSATION_IDS as readonly string[]);
  const skip = (c: string) => isTestConversation(c) || isNoLineTestConversation(c) || internal.has(c);
  // 画像のある通（こちら・お客様）
  const imgs: Array<CuMsg & { conversation_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id,conversation_id,sender,text,image_url,created_at,quoted_message_id").not("image_url", "is", null).gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    imgs.push(...((data ?? []) as Array<CuMsg & { conversation_id: string }>).filter((m) => !skip(m.conversation_id)));
    if ((data ?? []).length < 1000) break;
  }
  const convs = [...new Set(imgs.filter((m) => m.sender === "staff").map((m) => m.conversation_id))];
  // こちらの画像の後の文（反応を見る）: 画像のある会話だけ
  const reacted: CuMsg[] = [];
  for (let i = 0; i < convs.length; i += 20) {
    const { data, error } = await sb.from("messages").select("id,conversation_id,sender,text,image_url,created_at,quoted_message_id,is_aix_generated").in("conversation_id", convs.slice(i, i + 20)).gte("created_at", since).order("created_at").limit(5000);
    if (error) throw new Error(error.message);
    const by = new Map<string, CuMsg[]>();
    for (const m of (data ?? []) as Array<CuMsg & { conversation_id: string }>) { const a = by.get(m.conversation_id) ?? []; a.push(m); by.set(m.conversation_id, a); }
    for (const ms of by.values()) reacted.push(...reactedOurImages(ms));
  }
  const readSet = async (urls: string[]) => {
    const got = new Set<string>();
    for (let i = 0; i < urls.length; i += 40) {
      const part = urls.slice(i, i + 40);
      const [d, s] = await Promise.all([
        sb.from("image_details").select("image_url").in("image_url", part),
        sb.from("sent_image_properties").select("image_url,property_name").in("image_url", part),
      ]);
      for (const r of (d.data ?? []) as Array<{ image_url: string }>) got.add(r.image_url);
      for (const r of (s.data ?? []) as Array<{ image_url: string; property_name: string | null }>) if (r.property_name) got.add(r.image_url);
    }
    return got;
  };
  const ourUrls = [...new Set(reacted.map((m) => m.image_url as string))];
  // お客様の画像の記録（customer_image_records）が本番で既定 on になったのは 11/21 04:42 JST（作業員G）。それより前の画像は記録が無いのが正しいので数えない（G の backfill の後に外す）
  const CUSTOMER_IMAGE_RECORD_ON_AT = "2026-11-20T19:42:00Z";
  const custImgs = imgs.filter((m) => m.sender === "customer" && m.created_at >= CUSTOMER_IMAGE_RECORD_ON_AT);
  const custUrls = [...new Set(custImgs.map((m) => m.image_url as string))];
  const ourRead = await readSet(ourUrls);
  // お客様の画像の読みは customer_image_records（message_id・作業員G 11/21 から既定 on）。image_details はこちらの画像だけ（image-detail-store の決まり）
  const custRead = new Set<string>();
  const custIds = custImgs.map((m) => m.id);
  for (let i = 0; i < custIds.length; i += 100) {
    const { data } = await sb.from("customer_image_records").select("message_id").in("message_id", custIds.slice(i, i + 100));
    const got = new Set(((data ?? []) as Array<{ message_id: string }>).map((r) => r.message_id));
    for (const m of custImgs) if (got.has(m.id)) custRead.add(m.image_url as string);
  }
  // AIX【物件確認した】の物件名
  const { data: ax, error: axe } = await sb.from("aix_usage_logs").select("id,conversation_id,property_names").eq("aix_type", "property_check_result").gte("created_at", since).limit(3000);
  if (axe) throw new Error(axe.message);
  const axRows = ((ax ?? []) as Array<{ id: string; conversation_id: string; property_names: string[] | null }>).filter((r) => !skip(r.conversation_id));
  const axUn = axRows.filter((r) => !(r.property_names ?? []).some((n) => String(n ?? "").trim()));
  return [
    { field: "reacted_our_image", total: ourUrls.length, read: ourUrls.filter((u) => ourRead.has(u)).length, examples: reacted.filter((m) => !ourRead.has(m.image_url as string)).slice(0, 6).map((m) => m.id.slice(0, 8)) },
    { field: "customer_image", total: custUrls.length, read: custUrls.filter((u) => custRead.has(u)).length, examples: custImgs.filter((m) => !custRead.has(m.image_url as string)).slice(0, 6).map((m) => m.id.slice(0, 8)) },
    { field: "check_result_property", total: axRows.length, read: axRows.length - axUn.length, examples: axUn.slice(0, 6).map((r) => String(r.id).slice(0, 8)) },
  ];
}

if (process.argv[1]?.endsWith("check-unread.ts")) {
  const days = Number(arg("days", "7")) || 7;
  checkUnread(days).then((rows) => {
    if (argv.includes("--json")) { console.log(JSON.stringify({ days, rows })); return; }
    console.log(`読めていない型の点検（${days}日）`);
    for (const r of rows) console.log(`- ${unreadLine(r)}`);
  }).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
