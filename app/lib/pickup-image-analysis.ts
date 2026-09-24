// app/lib/pickup-image-analysis.ts
// 「🔍 画像で分析」: 物件資料の画像（お客様に送る1ページ目＝間取り図・写真・設備欄）を DeepSeek が読み、
//   お客様の希望に照らして 水回り／キッチン／リビングと洋室の位置関係／収納（WIC 等）を判断し、一番合う物件を出す。
//
// 2026-09-24 竹内「画像で分析ボタンを付ける。お客さんの要望【水回りの判断・キッチンの判断・リビングと洋室の位置関係・
//   収納（WIC 等）】を判断できる。お客さんの希望によって必要な場合がある。トリミングした画像の中で一番条件に合った物件がわかる」
//
// 設計（設計知見「画像は有無だけ・数値は読まない」「推論モデルは max_tokens を大きく」「失敗は判定を変えない」）:
//   - 1物件 = 1回の呼び出し（複数枚を1回に入れると物件の取り違えが起きる）。並列
//   - 読むのは見えている物だけ。金額・面積・帖数の数字は書かせない（誤読が本文に出ると事故）→ 帖数は「広め／普通／狭め」の言葉だけ
//   - 合い具合（match 0〜100）はお客様の希望に書いてある項目だけで付ける。希望に無い項目は点に入れない
//   - 送るのは物件資料の画像と「条件の文」だけ（お客様の名前・電話は入れない）
import { callDeepSeek } from "./vision-alt-provider";

export type PickupImageAnalysis = {
  water: string;        // 水回り（バス・トイレ別／独立洗面台／浴室乾燥 等・見える物だけ）
  kitchen: string;      // キッチン（口数・対面/壁付け・IH/ガス 等）
  layout: string;       // リビングと洋室の位置関係（隣り合う／廊下を挟む／引き戸で続き間 等）
  storage: string;      // 収納（WIC・クローゼットの数と位置）
  match: number | null; // お客様の希望への合い具合 0〜100（希望が無ければ null）
  good: string[];       // 希望に合う点
  concern: string[];    // 希望に合わない・気になる点
};

export const ANALYSIS_MAX_TOKENS = 12000;

/** お客様の希望の文（条件の欄をまとめる。個人情報の欄は入れない） */
export function buildWantsText(c: Record<string, unknown> | null | undefined, staffNote?: string | null): string {
  const parts: string[] = [];
  const add = (label: string, v: unknown) => { const s = String(v ?? "").trim(); if (s) parts.push(`${label}: ${s}`); };
  if (c) {
    add("間取り", c.floor_plan ?? c.layout);
    add("こだわり", c.preferences);
    add("NG", c.ng_points);
    add("その他の希望", c.other_requests);
    add("追加条件", c.additional_conditions);
  }
  add("スタッフのメモ", staffNote);
  return parts.join("\n");
}

export function buildAnalysisPrompt(wants: string): string {
  return `これは賃貸物件の資料（マイソク）の画像です。間取り図・室内写真・設備欄を見て、次の JSON だけを返してください（説明文・コードブロック不要）。
{"water":"","kitchen":"","layout":"","storage":"","match":null,"good":[],"concern":[]}
- water: 水回り。バス・トイレ別／独立洗面台／浴室乾燥機／追い焚き／洗濯機置場の位置 など、見える物だけ短く
- kitchen: キッチン。対面（カウンター）か壁付けか・コンロ（IH/ガス・口数）・システムキッチン など、見える物だけ
- layout: リビングと洋室の位置関係。隣り合う／廊下や水回りを挟んで離れている／引き戸で続き間 など、間取り図から
- storage: 収納。ウォークインクローゼット（WIC）・クローゼットの数と、どの部屋にあるか
- match: 下の「お客様の希望」への合い具合 0〜100。希望に書いてある項目だけで判断する。希望が空なら null
- good: 希望に合う点（短く・最大4つ）／ concern: 希望に合わない・気になる点（短く・最大4つ）
- 画像に無い事は書かない（分からない項目は ""）。金額・面積・帖数の数字は書かない（広め／普通／狭め の言葉にする）
- 「対面」「カウンターキッチン」は、設備欄にその言葉があるか、間取り図でキッチンがリビング側を向いている（シンクの前がリビング）時だけ。
  廊下や壁に沿って置かれていれば「壁付け」。どちらか分からなければ向きは書かない（推測で「対面」にしない）
- WIC（ウォークインクローゼット）は間取り図に「WIC」「W.I.C」「WCL」「納戸」と書かれた物だけ。シューズ用（SIC・シューズWIC）は「シューズ用」と分けて書く

お客様の希望:
${wants || "（特になし）"}`;
}

/** 返事の JSON を読む（崩れた返事は null） */
export function parseAnalysis(text: string): PickupImageAnalysis | null {
  const raw = (text ?? "").trim();
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (block ? block[1] : raw).trim();
  const jsonStr = body.startsWith("{") ? body : (body.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonStr) return null;
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    const s = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const arr = (v: unknown) => (Array.isArray(v) ? v : []).map(s).filter(Boolean).slice(0, 4);
    const m = o.match == null || o.match === "" ? null : Number(o.match);
    const out: PickupImageAnalysis = {
      water: s(o.water), kitchen: s(o.kitchen), layout: s(o.layout), storage: s(o.storage),
      match: m != null && Number.isFinite(m) ? Math.max(0, Math.min(100, Math.round(m))) : null,
      good: arr(o.good), concern: arr(o.concern),
    };
    if (!out.water && !out.kitchen && !out.layout && !out.storage) return null;   // 何も読めていない＝失敗
    return out;
  } catch { return null; }
}

/** 一番合う物件（match が最大・同点は元の順位が上）。match が1件も無ければ null */
export function pickBest<T extends { id: number; rank: number; analysis: PickupImageAnalysis | null }>(rows: T[]): T | null {
  const scored = rows.filter((r) => r.analysis?.match != null);
  if (!scored.length) return null;
  return scored.slice().sort((a, z) => (z.analysis!.match! - a.analysis!.match!) || (a.rank - z.rank))[0];
}

/** 1物件を読む。失敗は null */
export async function analyzePickupImage(imageUrl: string, wants: string, opts?: { timeoutMs?: number }): Promise<{ analysis: PickupImageAnalysis | null; usage?: { input: number; output: number; cacheHit: number }; model?: string }> {
  const res = await callDeepSeek(null, [
    { type: "text", text: buildAnalysisPrompt(wants) },
    { type: "image_url", image_url: { url: imageUrl } },
  ], { maxTokens: ANALYSIS_MAX_TOKENS, timeoutMs: opts?.timeoutMs ?? 90_000, effort: "low" });
  if (!res) return { analysis: null };
  return { analysis: parseAnalysis(res.text), usage: { input: res.usage.input, output: res.usage.output, cacheHit: res.usage.cacheHit }, model: res.model };
}
