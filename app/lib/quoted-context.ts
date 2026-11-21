// app/lib/quoted-context.ts
// 2026-09-15 竹内（みく事例）: お客様が LINE の引用返信で「こちら３階は空きありますか？」と聞いた。引用先はスタッフが送った物件資料の画像
//   （robot home 太子橋 101号室）だったが、ブレイン・AIX には「[画像]」としか伝わらず、ブレインは駒川中野の物件と取り違え、
//   AIX 物件確認した（会話を合わせる）は 9/10 に紹介した別の物件（リアライズ長居公園通313号室）の3階と読んで確認前の文を作った。
//   スタッフが送った画像は送った時に Vision で物件名・号室を読んで sent_properties に残っている（extract-property-info）。
//   → 引用先の画像を sent_properties の image_url で物件に直す（推測ではなく記録）。引用先が文ならその文。
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるように。こっちが送った画像なら deepseek で読み取れる
//   ようになってるはずなので、そこで読み取ってちゃんとした文を生成できるようにする」
//   ＝ 「どの物件か」だけでなく、**資料に書いてある条件**（駐車場・ペット・保証会社・洗濯機置場・設備）も渡す。
//   実測（直近120日・こちらが送った画像への引用返信133件）:
//     資料を読まないと答えられない質問 44件（33.1%）／うち75%はスタッフが確認を挟まず**その場で答えていた**。
//   読み取りは image_details（送った時・引用が来た時に読んで残す）。ここでは**表を見るだけ**なので待ち時間は増えない。
//
// ※ プロンプトに入れる文（純関数）は quoted-note.ts。ここは DB から引用先を引く所だけ。
import { supabase } from "@/app/lib/supabase-server";
import { getImageDetails } from "@/app/lib/image-detail-store";
import type { ImageKind } from "@/app/lib/property-image-read";
import type { QuotedContext } from "@/app/lib/quoted-note";
import { isAfterCutoff, type DeepseekCutoff } from "@/app/lib/post-apply";

export type { QuotedContext } from "@/app/lib/quoted-note";
export { formatQuotedDetailBlock, describeQuotedTarget, buildQuotedReplyNote, formatQuotedContextBlock } from "@/app/lib/quoted-note";

// 物件名の形は画面の引用の枠（quote-preview.ts）と同じ関数（ブレイン・生成・画面で同じ名前に揃える）
import { propertyLabelOf } from "@/app/lib/quote-preview";

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

type QuotedPair = {
  customerText: string;
  /** 引用したお客様の発言の時刻 */
  customerAt: string | null;
  quoted: { sender: string; text: string | null; image_url: string | null; created_at?: string | null };
  /** 同じ流れ（続けてのお客様の発言）のほかの引用（古い順）。2026-10-07 Ryoichi kiritsuke「ここと」「ここを見に行きたいです」 */
  others: Array<{ customerText: string; customerAt: string | null; quoted: QuotedPair["quoted"] }>;
};

/** お客様の最新の発言（最後のスタッフ発言より後）のうち、引用返信の最後の1通と、その引用先 */
async function findLatestQuotedPair(conversationId: string): Promise<QuotedPair | null> {
  const { data: rows } = await supabase.from("messages")
    .select("sender, text, quoted_message_id, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(8);
  const recent = (rows ?? []) as Array<{ sender: string; text: string | null; quoted_message_id: string | null; created_at?: string | null }>;
  let target: (typeof recent)[number] | null = null;
  let targetIdx = -1;
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (m.sender !== "customer") { if (target) break; continue; }
    if (m.quoted_message_id) { target = m; targetIdx = i; break; }
  }
  if (!target?.quoted_message_id) return null;
  // 同じ流れ＝target より前の、続けてのお客様の発言（スタッフの発言で切る）のうち引用している物
  const olderQuoted: typeof recent = [];
  for (let i = targetIdx + 1; i < recent.length; i++) {
    const m = recent[i];
    if (m.sender !== "customer") break;
    if (m.quoted_message_id) olderQuoted.push(m);
  }
  const ids = [...new Set([target.quoted_message_id, ...olderQuoted.map((m) => m.quoted_message_id as string)])];
  const { data: qs } = await supabase.from("messages")
    .select("line_message_id, sender, text, image_url, created_at")
    .eq("conversation_id", conversationId)
    .in("line_message_id", ids);
  const byId = new Map(((qs ?? []) as Array<QuotedPair["quoted"] & { line_message_id: string }>).map((r) => [r.line_message_id, r] as const));
  const q = byId.get(target.quoted_message_id);
  if (!q) return null;
  const others: QuotedPair["others"] = [];
  for (const m of olderQuoted.reverse()) {
    const oq = byId.get(m.quoted_message_id as string);
    if (oq) others.push({ customerText: m.text ?? "", customerAt: m.created_at ?? null, quoted: oq });
  }
  return { customerText: target.text ?? "", customerAt: target.created_at ?? null, quoted: q, others };
}

export { quotedImagePropertyReadOn } from "@/app/lib/quoted-note";
import { quotedImagePropertyReadOn } from "@/app/lib/quoted-note";
/** その時刻の前後5分の AIX の種類（1件だけの時） */
async function aixTypeNear(conversationId: string, atIso: string | null): Promise<string | null> {
  if (!atIso) return null;
  const t = Date.parse(atIso);
  const { data } = await supabase.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", conversationId)
    .gte("created_at", new Date(t - 65 * 60_000).toISOString()).lte("created_at", new Date(t + 6 * 60_000).toISOString()).limit(50);
  const near = ((data ?? []) as Array<{ aix_type: string | null; sent_at: string | null; created_at: string }>).filter((l) => Math.abs(Date.parse(l.sent_at ?? l.created_at) - t) <= 5 * 60_000);
  return near.length === 1 ? near[0].aix_type : null;
}

/** 「[画像]」「[動画]」だけ＝中身がまだ分かっていない画像 */
function isImagePlaceholder(text: string | null): boolean {
  return !text || /^\s*\[(?:画像|動画)\]\s*$/.test(text);
}

/**
 * 引用先が**こちらが送った画像**で、まだ中身を読んでいなければ読んで残す。
 * 2026-09-21: 下書きを作る手前（bg-async）でブレインと**並べて**動かす。
 *   送った時（send-line-message）に読めている画像なら表を見るだけで終わる。
 * @returns 読めた／既にあった＝true
 */
export async function ensureQuotedImageDetail(conversationId: string): Promise<boolean> {
  try {
    const pair = await findLatestQuotedPair(conversationId);
    if (!pair) return false;
    const { quoted } = pair;
    if (quoted.sender !== "staff" || !quoted.image_url || !isImagePlaceholder(quoted.text)) return false;
    // 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、切り替えたところ以降渡せば個人情報防げる」:
    //   読み取りは DeepSeek（property_image_detail）。申込中の会話・線より前に送った画像は読まない
    //   （判定は ensureImageDetail の中・引用先を送った時刻で見る）
    const { ensureImageDetail } = await import("@/app/lib/image-detail-store");
    const d = await ensureImageDetail(quoted.image_url, conversationId, { sentAt: quoted.created_at ?? null });
    // 2026-11-21 作業員G（#461 ①・竹内さん「お客さんが反応したのはちゃんと読みとる」）: 引用された画像が「どの物件か」の記録が無い時は、
    //   引用された時点でその画像の物件名・号室を読んで記録する（recordSentImageProperty＝DeepSeek 1回・会話で前に送った物件名と照合できた時だけ記録）。
    //   読めない・照合できない時は AIX の記録の候補（その時の AIX の物件名が1件だけ＝#448 の線）。それでも分からなければ何も作らない（「分からない」のまま渡る）。
    //   60日でお客様がこちらの画像を引用した 102通のうち 23通はまだ物件の記録が無い。申込中の会話・書類の番は読まない（recordSentImageProperty の中の線）。
    //   既定 off（QUOTED_IMAGE_PROPERTY_READ=on）
    if (quotedImagePropertyReadOn()) {
      const labels = await propertyLabelsForImages(conversationId, [quoted.image_url]);
      if (!labels.get(quoted.image_url)) {
        const { recordSentImageProperty } = await import("@/app/lib/sent-image-record");
        const r = await recordSentImageProperty({ imageUrl: quoted.image_url, conversationId, source: "quoted_read", sentAt: quoted.created_at ?? null }).catch(() => null);
        let via: string = r?.matched ? "read" : "none";
        if (!r?.matched) {
          const { attributeSentImageFromAixLog } = await import("@/app/lib/sent-image-aix-attribute-server");
          const { data: row } = await supabase.from("messages").select("is_aix_generated").eq("conversation_id", conversationId).eq("image_url", quoted.image_url).limit(1).maybeSingle();
          const aixType = (row as { is_aix_generated?: boolean | null } | null)?.is_aix_generated ? await aixTypeNear(conversationId, quoted.created_at ?? null) : null;
          if (aixType) {
            const a = await attributeSentImageFromAixLog(supabase, { imageUrl: quoted.image_url, conversationId, source: `aix:${aixType}`, sentAt: quoted.created_at ?? new Date().toISOString() }, { force: true }).catch(() => "no_match" as const);
            if (a === "attributed") via = "aix_log";
          }
        }
        console.log(JSON.stringify({ tag: "quoted-image:property-read", conversationId, via }));
      }
    }
    return !!d;
  } catch (e) {
    console.warn("[quoted-context] ensure detail failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** お客様の最新の発言（最後のスタッフ発言より後）のうち、引用返信の最後の1通の引用先 */
export async function resolveLatestQuotedContext(
  conversationId: string,
  /** DeepSeek に送る時だけ渡す線（post-apply.ts）。引用した発言・引用先のどちらかが線より前なら何も返さない。省略時は今までどおり */
  opts: { cutoff?: DeepseekCutoff } = {},
): Promise<QuotedContext | null> {
  try {
    const pair = await findLatestQuotedPair(conversationId);
    if (!pair) return null;
    if ("cutoff" in opts && !(isAfterCutoff(pair.customerAt, opts.cutoff) && isAfterCutoff(pair.quoted.created_at ?? null, opts.cutoff))) return null;
    const quoted = pair.quoted;
    const isImage = isImagePlaceholder(quoted.text);
    let propertyLabel: string | null = null;
    let detailLines: string[] = [];
    let detailKind: ImageKind | null = null;
    // 同じ流れのほかの引用（DeepSeek に送る時は線より前の物を渡さない）
    const others = pair.others.filter((o) => !("cutoff" in opts) || (isAfterCutoff(o.customerAt, opts.cutoff) && isAfterCutoff(o.quoted.created_at ?? null, opts.cutoff)));
    const otherImageUrls = others.filter((o) => o.quoted.sender === "staff" && !!o.quoted.image_url && isImagePlaceholder(o.quoted.text)).map((o) => o.quoted.image_url as string);
    const otherLabels = otherImageUrls.length > 0 ? await propertyLabelsForImages(conversationId, otherImageUrls) : new Map<string, string>();
    const otherQuotes = others.map((o) => {
      const img = isImagePlaceholder(o.quoted.text);
      return {
        customerText: o.customerText,
        propertyLabel: img && o.quoted.sender === "staff" && o.quoted.image_url ? otherLabels.get(o.quoted.image_url) ?? null : null,
        isImage: img,
        // お客様の送った画像の書き起こし（"[画像] …"）は発言ではないので渡さない
        quotedText: img || /^\s*\[(?:画像|動画)\]/.test(o.quoted.text ?? "") ? null : (o.quoted.text ?? "").slice(0, 200),
      };
    });
    if (isImage && quoted.image_url && quoted.sender === "staff") {
      const [labels, details] = await Promise.all([
        propertyLabelsForImages(conversationId, [quoted.image_url]),
        // 読み取りは**表を見るだけ**（無ければ空。ここで読みに行くと下書きを20〜30秒待たせる）
        getImageDetails([quoted.image_url]),
      ]);
      propertyLabel = labels.get(quoted.image_url) ?? null;
      const d = details.get(quoted.image_url);
      // 見積書・本人確認書類は中身を渡さない（読み取りの時点で lines は空だが、ここでも念のため）
      if (d) { detailKind = d.kind; detailLines = d.kind === "property" ? d.lines : []; }
    }
    return {
      customerText: pair.customerText,
      quotedSender: quoted.sender === "staff" ? "staff" : "customer",
      // お客様が送った画像は line-webhook が Vision で書き起こしている（"[画像] <書き起こし>"）。
      //   「[画像]」だけの時は中身が無いので null のまま
      quotedText: isImage ? null : (quoted.text ?? "").slice(0, 400),
      isImage,
      propertyLabel,
      detailLines,
      detailKind,
      otherQuotes,
    };
  } catch (e) {
    console.warn("[quoted-context] resolve failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
