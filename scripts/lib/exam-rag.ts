// scripts/lib/exam-rag.ts — 試験の問題を「場面・言葉・効く部品・正解・前に落ちたか・関係する設計知見」で持ち、直した所に関係する問題だけを選ぶ（純関数）
//
// 2026-10-16 竹内「試験の問題をデータベースにためて RAG 検索で選ぶ・キャッシュが効く並べ方・比べる相手の答えに期限」＋「試験と設計知見（KB）を連動させる」
//   ・問題の札（ExamCard）: 場面（型・小場面・札）・言葉（お客様の今の発言＋直前のこちらの送信・伏せた物）・効く部品（段・入口のファイル・録音で見た名札）・
//     正解（竹内さんの実送信・伏せた物）・前に落ちたか（揺れの記録）・関係する知見の id（自動の候補＋直して通った時の固定の紐付け）。
//   ・選び方（selectProblems）: 直したファイルと差分の言葉の埋め込みの近さで上位 N 問＋必ず入れる問題（前に落ちた・新しい・変えた知見に紐付く・差分の言葉で当たった知見に紐付く）。
//     分からない時（差分が読めない・試験の道具や設定を直した・埋め込みが無い）は安全側＝全部。
//   ・並べ方（orderForCache）: 段（ブレインだけ／下書きまで）→ 前置きの印（録音で見たブレインの system と前の方の固定の塊の hash）→ 型 の順にまとめる。
//     答えは問題 id で束ねて比べる（perProblem・planBaseline・揺れの記録）＝並べ替えで比べの結果は変わらない。
//   ここは DB も fetch も LLM も持たない（埋め込み・読み書きは exam-rag-store.ts）。
import { createHash } from "node:crypto";

export type Vec = number[];
export type KbLinkKind = "auto" | "fixed";
export type KbLink = { kbId: string; kind: KbLinkKind; score: number; title?: string; decided?: string; at: string; note?: string };
/** 問題の札（DB の表 exam_problem_index の1行と同じ形。個人情報は入れない＝言葉・正解は伏せた物だけ・会話 id は hash） */
export type ExamCard = {
  id: string; specHash: string; type: string; sub: string; tags: string[];
  stage: "brain" | "draft";
  /** 言葉: お客様の今の発言（伏せた物・300字まで）＋直前のこちらの送信（伏せた物・200字まで） */
  words: string;
  /** 正解: 竹内さんの実送信（伏せた物・300字まで）と道（accept） */
  answer: string; accept: string[];
  /** 効く部品: 段の入口のファイルと、録音で見たこの問題の名札（brain_full・final_check_* 等） */
  parts: { files: string[]; actions: string[] };
  convHash: string; addedAt: string | null; source: "spec" | "takeuchi_send";
  embedding?: Vec | null; embeddingHash?: string | null;
};
/** 埋め込みに渡す文（場面・言葉・正解。文が変われば hash が変わり埋め直す） */
export function cardEmbeddingInput(c: Pick<ExamCard, "type" | "sub" | "tags" | "words" | "answer">): string {
  return [`場面: ${c.type}${c.sub ? `／${c.sub}` : ""}${c.tags.length ? `（${c.tags.join("・")}）` : ""}`, `言葉: ${c.words}`, `正解: ${c.answer}`].join("\n").slice(0, 3000);
}
export function hashText(s: string): string { return createHash("sha256").update(s).digest("hex").slice(0, 16); }

type ProblemLike = {
  id: string; type: string; sub?: string; tags?: string[]; customer?: string; staffText?: string; accept?: string[]; conv?: string; addedAt?: string; addedBy?: string;
  context?: Array<{ s: string; t: string; aix?: boolean }>; stage?: string;
};
/** 問題 → 札（mask は伏せる関数＝brain-exam-mask の maskExamText＋maskForEmbedding を呼ぶ側が渡す。純関数のまま試せるように） */
export function cardOfProblem(p: ProblemLike, o: { specHash: string; stage: "brain" | "draft"; mask: (s: string) => string; files: string[]; actions?: string[] }): ExamCard {
  const lastStaff = [...(p.context ?? [])].reverse().find((m) => m.s === "staff" && (m.t ?? "").trim())?.t ?? "";
  const words = `${o.mask(String(p.customer ?? "")).slice(0, 300)}${lastStaff ? `\n（直前のこちら）${o.mask(lastStaff).slice(0, 200)}` : ""}`;
  return {
    id: p.id, specHash: o.specHash, type: p.type, sub: String(p.sub ?? ""), tags: [...(p.tags ?? [])],
    stage: o.stage, words, answer: o.mask(String(p.staffText ?? "")).slice(0, 300), accept: [...(p.accept ?? [])],
    parts: { files: [...o.files], actions: [...new Set(o.actions ?? [])].sort() },
    convHash: p.conv ? hashText(`conv:${p.conv}`) : "", addedAt: p.addedAt ?? null,
    source: (p.tags ?? []).includes("お手本") ? "takeuchi_send" : "spec",
  };
}

export function cosine(a: Vec, b: Vec): number {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

// ─── 差分の言葉 ─────────────────────────────────────────────────────────
/** git diff の本文から、問いに使う言葉（足した・消した行のコメント・文字列・識別子）を取る。日本語の行を先に・長さの上限つき */
export function diffQueryText(diff: string, files: string[], max = 3000): string {
  const lines: string[] = [];
  for (const raw of diff.split("\n")) {
    if (!/^[+-]/.test(raw) || /^(?:\+\+\+|---)/.test(raw)) continue;
    const t = raw.slice(1).trim();
    if (t.length < 4) continue;
    lines.push(t);
  }
  const jp = lines.filter((l) => /[ぁ-んァ-ヶ一-龠]/.test(l));
  const rest = lines.filter((l) => !/[ぁ-んァ-ヶ一-龠]/.test(l));
  const head = `直したファイル: ${files.join(" ")}`;
  const body = [...new Set([...jp, ...rest])].join("\n");
  return `${head}\n${body}`.slice(0, max);
}

// ─── 設計知見の変化 ─────────────────────────────────────────────────────
export type KbSnapshot = { at: string; rows: Record<string, string> };
export type KbChange = { id: string; kind: "new" | "changed" | "retired" };
/** 前の控え（id → 文の hash）と今の現行の行を比べる。控えが無い（初回）は変化なしとして扱う（全部を「新しい」にしない） */
export function kbChanges(prev: KbSnapshot | null, now: Record<string, string>): KbChange[] {
  if (!prev) return [];
  const out: KbChange[] = [];
  for (const [id, h] of Object.entries(now)) { if (!(id in prev.rows)) out.push({ id, kind: "new" }); else if (prev.rows[id] !== h) out.push({ id, kind: "changed" }); }
  for (const id of Object.keys(prev.rows)) if (!(id in now)) out.push({ id, kind: "retired" });
  return out;
}

// ─── 選び方 ─────────────────────────────────────────────────────────────
export type SelectInput = {
  cards: ExamCard[];
  /** 差分の言葉の埋め込み（無い＝分からない） */
  queryVec: Vec | null;
  /** 差分の段の分け方（exam-scope.decideStageFromDiff の cls と、安全側に倒す理由） */
  changeClass: "brain" | "draft" | "both" | "none" | null;
  /** 全部にする理由（試験の道具・設定・差分が読めない 等）。あれば全部 */
  allReason?: string | null;
  /** 前に落ちた問題（揺れの記録に ✕ がある・前の回で不合格） */
  failedBefore: Set<string>;
  /** 新しい問題（まだ一度も回していない・足して N 日以内） */
  fresh: Set<string>;
  /** 問題 → 知見の紐付け */
  links: Record<string, KbLink[]>;
  /** 変わった・入れた・退役した知見 id（kbChanges） */
  changedKb: KbChange[];
  /** 差分の言葉で KB を引いて当たった知見 id（上位） */
  kbHits: Array<{ id: string; score: number; title?: string }>;
  /** 新しい知見の埋め込みと問題の近さで足す問題（kbId → 問題 id と近さ）。紐付けが無い新しい知見の分 */
  kbNearProblems?: Record<string, Array<{ id: string; sim: number }>>;
  /** 差分・言葉・commit の文で名指しされた問題 id */
  mentioned?: string[];
  topN: number;
  /** 近さの下限（これ未満は上位 N でも入れない） */
  minSim?: number;
};
export type Selected = { id: string; why: string[]; sim: number | null; must: boolean };
export type SelectResult = { mode: "all" | "rag"; picked: Selected[]; skipped: number; note: string };

const short = (id: string) => id.slice(0, 8);
export function selectProblems(i: SelectInput): SelectResult {
  const all = (why: string): SelectResult => ({ mode: "all", picked: i.cards.map((c) => ({ id: c.id, why: [why], sim: null, must: true })), skipped: 0, note: why });
  if (i.allReason) return all(`安全側で全部: ${i.allReason}`);
  if (!i.cards.length) return { mode: "rag", picked: [], skipped: 0, note: "問題が無い" };
  if (!i.queryVec && i.changeClass !== "none") return all("安全側で全部: 差分の言葉の埋め込みが無い");
  const noEmb = i.cards.filter((c) => !c.embedding?.length);
  if (noEmb.length * 2 > i.cards.length) return all(`安全側で全部: 埋め込みの無い問題が半分を超える（${noEmb.length}/${i.cards.length}・exam-rag.ts --index で作る）`);

  // 下書きだけの変更はブレインだけの問題に効かない（試験の下書きはブレインの答えを固定して流す）。両方・ブレインは全部の問題が対象
  const eligible = i.changeClass === "draft" ? i.cards.filter((c) => c.stage === "draft") : i.cards;
  const why = new Map<string, string[]>();
  const add = (id: string, w: string) => { if (!eligible.some((c) => c.id === id)) return; why.set(id, [...(why.get(id) ?? []), w]); };
  for (const c of eligible) {
    if (i.failedBefore.has(c.id)) add(c.id, "前に落ちた");
    if (i.fresh.has(c.id)) add(c.id, "新しい問題（まだ回していない）");
    if (!c.embedding?.length) add(c.id, "埋め込みが無い（安全側で入れる）");
  }
  // 知見の変化 → 紐付いた問題
  const changedIds = new Map(i.changedKb.map((k) => [k.id, k.kind]));
  const hitIds = new Map(i.kbHits.map((h) => [h.id, h]));
  const kindJa = { new: "入れた", changed: "変えた", retired: "退役した" } as const;
  for (const c of eligible) {
    for (const l of i.links[c.id] ?? []) {
      const k = changedIds.get(l.kbId);
      if (k) add(c.id, `知見 ${short(l.kbId)} を${kindJa[k]}（${l.kind === "fixed" ? "直して通った紐付け" : "近い知見"}）`);
      const h = hitIds.get(l.kbId);
      if (h) add(c.id, `差分の言葉で当たった知見 ${short(l.kbId)}${h.title ? `「${h.title.slice(0, 24)}」` : ""}に紐付く`);
    }
  }
  for (const [kbId, ps] of Object.entries(i.kbNearProblems ?? {})) for (const p of ps) add(p.id, `${changedIds.has(kbId) ? "新しい" : "差分で当たった"}知見 ${short(kbId)} に近い（${p.sim.toFixed(2)}）`);
  for (const id of i.mentioned ?? []) add(id, "差分・言葉で名指し");

  // 近さの上位 N
  const minSim = i.minSim ?? 0.2;
  const sims = new Map<string, number>();
  if (i.queryVec && i.changeClass !== "none") for (const c of eligible) if (c.embedding?.length) sims.set(c.id, cosine(i.queryVec, c.embedding));
  const ranked = [...sims].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let n = 0;
  for (const [id, s] of ranked) {
    if (n >= i.topN) break;
    if (s < minSim) break;
    if (!why.has(id)) { why.set(id, [`差分の言葉に近い（${s.toFixed(3)}・上位 ${n + 1}）`]); n++; }
    else { why.get(id)!.push(`差分の言葉に近い（${s.toFixed(3)}）`); }
  }
  const picked: Selected[] = i.cards.filter((c) => why.has(c.id)).map((c) => ({ id: c.id, why: why.get(c.id)!, sim: sims.get(c.id) ?? null, must: why.get(c.id)!.some((w) => !w.startsWith("差分の言葉に近い")) }));
  const note = i.changeClass === "none" ? "試験に効く変更なし → 必ず入れる問題だけ" : i.changeClass === "draft" ? "下書きだけの変更 → 下書きまでの問題から選ぶ" : "";
  return { mode: "rag", picked, skipped: i.cards.length - picked.length, note };
}

// ─── 並べ方（キャッシュ） ───────────────────────────────────────────────
/**
 * 前置き（system・知識の塊）が同じ問題を続けて流す: 段 → 前置きの印 → 型 → 元の順。
 *   段: ブレインだけの問題をまとめ、下書きまでの問題を後ろにまとめる（generate-reply・最終チェックの前置きが5分の切れの内に続く）。
 *   前置きの印は録音から（無ければ型だけ）。並べ替えは安定（同じ印の中は元の順）。
 */
export function orderForCache<P extends { id: string; type: string }>(ps: P[], o: { stageOf: (p: P) => "brain" | "draft"; prefixOf?: (id: string) => string | null; convOf?: (p: P) => string | null; lenOf?: (p: P) => number }): P[] {
  const idx = new Map(ps.map((p, k) => [p.id, k]));
  const firstSeen = new Map<string, number>();
  const pref = (p: P) => o.prefixOf?.(p.id) ?? (o.convOf ? "" : `型:${p.type}`);
  for (const p of ps) { const k = pref(p); if (!firstSeen.has(k)) firstSeen.set(k, idx.get(p.id)!); }
  const typeSeen = new Map<string, number>();
  for (const p of ps) if (!typeSeen.has(p.type)) typeSeen.set(p.type, idx.get(p.id)!);
  // 2026-10-21 ④ 同じ元の会話の問題を続けて流す（会話の前置き・判断の手本の除き方＝要求の前の方が同じ＝キャッシュに当たる）。会話の中は短い履歴から
  const convSeen = new Map<string, number>();
  if (o.convOf) for (const p of ps) { const c = o.convOf(p); if (c && !convSeen.has(c)) convSeen.set(c, idx.get(p.id)!); }
  return [...ps].sort((a, b) => {
    const sa = o.stageOf(a) === "brain" ? 0 : 1, sb = o.stageOf(b) === "brain" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const pa = firstSeen.get(pref(a))!, pb = firstSeen.get(pref(b))!;
    if (pa !== pb) return pa - pb;
    if (o.convOf) {
      const ca = o.convOf(a), cb = o.convOf(b);
      const ka = ca ? convSeen.get(ca)! : idx.get(a.id)!, kb = cb ? convSeen.get(cb)! : idx.get(b.id)!;
      if (ka !== kb) return ka - kb;
      if (ca && ca === cb && o.lenOf) { const d = o.lenOf(a) - o.lenOf(b); if (d) return d; }
      return idx.get(a.id)! - idx.get(b.id)!;
    }
    const ta = typeSeen.get(a.type)!, tb = typeSeen.get(b.type)!;
    if (ta !== tb) return ta - tb;
    return idx.get(a.id)! - idx.get(b.id)!;
  });
}
/** 録音の要求本文から前置きの印を作る: system（全部）と、最初の user の中の固定の塊（cache_control の付いた塊まで）。無ければ system だけ */
export function prefixKeyOfBody(normBody: string): string | null {
  let b: { system?: unknown; messages?: Array<{ role: string; content: unknown }> };
  try { b = JSON.parse(normBody); } catch { return null; }
  const parts: unknown[] = [];
  if (b.system !== undefined) parts.push(b.system);
  for (const m of b.messages ?? []) {
    if (m.role === "system") { parts.push(m.content); continue; }
    if (Array.isArray(m.content)) {
      const blocks = m.content as Array<{ cache_control?: unknown }>;
      const last = blocks.map((x, k) => (x?.cache_control ? k : -1)).reduce((a, k) => Math.max(a, k), -1);
      if (last >= 0) parts.push(blocks.slice(0, last + 1));
    }
    break;
  }
  if (!parts.length) return null;
  return hashText(JSON.stringify(parts)).slice(0, 10);
}

// ─── 落ちた時に出す知見 ─────────────────────────────────────────────────
/** 問題に紐付く知見を、固定（直して通った）→ 近さの順に上位 k */
export function topLinks(links: KbLink[] | undefined, k = 3): KbLink[] {
  return [...(links ?? [])].sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "fixed" ? -1 : 1)).slice(0, k);
}
export function formatLinks(links: KbLink[]): string {
  return links.map((l) => `${short(l.kbId)}${l.kind === "fixed" ? "［直して通った］" : `（近さ ${l.score.toFixed(2)}）`} ${(l.title ?? "").slice(0, 50)}${l.decided ? ` — ${l.decided.slice(0, 60)}` : ""}`).join("\n      ");
}
/** 自動の候補を入れ替える（固定の紐付けは残す・同じ知見は固定を優先） */
export function mergeAutoLinks(cur: KbLink[] | undefined, auto: KbLink[]): KbLink[] {
  const fixed = (cur ?? []).filter((l) => l.kind === "fixed");
  const fixedIds = new Set(fixed.map((l) => l.kbId));
  return [...fixed, ...auto.filter((l) => !fixedIds.has(l.kbId))];
}
export function addFixedLink(cur: KbLink[] | undefined, l: Omit<KbLink, "kind">): KbLink[] {
  return [{ ...l, kind: "fixed" as const }, ...(cur ?? []).filter((x) => x.kbId !== l.kbId)];
}
