// app/lib/quoted-context.ts
// 2026-09-15 竹内（みく事例）: お客様が LINE の引用返信で「こちら３階は空きありますか？」と聞いた。引用先はスタッフが送った物件資料の画像
//   （robot home 太子橋 101号室）だったが、ブレイン・AIX には「[画像]」としか伝わらず、ブレインは駒川中野の物件と取り違え、
//   AIX 物件確認した（会話を合わせる）は 9/10 に紹介した別の物件（リアライズ長居公園通313号室）の3階と読んで確認前の文を作った。
//   スタッフが送った画像は送った時に Vision で物件名・号室を読んで sent_properties に残っている（extract-property-info）。
//   → 引用先の画像を sent_properties の image_url で物件に直す（推測ではなく記録）。引用先が文ならその文。
import { supabase } from "@/app/lib/supabase";

export type QuotedContext = {
  /** 引用したお客様の発言 */
  customerText: string;
  quotedSender: "staff" | "customer";
  /** 引用先の本文（画像なら null） */
  quotedText: string | null;
  isImage: boolean;
  /** 引用先の画像がスタッフの送った物件資料・見積書なら、その物件（「robot home 太子橋 101号室」）。分からなければ null */
  propertyLabel: string | null;
};

function propertyLabelOf(name: string | null | undefined, roomNo: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  const r = (roomNo ?? "").trim().replace(/^0+(?=\d)/, "");
  return r ? `${n} ${r}号室` : n;
}

/** 画像の URL → 送った物件（送った時の Vision 読み取り。sent_image_properties、無ければ sent_properties） */
export async function propertyLabelsForImages(conversationId: string, imageUrls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const urls = [...new Set(imageUrls.filter(Boolean))];
  if (urls.length === 0) return out;
  for (const table of ["sent_image_properties", "sent_properties"] as const) {
    const rest = urls.filter((u) => !out.has(u));
    if (rest.length === 0) break;
    const { data, error } = await supabase.from(table)
      .select("image_url, property_name, room_no")
      .eq("conversation_id", conversationId)
      .in("image_url", rest);
    if (error) { console.warn(`[quoted-context] ${table} read failed:`, error.message); continue; }
    for (const r of (data ?? []) as Array<{ image_url: string; property_name: string | null; room_no: string | null }>) {
      const label = propertyLabelOf(r.property_name, r.room_no);
      if (label && !out.has(r.image_url)) out.set(r.image_url, label);
    }
  }
  return out;
}

/** お客様の最新の発言（最後のスタッフ発言より後）のうち、引用返信の最後の1通の引用先 */
export async function resolveLatestQuotedContext(conversationId: string): Promise<QuotedContext | null> {
  try {
    const { data: rows } = await supabase.from("messages")
      .select("sender, text, quoted_message_id, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(8);
    const recent = (rows ?? []) as Array<{ sender: string; text: string | null; quoted_message_id: string | null }>;
    let target: (typeof recent)[number] | null = null;
    for (const m of recent) {
      if (m.sender !== "customer") { if (target) break; continue; }
      if (m.quoted_message_id) { target = m; break; }
    }
    if (!target?.quoted_message_id) return null;
    const { data: q } = await supabase.from("messages")
      .select("sender, text, image_url")
      .eq("conversation_id", conversationId)
      .eq("line_message_id", target.quoted_message_id)
      .maybeSingle();
    if (!q) return null;
    const quoted = q as { sender: string; text: string | null; image_url: string | null };
    const isImage = !quoted.text || /^\s*\[(?:画像|動画)\]\s*$/.test(quoted.text);
    let propertyLabel: string | null = null;
    if (isImage && quoted.image_url && quoted.sender === "staff") {
      propertyLabel = (await propertyLabelsForImages(conversationId, [quoted.image_url])).get(quoted.image_url) ?? null;
    }
    return {
      customerText: target.text ?? "",
      quotedSender: quoted.sender === "staff" ? "staff" : "customer",
      quotedText: isImage ? null : (quoted.text ?? "").slice(0, 400),
      isImage,
      propertyLabel,
    };
  } catch (e) {
    console.warn("[quoted-context] resolve failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 生成のプロンプトに入れる引用の説明（どの物件の話か） */
export function formatQuotedContextBlock(q: QuotedContext | null): string {
  if (!q) return "";
  const who = q.quotedSender === "staff" ? "スタッフ（こちら）" : "お客様自身";
  const what = q.isImage
    ? q.propertyLabel ? `物件資料・見積書の画像（${q.propertyLabel}）` : "画像"
    : `「${q.quotedText}」`;
  return `【💬 引用返信（確定事実・どの物件の話かの最優先の手がかり）】
お客様の発言「${q.customerText.replace(/\n/g, " ").slice(0, 120)}」は、${who}が送った${what}への引用返信です。
${q.propertyLabel ? `「こちら」「この物件」「〇階」は ${q.propertyLabel}（と同じ建物）を指す。会話の他の物件（以前に紹介した物件・号室）と取り違えないこと。` : "「こちら」「この物件」は引用先の内容を指す。会話の他の物件と取り違えないこと。"}`;
}
