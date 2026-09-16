// app/lib/promise-calendar.ts
// お客様に約束した事（送信時の記録 sent_facts の promised）をカレンダーに【必ず】で置き、履行したら完了にする（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（慶次・𝒮 さん事例）「今日約束した事はカレンダーに【必ず】と入れて、お客さん名と要件を入れる（AIX と合わせて）。
//   そうしたら予定漏れが無くなり、お客さんに対して漏れる事が無くなる。連絡漏れが多い」:
//   慶次 10:28「オススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！／保証会社の件も確認させて頂きますので」→ カレンダーには
//   ブレインの推測（notes "[Brain AIX] action=property_send"・翌日）だけで、保証会社の確認は無かった。
//   𝒮 10:27「改めて管理会社に11月中旬でのご入居が可能か交渉頂きます！！／確認出来次第ご連絡させて頂きます」→ LLM の抽出（save-reply-example）で
//   1件だけ入った（1通に2つの約束があると1つしか拾わない・お客様名が付かない・完了は日付が過ぎたら自動）。
//   → 一次証拠（送信時の記録）から決定論で作る。印は手入力の型（【時間確保】と同じ notes 先頭）に合わせる。
//   【必ず】の行は日付が過ぎても自動で完了にせず、それを履行する送信（物件送付・御見積書送付・確認結果の報告）で完了にする。
import { jstParts } from "./jst-date";
import type { LedgerEntry, LedgerKind } from "./action-ledger";

/** お客様への約束の印（notes の先頭）。この印がある行＝履行するまで消えない */
export const PROMISE_MUST_MARK = "【必ず】";
const pad2 = (n: number) => String(n).padStart(2, "0");

export type PromiseKind = "pickup_declared" | "estimate_declared" | "confirmation_promised";
const PROMISE_SPEC: Record<PromiseKind, { eventType: string; label: (o: { object?: string | null; estimateFor?: string[] }) => string; aix: string; fulfilledBy: LedgerKind }> = {
  pickup_declared: { eventType: "property_send", label: () => "物件ピックアップ送付", aix: "物件ピックアップした（または 物件オススメ）", fulfilledBy: "properties_sent" },
  estimate_declared: { eventType: "estimate_sheet", label: (o) => o.estimateFor?.length ? `御見積書送付（${o.estimateFor.slice(0, 2).join("・")}${o.estimateFor.length > 2 ? " 他" : ""}）` : "御見積書送付", aix: "見積書送る", fulfilledBy: "estimate_sent" },
  confirmation_promised: { eventType: "follow_up", label: (o) => `${o.object ?? "確認事項"}の確認→ご連絡`, aix: "物件確認した（確認結果を送る）", fulfilledBy: "confirmation_reported" },
};
export const PROMISE_KINDS = Object.keys(PROMISE_SPEC) as PromiseKind[];
/** 外の出来事待ち（新着・募集が出次第）＝期日の無い約束。send-line-message の line_tasks と同じ除外 */
const EXTERNAL_WAIT_RE = /(?:新着|募集|出|見つかり)(?:が)?(?:出)?次第/;
/** 履行する done の種類 → 完了にする約束の種類 */
const FULFILLS_PROMISE: Partial<Record<LedgerKind, PromiseKind>> = {
  properties_sent: "pickup_declared",
  estimate_sent: "estimate_declared",
  confirmation_reported: "confirmation_promised",
};

export function isPromiseKind(kind: string): kind is PromiseKind {
  return kind in PROMISE_SPEC;
}
/** 約束の行か（notes の先頭が【必ず】） */
export function isPromiseMustNotes(notes: string | null | undefined): boolean {
  return (notes ?? "").trimStart().startsWith(PROMISE_MUST_MARK);
}
/** 約束の行の notes の1行目（【必ず】＋要件）。同じ要件の未完了の行があれば二重に作らない */
export function promiseHeadline(kind: PromiseKind, detail: { object?: string | null; estimateFor?: string[] } = {}): string {
  return `${PROMISE_MUST_MARK}${PROMISE_SPEC[kind].label(detail)}`;
}
function jstLabel(iso: string): string {
  const p = jstParts(iso);
  return `${p.m}/${p.d} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export type PromiseEventRow = {
  title: string; event_type: string; customer_name: string | null; conversation_id: string;
  start_at: string; all_day: boolean; notes: string;
};

/**
 * 送信時の記録（1通分の分類）から、カレンダーに置く約束の行を作る。
 *   title: 「〇〇 物件ピックアップ送付」「〇〇 保証会社の確認→ご連絡」（手入力と同じ「お客様名 要件」）
 *   notes: 1行目【必ず】要件／約束した文／押す AIX／いつの送信か
 *   start_at: 約束した日（その日のうちにやること＝「今日約束した事」）
 */
export function promiseEventRows(
  entries: ReadonlyArray<Pick<LedgerEntry, "kind" | "status" | "evidence" | "detail">>,
  o: { customerName: string | null | undefined; conversationId: string; sentAt: string },
): PromiseEventRow[] {
  const name = (o.customerName ?? "").trim();
  const out: PromiseEventRow[] = [];
  for (const e of entries) {
    if (e.status !== "promised" || !isPromiseKind(e.kind)) continue;
    // 竹内の既存方針（line_tasks と同じ）: 「新着が出次第お送り」は外の出来事待ちで、いつ届けるか決まっていない＝やることにしない
    if (e.kind === "pickup_declared" && EXTERNAL_WAIT_RE.test(e.evidence ?? "")) continue;
    const detail = { object: e.detail?.object ?? null, estimateFor: e.detail?.estimateFor ?? [] };
    const head = promiseHeadline(e.kind, detail);
    if (out.some((r) => r.notes.split("\n")[0] === head)) continue;
    const label = head.slice(PROMISE_MUST_MARK.length);
    out.push({
      title: name ? `${name} ${label}` : label,
      event_type: PROMISE_SPEC[e.kind].eventType,
      customer_name: name || null,
      conversation_id: o.conversationId,
      start_at: o.sentAt,
      all_day: true,
      notes: [
        head,
        `約束: 「${(e.evidence ?? "").trim()}」`,
        `AIX: 【${PROMISE_SPEC[e.kind].aix}】を送ったら完了`,
        `（${jstLabel(o.sentAt)} の送信から）`,
      ].join("\n"),
    });
  }
  return out;
}

/**
 * 既にある未完了の約束の行と比べて、新しく作る行だけを返す（同じ会話・同じ要件の未完了があれば作らない）
 */
export function planPromiseInsert(
  rows: PromiseEventRow[],
  existingOpen: ReadonlyArray<{ id: number; notes: string | null; is_done?: boolean | null }>,
): PromiseEventRow[] {
  const openHeads = new Set(existingOpen.filter((r) => !r.is_done && isPromiseMustNotes(r.notes)).map((r) => (r.notes ?? "").trimStart().split("\n")[0]));
  return rows.filter((r) => !openHeads.has(r.notes.split("\n")[0]));
}

/** 確認の約束の要件（notes 1行目「【必ず】保証会社の確認→ご連絡」→「保証会社」） */
function confirmObjectOfNotes(notes: string | null | undefined): string | null {
  const head = (notes ?? "").trimStart().split("\n")[0] ?? "";
  const m = head.match(new RegExp(`^${PROMISE_MUST_MARK}(.+?)の確認→ご連絡$`));
  return m ? m[1] : null;
}
/** 募集状況・空室・番手・管理会社の確認は、物件や御見積書を送れば答えたことになる（確認結果は物件・見積に含まれる） */
const CONFIRM_ANSWERED_BY_DELIVERY_RE = /募集状況|空室|空き|番手|管理会社|初期費用|割引|入居可能日|入居可否|確認事項/;

/**
 * 履行した送信で完了にする約束の行の id（決定論）。
 *   物件送付 → ピックアップの約束（＋募集状況・空室・番手・管理会社 等の確認の約束）
 *   御見積書送付 → 御見積書の約束（＋同上の確認の約束）
 *   確認結果の報告 → 確認の約束（報告に対象があり行にも対象があれば一致する行だけ。無ければ全部）
 *   保証会社の案内 → 保証会社の確認の約束だけ
 *   批評（Fable5・2026-09-16）: 種類一致だけだと「確認します」と言って物件・見積書で答えた分（14日で 40件中 12件）が
 *   偽の連絡漏れとして残る（morning-report の line_tasks 放置40件と同じ状態になる）
 */
export function planPromiseCompletion(
  done: ReadonlyArray<{ kind: LedgerKind; object?: string | null }>,
  existingOpen: ReadonlyArray<{ id: number; event_type: string | null; notes: string | null; is_done?: boolean | null }>,
): number[] {
  const ids = new Set<number>();
  const open = existingOpen.filter((r) => !r.is_done && isPromiseMustNotes(r.notes) && !!r.event_type);
  for (const d of done) {
    const k = FULFILLS_PROMISE[d.kind];
    for (const r of open) {
      const isConfirm = r.event_type === PROMISE_SPEC.confirmation_promised.eventType;
      const obj = isConfirm ? confirmObjectOfNotes(r.notes) : null;
      if (k && r.event_type === PROMISE_SPEC[k].eventType) {
        // 確認結果の報告に対象があり、行にも対象があれば一致する行だけ
        if (k === "confirmation_promised" && d.object && obj && !obj.includes(d.object) && !d.object.includes(obj)) continue;
        ids.add(r.id);
        continue;
      }
      if (isConfirm && (d.kind === "properties_sent" || d.kind === "estimate_sent") && (!obj || CONFIRM_ANSWERED_BY_DELIVERY_RE.test(obj))) ids.add(r.id);
      if (isConfirm && d.kind === "guarantor_explained" && obj && /保証会社|審査/.test(obj)) ids.add(r.id);
    }
  }
  return [...ids];
}
