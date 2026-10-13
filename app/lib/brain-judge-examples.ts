// app/lib/brain-judge-examples.ts — 見張りで外れた番を「ブレインの判断の手本」にする（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-13 竹内さんの承認: 見張り（line-watch・決定論の採点係）の結果をブレインと試験に戻す。その2。
//   見張りで different（返信か AIX か・AIX の種類が違う）だった番の「その時の状況（場面・お客様の発言の要点・お客様の状態・台帳の事実）」と
//   「竹内さんの実際の一手（AIX の種類×ピッカー・手打ちの AIX の中身・返信の約束）」を短く集め（scripts/brain-judge-examples-build.ts →
//   app/lib/brain-judge-examples-data.ts）、同じ場面の番でブレインの材料に最大3件入れる。
//   P0「判断はすべてブレイン基準」: 手本は答えを決める規則ではなく、ブレインが文を読んで決める時の材料（上書きしない）。
//   置き場所: ブレインの材料の「3 毎回変わる並び」（customerSpecificText・キャッシュの印の無い所・場面の証拠の後ろ）＝system と会話専用ブロックのキャッシュは変えない。
//   前の調べ（brain-exam の BRAIN_EXAM_INJECT_FILE で判断の手本を足した試し）で 12問の道が 1→4。
// 入れる: BRAIN_JUDGE_EXAMPLES=on（2026-10-13 は試験の前後が出るまで既定 off）
import { resolveReplyScene, REPLY_SCENE_JA, type ReplyScene } from "./reply-scene";

export type JudgeExample = {
  /** 元の番（line_watch_turns の鍵）。同じ会話の番は手本にしない */
  conv: string;
  at: string;
  scene: ReplyScene;
  /** お客様の発言の要点（伏せた・最大120字） */
  customer: string;
  /** その時の状況（段階・気持ち・直前の AIX・指す物件の有無 等を短く） */
  state: string;
  /** AI（ブレイン）が選んだ道 */
  brain: string;
  /** 竹内さん（スタッフ）の実際の一手 */
  actual: string;
  /** 外れの理由（line-watch-judge の reason） */
  reason: string;
  /** 書いた人（takeuchi｜employee｜unknown） */
  writer: "takeuchi" | "employee" | "unknown";
  /** 元の会話の指紋（番より前のお客様の発言の短い指紋・最初の4通＋直前の20通）。今の会話の発言と1つでも合えば同じ会話＝手本にしない（試験の写しで先の番の答えが漏れない） */
  fp?: string[];
};

/** 発言の指紋（伏せ字・記号・空白を除いた頭40字の FNV-1a）。12字未満の発言は指紋にしない（決まり文句が他の会話と合う） */
export function textFingerprint(t: string): string | null {
  const n = norm(t).replace(/[〇○◯*＊]/g, "").slice(0, 40);
  if (n.length < 12) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < n.length; i++) { h ^= n.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export function judgeExamplesEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-10-13: 試験（関係する問題）の前後が出るまで既定 off（BRAIN_JUDGE_EXAMPLES=on で入れる）。結果を見て既定 on に変える
  return (env.BRAIN_JUDGE_EXAMPLES ?? "").trim().toLowerCase() === "on";
}

/** 見張りの理由のうち「道（返信か AIX か・AIX の種類）」の外れ（文の言い回し・事実の違いは入れない） */
export const PATH_MISS_REASONS: ReadonlySet<string> = new Set(["aix_other", "aix_but_text", "text_but_aix", "text_but_staff_fact", "no_reply_needed_but_sent"]);

const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}！!。、,，・〇]/gu, "");
function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
/** 2文字の組の重なり（Jaccard） */
export function textSim(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** この会話に既に出ているお客様の発言と同じ番（試験の写し・同じ会話）か。短い決まり文句（6字未満）は見ない */
export const SAME_TURN_SIM = 0.6;
function seenIn(ex: JudgeExample, history: ReadonlyArray<string>, histFp: ReadonlySet<string>): boolean {
  if (ex.fp?.some((f) => histFp.has(f))) return true;
  if (norm(ex.customer).length < 6) return false;
  return history.some((h) => norm(h).length >= 6 && textSim(ex.customer, h) >= SAME_TURN_SIM);
}

/**
 * 今の番に入れる手本（最大 max 件）。同じ場面だけ・同じ会話と、この会話に既に出ている発言の番は外す（答えが漏れない）。
 *   並べ方: 発言の近さ＋竹内さんの番＋新しさ。近さが同じなら新しい方
 */
export function pickJudgeExamples(all: ReadonlyArray<JudgeExample>, ctx: {
  customerText: string; conversationId?: string | null; historyCustomerTexts?: ReadonlyArray<string>; max?: number; scene?: ReplyScene | null; excludeConversationIds?: ReadonlyArray<string>;
}): JudgeExample[] {
  const text = String(ctx.customerText ?? "").trim();
  if (!text) return [];
  const scene = ctx.scene ?? resolveReplyScene({ customerText: text }).scene;
  const hist = ctx.historyCustomerTexts ?? [];
  const max = ctx.max ?? 3;
  const histFp = new Set(hist.map(textFingerprint).filter((x): x is string => !!x));
  // 試験（scripts/brain-exam.ts）は問題の元の会話を BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV で渡す（写しの会話 id は元と違う＝指紋で外し切れない番がある）
  const envEx = new Set((typeof process !== "undefined" ? process.env.BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV ?? "" : "").split(",").map((x) => x.trim()).filter(Boolean));
  const ex = new Set([...(ctx.excludeConversationIds ?? []), ...envEx]);
  const pool = all.filter((e) => e.scene === scene && e.conv !== ctx.conversationId && !ex.has(e.conv) && !seenIn(e, hist, histFp));
  if (!pool.length) return [];
  const newest = Math.max(...pool.map((e) => Date.parse(e.at) || 0));
  const scored = pool.map((e) => {
    const ageDays = Math.max(0, (newest - (Date.parse(e.at) || 0)) / 86_400_000);
    return { e, s: textSim(text, e.customer) + (e.writer === "takeuchi" ? 0.15 : 0) + Math.max(0, 0.1 - ageDays * 0.002) };
  }).sort((a, b) => b.s - a.s || Date.parse(b.e.at) - Date.parse(a.e.at));
  // 同じ一手ばかりにしない（同じ actual は1件まで）
  const out: JudgeExample[] = [];
  const seen = new Set<string>();
  for (const { e } of scored) {
    if (seen.has(e.actual)) continue;
    seen.add(e.actual);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/** ブレインの材料の文（無ければ空） */
export function judgeExamplesBrainText(picked: ReadonlyArray<JudgeExample>): string {
  if (!picked.length) return "";
  const lines = picked.map((e, i) => `${i + 1}. お客様「${e.customer}」／状況: ${e.state || "-"}\n   AI の判断: ${e.brain} → 竹内さんの実際の一手: ${e.actual}`);
  return `\n\n【判断の手本（同じ場面「${REPLY_SCENE_JA[picked[0].scene]}」で AI の判断が竹内さんの実際と違った過去の番・見張りの記録から）】
${lines.join("\n")}
※ 竹内さんが「返信か AIX か・どの AIX か」をどう決めたかの参考。スタッフだけが知る事（確認の結果・空き・金額・内覧の日程）は AIX の番。今の会話の事実（台帳・送った物件・段階）に合わない一手は真似しない。`;
}

/** 番の一手の書き方（build スクリプト用・純関数）。押した AIX → 手打ちの AIX の中身 → 返信の行為 の順 */
export function describeActualMove(o: {
  burstPress: Array<{ aix_type: string; check_pattern?: string | null }>;
  laterPress?: Array<{ aix_type: string }>;
  staffFacts?: Array<{ kind: string; key: string; family: string }>;
  staffActs?: string[];
  actJa?: Record<string, string>;
  aixJa?: Record<string, string>;
}): string {
  const aj = (a: string) => (o.aixJa?.[a] ? `${o.aixJa[a]}（${a}）` : a);
  const later = (o.laterPress ?? []).filter((p) => !o.burstPress.some((b) => b.aix_type === p.aix_type));
  const tail = later.length ? `（その後 AIX ${[...new Set(later.map((p) => aj(p.aix_type)))].join("・")}）` : "";
  if (o.burstPress.length) {
    const ps = [...new Set(o.burstPress.map((p) => `AIX【${aj(p.aix_type)}${p.check_pattern ? `／${p.check_pattern}` : ""}】`))];
    return `${ps.join("＋")}${tail}`;
  }
  if (o.staffFacts?.length) {
    const keys = [...new Set(o.staffFacts.map((f) => f.key))];
    return `AIX の中身（スタッフだけが知る事: ${keys.join("・")}）を手打ちで送った＝AIX の番${tail}`;
  }
  const acts = (o.staffActs ?? []).map((a) => o.actJa?.[a] ?? a);
  return `返信${acts.length ? `（${acts.join("・")}）` : ""}${tail}`;
}
