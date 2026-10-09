// app/lib/design-knowledge-rag.ts — 設計知見の RAG（自然文の問いで引く）の決まり（純関数・DB も API も触らない）
//
// 2026-10-06 竹内「設計知見ひっぱるときRAG検索いれたらどうか 設計知見かなり重要になっていく 改善するにあたって」（⑯）。
//   旧の引き方は札（tags）と SQL の部分一致だけ。自然文の問い（「待ち合わせ場所はどう決める」）は語が行の文と一字一句一致しないと当たらない。
//   → 埋め込み（text-embedding-3-small・題＋本文＋根拠＋札）の近さ＋語の重なり（題を重く）＋札＋新しさ を足した点で並べる（hybridRank）。
//   退役した行（is_current=false）は出さない。点が並んだら竹内さんの言葉がある行（決定）を上に。
import { grams, jaccard, normKb } from "@/app/lib/design-knowledge-curation";
import { effectivePriority, isP0Relevant, P0_PIN, PRIORITY_BOOST, type KbPriority } from "@/app/lib/design-knowledge-priority";

export type RagRow = {
  id: string;
  title: string;
  insight: string;
  rationale?: string | null;
  context?: string | null;
  tags?: string[] | null;
  is_current: boolean;
  created_at: string;
  /** 段（0＝絶対・最優先〜3＝事例・経緯・design-knowledge-priority.ts）。列が無い・null の時は決定論の推定で並べる */
  priority?: number | null;
};

/** 埋め込みに入れる文（題＋本文＋根拠＋札）。8k トークンの上限に余裕を持って 4,000字で切る */
export const EMBED_MAX_CHARS = 4000;
export function kbEmbeddingInput(r: Pick<RagRow, "title" | "insight" | "rationale" | "tags">): string {
  const tags = (r.tags ?? []).filter(Boolean).join("・");
  return [r.title, r.insight, r.rationale ?? "", tags ? `札: ${tags}` : ""].filter(Boolean).join("\n").slice(0, EMBED_MAX_CHARS);
}
/** 文の指紋（埋め直しの判定用・FNV-1a 32bit を2回＝衝突は実用上起きない長さ） */
export function textHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 31), 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + ":" + s.length;
}
/** 埋め直しが要るか（まだ無い・文が変わった） */
export function needsEmbedding(r: RagRow & { embedding_hash?: string | null }): boolean {
  return r.is_current && r.embedding_hash !== textHash(kbEmbeddingInput(r));
}

// 問いの語: 助詞・よくある語を除いた2文字組で見る（日本語は空白で切れないため）
const STOP = /(?:は|が|を|に|で|と|の|も|へ|や|か|って|する|した|して|ます|です|どう|なぜ|何|いつ|どこ|ため|こと|もの|ような|られ|れる|たら|ない|ある|いる|なる|から|まで|より|よう|決め|方法)/g;
// 2026-10-08 同義・表記ゆれの辞書（竹内「ちゃんと RAG で正確に確かめられるようにする」）: 問いと行の両方を同じ形に寄せてから語を比べる（語の点だけ・埋め込みには使わない）。
//   normKb の後（小文字・記号なし）の形で書く。意味が変わる寄せはしない（例: 物件確認した≠確認した・従業員≠竹内さん・新着≠ピックアップ）。
//   足す時は scripts/kb-eval.ts で前後を測る（holdout が下がる寄せは入れない）
export const KB_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/内見/g, "内覧"],
  [/(?:御|お)?見積(?:もり|り)?書?/g, "見積"],
  [/お?申し?込み?/g, "申込"],
  [/いただ/g, "頂"],
  [/下さい/g, "ください"],
  [/おすすめ|お勧め|お薦め|おススメ/g, "オススメ"],
  [/(?:もっと|さらに|これ以上)(?=安)/g, "更に"],
  [/お客さん|顧客/g, "お客様"],
  [/返事/g, "返信"],
  [/集合場所/g, "待ち合わせ場所"],
  [/押さえ/g, "抑え"],
  [/敷金礼金|敷金・礼金/g, "敷礼"],
  [/問い?合わ?せ/g, "問合せ"],
  [/星(?!の絵文字)/g, "🌟"],
  [/内覧前の挨拶|内覧当日の挨拶|当日の挨拶/g, "内覧挨拶"],
];
export function synKb(n: string): string {
  let s = n;
  for (const [re, to] of KB_SYNONYMS) s = s.replace(re, to);
  return s;
}
const synMemo = new WeakMap<object, { t?: string; b?: string }>();
function synCached(r: RagRow, k: "t" | "b", text: string): string {
  let m = synMemo.get(r);
  if (!m) { m = {}; synMemo.set(r, m); }
  return (m[k] ??= synKb(normKb(text)));
}
export function queryGrams(q: string, opts: { syn?: boolean } = {}): Set<string> {
  const n = (opts.syn ? synKb(normKb(q)) : normKb(q)).replace(STOP, "|");
  const g = new Set<string>();
  for (const part of n.split("|")) for (let i = 0; i + 2 <= part.length; i++) g.add(part.slice(i, i + 2));
  return g;
}
/** 語の重なり（問いの2文字組のうち、題に何割・本文に何割あるか。題を重く） */
export function keywordScore(r: RagRow, qg: Set<string>, opts: { syn?: boolean } = {}): number {
  if (!qg.size) return 0;
  const t = opts.syn ? synCached(r, "t", r.title) : normKb(r.title), b = opts.syn ? synCached(r, "b", r.insight) : normKb(r.insight);
  let inT = 0, inB = 0;
  for (const x of qg) { if (t.includes(x)) inT++; else if (b.includes(x)) inB++; }
  return (inT * 1.0 + inB * 0.5) / qg.size;
}
/**
 * 2026-10-08 句の当たり: 問いを助詞で切った句（3字以上）が題・本文にそのまま入っているか（字数の重みで 0〜1・題は 1・本文は 0.5）。
 *   並びの点に足すと全体が下がった（kb-eval: 句 0.3〜1.0 で recall@5 0.95→0.92〜0.95・MRR 0.86→0.82〜0.85）＝並びには入れず、
 *   上位 k の外で本文にそのまま句がある行を「本文の一節で当たった行」として別に出す（phraseSupplement・長い決定の行の奥の一節を拾う）
 */
export function queryPhrases(q: string, opts: { syn?: boolean } = {}): string[] {
  const n = (opts.syn ? synKb(normKb(q)) : normKb(q)).replace(STOP, "|");
  return [...new Set(n.split("|").filter((x) => x.length >= 3))];
}
export function phraseScore(r: RagRow, phrases: string[], opts: { syn?: boolean } = {}): number {
  if (!phrases.length) return 0;
  const t = opts.syn ? synCached(r, "t", r.title) : normKb(r.title), b = opts.syn ? synCached(r, "b", r.insight) : normKb(r.insight);
  let hit = 0, all = 0;
  for (const p of phrases) { all += p.length; if (t.includes(p)) hit += p.length; else if (b.includes(p)) hit += p.length * 0.5; }
  return all ? hit / all : 0;
}
/** 札の当たり（問いの文に札の語がそのまま入っている・または指定の札） */
export function tagScore(r: RagRow, q: string, wantTags: string[] = []): number {
  const nq = normKb(q);
  let s = 0;
  for (const t of r.tags ?? []) {
    const nt = normKb(t);
    if (!nt || nt.length < 2) continue;
    if (wantTags.some((w) => normKb(w) === nt)) s += 1;
    else if (nq.includes(nt)) s += 0.5;
  }
  return Math.min(1, s);
}
/** 新しさ（0〜1・半減 60日） */
export function recencyScore(createdAt: string, nowIso: string): number {
  const days = Math.max(0, (Date.parse(nowIso) - Date.parse(createdAt)) / 86400e3);
  return Math.pow(0.5, days / 60);
}
/** 竹内さんの言葉がある行（決定） */
export function isOwnerWords(r: RagRow): boolean {
  return /竹内(さん)?[「『（]|竹内さんの(決定|指示|訂正)/.test(r.insight + "\n" + (r.context ?? ""));
}

/** 重み（scripts/kb-rag-eval.ts で当て直して決めた値・変える時は評価を回し直す） */
// 2026-10-06 当て直し（問い24・格子）: 近さだけ recall@5 0.79 → keyword 0.5・tag 0.3・recency 0.15 で 0.88（別の問い12で確かめた・scripts/kb-rag-eval.ts）
// 2026-10-07 竹内「設計知見もちゃんと整理して優先順位あげれる環境」: priority＝段の点（PRIORITY_BOOST）の掛け率。0 で段を効かせない（前と同じ並び）
// 2026-10-08 当て直し（scripts/kb-eval.ts・新しい物差し 194問＋前の物差し 78問・手元で全行の近さを計算した格子）:
//   近さを 0 にそろえる線を「上位 80 番目」→「上位 1,000 番目」（KB_VEC_FETCH）にし、keyword 0.5→1.0・tag 0.3→0.15・同義の辞書 on・場面は札のある行は札だけ（sceneTagOnly）。
//   新しい物差し recall@5 0.90→0.95・MRR 0.79→0.86（holdout 0.85→0.91・0.76→0.80）／前の物差し 0.94→0.97・0.74→0.82。
//   上位 80 だと長い決定の行（本文が複数の話題）の近さが 80 番目より下で 0 になり、語が全部当たっても上がらなかった（例「🌟が同点の時の決め方」は語 1.00 で 24位）。
//   埋め込みの文を「題＋札＋本文の頭 600字」や「題だけ」にする案は下がった（同じ格子で MRR 0.85・0.83）＝埋め込みの文は今のまま
export const HYBRID_WEIGHTS = { vector: 1.0, keyword: 1.0, tag: 0.15, recency: 0.15, ownerTie: 0.01, priority: 1.0 } as const;
/** 近さを取る数（RPC match_design_thinking_exact の match_count・PostgREST の上限 1,000）。並びの近さは「この中の最小〜最大」で 0〜1 にそろえる */
export const KB_VEC_FETCH = 1000;
/** 場面の行に足す点（scripts/kb-scene-rag-eval.ts の格子で決める） */
// 10/07 当て直し（scripts/kb-scene-rag-eval.ts）: 問い33 recall@5 0.73→0.94・別の問い12 0.75→0.92（0.3 は 0.91/0.75・0.8 は holdout 同じ）
export const SCENE_WEIGHT = 0.5;
export type Scored = { row: RagRow; score: number; vector: number; keyword: number; tag: number; recency: number; raw?: number; priority?: KbPriority; pinned?: boolean };
/**
 * 並べる。vecSim＝id→埋め込みの近さ（0〜1・無い行は 0）。近さは候補の中の最小〜最大で 0〜1 にそろえる（問いごとに近さの幅が違うため）
 *   mode: "hybrid"（全部）／"vector"（近さだけ）／"keyword"（語と札だけ＝旧の札・部分一致に相当）
 */
export function hybridRank(rows: RagRow[], vecSim: Map<string, number>, q: string, opts: { nowIso: string; tags?: string[]; mode?: "hybrid" | "vector" | "keyword"; weights?: Partial<Record<keyof typeof HYBRID_WEIGHTS, number>>; scene?: KbScene | null; sceneWeight?: number; syn?: boolean; vecNormRank?: number; sceneTagOnly?: boolean } ): Scored[] {
  const w: Record<keyof typeof HYBRID_WEIGHTS, number> = { ...HYBRID_WEIGHTS, ...(opts.weights ?? {}) };
  const mode = opts.mode ?? "hybrid";
  const syn = opts.syn ?? true;
  const qg = queryGrams(q, { syn });
  const cur = rows.filter((r) => r.is_current);
  const sims = cur.map((r) => vecSim.get(r.id) ?? 0).filter((x) => x > 0).sort((a, b) => b - a);
  // vecNormRank: 近さを 0 にそろえる線を「N 番目の近さ」にする（無い時は渡された中の最小＝前の形）
  const lo = sims.length ? (opts.vecNormRank ? sims[Math.min(sims.length - 1, opts.vecNormRank - 1)] : sims[sims.length - 1]) : 0, hi = sims.length ? sims[0] : 1;
  const out: Scored[] = cur.map((r) => {
    const raw = vecSim.get(r.id) ?? 0;
    const vector = raw > 0 && hi > lo ? Math.max(0, (raw - lo) / (hi - lo)) : raw > 0 ? 1 : 0;
    const keyword = keywordScore(r, qg, { syn });
    const tag = tagScore(r, q, opts.tags ?? []);
    const recency = recencyScore(r.created_at, opts.nowIso);
    const owner = isOwnerWords(r) ? 1 : 0;
    const sceneHit = opts.scene && opts.scene !== "other" && rowInScene(r, opts.scene, { tagOnly: opts.sceneTagOnly }) ? 1 : 0;
    const priority = effectivePriority(r);
    const score = (mode === "vector" ? vector
      : mode === "keyword" ? keyword + w.tag * tag
      : w.vector * vector + w.keyword * keyword + w.tag * tag + w.recency * recency + w.ownerTie * owner + w.priority * PRIORITY_BOOST[priority]) + (opts.sceneWeight ?? SCENE_WEIGHT) * sceneHit;
    return { row: r, score, vector, keyword, tag, recency, raw, priority };
  });
  out.sort((a, b) => b.score - a.score || (a.priority ?? 2) - (b.priority ?? 2) || (isOwnerWords(b.row) ? 1 : 0) - (isOwnerWords(a.row) ? 1 : 0) || (a.row.created_at < b.row.created_at ? 1 : -1));
  return out;
}

/**
 * 2026-10-07 段の別枠: P0（絶対・最優先）のうち問いに関係する物を先頭の別枠に出し、残りの上位 k はそのまま（P0 が席を奪わない＝recall が下がらない）。
 *   場面（scene）の点が付いていても付いていなくても同じ（P0 は場面に関係なく効く決まり）
 */
export function splitPinned(ranked: Scored[], k: number, opts: { p0Sims?: Map<string, number>; scene?: boolean } = {}): { pinned: Scored[]; hits: Scored[] } {
  const pinned = ranked
    .filter((s) => s.priority === 0 && (opts.scene || isP0Relevant(opts.p0Sims?.get(s.row.id) ?? s.raw ?? 0, s.keyword)))
    .slice(0, P0_PIN.max).map((s) => ({ ...s, raw: opts.p0Sims?.get(s.row.id) ?? s.raw, pinned: true }));
  const ids = new Set(pinned.map((s) => s.row.id));
  return { pinned, hits: ranked.filter((s) => !ids.has(s.row.id)).slice(0, k) };
}

// ─── 返信の場面で引く（3巡目・2026-10-07 竹内「的確なRAG検索できるように」「設計知見も場面場面でRAG検索をブレインと連動して」）──────
//   場面（app/lib/reply-scene.ts の9場面）ごとに、①札「場面:〇〇」②題の語の型（札が無い古い行にも当たる）③問いに足す語 を1つの表で持つ。
//   kb.ts --scene=<場面>／searchKb の scene で使う。札の書き込みは scripts/kb-scene-tag.ts（題の型で候補→人が確かめる）。
//   ⚠ 語の型は「題」だけに当てる（本文に当てると約2割の行が全部の場面に当たり絞れない＝10/07 実測）
export type KbScene = "ack" | "considering" | "question" | "conditions" | "property_share" | "cost" | "viewing" | "apply" | "other";
export const KB_SCENES: Record<KbScene, { tag: string; titleRe: RegExp | null; terms: string }> = {
  ack: { tag: "場面:短いお礼", titleRe: /お礼|了承|短い了承|締めの挨拶|返信不要|連絡待ち|連絡を待つ|よろしくお願い/, terms: "短いお礼・了承だけの番の返信" },
  considering: { tag: "場面:検討中", titleRe: /検討中|検討します|持ち帰|少し考え|考えます|一時保留|保留メッセージ|また連絡|扉の?1文|急かさ/, terms: "検討中・保留のお客様への返信" },
  question: { tag: "場面:質問", titleRe: /質問|聞かれ|相場|確認の約束に|確認に逃げ|家賃込み|設備の/, terms: "お客様の質問に答える返信" },
  conditions: { tag: "場面:条件", titleRe: /条件の(?:提示|変更|言い直し|復唱|発言)|言い直|条件ヒアリング|条件フォーム|希望条件|あと一つ|決め手の条件|探す宣言|他の物件/, terms: "お客様の条件の提示・変更への返信" },
  property_share: { tag: "場面:物件を送ってきた", titleRe: /持ち込|SUUMO|お客様が送ってきた|お客様の画像|送ってきた画像|募集状況/, terms: "お客様が物件（URL・画像）を送ってきた番" },
  cost: { tag: "場面:初期費用", titleRe: /初期費用|見積|総額|費用の質問|費用の語|安さ|分割/, terms: "初期費用・見積書の返信" },
  viewing: { tag: "場面:内覧", titleRe: /内覧|内見|待ち合わせ/, terms: "内覧・日程の返信" },
  apply: { tag: "場面:申込", titleRe: /申込|申し込|審査|仮押さえ|お部屋を?抑え|必要書類/, terms: "申込・審査の返信" },
  other: { tag: "場面:その他", titleRe: null, terms: "" },
};
const SCENE_TAGS = new Set<string>(Object.values(KB_SCENES).map((s) => s.tag));
/** 行がその場面の物か（札 or 題の型） */
export function rowInScene(r: Pick<RagRow, "title" | "tags">, scene: KbScene, opts: { tagOnly?: boolean } = {}): boolean {
  const s = KB_SCENES[scene];
  if ((r.tags ?? []).includes(s.tag)) return true;
  // tagOnly（既定 on・2026-10-08）: 場面の札が1つでも付いている行（場面を確かめた行・P0/P1 は全部）は札だけで決め、題の型で他の場面に振らない
  //   （題に「見積」があるだけの採点の行が 場面:初期費用 に入っていた。札の無い行だけ題の型で入る）
  if ((opts.tagOnly ?? true) && (r.tags ?? []).some((t) => SCENE_TAGS.has(t))) return false;
  return !!s.titleRe && s.titleRe.test(r.title);
}
/** 場面の問い: 問いに場面の語を足す（埋め込みと語の両方に効く）。語が既に入っていれば足さない */
export function sceneQuery(q: string, scene: KbScene | null | undefined): string {
  if (!scene || scene === "other") return q;
  const t = KB_SCENES[scene].terms;
  return t && !q.includes(t) ? `${q}（${t}）` : q;
}

/** 画面に出す形（題・本文の最初の2行・id の先頭8字・日付・札） */
export function formatHit(s: Scored): string {
  const r = s.row;
  const lines = String(r.insight ?? "").replace(/\r/g, "").split(/\n|(?<=。)/).map((x) => x.trim()).filter(Boolean).slice(0, 2).join(" ");
  const pl = s.priority != null ? `P${s.priority}・` : "";
  return `${s.pinned ? "★ 絶対・最優先 " : "■ "}${r.title}\n  ［${pl}${r.created_at.slice(0, 10)}・${r.id.slice(0, 8)}］ 点 ${s.score.toFixed(2)}（近さ ${s.vector.toFixed(2)}・語 ${s.keyword.toFixed(2)}）\n  [札] ${(r.tags ?? []).join(" / ")}\n  ${lines.slice(0, 220)}`;
}

/** 似ている組（週の整理）: 2つの埋め込みのコサイン近さ */
export function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
/** 似ている組の候補の線（埋め込みの近さ）。評価（kb-rag-eval の pairs）で決めた値 */
// 2026-10-06 測り直し: DeepSeek が同じ・上書きと判定した27組の近さは 0.71〜0.92（中央 0.83）。0.80 以上で 20/27・全体の組で 162（0.86 は 23 組で取りこぼしが多い）
export const NEAR_DUP_MIN = 0.80;
export { grams, jaccard };

/**
 * 2026-10-08 本文の一節で当たった行（kb.ts の「本文の一節」欄）: 上位 k に出ていない行のうち、問いの句（4字以上）が題・本文にそのまま入っている物を
 *   句の字数の多い順（同じなら並びの点の順）に max 件。長い決定の行の奥の一節（例「物件出し依頼の自動検知の通知」は ce22b1c6 の本文の1か所）を拾う。
 *   並びの点には入れない（入れると全体の recall が下がった＝phraseScore の注記）
 */
export const PHRASE_SUPPLEMENT = { minLen: 4, max: 3 } as const;
export function phraseSupplement(ranked: Scored[], shownIds: Set<string>, q: string, opts: { syn?: boolean; max?: number } = {}): Array<Scored & { phrases: string[] }> {
  const ps = queryPhrases(q, { syn: opts.syn }).filter((p) => p.length >= PHRASE_SUPPLEMENT.minLen);
  if (!ps.length) return [];
  const out: Array<Scored & { phrases: string[]; len: number }> = [];
  for (const s of ranked) {
    if (shownIds.has(s.row.id)) continue;
    const t = opts.syn ? synCached(s.row, "t", s.row.title) : normKb(s.row.title), b = opts.syn ? synCached(s.row, "b", s.row.insight) : normKb(s.row.insight);
    const hit = ps.filter((p) => t.includes(p) || b.includes(p));
    if (hit.length) out.push({ ...s, phrases: hit, len: hit.reduce((n, p) => n + p.length, 0) });
  }
  out.sort((a, b) => b.len - a.len || b.score - a.score);
  return out.slice(0, opts.max ?? PHRASE_SUPPLEMENT.max).map(({ len: _len, ...x }) => x);
}

/** 週の整理の要確認（memory/rules_digest_review.md）の「上書き」の組（--id=古い --by=新しい）。日付が逆の組は除く（どちらが新しい決定か言い切れない） */
export function reviewSupersedePairs(md: string): Array<{ oldId: string; newId: string }> {
  const out: Array<{ oldId: string; newId: string }> = [];
  for (const line of String(md ?? "").split(/\r?\n/)) {
    if (!line.includes("上書き") || line.includes("日付は逆")) continue;
    const m = line.match(/--id=([0-9a-f-]{36})\s+--by=([0-9a-f-]{36})/);
    if (m) out.push({ oldId: m[1], newId: m[2] });
  }
  return out;
}
