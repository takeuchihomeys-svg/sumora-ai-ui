// app/lib/estimate-event-guard.ts — 見積の予定（calendar_events.event_type=estimate_sheet）を、時刻では済みにせず、同じ会話・同じ時刻の重複は1つにする（純関数・既定 off）
//
// 2026-11-22 作業員K2（台帳 #580・#596・統括役の頼み）。
//   30日で「見積を送っていないのに見積の予定が済み」の会話が 10（申込以降を外して 9・今日まで見積を送っていない・8会話はこちらが御見積書の作成を約束していた）。
//   済みにしていたのは cron/calendar-auto-complete（30分ごと・時刻が過ぎた予定を済み・notes が【必ず】で始まる行と内覧だけ除く）。
//   ブレインが作る見積の予定（notes「[Brain AIX] …」）は、見積を送らなくても時刻が過ぎると済みになっていた。
//   また同じ会話・同じ時刻（作成が1秒以内）の見積の予定が2つずつ 6組（ブレインの行どうし・ブレインの行と【必ず】の行）＝作る所の取り合い。
// 直し（ESTIMATE_EVENT_GUARD=on の時だけ）:
//   ① 時刻で済みにする対象から見積の予定を外す（済みは見積書を送った時＝save-reply-example の見積書送付の消込・sent-facts の約束の消込のまま）
//   ② 同じ会話の、開いている見積の予定で start_at が DUP_WINDOW_MS 以内の物は1つだけ残し、他は済みにする（【必ず】の行を残す・同じなら早く作った方）
// テスト: app/lib/__tests__/estimate-event-guard.test.ts（9会話の形を伏せて）
type Env = Record<string, string | undefined>;
export function estimateEventGuardOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.ESTIMATE_EVENT_GUARD ?? "").trim().toLowerCase() === "on";
}
export const DUP_WINDOW_MS = 10 * 60_000;
export type EstimateEventRow = { id: string | number; conversation_id: string | null; start_at: string; created_at?: string | null; notes?: string | null; is_done?: boolean | null; event_type?: string | null };

const isMust = (r: EstimateEventRow) => /^【必ず】/.test(String(r.notes ?? ""));
/** 閉じる重複の id（開いている見積の予定だけ・会話ごとに start_at の近い物を束ねて1つ残す） */
export function duplicateEstimateEventIds(rows: ReadonlyArray<EstimateEventRow>, windowMs = DUP_WINDOW_MS): Array<string | number> {
  const open = rows.filter((r) => !r.is_done && (r.event_type == null || r.event_type === "estimate_sheet") && r.conversation_id);
  const byConv = new Map<string, EstimateEventRow[]>();
  for (const r of open) byConv.set(r.conversation_id!, [...(byConv.get(r.conversation_id!) ?? []), r]);
  const close: Array<string | number> = [];
  for (const list of byConv.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    let group: EstimateEventRow[] = [];
    const flush = () => {
      if (group.length > 1) {
        const keep = [...group].sort((a, b) => Number(isMust(b)) - Number(isMust(a)) || Date.parse(a.created_at ?? a.start_at) - Date.parse(b.created_at ?? b.start_at))[0];
        for (const g of group) if (g.id !== keep.id) close.push(g.id);
      }
      group = [];
    };
    for (const r of sorted) {
      if (group.length && Date.parse(r.start_at) - Date.parse(group[0].start_at) > windowMs) flush();
      group.push(r);
    }
    flush();
  }
  return close;
}
