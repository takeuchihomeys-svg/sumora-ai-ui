// scripts/lib/brain-exam-pc.ts — ブレインの試験の条件の行（property_customers）を、その番の時点に巻き戻す（純関数・DB も LLM も呼ばない）
//
// 2026-10-09 試験の穴（scripts/audit-brain-exam-pc-leak.ts）: brain-exam-add は条件の行を「作った時点の今の値」で写していた。
//   70問中41問で番の後に変わった列があり、10問は行そのものが番の後に作られていた（q020 友だち追加だけの番に条件が埋まっている・
//   q070 限度額を聞く番に後で入った限度額・q081 地域を聞く番に後で入った地域）。59問は last_property_sent_at が番の後。
// 巻き戻し方:
//   ・行が番の後に作られた → 条件の行なし（null）＝その時点では条件が無かった
//   ・property_condition_history の番の後の最初の変更の old_value がその時点の値（列ごと）。⚠ 履歴に残らない書き換え（画面・要約の書き戻し）は戻せない＝asOf に残す
//   ・last_property_sent_at が番の後 → 写した台帳（sent_properties）の番までの最後の送付時刻（無ければ null）
//   ・property_send_count（返事の無い送付の数）が番の後に変わっている恐れ → 前のお客様の通の後の送付の AIX（物件を送る・オススメ）の回数で見積もる
// 直して下がる問題も正しい（未来の値で当たっていた）。
export type PcHist = { changed_field: string; old_value: string | null; created_at: string };
export type PcAsOf = { createdAfter: boolean; rolledBack: string[]; sentAt: "kept" | "ledger" | "none"; sendCount: "kept" | "estimated"; note?: string };
type LedgerRowLike = { ago: number; row: Record<string, unknown> };

const NUM = new Set(["rent_min", "rent_max", "walk_minutes", "floor_area_min", "floor_area_max", "commute_minutes", "initial_cost_limit", "building_age", "property_send_count"]);
const BOOL = new Set(["pet"]);
const ms = (s: unknown) => (typeof s === "string" ? Date.parse(s) : NaN);

function typed(field: string, v: string | null): unknown {
  if (v === null || v === undefined) return null;
  if (NUM.has(field)) { const n = Number(String(v).replace(/[,，]/g, "")); return v.trim() === "" || !Number.isFinite(n) ? null : n; }
  if (BOOL.has(field)) return v === "true" ? true : v === "false" ? false : null;
  return v;
}

export function rollbackPcToTurn(
  row: Record<string, unknown>, histAfter: ReadonlyArray<PcHist>, at: string,
  ledger: Record<string, ReadonlyArray<LedgerRowLike>> | undefined, prevCustomerAt: string | null,
): { pc: Record<string, unknown> | null; asOf: PcAsOf } {
  const atMs = Date.parse(at);
  if (Number.isFinite(ms(row.created_at)) && ms(row.created_at) > atMs) return { pc: null, asOf: { createdAfter: true, rolledBack: [], sentAt: "none", sendCount: "kept", note: "条件の行は番の後に作られた" } };
  const pc: Record<string, unknown> = { ...row };
  delete pc.created_at;
  const rolledBack: string[] = [];
  for (const h of [...histAfter].sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    if (ms(h.created_at) <= atMs || rolledBack.includes(h.changed_field) || !(h.changed_field in pc)) continue;
    pc[h.changed_field] = typed(h.changed_field, h.old_value);
    rolledBack.push(h.changed_field);
  }
  let sentAt: PcAsOf["sentAt"] = "kept", sendCount: PcAsOf["sendCount"] = "kept";
  if (Number.isFinite(ms(pc.last_property_sent_at)) && ms(pc.last_property_sent_at) > atMs) {
    const sends = (ledger?.sent_properties ?? []).map((r) => r.row.sent_at).filter((v) => Number.isFinite(ms(v)) && ms(v) <= atMs).map((v) => ms(v));
    pc.last_property_sent_at = sends.length ? new Date(Math.max(...sends)).toISOString() : null;
    sentAt = sends.length ? "ledger" : "none";
    const prev = prevCustomerAt ? Date.parse(prevCustomerAt) : -Infinity;
    const rounds = new Set((ledger?.aix_usage_logs ?? []).filter((r) => /^property_(?:send|recommendation)$/.test(String(r.row.aix_type ?? "")) && ms(r.row.created_at) > prev && ms(r.row.created_at) <= atMs)
      .map((r) => Math.floor(ms(r.row.created_at) / 600_000)));
    pc.property_send_count = rounds.size;
    sendCount = "estimated";
  }
  return { pc, asOf: { createdAfter: false, rolledBack, sentAt, sendCount } };
}
