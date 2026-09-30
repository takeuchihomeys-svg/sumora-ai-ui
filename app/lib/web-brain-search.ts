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
import type { SearchOverride } from "./search-override";

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

/**
 * 2026-09-30 v2.5.42 竹内「リアプロと itandi、お客さんそれぞれ同時に完了するようにする。YUMA ならリアプロと itandi 完了して、次のお客さんに移る」:
 *   1人1コマンドに「リアプロ＋itandi」の両方を載せてよい（拡張は同じお客様の リアプロ → ITANDI を続けて回してから次のお客様へ）。
 *   受け付ける形: 1サイト（リアプロ・itandi・レインズ）か、リアプロ＋itandi の2つ（並びはリアプロ → itandi にそろえる）。それ以外は null
 */
export function normalizeWebBrainSites(v: unknown): WebBrainSite[] | null {
  const list = Array.isArray(v) ? v : [v];
  const uniq = [...new Set(list.map((x) => String(x ?? "")))];
  if (!uniq.length || !uniq.every(isWebBrainSite)) return null;
  if (uniq.length === 1) return [uniq[0] as WebBrainSite];
  if (uniq.length === 2 && uniq.includes("realnetpro") && uniq.includes("itandi")) return ["realnetpro", "itandi"];
  return null;
}
const siteList = (site: WebBrainSite | ReadonlyArray<WebBrainSite>): WebBrainSite[] => (Array.isArray(site) ? [...site] : [site as WebBrainSite]);

export type WebBrainPayload = {
  source: typeof WEB_BRAIN_SOURCE; is_wide: boolean; rp_update_days: number | null;
  /** 2026-09-27 AIXツールのメモ欄の検索の指示（その回だけの一時調整・search-override.ts）。無ければ登録の条件のまま */
  search_override?: SearchOverride;
};
export type WebBrainCommandRow = {
  command_type: "batch_property_search";
  customer_ids: string[];
  sites: WebBrainSite[];
  payload: WebBrainPayload;
  status: "pending";
};

/** まだ拾われていない（pending）同じお客様の web_brain の命令（別のサイトで積んだ物） */
export type PendingWebBrain = { id: string; customer_ids: string[] | null; sites: string[] | null; payload: { is_wide?: boolean | null; search_override?: unknown } | null };

/**
 * 2026-09-30 v2.5.42 リアプロを押した後に itandi を押した時（別々に積むと「全員のリアプロ → 全員の itandi」の順に回る）、
 *   まだ拾われていない同じお客様の命令（同じ ピンポイント／広げて・一時調整の上書きが無い）に新しいサイトを足す＝1人ずつ両サイトを続けて回す。
 *   足せない行（上書き付き・広げてが違う・もう拾われた）は今まで通り新しく積む（純関数）
 */
export function planWebBrainFold(rows: ReadonlyArray<WebBrainCommandRow>, pending: ReadonlyArray<PendingWebBrain>): { fold: Array<{ commandId: string; customerId: string; sites: WebBrainSite[] }>; insert: WebBrainCommandRow[] } {
  const fold: Array<{ commandId: string; customerId: string; sites: WebBrainSite[] }> = [];
  const insert: WebBrainCommandRow[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    const cid = r.customer_ids[0];
    const hit = r.customer_ids.length === 1 && !r.payload.search_override ? pending.find((pc) =>
      !used.has(pc.id) && (pc.customer_ids ?? []).length === 1 && String(pc.customer_ids![0]) === String(cid)
      && !!pc.payload?.is_wide === !!r.payload.is_wide && !pc.payload?.search_override
      && r.sites.some((s) => !(pc.sites ?? []).includes(s))) : undefined;
    if (!hit) { insert.push(r); continue; }
    const merged = normalizeWebBrainSites([...(hit.sites ?? []), ...r.sites]);
    if (!merged) { insert.push(r); continue; }
    used.add(hit.id);
    fold.push({ commandId: hit.id, customerId: String(cid), sites: merged });
  }
  return { fold, insert };
}

/** 同じお客様・同じサイトの一括検索がまだ終わっていない（pending/running）時の鍵 */
export function queuedKey(customerId: string, site: string): string { return `${customerId}::${site}`; }

/**
 * 積む行を作る。customers は選んだ順。まだ終わっていない同じ検索（queued）は積まない（二度押し・2つの画面）。
 * 更新日はお客様ごと（rp-update-days.effectiveRpUpdateDays＝拡張の更新日と同じ）。
 */
export function buildWebBrainCommands(
  customers: ReadonlyArray<RpUpdateDaysCustomer & { id: string }>,
  site: WebBrainSite | ReadonlyArray<WebBrainSite>,
  isWide: boolean,
  opts: { nowMs?: number; queued?: ReadonlySet<string>; searchOverride?: SearchOverride | null } = {},
): { rows: WebBrainCommandRow[]; skipped: string[] } {
  const nowMs = opts.nowMs ?? Date.now();
  const rows: WebBrainCommandRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const c of customers) {
    const id = String(c.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // 2026-09-30 v2.5.42 両サイトの時は、まだ終わっていない同じサイトの検索だけを除く（全部積んであれば積まない）
    const want = siteList(site).filter((s) => !opts.queued?.has(queuedKey(id, s)));
    if (!want.length) { skipped.push(id); continue; }
    rows.push({
      command_type: "batch_property_search",
      customer_ids: [id],
      sites: want,
      payload: { source: WEB_BRAIN_SOURCE, is_wide: !!isWide, rp_update_days: effectiveRpUpdateDays(c, nowMs), ...(opts.searchOverride ? { search_override: opts.searchOverride } : {}) },
      status: "pending",
    });
  }
  return { rows, skipped };
}

/** 選んだ人数とサイトで押せるか（押せない時は理由） */
export function webBrainBlockReason(count: number, site: WebBrainSite | ReadonlyArray<WebBrainSite>): string | null {
  if (count <= 0) return "お客様にチェックを入れてください";
  if (siteList(site).includes("reins") && count > REINS_MAX_CUSTOMERS) return "レインズは条件を入れるだけなので1人ずつです（次の人の条件で上書きされます）";
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
