// app/lib/reply-scene-brain.ts — 返信の「場面」をブレインの判断を主にして決める（11巡目・2026-10-08 竹内さん
//   「場面の読み取りを、ブレインの判断に寄せる。ブレインが判断。一緒に行う。設計知見と協力して徹底的に行う」）。
//
// なぜ: 返信の材料の取捨・PHASE_GUIDE の絞り・手本の並べ・注記を決める「場面」（reply-scene.resolveReplyScene）は、お客様の文の語だけで決めていた。
//   ブレイン（brain-core）は同じ番を会話全体・台帳・約束を読んで意図・質問・条件変更・迷い・AIX を判断しているのに、場面はそれを見ていなかった＝二重の判断で食い違う。
//   40日 943番（scripts/audit-word-vs-brain.ts）: 語は「その他」でブレインは質問あり 23・語は短いお礼でブレインは質問/条件 15・語は条件でブレインは質問 11・
//   語は費用でブレインは費用の質問なし 9・語は申込でブレインは申込と無関係 5。
//
// 決め方（ブレインが今の番を見て判断している時＝fresh。語の場面を出発点に、ブレインが「はっきり言った事」で上書きする）:
//   ①形の場面（語の解釈でなく形で決まる）: スタンプだけ・書類の画像・条件のフォーム・物件の URL/画像 → 語のまま
//   ②ブレインの「今の番」の判断（引きずりを外した物）:
//     条件変更（condition_change_type・scope≠none）→ 条件／今の番の質問 → 質問の中身と AIX で 費用・内覧・申込・質問／
//     迷い（hesitancy の保留＝thinking・callback・waiting・timeline）→ 検討中（語が「その他」の時だけ）／申込・内覧の意思（decision＋AIX）→ 申込・内覧／雑談の短い一言（chat・40字以内・問いの形なし）→ 短いお礼
//   ③ブレインが判断していない時（夜の見送り・失敗・古い判断・cached）は語の場面だけ（予備）
// 引きずり（40日の変わる番 240 を1番ずつ読んだ・scripts/audit-r11-scene-brain.ts・10/08）:
//   ブレインの質問・条件変更・迷いは「今の番」がお礼・了承だけの時に前の発言の物を引きずる（「お願いします」に cond=equip_add・「こんにちは！」に hes=callback・
//   「承知致しました。宜しくお願い致します。」に q=前の募集確認）。内覧当日の連絡（「5分から10分ほど遅れます」）・電話の連絡にも前の cond が残る。
//   → 語が短いお礼・了承の番は ブレインの質問・条件変更・迷いを使わない（申込・内覧の意思＋AIX だけ使う）／内覧当日の連絡・電話の連絡は条件変更を使わない／
//     迷いは語が「その他」の番だけ（「もう少し探していただけますか？」に hes=callback が付き、検討中にすると人の「新着状況随時確認…」と外れる）
// 戻す: REPLY_SCENE_BRAIN=off（語の場面だけ＝旧）。テストは generate-reply の testFlags.scene_brain="off"|"on"
import { resolveReplyScene, type ReplyScene } from "./reply-scene";
import { isViewingDayNotice } from "./reply-subscene";

export function replySceneBrainEnabled(env: Record<string, string | undefined> = process.env, override?: string | null): boolean {
  if (override === "off") return false;
  if (override === "on") return true;
  return (env.REPLY_SCENE_BRAIN ?? "").toLowerCase() !== "off";
}

// ─── 質問の引きずり ───────────────────────────────────────────
const PUNCT_RE = /[\s\p{P}\p{S}\p{Extended_Pictographic}\u{FE0F}]/gu;
/** 中身の2文字（漢字・カタカナ・英数を1字以上含む）。ひらがなだけの2文字（「ですか」等）は数えない */
function contentBigrams(s: string): Set<string> {
  const t = String(s ?? "").normalize("NFKC").replace(PUNCT_RE, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); if (/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(g)) out.add(g); }
  return out;
}
/** ブレインの質問（言い換え）の中身の語が、文にどれだけ出てくるか（0〜1） */
export function questionTurnOverlap(question: string, text: string): number {
  const q = contentBigrams(question.replace(/について|を?知りたい|を?教えてほしい|の?確認|したい|は?可能か|できるか|はあるか|はいつか|かどうか|詳細|募集状況/g, ""));
  if (!q.size) return 0;
  const t = String(text ?? "").normalize("NFKC").replace(PUNCT_RE, "");
  let hit = 0; for (const g of q) if (t.includes(g)) hit++;
  return hit / q.size;
}
/**
 * ブレインの質問を「今の番の質問」と「前の発言から引きずった質問」に分ける。
 * 引きずり＝今の番が短いお礼・了承・スタンプだけ（reply-scene の ack＝語を剥がした残りが3字以下）で、質問の中身の語が今の番に重ならない（0.25 未満）物。
 *   線の決め方（40日 1,620番・質問 980・scripts/audit-r11-brain-q-drag.ts を目で読んだ・10/08）:
 *   ①前の発言との重なりで引く版は、ブレインが「ここ」「こちら」を物件名に読み替えた今の質問を全部「引きずり」と誤った（43中 約20）
 *   ②問いの形（？・ですか 等）が無い番で引く版も「見てみたいです」「見積もりだしていただきたいです」「〜ってことですよね」「確認だけお願いします」を誤った
 *   ③短いお礼・了承だけの番に絞ると誤りが無い（「承知致しました。宜しくお願い致します。」→ q=前の募集確認 等・40日 8番）
 *   ⚠ 引きずりの中には「前に聞いてまだ応えていない質問」もある（58ae93f3: お礼の番でスタッフは前の名義の質問に答えた）＝場面の判定（材料の取捨）にだけ使い、
 *     ブレインの質問欄・必ず含める内容そのものは消さない。
 */
export function splitThisTurnQuestions(questions: readonly string[] | null | undefined, burstText: string): { kept: string[]; dragged: string[] } {
  const kept: string[] = [], dragged: string[] = [];
  const t = String(burstText ?? "").normalize("NFKC");
  const ackOnly = resolveReplyScene({ customerText: burstText }).scene === "ack";
  for (const q of questions ?? []) {
    if (!q || !q.trim()) continue;
    if (ackOnly && questionTurnOverlap(q, t) < 0.25) dragged.push(q); else kept.push(q);
  }
  return { kept, dragged };
}

// ─── 場面 ───────────────────────────────────────────
export type BrainSceneInput = {
  /** ブレインが今の番（最後のお客様の発言）を見て判断したか（fresh かつ cached でない） */
  fresh: boolean;
  intent?: string | null;
  questions?: readonly string[] | null;
  conditionChangeType?: string | null;
  conditionChangeScope?: string | null;
  hesitancy?: string | null;
  action?: string | null;
  replyMode?: string | null;
};
export type SceneSource = "structure" | "brain" | "word";
export type BrainSceneResult = { scene: ReplyScene; evidence: string; source: SceneSource; wordScene: ReplyScene; wordEvidence: string; questions: string[]; dragged: string[] };

const STRUCTURE_EVIDENCE = new Set(["stamp_only", "document_image", "condition_form", "image", "portal/image_text", "empty"]);
const COST_Q_RE = /初期費用|費用|見積|総額|いくら|金額|割引|安く|値下|日割|敷金|礼金|仲介手数料|頭金|支払|分割|一括|前払|カード払/;
const VIEWING_Q_RE = /内覧|内見|見学|待ち合わせ|現地|集合/;
const APPLY_Q_RE = /申込|申し込|審査|契約|保証(?:会社|人)|書類|名義|在籍|抑え|押さえ/;
const VIEWING_ACTIONS = new Set(["viewing_invite", "meeting_place", "greeting_viewing"]);
const COST_ACTIONS = new Set(["estimate_sheet", "cost_explain", "cost_breakdown"]);
/** 今の番に問い・依頼の形があるか（短いお礼に倒す時の歯止め） */
const ASK_FORM_RE = /[？?]|ですか|ますか|でしょうか|可能|いけます|行けます|教えて|知りたい|ほし(?:い|く)|欲し(?:い|く)|聞いて|もらえ|貰え|頂け|いただけ|下さい|ください|できない|出来ない/;

/** ブレインの今の番の質問から場面（費用 → AIX → 申込 → 内覧 → 質問の順。費用の質問が1つでもあれば費用＝見積の関門・材料を残す） */
function sceneOfQuestions(qs: readonly string[], action: string | null): { scene: ReplyScene; evidence: string } {
  const j = qs.join(" / ");
  if (COST_Q_RE.test(j)) return { scene: "cost", evidence: "brain_q:cost" };
  // 電話の時間の質問（「14:30-15:00くらいに掛けても大丈夫でしょうか？」に AIX=待ち合わせ・58ae93f3）は AIX で内覧・費用にしない
  if (/電話/.test(j) && !VIEWING_Q_RE.test(j)) return { scene: "question", evidence: "brain_q:phone" };
  if (action && COST_ACTIONS.has(action)) return { scene: "cost", evidence: `brain_q+aix:${action}` };
  if (action && VIEWING_ACTIONS.has(action)) return { scene: "viewing", evidence: `brain_q+aix:${action}` };
  if (action === "application_push") return { scene: "apply", evidence: "brain_q+aix:application_push" };
  if (APPLY_Q_RE.test(j)) return { scene: "apply", evidence: "brain_q:apply" };
  if (VIEWING_Q_RE.test(j)) return { scene: "viewing", evidence: "brain_q:viewing" };
  return { scene: "question", evidence: "brain_q" };
}

/** 返信の場面（ブレインの判断を主に・語は出発点と予備） */
export function resolveReplySceneBrainFirst(i: { customerText: string; brain: BrainSceneInput | null; enabled?: boolean }): BrainSceneResult {
  const text = String(i.customerText ?? "");
  const w = resolveReplyScene({ customerText: text });
  const base = { wordScene: w.scene, wordEvidence: w.evidence };
  const b = i.brain;
  if (i.enabled === false || !b || !b.fresh) return { scene: w.scene, evidence: w.evidence, source: "word", ...base, questions: [], dragged: [] };
  const sp = splitThisTurnQuestions(b.questions, text);
  const out = (scene: ReplyScene, evidence: string, source: SceneSource = "brain"): BrainSceneResult => ({ scene, evidence, source, ...base, questions: sp.kept, dragged: sp.dragged });
  const keep = (why = "brain_agrees") => out(w.scene, `${w.evidence}(${why})`, "word");
  // ① 形の場面
  if (STRUCTURE_EVIDENCE.has(w.evidence)) return out(w.scene, w.evidence, "structure");
  const action = b.action ?? null;
  const ackWord = w.scene === "ack";
  const dayNotice = isViewingDayNotice(text);
  // 引きずりの歯止め: 短いお礼・了承／内覧当日の連絡／電話の連絡 はブレインの条件変更を使わない
  const cond = b.conditionChangeType && b.conditionChangeScope !== "none" && !ackWord && !dayNotice && w.evidence !== "phone" ? b.conditionChangeType : null;
  const qs = ackWord ? [] : sp.kept;
  const decision = b.intent === "decision" && action
    ? (VIEWING_ACTIONS.has(action) ? "viewing" as const : action === "application_push" ? "apply" as const : null) : null;
  const core = text.normalize("NFKC").replace(PUNCT_RE, "");
  // 雑談の短い一言（chat だけ。positive＝物件・見積への評価「こんなに安いんですね！」「いいですね！」は訴求の材料が要るので短いお礼にしない＝reply-scene の ack_with_appraisal と同じ考え）
  //   挨拶・友だち追加・紹介の連絡は reply-subscene の「挨拶・友だち追加」「紹介」で別に見るので外す
  const shortChat = b.intent === "chat" && core.length <= 40 && !ASK_FORM_RE.test(text) && !/すみません|申し訳|ごめん|追加させ|紹介|はじめまして/.test(text);
  // 迷い: 保留（考える・また連絡・待って・時期）だけ。undecided（2つで迷う）は内覧・オススメで背中を押す番（ae18c038「どっちも気になります」→ 竹内さん「一度ご内覧如何でしょうか」）。挨拶だけの番に残った迷いは引きずり
  const hes = b.hesitancy && ["thinking", "callback", "waiting", "timeline"].includes(b.hesitancy) && !/^(?:こんにちは|こんばんは|こんばんわ|おはよう(?:ございます)?)$/.test(core) ? b.hesitancy : null;
  // 電話の連絡（「14:30-15:00くらいに掛けても大丈夫でしょうか？」）はブレインの AIX（待ち合わせ 等）で内覧にしない＝質問の中身だけで
  const q = qs.length ? sceneOfQuestions(qs, w.evidence === "phone" ? null : action) : null;
  switch (w.scene) {
    case "ack":
      return decision ? out(decision, `brain_decision+aix:${action}`) : keep(b.conditionChangeType || b.hesitancy || sp.dragged.length ? "ack_ignores_dragged" : "brain_agrees");
    case "viewing":
      if (dayNotice) return keep("viewing_day_notice");
      if (cond) return out("conditions", `brain_cond:${cond}`);
      if (q && (q.scene === "cost" || q.scene === "apply")) return out(q.scene, q.evidence);
      return keep();
    case "other":
      if (cond) return out("conditions", `brain_cond:${cond}`);
      if (q) return out(q.scene, q.evidence);
      if (hes) return out("considering", `brain_hes:${hes}`);
      if (decision) return out(decision, `brain_decision+aix:${action}`);
      if (shortChat) return out("ack", "brain_chat_short(word:other)");
      return keep();
    case "question":
    case "apply":
    case "considering":
      if (cond) return out("conditions", `brain_cond:${cond}`);
      // 検討中の語の番で問いの形が無いのにブレインが質問を挙げた時は、お客様の予定・状況の言い換え（f193d13d「行ける日分かりましたらまた連絡」→ q=「…分かったら連絡する」＋AIX 内覧調整）＝検討中のまま（YUMA の再生 r11b で見つけた・10/08）
      if (q && !(w.scene === "considering" && !ASK_FORM_RE.test(text))) return out(q.scene, q.evidence);
      if (decision && w.scene !== "apply") return out(decision, `brain_decision+aix:${action}`);
      if (shortChat && w.scene !== "considering") return out("ack", `brain_chat_short(word:${w.scene})`);
      return keep();
    case "cost":
      if (cond && !(q && q.scene === "cost" && action === "estimate_sheet")) return out("conditions", `brain_cond:${cond}`);
      if (q) return out(q.scene, q.evidence);
      if (shortChat) return out("ack", "brain_chat_short(word:cost)");
      return keep();
    case "conditions":
      if (cond) return keep("brain_cond");
      if (q) return out(q.scene, q.evidence);
      if (decision) return out(decision, `brain_decision+aix:${action}`);
      if (shortChat) return out("ack", "brain_chat_short(word:conditions)");
      return keep();
    default:
      return keep();
  }
}
