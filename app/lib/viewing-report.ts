// app/lib/viewing-report.ts
// 内覧の内容（内覧に行ったスタッフが分かったこと）を、ブレイン・戦略・返信生成・AIX に渡す形にする（純関数・DB は viewing-report-store.ts）。
// 2026-09-15 竹内（yasuki 事例）「息子さんとの状況がわかっていなかった可能性高い。内覧後の挨拶の部分に内覧の内容入れといた方が良い。
//   そうすれば実際に内覧に行ったスタッフが知っている部分が分かる」。
//   事例: 内覧後に「息子様での代理契約可能」と伝えた後、お客様「息子に確認の連絡を入れますので夕方くらいに折り返しの連絡をさせて頂きます」
//   → 下書き「息子様からのご返答お待ちしております」（連絡してくるのはお客様ご本人）。ブレインも「息子（保証人候補）に代理契約可否を確認する必要」
//   と読み違えた（代理契約できることは伝え済み）。対面で分かった事情（誰が契約するか・誰と相談するか）は会話に書かれず、どこにも残っていなかった
import { jstMD } from "./jst-date";

export const VIEWING_REPORT_MAX_CHARS = 600;
/** 渡す内覧の内容の件数と古さの上限 */
export const VIEWING_REPORT_PROMPT_LIMIT = 2;
export const VIEWING_REPORT_MAX_AGE_DAYS = 90;

export type ViewingReport = { viewedOn: string; propertyName: string | null; report: string; reportedAt: string };

/** 画面の入力 → 保存する文（空行・前後の空白を落とし、長さを制限） */
export function normalizeViewingReport(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n").slice(0, VIEWING_REPORT_MAX_CHARS);
}

function ymdAddDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 内覧の内容を書く内覧の記録を選ぶ: 今日〜3日前の、キャンセル以外で一番新しい日（予定・日付経過・済み）。
 * 未来の予定（次の内覧）には書かない。無ければ null（今日の日付で新しく作る）
 */
export function pickViewingRowForReport<T extends { scheduled_date: string; status: string | null }>(rows: T[], todayYmd: string): T | null {
  const from = ymdAddDays(todayYmd, -3);
  return rows
    .filter((r) => r.status !== "cancelled" && r.scheduled_date <= todayYmd && r.scheduled_date >= from)
    .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0] ?? null;
}

/** 新しい順・古すぎる物は落とす */
export function recentViewingReports(reports: ViewingReport[], nowMs: number = Date.now()): ViewingReport[] {
  const cutoff = nowMs - VIEWING_REPORT_MAX_AGE_DAYS * 86_400_000;
  return reports
    .filter((r) => r.report.trim() && Date.parse(r.reportedAt) >= cutoff)
    .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
    .slice(0, VIEWING_REPORT_PROMPT_LIMIT);
}

function reportLines(reports: ViewingReport[]): string {
  return reports.map((r) => {
    const md = jstMD(`${r.viewedOn}T12:00:00+09:00`);
    return `- ${md} 内覧${r.propertyName ? `（${r.propertyName}）` : ""}: ${r.report.replace(/\n+/g, " ／ ")}`;
  }).join("\n");
}

/** ブレイン（今回の発言の層・全項目の分析・戦略の整理）に渡す */
export function viewingReportBlockForBrain(reports: ViewingReport[], nowMs: number = Date.now()): string {
  const rs = recentViewingReports(reports, nowMs);
  if (rs.length === 0) return "";
  return `\n【内覧に行ったスタッフの記録（確定事実・会話に書かれていない事情はここが正）】\n${reportLines(rs)}\n`
    + `※お客様の発言はこの事情（誰が契約するか・誰と相談しているか・気に入った物件・気にしている点）を踏まえて読む。latent_intent・reply_direction・closing_strategy・next_steps をこの記録と矛盾させない`;
}

/** 返信生成・AIX の文面生成に渡す */
export function viewingReportNoteForReply(reports: ViewingReport[], nowMs: number = Date.now()): string {
  const rs = recentViewingReports(reports, nowMs);
  if (rs.length === 0) return "";
  return `\n\n【🏠 内覧に行ったスタッフが分かったこと（スタッフの記録・確定事実）】\n${reportLines(rs)}\n`
    + `・会話に書かれていない事情（誰が契約するか・誰と相談しているか・気に入った物件・気にしている点）はこの記録が正。お客様の今回の発言はこの事情を踏まえて読む（例:「息子に確認して折り返します」なら、連絡してくるのはお客様ご本人）\n`
    + `・記録の文をそのまま書き写さない。お客様が言っていない評価・こちらの見立ては本文に書かない`;
}
