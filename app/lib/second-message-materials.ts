// app/lib/second-message-materials.ts
// AIX の2通目（AIX で物件の画像・見積書を送った直後の文・aix-template-generate の ✨）に、返信の書く役と同じ材料と同じ確かめを渡す（純関数・DB 依存なし）。
//
// 2026-10-20 竹内さん（P1 ef272b2d）「この2通目の文を作成する部分の所も弱すぎる。返信の部分も参考に、ブレインの部分も参考に強化する」／
//   （P1 12adf1bd）「見積書2枚送っている場合、2枚分の見積書について送る形とする」。
//   試験 q182〜q189: 約束の答え（空き状況＝305号室のみ）が無い・何も送っていないのにご査収・送った物の種類の取り違え（物件資料⇔見積書）・
//   見積書2件を1件として書く・聞かれた事（角部屋は空いているか）に答えない・初期費用と月額の取り違え。
//
// 材料は作り直さない（返信と同じ関数を使う）:
//   ・お客様のまだ答えていない依頼・質問 … request-ledger.buildRequestLedger（会話画面の帯・返信と同じ）
//   ・まだ果たしていない約束 … promise-tracker.trackPromises（ブレインと同じ）
//   ・確認の結果（約束の答え） … action-ledger.findConfirmReportSentence（AIX の確認の結果の文）
//   ・送った見積書の件数・物件名 … estimate-second-message.isEstimateCard / estimatePropertiesOf
//   ・会社として決まっている事実 … company-facts.buildCompanyFactsNote（呼ぶ側）
// 切替: 2026-10-22 既定 on（止める SECOND_MSG_MATERIALS=off＝プロンプトも出力も旧と1文字も同じ）。試し（✨2通目 22番・竹内さんの送信が正解・scripts/yuma-r11-aix-text.ts --toggle）: 似ている度 0.372→0.380・作り事 0/0・見積書の後のご査収の食い違い 3→2。
//   10/22 足した材料（同じスイッチの中）: 統括（LINE のブレイン）の判断の束（ボタン・ピッカー・なぜ・この AIX で受ける依頼・続けて送る物）／
//   このボタン・ピッカーの意味（竹内基準・aix-catalog.aixMeaningForGenerator・お手本の文は渡さない）／物件の判断の中身（売上サポの理由・合う条件・決め手・お客様の反応）
import { buildRequestLedger, applyBrainRequestStatus, uncoveredRequests, TOPIC_JA, type LedgerItem, type RequestItem } from "./request-ledger";
import { trackPromises, type OpenPromise } from "./promise-tracker";
import { findConfirmReportSentence } from "./action-ledger";
import { isEstimateCard, estimatePropertiesOf } from "./estimate-second-message";
import { contractFreshForAix, askIsThisAix, promiseFulfilledBy } from "./aix-brain-contract";
import { normalizeBrainTurnContract } from "./turn-contract";

export function secondMsgMaterialsOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SECOND_MSG_MATERIALS ?? "").trim().toLowerCase() !== "off";
}

/** 画面の会話は画像の通を text 空＋imageUrl で渡す（試験・DB は "[画像]"）＝どちらも画像の通として数える */
export type SmMsg = { sender?: string | null; text?: string | null; isAix?: boolean | null; rawCreatedAt?: string | null; imageUrl?: string | null };
const textOfMsg = (m: SmMsg | null | undefined): string => {
  const t = String(m?.text ?? "");
  return !t.trim() && String(m?.imageUrl ?? "").trim() ? "[画像]" : t;
};

/** この番の送信のまとまり（最後の送信から3時間） */
export const TURN_WINDOW_MS = 3 * 3600_000;

const IMAGE_ONLY_RE = /^\s*\[(?:画像|動画|ファイル)\]\s*$/;

/**
 * この番（最後のお客様の発言より後のこちらの送信）と、それより前を分ける。
 * 画面が渡した1通目（sentMessage）が履歴にまだ無ければ、この番の最後に足す。
 */
export function splitTurn(msgs: ReadonlyArray<SmMsg>, sentMessage?: string | null): { before: SmMsg[]; turnStaff: string[] } {
  const list = Array.isArray(msgs) ? msgs : [];
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.sender === "customer") { last = i; break; }
  // この番の送信は直近のまとまりだけ（最後の送信から3時間より前の物は前の番＝お客様が返事をしないまま続けた別の件）
  const staffMsgs = list.slice(last + 1).filter((m) => m?.sender !== "customer" && textOfMsg(m).trim());
  const times = staffMsgs.map((m) => (m?.rawCreatedAt ? Date.parse(m.rawCreatedAt) : NaN));
  const newest = Math.max(...times.filter((t) => Number.isFinite(t)), -Infinity);
  const turnStaff = staffMsgs.filter((_, k) => !Number.isFinite(newest) || !Number.isFinite(times[k]) || newest - times[k] <= TURN_WINDOW_MS).map((m) => textOfMsg(m));
  const sm = String(sentMessage ?? "").trim();
  if (sm && !turnStaff.some((t) => t.trim() === sm)) turnStaff.push(sm);
  return { before: list.slice(0, last + 1), turnStaff };
}

export type SentKind = "estimate" | "property_images" | "check_result" | "images" | "none";
export type SentThisTurn = {
  /** この番で送った見積書の物件（【】の見出し・重なりなし・送った順） */
  estimates: string[];
  estimateCards: number;
  images: number;
  kind: SentKind;
  /** 何かを送った（資料・画像・見積書・URL）＝「ご査収」を書いてよい */
  anySent: boolean;
  /**
   * 送ったか分からない（物件確認した で画像・URL がまだ会話に見えない）＝「ご査収」は外さない。
   * 2026-10-22 質問11（scripts/audit-second-receipt-other-room.ts・90日）: 物件確認した の後に竹内さん達が「ご査収」を書いた 24番のうち、
   *   募集なし→別の部屋の画像の 5番は、画像が会話に見えないと全部外していた（画面は画像の通を text 空で渡す＝見えなかった）／
   *   室内イメージの URL だけの番 2番は画像が見えても外していた
   */
  uncertain?: boolean;
};
const URL_RE = /https?:\/\/\S+|〈URL〉|<URL>/;

/** 物件の資料（画像）を送る AIX */
const PROPERTY_IMAGE_ACTIONS: ReadonlySet<string> = new Set(["property_send", "property_recommendation"]);

/** この番で実際に送った物（件数と種類）。種類は AIX の種類と1通目の本文（見積書の本体か）で決める */
export function sentThisTurn(i: { actionType?: string | null; turnStaff: ReadonlyArray<string> }): SentThisTurn {
  const a = String(i.actionType ?? "").trim();
  const cards = i.turnStaff.filter((t) => isEstimateCard(t));
  const estimates: string[] = [];
  for (const c of cards) for (const p of estimatePropertiesOf(c)) if (!estimates.includes(p)) estimates.push(p);
  // ↑ 1枚の見積書に同じ物件の見出しが2回ある・同じ見積書を送り直した時は1件（重なりなし）
  const images = i.turnStaff.filter((t) => IMAGE_ONLY_RE.test(t)).length;
  // 室内イメージ・資料の URL（物件確認した→室内写真）も送った物（竹内さん「こちら室内イメージとなります😊！！お手隙の際にご査収ください！！」）
  const links = i.turnStaff.filter((t) => URL_RE.test(t)).length;
  // 種類は AIX の種類が先（物件オススメの番に前の見積書が残っていても見積書の番にしない）。種類の無い・他の AIX は送った物で見る
  const kind: SentKind = a === "estimate_sheet" ? "estimate"
    : PROPERTY_IMAGE_ACTIONS.has(a) ? "property_images"
    : a === "property_check_result" ? (cards.length > 0 ? "estimate" : images + links > 0 ? "images" : "check_result")
    : cards.length > 0 ? "estimate"
    : images > 0 ? "images" : "none";
  if (kind !== "estimate") estimates.length = 0;
  const anySent = cards.length > 0 || images > 0 || links > 0 || ((kind === "estimate" || kind === "property_images") && i.turnStaff.length > 0);
  return { estimates, estimateCards: cards.length, images, kind, anySent, ...(kind === "check_result" && !anySent ? { uncertain: true } : {}) };
}

const msOf = (iso: string | null | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

/** 時刻を付けた古い順の発言（時刻の無い通は前の通の直後とみなす・1通目は今） */
function timed(msgs: ReadonlyArray<SmMsg>, turnStaff: ReadonlyArray<string>, nowMs: number): Array<{ sender: string; text: string; createdAt: string; isAix: boolean }> {
  const out: Array<{ sender: string; text: string; createdAt: string; isAix: boolean }> = [];
  let prev = nowMs - 86_400_000;
  for (const m of msgs) {
    const t = msOf(m?.rawCreatedAt ?? null, prev + 1000);
    prev = t;
    out.push({ sender: m?.sender === "customer" ? "customer" : "staff", text: String(m?.text ?? ""), createdAt: new Date(t).toISOString(), isAix: !!m?.isAix });
  }
  const seen = new Set(msgs.map((m) => String(m?.text ?? "").trim()));
  for (const t of turnStaff) {
    if (seen.has(t.trim())) continue;
    prev = Math.max(prev + 1000, nowMs - 1000);
    out.push({ sender: "staff", text: t, createdAt: new Date(prev).toISOString(), isAix: true });
  }
  return out;
}

/**
 * お客様のまだ答えていない依頼・質問。
 *   ① この番より前（こちらが今回送る前）の発言から buildRequestLedger（会話画面の帯と同じ網）で「済み」でない物を拾い、
 *     ブレインの判断（suggested_aix_meta.request_status）があれば帯と同じ applyBrainRequestStatus で上書きする（判断はブレイン基準）。
 *   ② この番の送信（1通目）が言葉で触れた物を外す（uncoveredRequests）。
 *     ⚠ 網は「御見積書を送った＝空き・費用に答えた」と見る（帯の数え方）が、2通目では「角部屋は空いていますか」に言葉で答える必要があるので、ここは言葉で見る。
 *   種類の無い物（その他）・先の時期の相談は入れない。
 */
export function outstandingAsks(msgs: ReadonlyArray<SmMsg>, turnStaff: ReadonlyArray<string>, nowMs: number, brainRequestStatus?: unknown): LedgerItem[] {
  const { before } = splitTurn(msgs, null);
  const tm = timed(before, [], nowMs);
  const net = buildRequestLedger(tm, nowMs);
  const ledger = brainRequestStatus ? applyBrainRequestStatus(net, brainRequestStatus, tm, { ui: false }) : net;
  const open = ledger.filter((x) => x.status !== "done" && x.topic !== "other" && !x.deferred);
  const left = new Set(uncoveredRequests(open, turnStaff.join("\n")));
  return open.filter((x) => left.has(x)).slice(-6);
}

/** まだ果たしていない約束（この番の1通目までで果たしていない物） */
export function openPromises(msgs: ReadonlyArray<SmMsg>, turnStaff: ReadonlyArray<string>, nowMs: number): OpenPromise[] {
  return trackPromises(timed(msgs, turnStaff, nowMs), nowMs).open.filter((p) => !/記録なし/.test(p.status));
}

/** 確認の結果（AIX【物件確認した】等の記録）から、約束の答えの文を取り出す（新しい順・同じ文は1つ） */
export function confirmAnswersOf(rows: ReadonlyArray<{ generated_text?: string | null; created_at?: string | null }>, o: { nowMs: number; maxAgeH?: number }): string[] {
  const maxMs = (o.maxAgeH ?? 72) * 3600_000;
  const out: string[] = [];
  for (const r of rows) {
    if (o.nowMs - msOf(r.created_at ?? null, 0) > maxMs) continue;
    const s = findConfirmReportSentence(r.generated_text ?? "");
    if (s && !out.includes(s)) out.push(s.slice(0, 120));
  }
  return out.slice(0, 4);
}

/** お客様が聞いた費用の種類（初期費用＝入居時／月額＝毎月）。両方・どちらでもない時は null */
export function askedCostKind(customerTexts: ReadonlyArray<string>): "initial" | "monthly" | null {
  const t = customerTexts.join("\n").normalize("NFKC");
  const initial = /初期費用|初期|入居時|契約時|敷金|礼金|見積/.test(t);
  const monthly = /月額|月々|毎月|月の(?:支払|家賃)|家賃(?:は|って)?いくら|管理費(?:込み?)?(?:で|は)?いくら/.test(t);
  if (initial && !monthly) return "initial";
  if (monthly && !initial) return "monthly";
  return null;
}

/** この番より前、こちらの最後の送信の後のお客様の発言（今答える番の発言） */
export function lastCustomerBundle(before: ReadonlyArray<SmMsg>): string[] {
  const out: string[] = [];
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i];
    if (m?.sender !== "customer") break;
    out.unshift(String(m?.text ?? ""));
  }
  return out;
}

const SENT_KIND_LINE: Record<SentKind, string> = {
  estimate: "",
  property_images: "送ったのは物件の資料（画像）。「御見積書」とは書かない（見積書はまだ送っていない）。",
  check_result: "送ったのは確認の結果の文（別の部屋の画像・資料を一緒に送った時だけ「ご査収」）。御見積書を送ったとは書かない。",
  images: "",
  none: "この番ではまだ資料・画像・見積書を送っていない（約束の文だけ）。「ご査収ください」は書かない。",
};

export type SecondMaterialsInput = {
  sent: SentThisTurn;
  asks: ReadonlyArray<LedgerItem>;
  promises: ReadonlyArray<OpenPromise>;
  answers: ReadonlyArray<string>;
  ngPoints?: string | null;
  companyFactsNote?: string;
  memoNote?: string;
  costKind?: "initial" | "monthly" | null;
  reactionKind?: string | null;
  /** 統括（LINE のブレイン）の判断の束（buildBrainBundleNote） */
  brainBundleNote?: string;
  /** このボタン・ピッカーの意味（竹内基準・aixMeaningForGenerator） */
  meaningNote?: string;
  /** 物件の判断の中身（buildPropertyJudgeNote） */
  propertyJudgeNote?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-22 統括の判断の束・物件の判断の中身（竹内さん「AIX は LINE のブレイン（統括）が管轄」・P1 696c96ba）
// ─────────────────────────────────────────────────────────────────────────────

export type BrainBundleMeta = {
  action?: string | null;
  check_pattern?: string | null;
  reason?: string | null;
  after_aix_template?: string | null;
  turn_contract?: unknown;
  analyzed_msg_ts?: string | null;
} | null | undefined;

/**
 * 統括（LINE のブレイン）がこの番に決めた判断の束を、2通目の材料にする（1つの束＝ボタン・ピッカー・なぜ・この AIX で受ける依頼・続けて送る物）。
 *   ・古い判断（最後のお客様の発言より前の分析）は渡さない（aix-brain-contract と同じ鮮度の線）。
 *   ・統括の一手と押した AIX が違う番は「なぜ」を渡さない（別の判断の理由で書かない）。この AIX で受ける依頼だけ渡す。
 *   ・答えの値は書かない（値はスタッフの入力・1通目・確認の結果だけ）。
 *   labelOf: ボタン・ピッカーの画面の名前（呼ぶ側が aix-catalog から引く）
 */
export function buildBrainBundleNote(meta: BrainBundleMeta, o: {
  actionType: string | null | undefined;
  checkPattern?: string | null;
  messages?: ReadonlyArray<{ sender?: string | null; rawCreatedAt?: string | null }> | null;
  labelOf?: (aix: string, picker: string | null) => string;
}): string {
  const a = String(o.actionType ?? "").trim();
  if (!meta || !a) return "";
  if (!contractFreshForAix(meta, (o.messages ?? []) as never)) return "";
  const same = !!meta.action && askIsThisAix(String(meta.action), a, null);
  const label = (k: string, p: string | null) => (o.labelOf ? o.labelOf(k, p) : `${k}${p ? `/${p}` : ""}`);
  const L: string[] = [];
  if (same) {
    const cp = String(meta.check_pattern ?? "").trim() || null;
    L.push(`・統括が選んだ一手: ${label(a, cp)}（スタッフが押した物と同じ）`);
    if (meta.reason?.trim()) L.push(`・なぜ（統括）: ${meta.reason.trim().slice(0, 120)}`);
  }
  const c = normalizeBrainTurnContract(meta.turn_contract);
  const asks = ((c?.asks ?? []) as Array<{ quote?: unknown; route?: unknown; answer?: unknown; aix?: unknown }>)
    .filter((x) => (x.route === "aix" && askIsThisAix(String(x.aix ?? ""), a, o.checkPattern ?? null)) || (x.route === "promise" && promiseFulfilledBy(`${x.quote ?? ""} ${x.answer ?? ""}`, a)));
  if (asks.length) {
    L.push("・この AIX で受ける依頼（2通目までで書き切る部品・→ の後は統括の方向。値は1通目・確認の結果・資料の物だけ）:");
    for (const x of asks.slice(0, 4)) L.push(`  - 「${String(x.quote ?? "").slice(0, 60)}」${x.answer ? `→ ${String(x.answer).slice(0, 80)}` : ""}`);
  }
  if (same && meta.after_aix_template?.trim()) L.push(`・この後に続けて送る物（統括）: ${meta.after_aix_template.trim().slice(0, 40)}（2通目で先取りして書かない）`);
  if (!L.length) return "";
  return ["【統括（LINE のブレイン）の判断の束（この番の判断・2通目もこれに沿う。分析の言葉は本文に書かない）】", ...L].join("\n");
}

export type PropertyJudgeInput = {
  /** 物件の見出し（建物名 号室） */
  label: string;
  /** 売上サポで 👑（一番オススメ）にした */
  recommended?: boolean;
  /** 判定の良い所（お客様に関係する物だけ・AD・利益は入れない） */
  goodJa: ReadonlyArray<string>;
  /** 判定で合わない所（良い所として書かない） */
  badJa: ReadonlyArray<string>;
  /** この物件へのお客様の反応（送った物件の時） */
  reaction?: { good?: boolean; declined?: boolean; attrsJa?: ReadonlyArray<string> } | null;
  /** お客様が前に送った物件で言った不満（この物件の良い所の言い方の参考・値は書かない） */
  bundleNegativesJa?: ReadonlyArray<string>;
};

/** AD・利益・割引・業者の推定（お客様に関係しない・言ってはいけない）の言葉 */
const INTERNAL_REASON_RE = /AD|広告|利益|割引|業者|保留の物件|点に入れない|上限\d+点|元付|手数料/;

/**
 * 物件の判断の中身（なぜ推すか・合う条件・点の理由・決め手・お客様の反応）を2通目の材料にする（P1 696c96ba）。
 *   ⚠ 理由に使うのは資料で確かめた事実だけ（判定の言葉をそのまま本文に書かない）。AD・利益・割引の理由は入れない。
 */
export function buildPropertyJudgeNote(i: PropertyJudgeInput | null | undefined): string {
  if (!i || !i.label.trim()) return "";
  const clean = (xs: ReadonlyArray<string> | undefined) => [...new Set((xs ?? []).map((x) => String(x).trim()).filter((x) => x && !INTERNAL_REASON_RE.test(x)))].slice(0, 6);
  const good = clean(i.goodJa), bad = clean(i.badJa), neg = clean(i.bundleNegativesJa);
  const L: string[] = [];
  if (i.recommended) L.push("・売上サポで一番オススメ（👑）にしたお部屋");
  if (good.length) L.push(`・推す理由（お客様のご希望に合う所）: ${good.join("／")}`);
  if (bad.length) L.push(`・ご希望と合わない所（良い所・合う所として書かない）: ${bad.join("／")}`);
  const r = i.reaction;
  if (r?.declined) L.push("・このお部屋はお客様が見送りと言った（推さない・申込へ押さない）");
  else if (r?.good) L.push("・このお部屋にお客様が良い反応をしている（内覧・申込へ進める根拠）");
  if (r?.attrsJa?.length) L.push(`・このお部屋へのお客様の不満: ${clean(r.attrsJa).join("／")}（触れるなら受け止める・打ち消さない）`);
  if (neg.length) L.push(`・前に送ったお部屋でお客様が言った不満: ${neg.join("／")}（このお部屋で解消している点だけ言ってよい）`);
  if (!L.length) return "";
  return [`【物件の判断の中身（${i.label}・売上サポの判定から。値は資料の字のまま・判定の言葉を本文に書かない）】`, ...L].join("\n");
}

/** 2通目に渡す材料の1ブロック（何も無ければ空文字） */
export function buildSecondMaterialsNote(i: SecondMaterialsInput): string {
  const L: string[] = [];
  const s = i.sent;
  if (s.kind === "estimate") {
    if (s.estimates.length >= 2) {
      L.push(`・この番で送った物: 御見積書 ${s.estimates.length}件（${s.estimates.join("・")}）。2通目は${s.estimates.length}件分の御見積書について書く（全部の物件名を並べるか「${s.estimates.length}部屋の」「それぞれ」）。1件の名前だけで書かない。`);
    } else {
      L.push(`・この番で送った物: 御見積書${s.estimates.length === 1 ? `（${s.estimates[0]}）` : ""}。「物件資料」「間取り図」を送ったとは書かない。`);
    }
  } else if (SENT_KIND_LINE[s.kind]) {
    L.push(`・この番で送った物: ${SENT_KIND_LINE[s.kind]}`);
  }
  if (!s.anySent && !s.uncertain) L.push("・何も送っていない番なので「お手隙の際にご査収ください」は書かない。");
  if (i.costKind === "initial") L.push("・お客様が聞いたのは初期費用（入居の時に払う額）。月額（家賃・管理費）の話と取り違えない。");
  else if (i.costKind === "monthly") L.push("・お客様が聞いたのは毎月の額（家賃・管理費）。初期費用の話と取り違えない。");
  if (i.asks.length) {
    L.push("・お客様がまだ答えをもらっていない依頼・質問（会話の帯と同じ読み）:");
    for (const x of i.asks) L.push(`  - ${TOPIC_JA[x.topic]}「${x.quote}」（${x.status === "promised" ? "約束済み・結果待ち" : "まだ触れていない"}）`);
    L.push("  → 答えの事実が1通目・下の確認の結果・会話にあれば、2通目で先に答える（例: 「角部屋につきまして201号室現在も募集中となります！！」）。事実が無ければ作らず「確認させて頂きます」の一文で受ける（落とさない）。");
  }
  if (i.promises.length) {
    L.push("・こちらがした約束でまだ果たしていない物:");
    for (const p of i.promises) L.push(`  - ${p.kind}の約束「${p.sentence}」`);
    L.push("  → 答え（確認の結果）が下にあれば、2通目に入れて約束を閉じる（例: 「〇〇は現在305号室のみ募集に出ております！！」）。無ければ約束を言い直さない。");
  }
  if (i.answers.length) {
    L.push("・確認の結果（AIX の記録・事実の出どころ。書く時はこの言葉どおり・足さない）:");
    for (const a of i.answers) L.push(`  - 「${a}」`);
  }
  if (i.ngPoints?.trim()) L.push(`・お客様の NG 条件（物件の良い所・合う所として書かない）: ${i.ngPoints.trim().slice(0, 160)}`);
  const body = L.join("\n");
  const extra = [
    i.brainBundleNote?.trim() ?? "", i.meaningNote?.trim() ?? "", i.propertyJudgeNote?.trim() ?? "",
    i.companyFactsNote?.trim() ?? "", i.memoNote?.trim() ? `【お客様のメモ（返信と同じ材料・2通目では関係する所だけ使う）】\n${i.memoNote.trim().slice(0, 700)}` : "",
  ].filter(Boolean).join("\n\n");
  if (!body && !extra) return "";
  return [`【2通目の材料（返信の書く役と同じ材料・事実だけ。形と締めは下の【この2通目の形】が正）】`, body, extra].filter(Boolean).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 出口の確かめ（決定論）
// ─────────────────────────────────────────────────────────────────────────────

/** 「お手隙の際にご査収ください」の行（「ご査収頂きありがとうございます」は見てくれた事へのお礼なので当てない） */
const RECEIPT_LINE_RE = /^[^\n]*ご査収(?:ください|下さい|願います|の程)[^\n]*$/gm;

/** 何も送っていないのにご査収を書いた → その行を外す */
export function fixReceiptWhenNotSent(text: string, sent: Pick<SentThisTurn, "anySent"> & { uncertain?: boolean }): { text: string; applied: string[] } {
  if (sent.anySent || sent.uncertain) return { text, applied: [] };
  const applied: string[] = [];
  const out = String(text ?? "").replace(RECEIPT_LINE_RE, (m) => { applied.push(m.trim()); return ""; }).replace(/\n{3,}/g, "\n\n").trim();
  return applied.length ? { text: out, applied } : { text, applied: [] };
}

const DOC_WORD_RE = /物件資料(?:[・や]間取り図)?|お部屋の資料|物件の資料/g;
const ESTIMATE_WORD_RE = /御見積書|お見積書|御見積り|お見積り/;
/** お客様が送った資料の言い方（前: お送り頂いた・頂きました／後: 確認・拝見・ありがとう） */
const CUSTOMER_DOC_BEFORE_RE = /(?:お送り|送って|ご共有|共有)(?:頂|いただ)(?:き|いた)(?:まし)?た?$|(?:頂|いただ)(?:きました|いた)$/;
const CUSTOMER_DOC_AFTER_RE = /^(?:を|の)?(?:確認|拝見|ありがとう|頂|いただ)/;

/** 送った物の種類の言い方の取り違え。kind=estimate なのに「物件資料」と書いた → 御見積書に直す／property_images なのに「御見積書」→ 直さず当たりだけ返す */
export function fixImageTypeWording(text: string, sent: Pick<SentThisTurn, "kind" | "images">): { text: string; applied: string[]; flagged: string[] } {
  const t = String(text ?? "");
  if (sent.kind === "estimate") {
    const applied: string[] = [];
    // お客様が送った資料（「お送り頂きました物件資料確認させて頂きました」）は送った物の話ではないので触らない（レビュー 10/20）
    let out = t.replace(DOC_WORD_RE, (m: string, off: number) => {
      if (CUSTOMER_DOC_BEFORE_RE.test(t.slice(Math.max(0, off - 12), off)) || CUSTOMER_DOC_AFTER_RE.test(t.slice(off + m.length, off + m.length + 12))) return m;
      applied.push(m); return "御見積書";
    });
    out = out.replace(/御見積書[・や]御見積書/g, "御見積書");
    const flagged = /間取り図/.test(out) ? ["間取り図"] : [];
    return { text: applied.length ? out : t, applied, flagged };
  }
  if (sent.kind === "property_images" && ESTIMATE_WORD_RE.test(t) && /(?:となります|お送り|同封|ご査収)/.test(t)) {
    return { text: t, applied: [], flagged: [t.match(ESTIMATE_WORD_RE)![0]] };
  }
  return { text: t, applied: [], flagged: [] };
}

const buildingOf = (label: string) => label.normalize("NFKC").replace(/[\s　]*[0-9A-Za-z-]{1,6}(?:号室)?$/, "").trim();
const COUNT_WORD_RE = /それぞれ|[2-9２-９二三四五]部屋|[2-9２-９二三四五]件|お[2-9２-９二三]部屋|両方|どちらも/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 空白を外した比べ（「メゾン シュシュ」と「メゾンシュシュ」を同じに見る） */
const squash = (x: string) => x.normalize("NFKC").replace(/[\s　]/g, "");
/** 建物名を空白の有無を問わず当てる正規表現（号室が続けばそれも） */
const nameRe = (b: string) => new RegExp(`${[...squash(b)].map(escapeRe).join("[\\s　]*")}[\\s　]*(?:[0-9０-９A-Za-z-]{1,6}(?:号室)?)?`);

/**
 * 見積書を2件以上送ったのに1件の名前だけで書いた → 書いた名前を全部の名前に置き換える（どれも書いていなければ「最大限割引」の前に足す）。
 * 2件は名前を並べる（12adf1bd「メゾンシュシュ・Belle Court大美野 の最大限割引しました」）・3件以上は「N部屋の」（実送信「2部屋の最大限割引させていただきました」の形）
 */
export function fixEstimateNames(text: string, estimates: ReadonlyArray<string>): { text: string; applied: string[]; flagged: string[] } {
  const t = String(text ?? "");
  if (estimates.length < 2) return { text: t, applied: [], flagged: [] };
  const n = squash(t);
  const mentioned = estimates.filter((e) => { const b = squash(buildingOf(e)); return b.length >= 2 && n.includes(b); });
  if (mentioned.length >= 2 || COUNT_WORD_RE.test(t.normalize("NFKC"))) return { text: t, applied: [], flagged: [] };
  const all = estimates.length <= 2 ? estimates.join("・") : `${estimates.length}部屋の`;
  const tidy = (x: string) => x.replace(/部屋のの/g, "部屋の");
  if (mentioned.length === 1) {
    const b = buildingOf(mentioned[0]);
    const re = nameRe(b);
    if (re.test(t)) return { text: tidy(t.replace(re, () => all)), applied: [`${b}→${all}`], flagged: [] };
    return { text: t, applied: [], flagged: [`見積書${estimates.length}件・名前1件`] };
  }
  if (/最大限割引/.test(t)) return { text: tidy(t.replace(/(?:の)?最大限割引/, () => `${all.endsWith("の") ? all : `${all}の`}最大限割引`)), applied: [`+${all}`], flagged: [] };
  return { text: t, applied: [], flagged: [`見積書${estimates.length}件・名前なし`] };
}

/** 2通目（と1通目）で触れていない依頼・質問（直さず当たりだけ返す） */
export function unansweredAsks(asks: ReadonlyArray<LedgerItem | RequestItem>, firstAndSecond: string): RequestItem[] {
  return uncoveredRequests(asks as RequestItem[], firstAndSecond);
}

/** 費用の種類の取り違え（お客様は初期費用を聞いたのに2通目は月額だけ・その逆） */
export function costKindMismatch(text: string, kind: "initial" | "monthly" | null): string | null {
  const t = String(text ?? "").normalize("NFKC");
  if (kind === "initial" && /月額|月々|毎月/.test(t) && !/初期費用|御?見積|お見積/.test(t)) return "初期費用を聞かれたのに月額";
  if (kind === "monthly" && /初期費用/.test(t) && !/月額|月々|毎月|家賃|管理費/.test(t)) return "月額を聞かれたのに初期費用";
  return null;
}

/** 内覧・申込の訴求の一文があるか（測る用） */
export function hasViewingOrApplyPush(text: string): { viewing: boolean; apply: boolean } {
  const t = String(text ?? "");
  return {
    viewing: /(?:ご内覧|ご案内|内覧|内見)(?:させて|頂|いただ|出来|でき|可能)|お部屋ご案内/.test(t),
    apply: /お申込み?し(?:て)?お部屋[をも]?(?:抑え|押さえ)|お申し?込み(?:も)?させて|お部屋(?:を)?(?:抑え|押さえ)させて/.test(t),
  };
}

export type SecondFinalResult = { text: string; applied: string[]; warnings: string[] };

/** 出口の確かめを順に（ご査収 → 種類の言い方 → 見積書の件数 → 触れていない質問・費用の種類は当たりだけ） */
export function applySecondFinalChecks(text: string, i: { sent: SentThisTurn; asks: ReadonlyArray<LedgerItem>; firstMessage?: string | null; costKind?: "initial" | "monthly" | null }): SecondFinalResult {
  const applied: string[] = [];
  const warnings: string[] = [];
  let t = String(text ?? "");
  const r1 = fixReceiptWhenNotSent(t, i.sent);
  if (r1.applied.length) { t = r1.text; applied.push(...r1.applied.map((x) => `ご査収を外した「${x.slice(0, 30)}」`)); }
  const r2 = fixImageTypeWording(t, i.sent);
  if (r2.applied.length) { t = r2.text; applied.push(...r2.applied.map((x) => `${x}→御見積書`)); }
  warnings.push(...r2.flagged.map((x) => `送った物の種類と違う言い方「${x}」`));
  const r3 = fixEstimateNames(t, i.sent.estimates);
  if (r3.applied.length) { t = r3.text; applied.push(...r3.applied.map((x) => `見積書の名前 ${x}`)); }
  warnings.push(...r3.flagged);
  for (const x of unansweredAsks(i.asks, `${i.firstMessage ?? ""}\n${t}`)) warnings.push(`まだ答えていない: ${TOPIC_JA[x.topic]}「${x.quote}」`);
  const ck = costKindMismatch(t, i.costKind ?? null);
  if (ck) warnings.push(ck);
  return { text: t, applied, warnings };
}

/**
 * 個人情報の線（返信生成・AIX 本体と同じ決まり）: 申込以降・審査の事情（screening-sensitive）・申込の線がある会話（全部渡してよい以外）・読めない時は Claude に固定。
 * 戻り: pin＝Claude に固定（x-sumora-llm-post-apply: 1）／alt＝DeepSeek に回る（材料を伏せる・印 all）／claude＝もともと Claude
 */
export function secondMaterialsRoute(i: { postApply: boolean; cutoffAll: boolean; sensitive: boolean; readFailed?: boolean; goesAlt: boolean }): "pin" | "alt" | "claude" {
  if (i.readFailed || i.postApply || i.sensitive || !i.cutoffAll) return "pin";
  return i.goesAlt ? "alt" : "claude";
}
