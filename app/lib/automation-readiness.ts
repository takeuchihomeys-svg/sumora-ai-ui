// app/lib/automation-readiness.ts
// 週ごとの「自動化できる度合い」の表（純関数・DB も fetch も持たない）。読むのは scripts/automation-readiness.ts。
// 2026-09-27 竹内「かなり質はあがってるかな？全体の文の質や動き方の質／このようにテスト繰り返して質上げていくために足りない部分等見つけていく
//   ／そうすれば完全自動化できるから」→「週ごとの自動化できる度合いを1つの表で見られるようにする」に「それ行う」。
//
// 3つの物差し（どれも「スタッフが手を入れずに済んだか」）:
//   AIX   … ブレインの予想と押した AIX の一致・生成文を手直しなしで送った率・手直しの量と型（ai_reply_examples entry_source=aix_action の ai_draft↔sent_reply）
//   下書き … 下書きをそのまま送った率・手直しの量と型・下書きを使わず手打ちした率（ai_reply_examples entry_source=line_reply）
//   ブレイン … 判断の後の行動（brain-outcome.resolveBrainOutcomes）
// 「届いている」＝手直しなしが READY_RATE 以上かつ件数が READY_MIN_N 以上。届いていない所は手直しの件数（n×(1−率)）の多い順に候補にする。
//
// 過去の記録の推定（表に明記する）:
//   ・aix_usage_logs.suggested_action は 2026-09-27 の直しまで suggest-next-action（P8）の予想で、ブレインの予想ではなかった
//     （入っている 94件のうちブレインの判断と同じ値は1件）。直す前の行は brain_decision_logs の「押す前の一番新しい判断」から推定する。
//   ・outcome は窓が閉じた判断をすべて事実から決め直す（画面が書いた値は使わない）。
import { classifyEdit, droppedEdit, isUntouched, bigramSim, EDIT_KIND_JA, type EditDiff, type EditKind, type EditAmount } from "./edit-diff";
import { brainPredictionAt, BRAIN_OUTCOME_JA, type BrainOutcome, type ResolvedOutcome } from "./brain-outcome";

export const READY_RATE = 0.8;
export const READY_MIN_N = 10;

/** JST の週の月曜（YYYY-MM-DD） */
export function jstWeek(iso: string): string {
  const t = new Date(iso).getTime() + 9 * 3600_000;
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return mon.toISOString().slice(0, 10);
}

export type ReadinessAixRow = {
  id: string; conversation_id: string; created_at: string; aix_type: string; check_pattern?: string | null;
  suggested_action?: string | null; was_edited?: boolean | null; conversation_status?: string | null;
};
export type ReadinessExample = {
  conversation_id: string | null; sent_at: string | null; created_at?: string | null; entry_source: string | null;
  conversation_state?: string | null; aix_action?: string | null; ai_draft: string | null; sent_reply: string | null;
};
export type ReadinessDecision = {
  id: string; conversation_id: string; created_at: string; suggested_action: string | null;
  suggested_reply_mode?: string | null; scene_evidence?: string | null; conversation_status?: string | null; outcome?: string | null;
  /** 2層ブレインの毎回の分析の要点（intent＝お客様の発言の意図 等） */
  digest?: { intent?: string | null } | null;
};

const ms = (iso: string) => new Date(iso).getTime();
const normAix = (a: string | null | undefined) => { const s = (a ?? "").trim(); return s === "acknowledge_check" ? "property_check_result" : s; };

/** AIX の送信に、同じ会話・±3分の aix_action の下書きの記録を結ぶ（AixModal の save-reply-example） */
export const AIX_EXAMPLE_MATCH_MS = 3 * 60 * 1000;
export function matchAixExample(a: ReadinessAixRow, examples: ReadonlyArray<ReadinessExample>): ReadinessExample | null {
  const t = ms(a.created_at);
  let best: ReadinessExample | null = null, gap = Infinity;
  for (const e of examples) {
    if (e.entry_source !== "aix_action" || e.conversation_id !== a.conversation_id) continue;
    const at = e.sent_at ?? e.created_at; if (!at) continue;
    const g = Math.abs(ms(at) - t);
    if (g <= AIX_EXAMPLE_MATCH_MS && g < gap) { best = e; gap = g; }
  }
  return best;
}

/** 場面（ブレインの scene）: scene_evidence の scene。無ければ "（場面なし）" */
export function sceneOf(d: { scene_evidence?: string | null } | null | undefined): string {
  if (!d?.scene_evidence) return "（場面なし）";
  try { const o = JSON.parse(d.scene_evidence) as { scene?: string | null }; return o?.scene || "（場面なし）"; } catch { return "（場面なし）"; }
}

// ─── 1件ずつの判定 ───

/** AIX の送信の窓（押した記録は送った後に書かれるので、記録の10分前〜1分後の AIX の文を送った文とする） */
export const AIX_SENT_BEFORE_MS = 10 * 60 * 1000;
export const AIX_SENT_AFTER_MS = 60 * 1000;
/** 同じ会話で30分以内に続けて押した AIX は2つ目（ピックアップ→オススメ等）。ブレインの予想との一致には数えない（brain-aix-feedback と同じ） */
export const AIX_CHAIN_MS = 30 * 60 * 1000;
export type ReadinessStaffMessage = { conversation_id: string; created_at: string; text: string | null; is_aix_generated?: boolean | null };

/**
 * 生成文と送った文の対。ai_reply_examples の sent_reply は save-reply-example の「分割送信の2通目」のまとめで
 * 別の送信（前後の手打ち・カバーレター）がつながっている事がある（2026-09-27 見積書送るで確認）ので、
 * 送った文は messages の AIX の文（is_aix_generated）から取る: 1通が生成文と同じ／続けた数通をつないだ物が同じ → そのまま、
 * それ以外は生成文に一番近い1通と比べる。AIX の文が見つからない時だけ記録の sent_reply を使う。
 */
export function aixSentTextFor(draft: string, pressAtIso: string, msgs: ReadonlyArray<ReadinessStaffMessage>): string | null {
  const t = ms(pressAtIso);
  const texts = msgs
    .filter((m) => m.is_aix_generated && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .filter((m) => { const x = ms(m.created_at); return x >= t - AIX_SENT_BEFORE_MS && x <= t + AIX_SENT_AFTER_MS; })
    .map((m) => String(m.text).trim());
  if (texts.length === 0) return null;
  const d = draft.trim();
  if (texts.includes(d)) return d;
  for (let i = 0; i < texts.length; i++) {
    let joined = texts[i];
    for (let j = i + 1; j < texts.length; j++) { joined += "\n" + texts[j]; if (joined === d) return d; }
  }
  let best = texts[0], bestSim = -1;
  for (const x of texts) { const v = bigramSim(d, x); if (v > bestSim) { bestSim = v; best = x; } }
  return best;
}

export type AixJudged = {
  row: ReadinessAixRow; week: string; key: string;
  /** 30分以内に続けて押した2つ目の AIX（一致の分母に入れない） */
  chained: boolean;
  /** ブレインの予想（記録 or 推定）・"none"＝ブレインは AIX なし・null＝判断が無い */
  predicted: string | null; predictedEstimated: boolean;
  matched: boolean | null;
  /** 生成文と送った文（下書きの記録が無ければ null＝AI の生成なし・固定文） */
  edit: EditDiff | null;
  untouched: boolean | null;
};

/**
 * AIX 1件ずつ。recordedFrom 以降の行は suggested_action を記録として使い、それより前は判断から推定する。
 */
export function judgeAix(rows: ReadonlyArray<ReadinessAixRow>, examples: ReadonlyArray<ReadinessExample>, decisions: ReadonlyArray<ReadinessDecision>, recordedFromIso: string, staffMessages: ReadonlyArray<ReadinessStaffMessage> = []): AixJudged[] {
  const msgBy = new Map<string, ReadinessStaffMessage[]>();
  for (const m of staffMessages) { const a = msgBy.get(m.conversation_id) ?? []; a.push(m); msgBy.set(m.conversation_id, a); }
  const pressBy = new Map<string, number[]>();
  for (const r of rows) { const a = pressBy.get(r.conversation_id) ?? []; a.push(ms(r.created_at)); pressBy.set(r.conversation_id, a); }
  const decBy = new Map<string, ReadinessDecision[]>();
  for (const d of decisions) { const a = decBy.get(d.conversation_id) ?? []; a.push(d); decBy.set(d.conversation_id, a); }
  const exBy = new Map<string, ReadinessExample[]>();
  for (const e of examples) { if (!e.conversation_id || e.entry_source !== "aix_action") continue; const a = exBy.get(e.conversation_id) ?? []; a.push(e); exBy.set(e.conversation_id, a); }
  const recordedFrom = ms(recordedFromIso);
  return rows.map((row) => {
    const recorded = ms(row.created_at) >= recordedFrom;
    const predicted = recorded ? (row.suggested_action ?? null) : brainPredictionAt(decBy.get(row.conversation_id) ?? [], row.created_at);
    const tRow = ms(row.created_at);
    const chained = (pressBy.get(row.conversation_id) ?? []).some((x) => x < tRow && tRow - x <= AIX_CHAIN_MS);
    const matched = predicted == null || chained ? null : predicted !== "none" && normAix(predicted) === normAix(row.aix_type);
    const ex = matchAixExample(row, exBy.get(row.conversation_id) ?? []);
    const draft = String(ex?.ai_draft ?? "").trim();
    const fromMsgs = draft ? aixSentTextFor(draft, row.created_at, msgBy.get(row.conversation_id) ?? []) : null;
    const sentText = draft ? (fromMsgs ?? String(ex?.sent_reply ?? "")) : "";
    // AIX の文が送られているのに生成文と似た文が無い＝生成文を使わず別の文（見積書の本文だけ送ってカバーレターは手打ち 等）
    const simToSent = draft ? bigramSim(draft, sentText) : 0;
    const edit = ex && draft ? (fromMsgs != null && simToSent < 0.3 ? droppedEdit(simToSent) : classifyEdit(draft, sentText)) : null;
    // 生成文が無い（固定文・画像だけ）時は was_edited を使う（AixModal が生成文と送った文を比べた値）
    const untouched = edit ? isUntouched(edit) : row.was_edited == null ? null : !row.was_edited;
    return { row, week: jstWeek(row.created_at), key: row.aix_type, chained, predicted, predictedEstimated: !recorded, matched, edit, untouched };
  });
}

/** brain-core の digest.intent の日本語 */
export const INTENT_JA: Record<string, string> = {
  desire: "要望", question: "質問", chat: "雑談・相づち", decision: "決めた・申込の意思", consultation: "相談",
  positive: "前向きな反応", negative: "後ろ向きな反応",
};
/** 下書きの場面: 送る前の一番新しいブレインの判断（48時間以内）の「お客様の発言の意図」（digest.intent）。段階（conversation_state）は9割が proposing で分かれないため */
export function draftIntentOf(ex: ReadinessExample, decisionsOfConv: ReadonlyArray<ReadinessDecision>): string {
  const at = ex.sent_at ?? ex.created_at;
  if (!at) return "（判断なし）";
  const t = ms(at);
  let best: ReadinessDecision | null = null;
  for (const d of decisionsOfConv) { const x = ms(d.created_at); if (x <= t && t - x <= 48 * 3600_000 && (!best || x > ms(best.created_at))) best = d; }
  if (!best) return "（判断なし）";
  const k = best.digest?.intent || "";
  return k ? `${INTENT_JA[k] ?? k}（${k}）` : "（意図なし＝2層ブレインの要点が無い判断）";
}

export type DraftJudged = {
  ex: ReadinessExample; week: string; stage: string;
  /** ブレインの判断の「お客様の発言の意図」（draftIntentOf） */
  intent: string;
  /** 下書きを使わず手打ち（ai_draft なし） */
  manual: boolean;
  edit: EditDiff | null;
};
export function judgeDrafts(examples: ReadonlyArray<ReadinessExample>, decisions: ReadonlyArray<ReadinessDecision> = []): DraftJudged[] {
  const decBy = new Map<string, ReadinessDecision[]>();
  for (const d of decisions) { const a = decBy.get(d.conversation_id) ?? []; a.push(d); decBy.set(d.conversation_id, a); }
  return examples.filter((e) => e.entry_source === "line_reply" && (e.sent_at ?? e.created_at)).map((ex) => {
    const draft = String(ex.ai_draft ?? "").trim();
    return {
      ex, week: jstWeek((ex.sent_at ?? ex.created_at)!), stage: ex.conversation_state || "（段階なし）",
      intent: draftIntentOf(ex, ex.conversation_id ? decBy.get(ex.conversation_id) ?? [] : []),
      manual: !draft, edit: draft ? classifyEdit(draft, String(ex.sent_reply ?? "")) : null,
    };
  });
}

// ─── 集計 ───

export type Cell = {
  label: string; n: number;
  /** 手直しなしの率（分母は判定できた件数） */
  untouchedRate: number | null; untouchedN: number; judgedN: number;
  /** 一致率（AIX のみ・分母は予想がある件数） */
  matchRate?: number | null; predictedN?: number; estimatedN?: number;
  /** 手打ち率（下書きのみ） */
  manualRate?: number | null;
  amounts: Partial<Record<EditAmount, number>>;
  kinds: Array<{ kind: EditKind; label: string; count: number }>;
  reached: boolean;
  /** 手直しの件数（次に直す候補の並びに使う） */
  fixCount: number;
};

function topKinds(edits: ReadonlyArray<EditDiff | null>): Cell["kinds"] {
  const m = new Map<EditKind, number>();
  for (const e of edits) if (e && e.amount !== "none") for (const k of e.kinds) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, label: EDIT_KIND_JA[kind], count }));
}
function amounts(edits: ReadonlyArray<EditDiff | null>): Cell["amounts"] {
  const o: Cell["amounts"] = {};
  for (const e of edits) if (e) o[e.amount] = (o[e.amount] ?? 0) + 1;
  return o;
}
const rate = (a: number, b: number) => (b > 0 ? a / b : null);

export function aixCell(label: string, js: ReadonlyArray<AixJudged>): Cell {
  const judged = js.filter((j) => j.untouched != null);
  const unt = judged.filter((j) => j.untouched).length;
  const pred = js.filter((j) => j.matched != null);
  const ur = rate(unt, judged.length);
  return {
    label, n: js.length, untouchedRate: ur, untouchedN: unt, judgedN: judged.length,
    matchRate: rate(pred.filter((j) => j.matched).length, pred.length), predictedN: pred.length,
    estimatedN: pred.filter((j) => j.predictedEstimated).length,
    amounts: amounts(js.map((j) => j.edit)), kinds: topKinds(js.map((j) => j.edit)),
    reached: ur != null && ur >= READY_RATE && judged.length >= READY_MIN_N,
    fixCount: judged.length - unt,
  };
}
export function draftCell(label: string, js: ReadonlyArray<DraftJudged>): Cell {
  const withDraft = js.filter((j) => !j.manual);
  const unt = withDraft.filter((j) => isUntouched(j.edit)).length;
  const ur = rate(unt, withDraft.length);
  return {
    label, n: js.length, untouchedRate: ur, untouchedN: unt, judgedN: withDraft.length,
    manualRate: rate(js.filter((j) => j.manual).length, js.length),
    amounts: amounts(withDraft.map((j) => j.edit)), kinds: topKinds(withDraft.map((j) => j.edit)),
    reached: ur != null && ur >= READY_RATE && withDraft.length >= READY_MIN_N,
    // 手直し＋手打ち（下書きが使われなかった）を直す候補の件数に数える
    fixCount: (withDraft.length - unt) + js.filter((j) => j.manual).length,
  };
}

export function groupCells<T>(items: ReadonlyArray<T>, key: (t: T) => string, make: (label: string, xs: T[]) => Cell): Cell[] {
  const m = new Map<string, T[]>();
  for (const it of items) { const k = key(it); const a = m.get(k) ?? []; a.push(it); m.set(k, a); }
  return [...m].map(([k, xs]) => make(k, xs)).sort((a, b) => b.n - a.n);
}

export type BrainWeek = { week: string; n: number; byOutcome: Partial<Record<BrainOutcome | "pending", number>> };
export function brainWeeks(resolved: ReadonlyArray<ResolvedOutcome>): BrainWeek[] {
  const m = new Map<string, BrainWeek>();
  for (const r of resolved) {
    const w = jstWeek(r.decision.created_at);
    const row = m.get(w) ?? { week: w, n: 0, byOutcome: {} };
    row.n++;
    const k = r.outcome ?? "pending";
    row.byOutcome[k] = (row.byOutcome[k] ?? 0) + 1;
    m.set(w, row);
  }
  return [...m.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** ブレインの判断の後の行動を「AIX の判断」「返信の判断」で分けた率（場面ごと） */
export function brainSceneCells(resolved: ReadonlyArray<ResolvedOutcome & { scene: string }>): Array<{ scene: string; n: number; followRate: number | null; byOutcome: Partial<Record<BrainOutcome, number>> }> {
  const m = new Map<string, Array<ResolvedOutcome & { scene: string }>>();
  for (const r of resolved) { if (!r.outcome) continue; const a = m.get(r.scene) ?? []; a.push(r); m.set(r.scene, a); }
  return [...m].map(([scene, xs]) => {
    const by: Partial<Record<BrainOutcome, number>> = {};
    for (const x of xs) by[x.outcome!] = (by[x.outcome!] ?? 0) + 1;
    // 「ブレインどおりに動いた」: AIX の判断→同じ AIX／AIX なしの判断→下書きを使った（そのまま・直して）
    const acted = xs.filter((x) => x.outcome !== "superseded" && x.outcome !== "no_action");
    const follow = acted.filter((x) => x.decision.suggested_action ? x.outcome === "aix_followed" : x.outcome === "draft_followed" || x.outcome === "draft_modified").length;
    return { scene, n: xs.length, followRate: rate(follow, acted.length), byOutcome: by };
  }).sort((a, b) => b.n - a.n);
}

/** 次に直す候補（届いていない所を手直しの件数順・型の上位を添える） */
export function nextCandidates(cells: ReadonlyArray<Cell & { area: string }>, limit = 10): Array<{ area: string; label: string; fixCount: number; untouchedRate: number | null; n: number; topKinds: string }> {
  return cells
    .filter((c) => !c.reached && c.fixCount > 0)
    .sort((a, b) => b.fixCount - a.fixCount)
    .slice(0, limit)
    .map((c) => ({ area: c.area, label: c.label, fixCount: c.fixCount, untouchedRate: c.untouchedRate, n: c.n, topKinds: c.kinds.slice(0, 3).map((k) => `${k.label}${k.count}`).join("・") }));
}

export const pct = (r: number | null | undefined) => (r == null ? "—" : `${Math.round(r * 100)}%`);
export { BRAIN_OUTCOME_JA };
