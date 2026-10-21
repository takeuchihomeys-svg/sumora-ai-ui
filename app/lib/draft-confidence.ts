// app/lib/draft-confidence.ts — 下書きの「自信」を数字で持つ（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-21 竹内さん（設計知見 a5838a0b「①自信の気づき」・b01d793d「自信が無いと気づく」）:
//   自信を数字で持ち、低い番は人へ・高い番だけ（将来）自動送信の土台にする。自己申告だけに頼らず、今ある印から決まった計算で出す。
//   ※ 自動送信はここでは作らない（設計知見 ddd883fb「送ってよい条件を全部満たした時だけ・既定は送らない」）。ここは「低い時に人へ印を出す」まで。
//
// 物差し（理由つきで点を引く・100点から）:
//   最終チェック … 直せなかった block（fc_block）・残った warning（fc_warn）・書き直しても直らない（fc_exhausted）・直す前に指摘があった（fc_revised＝難しい番）
//   ブレイン   … 返信でなく AIX を指している（brain_wants_aix）・スタッフの確認が要る AIX を指している（brain_staff_aix）
//                LLM の判断を決まった規則が変えた（rule_override＝司令塔とつなぎの食い違い）・物件の見立てがゲートで落ちた（property_dropped）
//                追加の調査をかけた（deep_check＝材料が足りない番）
//   下書きの文 … スタッフしか知らない事を言い切る（staff_only_fact）・材料に無い日付/号室/物件名/金額（ungrounded_fact）
//                会社の事実に反する断定（company_fact・設計知見 975c5d86 の作り話の型）・AIX の中身の言い切り（aix_content）
//   お客様の番 … センシティブ（クレーム・否決・キャンセル）・審査に関わる人の事情（screening_sensitive）・質問が多い（multi_ask）・初めての返信（first_contact）
//   場面の慣れ … 過去にその場面の下書きがそのまま送られた率（scene_prior・試験の弱い型と同じ考え）・場面の前例が少ない（novel_scene）
//   将来の印   … 読み手の割れ（reader_split）・つなぎの切れ（link_break）（D案・つなぎのブレインが出す。今は入力が無ければ数えない）
//
// 重みは scripts/audit-draft-confidence.ts（本番の見張り line_watch_turns の下書き × スタッフが実際にした事・LLM なし・読むだけ）で決めた。
//   線を引き直す時はそのスクリプトを回して、段ごとの「そのまま送られた率」が high ≫ low になっている事を確かめる。
// 切替: DRAFT_CONFIDENCE=on で生成時に計算して最終チェックの結果（ai_draft_check.confidence）に載せる（既定 off＝何もしない）
import { findStaffOnlyFact, findUngroundedAmount, STAFF_CONFIRM_AIX } from "./staff-confirm-facts";
import { findUngroundedFacts } from "./draft-fact-grounding";
import { findCompanyFactContradictionsUngated } from "./company-fact-guard";
import { detectSensitiveCase } from "./sensitive-case";
import { screeningSensitiveSignal } from "./screening-sensitive";
import { classifyAixContent } from "./aix-content-gate";
import { DRAFT_CONFIDENCE_SCENE_PRIORS, DRAFT_CONFIDENCE_PRIOR_BASE } from "./draft-confidence-priors";

export const DRAFT_CONFIDENCE_VERSION = "dc-2026-10-21";

/** 切替（既定 off）。on の時だけ generate-reply が計算して載せる・画面が印を出す・自動返信の関所が低い番を止める */
export function draftConfidenceEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-10-21 確かめ役「画面の低の印と自動返信を人に残す側だけなら on でよい」→ 既定 on（止める DRAFT_CONFIDENCE=off）。高＝送ってよいの根拠にはまだしない
  return (env.DRAFT_CONFIDENCE ?? "").trim().toLowerCase() !== "off";
}

export type ConfidenceBand = "high" | "mid" | "low";
export type ConfidenceCode =
  | "fc_block" | "fc_exhausted" | "fc_warn" | "fc_revised"
  | "brain_wants_aix" | "brain_staff_aix" | "rule_override" | "property_dropped" | "deep_check"
  | "staff_only_fact" | "ungrounded_fact" | "company_fact" | "aix_content"
  | "sensitive" | "screening_sensitive" | "multi_ask" | "first_contact" | "long_draft"
  | "ack_only_turn" | "cust_date" | "draft_schedule" | "draft_asks_back" | "condition_form" | "pickup_promise"
  | "scene_prior_low" | "scene_prior_high" | "novel_scene"
  | "reader_split" | "link_break";

export const CONFIDENCE_CODE_JA: Record<ConfidenceCode, string> = {
  fc_block: "最終チェックの要修正が残っている", fc_exhausted: "書き直しても直らなかった", fc_warn: "最終チェックの指摘が残っている",
  fc_revised: "最初の下書きに指摘があった（直した後）",
  brain_wants_aix: "ブレインは AIX を指している", brain_staff_aix: "スタッフの確認が要る場面",
  rule_override: "AI の判断を規則が変えた（食い違い）", property_dropped: "物件の見立てが確かめられなかった", deep_check: "材料が足りず追加で調べた番",
  staff_only_fact: "スタッフしか知らない事を書いている", ungrounded_fact: "会話に無い日付・号室・物件名・金額",
  company_fact: "会社の事実に反する言い切り", aix_content: "AIX で送る中身の言い切り",
  sensitive: "クレーム・否決・キャンセルの番", screening_sensitive: "審査に関わる事情の番", multi_ask: "質問が多い番",
  first_contact: "初めての返信", long_draft: "長い下書き",
  ack_only_turn: "短いお礼・了承だけの番（言い過ぎやすい）", cust_date: "お客様が日にち・時刻を言った番", draft_schedule: "下書きが内覧・日時を段取りしている",
  draft_asks_back: "下書きがお客様に聞き返している", condition_form: "条件の長い文（型どおりの番）", pickup_promise: "ピックアップの約束（型どおりの番）",
  scene_prior_low: "この場面は過去によく直されている", scene_prior_high: "この場面は過去にそのまま送られている", novel_scene: "前例の少ない場面",
  reader_split: "読み手の読みが割れた", link_break: "渡るべき物が届いていない",
};

/**
 * 点の重み（引く点・負は足す点）。2026-10-21 scripts/audit-draft-confidence.ts --fit（見張りの 1,198番・LLM なし）:
 *   古い 60%（〜9/14）で「中身が合った」の見込み比（対数×20）を当てはめ、新しい 40%（9/14〜10/21・480番）で確かめた。
 *   件数が少ない印（会社の事実・センシティブ・AIX の中身 等・15件未満）は決めた重みのまま（作り話・圧の型は1通でも人へ）。
 *   古い半分と新しい半分で向きが揺れた印（長い下書き・場面の前例の低さ）は軽くした。
 *   分かった事: ブレインが AIX を指していても、下書きがある番の下書きは他の番と同じくらい使われていた（0点＝数えるだけ）。
 *     効いたのは「下書きが内覧・日時を段取りしている」「お客様に聞き返している」「スタッフしか知らない事」（どれもそのまま率が半分以下）。
 */
export const CONFIDENCE_WEIGHTS: Record<ConfidenceCode, number> = {
  fc_block: 30, fc_exhausted: 15, fc_warn: 4, fc_revised: 4,
  brain_wants_aix: 0, brain_staff_aix: 0, rule_override: 4, property_dropped: 0, deep_check: 6,
  staff_only_fact: 20, ungrounded_fact: 15, company_fact: 25, aix_content: 12,
  sensitive: 25, screening_sensitive: 15, multi_ask: 5, first_contact: -7, long_draft: 8,
  ack_only_turn: 4, cust_date: 6, draft_schedule: 22, draft_asks_back: 30, condition_form: -8, pickup_promise: -12,
  scene_prior_low: 8, scene_prior_high: -6, novel_scene: 0,
  reader_split: 15, link_break: 10,
};

/** 段の線（点 → 段）。低の割合は 1割前後に抑える（オオカミ少年にしない・D案 7-1「低は 15% 以下」） */
export const CONFIDENCE_HIGH_MIN = 90;
export const CONFIDENCE_LOW_MAX = 65;
/** 足す点の上限（型どおりの番でも、危ない印の引く点はほぼそのまま効かせる） */
export const CONFIDENCE_BONUS_CAP = 10;

export type ConfidenceIssue = { code?: string | null; severity?: string | null };
export type ConfidenceInput = {
  draft: string | null | undefined;
  /** この番のお客様の発言（連投をつないだ物） */
  customerText: string | null | undefined;
  /** 材料（直近の会話・条件 等）。下書きの事実の照らしに使う */
  groundText?: string | null;
  convStatus?: string | null;
  /** 最終チェックの結果（ai_draft_check の形 or 見張りの final_check の形） */
  finalCheck?: {
    ok?: boolean | null;
    issues?: ReadonlyArray<ConfidenceIssue> | null;
    revisionExhausted?: boolean | null;
    regenCount?: number | null;
    /** 直す前の指摘（"CODE:severity" の文字列） */
    preIssues?: ReadonlyArray<string> | null;
  } | null;
  brain?: {
    replyMode?: string | null;
    action?: string | null;
    /** LLM が選んだ AIX（決まった規則で変わる前） */
    llmAction?: string | null;
    property?: string | null;
    /** LLM が出した物件（実在ゲートの前） */
    llmProperty?: string | null;
    questions?: number | null;
    deepCheck?: boolean | null;
  } | null;
  isFirstContact?: boolean | null;
  /** 場面の鍵（line-watch-turn sceneKeyOf の key） */
  sceneKey?: string | null;
  /** 将来: D案の読み手の割れ・つなぎのブレインの切れの数 */
  readerSplit?: boolean | null;
  linkBreaks?: number | null;
  /** 場面の前例の表（既定は draft-confidence-priors.ts）。試しの時に古い半分だけで作った表を渡す */
  priors?: Readonly<Record<string, { n: number; asIs: number }>> | null;
  priorBase?: number | null;
};

export type ConfidenceReason = { code: ConfidenceCode; ja: string; delta: number; note?: string };
export type DraftConfidence = {
  v: string;
  score: number;
  band: ConfidenceBand;
  reasons: ConfidenceReason[];
};

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");
const AIX_ACTION_NULL = new Set(["", "null", "none", "undefined"]);
const actionOf = (a: string | null | undefined) => { const s = String(a ?? "").trim(); return AIX_ACTION_NULL.has(s) ? "" : s; };

// 文の型（scripts/audit-draft-confidence.ts で数えて選んだ。網は粗くてよい＝点を少し動かすだけ）
const DRAFT_SCHEDULE_RE = /内覧|内見|\d{1,2}[/月]\d{1,2}|\d{1,2}(?::\d{2}|時)/;
const DRAFT_ASK_BACK_RE = /[?？]|でしょうか|ますか[。！!😊😌]*$/m;
const PICKUP_PROMISE_RE = /ピックアップ|お探し(?:させて|いたし|致し)|探して(?:お送り|ご連絡)/;
const ACK_ONLY_RE = /ありがと|了解|承知|わかりました|分かりました|お願いします|お願い致します|はい|OK|大丈夫/i;
const CUST_DATE_RE = /\d{1,2}[/月]\d{1,2}|明日|明後日|今日|今週|来週|土曜|日曜|土日|平日|何時|\d{1,2}時/;

/** お客様の質問の数（？・〜ますか・〜でしょうか 等の文の数）。ブレインの数と大きい方 */
export function countCustomerAsks(text: string | null | undefined): number {
  const t = norm(text);
  if (!t.trim()) return 0;
  const parts = t.split(/(?<=[?？])|\n+|(?<=[。！!])/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((s) => /[?？]$|(?:ますか|ですか|でしょうか|ませんか|かな|ますでしょうか)[。！!😊]*$|(?:教えて|知りたい)/.test(s)).length;
}

/** 印を集める（点は付けない） */
export function confidenceSignals(i: ConfidenceInput): Array<{ code: ConfidenceCode; note?: string }> {
  const out: Array<{ code: ConfidenceCode; note?: string }> = [];
  const draft = String(i.draft ?? "").trim();
  const cust = String(i.customerText ?? "");
  const ground = [i.groundText ?? "", cust].join("\n");

  // ── 最終チェック ──
  const fc = i.finalCheck ?? null;
  if (fc) {
    const issues = fc.issues ?? [];
    const blocks = issues.filter((x) => x.severity === "block");
    const warns = issues.filter((x) => x.severity === "warning" || x.severity === "warn");
    if (blocks.length || fc.ok === false) out.push({ code: "fc_block", note: blocks.map((b) => b.code).filter(Boolean).slice(0, 3).join(",") });
    if (fc.revisionExhausted) out.push({ code: "fc_exhausted" });
    if (warns.length) out.push({ code: "fc_warn", note: warns.map((w) => w.code).filter(Boolean).slice(0, 3).join(",") });
    if ((fc.preIssues?.length ?? 0) > 0 || (fc.regenCount ?? 0) > 0) out.push({ code: "fc_revised" });
  }

  // ── ブレイン ──
  const b = i.brain ?? null;
  if (b) {
    const act = actionOf(b.action);
    if ((b.replyMode ?? "").trim() === "aix" || act) out.push({ code: "brain_wants_aix", note: act || undefined });
    if (act && STAFF_CONFIRM_AIX[act]) out.push({ code: "brain_staff_aix", note: act });
    const llm = actionOf(b.llmAction);
    if (llm !== act && (llm || act)) out.push({ code: "rule_override", note: `${llm || "なし"}→${act || "なし"}` });
    if ((b.llmProperty ?? "").trim() && !(b.property ?? "").trim()) out.push({ code: "property_dropped" });
    if (b.deepCheck) out.push({ code: "deep_check" });
  }

  // ── 下書きの文 ──
  if (draft) {
    const sf = findStaffOnlyFact(draft);
    if (sf) out.push({ code: "staff_only_fact", note: sf.kind });
    const ug = findUngroundedFacts(draft, ground)[0];
    const ua = findUngroundedAmount(draft, ground);
    if (ug || ua) out.push({ code: "ungrounded_fact", note: ug ? ug.kind : "amount" });
    const cf = findCompanyFactContradictionsUngated(draft)[0];
    if (cf) out.push({ code: "company_fact", note: cf.factId });
    const ac = classifyAixContent(draft, ground).find((h) => !h.grounded);
    if (ac) out.push({ code: "aix_content", note: ac.catalogKey });
    const lines = draft.split(/\n+/).filter((l) => l.trim()).length;
    if (lines >= 9 || draft.length >= 320) out.push({ code: "long_draft" });
    const dn = norm(draft);
    if (DRAFT_SCHEDULE_RE.test(dn)) out.push({ code: "draft_schedule" });
    if (DRAFT_ASK_BACK_RE.test(dn)) out.push({ code: "draft_asks_back" });
    if (PICKUP_PROMISE_RE.test(dn)) out.push({ code: "pickup_promise" });
  }

  // ── お客様の番 ──
  const sens = detectSensitiveCase(cust);
  if (sens) out.push({ code: "sensitive", note: sens });
  const scr = screeningSensitiveSignal(cust);
  if (scr) out.push({ code: "screening_sensitive", note: scr.category });
  const asks = Math.max(countCustomerAsks(cust), b?.questions ?? 0);
  if (asks >= 2) out.push({ code: "multi_ask", note: String(asks) });
  if (i.isFirstContact) out.push({ code: "first_contact" });
  const c = norm(cust).trim();
  if (c && c.length <= 30 && ACK_ONLY_RE.test(c) && !/[?？]/.test(c)) out.push({ code: "ack_only_turn" });
  if (CUST_DATE_RE.test(c)) out.push({ code: "cust_date" });
  if (c.length >= 120) out.push({ code: "condition_form" });

  // ── 場面の慣れ（過去の番のそのまま率） ──
  const priors = i.priors ?? DRAFT_CONFIDENCE_SCENE_PRIORS;
  const base = i.priorBase ?? DRAFT_CONFIDENCE_PRIOR_BASE;
  const key = (i.sceneKey ?? "").trim();
  if (key) {
    const p = priors[key];
    if (!p || p.n < 8) out.push({ code: "novel_scene", note: `${p?.n ?? 0}件` });
    else {
      const rate = p.asIs / p.n;
      if (rate <= base * 0.6) out.push({ code: "scene_prior_low", note: `${Math.round(rate * 100)}%/${p.n}件` });
      else if (rate >= Math.min(0.95, base * 1.5)) out.push({ code: "scene_prior_high", note: `${Math.round(rate * 100)}%/${p.n}件` });
    }
  }

  // ── 将来の印（入力がある時だけ） ──
  if (i.readerSplit) out.push({ code: "reader_split" });
  if ((i.linkBreaks ?? 0) > 0) out.push({ code: "link_break", note: String(i.linkBreaks) });
  return out;
}

export function bandOf(score: number): ConfidenceBand {
  return score >= CONFIDENCE_HIGH_MIN ? "high" : score <= CONFIDENCE_LOW_MAX ? "low" : "mid";
}

/** 点と段と理由。weights は試しの時だけ差し替える */
export function scoreDraftConfidence(i: ConfidenceInput, weights: Readonly<Record<ConfidenceCode, number>> = CONFIDENCE_WEIGHTS): DraftConfidence {
  const sig = confidenceSignals(i);
  let penalty = 0, bonus = 0;
  const reasons: ConfidenceReason[] = [];
  for (const s of sig) {
    const d = weights[s.code] ?? 0;
    if (d === 0) continue; // 0点の印は数えるだけ（理由に出さない）
    if (d > 0) penalty += d; else bonus -= d;
    reasons.push({ code: s.code, ja: CONFIDENCE_CODE_JA[s.code], delta: -d, ...(s.note ? { note: s.note.slice(0, 40) } : {}) });
  }
  // 足す点（型どおりの番）は合わせて CONFIDENCE_BONUS_CAP まで。足す点で危ない印（作り話・段取り 等）を打ち消さない
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty + Math.min(bonus, CONFIDENCE_BONUS_CAP))));
  reasons.sort((a, b) => a.delta - b.delta);
  return { v: DRAFT_CONFIDENCE_VERSION, score, band: bandOf(score), reasons };
}

/** 画面・ログ用の1行（低い理由の上位2つ） */
export function confidenceLine(c: DraftConfidence | null | undefined): string {
  if (!c) return "";
  const top = c.reasons.filter((r) => r.delta < 0).slice(0, 2).map((r) => r.ja).join("・");
  const ja = c.band === "high" ? "高" : c.band === "mid" ? "中" : "低";
  return top ? `自信 ${ja}（${c.score}・${top}）` : `自信 ${ja}（${c.score}）`;
}

/** 保存済みの ai_draft_check から読む（無い・形が違えば null） */
export function confidenceFromCheck(check: unknown): DraftConfidence | null {
  const c = (check as { confidence?: unknown } | null | undefined)?.confidence as DraftConfidence | undefined;
  if (!c || typeof c !== "object" || typeof c.score !== "number" || !["high", "mid", "low"].includes(String(c.band))) return null;
  return c;
}
