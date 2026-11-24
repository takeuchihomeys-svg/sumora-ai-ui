// app/lib/aix-state-doc.ts — 札の欠け「資料にある」を埋める部品（台帳 #688・決まった計算・LLM なし）
// 2026-11-25 作業員A（竹内さん「AIX の内容を理解して、どんな時に使えばよいかを理解すれば強化していく」・統括役の頼み）
//   辞書（aix-catalog）の線で一番多い条件は「資料に書いてある事（礼金・保証会社・駐車場・管理会社・入居時期・設備）は返信・無ければ確認の約束」（13か所）。
//   どの資料の表から読めるか（11/25 の DB の確かめ）: 送った物件（property_pickups・status=sent・60日 694件）は全件に terms（pickup-terms）と pdf_text（リアプロの文字層）がある。
//     pdf_text に言葉がある割合: 管理会社・元付 100%・保証会社 97%・駐車場 87%・礼金 87%・入居 87%・エアコン 82%・バイク／駐輪 67%・ペット 55%。
//   読み方は今ある contract-terms-question.routeContractTerm（項目ごとに material＝資料の文字で答えてよい／confirm＝資料に無い・言い切れない）をそのまま使う
//   （新しい読み方は作らない・同じ網で返信の道と札がそろう）。札には「最後の束で送った物件のうち、項目ごとに資料で答えられる件数」を載せる
import { routeContractTerm, type ContractMaterial, type ContractTermTopic } from "./contract-terms-question";

export const DOC_TOPICS: readonly ContractTermTopic[] = ["key_money", "deposit", "guarantor_company", "guarantor_person", "move_in", "parking", "management_company", "two_person", "pet"];
export type DocPickup = { property_name: string | null; created_at: string; terms?: ContractMaterial["terms"]; pdf_text?: string | null; image_lines?: string[] | null };
export type DocFacts = { properties: number; topics: Partial<Record<ContractTermTopic, { material: number; confirm: number }>> };

/** 資料で答えられる項目（純関数）。rows は送った物件（新しい順でも古い順でもよい）。now より後の行は入れない・最後の束（最新の作成時刻から30分以内）の物件だけ */
export function docFactsOf(rows: ReadonlyArray<DocPickup>, now: number, o: { bundleWindowMin?: number; nowMs?: number } = {}): DocFacts | null {
  const xs = rows.filter((r) => Date.parse(r.created_at) <= now).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!xs.length) return null;
  const t0 = Date.parse(xs[0].created_at), win = (o.bundleWindowMin ?? 30) * 60_000;
  const last = xs.filter((r) => t0 - Date.parse(r.created_at) <= win);
  const topics: DocFacts["topics"] = {};
  for (const tp of DOC_TOPICS) {
    const c = { material: 0, confirm: 0 };
    for (const r of last) {
      try { const rt = routeContractTerm(tp, { terms: r.terms ?? null, lines: r.image_lines ?? [], pdfText: r.pdf_text ?? null }, { nowMs: o.nowMs ?? now }); if (rt.route === "material") c.material++; else c.confirm++; } catch { c.confirm++; }
    }
    topics[tp] = c;
  }
  return { properties: last.length, topics };
}
const JA: Record<string, string> = { key_money: "礼金", deposit: "敷金", guarantor_company: "保証会社", guarantor_person: "保証人", move_in: "入居時期", parking: "駐車場", management_company: "管理会社", two_person: "二人入居", pet: "ペット" };
/** 札の1行（資料で答えられる項目／全件・確認が要る項目） */
export function docFactsLine(d: DocFacts | null): string {
  if (!d) return "送った物件の資料なし";
  const ok = Object.entries(d.topics).filter(([, c]) => c && c.material === d.properties).map(([k]) => JA[k] ?? k);
  const need = Object.entries(d.topics).filter(([, c]) => c && c.material === 0).map(([k]) => JA[k] ?? k);
  return `最後の束 ${d.properties}件の資料: 全件に書いてある ${ok.join("・") || "なし"}／どれにも無い（確認が要る） ${need.join("・") || "なし"}`;
}
