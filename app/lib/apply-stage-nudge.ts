// app/lib/apply-stage-nudge.ts — 審査に出した形跡があるのに段階が「申込」になっていない会話に、段階を申込にする促しを出す（純関数・LLM なし）。
//   竹内さんの決定（2026-10-08）④「審査に出した時に段階を申込にする運用はおこなう」（スタッフの運用）。
//   ツールは運用の助けとして、会話画面の小さい表示で促す（OutcomeConfirmBar）。自動で段階は変えない（押すのはスタッフ）。
//   背景: 結果の台帳の監査（plan_outcome_ledger 8-2）で、段階を申込にしないまま審査に出している会話が多く、
//         申込の時刻・案件の区切りを否決の文から推定するしかなかった。
//   線（scripts/audit-apply-stage-nudge.ts・直近120日の実 LINE で引いた）:
//     「審査通過しやすい」「1番手の方の審査中」「否決の場合」等（物件の説明・他の申込者・仮定）は当てない。
//     当てるのは、この方の審査が動いている言い方だけ（審査に移行・審査通過致しました・現在審査中となり・審査に出させて頂き・審査結果まだですか）。
import { isApplicationFormMessage } from "./application-form-detect";

/** 促しを出す（APPLY_STAGE_NUDGE=off で出さない） */
export function applyStageNudgeEnabled(env: Record<string, string | undefined>): boolean {
  return (env.APPLY_STAGE_NUDGE ?? "").trim().toLowerCase() !== "off";
}

/** この日数より前の形跡では促さない（古い会話を開いた時に出さない） */
export const NUDGE_LOOKBACK_DAYS = 21;

/** 申込以降・成約・失注（ここにいれば促さない） */
const NOT_PRE_APPLY: ReadonlySet<string> = new Set(["applying", "application", "screening", "contract", "approved", "closed_won", "closed_lost", "lost"]);
export function isPreApplyForNudge(status: string | null | undefined): boolean {
  const s = (status ?? "").trim();
  return !!s && !NOT_PRE_APPLY.has(s);
}

/** こちらの文: この方の審査が動いている（文ごとに見る） */
const STAFF_SCREENING_RE = new RegExp([
  "(?:保証会社|オーナー|貸主|管理会社)(?:の|による|様の)?(?:最終)?審査(?:に|へ)(?:と)?移行",
  "審査(?:は|が|を)?(?:無事)?(?:通過|承認)(?:致し|いたし|され|し)(?:ました|ている|ております|て(?:おり|い)ます)",
  "全ての審査(?:が|も)?(?:通過|完了)",
  "(?:現在|まだ)(?:保証会社の?|オーナーの?|貸主の?)?審査中(?:となり|となって|です|でござい|の状況)",
  "審査(?:を|に)(?:出させて|出し|提出させて|提出し|かけさせて|かけて|回させて)(?:頂き|いただき|頂いて|いただいて|ました|おります)",
  "審査(?:完了|通過)(?:の|との)?(?:ご)?連絡(?:を)?(?:頂|いただ)",
  "審査(?:の)?(?:進捗|状況)(?:あり次第|が?分かり次第|わかり次第|確認(?:出来|でき)次第)",
  "お申し?込み?(?:フォーマット|フォーム)?(?:の)?入力(?:が)?完了",
  // こちらが代わりに申し込む（「かしこまりました！！ 〇〇302号室お申し込みさせていただきます」）。「よろしければ…お申込みさせて頂きます」の誘いは下の打ち消しで外す
  "お申し?込み?(?:を)?(?:させて(?:頂|いただ)きま(?:す|した)|致しました|いたしました)",
].join("|"));
/** お客様の文: 審査の結果を待っている・通った */
//   お客様は「審査の結果ってまだ分からない感じでしょうか？」「オーナー審査どうなりましたか」のように問いの形で聞くので、問いの形は外さない
const CUSTOMER_SCREENING_RE = /審査(?:の)?結果(?:って|は|が)?(?:まだ|どう|出|いつ)|審査(?:って|は)?どうなり|審査[^\n。]{0,6}遅い|審査(?:通過|通りました|が通りました|通った)(?:ありがとう|しました|完了|です)/;
/** 物件の説明・他の申込者・仮定は外す（お客様・こちら共通） */
const SCREENING_NEGATE_RE = /場合|たら|しやすい|しにくい|可能性|一番手|1番手|二番手|2番手|番手|お申し?込み?が入|他の方|別の方|ほかの方|否決|通らな|通過しな|かも/;
/** こちらの文だけ: 誘い・問い（「よろしければ…お申込みさせて頂きます」「お申込み如何でしょうか」）は外す */
const STAFF_NEGATE_RE = /よろしければ|如何|いかが|でしょうか|ますか|ですか/;
/** 否決・取り消し（これより後の形跡でなければ促さない＝切り替えの番） */
const REJECT_OR_CANCEL_RE = /否決(?:とのご連絡|となって|となりました|となり|でした|になりました)|審査(?:継続)?不(?:可能|能)|審査(?:に|が)?(?:落ちてしまい|落ちました|通りませんでした)|(?:申し?込み?|申込)[^\n。]{0,15}(?:キャンセル|取り消し|取消)(?:で(?:お願い)|させて|します|しました)/;

const sentences = (t: string) => t.normalize("NFKC").split(/\n|(?<=[。！!])/);

export type NudgeMessage = { sender: string; text: string | null; createdAt: string };
export type ApplyStageNudge = { kind: "screening_text" | "application_form"; at: string; by: "staff" | "customer" };

/** 1通がこの方の審査の形跡か（純関数・テストと監査で使う） */
export function screeningEvidenceOf(m: NudgeMessage): ApplyStageNudge["kind"] | null {
  const t = String(m.text ?? "");
  if (!t.trim() || /^\s*\[(?:画像|動画)\]/.test(t)) return null;
  if (m.sender === "customer" && isApplicationFormMessage(t).detected) return "application_form";
  const re = m.sender === "customer" ? CUSTOMER_SCREENING_RE : STAFF_SCREENING_RE;
  const staff = m.sender !== "customer";
  // 申込の後の流れの説明（「🌟お申込み後の流れをご案内させていただきます」）は申込の前に送る説明（監査 95019eb8 09-30）
  if (staff && /流れ(?:を|について)?(?:ご案内|ご説明)|申し?込み?後の流れ/.test(t)) return null;
  return sentences(t).some((s) => re.test(s) && !SCREENING_NEGATE_RE.test(s) && !(staff && STAFF_NEGATE_RE.test(s))) ? "screening_text" : null;
}

/**
 * 促しを出すか。
 *   出す: 今の段階が申込より前・直近21日のうちに審査の形跡（こちら／お客様の文・申込フォーム）があり、
 *         それが最後に段階を戻した時より後で、その後に否決・取り消しの文が無い
 *   出さない: 申込以降・成約・失注／形跡が古い／戻した後に形跡が無い（戻した理由が否決なら切り替えの番）
 */
export function resolveApplyStageNudge(i: {
  status: string | null; messages: ReadonlyArray<NudgeMessage>; nowMs: number;
  /** 最後に段階を申込以降→申込前に戻した時刻（status_manual_back_at・stage_history） */
  lastBackAt?: string | null;
}): ApplyStageNudge | null {
  if (!isPreApplyForNudge(i.status)) return null;
  const from = Math.max(i.nowMs - NUDGE_LOOKBACK_DAYS * 86_400_000, i.lastBackAt ? Date.parse(i.lastBackAt) || -Infinity : -Infinity);
  const msgs = [...i.messages].filter((m) => Date.parse(m.createdAt) > from).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let found: ApplyStageNudge | null = null;
  for (const m of msgs) {
    if (sentences(String(m.text ?? "")).some((s) => REJECT_OR_CANCEL_RE.test(s) && !/場合|たら|ますか|ですか|\?|？/.test(s))) { found = null; continue; }
    const kind = screeningEvidenceOf(m);
    if (kind) found = { kind, at: m.createdAt, by: m.sender === "customer" ? "customer" : "staff" };
  }
  return found;
}

export function applyStageNudgeText(n: ApplyStageNudge): string {
  const what = n.kind === "application_form" ? "申込フォームが届いています" : n.by === "customer" ? "お客様から審査の結果のお話があります" : "審査に出している連絡があります";
  return `${what}が、段階が「申込」になっていません。審査に出していれば「申込」にしてください`;
}
