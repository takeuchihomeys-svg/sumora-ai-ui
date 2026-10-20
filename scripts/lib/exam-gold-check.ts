// scripts/lib/exam-gold-check.ts — 正解の食い違いを探す（決まった計算・LLM なし）
//
// 2026-10-20 竹内さん（試験のブレインを最優先で改善する・QUALITY⑥）: 似た場面なのに正解が食い違う問題を探し、「竹内さんへの確認」の一覧にする。
//   例: 約束の後の「よろしく」— q091・q103・q176 は AIX【物件確認した】が正解・q143 は返信が正解（AIX は言ってはいけない）。
//   場面の印（決まった計算）: お客様の発言の種類（お礼・了承だけ／質問／他）× 直前のこちらの送信の種類（約束した／AIX／他／なし）＋札＋発言の近さ（文字の2字組の重なり）。
//   食い違い: 片方の正解の道で答えると、もう片方では外れ（言ってはいけない道に当たる＝強い／正解に当たらない＝弱い）が両方向で起きる。
//   設計知見（KB）は場面の言葉で引いた上位を並べる（決めるのは竹内さん）。入口 scripts/exam-gold-check.ts。単体テスト scripts/lib/__tests__/exam-brain-like-line.test.ts
import { judgePath } from "./brain-exam-score";
import { codeOfLabel } from "./exam-rag-run";

export type GoldProblem = { id: string; type: string; tags?: string[]; accept?: string[]; mustNot?: string[]; why?: string; customer?: string; lastStaff?: string; lastStaffAix?: boolean };
export type CustKind = "お礼・了承だけ" | "質問" | "他";
export type StaffKind = "確認・交渉の約束" | "探す・送る約束" | "AIX" | "他" | "なし";

const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/[\s　!！。、,.~〜ー\-()（）🙏]/g, "");
/** お客様の発言の種類: 短いお礼・了承（よろしく・ありがとう・お願いします・了解）だけ／質問（？・〜ますか）／他 */
export function custKindOf(text: string | undefined): CustKind {
  const t = norm(text ?? "");
  if (!t) return "他";
  if (/[?？]|ますか|ですか|でしょうか|いくら|どこ/.test(t)) return "質問";
  const rest = t.replace(/よろしく(お願い)?(します|致します|いたします|お願います|お願いいたします|です)?|お願い(します|致します|いたします)|ありがとう(ございます|ございました)?|すみません|了解(です|しました)?|承知(しました|です)?|わかりました|はい|お手数(を)?おかけしますが|お手隙(おかけしますが)?|お忙しいところ|助かります|宜しく|お願いします|です|ます/g, "");
  return t.length <= 60 && rest.length <= 6 ? "お礼・了承だけ" : "他";
}
/** 直前のこちらの送信の種類: AIX／確認・交渉の約束（結果を返す）／探す・送る約束（ピックアップ）／他／なし（初回）。両方ある時は確認・交渉 */
export function staffKindOf(text: string | undefined, aix?: boolean): StaffKind {
  if (aix) return "AIX";
  const t = norm(text ?? "");
  if (!t) return "なし";
  if (/確認を?(させて|致し|いたし|します|出来次第|でき次第)|交渉を?(させて|致し|いたし|します)/.test(t)) return "確認・交渉の約束";
  if (/ピックアップ|お探し|探して|探させ|お送りさせて|送らせて|出来次第|でき次第|ご連絡させて/.test(t)) return "探す・送る約束";
  return "他";
}
/** 文字の2字組の重なり（Jaccard） */
export function bigramSim(a: string, b: string): number {
  const g = (s: string) => { const t = norm(s); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
  const x = g(a), y = g(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const k of x) if (y.has(k)) n++;
  return n / (x.size + y.size - n);
}
/** 場面の印（同じ印の問題を比べる）。お礼・了承だけの発言は言葉の違いが効かない＝種類だけ／他は近さで比べる */
export function sceneKeyOf(p: GoldProblem): string { return `${custKindOf(p.customer)}|${staffKindOf(p.lastStaff, p.lastStaffAix)}`; }
const GENERIC_TAGS = new Set(["竹内さんの番", "お手本", "送る番(10/09)"]);
/** 2つの問題の場面の近さ（0〜1）: 同じ場面の印 0.5＋発言の近さ 0.3＋同じ札 0.2（型が同じは +0.05） */
export function sceneSim(a: GoldProblem, b: GoldProblem): number {
  const same = sceneKeyOf(a) === sceneKeyOf(b);
  const ck = custKindOf(a.customer);
  const thanks = ck === "お礼・了承だけ" && custKindOf(b.customer) === ck;
  const words = thanks ? 1 : bigramSim(a.customer ?? "", b.customer ?? "");
  // お礼・了承だけでない発言は中身（言葉）で答えが決まる＝言葉がある程度近い時だけ同じ場面（質問の中身が違えば正解が違って当たり前）
  if (!thanks && words < 0.35) return 0;
  const ta = new Set((a.tags ?? []).filter((t) => !GENERIC_TAGS.has(t))), tb = (b.tags ?? []).filter((t) => !GENERIC_TAGS.has(t));
  const tags = ta.size || tb.length ? tb.filter((t) => ta.has(t)).length / Math.max(1, new Set([...ta, ...tb]).size) : 0;
  return Math.min(1, (same ? 0.5 : 0) + 0.3 * words + 0.2 * tags + (a.type === b.type ? 0.05 : 0));
}
/** 片方の正解の道（どれか）で答えた時、もう片方で通るか（通る道が1つでもあれば true）・言ってはいけない道に当たる道 */
export function crossCheck(from: GoldProblem, to: GoldProblem): { passes: boolean; hitsMustNot: string[] } {
  const hits: string[] = [];
  let passes = false;
  for (const a of from.accept ?? []) {
    const v = judgePath(codeOfLabel(a), to.accept ?? [], to.mustNot ?? []);
    if (v.ok) passes = true;
    if (v.mustNotHit) hits.push(`${a}→${v.mustNotHit}`);
  }
  return { passes, hitsMustNot: hits };
}
export type GoldConflict = { a: string; b: string; scene: string; sim: number; strength: "強い" | "弱い"; why: string; aAccept: string[]; bAccept: string[] };
/**
 * 食い違いの組: 場面の近さが min 以上で、どちらの正解の道で答えても、もう片方で通らない組。
 *   強い＝片方の正解がもう片方の『言ってはいけない道』に当たる／弱い＝正解に当たらないだけ
 */
export function findConflicts(ps: GoldProblem[], o: { minSim?: number } = {}): GoldConflict[] {
  const min = o.minSim ?? 0.6;
  const out: GoldConflict[] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], b = ps[j];
    if (!(a.accept ?? []).length || !(b.accept ?? []).length) continue;
    const sim = sceneSim(a, b);
    if (sim < min) continue;
    const ab = crossCheck(a, b), ba = crossCheck(b, a);
    if (ab.passes || ba.passes) continue;
    const strong = ab.hitsMustNot.length > 0 || ba.hitsMustNot.length > 0;
    out.push({ a: a.id, b: b.id, scene: sceneKeyOf(a), sim: Math.round(sim * 100) / 100, strength: strong ? "強い" : "弱い",
      why: strong ? `${a.id} の正解で答えると ${b.id} の言ってはいけない道（${[...ab.hitsMustNot, ...ba.hitsMustNot.map((x) => `逆: ${x}`)].slice(0, 3).join("・")}）` : "どちらの正解も、もう片方の正解に当たらない", aAccept: a.accept ?? [], bAccept: b.accept ?? [] });
  }
  return out.sort((x, y) => Number(y.strength === "強い") - Number(x.strength === "強い") || y.sim - x.sim);
}
/** 組を場面ごとの束にまとめる（同じ問題をつなぐ）。竹内さんへの確認は束ごとに1つ */
export function groupConflicts(cs: GoldConflict[]): Array<{ ids: string[]; scene: string; pairs: GoldConflict[]; strong: boolean }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const c of cs) { const ra = find(c.a), rb = find(c.b); if (ra !== rb) parent.set(ra, rb); }
  const g = new Map<string, GoldConflict[]>();
  for (const c of cs) { const r = find(c.a); g.set(r, [...(g.get(r) ?? []), c]); }
  return [...g.values()].map((pairs) => ({ ids: [...new Set(pairs.flatMap((p) => [p.a, p.b]))].sort(), scene: pairs[0].scene, pairs, strong: pairs.some((p) => p.strength === "強い") }))
    .sort((x, y) => Number(y.strong) - Number(x.strong) || y.ids.length - x.ids.length);
}
/** 設計知見を場面の言葉で引く（決まった計算: 題・本文・札に入っている言葉の数）。上位 k 件 */
export function kbHitsFor(words: string[], kb: Array<{ id: string; title: string; insight?: string; tags?: string[] | null }>, k = 3): Array<{ id: string; title: string; score: number }> {
  const ws = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2))];
  return kb.map((r) => { const t = `${r.title} ${(r.tags ?? []).join(" ")}`, body = String(r.insight ?? ""); const score = ws.reduce((s, w) => s + (t.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0), 0); return { id: r.id, title: r.title, score }; })
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
/** 場面の言葉（KB を引く）: 場面の種類の言葉＋問題の札 */
export function sceneWords(g: { scene: string }, ps: GoldProblem[]): string[] {
  const [ck, sk] = g.scene.split("|");
  const base = [...(ck === "お礼・了承だけ" ? ["よろしく", "お礼", "了承", "受けだけ"] : ck === "質問" ? ["質問"] : []), ...(sk === "確認・交渉の約束" ? ["約束の後", "確認の約束", "交渉"] : sk === "探す・送る約束" ? ["約束の後", "ピックアップの約束"] : sk === "AIX" ? ["AIX の後"] : [])];
  return [...base, ...ps.flatMap((p) => (p.tags ?? []).filter((t) => !GENERIC_TAGS.has(t)))];
}
/** 問題 id → 食い違う相手（失敗の理由の読み手に「正解が揺れている」の手がかりとして渡す） */
export function conflictPeers(cs: GoldConflict[]): Record<string, Array<{ id: string; accept: string[]; strength: string }>> {
  const m: Record<string, Array<{ id: string; accept: string[]; strength: string }>> = {};
  for (const c of cs) { (m[c.a] ??= []).push({ id: c.b, accept: c.bAccept, strength: c.strength }); (m[c.b] ??= []).push({ id: c.a, accept: c.aAccept, strength: c.strength }); }
  return m;
}
