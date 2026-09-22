// app/lib/sent-image-record.ts
// こちらが送った画像1枚 → どの物件か（物件名・号室）を**1回だけ読んで**記録する。
//
// 2026-09-22 竹内「やる」（同じ画像の物件名・号室を DeepSeek で2回読んでいたのを1回にまとめる）:
//   旧は2つの経路が同じ画像を別々に読んでいた。
//     ① /api/extract-property-info（画面の送信・AIX 物件オススメが裏で呼ぶ）… 照合なしでも記録
//     ② /api/send-line-message の after … 会話に出ている物件名と照合できた物だけ記録（家賃・募集状況も）
//   → ここに一本化。読むのは1回・結果の使い方は①②の両方を保つ:
//     ・照合できた   → 照合済みの名前で記録（sent_image_properties を上書き・sent_properties に新規なら追加）
//     ・照合できない → 読んだ名前のまま記録（既存の記録は上書きしない・source="vision"）＝①と同じ範囲を記録
//   既に同じ画像の記録があれば**読み直さず**、記録済みの名前を照合し直すだけ（AIX 物件オススメは
//   生成の時と送る時に同じ画像を渡すので、2回目は DeepSeek を呼ばない）。
import { supabase } from "@/app/lib/supabase";

export type SentImageRecordResult = {
  read: "deepseek" | "reused" | "not_property" | "failed";
  matched: boolean;
  propertyName: string | null;
  roomNo: string | null;
  sentProperties: "inserted" | "duplicate_skipped" | "skipped" | string;
  tokens?: { input: number; output: number } | null;
};

/** その会話で既に分かっている物件名（照合の辞書）: 送った物件＋本文の物件名 */
async function knownPropertyNames(conversationId: string): Promise<string[]> {
  const { extractPropertyLabels } = await import("@/app/lib/action-ledger");
  const known = new Set<string>();
  const { data: sp } = await supabase.from("sent_properties").select("property_name").eq("conversation_id", conversationId).limit(50);
  for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) known.add(r.property_name.trim());
  const { data: ms } = await supabase.from("messages").select("text").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(80);
  for (const lbl of extractPropertyLabels(((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n"))) {
    known.add(lbl.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
  }
  return [...known].filter((s) => s.length >= 2);
}

/**
 * 送った画像の物件を記録する（失敗しても投げない）。
 * @param source 照合できた時の記録の出所（"aix:property_send" / "staff_image" / "vision" など）
 */
export async function recordSentImageProperty(opts: {
  imageUrl: string;
  conversationId: string;
  source: string;
  propertyCustomerId?: string | null;
}): Promise<SentImageRecordResult> {
  const { imageUrl, conversationId, source } = opts;
  const out: SentImageRecordResult = { read: "failed", matched: false, propertyName: null, roomNo: null, sentProperties: "skipped" };
  try {
    const [{ readPropertyImage }, { resolveReadProperty }, { isSameProperty }] = await Promise.all([
      import("@/app/lib/property-image-read"),
      import("@/app/lib/property-name-match"),
      import("@/app/lib/sent-property-record"),
    ]);

    // ① 既に読んだ画像なら読み直さない
    const { data: prevRow } = await supabase.from("sent_image_properties")
      .select("property_name, room_no, source").eq("image_url", imageUrl).maybeSingle();
    const prev = prevRow as { property_name: string; room_no: string | null; source: string | null } | null;
    type Item = { propertyName: string; roomNumber: string; rent?: number | null; status?: string | null; deposit?: number | null; keyMoney?: number | null; vacancyDate?: string | null };
    let item: Item | null = null;
    if (prev?.property_name) {
      item = { propertyName: prev.property_name, roomNumber: prev.room_no ?? "" };
      out.read = "reused";
    } else {
      const read = await readPropertyImage(imageUrl, { timeoutMs: 80_000 });
      out.tokens = read.usage ?? null;
      // 見積書・本人確認書類は物件として記録しない
      if (!read.isProperty || read.items.length === 0) { out.read = !read.isProperty && read.raw.startsWith("{") ? "not_property" : "failed"; return out; }
      item = read.items[0];
      out.read = "deepseek";
    }

    // ② 照合（会話に出ている物件名に寄せる）
    const fixed = resolveReadProperty(item, await knownPropertyNames(conversationId));
    const named = fixed ?? item;
    out.matched = !!fixed;
    out.propertyName = named.propertyName?.trim() || null;
    out.roomNo = (named.roomNumber ?? "").trim() || null;
    if (!out.propertyName) return out;

    // ③ 画像ごとの記録。照合できた時だけ上書きする（照合なしで照合済みを消さない）
    const already = prev?.property_name && prev.source !== "vision";   // 照合済みの記録が既にある
    if (fixed) {
      await supabase.from("sent_image_properties").upsert(
        { image_url: imageUrl, conversation_id: conversationId, property_name: out.propertyName, room_no: out.roomNo, source },
        { onConflict: "image_url" },
      );
    } else if (!prev) {
      await supabase.from("sent_image_properties").upsert(
        { image_url: imageUrl, conversation_id: conversationId, property_name: out.propertyName, room_no: out.roomNo, source: "vision" },
        { onConflict: "image_url", ignoreDuplicates: true },
      );
    }

    // ④ 送った物件（同じ物件の2回目は書かない＝送った物件の数え方を守る）
    if (already && !fixed) { out.sentProperties = "skipped"; return out; }
    const { data: rows } = await supabase.from("sent_properties").select("property_name, room_no").eq("conversation_id", conversationId).limit(200);
    const existing = ((rows ?? []) as Array<{ property_name: string | null; room_no: string | null }>).map((r) => ({ property_name: r.property_name ?? "", room_no: r.room_no }));
    if (existing.some((e) => isSameProperty(e, { property_name: out.propertyName!, room_no: out.roomNo ?? "" }))) {
      out.sentProperties = "duplicate_skipped";
      return out;
    }
    let pcId = opts.propertyCustomerId ?? null;
    if (!pcId) {
      const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", conversationId).maybeSingle();
      pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    }
    const { error: spErr } = await supabase.from("sent_properties").insert({
      conversation_id: conversationId,
      property_customer_id: pcId,
      property_name: out.propertyName,
      room_no: out.roomNo ?? "",
      image_url: imageUrl,
      source: fixed ? source : "vision",
      // 読めなかった項目は入れない（0 や "open" に丸めない）
      ...(item.status ? { recruitment_status: item.status, recruitment_checked_at: new Date().toISOString() } : {}),
      ...(typeof item.rent === "number" ? { rent: item.rent } : {}),
    });
    out.sentProperties = spErr ? `error:${spErr.message}` : "inserted";
    return out;
  } catch (e) {
    console.warn("[sent-image-record] 失敗:", e instanceof Error ? e.message : e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "sent-image-record", conversationId, source, ...out }));
  }
}
