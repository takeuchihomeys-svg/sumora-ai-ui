// app/lib/brain-judge-examples.ts — 見張りで外れた番を「ブレインの判断の手本」にする（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-13 竹内さんの承認: 見張り（line-watch・決定論の採点係）の結果をブレインと試験に戻す。その2。
//   見張りで different（返信か AIX か・AIX の種類が違う）だった番の「その時の状況（場面・お客様の発言の要点・お客様の状態・台帳の事実）」と
//   「竹内さんの実際の一手（AIX の種類×ピッカー・手打ちの AIX の中身・返信の約束）」を短く集め（scripts/brain-judge-examples-build.ts →
//   app/lib/brain-judge-examples-data.ts）、同じ場面の番でブレインの材料に最大3件入れる。
//   P0「判断はすべてブレイン基準」: 手本は答えを決める規則ではなく、ブレインが文を読んで決める時の材料（上書きしない）。
//   置き場所: ブレインの材料の「3 毎回変わる並び」（customerSpecificText・キャッシュの印の無い所・場面の証拠の後ろ）＝system と会話専用ブロックのキャッシュは変えない。
//   前の調べ（brain-exam の BRAIN_EXAM_INJECT_FILE で判断の手本を足した試し）で 12問の道が 1→4。
// 戻す: BRAIN_JUDGE_EXAMPLES=off（2026-10-13 v2 の絞り込みの後に既定 on）
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
  // 2026-10-13: 混ざりの無い試験（YUMA3・11問）で道 8→5 に悪化（お礼・了承の場面で AIX を押した手本が効きすぎ）→ 一度 off に戻した。
  //   v2（場面の除外・一手が AIX の手本だけ・中身の近さ 0.12 以上）の後、同じ会話・同じ HEAD の off/on（YUMA2・b3476f98・関係する15問・混ざり 0）で
  //   道 9→10・合格 8→8・本質 8→10 → 既定 on。戻す: BRAIN_JUDGE_EXAMPLES=off
  return (env.BRAIN_JUDGE_EXAMPLES ?? "").trim().toLowerCase() !== "off";
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
/** 中身の2文字の組（漢字・カタカナ・英数を含む組だけ・どの依頼にも出る語の組は外す）。手本の近さはこれで測る（「ありがとうございます」で近くならない） */
const CONTENT_CH = /[一-龯々ァ-ヶー0-9A-Za-z]/;
const COMMON_BIGRAMS = new Set(["物件", "部屋", "お部", "宜し", "有難", "大丈", "丈夫", "今日", "明日", "本日", "確認", "可能"]);
function contentBigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); if ((CONTENT_CH.test(b[0]) || CONTENT_CH.test(b[1])) && !COMMON_BIGRAMS.has(b)) out.add(b); }
  return out;
}
/** 中身の近さ（中身の2文字の組の Jaccard） */
export function contentSim(a: string, b: string): number {
  const A = contentBigrams(a), B = contentBigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
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

/** 手本を入れない場面（発言の中身で一手が決まらない・前の流れで決まる番） */
export const JUDGE_EXAMPLE_SKIP_SCENES: ReadonlySet<ReplyScene> = new Set<ReplyScene>(["ack", "considering", "other"]);
/** 今の発言と手本の発言の近さの下限（2文字の組の重なり） */
export const JUDGE_EXAMPLE_MIN_SIM = Number((typeof process !== "undefined" ? process.env.BRAIN_JUDGE_EXAMPLES_MIN_SIM : "") || 0.12);

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
  // v2（2026-10-13 試験 YUMA3 で道 8→5 の後）: 発言で一手が決まらない場面（お礼・了承・検討中・その他）は入れない／
  //   竹内さんの一手が AIX（押した・手打ちの AIX の中身）の番だけ（「返信」の手本は2段の約束と食い違って AIX の番を返信に寄せた）／
  //   時刻で押す AIX（内覧後の挨拶・追客）は入れない／今の発言と近い番だけ（場面が同じでも別の依頼の番は外す）
  if (JUDGE_EXAMPLE_SKIP_SCENES.has(scene)) return [];
  const pool = all.filter((e) => e.scene === scene && e.conv !== ctx.conversationId && !ex.has(e.conv) && !seenIn(e, hist, histFp)
    && e.actual.startsWith("AIX") && !/greeting_viewing|followup_revive/.test(e.actual) && contentSim(text, e.customer) >= JUDGE_EXAMPLE_MIN_SIM);
  if (!pool.length) return [];
  const newest = Math.max(...pool.map((e) => Date.parse(e.at) || 0));
  const scored = pool.map((e) => {
    const ageDays = Math.max(0, (newest - (Date.parse(e.at) || 0)) / 86_400_000);
    return { e, s: contentSim(text, e.customer) + (e.writer === "takeuchi" ? 0.05 : 0) + Math.max(0, 0.03 - ageDays * 0.001) };
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
