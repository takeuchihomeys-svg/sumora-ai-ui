// app/lib/brain-fast-slow.ts — 慣れた事は速く・難しい事はじっくり（D案 4つの脳の働きの4つ目・設計知見 b01d793d・設計書 7-4）
//
// 純関数だけ（DB も fetch も LLM も持たない）。ブレイン（brain-core analyzeConversation）の入口で番の難しさを決まった計算で分け、
//   easy（慣れた番）   … 速い道: 判断に効きにくい大きな材料（RAG の知識・成約パターン・手本・テンプレ候補 等）を渡さない＝入力が減る。
//                         ただし1回目の判断に「難しさの印」が出たら、その場で全部の材料で読み直す（戻り道・見誤りの保険）。
//   normal            … 今のまま（何も変えない）。
//   hard（難しい番）   … じっくりの道: 場面で絞る材料の絞りを外す（全部の材料）＋同じ入力で2回目を回して道（本質の道・AIX・返信か AIX か）が割れないか見る。
//                         割れたら3回目で多数決（2つ揃った方）。3つとも違えば1回目のまま「割れた」の印（下書きの自信の reader_split）を残す。
// モデルは変えない（安いモデルに替えるとブレインの system の1時間キャッシュが別の鍵になり読めなくなる・別クラウド＝DeepSeek の経路は一切触らない）。
//
// 慣れた番の決め方は保守的（竹内さん「質を落とさずに」）: 全部を満たした時だけ easy（1つでも外れたら normal）。
//   今回の連投が短い（80字以下）・質問は1つまで・画像も URL も無い・センシティブ／審査の事情／条件の文／条件の変更／人生の出来事が無い・
//   申込以降でない・初めての返信でない・不満や不安の言葉が無い・台帳に未対応の約束が無い・
//   場面が慣れた型（過去にその場面の下書きがそのまま送られた率が全体の 1.15 倍以上・20件以上＝brain-fast-slow-priors。今は「条件」の場面）。
//   ※ 設計書 7-4 は「受け止めだけ」も慣れた番としていたが、本番1,198番（scripts/audit-fast-slow.ts）でお礼・了承の番はそのまま 24%・大きく直す 61%・合った 49%
//     （言い過ぎで直される）＝慣れた番ではなかった。検討・保留も同じ（17%）。どちらも普通の道のまま
// 難しい番: 質問3つ以上・クレーム／否決／キャンセル・審査の事情・人生の出来事・条件の変更（条件の文の型でない）・
//   不満の束・過去によく直された場面（そのまま率が全体の 0.6 倍以下）。
//   ※ 物件の URL が2つ以上は難しいにしない（本番: 物件の持ち込みの長い番はそのまま 50%・合った 61%＝型どおりの番だった）
// 切替: BRAIN_FAST_SLOW=on（既定 off＝何もしない）。2回目を止める BRAIN_FAST_SLOW_SECOND=off。速い道は既定で止める（BRAIN_FAST_SLOW_FAST=on の時だけ）
//   ※ 2026-10-22 試験 fs1022b: 慣れた番 6/6 が戻り道（AIX・約束の依頼）に入った＝呼び出しが毎回1回増えるだけで安くならない
// 測り方: scripts/audit-fast-slow.ts（本番の見張り line_watch_turns・読むだけ・LLM なし）
import type { ReplyScene } from "./reply-scene";
import { BRAIN_FAST_SLOW_SCENE_PRIORS, BRAIN_FAST_SLOW_PRIOR_BASE } from "./brain-fast-slow-priors";

export const BRAIN_FAST_SLOW_VERSION = "fs-2026-10-22";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

/** 既定 off。on の時だけ番の難しさで道を分ける */
export function brainFastSlowEnabled(env: Env = envOf()): boolean {
  return (env.BRAIN_FAST_SLOW ?? "").trim().toLowerCase() === "on";
}
/** 速い道（easy で材料を減らす）。BRAIN_FAST_SLOW=on かつ BRAIN_FAST_SLOW_FAST=on の時だけ（既定は止める） */
export function brainFastPathEnabled(env: Env = envOf()): boolean {
  return brainFastSlowEnabled(env) && (env.BRAIN_FAST_SLOW_FAST ?? "").trim().toLowerCase() === "on";
}
/** じっくりの道の2回目（hard で同じ入力をもう1回）。BRAIN_FAST_SLOW=on の時だけ・BRAIN_FAST_SLOW_SECOND=off で止める */
export function brainSlowSecondEnabled(env: Env = envOf()): boolean {
  return brainFastSlowEnabled(env) && (env.BRAIN_FAST_SLOW_SECOND ?? "").trim().toLowerCase() !== "off";
}

export type TurnLevel = "easy" | "normal" | "hard";
export type TurnDifficultyInput = {
  /** 今回の未返信の連投（お客様の文をつないだ物） */
  customerText: string | null | undefined;
  hasImage?: boolean | null;
  /** 返信の場面（reply-scene resolveReplyScene・お客様の文だけで決まる） */
  scene: ReplyScene | null | undefined;
  /** 申込以降（applying/screening/contract 等） */
  postApply?: boolean | null;
  /** この会話にこちらの送信がまだ無い（初めての返信） */
  isFirstContact?: boolean | null;
  /** 台帳の未対応の約束の数（分からなければ null＝数えない。実行時は brain-core が渡す） */
  pendingPromises?: number | null;
  /** お客様の気持ちの読み（customer-reaction-predict readCustomerMind の now・worry） */
  mindNow?: string | null;
  mindWorry?: string | null;
  /** 判定の部品（brain-core が既存の関数で出して渡す・純関数のまま保つため） */
  sensitive?: boolean | null;
  screeningSensitive?: boolean | null;
  conditionForm?: boolean | null;
  /** 場面の前例の表（既定は brain-fast-slow-priors.ts）。監査では古い半分だけで作った表を渡す */
  priors?: Readonly<Record<string, { n: number; asIs: number }>> | null;
  priorBase?: number | null;
};
export type TurnDifficulty = { level: TurnLevel; reasons: string[]; asks: number; urls: number };

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

/** お客様の質問の数（？・〜ますか・〜でしょうか・教えて 等の文の数）。draft-confidence countCustomerAsks と同じ網 */
export function countAsks(text: string | null | undefined): number {
  const t = norm(text);
  if (!t.trim()) return 0;
  const parts = t.split(/(?<=[?？])|\n+|(?<=[。！!])/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((s) => /[?？]$|(?:ますか|ですか|でしょうか|ませんか|かな|ますでしょうか)[。！!😊]*$|(?:教えて|知りたい)/.test(s)).length;
}
export function countUrls(text: string | null | undefined): number {
  return new Set(norm(text).match(/https?:\/\/[^\s]+/g) ?? []).size;
}

// 人生の出来事（事情が動いた番＝決まった型で返すと外す）
const LIFE_EVENT_RE = /転勤|異動|結婚|入籍|離婚|出産|妊娠|入院|亡くな|他界|転職|退職|失業|内定|合格|卒業|同棲|別れ/;
// 条件の変更（条件の文の型＝①〜⑧の長文は除く）
const CONDITION_CHANGE_RE = /(?:条件|予算|家賃|エリア|間取り|広さ|駅).{0,8}(?:変え|変更|上げ|下げ|広げ|増や|減ら|ずら)|やっぱり|やはり|考え直|見直し/;
// 不満・離れかけ（束の種類 complaint と同じ向き）
const COMPLAINT_RE = /遅い|まだですか|返事が|連絡が無|連絡がな|どうなって|困ります|おかしい|納得|不満|がっかり|残念/;

/** 慣れた型の場面（そのまま送られた率を見なくても easy の候補に入る） */
const FAMILIAR_SCENES: ReadonlySet<string> = new Set<string>([]);
/** 場面の前例の線 */
export const FAST_PRIOR_MIN_N = 20;
export const FAST_PRIOR_HIGH_RATIO = 1.15;
export const SLOW_PRIOR_LOW_RATIO = 0.6;
export const SLOW_PRIOR_MIN_N = 8;
export const FAST_MAX_CHARS = 80;

export function decideTurnDifficulty(i: TurnDifficultyInput): TurnDifficulty {
  const text = norm(i.customerText).trim();
  const asks = countAsks(text);
  const urls = countUrls(text);
  const scene = (i.scene ?? "other") as string;
  const priors = i.priors ?? BRAIN_FAST_SLOW_SCENE_PRIORS;
  const base = i.priorBase ?? BRAIN_FAST_SLOW_PRIOR_BASE;
  const p = priors[scene];
  const rate = p && p.n > 0 ? p.asIs / p.n : null;

  // ── 難しい（1つでも当たれば） ──
  const hard: string[] = [];
  if (asks >= 3) hard.push(`質問${asks}つ`);
  if (i.sensitive) hard.push("クレーム・否決・キャンセル");
  if (i.screeningSensitive) hard.push("審査の事情");
  if (LIFE_EVENT_RE.test(text)) hard.push("人生の出来事");
  if (!i.conditionForm && CONDITION_CHANGE_RE.test(text)) hard.push("条件の変更");
  if (i.mindNow === "complaint" || COMPLAINT_RE.test(text)) hard.push("不満");
  if (p && p.n >= SLOW_PRIOR_MIN_N && rate != null && rate <= base * SLOW_PRIOR_LOW_RATIO) hard.push(`よく直される場面（${scene}）`);
  if (hard.length) return { level: "hard", reasons: hard, asks, urls };

  // ── 慣れた（全部を満たした時だけ） ──
  const notEasy: string[] = [];
  if (!text) notEasy.push("文が無い");
  if (text.length > FAST_MAX_CHARS) notEasy.push("長い");
  if (asks > 1) notEasy.push("質問2つ");
  if (i.hasImage) notEasy.push("画像");
  if (urls > 0) notEasy.push("URL");
  if (i.conditionForm) notEasy.push("条件の文");
  if (i.postApply) notEasy.push("申込以降");
  if (i.isFirstContact) notEasy.push("初めての返信");
  if (i.mindWorry) notEasy.push("気がかりの言葉");
  if ((i.pendingPromises ?? 0) > 0) notEasy.push("未対応の約束");
  const familiar = FAMILIAR_SCENES.has(scene)
    || (!!p && p.n >= FAST_PRIOR_MIN_N && rate != null && rate >= Math.min(0.95, base * FAST_PRIOR_HIGH_RATIO));
  if (!familiar) notEasy.push(`慣れていない場面（${scene}）`);
  if (notEasy.length) return { level: "normal", reasons: notEasy.slice(0, 4), asks, urls };
  return { level: "easy", reasons: [`慣れた場面（${scene}${rate != null ? `・そのまま${Math.round(rate * 100)}%` : ""}）`], asks, urls };
}

/**
 * 速い道で渡さない材料（brain-core の材料の名前・見張り brain:blocks の chars の鍵と同じ）。
 *   どれも「会話全体の勝ち筋・他の会話の手本・テンプレの候補」＝慣れた短い番の判断（受け止め・一言の答え）には効きにくく、毎回の入力の大きな物。
 *   残す: お客様の状況・台帳・約束・送った物件・会話の履歴・AIX のボタン一覧・アクション別ルール（判断の土台）
 */
export const FAST_DROP_MATERIALS = ["ragKnowledge", "winning", "contractExamples", "examples", "templates", "judgeExamples", "routeType"] as const;
export type FastDropMaterial = (typeof FAST_DROP_MATERIALS)[number];
export function fastDrops(level: TurnLevel, env: Env = envOf()): ReadonlySet<string> {
  return level === "easy" && brainFastPathEnabled(env) ? new Set<string>(FAST_DROP_MATERIALS) : new Set<string>();
}

type AskLite = { route?: unknown; gap?: unknown; quote?: unknown };
function asksOf(parsed: Record<string, unknown> | null | undefined): AskLite[] {
  const tc = (parsed as { turn_contract?: { asks?: unknown } } | null | undefined)?.turn_contract;
  return Array.isArray(tc?.asks) ? (tc!.asks as AskLite[]) : [];
}

/**
 * 戻り道（見誤りの保険）: 速い道の1回目の判断に「難しさの印」があれば、全部の材料で読み直す。
 *   依頼が2つ以上・材料の足りない依頼（gap=material）・確認の約束か AIX の依頼・AIX を指している・物件を名指し
 *   のどれか（慣れた短い番の判断＝受け止め・一言の答え、から外れた）。返すのは理由（無ければ null）
 */
export function fastEscapeReason(parsed: Record<string, unknown> | null | undefined): string | null {
  if (!parsed) return "判断が読めない";
  const asks = asksOf(parsed);
  if (asks.length >= 2) return `依頼${asks.length}つ`;
  if (asks.some((a) => a.gap === "material")) return "材料が足りない依頼";
  if (asks.some((a) => a.route === "promise" || a.route === "aix")) return "約束・AIX の依頼";
  const aix = String((parsed as { aix?: unknown }).aix ?? "").trim();
  const action = String((parsed as { action?: unknown }).action ?? "").trim();
  if ((aix && aix !== "null") || (action && action !== "null") || (parsed as { reply_mode?: unknown }).reply_mode === "aix") return "AIX を指している";
  const cp = String((parsed as { current_property?: unknown }).current_property ?? "").trim();
  if (cp && cp !== "null") return "物件を名指し";
  return null;
}

/** 道の指紋（2回目の比べ）: 本質の道（依頼ごとの route）＋ AIX ＋ 返信か AIX か。文の言い回しは比べない */
export function routeFingerprint(parsed: Record<string, unknown> | null | undefined): string {
  if (!parsed) return "∅";
  const routes = asksOf(parsed).map((a) => String(a.route ?? "")).sort().join(",");
  const aix = String((parsed as { aix?: unknown }).aix ?? (parsed as { action?: unknown }).action ?? "").trim();
  const mode = String((parsed as { reply_mode?: unknown }).reply_mode ?? "").trim();
  return `${routes}|${aix === "null" ? "" : aix}|${mode}`;
}

/**
 * 2回目・3回目の答えから使う方を選ぶ（多数決）。
 *   1回目と2回目が同じ → 1回目（揃った＝自信あり）。違えば3回目を回す（呼び出し側）。
 *   3つ揃えたら、2つ以上同じ指紋の組の中で一番早い物を使う。3つとも違えば1回目のまま split=true。
 */
export function pickMajority(fps: ReadonlyArray<string>): { pick: number; split: boolean; agree: boolean } {
  if (fps.length <= 1) return { pick: 0, split: false, agree: true };
  if (fps.length === 2) return fps[0] === fps[1] ? { pick: 0, split: false, agree: true } : { pick: 0, split: true, agree: false };
  for (let k = 0; k < fps.length; k++) {
    if (fps.filter((f) => f === fps[k]).length >= 2) return { pick: k, split: false, agree: false };
  }
  return { pick: 0, split: true, agree: false };
}

/** 記録（meta.fast_slow → brain_decision_logs.digest.fs）。lv＝難しさ・why＝理由・drop＝渡さなかった材料の字数・up＝戻り道・runs＝回した回数・pick＝使った回・split＝割れた */
export type FastSlowRecord = {
  v: string; lv: TurnLevel; why: string[];
  drop?: number; up?: string | null; runs?: number; pick?: number; split?: boolean; fps?: string[];
};
