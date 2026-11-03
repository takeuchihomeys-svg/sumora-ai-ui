// app/lib/ops-anomaly.ts — 本番の異常の知らせ（土台の8つ ③・2026-11-03 作業員1・指揮役が案B を選んだ）
//
// 何を見るか（5分ごとの cron・SQL の件数だけ・LLM は呼ばない＝費用0）:
//   llm_fail    直近15分の LLM の失敗（status 5xx か 0＝時間切れ・つながらない。テストの行・script: の行・個人情報で別の窓口を止めた alt_skipped_pii は数えない）
//               → 同じ曜日の同じ時間帯（過去4週の同じ15分）の平均と比べる。max(5, 平均×3+3) 以上で知らせる
//   draft_stuck 下書きを作り始めたまま15分〜6時間止まっている会話（conversations.draft_pending_at）。3件以上で知らせる
//               （6時間より古い印は前からの取り残し＝別の問題・数えない。11/03 実測: 15分より古い31件のうち6時間以内は1件）
//   cron_fail   直近30分の cron の失敗（cron_run_logs.ok=false）。3件以上で知らせる
//   brain_gap   JST 10〜22 に、直近90分にお客様の発言が4件以上あるのにブレインの判断の記録が0件
//               （9時台は夜間見送り（22〜9 は 9 時から）の発言が溜まっている＝30日の当て直しで 9:00 の4回が全部これ・10時から見る）
// 30日の当て直し（11/03・SQL）: llm_fail は 10/22 23:15〜10/23 06:45 の障害の6回だけ・cron_fail 0回（30分の最大1件）・brain_gap 3回（10/20 18:30・10/27 13:30・10/28 13:30）
// 知らせ先（案B）: 記録の表 ops_anomalies（作業員が読む）＋画面の上の印（NEXT_PUBLIC_OPS_ANOMALY_BANNER=on の時だけ）。
//   宛先は OPS_ANOMALY_DESTINATIONS で足せる形（今は table だけ。後で line 等を足す時は notifyDestinations に足す）
//   売上番長グループには送らない（feedback_group_aix_only）
// 同じ種類が続く間は1行を更新する（開いた行＝resolved_at が null）。正常に戻った回に resolved_at を入れる。

export type AnomalyKind = "llm_fail" | "draft_stuck" | "cron_fail" | "brain_gap";
export type AnomalyStats = {
  /** 直近15分の LLM の失敗 */ llmFail15: number;
  /** 過去4週の同じ曜日・同じ15分の LLM の失敗（週ごと） */ llmFailBaseline: number[];
  /** 下書きが15分〜6時間止まっている会話 */ draftStuck: number;
  /** 直近30分の cron の失敗 */ cronFail30: number;
  /** 失敗した cron の名前（多い順・最大5） */ cronFailNames?: string[];
  /** 直近90分のお客様の発言 */ customerMsgs90: number;
  /** 直近90分のブレインの判断の記録 */ brainLogs90: number;
  /** JST の時（0〜23） */ jstHour: number;
};
export type Anomaly = { kind: AnomalyKind; severity: "warn" | "high"; value: number; baseline: number | null; why: string; detail?: Record<string, unknown> };

export const ANOMALY_LABEL: Record<AnomalyKind, string> = {
  llm_fail: "AI の呼び出しの失敗が多い",
  draft_stuck: "下書きが止まっている",
  cron_fail: "定時の処理の失敗が続く",
  brain_gap: "ブレインの判断が止まっている",
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function evaluateAnomalies(s: AnomalyStats): Anomaly[] {
  const out: Anomaly[] = [];
  const base = avg(s.llmFailBaseline);
  const llmLine = Math.max(5, Math.ceil(base * 3 + 3));
  if (s.llmFail15 >= llmLine)
    out.push({ kind: "llm_fail", severity: s.llmFail15 >= Math.max(15, llmLine * 2) ? "high" : "warn", value: s.llmFail15, baseline: Math.round(base * 10) / 10, why: `直近15分の失敗 ${s.llmFail15}件（いつもの同じ時間帯 ${base.toFixed(1)}件・線 ${llmLine}）` });
  if (s.draftStuck >= 3)
    out.push({ kind: "draft_stuck", severity: s.draftStuck >= 8 ? "high" : "warn", value: s.draftStuck, baseline: null, why: `下書きを作り始めたまま15分以上止まっている会話 ${s.draftStuck}件` });
  if (s.cronFail30 >= 3)
    out.push({ kind: "cron_fail", severity: s.cronFail30 >= 10 ? "high" : "warn", value: s.cronFail30, baseline: null, why: `直近30分の cron の失敗 ${s.cronFail30}件${s.cronFailNames?.length ? `（${s.cronFailNames.join("・")}）` : ""}`, detail: s.cronFailNames?.length ? { crons: s.cronFailNames } : undefined });
  if (s.jstHour >= 10 && s.jstHour < 22 && s.customerMsgs90 >= 4 && s.brainLogs90 === 0)
    out.push({ kind: "brain_gap", severity: s.customerMsgs90 >= 10 ? "high" : "warn", value: s.customerMsgs90, baseline: 0, why: `直近90分にお客様の発言 ${s.customerMsgs90}件・ブレインの判断の記録 0件` });
  return out;
}

/** 開いている行と今回の結果から、足す・更新する・閉じる を決める（純関数） */
export function planAnomalyWrites(open: Array<{ id: string; kind: string; severity: string; value: number }>, now: Anomaly[]): { insert: Anomaly[]; update: Array<{ id: string; a: Anomaly }>; resolve: string[] } {
  const insert: Anomaly[] = [], update: Array<{ id: string; a: Anomaly }> = [], resolve: string[] = [];
  for (const a of now) { const o = open.find((x) => x.kind === a.kind); if (o) update.push({ id: o.id, a }); else insert.push(a); }
  for (const o of open) if (!now.some((a) => a.kind === o.kind)) resolve.push(o.id);
  return { insert, update, resolve };
}

/** 知らせ先（OPS_ANOMALY_DESTINATIONS・既定 table,line）。line は宛先の env（OPS_ANOMALY_LINE_TO・OPS_ANOMALY_LINE_CHANNEL）がある時だけ送る */
export function anomalyDestinations(env: Record<string, string | undefined> = process.env): string[] {
  const v = String(env.OPS_ANOMALY_DESTINATIONS ?? "table,line").split(",").map((x) => x.trim()).filter(Boolean);
  return v.length ? v : ["table"];
}
/** OPS_ANOMALY_WATCH: off（既定）／dry（数えて決めてログに出すだけ・表に書かない＝最初の確かめ用。vercel crons run は query を渡せない）／on */
export function opsAnomalyWatchMode(env: Record<string, string | undefined> = process.env): "off" | "dry" | "on" { const v = String(env.OPS_ANOMALY_WATCH ?? "").trim().toLowerCase(); return v === "on" ? "on" : v === "dry" ? "dry" : "off"; }
export function opsAnomalyWatchOn(env: Record<string, string | undefined> = process.env): boolean { return opsAnomalyWatchMode(env) === "on"; }

// ─── 竹内さん個人の LINE（2026-11-03 夕 竹内さんの決定・KB P1）──────────────────────────
//   記録の表・画面の印に加えて、竹内さん個人の LINE にも送る。売上番長グループには送らない（feedback_group_aix_only）。
//   送り先は「会話の id」（OPS_ANOMALY_LINE_CONVERSATION）で受け、その会話の line_user_id とアカウント（conversations.account）から鍵を選ぶ
//   （send-line-message と同じ対応: スモラ／イエヤス／ギガ賃貸・無ければスモラ）。既定は YUMA（11/03 夜 竹内さんの決定）。
//   送る通は LINE の push だけで messages の表には入れない＝AIX ツールの会話・ブレイン・見張り・試験には載らない（webhook は push を返さない）。
//   同じ種類は1時間に1回まで
import { YUMA_CONVERSATION_ID } from "./test-conversations";
export const LINE_NOTIFY_MIN_INTERVAL_MS = 60 * 60_000;
const ACCOUNT_TOKEN_ENV: Record<string, string> = { sumora: "LINE_SUMORA_CHANNEL_ACCESS_TOKEN", "スモラ": "LINE_SUMORA_CHANNEL_ACCESS_TOKEN", ieyasu: "LINE_IEYASU_CHANNEL_ACCESS_TOKEN", "イエヤス": "LINE_IEYASU_CHANNEL_ACCESS_TOKEN", giga: "LINE_GIGA_CHANNEL_ACCESS_TOKEN", "ギガ賃貸": "LINE_GIGA_CHANNEL_ACCESS_TOKEN", hasu: "LINE_HASU_CHANNEL_ACCESS_TOKEN" };
/** 会話の行から送り先と鍵を決める（個人の id＝U… だけ・グループ C… は送らない） */
export function anomalyLineTargetFrom(conv: { line_user_id?: string | null; account?: string | null } | null, env: Record<string, string | undefined> = process.env): { to: string; token: string } | null {
  const to = String(conv?.line_user_id ?? "").trim();
  if (!/^U[0-9a-f]{32}$/.test(to)) return null;
  const token = String(env[ACCOUNT_TOKEN_ENV[String(conv?.account ?? "").trim()] ?? "LINE_SUMORA_CHANNEL_ACCESS_TOKEN"] ?? "").trim();
  return token ? { to, token } : null;
}
export function anomalyLineConversation(env: Record<string, string | undefined> = process.env): string | null {
  // 11/03 夜 竹内さんの決定: 既定は YUMA（竹内さん本人・スモラのアカウント）。会話の id は鍵ではない。止める: OPS_ANOMALY_LINE_CONVERSATION=off
  const raw = String(env.OPS_ANOMALY_LINE_CONVERSATION ?? "").trim();
  if (raw.toLowerCase() === "off") return null;
  const v = raw || YUMA_CONVERSATION_ID;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}
/** LINE に送ってよいか: 宛先に line があり、同じ種類を直近1時間に LINE へ送っていない */
export function shouldLineNotify(kind: string, lastLineAtByKind: Record<string, string | undefined>, nowMs: number, dests: string[]): boolean {
  if (!dests.includes("line")) return false;
  const last = lastLineAtByKind[kind];
  return !last || nowMs - Date.parse(last) >= LINE_NOTIFY_MIN_INTERVAL_MS;
}
export function anomalyLineText(a: Anomaly): string {
  return `⚠ 本番の異常（${a.severity === "high" ? "重い" : "注意"}）: ${ANOMALY_LABEL[a.kind]}\n${a.why}\n（同じ種類は1時間に1回まで・画面の上の印と ops_anomalies にも記録）`;
}
