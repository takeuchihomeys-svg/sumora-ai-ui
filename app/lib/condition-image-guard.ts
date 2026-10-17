// app/lib/condition-image-guard.ts
// AIX【物件オススメ】の条件のスクショ（condition_image_url）を DeepSeek vision に出す前の網（2026-10-17 竹内さん「順に改善おねがい」⑤・費用0の保険）。
//
// 【なぜ】条件のスクショはスタッフが画面で選ぶ画像で、お客様の画像（本人確認書類・振込の控え・人物の写真）を誤って選ぶと、
//   1通目の本文の生成（既定は DeepSeek）と一緒に別クラウドへ出る（設計知見 84cfec33「画像は伏せられない」）。
// 【決め】LLM は呼ばない（費用0）。画像の中身の指紋（SHA-256）を、その会話のお客様の画像（直近の8枚）の指紋と比べ、
//   同じ画像の保存済みの見出し（image-label: "[画像] 【…】"・本人確認書類 等の種類だけの形・image_type）が個人の画像なら Claude に倒す。
//   検索条件の画面・物件の画像・指紋が当たらない画像は今まで通り（当たった時だけ倒す）。戻す CONDITION_IMAGE_GUARD=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { customerImageGroup, savedImageKind, type ImageKind } from "@/app/lib/image-label";

export function conditionImageGuardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CONDITION_IMAGE_GUARD ?? "on").trim().toLowerCase() !== "off";
}

const PERSONAL_KINDS: ReadonlySet<ImageKind> = new Set<ImageKind>(["payment", "personal_unknown", "pet_document", "person_photo"]);
/** 種類の名前だけの書類の形（id-document-guard / personal-document-guard が保存する「[画像] 本人確認書類」等） */
const DOC_ONLY_RE = /^\s*\[画像\]\s*(?:本人確認書類|収入証明書|申込書|住民票|保険証|在留カード|源泉徴収票|給与明細|課税証明書)/;

export type ConditionImageVerdict = { personal: boolean; label: string | null };

/** 同じ画像の保存済みの本文・image_type → 個人の画像か（純関数） */
export function conditionImageVerdict(match: { text: string | null; image_type: string | null } | null): ConditionImageVerdict {
  if (!match) return { personal: false, label: null };
  const t = (match.text ?? "").trim();
  if (DOC_ONLY_RE.test(t)) return { personal: true, label: t.replace(/^\s*\[画像\]\s*/, "").slice(0, 20) };
  const kind = savedImageKind(t);
  if (kind && PERSONAL_KINDS.has(kind)) return { personal: true, label: kind };
  const g = customerImageGroup(t, match.image_type);
  if (g === "personal_document") return { personal: true, label: match.image_type ?? "personal_document" };
  return { personal: false, label: kind ?? (g as string | null) };
}

async function sha(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  } catch { return null; }
}

/** 条件のスクショがお客様の個人の画像と同じ画像か（読むだけ・失敗は「当たらない」） */
export async function checkConditionImage(sb: SupabaseClient, conversationId: string | null, url: string): Promise<ConditionImageVerdict & { matched: boolean; checked: number }> {
  const none = { personal: false, label: null, matched: false, checked: 0 };
  if (!conversationId || !url || !conditionImageGuardEnabled()) return none;
  try {
    const { data } = await sb.from("messages").select("text, image_url, image_type, created_at").eq("conversation_id", conversationId).eq("sender", "customer")
      .not("image_url", "is", null).gte("created_at", new Date(Date.now() - 60 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(8);
    const rows = (data ?? []) as Array<{ text: string | null; image_url: string | null; image_type: string | null }>;
    if (rows.length === 0) return none;
    const direct = rows.find((r) => r.image_url === url);
    if (direct) return { ...conditionImageVerdict(direct), matched: true, checked: rows.length };
    const [h, ...hs] = await Promise.all([sha(url, 5_000), ...rows.map((r) => sha(String(r.image_url), 5_000))]);
    if (!h) return { ...none, checked: rows.length };
    const i = hs.findIndex((x) => x === h);
    return i >= 0 ? { ...conditionImageVerdict(rows[i]), matched: true, checked: rows.length } : { ...none, checked: rows.length };
  } catch { return none; }
}
