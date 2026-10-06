// app/lib/zumen-obi-browser.ts（ブラウザ専用）
// ITANDI の「まとめて図面取得」の ZIP（または中の PDF・JPEG）を受け、物件ごとに1枚の画像（1ページ目・弊社の帯に帯替え）にする。
// 2026-10-06 竹内「まとめて図面ダウンロードをおして保存されるPDFをそのままAIXツールのところに入れて解析はできるのか」
//   「帯替えとはこのように弊社の情報に帯を変更するということ　帯の部分だけ判断して変えれば良い」
//
// - 描くのはスタッフのパソコンのブラウザ（pdf-trim-browser と同じ: 端末の書体で描く＝元の資料と同じ見た目・書体が無ければ作らない）
//   ZIP は数 MB〜十数 MB あり、サーバーの受け取りの上限（4.5MB）を超えるので、サーバーに送らずここで開く
// - 帯の判断は zumen-obi.planObiReplace（純関数）。迷えば帯替えせず、理由をスタッフに出す（自動で入れない）
// - 弊社の帯は public/brand/obi-hasu.png（リアプロの帯替え済みの資料から scripts/make-obi-hasu.ts で切り出した物）
// - 送るのは図面の1ページ目だけ。2ページ目以降（業者向けの案内・チラシ）は入れない
// ⚠ サーバー専用の物（pdf-sheet-crop・pdf-render・pdfjs-assets・@napi-rs/canvas）を import しない（本番のビルドが落ちる）
import { groupZumenFiles, parseZumenName, planObiReplace, paintObi, type ObiPlan } from "./zumen-obi";
import { extractObiFeatures, type CanvasPair } from "./zumen-obi-pdf";
import { judgeOriginalRender, requestedSystemFamilies } from "./pickup-send-image";
import { isLocalFontFamilyAvailable, PDFJS_PUBLIC_BASE } from "./pdf-trim-browser";

export const OBI_BAND_URL = "/brand/obi-hasu.png";

export type ZumenItem = {
  key: string;
  /** 「ラフォルテ日本橋 305」 */
  label: string;
  seq: number | null;
  /** ok＝帯替えした画像がある／stop＝帯替えしていない（理由あり） */
  status: "ok" | "stop";
  /** 帯替えした画像（ok の時） */
  file?: File;
  previewUrl?: string;
  /** stop の理由（ファイルごと） */
  reasons: string[];
  /** 本文に残った業者向けの記載など（止めはしない） */
  warnings: string[];
  /** 2ページ目以降を入れていない等のお知らせ */
  notes: string[];
  /** 画像の図面（帯の有無を確かめられない）の元のファイル。スタッフが目で確かめて「そのまま入れる」時に使う */
  imageAsIs?: File;
};

type Entry = { path: string; read: () => Promise<Uint8Array>; type: string };

const mimeOf = (p: string) => /\.pdf$/i.test(p) ? "application/pdf" : /\.png$/i.test(p) ? "image/png" : /\.gif$/i.test(p) ? "image/gif" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg";

/** 入れた物（ZIP・PDF・画像）を中のファイルの並びにする */
async function expand(files: File[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed") {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      for (const z of Object.values(zip.files)) {
        if (z.dir) continue;
        out.push({ path: z.name, type: mimeOf(z.name), read: () => z.async("uint8array") });
      }
    } else {
      out.push({ path: f.name, type: f.type || mimeOf(f.name), read: async () => new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return out;
}

let bandPromise: Promise<HTMLImageElement> | null = null;
function loadBand(): Promise<HTMLImageElement> {
  if (!bandPromise) {
    bandPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { bandPromise = null; reject(new Error("弊社の帯の画像を読めない")); };
      img.src = OBI_BAND_URL;
    });
  }
  return bandPromise;
}

const makeCanvas = (w: number, h: number): CanvasPair => {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas が使えない");
  return { canvas, ctx: ctx as unknown as CanvasPair["ctx"] };
};

type FileOutcome = { plan: ObiPlan | null; blob?: Blob; reason?: string; pages?: number };

/** PDF の1ページ目を描いて帯替えする */
async function processPdf(bytes: Uint8Array): Promise<FileOutcome> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_PUBLIC_BASE}pdf.worker.min.mjs`;
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${PDFJS_PUBLIC_BASE}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${PDFJS_PUBLIC_BASE}standard_fonts/`,
    useSystemFonts: true, fontExtraProperties: true,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    let textDraws = 0;
    const f = await extractObiFeatures(pdfjs as never, page as never, makeCanvas, {
      scale: 2,
      beforeRender: (ctx) => {
        const c = ctx as CanvasRenderingContext2D;
        const of = c.fillText.bind(c), os = c.strokeText.bind(c);
        c.fillText = (...a: Parameters<CanvasRenderingContext2D["fillText"]>) => { textDraws++; of(...a); };
        c.strokeText = (...a: Parameters<CanvasRenderingContext2D["strokeText"]>) => { textDraws++; os(...a); };
      },
    });
    const plan = planObiReplace({ rotate: f.rotate, items: f.items, images: f.images, rows: f.rows });
    if (plan.kind !== "replace") return { plan, pages: pdf.numPages };
    // 元の資料と同じ書体で描けたか（書体を差し替えた画像はお客様に送らない・pickup-send-image と同じ判定）
    const judge = judgeOriginalRender({
      requested: requestedSystemFamilies(f.styles as Record<string, { fontSubstitution?: string }>),
      available: isLocalFontFamilyAvailable, textChars: f.textChars, textDraws,
    });
    if (!judge.ok) return { plan, reason: judge.message, pages: pdf.numPages };
    const band = await loadBand();
    paintObi(f.pair.ctx as never, f.width, f.height, plan.cutY, { width: band.naturalWidth, height: band.naturalHeight, image: band });
    const canvas = f.pair.canvas as HTMLCanvasElement;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像にできない"))), "image/jpeg", 0.9));
    return { plan, blob, pages: pdf.numPages };
  } finally {
    try { await task.destroy(); } catch { /* 無視 */ }
  }
}

/**
 * 入れた物を物件ごとに帯替えする。onProgress は (済んだ数, 全部の数)。
 * 同じ物件（物件名＋号室）に複数のファイルがある時は、帯替えできた最初の1つを使う（業者向けの案内のスキャン等は外れる）
 */
export async function processZumenFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<ZumenItem[]> {
  const entries = await expand(files);
  const groups = groupZumenFiles(entries);
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  let done = 0;
  const items: ZumenItem[] = [];
  for (const g of groups) {
    const label = `${g.name}${g.room ? ` ${g.room}` : ""}`;
    const item: ZumenItem = { key: g.key, label, seq: g.seq, status: "stop", reasons: [], warnings: [], notes: [] };
    for (const e of g.files) {
      const fname = e.path.split("/").pop() ?? e.path;
      try {
        if (item.file) { item.notes.push(`${fname}: 同じ物件の別のファイル（使っていない）`); continue; }
        const bytes = await e.read();
        if (e.type !== "application/pdf") {
          item.reasons.push(`${fname}: 画像の図面（文字の層が無い）＝帯の有無を確かめられない。目で見て元付の情報が無ければ「そのまま入れる」`);
          if (!item.imageAsIs) item.imageAsIs = new File([bytes.slice().buffer as ArrayBuffer], fname, { type: e.type });
          continue;
        }
        const r = await processPdf(bytes);
        if (r.plan) for (const w of r.plan.warnings) if (!item.warnings.includes(w)) item.warnings.push(w);
        if (r.plan?.kind === "stop") { item.reasons.push(`${fname}: ${r.plan.reason}`); continue; }
        if (!r.blob) { item.reasons.push(`${fname}: ${r.reason ?? "画像にできない"}`); continue; }
        const n = parseZumenName(fname);
        item.file = new File([r.blob], `${n.seq != null ? `${n.seq}_` : ""}${label}.jpg`, { type: "image/jpeg" });
        item.previewUrl = URL.createObjectURL(r.blob);
        item.status = "ok";
        if ((r.pages ?? 1) > 1) item.notes.push(`${fname}: 2ページ目以降（${(r.pages ?? 1) - 1}ページ・業者向けの案内・チラシ等）は入れていない`);
      } catch (err) {
        item.reasons.push(`${fname}: 読めない（${err instanceof Error ? err.message : String(err)}）`);
      } finally {
        done++;
        onProgress?.(done, total);
      }
    }
    items.push(item);
  }
  return items;
}
