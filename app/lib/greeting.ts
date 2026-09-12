// app/lib/greeting.ts
// G30（2026-09-08）: 冒頭挨拶の決定論化（生成・後処理・検査の三者同名）。
// G31（2026-09-09）: 挨拶行（接触の事実）と開口語（顧客メッセージの意味）の二層分離。
// G32（2026-09-09 Fable5 じゅにあ事例・竹内方針）: 「お待たせ致しました」を返信から全廃。
//   ・自動返信へ移行するため「返信を待たせた」という前提が消える。経過時間は挨拶の根拠にしない（audit にのみ残す）。
//   ・挨拶行 = first（真の初回）／late_apology（顧客が結果を催促）／standard（当日未挨拶: 〇〇さんお世話になっております）／none（当日挨拶済み）＋夜間接頭辞。
//   ・開口語 = classifyCustomerResponse の kind から（依頼・条件・断り→かしこまりました／了承・感想→はい／情報質問・結果報告→なし）。
//   ・二層は standard→開口語 のみ（正解: お世話に→かしこまりました 54／→はい 9。お待たせ→開口語 0／はじめまして→開口語 0）。
//   ・「お待たせ致しました／お待たせいたしました／お待たせしました」は禁止語: 後処理 stripWaited で文節ごと除去、final-check BANNED_WORD で block。
//   ・生成（buildGreetingNote）・後処理（enforceOpening）・検査（final-check ⑦）・保存（toGreetingLite）が同じ GreetingDecision を参照する（四者同名）。
import { canonOf } from "./validate-reply";
import { jstDayStartMs } from "./jst-date"; // 2026-09-12 竹内方針D: JST の日付計算は jst-date に一本化
import type { CustomerResponseKind, SubstanceKind } from "./reply-context"; // type-only（実行時の循環 import なし）

export type GreetingKind = "first" | "late_apology" | "standard" | "none";
export type OpenerKind = "kashikomari" | "hai" | "none";

export const OPENER_TEXT: Record<OpenerKind, string> = { kashikomari: "かしこまりました！！", hai: "はい！！", none: "" };
export const OPENER_JA: Record<OpenerKind, string> = {
  kashikomari: "「かしこまりました！！」", hai: "「はい😊！！」", none: "開口語なし（本題・回答・目的語付きの受領お礼から）",
};

/** 監査値。決定には一切使わない（週次 SQL で「待たせた時間 × 冒頭」の分布を見るためだけに保存） */
export type GreetingAudit = {
  waitedMs: number | null;
  originCreatedAt: string | null;
  originTextHead: string | null;
  alreadyGreetedToday: boolean;
  customerKind: CustomerResponseKind | null;
  isDeliverableReply: boolean;
};

export type GreetingDecision = {
  kind: GreetingKind;
  /** 挨拶行（夜間接頭辞込み）。"" = 挨拶行なし */
  openingLine: string;
  /** @deprecated = openingLine（final-check.expectedOpening・既存ログ互換） */
  opening: string;
  nightPrefix: string;
  /** 挨拶行を後処理で確定差し込みするか（first / late_apology / 夜間 = true） */
  enforce: boolean;
  /** 開口語（挨拶行の次、または先頭） */
  opener: OpenerKind;
  /** 許容する開口語。LLM 生成がこの集合内なら尊重、外なら opener に置換（none なら除去）。足すことはしない */
  openerAllowed: OpenerKind[];
  openerReason: string;
  reason: string;
  audit: GreetingAudit;
};

/** DB（tpo_debug.greeting → reply_context_snapshot）・check-reply 転送用の軽量形 */
export type GreetingDecisionLite = Pick<GreetingDecision, "kind" | "openingLine" | "nightPrefix" | "enforce" | "opener" | "openerAllowed" | "openerReason" | "reason" | "audit">;
export function toGreetingLite(d: GreetingDecision): GreetingDecisionLite {
  return {
    kind: d.kind, openingLine: d.openingLine, nightPrefix: d.nightPrefix, enforce: d.enforce,
    opener: d.opener, openerAllowed: d.openerAllowed, openerReason: d.openerReason, reason: d.reason, audit: d.audit,
  };
}

const OPENER_KINDS: OpenerKind[] = ["kashikomari", "hai", "none"];
/**
 * DB から復元した古い greeting（G30/G31 形式・kind="waited"・opening のみ 等）を G32 Lite に正規化。
 * waited は standard へ写像し、opening 中の「お待たせ致しました」は「お世話になっております」に置換する。形が壊れていれば null（fail-open）
 */
export function normalizeGreetingLite(raw: unknown): GreetingDecisionLite | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawKind = typeof r.kind === "string" ? r.kind : "";
  const kind: GreetingKind | null =
    rawKind === "first" || rawKind === "late_apology" || rawKind === "standard" || rawKind === "none" ? rawKind
    : rawKind === "waited" ? "standard" : null;
  if (!kind) return null;
  const openingRaw = typeof r.openingLine === "string" ? r.openingLine : typeof r.opening === "string" ? r.opening : "";
  const openingLine = openingRaw.replace(/お待たせ(?:致|いた)?しました/g, "お世話になっております");
  const nightPrefix = typeof r.nightPrefix === "string" ? r.nightPrefix : openingLine.startsWith(NIGHT_PREFIX) ? NIGHT_PREFIX : "";
  const opener = OPENER_KINDS.includes(r.opener as OpenerKind) ? (r.opener as OpenerKind) : "none";
  const openerAllowed = Array.isArray(r.openerAllowed) && r.openerAllowed.every((k) => OPENER_KINDS.includes(k as OpenerKind)) && r.openerAllowed.length
    ? (r.openerAllowed as OpenerKind[]) : [...OPENER_KINDS];
  const a = (r.audit && typeof r.audit === "object" ? r.audit : {}) as Partial<GreetingAudit>;
  return {
    kind, openingLine, nightPrefix,
    enforce: typeof r.enforce === "boolean" ? r.enforce : kind === "first" || kind === "late_apology" || !!nightPrefix,
    opener, openerAllowed,
    openerReason: typeof r.openerReason === "string" ? r.openerReason : "復元（旧形式）",
    reason: typeof r.reason === "string" ? r.reason : "復元（旧形式）",
    audit: {
      waitedMs: typeof a.waitedMs === "number" ? a.waitedMs : null,
      originCreatedAt: typeof a.originCreatedAt === "string" ? a.originCreatedAt : null,
      originTextHead: typeof a.originTextHead === "string" ? a.originTextHead : null,
      alreadyGreetedToday: !!a.alreadyGreetedToday,
      customerKind: (a.customerKind ?? null) as CustomerResponseKind | null,
      isDeliverableReply: !!a.isDeliverableReply,
    },
  };
}

export const CONTINUOUS_CHAT_MS = 60 * 60 * 1000;
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 5;
export const NIGHT_PREFIX = "夜遅くに失礼します！！";

type Msg = { sender: string; text?: string; createdAt?: string; isAix?: boolean };
const MEDIA_ONLY_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/;

export function isNightHourJST(jstHour: number): boolean {
  return jstHour >= NIGHT_START_HOUR || jstHour < NIGHT_END_HOUR;
}

/** route.ts から移設（二重定義禁止・route.ts は import に置換） */
export function buildFirstGreeting(customerName: string): string {
  const n = canonOf(customerName); // 2026-09-12 竹内方針C: 確定名（resolveAddressName）を再正規化しない（「ちゃん」を剥がさない）
  return `${n ? `${n}さん、` : ""}はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！`;
}

/**
 * 進捗催促（顧客が「結果」を催促した）の判定。route.ts の進捗催促ラベルと final-check の late_apology 検査はこれを使う（同名）。
 * 了承のみ（isAckOnly）は催促ではない（「よろしくお願いします」「お願いします」を催促に数えない）。
 */
export const PROGRESS_PUSH_RE = /まだ(?:です|でしょう|ですか|なの|かな)|(?:連絡|返事|返信)(?:が|は)?(?:ない|無い|来ない|きてない|来てない|頂けて|いただけて)|進捗|いつ(?:頃|ごろ)?(?:送|届|来|ご連絡|連絡|になり)|どうなっ(?:て|た)|お待ちして(?:おり|い)ます(?:が|けど)|催促/;
export function isProgressPushMessage(text: string | null | undefined, opts: { isAckOnly?: boolean } = {}): boolean {
  const t = (text ?? "").trim();
  if (!t || opts.isAckOnly) return false;
  return PROGRESS_PUSH_RE.test(t);
}

export type WaitedOrigin = { createdAt: string; textHead: string; waitedMs: number };
/**
 * 監査用: 最後のスタッフ発言より後の「実質のある（isSubstantive）」最古の顧客メッセージからの経過。
 * G32 では挨拶の決定に使わない（audit にのみ保存）。了承のみ・画像のみは起点にしない。messages は oldest-first。
 */
export function computeWaitedOrigin(messages: Msg[], now: number, isSubstantive: (text: string) => boolean): WaitedOrigin | null {
  let lastStaffIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender === "staff") { lastStaffIdx = i; break; }
  }
  for (const m of messages.slice(lastStaffIdx + 1)) {
    if (m.sender !== "customer" || !m.createdAt) continue;
    const t = Date.parse(m.createdAt);
    if (!Number.isFinite(t)) continue;
    const text = (m.text ?? "").trim();
    if (!text || MEDIA_ONLY_RE.test(text) || !isSubstantive(text)) continue;
    return { createdAt: m.createdAt, textHead: text.replace(/\s+/g, " ").slice(0, 40), waitedMs: Math.max(0, now - t) };
  }
  return null;
}

export function msSinceLastStaff(messages: Msg[], now = Date.now()): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender === "staff" && m.createdAt) {
      const t = Date.parse(m.createdAt);
      return Number.isFinite(t) ? Math.max(0, now - t) : null;
    }
  }
  return null;
}

/** JST 当日 0:00〜23:59 にテキストのスタッフ送信（AIX 含む・画像/動画のみは除く）があれば true。createdAt が 1 件も無ければ undefined */
export function computeAlreadyGreetedToday(messages: Msg[], now = Date.now()): boolean | undefined {
  if (!messages.some((m) => !!m.createdAt)) return undefined;
  const dayStartUtc = jstDayStartMs(now);
  const dayEndUtc = dayStartUtc + 24 * 3600 * 1000 - 1;
  return messages.some((m) => {
    if (m.sender !== "staff" || !m.createdAt) return false;
    if (!m.text || m.text === "[画像]" || m.text === "[動画]") return false;
    const ts = Date.parse(m.createdAt);
    return Number.isFinite(ts) && ts >= dayStartUtc && ts <= dayEndUtc;
  });
}

/**
 * 開口語の決定（顧客メッセージの意味 → かしこまりました／はい／なし）。件数は正解 1,355 件（2026-05-25〜09-09）。
 * 挨拶行が first / late_apology の時は開口語なし（はじめまして→開口語 0 件・謝罪行の後に開口語を置く正解なし）。
 */
export function resolveOpener(o: {
  greetingKind: GreetingKind;
  customerKind: CustomerResponseKind | null;
  customerSecondary?: CustomerResponseKind[];
  substanceKinds?: SubstanceKind[];
  isDeliverableReply?: boolean;
}): Pick<GreetingDecision, "opener" | "openerAllowed" | "openerReason"> {
  const r = (opener: OpenerKind, openerAllowed: OpenerKind[], openerReason: string) => ({ opener, openerAllowed, openerReason });
  if (o.greetingKind === "first" || o.greetingKind === "late_apology") {
    return r("none", ["none"], `${o.greetingKind}: 挨拶行が開口語を兼ねる（正解: はじめまして→開口語 0 件）`);
  }
  if (o.isDeliverableReply) return r("none", ["none", "hai"], "結果報告は物件名・結果・名前行から本題（正解: 結果報告の冒頭は お世話に／名前行／🌟物件名。お待たせは廃止）");
  const kinds = new Set(o.substanceKinds ?? []);
  const asksAction = kinds.has("request") || kinds.has("condition") || kinds.has("schedule") || kinds.has("decision");
  switch (o.customerKind) {
    case "decline":
    case "condition_change":
      return r("kashikomari", ["kashikomari", "none"], "依頼・条件・断りの引き受け（正解 依頼形112／条件提示31／日程23、了承のみ 2）");
    case "question":
      return asksAction
        ? r("kashikomari", ["kashikomari", "none"], "依頼形の質問（「〜で探して頂けますか」）は引き受け")
        : r("none", ["none", "kashikomari", "hai"], "情報質問は回答文から（正解 質問→挨拶なし113／かしこまり67／はい24）");
    case "ack_only":
    case "positive":
    case "thinking":
    case "will_send_later":
      return asksAction
        ? r("kashikomari", ["kashikomari", "hai", "none"], "了承＋行動要求（申込・内覧・日程）は引き受け")
        : r("hai", ["hai", "none"], "了承・感想・保留の受け止め（正解 了承のみ→はい37／かしこまりました 2）");
    case "concern":
      // 2026-09-10 Fable5 みく事例: ここに来るのは「懸念の対象語が本文に実在する」時だけになった
      //   （resolveTurnPair / classifyCustomerResponse が証拠ゼロの concern を thinking・ack_only に降格するため）。
      //   「ありがとうございます！確認させていただきます」は thinking → 上の分岐で hai になる
      return r("none", ["none", "kashikomari"], "懸念は受け止め文から（正解 懸念→はい 1）");
    case "answer":
      return r("none", ["none", "hai", "kashikomari"], "我々の質問への回答は本題から");
    default:
      return asksAction
        ? r("kashikomari", ["kashikomari", "none", "hai"], "行動要求あり")
        : r("none", ["none", "hai", "kashikomari"], "分類不能: LLM の開口語を尊重");
  }
}

export function resolveGreeting(opts: {
  customerName: string;
  isFirstEverReply: boolean;
  alreadyGreetedToday: boolean;
  recentMessages: Msg[];
  jstHour: number;
  now?: number;
  /** 顧客が結果を催促した（isProgressPushMessage）。了承のみでは true にならない */
  isProgressPush?: boolean;
  /** 監査用の実質判定。route.ts は (t) => analyzeSubstance(t).has を渡す */
  isSubstantive: (text: string) => boolean;
  /** classifyCustomerResponse(...).kind */
  customerKind: CustomerResponseKind | null;
  customerSecondary?: CustomerResponseKind[];
  substanceKinds?: SubstanceKind[];
  /** この返信自体が成果物（AIX 物件送付・確認結果・見積）を届ける → 開口語なし */
  isDeliverableReply?: boolean;
}): GreetingDecision {
  const now = opts.now ?? Date.now();
  const name = canonOf(opts.customerName); // 2026-09-12 竹内方針C: 確定名を再正規化しない
  const call = name ? `${name}さん` : "";
  const origin = computeWaitedOrigin(opts.recentMessages, now, opts.isSubstantive);
  const sinceStaff = msSinceLastStaff(opts.recentMessages, now);
  const continuous = sinceStaff !== null && sinceStaff < CONTINUOUS_CHAT_MS;
  // 2026-09-12 竹内（Aoi 事例）: お客様への返信に「夜遅くに失礼します／夜分遅くに失礼致します」を入れない。
  //   旧: 22:00〜04:59（会話連続中を除く）は決定論で先頭に付与していた → 付与をやめる（AI が書いても banned-phrasing が除去）
  void isNightHourJST; void continuous;
  const nightPrefix = "";
  const audit: GreetingAudit = {
    waitedMs: origin?.waitedMs ?? null, originCreatedAt: origin?.createdAt ?? null, originTextHead: origin?.textHead ?? null,
    alreadyGreetedToday: opts.alreadyGreetedToday, customerKind: opts.customerKind, isDeliverableReply: !!opts.isDeliverableReply,
  };

  const mk = (kind: GreetingKind, openingLine: string, enforce: boolean, reason: string): GreetingDecision => {
    const op = resolveOpener({
      greetingKind: kind, customerKind: opts.customerKind, customerSecondary: opts.customerSecondary,
      substanceKinds: opts.substanceKinds, isDeliverableReply: !!opts.isDeliverableReply,
    });
    return { kind, openingLine, opening: openingLine, nightPrefix, enforce, ...op, reason, audit };
  };

  if (opts.isFirstEverReply) return mk("first", nightPrefix + buildFirstGreeting(name), true, "真の初回");
  if (opts.isProgressPush) return mk("late_apology", `${nightPrefix}${call}${call ? "、" : ""}ご連絡遅くなり申し訳御座いません！！`, true, "顧客が結果を催促（進捗催促TPO）");
  if (opts.alreadyGreetedToday) return mk("none", nightPrefix, !!nightPrefix, "当日挨拶済み（同日連続会話は開口語または本題から）");
  return mk("standard", `${nightPrefix}${call}お世話になっております！！`, !!nightPrefix, "継続会話・当日未挨拶");
}

/** 挨拶行の剥離（お待たせ系は禁止語なので剥がし対象として維持） */
export const GREETING_STRIP_RE =
  /^(?:「?[^\n！!。]{0,15}(?:さん|様)[、,\s]*)?(?:夜遅くに失礼(?:します|致します|いたします)|夜分遅くに失礼(?:します|致します|いたします)|お世話になっております|お待たせ(?:致|いた)?しました|いつもありがとうございます|ご連絡遅くなり申し訳(?:御座|ござ)いません)[^！!。\n]{0,10}?(?:[！!。]+|\n)\s*/;
/** 初回専用（旧 route.ts greetingSentencePattern を移設） */
export const FIRST_GREETING_SENTENCE_RE =
  /^(?:「?[^\n！!。]{0,15}(?:さん|様)[、,。\s]*)?(?:はじめまして|初めまして|お世話に|ご連絡|この度|こんにちは|こんばんは|おはよう|夜分遅く|夜遅く|お部屋探し[^！!。\n]{0,30}申します|[^！!。\n]{0,20}と申します)[^！!。\n]{0,40}?(?:[！!。]+|\n)\s*/;

/** 禁止語（G32）。final-check BANNED_WORDS_DETERMINISTIC と同名の語 */
export const WAITED_RE = /お待たせ(?:致|いた)?しました/;
/** 文中どこにあっても「〇〇さんお待たせ致しました！！」の文節ごと除去（同一文内の名前呼びかけも含めて） */
export const WAITED_SENTENCE_RE = /[^\n！!。]*お待たせ(?:致|いた)?しました[^\n！!。]{0,10}(?:[！!。]+)?[ \t]*/g;
export function stripWaited(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .replace(WAITED_SENTENCE_RE, () => { removed++; return ""; })
    .replace(/^[ \t]*\n/, "")
    .replace(/\n{3,}/g, "\n\n");
  return { text: removed ? out : text, removed };
}

/** 開口語（挨拶行を剥がした後の先頭）。final-check ⑦-e と enforceOpener が同名 */
export const OPENER_HEAD_RE = /^(かしこまりました|承知(?:いた|致)?しました|了解(?:いた|致)?しました|承りました|はい)([😊😌]*)[！!。]*\s*/;

export function detectOpener(text: string): { opener: OpenerKind; match: string; emoji: string; canonical: boolean } | null {
  const m = OPENER_HEAD_RE.exec(text.trimStart());
  if (!m) return null;
  const isHai = m[1] === "はい";
  return { opener: isHai ? "hai" : "kashikomari", match: m[0], emoji: m[2] ?? "", canonical: isHai || m[1] === "かしこまりました" };
}

function openerLiteral(k: OpenerKind, emoji: string): string {
  if (k === "none") return "";
  return k === "hai" ? `はい${emoji}！！` : `かしこまりました${emoji}！！`;
}

/**
 * 開口語層のみ（挨拶行を剥がした rest に対して呼ぶ）。LLM の開口語を尊重し、openerAllowed に無い時だけ置換／除去。
 * 無い時に足すことはしない（成約データに無い組合せを作らない）。承知／了解 → かしこまりました に正規化（正解 承知 4 vs かしこまりました 311）。
 */
export function enforceOpener(rest: string, d: Pick<GreetingDecision, "opener" | "openerAllowed">): { rest: string; fixes: string[] } {
  const fixes: string[] = [];
  const op = detectOpener(rest);
  if (!op) return { rest, fixes };
  const body = rest.trimStart().slice(op.match.length).trimStart();
  if (d.openerAllowed.includes(op.opener)) {
    if (op.canonical) return { rest, fixes };
    if (!body) return { rest, fixes };
    fixes.push(`開口語「${op.match.trim()}」を「${openerLiteral(op.opener, op.emoji)}」に正規化`);
    return { rest: `${openerLiteral(op.opener, op.emoji)}\n${body}`, fixes };
  }
  if (!body) return { rest, fixes }; // 開口語だけの本文（本文ゼロ防止フェイルオープン）
  const to = d.opener !== "none" && d.openerAllowed.includes(d.opener) ? openerLiteral(d.opener, op.emoji) : "";
  fixes.push(to ? `開口語「${op.match.trim()}」→「${to}」（decision.opener=${d.opener}）` : `開口語「${op.match.trim()}」を除去（decision.opener=none）`);
  return { rest: to ? `${to}\n${body}` : body, fixes };
}

/**
 * 冒頭の後処理（四者同名の「後処理」）。
 * ① 先頭の挨拶行を剥がす（お待たせ系含む）→ ② 文中の「お待たせ」文節を禁止語として除去 → ③ 開口語層 → ④ decision の挨拶行を差し込む（enforce 時のみ確定、standard/none は LLM が挨拶行を書いた時だけ差し替え）
 */
export function enforceOpening(text: string, d: GreetingDecision): { cleaned: string; fixes: string[] } {
  const fixes: string[] = [];
  let rest = text.trimStart();
  const stripRe = d.kind === "first" ? FIRST_GREETING_SENTENCE_RE : GREETING_STRIP_RE;
  let stripped = false;
  for (let i = 0; i < 4 && stripRe.test(rest); i++) {
    rest = rest.replace(stripRe, "");
    stripped = true;
    fixes.push("LLM生成の冒頭挨拶を除去");
  }
  // G32: 「お待たせ」は位置を問わず禁止語。剥がした痕跡は stripped と同じ扱い（standard なら決定論の挨拶行に差し替わる）
  const w = stripWaited(rest);
  if (w.removed) { rest = w.text; stripped = true; fixes.push(`禁止語「お待たせ致しました」の文節を${w.removed}件除去`); }
  rest = rest.trim();
  const o = enforceOpener(rest, d);
  rest = o.rest.trim();
  fixes.push(...o.fixes);
  const touched = stripped || o.fixes.length > 0;
  if (!d.enforce) {
    if (!touched) return { cleaned: text, fixes };
    return { cleaned: d.openingLine && stripped ? `${d.openingLine}\n${rest}` : rest || text, fixes };
  }
  if (!d.openingLine) return { cleaned: rest || text, fixes };
  if (!rest) return { cleaned: text.trim() || d.openingLine, fixes }; // 本文ゼロ防止フェイルオープン
  fixes.push(`冒頭を「${d.openingLine}」に固定（${d.kind}/${d.reason}）`);
  return { cleaned: `${d.openingLine}\n${d.kind === "first" ? "\n" : ""}${rest}`, fixes };
}

/** 生成プロンプト【⏰ 挨拶ルール・最優先】を decision から生成（route.ts の greetingNote を置換。四者同名） */
export function buildGreetingNote(d: GreetingDecision, jstHour: number): string {
  const head = "\n【⏰ 挨拶ルール・最優先】";
  const forbidden = (["kashikomari", "hai"] as OpenerKind[]).filter((k) => !d.openerAllowed.includes(k)).map((k) => OPENER_JA[k]);
  const where = d.openingLine ? "挨拶行の次の行" : "先頭";
  const openerLine = d.opener === "none"
    ? `開口語: なし。${where}は本題（回答・物件名・結果・「ご条件お送り頂きありがとうございます！！」のような目的語付きの受領お礼）から始める（${d.openerReason}）${d.openerAllowed.length > 1 ? `。${d.openerAllowed.filter((k) => k !== "none").map((k) => OPENER_JA[k]).join("／")}で始めても良い` : ""}`
    : `開口語: ${where}は ${OPENER_JA[d.opener]}（${d.openerReason}）。絵文字は「かしこまりました😊！！」「はい😊！！」の位置のみ`;
  const forbidLine = forbidden.length ? `開口語の禁止: ${forbidden.join("／")}で始めない。` : "";
  const common = `「お待たせ致しました」「お待たせしました」は禁止語（返信を待たせた体裁を作らない。結果報告でも使わない）。「ありがとうございます」「ご連絡ありがとうございます」だけの書き出しは禁止（目的語付き「〇〇お送り頂きありがとうございます」は可）。「夜遅くに失礼します」「夜分遅くに失礼致します」は返信に書かない（時間帯を問わず）。`;
  switch (d.kind) {
    case "first":
      return `${head}これはお客様への【はじめての返信】。必ず「${d.openingLine}」で始める（一字一句変更・省略・追加禁止。この行の後に空行を挟んで本文）。この後に「かしこまりました」「はい」を続けない。${common}`;
    case "late_apology":
      return `${head}お客様が結果を催促している。必ず「${d.openingLine}」で始める（一字一句変更禁止。この行の後に改行して現状事実1文＋次アクション1文）。この行が開口語を兼ねるので「かしこまりました」「はい」を置かない。${common}`;
    case "standard":
      return `${head}現在${jstHour}時台（JST）・本日この方への送信はまだ（${d.reason}）。長い返信・重要な連絡・結果報告の先頭行は「${d.openingLine}」で固定（一字一句変更禁止）。短い受け止めだけの返信は挨拶行を省いて開口語から始めてよい。${openerLine}。${forbidLine}${common}`;
    default:
      return `${head}本日の会話で冒頭挨拶は使用済み（${d.reason}）。「お世話になっております」「いつもありがとうございます」を書かない。${d.nightPrefix ? `ただし深夜帯のため先頭行は「${d.nightPrefix}」で固定（この行の後に改行して本文）。` : ""}${openerLine}。${forbidLine}${common}`;
  }
}
