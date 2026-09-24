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
//
// 2026-09-24 強化（竹内「希望条件や NG 条件の細かい部分も画像から判断できているか。会話や物件オススメの訴求点から抜けている部分を入れる」）:
//   - 希望は image-wants.ts が 条件欄・会話・訴求点から「画像で確かめられる物」だけ番号付き（W1…）で集める
//   - DeepSeek は希望1つずつに ok／ng／unknown（画像で分からない）と根拠を返す（checks）
//   - 点はモデルに付けさせず、checks から決定論で出す（scoreChecks・NG と必須は2倍・必須に ng なら20点が上限）。
//     モデルの match は同じ画像でも 50→75 と揺れた（YUMA）
import { callDeepSeek } from "./vision-alt-provider";
import { scoreChecksDetail, wantsToText, type ImageWant, type WantCheck } from "./image-wants";

export type PickupImageAnalysis = {
  water: string;        // 水回り（バス・トイレ別／独立洗面台／浴室乾燥 等・見える物だけ）
  kitchen: string;      // キッチン（口数・対面/壁付け・IH/ガス 等）
  layout: string;       // リビングと洋室の位置関係（隣り合う／廊下を挟む／引き戸で続き間 等）
  storage: string;      // 収納（WIC・クローゼットの数と位置）
  match: number | null; // お客様の希望への合い具合 0〜100（checks から決定論で。判定できる希望が無ければ null）
  match_raw?: number | null; // 必須 NG の上限（20）をかける前の点（同点の並べ替えに使う）
  must_fail?: boolean;       // 必須・NG 条件に当たった
  good: string[];       // 希望に合う点
  concern: string[];    // 希望に合わない・気になる点
  checks: WantCheck[];  // 希望1つずつの判定（W1…）
};

export const ANALYSIS_MAX_TOKENS = 12000;

/** 旧: 条件欄をまとめた文（画面の表示用に残す） */
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

export function buildAnalysisPrompt(wants: ImageWant[] | string): string {
  const list = typeof wants === "string" ? wants : wantsToText(wants);
  return `これは賃貸物件の資料（マイソク）の画像です。間取り図・室内写真・設備欄・条件欄・備考を見て、次の JSON だけを返してください（説明文・コードブロック不要）。
{"water":"","kitchen":"","layout":"","storage":"","checks":[{"id":"W1","result":"ok","why":""}],"good":[],"concern":[]}
- water: 水回り。バス・トイレ別／独立洗面台／浴室乾燥機／追い焚き／洗濯機置場の位置 など、見える物だけ短く
- kitchen: キッチン。対面（カウンター）か壁付けか・コンロ（IH/ガス・口数）・システムキッチン など、見える物だけ
- layout: リビングと洋室の位置関係。隣り合う／廊下や水回りを挟んで離れている／引き戸で続き間 など、間取り図から
- storage: 収納。ウォークインクローゼット（WIC）・クローゼットの数と、どの部屋にあるか
- checks: 下の「お客様の希望」の**番号ごとに1つずつ**。result は
    "ok"（資料で希望どおりと確かめられる）／"ng"（資料で希望に反すると確かめられる。NG の項目なら、その NG に当たる物がある＝ng）／
    "unknown"（資料からは分からない）。why は資料のどこで確かめたか（例「設備欄: バス・トイレ別」「間取り図: 洋室が LDK の隣」）を短く
    ・資料に書いていない・見えない事は必ず "unknown"（推測で ok/ng にしない）
    ・ペットは条件欄・備考の「ペット可／相談／不可」で判断する。「ペット可NG」は「ペット可の物件は嫌」という意味（ペット可・相談なら ng）
- good: 希望に合う点（短く・最大4つ）／ concern: 希望に合わない・気になる点（短く・最大4つ）
- 画像に無い事は書かない（分からない項目は ""）。金額・面積・帖数の数字は書かない（広め／普通／狭め の言葉にする）
- 「対面」「カウンターキッチン」は、設備欄にその言葉があるか、間取り図でキッチンがリビング側を向いている（シンクの前がリビング）時だけ。
  廊下や壁に沿って置かれていれば「壁付け」。どちらか分からなければ向きは書かない（推測で「対面」にしない）
- WIC（ウォークインクローゼット）は間取り図・設備欄に「WIC」「W.I.C」「WCL」「ウォークインクロゼット」「納戸」とある物だけ。
  シューズ用（SIC・シューズWIC・シューズウォークイン）は WIC に数えない（「シューズ用」と分けて書く）

お客様の希望（【出どころ・NG・必須】）:
${list || "（特になし）"}`;
}

/** 返事の JSON を読む（崩れた返事は null）。点は wants があれば checks から決定論で出す */
export function parseAnalysis(text: string, wants: ImageWant[] = []): PickupImageAnalysis | null {
  const raw = (text ?? "").trim();
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (block ? block[1] : raw).trim();
  const jsonStr = body.startsWith("{") ? body : (body.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonStr) return null;
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    const s = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const arr = (v: unknown) => (Array.isArray(v) ? v : []).map(s).filter(Boolean).slice(0, 4);
    const ids = new Set(wants.map((w) => w.id));
    const checks: WantCheck[] = (Array.isArray(o.checks) ? o.checks : [])
      .map((c) => c as Record<string, unknown>)
      .map((c) => ({ id: s(c.id).toUpperCase(), result: (["ok", "ng", "unknown"].includes(s(c.result)) ? s(c.result) : "unknown") as WantCheck["result"], why: s(c.why) }))
      .filter((c) => !wants.length || ids.has(c.id));
    const m = o.match == null || o.match === "" ? null : Number(o.match);
    const detail = wants.length ? scoreChecksDetail(wants, checks) : null;
    const out: PickupImageAnalysis = {
      water: s(o.water), kitchen: s(o.kitchen), layout: s(o.layout), storage: s(o.storage),
      match: detail ? detail.score : (m != null && Number.isFinite(m) ? Math.max(0, Math.min(100, Math.round(m))) : null),
      ...(detail ? { match_raw: detail.raw, must_fail: detail.mustFail } : {}),
      good: arr(o.good), concern: arr(o.concern), checks,
    };
    if (!out.water && !out.kitchen && !out.layout && !out.storage && !checks.length) return null;   // 何も読めていない＝失敗
    return out;
  } catch { return null; }
}

/** 一番合う物件（match が最大・同点は元の順位が上）。match が1件も無ければ null */
export function pickBest<T extends { id: number; rank: number; analysis: PickupImageAnalysis | null }>(rows: T[]): T | null {
  const scored = rows.filter((r) => r.analysis?.match != null);
  if (!scored.length) return null;
  // 同点（例: 全件が必須 NG で 20 点）は上限前の点（match_raw）で並べ、それも同じなら元の順位
  return scored.slice().sort((a, z) => (z.analysis!.match! - a.analysis!.match!) || ((z.analysis!.match_raw ?? 0) - (a.analysis!.match_raw ?? 0)) || (a.rank - z.rank))[0];
}

/** 1物件を読む。失敗は analysis=null */
export async function analyzePickupImage(imageUrl: string, wants: ImageWant[] | string, opts?: { timeoutMs?: number }): Promise<{ analysis: PickupImageAnalysis | null; usage?: { input: number; output: number; cacheHit: number }; model?: string }> {
  const res = await callDeepSeek(null, [
    { type: "text", text: buildAnalysisPrompt(wants) },
    { type: "image_url", image_url: { url: imageUrl } },
  ], { maxTokens: ANALYSIS_MAX_TOKENS, timeoutMs: opts?.timeoutMs ?? 90_000, effort: "low" });
  if (!res) return { analysis: null };
  return { analysis: parseAnalysis(res.text, typeof wants === "string" ? [] : wants), usage: { input: res.usage.input, output: res.usage.output, cacheHit: res.usage.cacheHit }, model: res.model };
}

