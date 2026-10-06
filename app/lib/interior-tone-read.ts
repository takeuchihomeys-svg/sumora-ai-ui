// app/lib/interior-tone-read.ts（サーバー専用・DeepSeek を呼ぶ・pdfjs/@napi-rs/canvas を使う。画面から import しない）
// 物件資料の室内写真から内装の基調色を読む（問いと読み取りの決まりは interior-tone.ts の純関数）。
//
// 2026-10-07 竹内（会話「し」）「画像から部屋の色判断は出来ひんかな？白基調希望のお客様で…」
//   - 呼ぶのは「お客様の希望に白基調・内装白がある」時だけ（呼ぶ側が wantsWhiteInterior で決める）。無条件には読まない
//   - リアプロの PDF があれば 2.5倍で描いて室内写真のマス（sheet-layout の planSheetCrop().photos）だけを切って読む（ページ全体より当たる）。
//     無ければ資料のページの画像（page_image_url）をそのまま
//   - DeepSeek（推論なし・温度0・答え JSON 1行）。費用は llm_usage_logs に action="interior_tone"（1枚 約$0.0001・約3秒）
//   - Claude には倒さない（読めなければ null＝分からない）。保存はしない（今は毎回読む・1回の送付で数枚）
import { callDeepSeekRead, VISION_ALT_MODEL_DEFAULT } from "./vision-alt-provider";
import { INTERIOR_TONE_SYSTEM, INTERIOR_TONE_QUESTION, parseInteriorTone, type InteriorTone } from "./interior-tone";

export const INTERIOR_TONE_MAX_TOKENS = 80;
export const INTERIOR_TONE_TIMEOUT_MS = 12_000;

export type InteriorToneRead = { tone: InteriorTone | null; ms: number; model: string; failed: boolean; source: "pdf_photos" | "image" | "none" };

/** 画像（URL か data:image/jpeg;base64）を1枚読む */
export async function readInteriorTone(image: string, opts?: { timeoutMs?: number; conversationId?: string | null; source?: InteriorToneRead["source"] }): Promise<InteriorToneRead> {
  const t0 = Date.now();
  const model = (process.env.VISION_ALT_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
  const source = opts?.source ?? "image";
  if (!/^(?:https?:\/\/|data:image\/)/.test(image)) return { tone: null, ms: 0, model, failed: true, source: "none" };
  const content = [
    { type: "text", text: INTERIOR_TONE_QUESTION },
    { type: "image_url", image_url: { url: image } },
  ];
  const budget = opts?.timeoutMs ?? INTERIOR_TONE_TIMEOUT_MS;
  const read = await callDeepSeekRead(INTERIOR_TONE_SYSTEM, content, { maxTokens: INTERIOR_TONE_MAX_TOKENS, timeoutMs: budget },
    (t) => parseInteriorTone(t),
    { retryIf: (elapsed) => budget - elapsed >= 2_000, retryTimeoutMs: (elapsed) => budget - elapsed });
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    for (const a of read.attempts) {
      recordAltUsage({
        model: a.res?.model ?? model, action: "interior_tone", conversationId: opts?.conversationId ?? null,
        usage: { input_tokens: a.res?.usage.cacheMiss ?? 0, output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
        durationMs: a.ms, sysHead: (a.retry ? "【読み直し】" : "") + INTERIOR_TONE_SYSTEM.slice(0, 180), sysKeyFull: null, maxTokens: INTERIOR_TONE_MAX_TOKENS,
      });
    }
  }).catch(() => {});
  return { tone: read.value, ms: Date.now() - t0, model: read.res?.model ?? model, failed: read.failed, source };
}

/** リアプロの PDF から室内写真のマスだけを切る（data URL）。切れなければ null */
export async function photosCropFromPdf(pdfUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pdfUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const [{ readSheetPdf, cropCanvas }, { planSheetCrop }] = await Promise.all([import("./pdf-sheet-crop"), import("./sheet-layout")]);
    const sheet = await readSheetPdf(bytes, { render: true, textPages: 1 });
    if (!sheet?.canvas) return null;
    const plan = planSheetCrop("realpro", sheet.boxes, sheet.aspect);
    if (!plan.photos) return null;
    const cr = await cropCanvas(sheet.canvas, plan.photos, { maxSide: 1000 });
    return cr ? `data:image/jpeg;base64,${cr.jpeg.toString("base64")}` : null;
  } catch { return null; }
}

/** 売上サポの行1つの内装の色（PDF の室内写真のマス → 無ければページの画像） */
export async function readInteriorToneForPickup(row: { site?: string | null; pdf_blob_url?: string | null; page_image_url?: string | null }, opts?: { conversationId?: string | null; timeoutMs?: number }): Promise<InteriorToneRead> {
  if (row.site === "realpro" && row.pdf_blob_url) {
    const crop = await photosCropFromPdf(row.pdf_blob_url);
    if (crop) return readInteriorTone(crop, { ...opts, source: "pdf_photos" });
  }
  if (row.page_image_url) return readInteriorTone(row.page_image_url, { ...opts, source: "image" });
  return { tone: null, ms: 0, model: "", failed: true, source: "none" };
}
