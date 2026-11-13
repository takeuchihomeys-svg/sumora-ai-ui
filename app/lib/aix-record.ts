// app/lib/aix-record.ts — 1件の AIX の記録の型（純関数・DB/LLM なし）
//
// 2026-11-13 作業員1（統括役の頼み・竹内さん「記録、AIX の種類なども、土台を作って、細かい部分は細分化して強化する」）。
//   土台: 見張りの番（line_watch_turns）の staff_aix が空の時、「AIX 無し」と「記録が取れなかった」と「お客様が続けて話した（次の番に付いた）」を分けて残す。
//     実物（直近7日・空の番 71）: 窓の中に AIX の記録がある番は 0・AIX の文（is_aix_generated）があって記録が無い番も 0。
//     24時間の内に AIX があった 36番は全部「次のお客様の発言の後」に押した物（番 11447: 09:56 のお客様→10:11 にお客様が続け→10:21 に物件確認した）。
//     そのうち 25番は次の番の staff_aix に付いている＝記録の穴ではなく、番の窓（次のお客様の発言まで）で次の番の一手になっていた。
//   細分化: 1件の AIX を 種類・下の種類（check_pattern／ピッカーで選んだ物）・物件の状態・何通目か・ブレインの勧めと同じか・スタッフが直したか・見積を同封したか に分ける
//     （ブレインの勧めと違う AIX は「提案と違う」と記録する・竹内さんの決定 69adf2b0）。見張り（staff_aix）・物差し（staffFrames）・材料の帳面が同じ名前で読む。
//   既定 off（WATCH_AIX_RECORD_V2=on の時だけ staff_aix に欄を足し、verdict_detail.staff_aix_state を書く）

export function watchAixRecordV2On(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.WATCH_AIX_RECORD_V2 ?? "").trim().toLowerCase() === "on";
}

/** aix_usage_logs の1行（読む欄だけ） */
export type AixLogRow = {
  aix_type: string | null; check_pattern?: string | null; created_at: string; sent_at?: string | null;
  picker_choices?: Record<string, unknown> | null; prop_statuses?: string[] | null; suggested_action?: string | null;
  was_edited?: boolean | null; send_mode?: string | null; estimate_sent?: boolean | null;
  /** 送った LINE のメッセージの id（messages.line_message_id と結ぶ＝押した人） */
  line_message_id?: string | null;
};
/** 押した人（line-watch-judge の書き手と同じ名前・messages.staff_writer）。結べない時は unknown＝記録の穴として別に数える */
export type PressedBy = { by: "takeuchi" | "employee" | "unknown"; basis: string | null };
/** ブレインの勧めと押した AIX の関係 */
export type BrainMatch = "same" | "diff" | "no_suggest";
/** 1件の AIX の記録（見張り・物差し・材料の帳面が同じ名前で読む） */
export type AixRecord = {
  aix_type: string; at: string; burst?: boolean;
  /** 下の種類: check_pattern、無ければピッカーで選んだ物（最初の文字の値・例 ack_preset=daihyo_initial_cost） */
  sub: string | null;
  /** 物件の状態（ピッカーの available／unavailable／alternative …） */
  statuses: string[] | null;
  /** 何通目か（同じまとまりの中の押した順・1＝1通目のテンプレ） */
  nth: number;
  brain: BrainMatch;
  suggested: string | null;
  edited: boolean | null;
  estimate: boolean | null;
  send_mode: string | null;
  check_pattern: string | null;
  /** 押した人（竹内さん基準・KB 41dadfe6・ce349a3f）。物差しにするのは takeuchi だけ */
  by: PressedBy["by"];
  by_basis: string | null;
};

/** ピッカーの選んだ物の最初の文字の値（「キー=値」）。真偽だけの物は数えない */
export function pickerSub(pc: Record<string, unknown> | null | undefined): string | null {
  if (!pc || typeof pc !== "object") return null;
  for (const [k, v] of Object.entries(pc)) if (typeof v === "string" && v.trim()) return `${k}=${v.trim()}`.slice(0, 60);
  return null;
}
export function brainMatchOf(aixType: string, suggested: string | null | undefined): BrainMatch {
  const s = String(suggested ?? "").trim();
  if (!s || s === "none") return "no_suggest";
  return s === aixType ? "same" : "diff";
}
/** 押した順に並べた記録（burstOf は番のまとまりの中か） */
export function toAixRecords(rows: ReadonlyArray<AixLogRow>, burstOf?: (at: string) => boolean, writerOf?: (lineMessageId: string) => { writer: string | null; basis?: string | null } | null): AixRecord[] {
  const sorted = rows.filter((r) => r.aix_type).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let nthInBurst = 0, nthOut = 0;
  return sorted.map((r) => {
    const burst = burstOf ? burstOf(r.created_at) : undefined;
    const nth = burst === false ? ++nthOut : ++nthInBurst;
    const t = String(r.aix_type);
    return {
      aix_type: t, at: r.created_at, ...(burst === undefined ? {} : { burst }),
      sub: r.check_pattern ?? pickerSub(r.picker_choices ?? null), statuses: r.prop_statuses?.length ? [...r.prop_statuses] : null,
      nth, brain: brainMatchOf(t, r.suggested_action), suggested: r.suggested_action ?? null,
      edited: r.was_edited ?? null, estimate: r.estimate_sent ?? null, send_mode: r.send_mode ?? null, check_pattern: r.check_pattern ?? null,
      ...pressedByOf(r.line_message_id ? writerOf?.(r.line_message_id) ?? null : null),
    };
  });
}

/** 押した人: messages.staff_writer が takeuchi／employee の時だけ言い切る（それ以外・結べない＝unknown） */
export function pressedByOf(w: { writer: string | null; basis?: string | null } | null): { by: PressedBy["by"]; by_basis: string | null } {
  const x = String(w?.writer ?? "").trim();
  return x === "takeuchi" || x === "employee" ? { by: x, by_basis: w?.basis ?? null } : { by: "unknown", by_basis: null };
}

/** 番の staff_aix が空かどうかの理由（土台） */
export type StaffAixState = "pressed" | "none" | "next_turn" | "unknown";
/**
 * pressed＝窓の中に AIX がある／next_turn＝窓の中には無いが、番の最後のお客様の発言から24時間の内・次のお客様の発言の後に押した（次の番の一手）／
 * none＝窓が閉じて AIX が無い（返信だけ・何もしない）／unknown＝窓がまだ開いている（これから押すかもしれない）
 */
export function staffAixState(o: { windowPresses: number; closed: boolean; customerLastAt: string; endAt: string; allPresses: ReadonlyArray<{ created_at: string; aix_type?: string | null }> }): StaffAixState {
  if (o.windowPresses > 0) return "pressed";
  if (!o.closed) return "unknown";
  const last = Date.parse(o.customerLastAt), end = Date.parse(o.endAt);
  const later = o.allPresses.some((p) => p.aix_type && Date.parse(p.created_at) >= end && Date.parse(p.created_at) < last + 86_400_000);
  return later ? "next_turn" : "none";
}
