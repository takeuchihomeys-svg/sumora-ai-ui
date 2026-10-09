// app/lib/draft-fact-grounding-server.ts — 下書きの事実の照らし（draft-fact-grounding.ts）の材料のうち、会話の本文に出ない物を DB から読む（読むだけ）
// 2026-10-09: 送った資料の画像の名前・号室（本文は「[画像]」だけ）・AIX の記録の物件名・見積書の記録・内覧の予定・カレンダー・会社の事実。
//   scripts/audit-draft-fact-grounding.ts の材料と同じ形（監査で線を引いた材料と本番の材料をそろえる）。
import { supabase } from "@/app/lib/supabase";
import { COMPANY_FACTS } from "@/app/lib/company-facts";
import { extractDraftFacts, findUngroundedFacts, groundingKinds, aixForUngroundedFact, type DraftFactKind } from "@/app/lib/draft-fact-grounding";

/**
 * 下書きの事実の照らしの結果（画面の帯・要対応・学習の記録の材料）。本文は変えない。
 * 差し込みの案（generate-reply・本質の担当が編集中のため案のまま）: route.ts 7247行の ai_draft_check の保存に
 *   `fact_grounding: await draftFactGroundingCheck(conversationId, finalDraftText)` を1つ足す（JSONB・migrate-schema 不要）。
 * 画面: misses があれば下書きの上に「この文の『8/5〜8/7頃のご入居』は材料に無い → AIX【物件確認した→入居可能日】で送る番」の帯。
 * 学習: ブレインが返信を選んだ番の misses＝「AIX の番を返信にした」読み違い（line_watch_turns.verdict_detail の fg か brain_decision_logs.digest の fg に残す案）。
 */
export type DraftFactGroundingCheck = { at: string; misses: Array<{ kind: DraftFactKind; value: string; aix: string; label: string; why: string; sentence: string }> };
export async function draftFactGroundingCheck(conversationId: string, draft: string | null | undefined): Promise<DraftFactGroundingCheck | null> {
  try {
    const text = String(draft ?? "");
    if (!text.trim() || !extractDraftFacts(text).length) return null;
    const { data: recent } = await supabase.from("messages").select("text").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(40);
    const ground = `${((recent ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n")}\n${await loadDraftGroundExtra(conversationId)}`;
    const { count } = await supabase.from("estimate_records").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
    const misses = findUngroundedFacts(text, ground, groundingKinds()).map((h) => {
      const s = aixForUngroundedFact(h, { estimateSent: (count ?? 0) > 0 });
      return { kind: h.kind, value: h.value, aix: s.catalogKey, label: s.label, why: s.why, sentence: Array.from(h.sentence).slice(0, 80).join("") };
    });
    if (misses.length) console.log(JSON.stringify({ tag: "draft-fact-grounding:miss", conversationId, misses: misses.map((m) => ({ kind: m.kind, value: m.value, aix: m.aix })) }));
    return { at: new Date().toISOString(), misses };
  } catch (e) {
    console.warn("[draft-fact-grounding] 照らせない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

const jst = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/** 会話の本文の外にある材料の文（失敗は ""＝足さないだけ。足りない材料は根拠なしに倒れる＝止める向き＝人に残す） */
export async function loadDraftGroundExtra(conversationId: string): Promise<string> {
  try {
    const since = new Date(Date.now() - 120 * 86400_000).toISOString();
    const [aix, sip, est, vw, vh, cal] = await Promise.all([
      supabase.from("aix_usage_logs").select("generated_text, property_names").eq("conversation_id", conversationId).gte("created_at", since).limit(200),
      supabase.from("sent_image_properties").select("image_url, property_name, room_no, facts").eq("conversation_id", conversationId).limit(400),
      supabase.from("estimate_records").select("property_name, room_no").eq("conversation_id", conversationId).limit(200),
      supabase.from("viewings").select("viewing_date, viewing_time").eq("conversation_id", conversationId).limit(50),
      supabase.from("viewing_history").select("scheduled_date, scheduled_time, property_name").eq("conversation_id", conversationId).limit(50),
      supabase.from("calendar_events").select("start_at, title").eq("conversation_id", conversationId).limit(100),
    ]);
    const lines: string[] = [];
    for (const a of (aix.data ?? []) as Array<{ generated_text: string | null; property_names: string[] | null }>) lines.push(a.generated_text ?? "", ...(a.property_names ?? []));
    for (const s of (sip.data ?? []) as Array<{ property_name: string | null; room_no: string | null; facts: unknown }>) lines.push(`${s.property_name ?? ""} ${s.room_no ?? ""}号室`, s.facts ? JSON.stringify(s.facts) : "");
    // 2026-10-09: 送った資料の画像の中身の行（image_details.lines＝向き・ペット・設備・現況・入居可能日）。生成が資料の事実で答えた文を「根拠なし」にしない
    const urls = [...new Set(((sip.data ?? []) as Array<{ image_url?: string | null }>).map((s) => s.image_url).filter((u): u is string => !!u))];
    for (let i = 0; i < urls.length; i += 40) {
      const { data: det } = await supabase.from("image_details").select("lines").in("image_url", urls.slice(i, i + 40));
      for (const d of (det ?? []) as Array<{ lines: unknown }>) if (Array.isArray(d.lines)) lines.push((d.lines as string[]).join("\n"));
    }
    for (const e of (est.data ?? []) as Array<{ property_name: string | null; room_no: string | null }>) lines.push(`${e.property_name ?? ""} ${e.room_no ?? ""}号室`);
    for (const v of (vw.data ?? []) as Array<{ viewing_date: string | null; viewing_time: string | null }>) lines.push(`${v.viewing_date ?? ""} ${v.viewing_time ?? ""}`);
    for (const v of (vh.data ?? []) as Array<{ scheduled_date: string | null; scheduled_time: string | null; property_name: string | null }>) lines.push(`${v.scheduled_date ?? ""} ${v.scheduled_time ?? ""} ${v.property_name ?? ""}`);
    for (const c of (cal.data ?? []) as Array<{ start_at: string | null; title: string | null }>) lines.push(`${jst(c.start_at)} ${c.title ?? ""}`);
    lines.push(...COMPANY_FACTS.map((f) => (f as { fact?: string }).fact ?? ""));
    return lines.filter(Boolean).join("\n");
  } catch (e) {
    console.warn("[draft-fact-grounding] 材料を読めない:", e instanceof Error ? e.message : String(e));
    return "";
  }
}
