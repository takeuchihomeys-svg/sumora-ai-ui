// app/lib/image-detail-store.ts
// こちらが送った画像の「中身の読み取り」を1枚1行で残す（image_details）。
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるように。こっちが送った画像なら
//   deepseek で読み取れるようになってるはずなので、そこで読み取ってちゃんとした文を生成できるようにする」
//
// 【なぜ表に残すか】読み取りは 20〜34秒かかる（推論モデル）。
//   下書きを作る時に読むと**そのぶん待たせる**ので、
//     ① 送った時（send-line-message の after）に読んで残す ＝ 待ち時間ゼロ
//     ② 引用が届いた時（line-webhook の after）に、まだ無ければ読む
//     ③ 文を作る所（generate-reply / AIX）は**表を見るだけ**（0ms）
//   という形にする。②が間に合わなくても、次の生成では効く。
//
// ⚠ 読むのは**こちらが送った画像だけ**。お客様の画像は line-webhook が既に Vision で書き起こしており、
//   身分証が写っている事がある（設計知見「画像は伏せようがない」）。この関数を customer の画像に使わない。
import { supabase } from "@/app/lib/supabase";
import { readPropertyImageDetail, type ImageKind } from "@/app/lib/property-image-read";

export type ImageDetail = { kind: ImageKind; lines: string[] };

/** 表から読む（無ければ null）。読み取りを起こさない */
export async function getImageDetails(imageUrls: string[]): Promise<Map<string, ImageDetail>> {
  const out = new Map<string, ImageDetail>();
  const urls = [...new Set(imageUrls.filter(Boolean))];
  if (urls.length === 0) return out;
  // URL は長いので小分けにする（まとめて投げるとリクエストが長すぎて落ちる）
  for (let i = 0; i < urls.length; i += 20) {
    const { data, error } = await supabase.from("image_details")
      .select("image_url, kind, lines").in("image_url", urls.slice(i, i + 20));
    if (error) { console.warn("[image-detail] read failed:", error.message); break; }
    for (const r of (data ?? []) as Array<{ image_url: string; kind: string; lines: unknown }>) {
      const lines = Array.isArray(r.lines) ? (r.lines as unknown[]).map((x) => String(x)) : [];
      out.set(r.image_url, { kind: (r.kind as ImageKind) ?? "other", lines });
    }
  }
  return out;
}

/**
 * まだ読んでいなければ読んで残す（こちらが送った画像のみ）。
 * 失敗しても投げない（材料が無いだけ＝汚れた材料は入れない）。
 */
export async function ensureImageDetail(
  imageUrl: string,
  conversationId: string | null,
  opts?: { timeoutMs?: number },
): Promise<ImageDetail | null> {
  if (!imageUrl) return null;
  try {
    const cached = (await getImageDetails([imageUrl])).get(imageUrl);
    if (cached) return cached;
    const read = await readPropertyImageDetail(imageUrl, { timeoutMs: opts?.timeoutMs });
    // 読めなかった（推論で使い切った・HTTPエラー）時は**残さない**。
    //   "other" を残すと次の機会に読み直せなくなる（読み取りの失敗と「物件資料ではない」は別）
    const failed = read.kind === "other" && read.lines.length === 0;
    if (failed) {
      console.warn(JSON.stringify({ tag: "image-detail:read-failed", imageUrl: imageUrl.slice(-40), raw: read.raw.slice(0, 120) }));
      return null;
    }
    const { error } = await supabase.from("image_details").upsert(
      { image_url: imageUrl, conversation_id: conversationId, kind: read.kind, lines: read.lines, model: process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash" },
      { onConflict: "image_url" },
    );
    console.log(JSON.stringify({
      tag: "image-detail:read", conversationId, kind: read.kind, lines: read.lines.length,
      tokens: read.usage, error: error?.message ?? null,
    }));
    return { kind: read.kind, lines: read.lines };
  } catch (e) {
    console.warn("[image-detail] ensure failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
