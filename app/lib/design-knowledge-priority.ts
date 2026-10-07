// app/lib/design-knowledge-priority.ts — 設計知見（system_design_thinking）の「段」（優先順位）の決まり（純関数・DB も LLM も触らない）
//
// 2026-10-07 竹内「設計知見もちゃんと整理して優先順位あげれる環境もつくる　そうすれば質が良くなるから」
//   問題: 絶対の決まり・今の決まり・参考・古い事例が同じ重みで RAG に出ていた（1,480行の現行に段が無い）。
//   段（priority smallint・小さいほど強い）:
//     P0 絶対・最優先 … 竹内さんの「絶対的な考え方」（札「絶対・最優先」の行だけ・竹内さんが決める）。場面に関係なく、関係する問いでは必ず先頭に出す
//     P1 今の決まり   … 今有効な竹内さんの決定・決まり・原則（「竹内さんの決定／承認／指示／訂正」・札「分析強化の原則」・整理が見張る決定の行）
//     P2 実装の知見   … 実装の型・汎用の点検表・診断・設計の判断（既定）
//     P3 事例・経緯   … 1件の事例・調べた経緯・実測の記録（参考。新しい決まりの根拠にはなるが、それ自体は決まりではない）
//   決め方: 決定論の目印が先（確かな物）→ 目印で言い切れない行だけ DeepSeek で P1/P2/P3 を分ける（P0 は LLM に付けさせない）→ 食い違いは要確認へ。
//   列が無い時（本番に ALTER を流す前）・null の行は inferPriority の値で並べる（後ろ互換）。
// design-knowledge-curation.ts が段を読むので、こちらから curation を import しない（循環を作らない）
function normKb(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　、。・,.!！?？「」『』()（）【】\[\]—\-–:：;；"'`]/g, "");
}

export type KbPriority = 0 | 1 | 2 | 3;
export const PRIORITY_LABEL: Record<KbPriority, string> = { 0: "P0 絶対・最優先", 1: "P1 今の決まり", 2: "P2 実装の知見", 3: "P3 事例・経緯" };
export const P0_TAG = "絶対・最優先";

export type PrioRow = {
  id?: string;
  title: string;
  insight: string;
  context?: string | null;
  rationale?: string | null;
  tags?: string[] | null;
  priority?: number | null;
  created_at?: string;
};

/** 竹内さんの決定の目印（本文・状況に「竹内さんの決定／承認／指示／訂正／了承」）。引用だけ（竹内「…」）は決定とは限らない＝目印にしない */
export const OWNER_DECISION_RE = /竹内(さん)?の?(決定|承認|指示|訂正|了承)|竹内さん(が)?(承認|決定|了承)|（\d{1,2}\/\d{1,2}\s*竹内さん(承認|決定|指示)）/;
/** 竹内さんの言葉の引用（決定かどうかは LLM に聞く手がかり） */
export const OWNER_QUOTE_RE = /竹内(さん)?[「『（]/;
/** 事例・経緯の題 */
export const CASE_TITLE_RE = /事例|経緯|振り返り|の記録$|実測の記録|調査メモ|のログ$/;
/** P1 の札（竹内さんの原則） */
export const P1_TAGS = ["分析強化の原則"];
/** P2 を示す札（型・点検表は事例の題でも P3 にしない） */
export const P2_TAGS = ["汎用", "点検表"];

export type PriorityGuess = { priority: KbPriority; reason: string; certain: boolean };

/**
 * 決定論の推定。certain=true は目印で言い切れる物（LLM に聞かない）。
 *   isDecisionRow＝整理の DECISIONS の決定の行（design-knowledge-curation.ts decisionRow）
 */
export function inferPriority(r: PrioRow, opts: { isDecisionRow?: boolean } = {}): PriorityGuess {
  const tags = r.tags ?? [];
  const body = `${r.insight ?? ""}\n${r.context ?? ""}`;
  if (tags.includes(P0_TAG)) return { priority: 0, reason: `札「${P0_TAG}」`, certain: true };
  if (opts.isDecisionRow) return { priority: 1, reason: "整理が見張る竹内さんの決定の行", certain: true };
  if (tags.some((t) => P1_TAGS.includes(t))) return { priority: 1, reason: "札「分析強化の原則」", certain: true };
  if (OWNER_DECISION_RE.test(body)) return { priority: 1, reason: "竹内さんの決定・承認・指示・訂正の目印", certain: true };
  const generic = tags.some((t) => P2_TAGS.includes(t)) || /^【汎用】/.test(r.title);
  if (CASE_TITLE_RE.test(r.title) && !generic) return { priority: 3, reason: "題が事例・経緯", certain: false };
  if (generic) return { priority: 2, reason: "札「汎用」「点検表」（型）", certain: false };
  return { priority: 2, reason: "既定（実装の知見）", certain: false };
}

/** 並べる時の段（列の値があればそれ・無ければ決定論の推定） */
export function effectivePriority(r: PrioRow): KbPriority {
  const p = r.priority;
  if (p === 0 || p === 1 || p === 2 || p === 3) return p;
  return inferPriority(r).priority;
}

/** 段の点（hybridRank に足す。重みは scripts/kb-scene-rag-eval.ts・kb-rag-eval.ts の格子で決めた値） */
// 2026-10-07 当て直し（DeepSeek で付けた段の計画を載せて4つの問いの組 計81問で測った・recall@5）:
//   段なし 74/81 → P1 +0.05 で 76/81（一般24: 20→21・一般holdout12: 11→12・場面33: 32→33・場面holdout12: 11→10＝「家賃に管理費込みか」の正解（P3 の事例行）が 0.02 差の同点で6位へ）
//   P1 +0.1 は 75/81・+0.2 は 69/81。P3 に −0.05〜−0.2 を付けると場面holdout が 0.83〜0.58 に落ちた＝この表の「事例」の行は返信の直しの教訓を持っている（下げない）
//   P0 は点では上げない分も含め、問いに関係すれば splitPinned の別枠で先頭（上位 k の席を奪わない）
export const PRIORITY_BOOST: Record<KbPriority, number> = { 0: 0.05, 1: 0.05, 2: 0, 3: 0 };
export function priorityBoost(r: PrioRow, scale = 1): number {
  return PRIORITY_BOOST[effectivePriority(r)] * scale;
}

/**
 * P0 を別枠で先頭に出すか。
 *   返信の場面（--scene）を付けた問い＝返信の作業そのもの → P0（返信／AIX／ブレインの全作業に適用）は必ず出す
 *   場面なしの問い → 関係する時だけ: P0 の行との埋め込みの近さ（全件比較の生の値）0.40 以上か、問いの語が題・本文に 0.40 以上
 *   2026-10-07 実測（P0 2行 × 24問）: 関係する問い「AIX と返信の分け方」0.75・「返信のズレの直し方」0.61・「AIXの確認しますは使うのか」0.55・
 *     「管理会社に確認した事を返信に書いた」0.42／関係ない問い「pgvector の索引」0.00・「Chrome拡張が固まった」0.21・「プロンプトキャッシュの分け方」0.32
 */
export const P0_PIN = { minSim: 0.4, minKeyword: 0.4, max: 3 } as const;
export function isP0Relevant(raw: number, keyword: number): boolean {
  return raw >= P0_PIN.minSim || keyword >= P0_PIN.minKeyword;
}

// ── DeepSeek で P1/P2/P3 を分ける（目印で言い切れない行だけ）──
export const PRIORITY_SYSTEM = [
  "あなたは社内の設計メモ（不動産仲介の LINE 返信 AI・物件検索ツールの開発メモ）の整理係です。各メモを次の3段のどれかに分け、JSON だけで答えてください。",
  "P1＝今有効な『決まり』: オーナー（竹内さん）が決めた業務の決まり・お客様への返し方・AIX の使い方・やってはいけない事・原則（『〜は〜する』『〜しない』と言い切る物）。",
  "P2＝実装の知見: コード・プロンプト・DB・RAG・キャッシュ・テストの型、点検表、不具合の見つけ方、設計の判断（他でも使える物を含む）。",
  "P3＝事例・経緯: 特定の1件の会話・1回の調査・実測の記録・バグを直した経緯（それ自体は今の決まりではない参考）。",
  "迷ったら P2。オーナーの言葉の引用があっても、中身が実装の工夫なら P2・1件の経緯なら P3。",
  '形: {"items":[{"n":番号,"p":1か2か3,"why":"20字以内"}]}',
].join("\n");

export function priorityPromptBatch(rows: Array<{ n: number; title: string; insight: string; ownerQuote: boolean; ownerDecision: boolean }>, mask: (s: string) => string): string {
  return rows.map((r) => `[${r.n}] 題: ${mask(r.title).slice(0, 200)}\n本文: ${mask(r.insight).replace(/\s+/g, " ").slice(0, 380)}\n目印: ${r.ownerDecision ? "オーナーの決定の言葉あり" : r.ownerQuote ? "オーナーの言葉の引用あり" : "なし"}`).join("\n\n");
}

export function parsePriorityBatch(text: string): Map<number, { p: 1 | 2 | 3; why: string }> {
  const out = new Map<number, { p: 1 | 2 | 3; why: string }>();
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return out;
  try {
    const j = JSON.parse(m[0]) as { items?: Array<{ n?: number; p?: number | string; why?: string }> };
    for (const it of j.items ?? []) {
      const n = Number(it.n), p = Number(String(it.p ?? "").replace(/^P/i, ""));
      if (!Number.isFinite(n) || ![1, 2, 3].includes(p)) continue;
      out.set(n, { p: p as 1 | 2 | 3, why: String(it.why ?? "").slice(0, 40) });
    }
  } catch { /* 読めない返事は空 */ }
  return out;
}

export type PriorityDecision = { id: string; priority: KbPriority; source: "rule" | "llm" | "fallback"; reason: string; review?: string };
/**
 * 決定論と LLM を合わせる。
 *   確かな目印（P0・決定の行・原則・決定の言葉）→ そのまま
 *   LLM が答えた → LLM の段。ただし食い違い（目印なしで P1・汎用の札で P3）は要確認に印
 *   LLM が答えない → 決定論の推定
 */
export function mergePriority(id: string, guess: PriorityGuess, llm: { p: 1 | 2 | 3; why: string } | null | undefined, r: PrioRow): PriorityDecision {
  if (guess.certain) return { id, priority: guess.priority, source: "rule", reason: guess.reason };
  if (!llm) return { id, priority: guess.priority, source: "fallback", reason: guess.reason };
  const body = `${r.insight ?? ""}\n${r.context ?? ""}`;
  let review: string | undefined;
  // 札が汎用・点検表（型）の行は事例に下げない（2026-10-07 実測: DeepSeek が汎用の 97行を P3 と読んだ＝実測の数字が入った型を事例と取る）→ P2 のまま・要確認に
  if (llm.p === 3 && (r.tags ?? []).some((t) => P2_TAGS.includes(t))) return { id, priority: 2, source: "llm", reason: `${llm.why || "DeepSeek"}（汎用の札で P2 に留めた）`, review: "札は汎用・点検表なのに DeepSeek は P3（事例）と読んだ — P2 のまま" };
  if (llm.p === 1 && !OWNER_QUOTE_RE.test(body)) review = "竹内さんの言葉が無いのに P1（決まり）と読まれた";
  else if (llm.p !== 3 && guess.priority === 3) review = "題は事例・経緯なのに LLM は P" + llm.p;
  return { id, priority: llm.p, source: "llm", reason: llm.why || "DeepSeek", review };
}

// ── 段の見張り（毎週）──
export const PRIORITY_WATCH = { p0Max: 5, p1MaxShare: 0.3 } as const;
export function priorityWatch(rows: PrioRow[]): { counts: Record<KbPriority, number>; warnings: string[]; fixes: Array<{ id: string; priority: KbPriority; reason: string }>; review: Array<{ id: string; note: string }> } {
  const counts: Record<KbPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const warnings: string[] = [];
  const fixes: Array<{ id: string; priority: KbPriority; reason: string }> = [];
  const review: Array<{ id: string; note: string }> = [];
  for (const r of rows) {
    const p = effectivePriority(r);
    counts[p]++;
    const hasP0Tag = (r.tags ?? []).includes(P0_TAG);
    // 札と列が食い違う: 札「絶対・最優先」があるのに P0 でない → 直す（札が竹内さんの決定）
    if (hasP0Tag && r.priority != null && r.priority !== 0 && r.id) fixes.push({ id: r.id, priority: 0, reason: `札「${P0_TAG}」があるのに P${r.priority}` });
    // 札が無いのに P0 → 勝手に下げない（要確認）
    if (!hasP0Tag && r.priority === 0 && r.id) review.push({ id: r.id, note: `P0 なのに札「${P0_TAG}」が無い（竹内さんが P0 にしたなら札を足す・違えば P1 へ）` });
    // 列が空 → 決定論の推定を書く（確かな物だけ）
    if (r.priority == null && r.id) { const g = inferPriority(r); if (g.certain) fixes.push({ id: r.id, priority: g.priority, reason: `段が空 → ${g.reason}` }); }
  }
  const n = rows.length || 1;
  if (counts[0] > PRIORITY_WATCH.p0Max) warnings.push(`P0 が ${counts[0]}行（線 ${PRIORITY_WATCH.p0Max}）— 絶対・最優先が増えすぎ。竹内さんに絞ってもらう`);
  if (counts[1] / n > PRIORITY_WATCH.p1MaxShare) warnings.push(`P1 が ${counts[1]}行・${Math.round((counts[1] / n) * 100)}%（線 ${Math.round(PRIORITY_WATCH.p1MaxShare * 100)}%）— 決まりが増えすぎ。古い決まりの退役か P2/P3 への付け直しを`);
  return { counts, warnings, fixes, review };
}

// ── 札の正規化（CLAUDE.md「タグの書き方」・2026-09-17 の正規化に合わせる）──
//   略語・モデル名・サービス名は決まった表記、概念は日本語。言い切れる表記ゆれだけ（意味が変わる置き換えはしない）
export const TAG_CANON: Record<string, string> = {
  aix: "AIX", rag: "RAG", tpo: "TPO", ocr: "OCR", "aix-meta": "AIX-META", haiku: "Haiku", sonnet: "Sonnet", vision: "Vision",
  deepseek: "DeepSeek", supabase: "Supabase", itandi: "ITANDI", vercel: "Vercel", ux: "UX", yuma: "YUMA",
  audit: "監査", scoring: "採点", greeting: "挨拶", estimate: "見積書", viewing: "内覧", brain: "ブレイン", image: "画像", images: "画像",
  promise: "約束", cost: "費用", "property-check": "物件確認", property_check: "物件確認", "prompt-cache": "プロンプトキャッシュ", prompt_cache: "プロンプトキャッシュ",
  汎用パターン: "汎用", 絶対最優先: "絶対・最優先",
};
export const TAG_MAX = 8;
export function canonTag(t: string): string {
  const s = String(t ?? "").trim();
  return TAG_CANON[s] ?? TAG_CANON[s.toLowerCase()] ?? TAG_CANON[normKb(s)] ?? s;
}
/** 札を正規化（表記ゆれを直し・重複と空を除く・順は保つ）。changed＝変わったか */
export function normalizeTags(tags: string[] | null | undefined): { tags: string[]; changed: boolean } {
  const src = (tags ?? []).map((t) => String(t ?? ""));
  const out: string[] = [];
  for (const t of src) { const c = canonTag(t); if (c && !out.includes(c)) out.push(c); }
  const changed = out.length !== src.length || out.some((t, i) => t !== src[i]);
  return { tags: out, changed };
}
