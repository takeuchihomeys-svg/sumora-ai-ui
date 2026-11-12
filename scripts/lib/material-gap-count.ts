// scripts/lib/material-gap-count.ts — 人が直した番（edited-turns の weak-spots）を材料の抜けの台帳の①〜⑤で分ける（決まった線・LLM なし・DB なし）
//
// 2026-11-12 作業員1（材料の抜けの台帳・統括役）。weak-spots.json（2026-10-16）の型ごとの例（お客様の文・AI の下書き・人の送信）を読み、
//   人の送信にだけある中身の種類から ①何が ③どこから ④なぜ無いか ⑤何が起きるか を推す。
//   ⚠ ④は「その材料がその時点で DB にあったか」を見ていない推定（決まった線）。DB の確かめは JST 22時以降に軽く（別の台本）。
import type { MaterialGap, GapWhy, GapEffect, GapFrom, GapWhatKind } from "../../app/lib/material-gap-ledger";
import { conversationFactKind, CONVERSATION_FACT_SPEC, type ConversationFactKind } from "../../app/lib/conversation-fact-kinds";

/** 会話の中の事実の種類 → ③どこから・④なぜ（11/12 46件を目で読んだ分け） */
const CF_WHY: Record<ConversationFactKind, { from: GapFrom; why: GapWhy } | null> = {
  viewing_logistics: { from: "company_facts", why: "c" }, viewing_schedule: { from: "db_table", why: "e" }, check_result: { from: "check_result", why: "e" },
  vacancy_result: { from: "check_result", why: "e" }, search_scope: { from: "conversation", why: "c" }, company_knowledge: { from: "company_facts", why: "a" },
  doc_fact: { from: "document", why: "b" }, cost_breakdown: { from: "db_table", why: "c" }, apply_procedure: { from: "company_facts", why: "c" },
  customer_circumstance: { from: "conversation", why: "c" }, ack_only: null,
};

export type WeakSpot = { key: string; bucket: string; scene: string; type: string; n: number; typeJa?: string; examples?: Array<{ customer?: string | null; draft?: string | null; sent?: string | null }> };

/** 型 → 何が起きるか（疑いの印の名前）。材料の抜けでない型（長さ・挨拶・締め・誘い）は null */
export const SPOT_EFFECT: Record<string, GapEffect | null> = {
  fact_fix: "fact_missed", promise_escape: "held_answerable", promise_added: "answered_staff_only", other: "answered_staff_only", rewrite: "misread",
  longer: null, shorter: null, close_added: null, close_cut: null, appeal_added: null, appeal_cut: null, greeting_added: null, greeting_cut: null,
  name_line_added: null, vague_promise_cut: null, extra_cut: null,
};

/** 人の送信にだけある中身 → ①何が・③どこから・④なぜ無いか（推定） */
export function classifySentContent(sent: string, draft: string, type: string, customer?: string | null): { kind: GapWhatKind; name: string; from: GapFrom; why: GapWhy } | null {
  const s = String(sent ?? "").normalize("NFKC");
  const onlyInSent = (re: RegExp) => re.test(s) && !re.test(String(draft ?? "").normalize("NFKC"));
  if (type === "other" || type === "promise_added") return { kind: "check_result", name: "管理会社・スタッフの確認の結果", from: "check_result", why: "e" };
  if (type === "rewrite") return { kind: "exchange_left", name: "場面・中身の読み（下書きと送信が別の中身）", from: "conversation", why: "d" };
  if (onlyInSent(/\d[\d,]*\s*円|\d+(?:\.\d+)?\s*万|初期費用|割引/)) return { kind: "doc_field", name: "金額（見積・初期費用・家賃）", from: "db_table", why: "c" };
  if (onlyInSent(/号室|[ァ-ヶ一-龠A-Za-z]{3,}\s*\d{2,4}/)) return { kind: "property_record", name: "物件名・号室", from: "db_table", why: "c" };
  if (onlyInSent(/相場|治安|エリア|地域|沿線|駅周辺/)) return { kind: "company_fact", name: "地域・相場の知識", from: "company_facts", why: "a" };
  if (onlyInSent(/保証会社|独立系|信販系|信用系|審査/)) return { kind: "doc_field", name: "保証会社・審査の事実", from: "document", why: "b" };
  if (onlyInSent(/\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}:\d{2}|曜|退去予定|入居可能/)) return { kind: "doc_field", name: "日付（入居・退去・内覧）", from: "document", why: "c" };
  if (onlyInSent(/設備|洗面|キッチン|バス|トイレ|収納|駐車場|ペット/)) return { kind: "doc_field", name: "設備・条件（資料の欄）", from: "document", why: "b" };
  // 2026-11-12 会話の中の事実の種類（conversation-fact-kinds）で分ける。お礼・了承だけは材料の抜けではない（null）
  const k = conversationFactKind(customer ?? "", sent);
  const w = CF_WHY[k];
  if (!w) return null;
  return { kind: "exchange_left", name: `会話の事実: ${CONVERSATION_FACT_SPEC[k].label}`, from: w.from, why: w.why };
}

/** 1つの型の例を台帳の抜けに（例が無い時は型だけで1件） */
export function gapsFromSpot(sp: WeakSpot): Array<MaterialGap & { n: number; spotKey: string }> {
  const effect = SPOT_EFFECT[sp.type];
  if (!effect) return [];
  const ex = sp.examples?.length ? sp.examples : [{ sent: "", draft: "" }];
  const per = sp.n / ex.length;
  return ex.flatMap((e) => {
    const c = classifySentContent(String(e.sent ?? ""), String(e.draft ?? ""), sp.type, (e as { customer?: string | null }).customer ?? null);
    if (!c) return [];
    const forRole = sp.bucket.startsWith("aix") ? "aix_first" as const : "writer" as const;
    return [{ what: { kind: c.kind, name: c.name }, forRole, forWhat: `${sp.scene} の${sp.bucket.startsWith("aix") ? " AIX の文" : "返信の文"}`, from: c.from, why: c.why, effect, n: per, spotKey: sp.key }];
  });
}

/** 型の一覧 → a〜e の数え・上位（何が×何のために×なぜ） */
export function countSpots(spots: ReadonlyArray<WeakSpot>): { total: number; why: Record<GapWhy, number>; effect: Record<string, number>; top: Array<{ what: string; forWhat: string; why: GapWhy; n: number }> } {
  const gaps = spots.flatMap(gapsFromSpot);
  const why = { a: 0, b: 0, c: 0, d: 0, e: 0 } as Record<GapWhy, number>;
  const effect: Record<string, number> = {};
  const top = new Map<string, { what: string; forWhat: string; why: GapWhy; n: number }>();
  for (const g of gaps) {
    why[g.why] += g.n; effect[g.effect] = (effect[g.effect] ?? 0) + g.n;
    const k = `${g.what.name}|${g.forRole}|${g.why}`;
    const v = top.get(k) ?? { what: g.what.name, forWhat: g.forRole === "aix_first" ? "AIX の文" : "返信の文", why: g.why, n: 0 };
    v.n += g.n; top.set(k, v);
  }
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    total: r(gaps.reduce((s, g) => s + g.n, 0)),
    why: Object.fromEntries(Object.entries(why).map(([k, v]) => [k, r(v)])) as Record<GapWhy, number>,
    effect: Object.fromEntries(Object.entries(effect).map(([k, v]) => [k, r(v)])),
    top: [...top.values()].map((v) => ({ ...v, n: r(v.n) })).sort((a, b) => b.n - a.n).slice(0, 10),
  };
}
