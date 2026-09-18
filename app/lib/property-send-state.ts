// app/lib/property-send-state.ts
// 「今この会話の物件はどういう状況か」を1か所で決める（純関数・DB 依存なし）。
//
// 2026-09-18 竹内（𝒮 さん事例）「今の状況はブレインが分かっているんやから、それと AIX のところ
//   リンクさせて状況に応じた文をおくれば、さらに良くなる」
//
// 設計知見「読む側は1つの整形関数を分析・戦略・返信生成・各 AIX の全員が使う（四者同名）」
//   「入口は1つの関数にまとめる（コピーで増やすと後から直した1か所だけが新しくなる）」に従い、
//   ブレインの判断・会話・画面入力のどれから来ても、状況はこの1つの型で表す。
//
// 分かる事:
//   ①この会話でこちらが物件を何件送ったか（比較の言い方「お送りした中でも」が使えるか）
//   ②そのお部屋が**今ご内覧頂けるか**（退去予定で解禁日が明日以降なら、締めは内覧誘導ではなく申込誘導）
//
// 出どころの優先順位（上が強い）:
//   1. ブレインの判断（suggested_aix_meta.property_state / action_ledger.facts.propertiesSentCount）
//   2. 会話・画面から渡された本文（ブレインがまだ動いていない・項目が無い時の受け皿）
//   0 に倒さない: 件数を 0 にすると「1件以下」＝比較の言い方が常に落ちる（2026-09-18 の実装バグ）。

import { viewableFromVacancyDate, vacancyDateLabel } from "./vacating-notice";
import { extractPropertyLabels } from "./action-ledger";

/** ブレインが保存する物件の状態（suggested_aix_meta.property_state・JSONB なので migrate-schema 不要） */
export type BrainPropertyState = {
  /** まだご内覧頂けない（退去予定・解禁日が明日以降） */
  notViewable: boolean;
  /** 退去予定日の表記（「9月30日」） */
  vacancyDate: string | null;
  /** 内覧解禁日の表記（「10月1日」） */
  viewableFrom: string | null;
};

export type PropertySendState = BrainPropertyState & {
  /** この会話でこちらが送った物件の件数 */
  sentPropertyCount: number;
  /** 件数の出どころ */
  sentSource: "brain" | "messages" | "none";
  /** 内覧可否の出どころ */
  viewableSource: "brain" | "messages" | "none";
  /** 判定に使った文（監査用・60字） */
  evidence: string | null;
};

type MsgLike = { sender?: string | null; text?: string | null };
type BrainLike = {
  property_state?: Partial<BrainPropertyState> | null;
  action_ledger?: { facts?: { propertiesSentCount?: number | null } | null } | null;
} | null | undefined;

/** 本文に書かれた退去予定日を拾う（「9月30日退去予定」「9月末退去予定」） */
const VACANCY_IN_TEXT_RE = /([0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日|[0-9０-９]{1,2}\s*月\s*(?:末|上旬|中旬|下旬))\s*(?:に)?退去予定/;

/** 表記（「10月1日」）が今日（JST）より後か */
function isFutureMD(md: string, nowMs: number): boolean {
  const m = md.match(/(\d{1,2})月(\d{1,2})日/);
  if (!m) return false;
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const month = Number(m[1]);
  const nowMonth = jst.getUTCMonth() + 1;
  // 年跨ぎ: 今が12月で解禁が1月なら翌年
  const year = month < nowMonth - 6 ? jst.getUTCFullYear() + 1 : jst.getUTCFullYear();
  const openMs = Date.UTC(year, month - 1, Number(m[2]));
  const todayMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return openMs > todayMs;
}

/** 本文から物件の状態（退去予定・内覧解禁日）を決定論で読む。ブレインもこの関数を使って保存する */
export function readPropertyStateFromText(text: string, nowMs: number = Date.now()): BrainPropertyState & { evidence: string | null } {
  const t = text ?? "";
  const m = t.match(VACANCY_IN_TEXT_RE);
  if (!m) return { notViewable: false, vacancyDate: null, viewableFrom: null, evidence: null };
  const vacancyDate = vacancyDateLabel(m[1]);
  const viewableFrom = viewableFromVacancyDate(vacancyDate, nowMs);
  if (!viewableFrom) return { notViewable: false, vacancyDate, viewableFrom: null, evidence: m[0].slice(0, 60) };
  return { notViewable: isFutureMD(viewableFrom, nowMs), vacancyDate, viewableFrom, evidence: m[0].slice(0, 60) };
}

/**
 * 今の状況を1つにまとめる。AIX（aix/action）・テンプレート（aix-template-generate）・
 * 返信生成が同じこの関数を読む（四者同名）。
 */
export function resolvePropertySendState(o: {
  brainMeta?: BrainLike;
  /** 会話（古い順でも新しい順でもよい） */
  recentMessages?: ReadonlyArray<MsgLike>;
  /** 画面・生成元から渡された本文（物件の資料の読み取り文など） */
  extraText?: string | null;
  /** ブレインが持っていない時の受け皿として使う件数（AIX ログから数えた値など） */
  fallbackSentCount?: number | null;
  nowMs?: number;
}): PropertySendState {
  const nowMs = o.nowMs ?? Date.now();

  // ── 件数 ───────────────────────────────────────────────
  const brainCount = o.brainMeta?.action_ledger?.facts?.propertiesSentCount;
  let sentPropertyCount = 0;
  let sentSource: PropertySendState["sentSource"] = "none";
  if (typeof brainCount === "number") {
    sentPropertyCount = brainCount;
    sentSource = "brain";
  } else if (typeof o.fallbackSentCount === "number") {
    sentPropertyCount = o.fallbackSentCount;
    sentSource = "messages";
  } else if (o.recentMessages?.length) {
    const staffText = o.recentMessages.filter((m) => (m.sender ?? "") === "staff").map((m) => m.text ?? "").join("\n");
    sentPropertyCount = extractPropertyLabels(staffText).length;
    sentSource = "messages";
  }

  // ── 内覧可否 ────────────────────────────────────────────
  const bs = o.brainMeta?.property_state;
  if (bs && typeof bs.notViewable === "boolean") {
    return {
      sentPropertyCount, sentSource,
      notViewable: bs.notViewable,
      vacancyDate: bs.vacancyDate ?? null,
      viewableFrom: bs.viewableFrom ?? null,
      viewableSource: "brain",
      evidence: bs.vacancyDate ? `${bs.vacancyDate}退去予定` : null,
    };
  }
  // 退去予定はこちらが送った物件の話だけを見る。お客様ご自身の「9月末退去予定」（今のお住まい）は数えない
  const text = [
    o.extraText ?? "",
    ...(o.recentMessages ?? []).filter((m) => (m.sender ?? "") !== "customer").slice(-8).map((m) => m.text ?? ""),
  ].filter(Boolean).join("\n");
  const read = readPropertyStateFromText(text, nowMs);
  return {
    sentPropertyCount, sentSource,
    notViewable: read.notViewable,
    vacancyDate: read.vacancyDate,
    viewableFrom: read.viewableFrom,
    viewableSource: read.evidence ? "messages" : "none",
    evidence: read.evidence,
  };
}

/**
 * ブレインが保存する物件の状態を決める（analyzeConversation から呼ぶ）。
 *
 * ・退去予定の日付は**こちらが送った物件の話**だけを見る（お客様ご自身の「9月末退去予定」は今のお住まいの話）
 * ・退去予定でも**スタッフが既に内覧を案内していれば内覧できる扱い**（2026-09-15 隼斗事例・moveOutViewingReleased）。
 *   退去予定の語だけで「内覧できない」とはしない、という既存のブレインの判断をそのまま引き継ぐ。
 */
export function resolveBrainPropertyState(o: {
  /** 会話（古い順・新しい順どちらでもよい） */
  messages: ReadonlyArray<MsgLike>;
  /** スタッフが既に内覧（日時・可否）を案内済みか */
  viewingReleased?: boolean;
  nowMs?: number;
}): BrainPropertyState {
  const staffText = o.messages.filter((m) => (m.sender ?? "") !== "customer").slice(-12).map((m) => m.text ?? "").join("\n");
  const read = readPropertyStateFromText(staffText, o.nowMs ?? Date.now());
  return {
    notViewable: o.viewingReleased ? false : read.notViewable,
    vacancyDate: read.vacancyDate,
    viewableFrom: read.viewableFrom,
  };
}

/** ログ・監査用の1行（どこから来た判断かを残す） */
export function describePropertySendState(s: PropertySendState): string {
  return `sent=${s.sentPropertyCount}(${s.sentSource}) notViewable=${s.notViewable}(${s.viewableSource})`
    + (s.vacancyDate ? ` vacancy=${s.vacancyDate}→${s.viewableFrom ?? "?"}` : "");
}
