// app/lib/web-brain-search.ts
// AIXツールの一括検索（ウェブでチェックしたお客様 → 拡張のブレインの PC が検索）の「何を積むか」「進み具合」（純関数・画面からも使える）。
//
// 2026-09-25 竹内「チェックボックスを付ける。拡張ツールのように、下にピンポイントか広げて検索、そしてリアプロか itandi で選択。
//   チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」「更新日も拡張ツールと連動」
//
// 積み方: 1人1コマンド（automation_commands・payload {source:"web_brain", is_wide, rp_update_days}・sites:[site]）。
//   更新日がお客様ごとに違うので1人ずつ（自動便の 11:00 と同じ形）。拾うのはブレインの PC だけ（/api/automation/pending?brain=1）。
//   1台だけが拾う（条件付き UPDATE・既存）。拾い手が3時間いなければ error（automation-sources.ts）。
// 決定（2026-09-25 竹内）: 自動検索（11時・17時の自動便）はまだ行わない＝ブレインの PC では見送りのまま。新着物件は手動の一括・個別の検索の分だけ。
import { effectiveRpUpdateDays, type RpUpdateDaysCustomer } from "./rp-update-days";

export const WEB_BRAIN_SOURCE = "web_brain";
export type WebBrainSite = "realnetpro" | "itandi" | "reins";
export const WEB_BRAIN_SITES: readonly WebBrainSite[] = ["realnetpro", "itandi", "reins"];
/** 一度に積める人数（押し間違いで全員を積まない） */
export const WEB_BRAIN_MAX_CUSTOMERS = 30;
/** レインズは条件を入れるだけ（送信は無い）→ 1人ずつ（次の人の条件で上書きされるため） */
export const REINS_MAX_CUSTOMERS = 1;

export function isWebBrainSite(v: unknown): v is WebBrainSite {
  return typeof v === "string" && (WEB_BRAIN_SITES as readonly string[]).includes(v);
}

export type WebBrainPayload = { source: typeof WEB_BRAIN_SOURCE; is_wide: boolean; rp_update_days: number | null };
export type WebBrainCommandRow = {
  command_type: "batch_property_search";
  customer_ids: string[];
  sites: WebBrainSite[];
  payload: WebBrainPayload;
  status: "pending";
};

/** 同じお客様・同じサイトの一括検索がまだ終わっていない（pending/running）時の鍵 */
export function queuedKey(customerId: string, site: string): string { return `${customerId}::${site}`; }

/**
 * 積む行を作る。customers は選んだ順。まだ終わっていない同じ検索（queued）は積まない（二度押し・2つの画面）。
 * 更新日はお客様ごと（rp-update-days.effectiveRpUpdateDays＝拡張の更新日と同じ）。
 */
export function buildWebBrainCommands(
  customers: ReadonlyArray<RpUpdateDaysCustomer & { id: string }>,
  site: WebBrainSite,
  isWide: boolean,
  opts: { nowMs?: number; queued?: ReadonlySet<string> } = {},
): { rows: WebBrainCommandRow[]; skipped: string[] } {
  const nowMs = opts.nowMs ?? Date.now();
  const rows: WebBrainCommandRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const c of customers) {
    const id = String(c.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (opts.queued?.has(queuedKey(id, site))) { skipped.push(id); continue; }
    rows.push({
      command_type: "batch_property_search",
      customer_ids: [id],
      sites: [site],
      payload: { source: WEB_BRAIN_SOURCE, is_wide: !!isWide, rp_update_days: effectiveRpUpdateDays(c, nowMs) },
      status: "pending",
    });
  }
  return { rows, skipped };
}

/** 選んだ人数とサイトで押せるか（押せない時は理由） */
export function webBrainBlockReason(count: number, site: WebBrainSite): string | null {
  if (count <= 0) return "お客様にチェックを入れてください";
  if (site === "reins" && count > REINS_MAX_CUSTOMERS) return "レインズは条件を入れるだけなので1人ずつです（次の人の条件で上書きされます）";
  if (count > WEB_BRAIN_MAX_CUSTOMERS) return `一度に積めるのは${WEB_BRAIN_MAX_CUSTOMERS}人までです`;
  return null;
}

export type CommandLite = { id: string; status: string; error_message?: string | null; created_at?: string | null; picked_up_at?: string | null };
export type WebBrainProgress = { total: number; done: number; running: number; pending: number; failed: number; cancelled: number; finished: boolean; waitingForBrainPc: boolean; line: string };

/**
 * 進み具合の1行。「ブレインの PC が拾っていない」は、全部がまだ pending のまま waitMs 以上たった時。
 */
export function summarizeWebBrainProgress(cmds: ReadonlyArray<CommandLite>, opts: { sinceMs: number; nowMs?: number; waitMs?: number }): WebBrainProgress {
  const nowMs = opts.nowMs ?? Date.now();
  const waitMs = opts.waitMs ?? 90_000;
  const n = (s: string) => cmds.filter((c) => c.status === s).length;
  const total = cmds.length, done = n("done"), running = n("running"), pending = n("pending"), failed = n("error"), cancelled = n("cancelled");
  const finished = total > 0 && pending === 0 && running === 0;
  const waitingForBrainPc = total > 0 && pending === total && nowMs - opts.sinceMs >= waitMs;
  const parts = [`完了 ${done}/${total}`];
  if (running) parts.push(`検索中 ${running}`);
  if (pending) parts.push(`待ち ${pending}`);
  if (failed) parts.push(`失敗 ${failed}`);
  if (cancelled) parts.push(`止めた ${cancelled}`);
  const line = `🧠 一括検索: ${parts.join("・")}${finished ? "（終わりました。新着物件は届き次第ここに並びます）" : ""}${waitingForBrainPc ? "（ブレインモードの PC がまだ拾っていません。拡張の 🧠 ブレインを ON に＝スタッフモード以外）" : ""}`;
  return { total, done, running, pending, failed, cancelled, finished, waitingForBrainPc, line };
}
