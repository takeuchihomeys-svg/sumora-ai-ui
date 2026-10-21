// app/lib/reply-outcome-learn.ts — 結果から学ぶ（D案の足りない働き ③・純関数・DB も fetch も LLM も持たない）
//
// 2026-10-21 竹内さんの決定（a5838a0b）③「結果から学ぶ（返し方の後に内覧・申込へ進んだかで学ぶ）」。竹内さん「データあるから」＝もうある記録で学ぶ。
//   過去の「お客様の番 → こちらの返事」を、その時の段階（結果の台帳 deal_outcomes の 物件送付・内覧の予定 の時刻で決める）×
//   返し方の形（下の REPLY_SHAPES・決まった計算）に分け、その後に
//     内覧の予定が入ったか（14日・deal_outcomes.viewing_at / viewings / viewing_history）・申込（30日・推定でない applied_at）・返事（7日）
//   を数える。偏り（お客様の番の種類＝温度の代わり・返事までの時間・アカウント）は「同じ層の平均との差」で揃える（直接の標準化）。
//   相関であって因果ではない。時間で分けた確かめ（古い 70% で作り、新しい 30% で順位が保たれるか）は scripts/audit-reply-outcome.ts。
//
// 数え表: reply-outcome-table-data.ts（scripts/audit-reply-outcome.ts --write-table が書く・数だけ・文も会話の ID も持たない）
// スイッチ: BRAIN_OUTCOME_LEARN=on でブレインの材料に 1〜2 行（既定 off＝プロンプトは1バイトも変わらない）
// 竹内さんの営業の意図（決定率を上げる・内覧はこちらで）に合わせ、注記は「誘い・勧めるをやめる理由」にはしない（材料の数だけ）。
// テスト: app/lib/__tests__/reply-outcome-learn.test.ts
import { proposalKindOf } from "@/app/lib/customer-mood-flow";
import type { CustomerStage } from "@/app/lib/customer-state";
import { REPLY_OUTCOME_TABLE } from "@/app/lib/reply-outcome-table-data";

/** こちらの返し方の形（決まった計算・優先の順に判定） */
export const REPLY_SHAPES = ["answer_invite", "invite", "apply", "estimate", "property", "promise", "ask", "answer", "ack"] as const;
export type ReplyShape = (typeof REPLY_SHAPES)[number];
export const REPLY_SHAPE_JA: Record<ReplyShape, string> = {
  answer_invite: "答え・受け止め＋内覧の誘い1文",
  invite: "内覧の誘い（ほぼ誘いだけ）",
  apply: "申込を勧める・抑える",
  estimate: "見積・初期費用",
  property: "物件を送る",
  promise: "確認して後で送る約束",
  ask: "こちらから聞き返す",
  answer: "答え・説明",
  ack: "短い受け",
};

/** 段階（台帳の時刻で決める・申込以降は対象外） */
export const OUTCOME_SCENES = ["hearing", "proposing", "viewing"] as const;
export type OutcomeScene = (typeof OUTCOME_SCENES)[number];
export const OUTCOME_SCENE_JA: Record<OutcomeScene, string> = { hearing: "条件を聞く段（物件送付前）", proposing: "物件を送った後・内覧前", viewing: "内覧の予定が入った後" };

const INVITE_RE = /ご?内[覧見](?:[^\n。]{0,20})(?:可能|できます|出来ます|いかが|どうでしょう|ご都合|ご希望|日程|行きませんか|しませんか|しましょう|させて|ご案内)|(?:ご案内|ご一緒)(?:[^\n。]{0,6})(?:可能|できます|出来ます|いかが)|ご都合(?:の|が)?(?:良い|よい|いい)(?:日|お日にち|日時)/;
const APPLY_RE = /お?申し?込(?:み)?(?:[^\n。]{0,15})(?:可能|できます|いかが|おすすめ|オススメ|抑え|押さえ|頂け|いただけ|しませんか|をお願い|しておく|して(?:頂|いただ)ければ)|(?:先に|一旦|まず)(?:[^\n。]{0,8})(?:抑え|押さえ)/;
const ESTIMATE_RE = /見積|お見積|初期費用|ご請求|概算/;
const PROMISE_RE = /確認(?:して|させて|し次第|いたし|致し)|お調べ|調べて(?:み|ご連絡)|折り返し|お待ち(?:下さい|ください)|改めて(?:ご連絡|お送り)|分かり次第|わかり次第/;
const ASK_RE = /[？?]|いかがでしょうか|でしょうか|ございますか|頂けますか|いただけますか|ご希望(?:は|の)|教えて(?:下さい|ください|頂け|いただけ)/;
const URL_RE = /https?:\/\/\S+/;

const clean = (t: string) => t.normalize("NFKC").replace(URL_RE, "").replace(/\s+/g, " ").trim();
const contentLen = (t: string) => t.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}！!。、,.]/gu, "").length;

/** 返事（連投をまとめた文）の形。文が無い（画像だけ等）時は null */
export function replyShapeOf(text: string | null | undefined): ReplyShape | null {
  const raw = String(text ?? "");
  if (!raw.trim() || /^\s*\[(?:画像|動画|スタンプ|ファイル|位置情報)[^\]]*\]\s*$/.test(raw)) return null;
  const t = clean(raw);
  const pk = proposalKindOf(raw);
  const m = INVITE_RE.exec(t);
  if (m) {
    // 誘いの前に中身（答え・受け止め）がどれだけあるか
    const before = contentLen(t.slice(0, m.index));
    return before >= 25 ? "answer_invite" : "invite";
  }
  // 内覧・申込の語があるだけ（当日の流れ・審査の話）は誘い・勧めに数えない（誘う言い方の時だけ）
  if (APPLY_RE.test(t)) return "apply";
  if (pk === "物件" || (URL_RE.test(raw) && /物件|お部屋|ご紹介|ピックアップ|こちら/.test(raw))) return "property";
  if (ESTIMATE_RE.test(t) || pk === "見積") return "estimate";
  if (PROMISE_RE.test(t)) return "promise";
  if (ASK_RE.test(t)) return "ask";
  return contentLen(t) < 25 ? "ack" : "answer";
}

/** 台帳の時刻（物件送付・内覧の予定・申込）から、その時点の段階。申込以降は null（対象外） */
export function sceneAt(at: number, ms: { propertySentAt?: number | null; viewingAt?: number | null; appliedAt?: number | null }): OutcomeScene | null {
  if (ms.appliedAt != null && ms.appliedAt <= at) return null;
  if (ms.viewingAt != null && ms.viewingAt <= at) return "viewing";
  if (ms.propertySentAt != null && ms.propertySentAt <= at) return "proposing";
  return "hearing";
}

/** 本番の段階（customer-state の12段階）→ この表の段階 */
export function sceneFromCustomerStage(stage: CustomerStage | null | undefined): OutcomeScene | null {
  switch (stage) {
    case "first": case "searching": return "hearing";
    case "proposing": case "interested": case "estimate_sent": return "proposing";
    case "viewing_arranging": case "viewing_scheduled": case "viewed": return "viewing";
    default: return null; // 申込準備以降・成約・見送り・不明
  }
}

/** 数え表の1マス（段階×形）。lift は同じ層の平均との差（-1〜1）・lo/hi は会話ごとの再標本の 90% の幅 */
export type OutcomeCell = {
  scene: OutcomeScene; shape: ReplyShape; n: number; convs: number;
  progress: number; view14: number; apply30: number; reply7: number;
  lift: number; lo: number; hi: number;
  /** 時間で分けた確かめ: 古い側だけで確か（30番以上・幅が 0 をまたがない）だったマスが新しい側でも同じ向きだったか。古い側で確かでなければ null */
  held: boolean | null;
};
export type OutcomeTable = { builtAt: string; days: number; turns: number; outcome: "progress"; cells: OutcomeCell[] };

export const OUTCOME_MIN_N = 30;

export function outcomeLearnEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_OUTCOME_LEARN ?? "").trim().toLowerCase() === "on";
}

const pt = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}pt`;
const pc = (x: number) => `${Math.round(x * 100)}%`;

/** その段階で言える（数が足り、幅が 0 をまたがず、古い側だけで選んで新しい側でも向きが保たれた）マス。差の大きい順 */
export function reliableCells(scene: OutcomeScene | null | undefined, table: OutcomeTable = REPLY_OUTCOME_TABLE): OutcomeCell[] {
  if (!scene) return [];
  return table.cells
    // 確認の約束は事実が材料に無い時の形・条件を聞く段の聞き返しは条件が足りない時に要る形（どちらも結果で選ぶ物ではない・逆向きの因果が強い）＝出さない
    .filter((c) => c.shape !== "promise" && !(scene === "hearing" && c.shape === "ask"))
    .filter((c) => c.scene === scene && c.n >= OUTCOME_MIN_N && c.held === true && (c.lo > 0 || c.hi < 0))
    .sort((a, b) => b.lift - a.lift);
}

/**
 * ブレインへの注記（1〜2 行の材料・判断と文はブレイン）。言える事が無ければ空文字。
 *   進みやすい形（差がプラス）を先に・止まりやすい形（マイナス）は1つだけ。誘い・勧めるをやめる理由にはしない。
 */
export function buildOutcomeNote(scene: OutcomeScene | null | undefined, table: OutcomeTable = REPLY_OUTCOME_TABLE): string {
  const xs = reliableCells(scene, table);
  if (!xs.length || !scene) return "";
  const goal = scene === "viewing" ? "30日で申込" : "14日で内覧の予定か30日で申込";
  const fmt = (c: OutcomeCell) => `${REPLY_SHAPE_JA[c.shape]} ${pt(c.lift)}（${c.n}番・進んだ ${pc(c.progress)}）`;
  const up = xs.filter((c) => c.lift > 0).slice(0, 2);
  const down = xs.filter((c) => c.lift < 0).slice(-1);
  const parts = [...up.map(fmt), ...down.map(fmt)];
  if (!parts.length) return "";
  return `\n【結果から学ぶ（${OUTCOME_SCENE_JA[scene]}・過去の実データ ${table.turns}番・${goal}に進んだ割合の、同じ段階×お客様の番の種類×返事の速さの平均との差／相関の材料で因果ではない・誘う・勧めるをやめる理由にはしない・答えが要る時は答えを先に）】\n- ${parts.join("／")}\n- 数はお客様の様子の結果でもある（申込で抑えた番＝気に入ったお部屋があった・物件をまた送った番＝前のが合わなかった・聞き返した番＝条件が足りなかった）＝お客様が求めた物（他の物件・答え・確認）は必ず出す／申込で抑えるのは気に入ったお部屋がある時（遠方・内覧まで期間がある・内覧の後）だけ／文はいつもの竹内基準\n`;
}
