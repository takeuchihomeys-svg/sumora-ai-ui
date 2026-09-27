// app/lib/aix-button-view.ts
// トーク画面の AIX のボタン（ブレインのカード・2択・誘導の帯・AIX ボタンの点滅・「✓ 確認した」・一覧の AIX バッジ・
// AIX メニューのおすすめ枠）を「今の値で画面が何を出すか」として決める純関数（依存なし・画面とサーバー・スクリプトの共用）。
//
// 2026-09-27 竹内さん「AIXのボタンが表示されるタイミングとかもズレや問題、違うのが出たりする場合そこのズレも修正する」:
//   旧は page.tsx の中に判定が散らばっていて（isBrainAixFresh・brainAixAction・isAixBadge・帯の優先度の早期 return）、
//   本番のデータに当てて「その時画面が何を出していたか」を測れなかった → ここに切り出して page.tsx はこれを呼ぶだけにした。
//   決まり（feedback_brain_owns_aix）: AIX が要るか・どの AIX かはブレインだけが決める。画面は判断を読むだけ。
//
// 直したズレ（legacy: true で旧の動きを再現できる。監査 scripts/audit-aix-button.ts が前後を並べる）:
//   A. ブレインの最新の判断が「AIX なし」なのに、手元に控えた前の判断（下書きを出した時の控え）の AIX で点滅・帯が出ていた
//      → 今の判断（suggested_aix_meta）がある時は控えに落ちない
//   B. 手元の控え（下書きの生成・再生成で届いた AIX）は analyzed_msg_ts を持たないことがあり、鮮度を見ずに通っていた
//      → 控えにも「どのお客様の発言への判断か」を付け（画面が控えた時の最新のお客様の発言の時刻）、新しい発言が来たら使わない
//   C. 控えの AIX を送った後も、次のお客様の発言まで同じ AIX の点滅・「✓ 確認した」が残っていた（DB の判断は送信で消える）
//      → 判断の後にスタッフが AIX を送っていたら控えは使わない（DB と同じ）
//   D. 一覧の AIX バッジは鮮度を見ていなかった（分析中に届いた2通目の前の判断でもバッジが出る）→ 読み込み済みのメッセージがあれば鮮度を見る
//   E. 2択（two_choice_mode）や2つ目の AIX（alt_actions）を持つ判断でも、先に並ぶ単独の帯（物件ピックアップ・見積書・内覧・待ち合わせ）が
//      カードを隠していた（2択なのに「返信する」が出ない・AIX ボタンも隠れたまま）→ 2択・2つ目の AIX がある時は帯を出さずカードを出す
//   F. 2択のカードは note が空だと出ず、AIX ボタンだけ隠れていた（AIX を押す道が無くなる）→ 2択のカードは note を要らない・
//      AIX ボタンを隠すのはカードを実際に出している時だけ
//   G. 帯・カードの ✕ や押下は会話ごとに一度きりで、同じタブの間は次の発言の判断でも二度と出なかった
//      → 却下の鍵を「会話＋判断（見た発言の時刻・AIX の種類・2択）」にする（brainDecisionKey）
//   H. AIX メニューのおすすめ枠がブレインの判断でない頻度の推薦（/api/aix/suggest）や古い判断の見積書でも光っていた
//      → おすすめ枠はブレインの今の判断の AIX だけ
//   I. 通常の返信を先に送ると DB の判断（suggested_aix_meta）が送信で消え、カード・帯・点滅も消えるのに、
//      売上番長グループの AIX要対応（aix_action_items の pending）は残っていた（本番: 返信の後に同じ番で同じ AIX を押した 36件・
//      中央47分後・押す時にはカードが無かった）。2026-09-27 竹内さん「それでおねがい」
//      → 返信の後も、その判断の AIX要対応が pending の間はカードを残す（pendingItemMeta）。
//        消える: AIX を送った（どの AIX でも完了になる）・AIX要対応が✅／取り下げ（画面の30秒の読み直しで pending から外れる）・
//        新しいお客様の発言（新しい判断）。返信をまだ送っていない間（下書きを出して判断が消えただけ）は今まで通り出さない

import { BRAIN_FRESHNESS_TOLERANCE_MS } from "./brain-meta-restore";

/** ブレインの action → 画面の AIX ボタンの名前（page.tsx の BRAIN_AIX_LABELS をここに移した。表記は aix-taxonomy と揃える） */
export const BRAIN_AIX_LABELS: Record<string, string> = {
  estimate_sheet:          "AIX 見積書送る",
  property_check_result:   "AIX 物件確認した",
  acknowledge_check:       "AIX 確認します",
  viewing_invite:          "AIX 内覧日調整",
  meeting_place:           "AIX 待ち合わせ",
  application_push:        "AIX 申込へ！",
  property_send:           "AIX 物件ピックアップ",
  property_recommendation: "AIX 物件オススメ",
  condition_hearing:       "AIX 条件ヒアリング",
  followup_revive:         "AIX 追客する",
  greeting_viewing:        "AIX 内覧挨拶",
  property_search:         "AIX 物件を探す",
  cost_explain:            "AIX 初期費用を説明",
  cost_breakdown:          "AIX 初期費用について",
  phone_call:              "AIX 電話をかける",
  guarantor_info:          "AIX 保証会社について",
};

export type AixViewMeta = {
  action?: string | null;
  check_pattern?: string | null;
  note?: string | null;
  analyzed_msg_ts?: string | null;
  reply_mode?: string | null;
  two_choice_mode?: boolean | null;
  alt_actions?: string[] | null;
  source?: string | null;
  decision_source?: string | null;
  first_contact_pickup?: string | null;
  reply_direction_label?: string | null;
};

export type AixViewMessage = { sender: string; rawCreatedAt?: string | null; isAix?: boolean };

const tsMs = (s: string | null | undefined): number => {
  if (!s) return NaN;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : NaN;
};

/** 最新のお客様の発言の時刻（無ければ null） */
export function latestCustomerTs(msgs: AixViewMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].sender === "customer") return msgs[i].rawCreatedAt ?? null;
  return null;
}

/**
 * ブレインの判断が「最新のお客様の発言」を見た後のものか（page.tsx の旧 isBrainAixFresh と同じ）。
 * requireTs=false: analyzed_msg_ts を持たない判断も認める（旧の控えの扱い。legacy の再現だけで使う）
 */
export function isBrainAixFresh(meta: { analyzed_msg_ts?: string | null } | null | undefined, msgs: AixViewMessage[], requireTs = true): boolean {
  if (!meta) return false;
  const latest = latestCustomerTs(msgs);
  if (!meta.analyzed_msg_ts) return !requireTs;
  if (!latest) return false;
  return tsMs(meta.analyzed_msg_ts) >= tsMs(latest) - BRAIN_FRESHNESS_TOLERANCE_MS;
}

/** 画面の AIX 提案がブレインの判断と同じ AIX か。property_check は property_check_result の旧名なので同一視する */
export function sameAixAction(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (x: string) => (x === "property_check" ? "property_check_result" : x);
  return norm(a) === norm(b);
}

/** 判断の名札（帯・カードの却下の鍵に使う）。同じ発言への判断でも AIX の種類・2択が変われば別の判断 */
export function brainDecisionKey(meta: AixViewMeta | null | undefined): string {
  if (!meta) return "none";
  return `${meta.analyzed_msg_ts ?? ""}|${meta.action ?? ""}|${meta.two_choice_mode ? "2" : ""}`;
}

/** 却下の鍵（会話＋判断）。旧は会話 id だけで、一度 ✕・押下した会話は同じタブの間ずっと出なかった（G） */
export function aixDismissKey(conversationId: string, meta: AixViewMeta | null | undefined, legacy = false): string {
  return legacy ? conversationId : `${conversationId}#${brainDecisionKey(meta)}`;
}

/** 手元の控え（下書き表示・生成で届いた AIX）。turn_ts: 控えた時の最新のお客様の発言の時刻（analyzed_msg_ts が無い控え用） */
export type KeptAix = { action?: string | null; analyzed_msg_ts?: string | null; turn_ts?: string | null } | null | undefined;

/** 判断の後にスタッフが AIX を送ったか（DB の判断は送信で消える＝控えも使わない） */
function staffAixSentAfter(msgs: AixViewMessage[], ts: string | null | undefined): boolean {
  const t = tsMs(ts);
  if (!Number.isFinite(t)) return false;
  return msgs.some((m) => m.sender === "staff" && m.isAix && tsMs(m.rawCreatedAt) > t);
}

/** 売上番長グループの AIX要対応（aix_action_items の pending 1件。画面は30秒の読み直しで読む） */
export type PendingAixItem = { action?: string | null; check_pattern?: string | null; brain_analyzed_msg_ts?: string | null } | null | undefined;

/** AIX要対応から戻した判断の印（source）。カードの出所の見分けに使う */
export const PENDING_ITEM_SOURCE = "aix_action_item";

/**
 * I: 通常の返信の後も AIX要対応が pending の間は、その判断をカードに戻す（無ければ null）。
 *   条件: DB の判断が無い（送信で消えた）／実在の AIX ボタン／AIX要対応が見た発言が最新のお客様の発言（新しい発言が来ていない）／
 *        その発言の後にスタッフが通常の返信を送った（下書きを出しただけの間は出さない）／その後に AIX を送っていない。
 *   AIX要対応には note・2択・2つ目の AIX が残らないので、戻すのは AIX のボタン1つのカード（note なし）。
 */
export function pendingItemMeta(input: { meta: AixViewMeta | null | undefined; pending: PendingAixItem; messages: AixViewMessage[] }): AixViewMeta | null {
  const { meta, pending, messages } = input;
  if (meta || !pending?.action || !BRAIN_AIX_LABELS[pending.action]) return null;
  const ts = pending.brain_analyzed_msg_ts ?? null;
  if (!ts || !isBrainAixFresh({ analyzed_msg_ts: ts }, messages)) return null;
  const turnTs = latestCustomerTs(messages) ?? ts;
  const t = tsMs(turnTs);
  const repliedAfter = messages.some((m) => m.sender === "staff" && !m.isAix && tsMs(m.rawCreatedAt) > t);
  if (!repliedAfter || staffAixSentAfter(messages, turnTs)) return null;
  return { action: pending.action, check_pattern: pending.check_pattern ?? null, analyzed_msg_ts: ts, reply_mode: "aix", source: PENDING_ITEM_SOURCE, note: null };
}

/**
 * 却下（✕・押下）を引く鍵の一覧。AIX要対応から戻したカードは2択かどうかが分からないので、
 * 同じ判断の2択の鍵も見る（2択で「返信する」を押した判断を、返信の後に AIX のカードで出し直さない）
 */
export function aixDismissKeys(conversationId: string, meta: AixViewMeta | null | undefined): string[] {
  const k = aixDismissKey(conversationId, meta);
  if (meta?.source !== PENDING_ITEM_SOURCE) return [k];
  return [k, aixDismissKey(conversationId, { ...meta, two_choice_mode: true })];
}

/**
 * ブレインが「今のお客様の発言に AIX が要る」と判断した AIX（無ければ null）。点滅・帯・「✓ 確認した」の元。
 * meta: conversations.suggested_aix_meta（DB の今の判断）／kept: 下書きを出した時に控えた判断
 */
export function resolveBrainAixAction(input: { meta: AixViewMeta | null | undefined; kept?: KeptAix; messages: AixViewMessage[]; legacy?: boolean }): string | null {
  const { meta, kept, messages, legacy } = input;
  if (legacy) {
    if (meta?.action) return isBrainAixFresh(meta, messages) ? meta.action : null;
    if (kept?.action) return isBrainAixFresh(kept, messages, false) ? kept.action : null;
    return null;
  }
  // A: 今の判断があればそれだけを見る（AIX なし＝null。古い判断＝null。控えに落ちない）
  if (meta) return isBrainAixFresh(meta, messages) && meta.action ? meta.action : null;
  if (!kept?.action) return null;
  // B: 控えは「どの発言への判断か」を必ず持つ（analyzed_msg_ts か、控えた時の最新の発言）
  const keptTs = kept.analyzed_msg_ts ?? kept.turn_ts ?? null;
  if (!keptTs || !isBrainAixFresh({ analyzed_msg_ts: keptTs }, messages)) return null;
  // C: 判断の後に AIX を送っていたら使わない
  if (staffAixSentAfter(messages, keptTs)) return null;
  return kept.action;
}

/**
 * 一覧の「AIX」バッジ（次に AIX ボタンで対応すべき顧客）。バッジ・絞り込み・件数で共有する。
 * 条件は aix-action-items.syncAixActionItem と同じ: 実在の AIX ボタン・reply_mode=aix・cached でない。
 * D: 読み込み済みのメッセージがあれば鮮度も見る（分析中に届いた発言の前の判断でバッジを出さない）
 */
export function isAixListBadge(c: { meta: AixViewMeta | null | undefined; lastSender?: string | null; messages?: AixViewMessage[] | null }, legacy = false): boolean {
  const m = c.meta;
  if (!m || m.source === "cached") return false;
  const byStaffPromise = /^(promise:|signal:pending_pickup)/.test(m.decision_source ?? "");
  if (c.lastSender !== "customer" && !byStaffPromise) return false;
  if (!legacy && c.messages && c.messages.length > 0 && latestCustomerTs(c.messages) && !isBrainAixFresh(m, c.messages)) return false;
  if (m.first_contact_pickup) return true;
  return !!m.action && !!BRAIN_AIX_LABELS[m.action] && m.reply_mode === "aix";
}

/** 却下の状態（page.tsx の dismissed*Ids を今の鍵で引いた結果） */
export type AixDismissState = {
  brainHint?: boolean;       // P5 ブレインのカード・2択（dismissedBrainHintIds）
  viewingSpecific?: boolean; // P3.2.5
  meetingPlace?: boolean;    // P3.3・P3.6
  newListing?: boolean;      // P3.4
  viewingInvite?: boolean;   // P3.5
  estimateSheet?: boolean;   // P4.5
};

/** P3.2.5〜P4.5 の単独の帯（page.tsx の並び順どおり） */
export type AixEarlyBanner =
  | "viewing_specific"      // P3.2.5 AIX 内覧へ！（ブレイン viewing_invite・最後がお客様）
  | "meeting_place_guide"   // P3.3 AIX 待ち合わせ
  | "property_send"         // P3.4 AIX 物件ピックアップ
  | "viewing_invite"        // P3.5 AIX 内覧へ！
  | "meeting_place_meta"    // P3.6 AIX 待ち合わせ
  | "estimate_sheet";       // P4.5 AIX 見積書

export type AixCard = {
  kind: "two_choice" | "brain_button";
  action: string;
  altActions: string[];
  replyDirectionLabel: string | null;
};

export type AixButtonView = {
  /** 点滅・帯・「✓ 確認した」の元（ブレインの今の判断の AIX） */
  brainAixAction: string | null;
  /** DB の判断が最新のお客様の発言を見たか（帯・カードの前提） */
  metaFresh: boolean;
  /** AIX ボタンの点滅の色の元 */
  pulse: "property_check_result" | "meeting_place" | "estimate_sheet" | null;
  /** 「✓ 確認した」ショートカット */
  checkShortcut: boolean;
  /** 2択のカードを出している間は AIX ボタンを隠す */
  aixMenuButtonHidden: boolean;
  /** P3.2.5〜P4.5 の帯（無ければ null）。P4 以降のブレイン以外の帯より前に並ぶ */
  earlyBanner: AixEarlyBanner | null;
  /** P5 ブレインのカード（帯が無い時。P4・P4.5 の送信直後の帯より後ろに並ぶ） */
  card: AixCard | null;
  /** AIX メニューで光らせる AIX（ブレインの今の判断だけ） */
  menuHighlight: string | null;
  /** 一覧の AIX バッジ */
  listBadge: boolean;
  /** I: 返信の後に AIX要対応から戻した判断（カードの元。DB の判断がある時・戻さない時は null） */
  pendingMeta: AixViewMeta | null;
};

export type AixButtonViewInput = {
  meta: AixViewMeta | null | undefined;
  kept?: KeptAix;
  messages: AixViewMessage[];
  lastSender?: string | null;
  /** AIX のフロー中（モーダルを開いている）は点滅・帯を出さない */
  activeAixFlow?: string | null;
  dismissed?: AixDismissState;
  /** P3 の内覧テンプレの帯が出ている（P3.5 はその間出さない） */
  viewingTemplatePending?: boolean;
  /** I: この会話の AIX要対応（pending）。返信の後もカードを残すかの元 */
  pendingItem?: PendingAixItem;
  legacy?: boolean;
};

/** 今の値で画面が出す AIX（page.tsx はこれを呼ぶだけ・お客様役の検査・監査も同じ関数を当てる） */
export function resolveAixButtonView(input: AixButtonViewInput): AixButtonView {
  const { kept, messages, activeAixFlow, legacy } = input;
  const d = input.dismissed ?? {};
  const lastSender = input.lastSender ?? messages[messages.length - 1]?.sender ?? null;
  const customerIsLast = lastSender === "customer";
  // I: 返信の後（DB の判断が送信で消えた）でも AIX要対応が pending なら、その判断を今の判断として読む（一覧のバッジは元のまま）
  const pendingMeta = legacy ? null : pendingItemMeta({ meta: input.meta, pending: input.pendingItem, messages });
  const meta = pendingMeta ?? input.meta;
  const brainAixAction = resolveBrainAixAction({ meta, kept, messages, legacy });
  const metaFresh = isBrainAixFresh(meta, messages);
  const flow = !!activeAixFlow;

  const guideCheck = !flow && sameAixAction(brainAixAction, "property_check_result");
  const guideMeeting = !flow && brainAixAction === "meeting_place";
  const pulse: AixButtonView["pulse"] = flow ? null
    : guideCheck ? "property_check_result"
    : guideMeeting ? "meeting_place"
    : brainAixAction === "estimate_sheet" ? "estimate_sheet"
    : null;

  // P5 のカード（帯より後ろだが、E の判定に要るので先に作る）
  const action = meta?.action ?? "";
  const hasValidAction = !!(action && BRAIN_AIX_LABELS[action]);
  const alt = (meta?.alt_actions ?? []).filter((a) => a !== action && !!BRAIN_AIX_LABELS[a]);
  // 内覧へ！は最後がスタッフ（物件を送った後）の古い判断では出さない。AIX要対応から戻した判断は見た発言が最新なので止めない
  const viewingBlocked = action === "viewing_invite" && !customerIsLast && !pendingMeta;
  let card: AixCard | null = null;
  if (metaFresh && !d.brainHint && !viewingBlocked) {
    const two = !!meta?.two_choice_mode;
    // 旧: note 必須（2択も・AIX のカードも）。F: note が空でもカードは出す（note の行を出さないだけ）
    //   （旧の page.tsx の「ボタンなし（未知アクション）」の枝は hasValidAction か2択が前提なので通らない）
    const cardAllowed = legacy ? (!!meta?.note && (hasValidAction || two)) : (two || hasValidAction);
    if (cardAllowed) {
      if (two) card = { kind: "two_choice", action, altActions: [], replyDirectionLabel: meta?.reply_direction_label ?? null };
      else card = { kind: "brain_button", action, altActions: alt, replyDirectionLabel: null };
    }
  }

  // P3.2.5〜P4.5 の帯（旧の並び・条件のまま）
  let earlyBanner: AixEarlyBanner | null = null;
  // E: 2択・2つ目の AIX を持つカードを出す時は単独の帯で隠さない
  const cardOwnsTurn = !legacy && !!card && (card.kind === "two_choice" || card.altActions.length > 0);
  if (!cardOwnsTurn) {
    if (!flow && customerIsLast && brainAixAction === "viewing_invite" && !d.viewingSpecific) earlyBanner = "viewing_specific";
    else if (metaFresh && guideMeeting && !d.meetingPlace) earlyBanner = "meeting_place_guide";
    else if (metaFresh && !flow && brainAixAction === "property_send" && !d.newListing) earlyBanner = "property_send";
    else if (metaFresh && meta?.action === "viewing_invite" && customerIsLast && !input.viewingTemplatePending && !d.viewingInvite) earlyBanner = "viewing_invite";
    else if (metaFresh && meta?.action === "meeting_place" && !d.meetingPlace) earlyBanner = "meeting_place_meta";
    else if (metaFresh && meta?.action === "estimate_sheet" && !d.estimateSheet) earlyBanner = "estimate_sheet";
  }

  // 旧: 2択の判断があれば（鮮度・カードの有無を見ずに）AIX ボタンを隠していた。F: カードを実際に出している時だけ
  const aixMenuButtonHidden = legacy
    ? !!(meta?.two_choice_mode && !d.brainHint)
    : !!(card && card.kind === "two_choice" && !earlyBanner);

  const menuHighlight = legacy
    ? (guideCheck ? "property_check_result" : guideMeeting ? "meeting_place" : meta?.action === "estimate_sheet" ? "estimate_sheet" : null)
    : (flow ? null : brainAixAction);

  return {
    brainAixAction,
    metaFresh,
    pulse,
    checkShortcut: guideCheck,
    aixMenuButtonHidden,
    earlyBanner,
    card: earlyBanner ? null : card,
    menuHighlight,
    listBadge: isAixListBadge({ meta: input.meta, lastSender, messages }, legacy),
    pendingMeta,
  };
}

/** 画面に出る AIX の種類を1つに畳む（監査・お客様役の検査用）。帯＞カード＞点滅の順。2択は "two_choice:<action>" */
export function summarizeAixButtonView(v: AixButtonView): { shown: string | null; channel: "banner" | "card" | "two_choice" | "pulse" | "none" } {
  const BANNER_ACTION: Record<AixEarlyBanner, string> = {
    viewing_specific: "viewing_invite", meeting_place_guide: "meeting_place", property_send: "property_send",
    viewing_invite: "viewing_invite", meeting_place_meta: "meeting_place", estimate_sheet: "estimate_sheet",
  };
  if (v.earlyBanner) return { shown: BANNER_ACTION[v.earlyBanner], channel: "banner" };
  if (v.card?.kind === "two_choice") return { shown: `two_choice:${v.card.action || "property_recommendation"}`, channel: "two_choice" };
  if (v.card?.kind === "brain_button") return { shown: v.card.action, channel: "card" };
  if (v.pulse) return { shown: v.pulse, channel: "pulse" };
  return { shown: null, channel: "none" };
}
