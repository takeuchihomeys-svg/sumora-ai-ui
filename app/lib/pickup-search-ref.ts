// app/lib/pickup-search-ref.ts
// merge-pdfs が受け取った物から「この PDF を見つけた検索の回」（search_audits.run_id）と「一括検索の指示」（automation_commands.id）を取り出す（純関数）。
//
// 2026-11-10 竹内さん OK（拡張の裏データを DB で追えるように）: 直近14日のピックアップ 129 束のうち run_id で検索の回に結べる物は 0、
//   時刻の突き合わせでも 74% だけだった。merge-pdfs は一括の回の batch_owner.run_id・search_command_id を既に受け取っているのに残していなかった
//   → property_pickups.search_run_id / search_command_id に残す（v_search_runs が結ぶ）。
//
// 決まり:
//   ・run_id の出所は 本文の search_run_id → batch_owner.run_id → search_stamp.run_id の順（拡張が今送るのは batch_owner だけ・残りは Cursor が足す時の受け口）
//   ・指示の id は 本文の search_command_id → batch_owner.command_id の順
//   ・拡張から来た文字なので形を確かめる（英数字と _ - : . だけ・80 字まで）。合わない値は null（推測で埋めない・記録は止めない）
const SAFE_ID_RE = /^[A-Za-z0-9_\-:.]{1,80}$/;

function safeId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return SAFE_ID_RE.test(s) ? s : null;
}

function field(o: unknown, key: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
}

export type PickupSearchRef = { searchRunId: string | null; searchCommandId: string | null };

export function pickupSearchRef(body: unknown): PickupSearchRef {
  const owner = field(body, "batch_owner");
  const stamp = field(body, "search_stamp");
  const searchRunId = safeId(field(body, "search_run_id")) ?? safeId(field(owner, "run_id")) ?? safeId(field(stamp, "run_id"));
  const searchCommandId = safeId(field(body, "search_command_id")) ?? safeId(field(owner, "command_id"));
  return { searchRunId, searchCommandId };
}
