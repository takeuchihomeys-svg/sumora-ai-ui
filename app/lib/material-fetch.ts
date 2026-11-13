// app/lib/material-fetch.ts — 足りない事実を取りに行く段（S4）の表（純関数・DB/LLM なし）
//
// 2026-11-13 作業員1（統括役・点検役の比べ「一番大きい抜けは足りない事実を取りに行く段」・材料の帳面 MATERIAL_GAP_BOOKS の続き）
//   ブレインが material_missing（自己申告）に「無い」と書いても、取りに行っていなかった（12548 床の色・他の号室／12838 送れる候補・オートロックの資料／
//   12643 見積の項目）。自己申告を決まった鍵に寄せ（material-missing-key）、決まった取り先を引く:
//     物件の資料（他の号室・床や内装の色・寸法・設備）→ property_pickups の資料の行（image_lines・equipment・terms）
//     送れる候補 → 送っていない新しいピックアップ（pickup_ready と同じ線）
//     見積の項目 → 送った御見積書の文（aix_usage_logs の estimate_sheet）
//     会社の知識 → company facts（おとり・掲載の決まりを含む）
//   取れた物は事実の欄として読み直しの口（brain-recheck の from:"fetch"）に1回だけ渡す。取れなかった物は「スタッフだけ」の印（返信か AIX かの判断へ）。
//   既定 off（BRAIN_MATERIAL_FETCH=on の時だけ）
import { materialBookOf } from "./material-gap-ledger";

export function materialFetchOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_MATERIAL_FETCH ?? "").trim().toLowerCase() === "on";
}

export type FetchSource = "property_doc" | "pickup_ready" | "estimate_sheet" | "company_facts";
export type FetchPlanItem = { label: string; source: FetchSource | null; words: string[] };

/** 資料の行を探す時の語（自己申告の名前から拾う） */
const DOC_WORDS = ["床", "色", "フローリング", "号室", "オートロック", "収納", "クローゼット", "寸法", "広さ", "エアコン", "キッチン", "浴室", "トイレ", "洗濯機", "ペット", "駐車場", "バイク", "階", "日当たり", "向き", "宅配", "ネット", "インターネット"];
const words = (label: string) => DOC_WORDS.filter((w) => label.includes(w));

/** 自己申告1つ → 取り先（null＝スタッフしか知らない／取り先が無い） */
export function fetchSourceOf(label: string): FetchSource | null {
  const b = materialBookOf(label);
  if (/見積|初期費用/.test(label) && !/交渉|代表|割引|可否/.test(label)) return "estimate_sheet";
  if (b.mark === "staff") return null;
  if (b.key === "sendable_candidates" || /候補|新着|新規/.test(label)) return "pickup_ready";
  if (b.book === "company_fact") return "company_facts";
  if (b.book === "property_doc" || words(label).length) return "property_doc";
  return null;
}
export function materialFetchPlan(labels: ReadonlyArray<string>): FetchPlanItem[] {
  const seen = new Set<string>();
  return labels.filter((l) => l && !seen.has(l) && (seen.add(l), true)).slice(0, 6).map((label) => ({ label, source: fetchSourceOf(label), words: words(label) }));
}

/** 資料の行から、自己申告の語を含む行を拾う（「他の号室」は同じ物件の号室の一覧） */
export function pickDocLines(rows: ReadonlyArray<{ property_name: string | null; room_no: string | null; lines: ReadonlyArray<string> }>, item: FetchPlanItem, max = 4): string[] {
  const out: string[] = [];
  if (/号室/.test(item.label) && /他|別|違う|ほか/.test(item.label)) {
    const by = new Map<string, Set<string>>();
    for (const r of rows) if (r.property_name && r.room_no) { const s = by.get(r.property_name) ?? new Set<string>(); s.add(r.room_no); by.set(r.property_name, s); }
    for (const [n, s] of by) if (s.size) out.push(`${n}: 資料のある号室 ${[...s].slice(0, 6).join("・")}`);
    return out.slice(0, max);
  }
  const ws = item.words.filter((w) => w !== "号室");
  if (!ws.length) return out;
  for (const r of rows) for (const l of r.lines) if (ws.some((w) => l.includes(w))) { const s = `${r.property_name ?? "物件"}${r.room_no ? ` ${r.room_no}` : ""}: ${l.slice(0, 80)}`; if (!out.includes(s)) out.push(s); if (out.length >= max) return out; }
  return out;
}

export type FetchResult = { label: string; source: FetchSource | null; facts: string[] };
/** 読み直しに渡す事実の欄（取れた物だけ）。無ければ null */
export function fetchedMaterialText(results: ReadonlyArray<FetchResult>): string | null {
  const got = results.filter((r) => r.facts.length);
  if (!got.length) return null;
  return got.map((r) => `・${r.label}（${r.source}）: ${r.facts.join(" ／ ")}`).join("\n").slice(0, 600);
}
/** 記録（meta.material_fetch）: 「名前|取り先|got／staff／none」 */
export function materialFetchDigest(results: ReadonlyArray<FetchResult>): string[] | undefined {
  const d = results.map((r) => `${r.label.slice(0, 24)}|${r.source ?? "-"}|${r.facts.length ? "got" : r.source ? "none" : "staff"}`);
  return d.length ? d : undefined;
}
