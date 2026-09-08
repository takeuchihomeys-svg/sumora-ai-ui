// app/lib/greeting.ts
// G30（2026-09-08 Fable5）: 冒頭挨拶を決定論で確定し、生成プロンプト（リテラル埋め込み）・後処理（enforceOpening）・
// final-check（OPENING_GREETING_*）の三者が同じ GreetingDecision を参照する。
// 旧実装は「お世話に／お待たせ／いつもありがとう」の3候補から LLM に選ばせていたが、「お待たせ致しました」の可否は
// 経過時間で決まる事実であり、「夜分遅く禁止」と「時間帯挨拶」がプロンプト内で矛盾していた。ここで一度だけ確定する。
import { normalizeCustomerName } from "./validate-reply";

export type GreetingKind = "first" | "waited" | "late_apology" | "standard" | "none";

export type GreetingDecision = {
  kind: GreetingKind;
  /** 先頭に置く挨拶行（夜間接頭辞込み）。"" = 挨拶なし */
  opening: string;
  nightPrefix: string;
  /** 後処理で opening を確定的に差し込むか（first/waited/late_apology/夜間 = true） */
  enforce: boolean;
  waitedMs: number | null;
  reason: string;
};

export const WAIT_THRESHOLD_MS = 3 * 60 * 60 * 1000;
export const CONTINUOUS_CHAT_MS = 60 * 60 * 1000;
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 5;
export const NIGHT_PREFIX = "夜遅くに失礼します！！";

type Msg = { sender: string; text?: string; createdAt?: string; isAix?: boolean };

export function isNightHourJST(jstHour: number): boolean {
  return jstHour >= NIGHT_START_HOUR || jstHour < NIGHT_END_HOUR;
}

/** route.ts から移設（二重定義禁止・route.ts は import に置換） */
export function buildFirstGreeting(customerName: string): string {
  const n = normalizeCustomerName(customerName);
  return `${n ? `${n}さん、` : ""}はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！`;
}

/** 最後のスタッフ発言より後の顧客メッセージのうち最古の createdAt からの経過ms。未返信が無ければ null。messages は oldest-first */
export function computeWaitedMs(messages: Msg[], now = Date.now()): number | null {
  let lastStaffIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender === "staff") { lastStaffIdx = i; break; }
  }
  const pendingTs = messages
    .slice(lastStaffIdx + 1)
    .filter((m) => m.sender === "customer" && m.createdAt)
    .map((m) => Date.parse(m.createdAt as string))
    .filter(Number.isFinite);
  if (pendingTs.length === 0) return null;
  return Math.max(0, now - Math.min(...pendingTs));
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

export function resolveGreeting(opts: {
  customerName: string;
  isFirstEverReply: boolean;
  alreadyGreetedToday: boolean;
  recentMessages: Msg[];
  jstHour: number;
  now?: number;
  isProgressPush?: boolean;
}): GreetingDecision {
  const now = opts.now ?? Date.now();
  const name = normalizeCustomerName(opts.customerName);
  const call = name ? `${name}さん` : "";
  const waitedMs = computeWaitedMs(opts.recentMessages, now);
  const sinceStaff = msSinceLastStaff(opts.recentMessages, now);
  const continuous = sinceStaff !== null && sinceStaff < CONTINUOUS_CHAT_MS;
  const nightPrefix = isNightHourJST(opts.jstHour) && !continuous ? NIGHT_PREFIX : "";

  if (opts.isFirstEverReply) {
    return { kind: "first", opening: nightPrefix + buildFirstGreeting(name), nightPrefix, enforce: true, waitedMs, reason: "真の初回" };
  }
  if (opts.isProgressPush) {
    return { kind: "late_apology", opening: `${nightPrefix}${call}${call ? "、" : ""}ご連絡遅くなり申し訳御座いません！！`, nightPrefix, enforce: true, waitedMs, reason: "進捗催促TPO" };
  }
  if (waitedMs !== null && waitedMs >= WAIT_THRESHOLD_MS) {
    const h = Math.round(waitedMs / 3600000);
    return { kind: "waited", opening: `${nightPrefix}${call}お待たせ致しました！！`, nightPrefix, enforce: true, waitedMs, reason: `返信まで約${h}時間` };
  }
  if (opts.alreadyGreetedToday) {
    return { kind: "none", opening: nightPrefix, nightPrefix, enforce: !!nightPrefix, waitedMs, reason: "当日挨拶済み" };
  }
  return { kind: "standard", opening: `${nightPrefix}${call}お世話になっております！！`, nightPrefix, enforce: !!nightPrefix, waitedMs, reason: "継続会話・当日未挨拶" };
}

export const GREETING_STRIP_RE =
  /^(?:「?[^\n！!。]{0,15}(?:さん|様)[、,\s]*)?(?:夜遅くに失礼(?:します|致します|いたします)|夜分遅くに失礼(?:します|致します|いたします)|お世話になっております|お待たせ(?:致|いた)しました|いつもありがとうございます|ご連絡遅くなり申し訳(?:御座|ござ)いません)[^！!。\n]{0,10}?(?:[！!。]+|\n)\s*/;
/** 初回専用（旧 route.ts greetingSentencePattern を移設） */
export const FIRST_GREETING_SENTENCE_RE =
  /^(?:「?[^\n！!。]{0,15}(?:さん|様)[、,。\s]*)?(?:はじめまして|初めまして|お世話に|ご連絡|この度|こんにちは|こんばんは|おはよう|夜分遅く|夜遅く|お部屋探し[^！!。\n]{0,30}申します|[^！!。\n]{0,20}と申します)[^！!。\n]{0,40}?(?:[！!。]+|\n)\s*/;

export function enforceOpening(text: string, d: GreetingDecision): { cleaned: string; fixes: string[] } {
  const fixes: string[] = [];
  let rest = text.trimStart();
  const stripRe = d.kind === "first" ? FIRST_GREETING_SENTENCE_RE : GREETING_STRIP_RE;
  for (let i = 0; i < 4 && stripRe.test(rest); i++) {
    rest = rest.replace(stripRe, "");
    fixes.push("LLM生成の冒頭挨拶を除去");
  }
  rest = rest.trim();
  if (!d.enforce) {
    // standard/none（夜間なし）: LLM が挨拶を書いていれば決定論の opening に差し替え、無ければ触らない
    return { cleaned: fixes.length ? (d.opening ? `${d.opening}\n${rest}` : text) : text, fixes };
  }
  if (!d.opening) return { cleaned: rest || text, fixes };
  if (!rest) return { cleaned: text.trim() || d.opening, fixes }; // 本文ゼロ防止フェイルオープン
  fixes.push(`冒頭を「${d.opening}」に固定（${d.kind}/${d.reason}）`);
  return { cleaned: `${d.opening}\n${d.kind === "first" ? "\n" : ""}${rest}`, fixes };
}
