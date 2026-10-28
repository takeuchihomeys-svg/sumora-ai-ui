// app/lib/knowledge-gap.ts — 知識の穴の拾い出し（純関数）。scripts/knowledge-gap-weekly.ts が使う。
//
// 2026-10-29 作業員5（竹内さん 10/29「知識弱い部分も見つけ出していく」・KB P1）:
//   本番の見張り（line_watch_turns）で、下書きが「確認させて頂きます」「分かりかねます」と約束・ぼかしをした番のうち、
//   同じ番の竹内さん・スタッフの実送信が約束せずに具体の事実で答えた番を拾う＝AI が知らなかった知識の候補。
//   CLAUDE.md「絶対的な考え方」の外れの3つで分ける:
//     company   会社の事実（自社の決まり・サービス・割引・手配できる事）      → 知識の穴（会社の事実の候補）
//     procedure 手続き（申込・審査・契約・入居までの流れ・必要な物）          → 知識の穴（手続きの候補）
//     general   一般の不動産の知識（相場・仕組み・言葉の意味）                → 知識の穴（一般の知識の候補）
//     property  その物件の資料・記録で分かる事実（設備・条件・床の色の規則）  → 物件の記録の候補（物件ごとの記録に載っていれば答えられた）
//     staff_only 管理会社に聞いて分かった事・募集状況・交渉の結果・日程の確定 → 知識の穴ではない（AIX で送る番＝返信か AIX かの判断の側）
//     none      事実の答えではない（了承・挨拶・案内だけ）
//   裏取り: 根拠の送信が竹内さんの手（messages.staff_writer=takeuchi）なら「入れてよい候補」、従業員だけなら「竹内さんに聞く ○×」。
//   書くのは KB（設計知見）への登録だけ。会社の事実のコード（company-facts.ts）への反映は統括に候補を見せてから。

/** 下書きのぼかし・約束（確認の約束・分かりかね） */
export const VAGUE_DRAFT_RE = /確認(?:させて|致し|いたし|し(?:て)?ご連絡)|分かりかね|わかりかね|お調べ(?:して|させて|致し|いたし)|確認(?:出来|でき)次第|管理会社(?:様)?に(?:確認|問い合わせ|お問い合わせ)/;
/** 実送信も約束している（＝答えていない）。「確認しました」は答えなので外さない */
const STAFF_PROMISE_RE = /確認して(?:ご連絡|お送り)|お調べし|確認(?:させて|致し|いたし)(?:ます|頂きます|いただきます)|分かりかね|わかりかね|確認(?:出来|でき)次第|お調べ(?:して|させて|致し|いたし)/;
/** 事実の答えではない通（了承・お礼・査収の促しだけ） */
const COURTESY_PHRASES_RE = /はい|かしこまりました|承知(?:致し|いたし)?ました|ありがとうございます|お手隙の際に|ご査収(?:くだ|下)さい|何卒|よろしく|宜しく|お願い(?:致し|いたし)?ます|お世話になっております|全然大丈夫です|大丈夫です|[！!😊😌🌟✨。、\s]/gu;
const isCourtesyOnly = (t: string) => t.replace(COURTESY_PHRASES_RE, "").length < 6;

export type GapTurnRow = {
  id: number;
  conversation_id: string;
  customer_turn_at: string;
  scene_key: string | null;
  draft_first: string | null;
  staff_texts: Array<{ at?: string; text: string; burst?: boolean }> | null;
  staff_aix: Array<{ aix_type: string | null; burst?: boolean }> | null;
};

/** 実送信のうち、約束していない・事実を含みうる通（返事のまとまり burst を優先） */
export function answeringStaffTexts(row: Pick<GapTurnRow, "staff_texts">): Array<{ at?: string; text: string }> {
  const all = (row.staff_texts ?? []).filter((s) => (s.text ?? "").trim());
  const burst = all.filter((s) => s.burst !== false);
  const pool = burst.length ? burst : all;
  return pool.filter((s) => !STAFF_PROMISE_RE.test(s.text) && !isCourtesyOnly(s.text) && s.text.replace(/\s/g, "").length >= 12);
}

/** 拾う番か（下書きがぼかした・実送信が約束せずに答えた） */
export function isGapTurn(row: GapTurnRow): boolean {
  const d = row.draft_first ?? "";
  if (!VAGUE_DRAFT_RE.test(d)) return false;
  return answeringStaffTexts(row).length > 0;
}

/** 網③（10/29 作業員1の5番の読み）: 実送信の文のうち、下書きに無く、約束・挨拶・聞き返しでない事実の文（〜となります・〜可能です・〜ございます・〜手配させて頂きます）。
 *   下書きがぼかしていない番でも「実送信だけにある事実の1文」で知識の抜けを拾う（7683 引越し業者の手配・5508・5964・8466） */
const FACT_LINE_END_RE = /(?:となります|となっております|可能(?:です|となります|でございます)|(?:御座|ござ)います|ございません|(?:手配|ご案内|対応)(?:も)?(?:させて|致し|いたし)(?:頂|いただ)?(?:き)?ます|限られ(?:ます|ております)|かかります|必要(?:です|ございません|ありません))[！!😊😌🌟✨。\s]*$/u;
const NON_FACT_LINE_RE = /お手隙|ご査収|如何でしょうか|いかがでしょうか|でしょうか|ありがとうございます|お世話になって|よろしく|宜しく|お気軽|お待ち|ご連絡させて|お送りさせて|ご案内させて頂きます！！$|確認(?:させて|致し|いたし)/;
function splitLines(t: string): string[] { return t.split(/\n|(?<=[。！!？?])(?=[^！!？?])/).map((x) => x.trim()).filter((x) => x.length >= 8); }
export function staffOnlyFactLines(draft: string | null | undefined, staffText: string): string[] {
  const dl = splitLines(draft ?? "");
  return splitLines(staffText).filter((l) => FACT_LINE_END_RE.test(l) && !NON_FACT_LINE_RE.test(l) && !dl.some((d) => factSimilarity(d, l) >= 0.45));
}

export type GapKind = "company" | "procedure" | "general" | "property" | "staff_only" | "none";
export const GAP_KIND_JA: Record<GapKind, string> = {
  company: "会社の事実", procedure: "手続き", general: "一般の知識", property: "物件の記録", staff_only: "スタッフだけが知る事（AIX の番）", none: "事実の答えではない",
};
/** 知識の穴として数える種類（staff_only・none は外す） */
export const KNOWLEDGE_KINDS: ReadonlySet<GapKind> = new Set(["company", "procedure", "general", "property"]);

export type GapExtract = { n: number; kind: GapKind; fact: string; question: string; building: string | null };

export const GAP_EXTRACT_SYSTEM = [
  "あなたは賃貸仲介会社の LINE 返信の監査役です。各番について、AI の下書きは「確認します」「分かりかねます」とぼかした（または答えるべき事実が抜けた）が、実際のスタッフの返信は答えた。",
  "スタッフの返信が答えた事実を1つだけ取り出し、種類を決めてください。",
  "種類:",
  "- company: 自社の決まり・サービス・割引・手配できる事（例: 引越し業者の手配ができる・スモ割の額）",
  "- procedure: 申込・審査・契約・入居までの流れや必要な物（例: 代理契約は郵送で来阪不要）",
  "- general: どの物件にも言える一般の不動産の知識・相場・仕組み（例: 保証料は総賃料の50%前後が相場）",
  "- property: その物件の資料・募集図面・物件の記録に載る事実（設備・規約・ペット可否・床の色の規則・契約期間）。building に物件名",
  "- staff_only: その時に管理会社へ聞いて分かった事・募集状況・交渉の結果・内覧の日程や確定（スタッフだけが知り得る・AI が知り得ない）",
  "- none: 事実の答えではない（了承・挨拶・案内・物件の提案だけ）",
  "迷ったら staff_only か none。事実は下書き・会話に無い、スタッフが新しく言った事だけ。",
  "スタッフの返信が、下書きがぼかした問いへの答えになっていない（別の物件の提案・見積書の画像・ピックアップの案内に変えた）時は none。",
  "スタッフの文に無い数字・名前を足さない（文にある言葉だけで書く）。",
  "fact は他の会話でも使える一般化した1文（40字以内・お客様の名前・号室は書かない。property だけ物件名を building に）。",
  "question は竹内さんに ○× で聞く形の1文（「〜で合っていますか」）。",
  "出力は JSON 配列だけ: [{\"n\":1,\"kind\":\"company\",\"fact\":\"...\",\"question\":\"...\",\"building\":null}]",
].join("\n");

export function gapExtractPrompt(items: Array<{ n: number; customer: string; draft: string; staff: string; aixSent: string[] }>): string {
  return items.map((x) => [
    `### 番 ${x.n}`,
    `お客様: ${x.customer.slice(0, 400)}`,
    `AI の下書き（ぼかした・または事実が抜けた）: ${x.draft.slice(0, 300)}`,
    `スタッフの実際の返信: ${x.staff.slice(0, 500)}`,
    x.aixSent.length ? `同じ番にスタッフが送った AIX: ${x.aixSent.join("・")}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}

const KINDS = new Set<GapKind>(["company", "procedure", "general", "property", "staff_only", "none"]);
export function parseGapExtract(text: string): Map<number, GapExtract> {
  const out = new Map<number, GapExtract>();
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const v of arr) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const n = Number(o.n);
    const kind = String(o.kind ?? "") as GapKind;
    if (!Number.isFinite(n) || !KINDS.has(kind)) continue;
    out.set(n, { n, kind, fact: String(o.fact ?? "").trim().slice(0, 80), question: String(o.question ?? "").trim().slice(0, 120), building: o.building ? String(o.building).trim().slice(0, 40) : null });
  }
  return out;
}

/** 似た候補をまとめる鍵（文字の2連の重なり）。同じ種類・同じ物件の中だけで比べる */
function bigrams(s: string): Set<string> {
  const t = s.normalize("NFKC").replace(/[\s、。！!？?「」『』（）()・]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
export function factSimilarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 候補の文字の2連のうち、既知の事実（会社の事実の fact 等）に含まれる割合（短い候補と長い事実を比べる） */
export function factCoverage(candidate: string, known: string): number {
  const A = bigrams(candidate), B = bigrams(known);
  if (!A.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / A.size;
}
/** 既に会社の事実（company-facts.ts）にある候補か＝知識はあるのに届かなかった（材料の届き方の側）。線は 0.6 */
export function knownFactOf(candidate: string, known: ReadonlyArray<{ id: string; fact: string }>, threshold = 0.6): string | null {
  let best: { id: string; c: number } | null = null;
  for (const k of known) { const c = factCoverage(candidate, k.fact); if (c >= threshold && (!best || c > best.c)) best = { id: k.id, c }; }
  return best?.id ?? null;
}

/** 候補の扱い: known＝既にある事実（届かなかった）／property＝物件の記録の候補（○× にしない）／backed＝入れてよい（竹内さんの送信が根拠）／ask＝竹内さんに ○× */
export type GapStatus = "known" | "property" | "backed" | "ask";
export function gapStatus(c: Pick<GapCandidate, "kind" | "knownFactId" | "backedByTakeuchi">): GapStatus {
  if (c.knownFactId) return "known";
  if (c.kind === "property") return "property";
  return c.backedByTakeuchi ? "backed" : "ask";
}

export type GapEvidence = { turnId: number; conversationId: string; at: string; scene: string | null; draftHead: string; staffHead: string; staffMsgId: string | null; writer: string | null };
export type GapCandidate = { kind: GapKind; fact: string; question: string; building: string | null; evidence: GapEvidence[]; backedByTakeuchi: boolean;
  /** 既に会社の事実にある（id）＝知識はあるのに下書きに届かなかった。知識の穴ではなく材料の届き方の側 */
  knownFactId?: string | null };

/** 候補をまとめる（同じ種類・同じ物件で似方 0.45 以上は1つに）。裏取り＝根拠のどれかが竹内さんの送信 */
export function groupGapCandidates(items: Array<{ ex: GapExtract; ev: GapEvidence }>, threshold = 0.45): GapCandidate[] {
  const out: GapCandidate[] = [];
  for (const { ex, ev } of items) {
    if (!KNOWLEDGE_KINDS.has(ex.kind) || !ex.fact) continue;
    const hit = out.find((c) => c.kind === ex.kind && (c.building ?? "") === (ex.building ?? "") && factSimilarity(c.fact, ex.fact) >= threshold);
    if (hit) { hit.evidence.push(ev); hit.backedByTakeuchi ||= ev.writer === "takeuchi"; continue; }
    out.push({ kind: ex.kind, fact: ex.fact, question: ex.question, building: ex.building, evidence: [ev], backedByTakeuchi: ev.writer === "takeuchi" });
  }
  // 多い順（同数は会社の事実→手続き→一般→物件・新しい順）
  const order: Record<string, number> = { company: 0, procedure: 1, general: 2, property: 3 };
  return out.sort((a, b) => b.evidence.length - a.evidence.length || (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || b.evidence[0].at.localeCompare(a.evidence[0].at));
}

/** 作業員1の毎週の表（line-watch-miss-causes）に足す章の行（JSON で読み込める形） */
export type GapChapterRow = { turnId: number; scene: string | null; draftHead: string; staffHead: string; kind: GapKind; candidate: string; building: string | null; backed: boolean; staffMsgId: string | null };
export type GapChapter = {
  generatedAt: string; days: number;
  counts: { turns: number; vague: number; picked: number; byKind: Record<string, number>; knowledge: number; backed: number; ask: number; known: number; property: number };
  candidates: GapCandidate[];
  rows: GapChapterRow[];
};

const head = (s: string, n = 60) => s.replace(/\s+/g, " ").trim().slice(0, n);
export function gapChapterMarkdown(ch: GapChapter, top = 10): string {
  const c = ch.counts;
  const kinds = Object.entries(c.byKind).map(([k, v]) => `${GAP_KIND_JA[k as GapKind] ?? k} ${v}`).join("・");
  const lines = [
    "## 知識の弱さ（B の候補）",
    `直近 ${ch.days} 日の返信の番 ${c.turns} のうち、下書きがぼかした番 ${c.vague}・実送信が約束せずに答えた番 ${c.picked}（${kinds}）。`,
    `知識の候補 ${c.knowledge} 件（まとめた後）: 竹内さんの送信で裏が取れた「入れてよい候補」${c.backed}・竹内さんに聞く ○× ${c.ask}・既に会社の事実にある（届かなかった）${c.known}・物件の記録の候補 ${c.property}。スタッフだけが知る事（AIX の番）は知識の穴に数えない。`,
    "",
    `### 上位の候補 ${Math.min(top, ch.candidates.length)} 件`,
  ];
  ch.candidates.slice(0, top).forEach((k, i) => {
    const e = k.evidence[0];
    lines.push(`${i + 1}. 【${GAP_KIND_JA[k.kind]}${k.building ? `・${k.building}` : ""}】${k.fact}（${k.evidence.length}番・${({ known: `既に会社の事実 ${k.knownFactId} にある＝届かなかった`, property: `物件の記録の候補${k.backedByTakeuchi ? "（竹内さんの送信）" : ""}`, backed: `入れてよい候補（根拠 ${k.evidence.find((x) => x.writer === "takeuchi")?.staffMsgId ?? "?"}）`, ask: "竹内さんに聞く" } as const)[gapStatus(k)]}）`);
    lines.push(`   例 #${e.turnId}: 下書き「${head(e.draftHead)}」→ 実送信「${head(e.staffHead, 80)}」`);
  });
  const ask = ch.candidates.filter((k) => gapStatus(k) === "ask");
  if (ask.length) {
    lines.push("", `### 竹内さんに聞く ○×（${ask.length} 件）`);
    ask.forEach((k, i) => lines.push(`${i + 1}. ${k.question || `${k.fact}で合っていますか`}（${GAP_KIND_JA[k.kind]}・${k.evidence.length}番・例 #${k.evidence[0].turnId}）`));
  }
  return lines.join("\n");
}
