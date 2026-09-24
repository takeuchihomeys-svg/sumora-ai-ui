// app/lib/sheet-read-server.ts（サーバー専用・DB・DeepSeek・pdfjs。画面側から import しない）
// 「🔍 画像で分析」の物件ごとの事実を用意する: 保存した読み取り（property_sheet_facts）を引き、無ければ資料を切り出して DeepSeek で1回だけ読む。
//
// 2026-09-24 竹内「読んだ結果を物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」
//   引く順（安い順）:
//     ① この行で前に読んだ facts_id（image_analysis.sheet.facts_id・同じ前置きの版の時だけ）
//     ② 文字層の物件の鍵（物件名＋号室＋所在地＝unit_key）。pdf_text が無い行（直す前の記録）は PDF の文字層を取ってから
//     ③ 切り出した間取り図の画素のハッシュ（fp_hash）。同じ棟・同じ型の部屋（調査: 15部屋で読むのは12回）
//     ④ どれも無ければ DeepSeek で読む（推論なし・崩れた／fp_ok=false の時だけ推論 low で1回読み直す）
//   ⚠ 使い回した事実でも、その部屋の説明文・文字層との突き合わせ（sheet-facts.checkSheetConsistency）は毎回行う
import { supabase } from "@/app/lib/supabase";
import { callDeepSeek } from "@/app/lib/vision-alt-provider";
import { readSheetPdf, loadImageCanvas, cropCanvas } from "@/app/lib/pdf-sheet-crop";
import { detectSheetType, planSheetCrop, type SheetType, type CropPlan } from "@/app/lib/sheet-layout";
import { parseSheetText, unitKeyOf, checkSheetConsistency, type SheetTextFacts } from "@/app/lib/sheet-facts";
import {
  buildSheetReadContent, parseSheetImageFacts, sectionKeyFor, buildWantsJudgePrompt,
  SHEET_PROMPT_VERSION, SHEET_READ_MAX_TOKENS, SHEET_RETRY_MAX_TOKENS, type SheetImageFacts,
} from "@/app/lib/sheet-prompt";
import { pickAnalysisImageUrl } from "@/app/lib/pickup-image-url";
import { wantsToText, type ImageWant, type WantCheck } from "@/app/lib/image-wants";

export const SHEET_FACTS_TABLE = "property_sheet_facts";
const READ_TIMEOUT_MS = 40_000;
const RETRY_TIMEOUT_MS = 90_000;

export type SheetSourceRow = {
  id: number;
  site: string | null;
  pdf_url: string | null;
  pdf_blob_url: string | null;
  pdf_text: string | null;
  summary_text: string | null;
  trim_image_url: string | null;
  page_image_url: string | null;
  pdf_has_text: boolean | null;
  image_analysis: Record<string, unknown> | null;
};

export type SheetUsage = { model: string; input: number; output: number; cacheHit: number; ms: number; retry: boolean; ok: boolean; section: string };

export type SheetReadOutcome = {
  sheetType: SheetType;
  typeBy: string;
  crop: { mode: CropPlan["mode"]; basis: CropPlan["basis"]; reason: string | null } | null;
  text: SheetTextFacts;
  image: SheetImageFacts | null;
  factsId: number | null;
  /** saved_row＝この行の前回・saved_unit＝同じ部屋・saved_fp＝同じ図・read＝今回読んだ・none＝読めない */
  source: "saved_row" | "saved_unit" | "saved_fp" | "read" | "none";
  usage: SheetUsage[];
  error: string | null;
};

type FactsRow = { id: number; unit_key: string | null; sheet_type: string; crop_mode: string; crop_basis: string | null; image_facts: SheetImageFacts | null; text_facts: SheetTextFacts | null; site: string | null };
const FACTS_COLS = "id, unit_key, sheet_type, crop_mode, crop_basis, image_facts, text_facts, site";

async function findFacts(col: "id" | "unit_key" | "fp_hash", value: string | number): Promise<FactsRow | null> {
  let q = supabase.from(SHEET_FACTS_TABLE).select(FACTS_COLS).eq(col, value);
  if (col !== "id") q = q.eq("prompt_version", SHEET_PROMPT_VERSION);
  const { data, error } = await q.order("id", { ascending: false }).limit(1);
  if (error) { console.warn("[sheet-read] 保存した読み取りを引けない:", error.message); return null; }
  const r = ((data ?? [])[0] ?? null) as FactsRow | null;
  return r && r.image_facts ? r : null;
}

async function saveFacts(row: Record<string, unknown>): Promise<number | null> {
  const withKey = row.unit_key != null;
  const q = withKey
    ? supabase.from(SHEET_FACTS_TABLE).upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "unit_key,prompt_version" }).select("id").limit(1)
    : supabase.from(SHEET_FACTS_TABLE).insert(row).select("id").limit(1);
  const { data, error } = await q;
  if (error) { console.warn("[sheet-read] 読み取りを保存できない:", error.message); return null; }
  return ((data ?? [])[0] as { id?: number } | undefined)?.id ?? null;
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
}

/** DeepSeek で切り出した画像を読む（推論なし → 崩れた／間取り図が読めない時だけ推論 low で1回） */
async function readImage(mode: CropPlan["mode"], dataUrl: string): Promise<{ image: SheetImageFacts | null; usage: SheetUsage[] }> {
  const usage: SheetUsage[] = [];
  const section = sectionKeyFor(mode);
  const content = buildSheetReadContent(mode, dataUrl);
  const t0 = Date.now();
  const r1 = await callDeepSeek(null, content, { thinking: false, maxTokens: SHEET_READ_MAX_TOKENS, timeoutMs: READ_TIMEOUT_MS });
  const f1 = r1 ? parseSheetImageFacts(r1.text) : null;
  usage.push({ model: r1?.model ?? "deepseek-flash", input: r1?.usage.input ?? 0, output: r1?.usage.output ?? 0, cacheHit: r1?.usage.cacheHit ?? 0, ms: Date.now() - t0, retry: false, ok: !!f1, section });
  if (f1 && f1.fp_ok) return { image: f1, usage };
  // 2026-09-24 実測: 推論 low でも答えは変わらない事が多いが、返事が崩れた時と「間取り図が読めない」時だけ1回読み直す
  //   （max_tokens を小さくすると推論で使い切って答えが空になる＝12000）
  const t1 = Date.now();
  const r2 = await callDeepSeek(null, content, { effort: "low", maxTokens: SHEET_RETRY_MAX_TOKENS, timeoutMs: RETRY_TIMEOUT_MS });
  const f2 = r2 ? parseSheetImageFacts(r2.text) : null;
  usage.push({ model: r2?.model ?? "deepseek-flash", input: r2?.usage.input ?? 0, output: r2?.usage.output ?? 0, cacheHit: r2?.usage.cacheHit ?? 0, ms: Date.now() - t1, retry: true, ok: !!f2, section });
  if (f2 && (f2.fp_ok || !f1)) return { image: f2, usage };
  return { image: f1 ?? f2, usage };
}

/** 物件1件の事実（文字層＋間取り図）を用意する。失敗しても投げない */
export async function loadSheetFacts(row: SheetSourceRow): Promise<SheetReadOutcome> {
  const out: SheetReadOutcome = { sheetType: "unknown", typeBy: "none", crop: null, text: parseSheetText(row.pdf_text), image: null, factsId: null, source: "none", usage: [], error: null };
  const fromSaved = (f: FactsRow, source: SheetReadOutcome["source"]): SheetReadOutcome => ({
    ...out,
    sheetType: (f.sheet_type as SheetType) ?? "unknown", typeBy: "saved",
    crop: { mode: f.crop_mode as CropPlan["mode"], basis: (f.crop_basis ?? "page") as CropPlan["basis"], reason: null },
    text: out.text.hasText ? out.text : (f.text_facts ?? out.text),
    image: f.image_facts, factsId: f.id, source,
  });
  try {
    // ① この行で前に読んだ物（同じ前置きの版だけ）
    const prev = (row.image_analysis?.sheet ?? null) as { facts_id?: number; prompt_version?: string } | null;
    let key = out.text.hasText ? unitKeyOf(out.text) : null;
    if (prev?.facts_id && prev.prompt_version === SHEET_PROMPT_VERSION) {
      const f = await findFacts("id", prev.facts_id);
      // 2026-09-24 反証: 前回の読み取りが今の資料の部屋と違う（資料が差し替わった・鍵の形が変わった）時は使わない
      if (f && !(key && f.unit_key && f.unit_key !== key)) return fromSaved(f, "saved_row");
    }
    // ② 同じ部屋（文字層の鍵）
    if (key) { const f = await findFacts("unit_key", key); if (f) return fromSaved(f, "saved_unit"); }

    // ③ 資料を読む（PDF があれば文字層と画像の位置も取る。無ければ画像から）
    const pdfBytes = row.pdf_blob_url ? await fetchBytes(row.pdf_blob_url) : null;
    const sheet = pdfBytes ? await readSheetPdf(pdfBytes, { render: true }) : null;
    if (sheet && sheet.texts.join("").trim().length >= 40) {
      const t = parseSheetText(sheet.texts.join("\n"));
      if (t.hasText) out.text = t;
      if (!key && out.text.hasText) {
        key = unitKeyOf(out.text);
        if (key) { const f = await findFacts("unit_key", key); if (f) return fromSaved(f, "saved_unit"); }
      }
    }
    const type = detectSheetType({ site: row.site, pdfUrl: row.pdf_url, pageText: sheet?.texts[0] ?? row.pdf_text });
    out.sheetType = type.type; out.typeBy = type.by;
    let canvas = sheet?.canvas ?? null;
    let plan: CropPlan;
    if (canvas && sheet) {
      plan = planSheetCrop(type.type, sheet.boxes, sheet.aspect);
    } else {
      // PDF が無い・描けない: 文字のある画像（トリミング → 文字層が取れた回の page_image_url）から。描画命令が無いので位置は確かめられない
      const url = pickAnalysisImageUrl(row);
      const bytes = url ? await fetchBytes(url) : null;
      canvas = bytes ? await loadImageCanvas(Buffer.from(bytes)) : null;
      if (!canvas) { out.error = "資料（PDF・画像）が無い"; return out; }
      plan = planSheetCrop(type.type, null, canvas.height / canvas.width);
    }
    out.crop = { mode: plan.mode, basis: plan.basis, reason: plan.reason };
    const crop = await cropCanvas(canvas, plan.rect);
    if (!crop) { out.error = "切り出せない"; return out; }

    // ④ 同じ図（画素のハッシュ・同じ切り出しの形の時だけ）
    const same = await findFacts("fp_hash", crop.hash);
    if (same && same.crop_mode === plan.mode) {
      const id = await saveFacts({
        unit_key: key, site: row.site, sheet_type: type.type, crop_mode: plan.mode, crop_basis: plan.basis, fp_hash: crop.hash,
        image_facts: same.image_facts, text_facts: out.text, consistency: checkSheetConsistency({ text: out.text, image: same.image_facts }),
        model: "reused", prompt_version: SHEET_PROMPT_VERSION, reused_from: same.id, source_pickup_id: row.id,
      });
      return { ...out, image: same.image_facts, factsId: id ?? same.id, source: "saved_fp" };
    }

    // ⑤ 読む
    const dataUrl = `data:image/jpeg;base64,${crop.jpeg.toString("base64")}`;
    const r = await readImage(plan.mode, dataUrl);
    out.usage = r.usage;
    if (!r.image) { out.error = "読めなかった"; return out; }
    out.image = r.image;
    out.source = "read";
    out.factsId = await saveFacts({
      unit_key: key, site: row.site, sheet_type: type.type, crop_mode: plan.mode, crop_basis: plan.basis, fp_hash: crop.hash,
      image_facts: r.image, text_facts: out.text, consistency: checkSheetConsistency({ text: out.text, image: r.image }),
      model: r.usage[r.usage.length - 1]?.model ?? "deepseek-flash", prompt_version: SHEET_PROMPT_VERSION, reused_from: null, source_pickup_id: row.id,
    });
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
}

/**
 * 決まった手順で決まらなかった希望だけ、保存した事実と希望を文字で聞く（推論なし）。失敗は空（その希望は「分からない」のまま）
 * お客様の名前・電話は入らない（希望は image-wants-server が伏せた物・事実は物件の資料だけ）
 */
export async function judgeWantsByText(text: SheetTextFacts, image: SheetImageFacts | null, wants: ImageWant[]): Promise<{ checks: WantCheck[]; usage: SheetUsage | null }> {
  if (!wants.length) return { checks: [], usage: null };
  const facts = {
    間取り: image?.madori || text.madori, 専有面積: text.areaSqm, 階: text.floor, 方位: text.direction,
    部屋: image?.rooms ?? [], 帖数_資料: text.jo, キッチン: image?.kitchen ?? null, 水回り: image?.water ?? null,
    部屋の関係: image?.living_bedroom ?? null, 収納: image?.storage ?? null, 設備と条件: text.features.slice(0, 900),
  };
  const t0 = Date.now();
  const r = await callDeepSeek(null, buildWantsJudgePrompt(JSON.stringify(facts), wantsToText(wants)), { thinking: false, maxTokens: SHEET_READ_MAX_TOKENS, timeoutMs: 30_000 });
  const usage: SheetUsage = { model: r?.model ?? "deepseek-flash", input: r?.usage.input ?? 0, output: r?.usage.output ?? 0, cacheHit: r?.usage.cacheHit ?? 0, ms: Date.now() - t0, retry: false, ok: false, section: "wants_text" };
  if (!r) return { checks: [], usage };
  const ids = new Set(wants.map((w) => w.id));
  try {
    const body = r.text.match(/\{[\s\S]*\}/)?.[0] ?? "";
    const o = JSON.parse(body) as { checks?: Array<Record<string, unknown>> };
    const checks = (o.checks ?? []).map((c) => ({
      id: String(c.id ?? "").trim().toUpperCase(),
      result: (["ok", "ng", "unknown"].includes(String(c.result)) ? String(c.result) : "unknown") as WantCheck["result"],
      why: String(c.why ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
    })).filter((c) => ids.has(c.id));
    usage.ok = true;
    return { checks, usage };
  } catch { return { checks: [], usage }; }
}
