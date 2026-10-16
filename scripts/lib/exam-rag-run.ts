// scripts/lib/exam-rag-run.ts — 試験の問題の札を作る（--index）・直した所に関係する問題を選ぶ（--select=rag）の組み立て
//   純な決め方は exam-rag.ts、置き場と KB の読みは exam-rag-store.ts。ここは git・埋め込み（OpenAI text-embedding-3-small）・KB の RPC を呼ぶ。LLM は呼ばない。
import { execFileSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cardEmbeddingInput, cardOfProblem, diffQueryText, hashText, kbChanges, mergeAutoLinks, addFixedLink, selectProblems, type ExamCard, type KbLink, type SelectResult } from "./exam-rag";
import { addPendingLinks, kbEmbeddings, loadCards, loadKbRows, loadLinks, matchKb, nearProblemsOf, readKbSnapshot, readPendingLinks, readPrefixes, kbTextMask, saveCards, scanCassetteForProblems, updateLinks, writeKbSnapshot, writePendingLinks, writePrefixes, type KbRow } from "./exam-rag-store";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_ENTRIES, DRAFT_ENTRIES, classifyFile, combineClasses, decideStageFromDiff, examGraph, stageOfClass, workingFiles, type StageDecision } from "./exam-scope";
import { specHashOf } from "./exam-problems-store";
import { readObs } from "./exam-flake";
import { maskExamText } from "./brain-exam-mask";
import { aixFamily, judgePath, type PathCode } from "./brain-exam-score";
import { topicKey } from "../../app/lib/aix-catalog";

type P = Parameters<typeof cardOfProblem>[0] & Record<string, unknown>;
const EMBED_PRICE_PER_M = 0.02;

async function embed(texts: string[]): Promise<{ vectors: Array<number[] | null>; tokens: number }> {
  const { embedTexts } = await import("../../app/lib/design-knowledge-rag-server");
  const out: Array<number[] | null> = []; let tokens = 0;
  for (let i = 0; i < texts.length; i += 64) { const r = await embedTexts(texts.slice(i, i + 64)); out.push(...r.vectors); tokens += r.tokens; }
  return { vectors: out, tokens };
}
async function maskFn(): Promise<(s: string) => string> {
  const { maskForEmbedding } = await import("../../app/lib/pii-mask");
  return (s: string) => maskForEmbedding(maskExamText(s, null));
}
const kbText = (r: KbRow) => `${r.title}\n${r.insight}\n${r.rationale ?? ""}\n${(r.tags ?? []).join(" ")}`;
export function kbHashMap(rows: KbRow[]): Record<string, string> { return Object.fromEntries(rows.map((r) => [r.id, hashText(kbText(r))])); }

export type IndexStats = { cards: number; embedded: number; tokens: number; usd: number; linked: number; pendingResolved: number; store: string; prefixes: number };
/**
 * 札を作る・埋める（文が変わった物だけ）・近い知見を紐付ける（自動の候補・固定は残す）・控えの紐付けを id に解く・録音から前置きの印を取る
 */
export async function buildIndex(sb: SupabaseClient, problems: P[], o: { stageOf: (p: P) => "brain" | "draft"; cassetteDir?: string; relink?: boolean; kbRows?: KbRow[]; log?: (s: string) => void }): Promise<IndexStats> {
  const log = o.log ?? console.log;
  const mask = await maskFn();
  const prefixes = o.cassetteDir ? scanCassetteForProblems(o.cassetteDir) : readPrefixes();
  if (o.cassetteDir) writePrefixes(prefixes);
  const cur = await loadCards(sb);
  const cards: ExamCard[] = problems.map((p) => {
    const st = o.stageOf(p);
    const c = cardOfProblem(p, { specHash: specHashOf(p), stage: st, mask, files: st === "draft" ? [...BRAIN_ENTRIES, ...DRAFT_ENTRIES] : BRAIN_ENTRIES, actions: prefixes[p.id]?.actions ?? cur[p.id]?.parts.actions ?? [] });
    const h = hashText(cardEmbeddingInput(c));
    const old = cur[p.id];
    return old?.embeddingHash === h && old.embedding?.length ? { ...c, embedding: old.embedding, embeddingHash: h } : { ...c, embedding: null, embeddingHash: h };
  });
  const need = cards.filter((c) => !c.embedding?.length);
  let tokens = 0;
  if (need.length) {
    const r = await embed(need.map((c) => cardEmbeddingInput(c)));
    tokens = r.tokens;
    need.forEach((c, k) => { c.embedding = r.vectors[k]; if (!c.embedding) c.embeddingHash = null; });
  }
  const store = await saveCards(sb, cards);
  // 近い知見（自動の候補）: 新しく埋めた問題・紐付けの無い問題（--relink で全部）
  const links = await loadLinks(sb);
  const kbRows = o.kbRows ?? await loadKbRows(sb);
  const byId = new Map(kbRows.map((r) => [r.id, r]));
  const km = await kbTextMask();
  const relink = cards.filter((c) => c.embedding?.length && (o.relink || need.includes(c) || !(links[c.id] ?? []).some((l) => l.kind === "auto")));
  const auto: Record<string, KbLink[]> = {};
  for (const c of relink) {
    const hits = await matchKb(sb, c.embedding!, 8);
    auto[c.id] = hits.filter((h) => h.similarity >= 0.3 && byId.has(h.id)).slice(0, 5).map((h) => ({ kbId: h.id, kind: "auto" as const, score: Math.round(h.similarity * 1000) / 1000, title: km(byId.get(h.id)!.title), decided: km(byId.get(h.id)!.insight).slice(0, 120), at: new Date().toISOString() }));
  }
  // 控えの紐付け（題・id8・id）を id に解く
  const pend = readPendingLinks();
  const left: typeof pend = [];
  const fixed: Array<{ pid: string; l: Omit<KbLink, "kind"> }> = [];
  for (const pl of pend) {
    const ref = pl.kbRef.trim();
    const row = byId.get(ref) ?? kbRows.find((r) => r.id.startsWith(ref) && /^[0-9a-f]{8}/.test(ref)) ?? kbRows.find((r) => r.title === ref.replace(/^title:/, ""));
    if (!row) { left.push(pl); continue; }
    fixed.push({ pid: pl.problemId, l: { kbId: row.id, score: 1, title: km(row.title), decided: km(row.insight).slice(0, 120), at: pl.at, note: pl.note } });
  }
  await updateLinks(sb, (curL) => {
    const next = { ...curL };
    for (const [pid, ls] of Object.entries(auto)) next[pid] = mergeAutoLinks(next[pid], ls);
    for (const f of fixed) next[f.pid] = addFixedLink(next[f.pid], f.l);
    return next;
  });
  if (fixed.length) writePendingLinks(left);
  // 知見の控えが無ければ今で作る（次から「この後に入れた・変えた・退役した知見」が分かる）
  if (!readKbSnapshot()) writeKbSnapshot({ at: new Date().toISOString(), rows: kbHashMap(kbRows) });
  const usd = (tokens / 1e6) * EMBED_PRICE_PER_M;
  log(`問題の札: ${cards.length}問（埋めた ${need.length}・トークン ${tokens}・$${usd.toFixed(5)}）・近い知見を紐付け ${relink.length}問・控えの紐付けを解いた ${fixed.length}（残り ${left.length}）・置き場 ${store}・前置きの印 ${Object.values(prefixes).filter((x) => x.prefix).length}問`);
  return { cards: cards.length, embedded: need.length, tokens, usd, linked: relink.length, pendingResolved: fixed.length, store, prefixes: Object.keys(prefixes).length };
}

export type RagSelectOut = SelectResult & { decision: StageDecision; queryChars: number; kbChanged: number; kbHits: Array<{ id: string; score: number; title?: string }>; tokens: number; kbNow: Record<string, string> | null };
/** 全部にする変更（試験の道具・設定・消した app）。ブレインと下書きの両方を読むファイルは全部にしない（近さで選ぶ） */
export function allReasonOf(d: StageDecision): string | null {
  if (!d.base) return d.note || "main との分かれ目が分からない";
  const hard = d.files.filter((f) => /試験の道具|設定|消した app/.test(f.why));
  if (hard.length) return `${hard.slice(0, 3).map((f) => `${f.file}（${f.why}）`).join("・")}${hard.length > 3 ? ` ほか ${hard.length - 3}` : ""}`;
  if (d.note && /分からない|読めない|見つからない/.test(d.note)) return d.note;
  return null;
}
export async function ragSelect(sb: SupabaseClient, problems: P[], o: { stageOf: (p: P) => "brain" | "draft"; topN: number; extraQuery?: string; cwd?: string; freshDays?: number; /** 試し: <a>..<b> の変更だったら何を選ぶか（作業ツリーの差の代わり） */ range?: string; log?: (s: string) => void }): Promise<RagSelectOut> {
  const log = o.log ?? console.log;
  const cwd = o.cwd ?? ".";
  const decision = o.range ? decisionOfRange(o.range, cwd) : decideStageFromDiff(cwd);
  const allReason = allReasonOf(decision);
  // 札が無い・古い問題は先に作る（埋め込み 1問 約 300 トークン＝$0.000006）
  const cards0 = await loadCards(sb);
  const stale = problems.filter((p) => !cards0[p.id] || cards0[p.id].specHash !== specHashOf(p));
  const kbRows = await loadKbRows(sb);
  if (stale.length) await buildIndex(sb, stale, { stageOf: o.stageOf, kbRows, log });
  const cardsAll = await loadCards(sb);
  const cards = problems.map((p) => cardsAll[p.id]).filter(Boolean);
  // 差分の言葉
  let diff = "";
  const files = decision.files.map((f) => f.file);
  if (decision.base) { try { diff = execFileSync("git", ["diff", "-U0", o.range ?? decision.base, "--", ...files.filter((f) => !/\.(?:png|jpg|xlsx|pdf)$/i.test(f))], { cwd, maxBuffer: 64 * 1024 * 1024 }).toString(); } catch { /* 名前だけで */ } }
  const q = [o.extraQuery ?? "", diffQueryText(diff, files)].filter(Boolean).join("\n");
  let tokens = 0, queryVec: number[] | null = null;
  if (!allReason && (files.length || o.extraQuery)) { const r = await embed([q]); queryVec = r.vectors[0]; tokens += r.tokens; }
  // 知見の変化（前の控えと比べる）と、差分の言葉で当たった知見
  const kbNow = kbHashMap(kbRows);
  const changed = kbChanges(readKbSnapshot(), kbNow);
  const byId = new Map(kbRows.map((r) => [r.id, r]));
  const kbHits = queryVec ? (await matchKb(sb, queryVec, 8)).filter((h) => h.similarity >= 0.35).map((h) => ({ id: h.id, score: h.similarity, title: byId.get(h.id)?.title })) : [];
  const links = await loadLinks(sb);
  const linked = new Set(Object.values(links).flat().map((l) => l.kbId));
  const unlinked = changed.filter((c) => c.kind !== "retired" && !linked.has(c.id)).map((c) => c.id).slice(0, 30);
  const kbNear: Record<string, Array<{ id: string; sim: number }>> = {};
  if (unlinked.length) { const ev = await kbEmbeddings(sb, unlinked); for (const [id, v] of ev) { const ps = nearProblemsOf(v, cards); if (ps.length) kbNear[id] = ps; } }
  // 差分で当たった知見（上位3）に近い問題も入れる（問題 → 知見の自動の紐付けは問題の言葉から引くので、設計の言葉の知見とは近さが出にくい＝逆向きでも引く）
  const hitTop = kbHits.slice(0, 3).map((h) => h.id).filter((id) => !kbNear[id]);
  if (hitTop.length) { const ev = await kbEmbeddings(sb, hitTop); for (const [id, v] of ev) { const ps = nearProblemsOf(v, cards, 2, 0.45); if (ps.length) kbNear[id] = ps; } }
  // 差分・言葉・commit の文に問題の id（q112 等）が書いてあれば必ず入れる（直す人が名指しした問題）
  let msgs = "";
  if (o.range) { try { msgs = execFileSync("git", ["log", "--format=%B", o.range], { cwd }).toString(); } catch { /* */ } }
  const mentioned = [...new Set([...`${q}\n${msgs}`.matchAll(/\bq\d{3,4}\b/g)].map((m) => m[0]))].filter((id) => cards.some((c) => c.id === id));
  // 前に落ちた・新しい（揺れの記録 30日）
  const failedBefore = new Set<string>(), fresh = new Set<string>();
  const freshMs = (o.freshDays ?? 7) * 86_400_000;
  for (const p of problems) {
    const obs = readObs(p.id);
    if (!obs.length) fresh.add(p.id);
    // 「前に落ちた」＝一番新しい答えが不合格（今も落ちている）。30日の中の一度でも ✕ にすると、直しの試しで壊した回まで数えて殆ど全部になる（10/16 の試しで 144問中 130問超）
    //   さらに「道」で見る（依頼の要点の判定は DeepSeek の揺れ・言い方の差で ✕ が多く、それで数えると 144問中 72問＝選ぶ意味が無い）
    //   10/16 の試し: 一番新しい道が外れの問題は 144問中 45問。その殆どは main でもずっと外れ（解けていない問題＝落ちたのではない）。
    //   既定（EXAM_RAG_FAILED=fell）は「前は道が合っていたのに、一番新しい答えで外れた」＝落ちた問題だけ必ず入れる。ずっと外れの問題は差分の言葉が近ければ入る。
    //   last＝一番新しい道が外れなら全部（旧の考え・多い）／off＝入れない
    const mode = (process.env.EXAM_RAG_FAILED ?? "fell").trim();
    //   「前は合っていた」は直前の2回（独立に回した答え）が両方とも道が合っていた事（DeepSeek の揺れで行ったり来たりする問題は数えない＝36問 → 下の数）
    const sorted = [...obs].filter((x) => x.independent !== false).sort((a, b) => a.at.localeCompare(b.at));
    const last = sorted[sorted.length - 1];
    const prev2 = sorted.slice(-3, -1);
    if (mode !== "off" && last && pathFailedSig(last.sig, p as never) && (mode === "last" || (prev2.length === 2 && prev2.every((x) => !pathFailedSig(x.sig, p as never))))) failedBefore.add(p.id);
    const added = Date.parse(String(p.addedAt ?? ""));
    if (Number.isFinite(added) && Date.now() - added < freshMs) fresh.add(p.id);
  }
  const res = selectProblems({ cards, queryVec, changeClass: decision.base ? decision.cls : null, allReason, failedBefore, fresh, links, changedKb: changed, kbHits, kbNearProblems: kbNear, mentioned, topN: o.topN });
  // 札の無い問題（埋め込みに失敗した等）は安全側で入れる
  const have = new Set(cards.map((c) => c.id));
  for (const p of problems) if (!have.has(p.id) && !res.picked.some((x) => x.id === p.id)) res.picked.push({ id: p.id, why: ["札が無い（安全側で入れる）"], sim: null, must: true });
  void log;
  return { ...res, decision, queryChars: q.length, kbChanged: changed.length, kbHits, tokens, kbNow };
}
/** 揺れの記録の答えの印（道|○✕|下書き=道○✕）が不合格か */
export function failedSig(sig: string): boolean { return /\|✕/.test(sig) || /下書き=[^|]*✕/.test(sig); }
/** 道の符号の字（brain-exam.ts の codeFromString と同じ） */
export function codeOfLabel(c: string): PathCode {
  // brain-exam-score.brainPathCode の label の書き方を戻す: 「AIX:<action>[/<cp>]（左右|左だけ）」「2段:<k>（初回）」「返信（分からない事は確認の約束）」「なし（連絡待ち）」
  const note = c.match(/（([^）]*)）\s*$/)?.[1] ?? "";
  const s = c.replace(/（[^）]*）\s*$/, "").trim();
  if (s.startsWith("AIX:")) {
    const [a, cp] = s.slice(4).split("/");
    const fam = aixFamily(a);
    const cs = [...new Set([fam === "property_check_result" && cp ? `AIX:${topicKey(`property_check_result/${cp}`)}` : `AIX:${a}`, `AIX:${fam}`, "AIX"])];
    return note === "左右" ? { codes: [...cs, "AIX:左右"], hard: [...cs, "右:全力"], label: c } : { codes: cs, hard: cs, label: c };
  }
  if (s.startsWith("2段")) return { codes: [s, "2段"], hard: [s, "2段"], label: c };
  if (s === "返信" && /確認の約束/.test(note)) return { codes: ["返信", "2段:check", "2段"], hard: [], label: c };
  return { codes: [s], hard: [s], label: c };
}
/** 答えの印のブレインの道・下書きの道が正解でないか（正解は accept か、出し切りの決まりが入った時の acceptWhen.searchExhausted のどちらかに当たれば正解） */
export function pathFailedSig(sig: string, p: { accept?: string[]; mustNot?: string[]; acceptWhen?: { searchExhausted?: string[] } }): boolean {
  const accs = [p.accept ?? [], p.acceptWhen?.searchExhausted ?? []].filter((a) => a.length);
  const okOf = (code: string) => accs.some((a) => judgePath(codeOfLabel(code), a, p.mustNot ?? []).ok);
  const path = sig.split("|")[0];
  if (path && !okOf(path)) return true;
  const d = sig.match(/下書き=([^|]*?)[○✕]?$/)?.[1];
  return !!d && d !== "（下書きなし）" && !okOf(d);
}
/** 試し: <a>..<b> の変更を、今の作業ツリーの import の線で分ける（scripts/exam-rag.ts --select --select-range=<a>..<b>） */
export function decisionOfRange(range: string, cwd = "."): StageDecision {
  if (!/^[\w./~^-]+\.\.[\w./~^-]+$/.test(range)) throw new Error(`--select-range は <a>..<b>: ${range}`);
  const files = execFileSync("git", ["diff", "--name-only", range], { cwd }).toString().split("\n").map((x) => x.trim()).filter(Boolean);
  const g = examGraph(workingFiles(cwd));
  const vs = files.map((f) => classifyFile(f, g, existsSync(join(cwd, f))));
  const cls = combineClasses(vs);
  return { stage: stageOfClass(cls), cls, base: range.split("..")[0], files: vs, note: cls === "none" ? "変わったファイルは試験の入口から読まれない" : "" };
}
/** 試験が終わった後、知見の控えを今に進める（次の --select=rag は、この後に変わった知見だけを「変わった」と見る） */
export function commitKbSnapshot(kbNow: Record<string, string>): void { writeKbSnapshot({ at: new Date().toISOString(), rows: kbNow }); }
/** 直して通った問題と知見を結ぶ（知見の id・id8・題。まだ KB に無い題は控え、次の --index で解く） */
export function recordFixedLinks(problemIds: string[], kbRefs: string[], note?: string): void {
  const at = new Date().toISOString();
  addPendingLinks(problemIds.flatMap((pid) => kbRefs.map((r) => ({ problemId: pid, kbRef: r, at, note }))));
}
