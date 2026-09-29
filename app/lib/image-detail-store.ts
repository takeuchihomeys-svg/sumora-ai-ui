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
import { readPropertyImageDetail, type ImageKind, type DetailResult } from "@/app/lib/property-image-read";
import { pickupRowDetailPlan, readPropertyDetailFromText, detailModelLabel } from "@/app/lib/property-detail-source";
import { loadDeepseekCutoff, isAfterCutoff } from "@/app/lib/post-apply";

export type ImageDetail = { kind: ImageKind; lines: string[] };

/** 画像を読む時間切れ。2026-09-29: 25秒 → 60秒（9/28 の成功の平均 30秒・37/67 が時間切れで費用だけ払っていた。send-line-message は maxDuration 120） */
export const IMAGE_DETAIL_TIMEOUT_MS = 60_000;

type PickupDetail = DetailResult & { source: "pickup_lines" | "pickup_text" };
type PickupRowLite = { image_lines: unknown; pdf_text: string | null };

/** 売上サポの行（image_lines か文字層）で済ませる。行に何も無い・文字層の読み取りが失敗なら null */
async function detailFromPickupRows(rows: PickupRowLite[], conversationId: string | null): Promise<PickupDetail | null> {
  const plan = pickupRowDetailPlan(rows);
  if (!plan) return null;
  if (plan.kind === "lines") return { kind: "property", lines: plan.lines, raw: "", source: "pickup_lines" };
  const r = await readPropertyDetailFromText(plan.text, { conversationId });
  if (r.failed) return null;
  return { kind: r.kind, lines: r.lines, raw: r.raw, usage: r.usage, source: "pickup_text" };
}

/**
 * 送った画像が売上サポの行（property_pickups の trim_image_url / page_image_url / agent_image_url）なら、
 * その行の image_lines を写すか、文字層（pdf_text）から読む。行が無ければ null（呼び出し側が画像を読む）。
 * 失敗しても投げない（null）
 * ⚠ AIX（物件ピックアップ・オススメ）が送る画像は AixModal が**ファイルとして再アップロード**した別の URL
 *   （…/property-images/aix/<会話>/<時刻>_<乱数>.png）なので、ここの URL の一致には当たらない（直近7日 150枚中 134枚）。
 *   その分は生成の時に primeImageDetailsFromPickups（下）が行 ID で結んで image_details に先に写す
 */
async function detailFromPickupRow(imageUrl: string, conversationId: string | null): Promise<PickupDetail | null> {
  try {
    const cols = ["trim_image_url", "page_image_url", "agent_image_url"] as const;
    const found = await Promise.all(cols.map(async (c) => {
      const { data, error } = await supabase.from("property_pickups").select("image_lines, pdf_text, created_at")
        .eq(c, imageUrl).order("created_at", { ascending: false }).limit(1);
      if (error) { console.warn("[image-detail] property_pickups read failed:", error.message); return null; }
      return (data?.[0] as (PickupRowLite & { created_at: string | null }) | undefined) ?? null;
    }));
    const rows = found.filter((r): r is NonNullable<typeof r> => !!r);
    if (rows.length === 0) return null;
    return await detailFromPickupRows(rows, conversationId);
  } catch (e) {
    console.warn("[image-detail] pickup row lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 2026-09-29 検証の反証への直し: AIX【物件ピックアップした】【物件オススメ】の生成（/api/aix/action）は、
 * 送る画像の URL（再アップロード済み）と売上サポの行（pickup_ids・同じ並び）を両方知っている。
 * そこで**生成の時に**行の image_lines（無ければ文字層の読み取り・$0.001）を送る画像の URL で image_details に写しておく。
 * 送った後の ensureImageDetail は表にあるので DeepSeek の画像読み（推論 low・30秒・$0.006）を呼ばない。
 * 既に表にある URL は触らない。失敗しても投げない（後の ensureImageDetail が今までどおり読む）
 */
export async function primeImageDetailsFromPickups(
  conversationId: string,
  pairs: Array<{ imageUrl: string; row: PickupRowLite }>,
): Promise<{ primed: number; skipped: number; none: number; source: Record<string, number> }> {
  const out = { primed: 0, skipped: 0, none: 0, source: {} as Record<string, number> };
  const valid = pairs.filter((p) => typeof p.imageUrl === "string" && p.imageUrl.trim() && p.row);
  if (valid.length === 0) return out;
  try {
    // 申込中の会話・線より前は DeepSeek に渡さない（ensureImageDetail と同じ線。行の文字層は物件の資料だが、線は会話ごとに一律に守る）
    if (!isAfterCutoff(new Date().toISOString(), await loadDeepseekCutoff(supabase, conversationId))) {
      console.log(JSON.stringify({ tag: "deepseek-cutoff:skip-image-read", route: "image-detail:prime", conversationId }));
      return out;
    }
    const have = await getImageDetails(valid.map((p) => p.imageUrl));
    const model = (process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash").trim();
    await Promise.allSettled(valid.map(async ({ imageUrl, row }) => {
      if (have.has(imageUrl)) { out.skipped++; return; }
      const d = await detailFromPickupRows([row], conversationId);
      if (!d || d.lines.length === 0) { out.none++; return; }
      const { error } = await supabase.from("image_details").upsert(
        { image_url: imageUrl, conversation_id: conversationId, kind: d.kind, lines: d.lines, model: detailModelLabel(d.source, model) },
        { onConflict: "image_url", ignoreDuplicates: true },
      );
      if (error) { console.warn("[image-detail] prime upsert failed:", error.message); return; }
      out.primed++; out.source[d.source] = (out.source[d.source] ?? 0) + 1;
    }));
  } catch (e) {
    console.warn("[image-detail] prime failed:", e instanceof Error ? e.message : e);
  }
  return out;
}

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
  /** sentAt: その画像を送った時刻（省略時は今＝送った直後の読み取り） */
  opts?: { timeoutMs?: number; sentAt?: string | null },
): Promise<ImageDetail | null> {
  if (!imageUrl) return null;
  try {
    const cached = (await getImageDetails([imageUrl])).get(imageUrl);
    if (cached) return cached;
    // 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、切り替えたところ以降渡せば個人情報防げる」:
    //   読み取りは DeepSeek（property_image_detail）。申込中の会話・線より前に送った画像は読まない（会話の記録から線を引く・読めなければ読まない）
    if (conversationId && !isAfterCutoff(opts?.sentAt ?? new Date().toISOString(), await loadDeepseekCutoff(supabase, conversationId))) {
      console.log(JSON.stringify({ tag: "deepseek-cutoff:skip-image-read", route: "image-detail", conversationId }));
      return null;
    }
    // 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った。更に節約できないか」:
    //   送る画像の大半は売上サポの行（property_pickups）の資料で、その行は読み取り済みの image_lines か PDF の文字層を持っている。
    //   9/28 は送った 67枚のうち 37回が 25秒の時間切れ＝費用だけ払って材料が残っていなかった。
    //   ① 行に image_lines があれば写す（DeepSeek を呼ばない）②文字層があれば文字層から読む（推論なし・1.6秒）
    //   ③ どちらも無い（スタッフが手で送った画像等）だけ今までどおり画像を読む。時間切れは 25秒 → 60秒（成功の平均が 30秒）
    const fromPickup = await detailFromPickupRow(imageUrl, conversationId);
    const read = fromPickup ?? await readPropertyImageDetail(imageUrl, { timeoutMs: opts?.timeoutMs ?? IMAGE_DETAIL_TIMEOUT_MS });
    // 読めなかった（推論で使い切った・HTTPエラー）時は**残さない**。
    //   "other" を残すと次の機会に読み直せなくなる（読み取りの失敗と「物件資料ではない」は別）
    const failed = read.kind === "other" && read.lines.length === 0;
    if (failed) {
      console.warn(JSON.stringify({ tag: "image-detail:read-failed", imageUrl: imageUrl.slice(-40), raw: read.raw.slice(0, 120) }));
      return null;
    }
    // model 列に出所を付ける（pickup_lines／pickup_text:…／image:…・detailModelLabel）
    const { error } = await supabase.from("image_details").upsert(
      { image_url: imageUrl, conversation_id: conversationId, kind: read.kind, lines: read.lines, model: detailModelLabel(fromPickup ? fromPickup.source : "image", process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash") },
      { onConflict: "image_url" },
    );
    console.log(JSON.stringify({
      tag: "image-detail:read", conversationId, kind: read.kind, lines: read.lines.length,
      source: fromPickup ? fromPickup.source : "image",
      tokens: read.usage, error: error?.message ?? null,
    }));
    return { kind: read.kind, lines: read.lines };
  } catch (e) {
    console.warn("[image-detail] ensure failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
