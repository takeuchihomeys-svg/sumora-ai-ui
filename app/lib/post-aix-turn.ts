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

// ─── 2026-10-16 竹内悠馬（10/16 の画面の事例 a・b）: AIX の続きは「同じテンプレの2通目」とは限らない ───────────────
//   (a) 物件ピックアップした の後は、その中から1件オススメ＝AIX【物件オススメ】へつながる（帯が「物件ピックアップした【AIX】の続き」のままだった）。
//       30日の本番（aix_usage_logs・読むだけ）: 物件ピックアップした の後にお客様の発言が無いまま次の AIX を送った 83回 → 物件オススメ 65回（78%）。
//       物件ピックアップした は一覧の文（ご査収ください）まで AIX の中で送るので、同じテンプレの2通目は無い。
//   (b) お客様が送った物件が募集に出ていなかった（物件確認した・unavailable）→ 条件をまだもらっていなければ条件を聞く（AIX【ヒアリング】）→
//       条件がそろっていれば条件に合う物件を新しくピックアップ（AIX【物件ピックアップした】）。60日: unavailable の後にお客様の発言なしで次の AIX 15回 →
//       物件オススメ 7・物件ピックアップした 4・見積書 2・ヒアリング 1（代わりの物件を出す）。
//   決め: 帯は「次の AIX」を出し、押すとその AIX を開く。それ以外は今まで通り（同じテンプレの続き）。戻す NEXT_PUBLIC_POST_AIX_NEXT=off
export function postAixNextEnabled(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() !== "off";
}
export type NextAixAfterAix = { action: "property_recommendation" | "condition_hearing" | "property_send" | "estimate_sheet" | "viewing_invite" | "application_push"; why: string };

// ─── 2026-10-18 弱い所B-2: 1つの発言に複数の依頼がある時の AIX の順番（竹内さん 10/15 の決定 a71c2481）───────────────
//   「内見＋初期費用」→ まず見積書（確認の形）→ 送信完了で AIX【内覧日調整】（次の段階の形）。順番: 確認の形（物件確認・見積書）が先、内覧・申込が次。
//   本番（aix_usage_logs 120日・読むだけ・scripts で数えた）:
//     ・内見と費用を両方言った番（85番）の最初の AIX: 物件確認（空き）28・見積書 13・内覧日調整 12・待ち合わせ 9 ＝確認の形が先（41/53）
//     ・見積書の後にお客様が内見に触れた → 次の AIX は 内覧日調整 18/26（69%）
//     ・今は同じ番で続けて押す事は少ない（内見＋費用で見積書の後にお客様の発言なしで内覧日調整 1/8）＝竹内さんが 10/15 に「連続して推せるようにする」と決めた所
//   ブレインの本質（turn_contract の依頼ごとの AIX）があればその AIX を順番に並べ、無ければお客様の今の番の言葉（内見・初期費用）で決める。
//   戻す NEXT_PUBLIC_POST_AIX_ORDER=off
export function postAixOrderEnabled(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() !== "off";
}
/** 確認の形（こちらが調べて結果を返す）＝先。小さいほど先 */
const AIX_ORDER_RANK: Record<string, number> = {
  property_check_result: 0, acknowledge_check: 0, guarantor_info: 0,
  estimate_sheet: 1, cost_explain: 1, cost_breakdown: 1,
  viewing_invite: 2, meeting_place: 3, application_push: 4,
};
const ORDER_NEXT_OK = new Set(["estimate_sheet", "viewing_invite", "application_push"]);
const VIEW_WISH_RE = /内見|内覧|見学|見に行|見たい|案内して/;
const COST_ASK_RE = /初期費用|見積|総額|費用(?:は|が|を|って|も)/;
/**
 * 送った AIX の次に、同じ番の依頼で残っている AIX（順番どおり）。無ければ null。
 *   contractAsks: ブレインの turn_contract.asks（今のお客様の番を見た物だけ渡す）
 *   customerTurnText: 最後の AIX の前のお客様の連投（ブレインの本質が無い時に使う）
 */
export function nextAixInRequestOrder(i: {
  aixType: string | null | undefined;
  checkPattern?: string | null;
  contractAsks?: ReadonlyArray<{ route?: unknown; aix?: unknown }> | null;
  customerTurnText?: string | null;
  env?: string | null;
}): NextAixAfterAix | null {
  if (!postAixOrderEnabled(i.env)) return null;
  const sent = String(i.aixType ?? "");
  const sentRank = AIX_ORDER_RANK[sent];
  if (sentRank == null) return null;
  // 物件確認で募集に出ていない・他の確認（管理会社の確認 等）の後は、内覧・見積に進めない（今まで通りの帯・nextAixAfterAix の (b)）
  if (sent === "property_check_result" && i.checkPattern && i.checkPattern !== "available") return null;
  // ① ブレインの本質: 依頼ごとの AIX を順番に並べ、送った物より後の段の物
  const fromContract = (i.contractAsks ?? [])
    .filter((a) => a?.route === "aix")
    .map((a) => String(a.aix ?? "").split("/")[0])
    .filter((k) => k && k !== sent && AIX_ORDER_RANK[k] != null && AIX_ORDER_RANK[k] > sentRank && ORDER_NEXT_OK.has(k))
    .sort((a, b) => AIX_ORDER_RANK[a] - AIX_ORDER_RANK[b]);
  if (fromContract.length) {
    const k = fromContract[0] as NextAixAfterAix["action"];
    return { action: k, why: `同じ番のもう1つの依頼（ブレイン）＝確認の形が先・${k === "viewing_invite" ? "内覧日の調整" : k === "estimate_sheet" ? "初期費用の見積書" : "申込"}が次` };
  }
  // ② お客様の今の番の言葉（内見＋初期費用）
  const t = (i.customerTurnText ?? "").normalize("NFKC");
  if (!t.trim()) return null;
  const wantsView = VIEW_WISH_RE.test(t), wantsCost = COST_ASK_RE.test(t);
  if (!wantsView || !wantsCost) return null;
  if (sent === "property_check_result" && /^(?:available)$/.test(String(i.checkPattern ?? ""))) {
    return { action: "estimate_sheet", why: "内見と初期費用の2つのご依頼＝空きの確認の次は初期費用の見積書（その後に内覧日の調整）" };
  }
  if (sent === "estimate_sheet") return { action: "viewing_invite", why: "内見と初期費用の2つのご依頼＝見積書（確認の形）の次は内覧日の調整" };
  return null;
}

/**
 * 直前に送った AIX の後の「次の AIX」（同じテンプレの2通目でない時だけ）。無ければ null（今まで通りの帯）。
 * hasConditions: 希望の条件（エリアと家賃）がそろっているか
 * order: 1つの発言に複数の依頼がある時の順番（nextAixInRequestOrder の入力）。先に見る
 */
export function nextAixAfterAix(i: { aixType: string | null | undefined; checkPattern?: string | null; hasConditions: boolean; order?: Omit<Parameters<typeof nextAixInRequestOrder>[0], "aixType" | "checkPattern"> | null }): NextAixAfterAix | null {
  if (i.order) { const o = nextAixInRequestOrder({ ...i.order, aixType: i.aixType, checkPattern: i.checkPattern }); if (o) return o; }
  if (i.aixType === "property_send") return { action: "property_recommendation", why: "物件ピックアップした の続き＝その中から1件オススメ" };
  if (i.aixType === "property_check_result" && /^(?:unavailable|all_unavailable|none_available)$/.test(String(i.checkPattern ?? ""))) {
    return i.hasConditions
      ? { action: "property_send", why: "送って頂いた物件が募集に出ていない＝ご条件に合う物件を新しくピックアップ" }
      : { action: "condition_hearing", why: "送って頂いた物件が募集に出ていない・ご条件がまだ＝条件を聞く" };
  }
  return null;
}
/**
 * 最後の AIX の前のお客様の連投（最大6通・AIX の24時間前まで）。
 *   AIX の直前のこちらの通（AIX・「かしこまりました」等の手打ち）は飛ばし、お客様の通を集めた後にこちらの通に当たったら止める
 */
export function customerTurnBeforeAix(msgs: ReadonlyArray<PostAixTurnMsg>, aixAtIso: string | null | undefined): string {
  const at = Date.parse(String(aixAtIso ?? ""));
  if (!Number.isFinite(at)) return "";
  const out: string[] = [];
  for (let k = msgs.length - 1; k >= 0 && out.length < 6; k--) {
    const m = msgs[k];
    const t = Date.parse(String(m.rawCreatedAt ?? ""));
    if (!Number.isFinite(t) || t >= at) continue;
    if (at - t > 86_400_000) break;
    if (m.sender === "customer") { out.unshift(String(m.text ?? "")); continue; }
    if (out.length) break;
  }
  return out.join("\n");
}
/** ブレインの本質の依頼（今のお客様の番を見た判断だけ・analyzed_msg_ts が最後のお客様の発言より前なら使わない） */
export function freshContractAsks(meta: unknown, msgs: ReadonlyArray<PostAixTurnMsg>): Array<{ route?: unknown; aix?: unknown }> | null {
  const m = meta as { turn_contract?: { asks?: unknown }; analyzed_msg_ts?: string | null } | null | undefined;
  const asks = m?.turn_contract?.asks;
  if (!Array.isArray(asks)) return null;
  const analyzed = Date.parse(String(m?.analyzed_msg_ts ?? ""));
  if (!Number.isFinite(analyzed)) return null;
  let lastCust = -Infinity;
  for (const x of msgs) if (x.sender === "customer") { const t = Date.parse(String(x.rawCreatedAt ?? "")); if (Number.isFinite(t) && t > lastCust) lastCust = t; }
  return analyzed >= lastCust - 5000 ? asks as Array<{ route?: unknown; aix?: unknown }> : null;
}
/** 条件の行（property_customers）から「エリアと家賃がそろっている」 */
export function hasSearchConditions(row: { desired_area?: string | null; rent_max?: number | null } | null | undefined): boolean {
  return !!(row && String(row.desired_area ?? "").trim() && typeof row.rent_max === "number" && row.rent_max > 0);
}
