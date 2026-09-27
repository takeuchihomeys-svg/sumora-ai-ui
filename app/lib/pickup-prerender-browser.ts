// app/lib/pickup-prerender-browser.ts（ブラウザ専用）
// パソコン（MS ゴシックのある Windows の Chrome）で、送る画像がまだ無いピックアップの行を先に「元の資料の1ページ目そのまま」の画像にして保存する。
// 2026-09-27 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」
//   使う所: ①拡張の裏の画面（offscreen → iframe で /pickup-prerender）＝資料が届いた後と10分おき ②売上サポ（PickupReview）をパソコンで開いた時
//   描き方は renderOriginalPageInBrowser（切り取りなし・書体の確認つき）と同じ。書体が無い端末では1件目で止めて何も作らない（元の見た目でない画像を作らない）
// ⚠ ./pdf-trim（サーバー専用）を import しない
import { renderOriginalPageInBrowser, blobToBase64, isLocalFontFamilyAvailable } from "./pdf-trim-browser";
import { chunkTrimImages, TRIM_POST_BUDGET_CHARS } from "./pickup-aix-handoff";

export type PrerenderResult = { listed: number; made: number; failed: Array<{ id: number; error: string }>; fontMissing: boolean; message: string };

/** この端末でリアプロの資料を元の見た目で描けそうか（MS ゴシックがあるか）。無い端末（iPhone 等）では最初から回さない */
export function deviceHasRealproFont(): boolean {
  try { return isLocalFontFamilyAvailable("MS Gothic") || isLocalFontFamilyAvailable("ＭＳ ゴシック"); } catch { return false; }
}

export async function prerenderPickupImages(opts: { authHeader: Record<string, string>; ids?: number[]; limit?: number; onLog?: (s: string) => void }): Promise<PrerenderResult> {
  const log = opts.onLog ?? (() => {});
  const qs = new URLSearchParams();
  if (opts.ids?.length) qs.set("ids", opts.ids.join(","));
  if (opts.limit) qs.set("limit", String(opts.limit));
  const res = await fetch(`/api/property-pickups/prerender?${qs}`, { headers: opts.authHeader, cache: "no-store" });
  const j = await res.json().catch(() => ({})) as { ok?: boolean; items?: Array<{ id: number; pdf_blob_url: string; property_name: string; room_no: string | null }>; error?: string };
  if (!res.ok || !j.ok) throw new Error(j.error ?? `一覧を取れない（HTTP ${res.status}）`);
  const items = j.items ?? [];
  const out: PrerenderResult = { listed: items.length, made: 0, failed: [], fontMissing: false, message: "" };
  if (items.length === 0) { out.message = "作る物はありません"; return out; }
  const images: Array<{ id: number; jpeg_base64: string }> = [];
  for (const it of items) {
    try {
      const jpeg = await renderOriginalPageInBrowser(it.pdf_blob_url);
      images.push({ id: it.id, jpeg_base64: await blobToBase64(jpeg) });
      log(`描いた #${it.id} ${it.property_name}${it.room_no ? ` ${it.room_no}` : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "OriginalFontMissingError") {
        // この端末には資料の書体が無い → 残りも同じなので止める（差し替えた画像は作らない）
        out.fontMissing = true; out.failed.push({ id: it.id, error: msg });
        log(`書体が無いので止めた: ${msg}`);
        break;
      }
      out.failed.push({ id: it.id, error: msg });
      log(`描けない #${it.id}: ${msg}`);
    }
  }
  for (const chunk of chunkTrimImages(images, TRIM_POST_BUDGET_CHARS)) {
    const r = await fetch("/api/property-pickups/trim", {
      method: "POST", headers: { "Content-Type": "application/json", ...opts.authHeader },
      body: JSON.stringify({ images: chunk }),
    });
    const tj = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })) as { trimmed?: number; items?: Array<{ id: number; error?: string }>; error?: string };
    out.made += tj.trimmed ?? 0;
    for (const x of tj.items ?? []) if (x.error) out.failed.push({ id: x.id, error: x.error });
    if (!r.ok && !tj.items) for (const c of chunk) out.failed.push({ id: c.id, error: tj.error ?? `HTTP ${r.status}` });
  }
  out.message = `${out.listed}件中 ${out.made}件を元の資料の画像にしました${out.failed.length ? `（できなかった ${out.failed.length}件）` : ""}${out.fontMissing ? "・この端末には資料の書体がありません" : ""}`;
  return out;
}
