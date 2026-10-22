// app/lib/brain-unknowns.ts — ブレインの「分からない事」を今ある印から決まった計算で拾う（純関数・DB も LLM も持たない）
//
// 2026-10-22 竹内さんの決定（設計知見 395e0064）: 分からない→集める→竹内さんにまとめて聞く→答えを設計知見とブレインに入れる→試験で確かめる。
//   ここは「集める」。拾う印（どれも既にある物・新しい LLM 呼び出しなし）:
//     low_confidence_reason … 下書きの自信が低（draft-confidence）の番の、点を引いた理由（コードごと）
//     staff_only_fact       … 下書きがスタッフしか知らない事（空き・見積の金額・待ち合わせ・内覧確定・電話）を言い切った番（staff-confirm-facts）
//     company_rule_missing  … 最終チェックが「作り話の決まり・金額」を指摘した番＝会社の決まりがブレインの材料に無い（FABRICATED_POLICY 等）
//     watch_break           … つなぎのブレインの見張りの切れ（link-brain-watch の つなぎ×切れの型）
//     exam_miss_type        … 試験の外れの理由（scripts/exam-brain.ts の読み手が付けた型・手元のファイルから scripts/owner-questions.ts --collect-exam）
//   sample_ref に残すのは会話 id（または頭8文字）と時刻だけ。お客様の文・下書きの文・名前は残さない。
import { findStaffOnlyFact } from "./staff-confirm-facts";
import { confidenceFromCheck, CONFIDENCE_CODE_JA, type ConfidenceCode } from "./draft-confidence";

export type UnknownKind = "low_confidence_reason" | "staff_only_fact" | "company_rule_missing" | "watch_break" | "exam_miss_type";
export const UNKNOWN_KIND_JA: Record<UnknownKind, string> = {
  low_confidence_reason: "自信が低い理由",
  staff_only_fact: "スタッフしか知らない事を書いた",
  company_rule_missing: "会社の決まりが材料に無い",
  watch_break: "つなぎの切れ",
  exam_miss_type: "試験の外れの型",
};

export type SampleRef = { conversation_id?: string; at?: string; exam_label?: string; qid?: string; turn_id?: number };
export type UnknownHit = { kind: UnknownKind; key: string; label: string; ref: SampleRef };

/** 切替（既定 on・止める BRAIN_UNKNOWNS=off）。読みは見張りの1日分の1回・書きは型の数（多くて数十行）だけ */
export function brainUnknownsEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_UNKNOWNS ?? "").trim().toLowerCase() !== "off";
}

/** 最終チェックのコードのうち「会社の決まり・事実がブレインの材料に無い」を表す物 */
export const COMPANY_RULE_CODES: Readonly<Record<string, string>> = {
  FABRICATED_POLICY: "会社の決まりを作って書いた",
  FABRICATED_AMOUNT: "材料に無い金額を書いた",
};

const STAFF_ONLY_JA: Record<string, string> = {
  vacancy: "空き状況", estimate_amount: "見積の金額", meeting_address: "待ち合わせの住所", viewing_fixed: "内覧の確定", phone_call_promise: "電話の約束",
};

export type WatchTurnRow = { id: number; conversation_id: string; customer_turn_at: string | null; final_check: unknown; draft_last: string | null };

/** 見張りの番1つから拾う */
export function unknownsFromTurn(r: WatchTurnRow): UnknownHit[] {
  const ref: SampleRef = { conversation_id: r.conversation_id, at: r.customer_turn_at ?? undefined, turn_id: r.id };
  const out: UnknownHit[] = [];
  const conf = confidenceFromCheck(r.final_check);
  if (conf && conf.band === "low") {
    for (const reason of conf.reasons) {
      if (!(reason.delta < 0)) continue;
      const code = String(reason.code) as ConfidenceCode;
      out.push({ kind: "low_confidence_reason", key: code, label: CONFIDENCE_CODE_JA[code] ?? code, ref });
    }
  }
  const so = r.draft_last ? findStaffOnlyFact(r.draft_last) : null;
  if (so) out.push({ kind: "staff_only_fact", key: so.kind, label: STAFF_ONLY_JA[so.kind] ?? so.kind, ref });
  const codes = (r.final_check as { final_codes?: unknown } | null)?.final_codes;
  const seen = new Set<string>();
  for (const c of Array.isArray(codes) ? codes : []) {
    const base = String(c).split(":")[0];
    if (COMPANY_RULE_CODES[base] && !seen.has(base)) { seen.add(base); out.push({ kind: "company_rule_missing", key: base, label: COMPANY_RULE_CODES[base], ref }); }
  }
  return out;
}

/** つなぎの見張りのまとめ（link-brain-watch の LinkWatchSummary の形の一部）から拾う */
export function unknownsFromLinkSummary(s: { links: Record<string, { byType: Record<string, number>; examples?: Array<{ conv: string; at: string; breakType: string }> }> }, breakJa: Record<string, string> = {}, linkJa: Record<string, string> = {}): UnknownHit[] {
  const out: UnknownHit[] = [];
  for (const [link, c] of Object.entries(s.links ?? {})) {
    for (const [t, n] of Object.entries(c.byType ?? {})) {
      const exs = (c.examples ?? []).filter((e) => e.breakType === t);
      const label = `${linkJa[link] ?? link}：${breakJa[t] ?? t}`;
      for (let i = 0; i < n; i++) {
        const e = exs[i];
        out.push({ kind: "watch_break", key: `${link}:${t}`, label, ref: e ? { conversation_id: e.conv, at: e.at } : {} });
      }
    }
  }
  return out;
}

export type UnknownAgg = { kind: UnknownKind; key: string; label: string; n: number; refs: SampleRef[]; lastAt: string | null };
const MAX_REFS = 5;

/** 型×鍵でまとめる（例の印は新しい順に5つまで） */
export function aggregateUnknowns(hits: ReadonlyArray<UnknownHit>): UnknownAgg[] {
  const m = new Map<string, UnknownAgg>();
  for (const h of hits) {
    const k = `${h.kind}\u0000${h.key}`;
    const a = m.get(k) ?? { kind: h.kind, key: h.key, label: h.label, n: 0, refs: [], lastAt: null };
    a.n++;
    if (h.ref && Object.keys(h.ref).length) a.refs.push(h.ref);
    if (h.ref.at && (!a.lastAt || h.ref.at > a.lastAt)) a.lastAt = h.ref.at;
    m.set(k, a);
  }
  for (const a of m.values()) a.refs = a.refs.sort((x, y) => String(y.at ?? "").localeCompare(String(x.at ?? ""))).slice(0, MAX_REFS);
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** 既存の行と足し合わせる（数は足す・例は新しい物を前に5つまで・同じ印は重ねない） */
export function mergeUnknownRow(existing: { count: number; sample_ref: unknown; first_at: string | null; last_at: string | null } | null, a: UnknownAgg, nowIso: string): { count: number; sample_ref: SampleRef[]; first_at: string; last_at: string } {
  const old = Array.isArray(existing?.sample_ref) ? (existing!.sample_ref as SampleRef[]) : [];
  const key = (r: SampleRef) => `${r.conversation_id ?? ""}|${r.at ?? ""}|${r.exam_label ?? ""}|${r.qid ?? ""}`;
  const seen = new Set<string>();
  const refs: SampleRef[] = [];
  for (const r of [...a.refs, ...old]) { const k = key(r); if (seen.has(k)) continue; seen.add(k); refs.push(r); if (refs.length >= MAX_REFS) break; }
  const last = a.lastAt ?? nowIso;
  return {
    count: (existing?.count ?? 0) + a.n,
    sample_ref: refs,
    first_at: existing?.first_at ?? last,
    last_at: existing?.last_at && existing.last_at > last ? existing.last_at : last,
  };
}

/** 試験の外れの理由（scripts/exam-brain.ts の reasons-latest.json の形）から拾う。「正解が揺れている」「判定の誤り」は試験の側の問題なので鍵に印を付ける */
export function unknownsFromExamReasons(rec: { label?: string; reasons?: Array<{ id: string; kind: string }> } | null): UnknownHit[] {
  if (!rec?.reasons?.length) return [];
  return rec.reasons.map((r) => ({ kind: "exam_miss_type" as const, key: r.kind, label: r.kind, ref: { exam_label: rec.label, qid: r.id } }));
}
