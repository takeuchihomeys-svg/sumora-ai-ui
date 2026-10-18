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
].join("|"));
/**
 * こちらが代わりに申し込む宣言（「かしこまりました！！ 〇〇302号室お申し込みさせていただきます」）。「よろしければ…お申込みさせて頂きます」の誘いは下の打ち消しで外す。
 * 2026-10-15 軸の直し（ryou さん f895b126 9/26〜10/10）: 受けの宣言だけでは申込の情報（フォーム・本人確認）はまだ来ていない＝この方の審査は動いていない。
 *   宣言は、申込フォームの受領（applying_text_received・お客様のフォームの文）か本人確認の画像（applying_image_received）がある時だけ形跡にする。
 *   戻す APPLY_STAGE_NUDGE_AXIS=off（宣言だけでも形跡＝前の形）
 */
const STAFF_APPLY_DECLARATION_RE = /お申し?込み?(?:を)?(?:させて(?:頂|いただ)きま(?:す|した)|致しました|いたしました)/;
export function applyStageNudgeAxisOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.APPLY_STAGE_NUDGE_AXIS ?? "").trim().toLowerCase() !== "off";
}
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
export type ApplyStageNudge = { kind: "screening_text" | "application_form" | "id_image"; at: string; by: "staff" | "customer" };

/** こちらの受けの宣言（申込させて頂きます）の文があるか（誘い・問い・他の申込者の文は外す） */
export function isStaffApplyDeclaration(m: NudgeMessage): boolean {
  if (m.sender === "customer") return false;
  const t = String(m.text ?? "");
  if (!t.trim() || /流れ(?:を|について)?(?:ご案内|ご説明)|申し?込み?後の流れ/.test(t)) return false;
  return sentences(t).some((s) => STAFF_APPLY_DECLARATION_RE.test(s) && !SCREENING_NEGATE_RE.test(s) && !STAFF_NEGATE_RE.test(s));
}

/**
 * 1通がこの方の審査の形跡か（純関数・テストと監査で使う）。
 *   o.formReceived: 申込フォームの受領・本人確認の画像の記録がある（無い時、こちらの受けの宣言だけでは形跡にしない・APPLY_STAGE_NUDGE_AXIS=off で前の形）
 */
export function screeningEvidenceOf(m: NudgeMessage, o: { formReceived?: boolean } = {}): ApplyStageNudge["kind"] | null {
  const kind = screeningEvidenceCore(m);
  if (kind) return kind;
  if (isStaffApplyDeclaration(m) && (!applyStageNudgeAxisOn() || o.formReceived)) return "screening_text";
  return null;
}
function screeningEvidenceCore(m: NudgeMessage): ApplyStageNudge["kind"] | null {
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
  /** 2026-10-15: 申込フォームの受領（conversations.applying_text_received）・本人確認の画像（applying_image_received） */
  applyingTextReceived?: boolean | null;
  applyingImageReceived?: boolean | null;
}): ApplyStageNudge | null {
  if (!isPreApplyForNudge(i.status)) return null;
  const from = Math.max(i.nowMs - NUDGE_LOOKBACK_DAYS * 86_400_000, i.lastBackAt ? Date.parse(i.lastBackAt) || -Infinity : -Infinity);
  const msgs = [...i.messages].filter((m) => Date.parse(m.createdAt) > from).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let found: ApplyStageNudge | null = null;
  let lastRejectMs = -Infinity;
  const formReceived = !!i.applyingTextReceived || !!i.applyingImageReceived || msgs.some((m) => m.sender === "customer" && isApplicationFormMessage(String(m.text ?? "")).detected);
  // 2026-10-18 竹内さん 10/16「申込の帯は申込フォームが届いてから出す」: 審査の言い方（こちら・お客様）があっても、申込フォームの受領・本人確認の画像が無い間は出さない。
  //   10/15 の軸の直しは受けの宣言だけだった（下の screeningEvidenceOf）。戻す APPLY_STAGE_NUDGE_FORM_ONLY=off（審査の言い方だけでも出す＝10/15 の形）
  if (!formReceived && (process.env.APPLY_STAGE_NUDGE_FORM_ONLY ?? "").trim().toLowerCase() !== "off") return null;
  for (const m of msgs) {
    if (sentences(String(m.text ?? "")).some((s) => REJECT_OR_CANCEL_RE.test(s) && !/場合|たら|ますか|ですか|\?|？/.test(s))) { found = null; lastRejectMs = Date.parse(m.createdAt); continue; }
    const kind = screeningEvidenceOf(m, { formReceived });
    if (kind) found = { kind, at: m.createdAt, by: m.sender === "customer" ? "customer" : "staff" };
  }
  // 2026-10-18 確かめる人: 本人確認の画像だけ（フォームの文・審査の言い方が無い）の時に帯が出なかった（formReceived は真なのに形跡の通が無い）。
  //   画像の記録（applying_image_received＝申込書の案内の後72時間以内のお客様の画像）があり、窓の中にお客様の画像の通があれば、その通を形跡にする。
  //   戻す APPLY_STAGE_NUDGE_ID_IMAGE=off
  if (!found && i.applyingImageReceived && (process.env.APPLY_STAGE_NUDGE_ID_IMAGE ?? "").trim().toLowerCase() !== "off") {
    const img = [...msgs].reverse().find((m) => m.sender === "customer" && Date.parse(m.createdAt) > lastRejectMs && /^\s*\[(?:画像|ファイル)/.test(String(m.text ?? ""))
      // 確かめる人 10/18: 見出し付きの画像（"[画像] 【物件の資料】" "【物件以外：…】" "【種類不明】"＝本人確認・収入の書類でない）は形跡にしない（image-label.ts）
      && !/^\s*\[画像\]\s*【/.test(String(m.text ?? "")));
    if (img) found = { kind: "id_image", at: img.createdAt, by: "customer" };
  }
  return found;
}

export function applyStageNudgeText(n: ApplyStageNudge): string {
  const what = n.kind === "application_form" ? "申込フォームが届いています" : n.kind === "id_image" ? "本人確認の画像が届いています" : n.by === "customer" ? "お客様から審査の結果のお話があります" : "審査に出している連絡があります";
  return `${what}が、段階が「申込」になっていません。審査に出していれば「申込」にしてください`;
}
