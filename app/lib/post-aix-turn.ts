// app/lib/post-aix-turn.ts（純関数・DB/LLM なし・画面とサーバーの両方から読める）
// 「今は AIX の続き（2通目）の番」かを、画面の一時的な状態ではなく会話の記録（メッセージ＋最後に送った AIX）から決める。
//
// 2026-10-15 竹内悠馬（KAORI さん・ギガ賃貸）「AIX の物件オススメを送った後、入力欄の上に『物件オススメ【AIX】の続きを送る［テンプレを開く］』が出る。
//   ここが AIX テンプレート（2通目）になっているはずなのに、なっていない事が多い。ちゃんと AIX テンプレートにして、押したら切り替えられるように。
//   『今は AIX の続き（2通目）の番』をちゃんと判断できるように」
// ■ 調べ（本番の記録・読むだけ）
//   - 帯は postAixTemplateMap（AIX を送った画面の一時的な状態）だけで出ていた → 開き直し・別の端末・別の会話に移って戻った後は出ない。
//   - 帯を押してもテンプレートの一覧が開くだけで、AIX テンプレート（✨ この会話に合った文を生成）はもう1回押す必要があった。
//     21日の物件オススメ 167回のうち 2通目を送った 137回: ✨ を使った 92・使わず手で書いた 45。
// ■ 決め: 続きの番＝ 最後に送った AIX（aix_usage_logs）の🌟などの本文が会話にあり、その後にお客様の発言も、こちらの会話文（2通目）も無い・送ったのが今日（日本時間）。
//   「2通目を送らない」と決めて送った物（picker_choices.closing_in_first）は番にしない。
//   戻す: NEXT_PUBLIC_POST_AIX_TURN_FROM_LOG=off（帯は今まで通り画面の状態だけ）

export type PostAixTurnMsg = { sender: string; text?: string | null; isAix?: boolean; rawCreatedAt?: string | null };
export type LatestAix = { aixType: string; at: string; noSecond?: boolean | null } | null | undefined;

const jstDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
/** AIX の送信に付いてくる物（画像・室内イメージの URL）＝2通目ではない */
function isAttachmentText(t: string): boolean {
  const s = t.trim();
  return !s || s === "[画像]" || s === "[動画]" || /^（室内イメージ）/.test(s) || /^https?:\/\/\S+$/.test(s);
}

export function postAixTurnFromLogEnabled(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() !== "off";
}

/**
 * 最後の AIX の本文の後の様子: open＝お客様の発言もこちらの会話文も無い／closed＝どちらかがある／unknown＝AIX の本文が見当たらない（予約送信でまだ無い等）。
 *   index は open の時の AIX の本文の位置
 */
export function postAixTurnState(messages: ReadonlyArray<PostAixTurnMsg>): { state: "open" | "closed" | "unknown"; index: number } {
  for (let j = messages.length - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.sender === "customer") return { state: "closed", index: -1 }; // AIX の本文より後にお客様の発言＝別の番
    const t = String(m.text ?? "");
    if (m.isAix && !isAttachmentText(t)) return { state: "open", index: j };
    if (!m.isAix && !isAttachmentText(t)) return { state: "closed", index: -1 }; // AIX の後にこちらの会話文＝2通目は送った
  }
  return { state: "unknown", index: -1 };
}

/**
 * 続きの番なら AIX の種類と1通目の本文を返す（違えば null）。
 * messages は古い順。latestAix.at は送った時刻（aix_usage_logs.sent_at）
 */
export function resolvePostAixTurn(i: { messages: ReadonlyArray<PostAixTurnMsg>; latestAix: LatestAix; nowMs: number }): { actionType: string; sentMessage: string } | null {
  const la = i.latestAix;
  if (!la?.aixType || la.noSecond) return null;
  const at = Date.parse(la.at);
  if (!Number.isFinite(at) || jstDay(at) !== jstDay(i.nowMs)) return null;
  const msgs = i.messages;
  // 最後の AIX の本文（画像・室内イメージ以外）。送った時刻の5分前より後
  const st = postAixTurnState(msgs);
  if (st.state !== "open") return null;
  const k = st.index;
  const mt = Date.parse(String(msgs[k].rawCreatedAt ?? ""));
  if (!Number.isFinite(mt) || mt < at - 5 * 60_000) return null;
  return { actionType: la.aixType, sentMessage: String(msgs[k].text ?? "") };
}

/** ✨ AIX テンプレートの生成（/api/aix-template-generate）の本文。テンプレート一覧の ✨ と帯の「AIX テンプレートを入れる」で同じ物を送る */
export type AixTemplateRequestInput = {
  actionType: string | null;
  actionCategory: string;
  conversationId: string;
  customerName: string;
  conversationState: string | null | undefined;
  recentMessages: ReadonlyArray<Record<string, unknown>>;
  customerConditions: string;
  customerSummary: string | null;
  noEmoji: boolean;
  pendingScheduledMessages: ReadonlyArray<{ text?: string | null }>;
  staffMessagedToday: boolean;
  pickupType: string | null;
  lastAixCheckPattern: string | null;
  sentMessage: string | null;
  sentMessageSource: string | null;
  ctaPreference: string | null;
};
export function buildAixTemplateRequestBody(i: AixTemplateRequestInput): Record<string, unknown> {
  return {
    actionType: i.actionType,
    actionCategory: i.actionCategory,
    conversationId: i.conversationId,
    customerName: i.customerName,
    conversationState: i.conversationState,
    recentMessages: i.recentMessages.slice(-15),
    customerConditions: i.customerConditions,
    customerSummary: i.customerSummary,
    noEmoji: i.noEmoji,
    pendingScheduledMessages: i.pendingScheduledMessages.filter((m) => m.text),
    staffMessagedToday: i.staffMessagedToday,
    pickupType: i.pickupType,
    lastAixCheckPattern: i.lastAixCheckPattern,
    sentMessage: i.sentMessage,
    sentMessageSource: i.sentMessageSource,
    ctaPreference: i.ctaPreference,
  };
}

/** 帯から直に AIX テンプレートを入れる AIX（確かめた物だけ・物件オススメ）。戻す NEXT_PUBLIC_POST_AIX_TEMPLATE_DIRECT=off */
export function postAixDirectTemplateOn(actionType: string | null | undefined, v: string | null | undefined): boolean {
  if ((v ?? "").trim().toLowerCase() === "off") return false;
  return actionType === "property_recommendation";
}
