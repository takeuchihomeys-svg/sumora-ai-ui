// app/lib/target-list-format.ts
// グループの「🌟ターゲット🌟」の文（純関数・DB なし）。
//
// 2026-10-08 竹内さん: 実際に従業員へ共有している「🌟ターゲット🌟」の形にそろえる（fact_target_list_priority）。
//   時間割 →【内覧・申込】（①内覧済み ②審査落ち ③新規 ④物件検索中・名前（希望の条件・状況の一言））→ 運用メモの決まった行
//   →【審査中】（conversations.status=applying・名前（状況の一言）・ブレインの判断は足さない・申込以降は別ツールの領分なので今ある情報だけ）
//   一言の要約は竹内さんの書き方に寄せる（例「隼斗（勤務先の高殿6丁目のパチンコ店まで自転車で15〜20分程の距離、マンションタイプ）」
//   「慶次（どくりつけい、敷金礼金無し、ガスコンロ10月末）」「🐥（次回9/18）」）。LLM は使わない（既存の条件・要約から決定論で作る）
import type { TargetTier } from "@/app/lib/brain-attention";

/** 竹内さんの共有の時間割（原文のまま・変えない） */
export const TARGET_SCHEDULE_LINES = [
  "10:30までに管理会社とのやりとり",
  "（取得する書類の提出は期日切る）",
  "",
  "10:30ターゲットリスト共有",
  "",
  "10:30〜12:30ターゲットリストのお客さん",
  "",
  "13:00〜内覧アポ入れるなら",
  "",
  "13:00〜16：00のどこかで休憩",
  "",
  "16:30〜17:00管理会社にやりとり",
  "（取得する書類の提出は期日切る）",
  "",
  "3日おき　17:00〜18:00契約書類作成",
  "",
  "休み前日に緊急や重要な事項共有",
];

/** 【内覧・申込】と【審査中】の間の決まった行（原文のまま） */
export const TARGET_MEMO_LINES = [
  "アクション何もない時は3日で審査の進捗確認",
  "",
  "⭐️過去フォーマット送ってきていた人は再度申込み前に再度入居希望日を確認！",
  "",
  "審査通過後に入居日カレンダーに追加、必要書類確認、連絡",
];

export type TargetLine = { mark?: string | null; name: string; summary?: string | null };

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").trim();
const lineOf = (t: TargetLine) => `${t.mark ?? ""}${t.name}${t.summary ? `（${t.summary}）` : ""}`;

/** 「🌟ターゲット🌟」の本文。審査中が0人でも見出しは出す（従業員が見る形を崩さない） */
/** 時間割を入れる便（JST の時）。10/08 竹内さん「朝の 10:30 の1回だけ入れて、残りの5回は一覧だけにする」（cron は JST 10・12・14・16・18・20 時） */
export const TARGET_SCHEDULE_HOUR_JST = 10;
export function withScheduleAt(jstHour: number): boolean { return jstHour === TARGET_SCHEDULE_HOUR_JST; }

export function formatTargetList(i: { targets: TargetLine[]; screening: TargetLine[]; footer?: string | null; withSchedule?: boolean }): string {
  // 時間割は朝の便だけ（withSchedule=false の便は【内覧・申込】以下だけ。運用メモと【審査中】は毎回）
  const out = ["🌟ターゲット🌟", "", ...(i.withSchedule === false ? [] : [...TARGET_SCHEDULE_LINES, ""]), "【内覧・申込】"];
  out.push(...(i.targets.length ? i.targets.map(lineOf) : ["（なし）"]));
  out.push("", ...TARGET_MEMO_LINES, "", "【審査中】");
  out.push(...(i.screening.length ? i.screening.map((t) => `・${lineOf({ ...t, mark: null })}`) : ["（なし）"]));
  if (i.footer) out.push("", i.footer);
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 一言の要約
// ─────────────────────────────────────────────────────────────────────────────
export type TargetSummaryInput = {
  tier?: TargetTier | null;
  desiredArea?: string | null;
  commuteStation?: string | null;
  commuteMinutes?: number | null;
  rentMax?: number | null;
  floorPlan?: string | null;
  otherRequests?: string | null;
  /** property_customers.ai_summary_json.situation（今の状況の一言） */
  situation?: string | null;
  /** situation を書いた時刻（ai_summary_at）。古い状況は使わない */
  situationAt?: string | null;
  /** これからの内覧の予定日（viewing_history scheduled・今日以降の一番近い日 YYYY-MM-DD） */
  nextViewingDate?: string | null;
  nowMs: number;
};

/** 状況の一言を使う期間（ai_summary_at から） */
export const SITUATION_FRESH_DAYS = 7;
/** 一言の長さの上限（竹内さんの例は 10〜40字） */
export const SUMMARY_MAX = 40;

/** 竹内さんが一言に書く種類の要望（敷礼・保証会社・築年・設備・入居時期 等）。条件の欄の他の要望から拾う順 */
const KEY_REQ_RE = /敷金|礼金|敷礼|初期費用|独立系|保証|築浅|築年|ペット|バス|トイレ|オートロック|ガスコンロ|駐車場|入居|月末|月中|月上旬|月下旬|子ども|子供|マンション|RC|鉄筋|木造|家具/;

function md(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? `${Number(m[2])}/${Number(m[3])}` : null;
}

function rentText(rentMax: number | null | undefined): string | null {
  if (!rentMax || rentMax <= 0) return null;
  const man = Math.round(rentMax / 1000) / 10;
  return `${man}万円ほど`;
}

function areaText(i: TargetSummaryInput): string | null {
  const st = norm(i.commuteStation);
  if (st && st !== "市内") return `${st.replace(/駅$/, "")}駅まで${i.commuteMinutes ? `${i.commuteMinutes}分以内` : "通勤"}`;
  const a = norm(i.desiredArea);
  if (!a) return null;
  // 括弧の説明（「(Googleマップで示した地図の左側エリア)」等）は落とし、同じ地名は1回（実物 uran.「玉造、玉造」）
  const parts = [...new Set(a.replace(/[（(][^）)]*[）)]/g, "").split(/[、,，・\/]/).map((x) => x.trim()).filter(Boolean))];
  return parts.slice(0, 3).join("、");
}

function keyRequests(other: string | null | undefined, limit: number): string[] {
  const items = (other ?? "").split(/[、,，・\n。]/).map((x) => x.trim()).filter((x) => x && x.length <= 14);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const x of items) {
    if (!KEY_REQ_RE.test(x)) continue;
    const k = x.replace(/希望$|したい$|がいい$/, "");
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(x);
    if (picked.length >= limit) break;
  }
  return picked;
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** 希望の条件の一言（「梅田、心斎橋、難波に30分以内でアクセスできる6万円ほど1K」「敷金礼金無し」の形） */
export function conditionPhrase(i: TargetSummaryInput): string {
  const head: string[] = [];
  const area = areaText(i);
  if (area) head.push(area);
  // 間取りの「希望なし」「指定なし」等は書かない（実物 名無しの権兵衛「4.5万円ほど希望なし」）
  const plan = norm(i.floorPlan);
  const cond = [rentText(i.rentMax), plan && !/^(希望|指定|特に|こだわり)?(なし|無し|ない|不問)$/.test(plan) ? plan : null].filter(Boolean).join("");
  if (cond) head.push(cond);
  const parts = [...head, ...keyRequests(i.otherRequests, 2)];
  return parts.join("、");
}

/** 状況の一言（新しい時だけ・句点や「〜中」の後ろの説明を落とす） */
export function situationPhrase(i: Pick<TargetSummaryInput, "situation" | "situationAt" | "nowMs">): string | null {
  const s = norm(i.situation).replace(/[。．.]+$/, "");
  if (!s) return null;
  const at = i.situationAt ? Date.parse(i.situationAt) : NaN;
  if (!Number.isFinite(at) || i.nowMs - at > SITUATION_FRESH_DAYS * 86_400_000) return null;
  return s;
}

/**
 * 【内覧・申込】の一言。
 *   これからの内覧があれば「次回M/D内覧」を先に（竹内さん「🐥（次回9/18）」）
 *   ①内覧済み ②審査落ち … 状況の一言（新しい時）→ 無ければ希望の条件（段の名は書かない）
 *   ③新規 ④物件検索中 … 希望の条件 → 無ければ状況の一言
 */
export function targetSummaryLine(i: TargetSummaryInput, max = SUMMARY_MAX): string {
  const parts: string[] = [];
  const nv = i.nextViewingDate ? md(i.nextViewingDate) : null;
  if (nv) parts.push(`次回${nv}内覧`);
  const sit = situationPhrase(i);
  const cond = conditionPhrase(i);
  const priority = i.tier === "viewed" || i.tier === "screening_failed";
  const main = priority ? sit || cond : cond || sit;
  if (main) parts.push(main);
  // 段の名（審査落ち・内覧済み）は書かない: 竹内さんの共有も名前と一言だけで、並び（①〜④）で伝わる。
  //   状況の一言と段の名が食い違う（実物 隼斗「審査落ち、メゾン深江601の申込決定」）と読み違えるため
  return cut(parts.join("、"), max);
}

/** 【審査中】の一言（状況の一言だけ。古い・無い時は空＝名前だけ） */
export function screeningSummaryLine(i: Pick<TargetSummaryInput, "situation" | "situationAt" | "nowMs">, max = 30): string {
  const s = situationPhrase(i);
  return s ? cut(s, max) : "";
}
