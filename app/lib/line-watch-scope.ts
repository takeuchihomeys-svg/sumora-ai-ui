// app/lib/line-watch-scope.ts
// 見張り（line_watch_turns）の「どの番を数えるか」と「控えが止まっていないか」の決まり（純関数・DB も fetch も LLM も持たない）。
//   2026-10-20 下書きなしの番の訳（scripts/audit-draft-diff-types.ts --why-no-draft）: 30日の返信の番で「下書きなし」148 のうち約126 が
//   測り方・記録の問題だった。ここはその4つの直し（数え方だけ。下書きを作る側・送る側は何も変えない）:
//
//   ① 申込以降の線を下書きの関所と同じにする（postApplyAtTurn）
//      見張りは conv_status だけで「対象外:申込以降」を決めていたが、下書きの関所は resolvePostApply（本人確認書類・収入証明・申込へ押下・印）で止める。
//      status が遅れている会話の番が「下書きが無い（手打ち）」に数えられていた（38番）。番の時点の記録で resolvePostApply を当て直す。
//      ⚠ 印（conversations.is_post_apply）は時刻が残らないので、番の時点の値が分からない → 使わない（今の印で昔の番を外すと戻した会話を外しすぎる）。
//      ⚠ 戻した時刻（deepseek_cutoff_at・status_manual_back_at）は最後の1回しか残らない → 番より後の戻しは見ない（その番の時点では戻していない）。
//        番より前に戻して、番より後にもう一度戻した会話は、前の戻しが見えず申込以降に寄る（少ない・数え方の側だけの誤差）。
//      戻す: LINE_WATCH_POSTAPPLY_SCOPE=off（status だけの今までの線）
//   ② 控えの止まり（findCaptureStalls）: トリガー capture_line_watch_turn は失敗を WARNING で飲む（EXCEPTION WHEN OTHERS）。
//      10/12 12:34Z〜10/15 00:01Z の約60時間、番の行はできたが下書き・ブレインの欄が1つも入らなかった（ブレインも下書きも実際は動いていた）。
//      営業時間（日本時間 10〜20時）に、ブレインの判断はあるのに控えの欄が埋まった番が2時間以上0件の区間を出す。
//   ③ 一致率の分母から外す番（watchTurnExclusion）: 埋め戻し・申込以降・番の鍵が消えた重複行・連投の途中向けの古い下書き（返信の道）
//   ④ 番の鍵（お客様の連投の最初の発言）が消えた・時刻が変わった重複行（findDuplicateTurns）→ 本物の行に寄せて判定する
// テスト: app/lib/__tests__/line-watch-scope.test.ts
import { resolvePostApply, type PostApplyReason } from "./post-apply";

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

// ─────────────────────────────────────────────────────────────
// ① 番の時点の申込以降
// ─────────────────────────────────────────────────────────────
/** 戻す: LINE_WATCH_POSTAPPLY_SCOPE=off。見張りの判定・数字だけに効く（下書きの関所 post-apply.ts は触らない） */
export function watchPostApplyScopeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LINE_WATCH_POSTAPPLY_SCOPE ?? "").trim().toLowerCase() !== "off";
}

/** 会話の申込の記録（時刻つき）。loadPostApplyFacts と同じ表から読む（最後の1つではなく全部） */
export type PostApplyTimeline = {
  /** AIX【申込へ】を押した時刻（aix_usage_logs.application_push） */
  applicationPushes: ReadonlyArray<string>;
  /** お客様から本人確認書類・収入証明書が届いた時刻（messages.image_type） */
  idDocuments: ReadonlyArray<string>;
  /** 段階を前に戻した時刻（conversations.status_manual_back_at・deepseek_cutoff_at の今の値＝最後の1回だけ） */
  statusManualBackAt?: string | null;
  deepseekCutoffAt?: string | null;
};

/**
 * 番の時点（atIso＝番の最後のお客様の発言）で申込以降だったか。resolvePostApply（下書きの関所と同じ関数）に、その時刻までの記録だけを渡す。
 *   status は番の控え（conv_status＝トリガーが番の時に書いた値）。印（is_post_apply）は時刻が無いので渡さない
 */
export function postApplyAtTurn(status: string | null | undefined, tl: PostApplyTimeline | null | undefined, atIso: string): { postApply: boolean; reason: PostApplyReason } {
  const at = ms(atIso);
  if (!tl || at === null) { const r = resolvePostApply({ status }); return { postApply: r.postApply, reason: r.reason }; }
  const lastBefore = (l: ReadonlyArray<string>) => {
    let best: number | null = null;
    for (const s of l) { const t = ms(s); if (t !== null && t <= at && (best === null || t > best)) best = t; }
    return best === null ? null : new Date(best).toISOString();
  };
  const before = (s: string | null | undefined) => { const t = ms(s); return t !== null && t <= at ? s! : null; };
  const r = resolvePostApply({
    status,
    applicationPushAt: lastBefore(tl.applicationPushes),
    idDocumentAt: lastBefore(tl.idDocuments),
    statusManualBackAt: before(tl.statusManualBackAt),
    deepseekCutoffAt: before(tl.deepseekCutoffAt),
  });
  return { postApply: r.postApply, reason: r.reason };
}

// ─────────────────────────────────────────────────────────────
// ④ 番の鍵が消えた重複行
// ─────────────────────────────────────────────────────────────
/** 鍵の発言を探す幅（トリガーの customer_turn_at は messages.created_at そのもの） */
export const TURN_KEY_TOLERANCE_MS = 1_000;
/** 本物の行を探す幅（鍵の発言が数秒ずれて入り直した形・実物 10/20 96c140e4: 06:07:27.5 の行が消え 06:07:29.3 の行が本物） */
export const DUPLICATE_SLACK_MS = 2 * 60_000;

export type DupTurn = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at?: string | null };
/**
 * 番の鍵（customer_turn_at）のお客様の発言が今は無い行のうち、同じ会話で鍵の発言がある行が近く（その行の連投の幅±2分）にある物 → その行の id。
 *   近くに本物の行が無い（発言が取り消された等）は重複ではない（返さない）。customerTimes は会話ごとのお客様の発言の時刻
 */
export function findDuplicateTurns(rows: ReadonlyArray<DupTurn>, customerTimes: ReadonlyMap<string, ReadonlyArray<string>>): Map<number, number> {
  const out = new Map<number, number>();
  const keyOk = (r: DupTurn) => {
    const t = ms(r.customer_turn_at);
    if (t === null) return false;
    return (customerTimes.get(r.conversation_id) ?? []).some((c) => { const x = ms(c); return x !== null && Math.abs(x - t) <= TURN_KEY_TOLERANCE_MS; });
  };
  const ok = new Map(rows.map((r) => [r.id, keyOk(r)]));
  for (const r of rows) {
    if (ok.get(r.id)) continue;
    // 会話の発言が1つも読めない（読む範囲の外）時は決めない
    if (!(customerTimes.get(r.conversation_id) ?? []).length) continue;
    const from = ms(r.customer_turn_at)!, to = Math.max(from, ms(r.customer_last_at) ?? from);
    if (!Number.isFinite(from)) continue;
    let best: DupTurn | null = null;
    for (const o of rows) {
      if (o.id === r.id || o.conversation_id !== r.conversation_id || !ok.get(o.id)) continue;
      const t = ms(o.customer_turn_at)!;
      if (t < from - DUPLICATE_SLACK_MS || t > to + DUPLICATE_SLACK_MS) continue;
      if (!best || Math.abs(t - from) < Math.abs(ms(best.customer_turn_at)! - from)) best = o;
    }
    if (best) out.set(r.id, best.id);
  }
  return out;
}

/** 重複行の控え（1段目の欄）を本物の行に寄せる: 本物の行で空の欄だけを重複行の値で埋める（本物の行の値は変えない） */
export const CAPTURE_MERGE_COLS = ["draft_last", "draft_last_at", "draft_first", "draft_first_at", "draft_versions", "draft_sentinel", "brain_action", "brain_reply_mode", "brain_versions", "tpo_label"] as const;
export function mergeCapture<T extends Record<string, unknown>>(real: T, dup: Record<string, unknown>): { merged: T; filled: string[] } {
  const merged: Record<string, unknown> = { ...real };
  const filled: string[] = [];
  const empty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || v === 0;
  // 下書きの欄はまとめて寄せる（片方だけ埋めると版の数と文が食い違う）
  const draftCols = ["draft_last", "draft_last_at", "draft_first", "draft_first_at", "draft_versions", "draft_sentinel"];
  const brainCols = ["brain_action", "brain_reply_mode", "brain_versions", "tpo_label"];
  for (const group of [draftCols, brainCols]) {
    const realEmpty = group.every((c) => empty(real[c]));
    const dupHas = group.some((c) => !empty(dup[c]));
    if (realEmpty && dupHas) for (const c of group) { merged[c] = dup[c] ?? null; if (!empty(dup[c])) filled.push(c); }
  }
  return { merged: merged as T, filled };
}

// ─────────────────────────────────────────────────────────────
// ③ 一致率の分母から外す番
// ─────────────────────────────────────────────────────────────
export type WatchExclusion = "backfill" | "out_of_scope" | "duplicate_turn" | "stale_draft";
export const WATCH_EXCLUSION_JA: Record<WatchExclusion, string> = {
  backfill: "埋め戻しの番（当時の控えなし）",
  out_of_scope: "申込以降（下書きの関所と同じ線）",
  duplicate_turn: "番の鍵が消えた重複行（本物の行に寄せた）",
  stale_draft: "連投の途中向けの古い下書き（返信の道・比べない）",
};
/**
 * 数えない番か。詰める順は上から（埋め戻し→申込以降→重複→古い下書き）。
 *   古い下書きは返信の道だけ（AIX の道は AIX の種類で比べる＝下書きに依らない）。
 */
export function watchTurnExclusion(t: { scene_key?: string | null; verdict_detail?: unknown }): WatchExclusion | null {
  const d = (t.verdict_detail && typeof t.verdict_detail === "object" && !Array.isArray(t.verdict_detail) ? t.verdict_detail : {}) as Record<string, unknown>;
  if (d.backfill) return "backfill";
  if ((t.scene_key ?? "").startsWith("対象外") || d.path === "対象外") return "out_of_scope";
  if (d.duplicate_of != null) return "duplicate_turn";
  if (d.draft_src === "stale" && (d.path === "返信" || (t.scene_key ?? "").startsWith("返信"))) return "stale_draft";
  return null;
}

// ─────────────────────────────────────────────────────────────
// ② 控えの止まり
// ─────────────────────────────────────────────────────────────
/** 日本時間の営業時間（この中だけ数える）・止まりとみなす長さ・その間のブレインの判断の数の下限 */
//   minDecisions=8: 直近20日を当てて（読むだけ・10/20）10/13・10/14 の止まり（判断 65・50件）だけが当たり、日曜の静かな時間（3.5時間・判断6件）は当たらない線
export const STALL = { startHour: 10, endHour: 20, minMs: 2 * 3600_000, minDecisions: 8 } as const;
const JST = 9 * 3600_000;

/** from〜to のうち日本時間 startHour〜endHour の区間（毎日） */
export function businessSpans(fromMs: number, toMs: number, startHour: number = STALL.startHour, endHour: number = STALL.endHour): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!(toMs > fromMs)) return out;
  const d0 = new Date(fromMs + JST); d0.setUTCHours(0, 0, 0, 0);
  for (let day = d0.getTime() - JST; day < toMs; day += 86_400_000) {
    const s = Math.max(fromMs, day + startHour * 3600_000), e = Math.min(toMs, day + endHour * 3600_000);
    if (e > s) out.push([s, e]);
  }
  return out;
}

export type CaptureStall = { from: string; to: string; minutes: number; decisions: number };
/**
 * 営業時間の中で、控えの欄が埋まった時刻（captures＝brain_at・draft_first_at・draft_last_at）が minMs 以上空き、
 *   その間にブレインの判断（decisions＝brain_decision_logs.created_at）が minDecisions 以上ある区間。
 *   営業時間ごとに切る（夜をまたいだ空きは翌朝10時から数え直す）
 */
export function findCaptureStalls(o: { captures: ReadonlyArray<string>; decisions: ReadonlyArray<string>; fromMs: number; toMs: number; minMs?: number; minDecisions?: number }): CaptureStall[] {
  const minMs = o.minMs ?? STALL.minMs, minDec = o.minDecisions ?? STALL.minDecisions;
  const caps = o.captures.map((s) => ms(s)).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const decs = o.decisions.map((s) => ms(s)).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const out: CaptureStall[] = [];
  for (const [s, e] of businessSpans(o.fromMs, o.toMs)) {
    const pts = [s, ...caps.filter((c) => c > s && c < e), e];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (b - a < minMs) continue;
      const n = decs.filter((d) => d >= a && d < b).length;
      if (n >= minDec) out.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), minutes: Math.round((b - a) / 60_000), decisions: n });
    }
  }
  return out;
}

/** 戻す（数えるのを止める）: LINE_WATCH_STALL_CHECK=off（記録だけ・外に送らない側。既定 on） */
export function watchStallCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LINE_WATCH_STALL_CHECK ?? "").trim().toLowerCase() !== "off";
}
/** LINE（売上番長グループの朝の報告）に出す: 既定 on（竹内さん 10/21 OK）・止める LINE_WATCH_STALL_ALERT=off */
export function watchStallAlertEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LINE_WATCH_STALL_ALERT ?? "").trim().toLowerCase() !== "off";
}
const hm = (iso: string) => { const d = new Date(Date.parse(iso) + JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
/** 人が読む1行（無ければ空） */
export function captureStallLine(stalls: ReadonlyArray<CaptureStall>): string {
  if (!stalls.length) return "";
  const head = stalls.slice(0, 3).map((x) => `${hm(x.from)}〜${hm(x.to).replace(/^\d+\/\d+ /, "")}（${x.minutes}分・判断${x.decisions}件）`).join("、");
  return `⚠️ 見張りの控えが止まっている疑い: ${head}${stalls.length > 3 ? ` ほか${stalls.length - 3}区間` : ""}（ブレインは動いているのに line_watch_turns の下書き・判断の欄が埋まっていない。トリガー capture_line_watch_turn は失敗を WARNING で飲むので DB のログを確認）`;
}
