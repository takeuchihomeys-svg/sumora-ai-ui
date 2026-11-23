// app/lib/situation-now.ts — 今の状況の記録（meta.situation_now）を1つに組む（純関数・DB/LLM なし・既定 off）
//
// 2026-11-15 作業員L（竹内さん 11/15「状況理解の部分もこのように強化すればより強くなる」・統括役の決め: 欄の名前 timeline・sent・checked・our_items・
//   promises_open・asks・this_turn・conflicts と src・sure）。全体の統括・統括・書き手・AIX・最終チェックが同じ記録を読む元。
//   作り直さない物: 時系列＝situation-timeline.ts／前に送った文の項目＝exchange-ledger（our-part-types）／要件＝作業員M の ask-ledger
//   （askIdOf・progressAfterSends・openAsksFrom）／約束の結び付け＝promise-close-link（detail.closed_by）／食い違い＝material-clash。
//   作業員I の next_send は our_items の item_id を指して読む（「前のどの通のどの項目を受けて次を送るか」）。
// スイッチ BRAIN_SITUATION_NOW（11/18 から既定 shadow＝記録だけ・止める =off）。プロンプトに1文字も足さない＝道・材料・下書きは変えない（書き手に渡すのは試験の後に決める）。
//   試験 L1118-sitnow（q091 q092 q013・ASK_LEDGER=shadow）で欄が入る事を確かめた。要件・送った所まで（asks・this_turn）は ASK_LEDGER が off でない時だけ入る。
import type { TimelineRecord } from "./situation-timeline";
import type { ExchangeLedger } from "./exchange-ledger";
import type { MaterialClash } from "./material-clash";
import { PROMISE_OF_DONE } from "./promise-close-link";
import { jstMD } from "./jst-date";

type Env = Record<string, string | undefined>;
/** off / shadow（既定・記録だけ）/ on（今は shadow と同じ＝記録だけ。書き手・AIX に渡す形は試験の後に作る） */
export const situationNowOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_SITUATION_NOW ?? "shadow").trim().toLowerCase() !== "off";

export type Src = "db" | "text" | "brain";
export type Sure = "high" | "mid" | "low";
export type SnSent = { sent_id: string; at: string; kind: string; aix: string | null; check_pattern: string | null; props: string[]; line_message_id: string | null; answers_ask: string[]; src: Src; sure: Sure };
export type SnChecked = { check_id: string; at: string; what: string; props: string[]; result: string[]; told: boolean; src: Src; sure: Sure };
export type SnOurItem = { item_id: string; at: string; kind: string; label: string; text: string; expect: string; answered: boolean | null; ask_id: string | null; src: Src; sure: Sure };
export type SnPromise = { promise_id: string; kind: string; object: string | null; at: string; due_h: number | null; closed_by: unknown; src: Src; sure: Sure };
export type SituationNow = {
  v: 1;
  timeline?: { words: Array<{ word: string; said: string; from: string | null; to: string | null; label: string }>; viewings: Array<{ at: string; type: string; done: boolean }>; promises: Array<{ at: string; type: string }> };
  sent?: SnSent[];
  checked?: SnChecked[];
  our_items?: SnOurItem[];
  promises_open?: SnPromise[];
  asks?: { done: string[]; promised: string[]; open: string[] };
  this_turn?: { sent_up_to: number; remaining: Array<{ no: number; slot: string; aix: string | null }> };
  conflicts?: Array<{ kind: string; a_id: string; b_id: string; why: string }>;
};

export type FactIn = { sent_at: string; origin: string; aix_type?: string | null; kind: string; status: string; line_message_id?: string | null; detail?: Record<string, unknown> | null };
export type AixIn = { aix_type: string | null; line_message_id?: string | null; sent_at?: string | null; created_at: string; check_pattern?: string | null; property_names?: string[] | null; prop_statuses?: string[] | null; estimate_sent?: boolean | null };

/** sent_facts の行の id（表の一意の鍵 conversation_id,sent_at,origin,kind と同じ形・会話の中で一意） */
export const factIdOf = (f: Pick<FactIn, "sent_at" | "origin" | "kind">) => `sf:${f.sent_at}|${f.origin}|${f.kind}`;
export const aixIdOf = (a: Pick<AixIn, "line_message_id" | "sent_at" | "created_at" | "aix_type">) => `aix:${a.line_message_id ?? `${a.sent_at ?? a.created_at}|${a.aix_type ?? ""}`}`;
const names = (d: Record<string, unknown> | null | undefined) => [...((d?.propertyNames as string[] | undefined) ?? []), ...((d?.estimateFor as string[] | undefined) ?? [])].map((x) => String(x).slice(0, 30)).slice(0, 8);
const SENT_KINDS = new Set(["properties_sent", "estimate_sent", "media_sent", "meeting_place_sent", "viewing_invited", "application_guided", "cost_explained", "cost_breakdown_explained", "guarantor_explained"]);
const CHECK_WHAT: Record<string, string> = { availability: "vacancy", available: "vacancy", mgmt_initial_cost: "initial_cost", mgmt_move_in: "move_in", mgmt_viewing: "viewing_ok", interior_photo: "interior_photo" };

export type SituationInput = {
  timeline?: TimelineRecord | null;
  facts?: ReadonlyArray<FactIn>;
  aix?: ReadonlyArray<AixIn>;
  exchange?: ExchangeLedger | null;
  /** 作業員M の要件の帳面から（askIdOf の id）。progress は progressAfterSends の結果 */
  asks?: { items: ReadonlyArray<{ id: string; quote: string }>; progress: { sentUpTo: number; answered: string[]; promised: string[]; remaining: string[] } | null; msgs: ReadonlyArray<{ no: number; slot: string; aix: string | null }> } | null;
  askIdOf?: (quote: string) => string;
  clash?: MaterialClash | null;
  nowMs: number;
};

export function buildSituationNow(i: SituationInput): SituationNow {
  const out: SituationNow = { v: 1 };
  if (i.timeline) {
    out.timeline = {
      words: i.timeline.words.map((w) => ({ word: w.word, said: new Date(w.saidAtMs).toISOString(), from: w.fromMs ? new Date(w.fromMs).toISOString() : null, to: w.toMs ? new Date(w.toMs).toISOString() : null, label: w.label })),
      viewings: i.timeline.viewings.map((v) => ({ at: new Date(v.atMs).toISOString(), type: v.type, done: v.done })),
      promises: i.timeline.promises.filter((p) => !p.done).map((p) => ({ at: new Date(p.atMs).toISOString(), type: p.type })),
    };
  }
  const facts = [...(i.facts ?? [])].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  // 送った事（行動台帳の済みの行・新しい12件）
  out.sent = facts.filter((f) => f.status === "done" && SENT_KINDS.has(f.kind)).slice(-12).map((f) => ({
    sent_id: factIdOf(f), at: f.sent_at, kind: f.kind, aix: f.aix_type ?? null, check_pattern: (f.detail?.checkPattern as string | undefined) ?? null, props: names(f.detail),
    line_message_id: f.line_message_id ?? null, answers_ask: [], src: "db" as Src, sure: (f.origin === "aix" ? "high" : "mid") as Sure,
  }));
  // 確認した事（物件確認した の AIX・新しい8件）。told＝送った（AIX はお客様に送った物）
  out.checked = (i.aix ?? []).filter((a) => a.aix_type === "property_check_result").sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at)).slice(-8).map((a) => ({
    check_id: aixIdOf(a), at: a.sent_at ?? a.created_at, what: CHECK_WHAT[String(a.check_pattern ?? "")] ?? String(a.check_pattern ?? "vacancy"), props: (a.property_names ?? []).slice(0, 8),
    result: (a.prop_statuses ?? []).slice(0, 8), told: !!a.sent_at, src: "db" as Src, sure: "high" as Sure,
  }));
  // 前に送った文の項目（exchange-ledger の our-part-types と答えたか）
  if (i.exchange) {
    const openAt = new Set(i.exchange.open.filter((o) => o.kind === "our_question_unanswered" || o.kind === "our_promise_unkept" || o.kind === "property_no_reaction").map((o) => o.at));
    const askIds = (i.asks?.items ?? []);
    out.our_items = i.exchange.ours.map((p, n) => {
      const ask = p.kind === "fact" || p.kind === "aix" ? askIds.find((a) => a.quote && p.text && (p.text.includes(a.quote.slice(0, 8)) || a.quote.includes(p.text.slice(0, 8)))) : undefined;
      return {
        item_id: `${p.at}#${n}`, at: p.at, kind: p.kind, label: p.label, text: p.text.slice(0, 60), expect: p.expect,
        answered: p.kind === "question" || p.kind === "promise" || p.kind === "property" || p.kind === "aix" ? !openAt.has(p.at) : null,
        ask_id: ask ? ask.id : null, src: "text" as Src, sure: "mid" as Sure,
      };
    });
  }
  // 開いている約束（行動台帳の約束の行で closed_by が無く、後に同じ種類の済みも無い物）
  const doneKinds = (k: string) => Object.entries(PROMISE_OF_DONE).find(([, p]) => p === k)?.[0];
  out.promises_open = facts.filter((f) => f.status === "promised" && doneKinds(f.kind)).filter((f) => !(f.detail as { closed_by?: unknown } | null)?.closed_by)
    .filter((f) => !facts.some((d) => d.status === "done" && d.kind === doneKinds(f.kind) && d.sent_at > f.sent_at))
    .map((f) => ({ promise_id: factIdOf(f), kind: f.kind, object: (f.detail?.object as string | undefined) ?? null, at: f.sent_at, due_h: Math.round((i.nowMs - Date.parse(f.sent_at)) / 36e5), closed_by: null, src: "db" as Src, sure: "mid" as Sure }));
  // 要件（作業員M の帳面そのまま）と、この番で送った所まで・残っている役目
  if (i.asks?.progress) {
    out.asks = { done: i.asks.progress.answered, promised: i.asks.progress.promised, open: i.asks.progress.remaining };
    out.this_turn = { sent_up_to: i.asks.progress.sentUpTo, remaining: i.asks.msgs.filter((m) => m.no > i.asks!.progress!.sentUpTo).map((m) => ({ no: m.no, slot: m.slot, aix: m.aix })) };
  }
  // 食い違い（材料の塊どうし）
  if (i.clash) out.conflicts = i.clash.opposed.filter((o) => o.level === "yes").map((o): { kind: string; a_id: string; b_id: string; why: string } => ({ kind: o.kind, a_id: `block:${o.a}`, b_id: `block:${o.b}`, why: "道について逆を言う材料の塊" }))
    .concat(i.clash.shapeNoRoute.map((s) => ({ kind: "shape_no_route", a_id: `block:${s.block}`, b_id: `block:${s.with[0] ?? ""}`, why: "形だけを並べて道を言わない塊" })));
  return out;
}

/** digest に残す短い形（数だけ） */
export function situationNowDigest(s: unknown): Record<string, number> | null {
  if (!s || typeof s !== "object") return null;
  const x = s as SituationNow;
  const n = (a: unknown[] | undefined) => (Array.isArray(a) ? a.length : 0);
  return { tw: n(x.timeline?.words), tv: n(x.timeline?.viewings), se: n(x.sent), ch: n(x.checked), oi: n(x.our_items), ou: (x.our_items ?? []).filter((o) => o.answered === false).length, po: n(x.promises_open), ao: n(x.asks?.open), cf: n(x.conflicts) };
}

// ── 2026-11-18 作業員L（統括役「状況の把握が統括と書き手の文に実際に届いて使われているか」）: 書き手に渡す1つの塊 ──────────────
//   今の書き手（generate-reply）が受け取る状況: 行動台帳の注記（送った・約束）・内覧の報告・送った物件は募集中を確認済み（SENT_CONFIRMED_NOTE）。
//   届いていない: ①お客様の時の言葉を言った日で直した日付（時系列の帳面はブレインの材料だけ）②これからの内覧（カレンダーの時刻がある予定・道順の質問の時だけ viewing_history）
//   ③開いている約束がいつから開いているか ④確かめた結果（いつ・どの物件・どうだった）。下書きの「〇日にお伝えした」「先日お送りした」「来週の内覧」が材料なしで書かれる元。
//   SITUATION_WRITER_NOTE=on（既定 off）の時だけ、meta.situation_now から事実だけの塊を作る（道の言葉は書かない・読み方の決まりも足さない）。
export const situationWriterNoteOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.SITUATION_WRITER_NOTE ?? "on").trim().toLowerCase() !== "off";
// 2026-11-18 作業員L: 試験 L1118-wsit-off → L1118-wsit-on（10問・2回・下書きまで・DeepSeek）で悪くなった問題 0・下書きの道 14/20→15/20・下書きの合格 10/20→12/20・依頼 14/24→16/24 ＝既定 on（戻す =off）
const STATUS_JA: Record<string, string> = { available: "募集中", open: "募集中", closed: "募集終了", ended: "募集終了", move_out_planned: "退去予定", applied: "申込あり", occupied: "入居中" };
/**
 * 2026-11-23 作業員L（台帳 #7・統括役の頼み）: 時系列の帳面の欄のうち、カレンダーの終日の予定（約束と連絡の日＝timeline.promises）は
 *   ブレインの材料（timelineBlock）には出るが、書き手への注記（この関数）には出ていなかった（72時間で数えた・scripts/audit-timeline-delivery.ts）。
 *   SITUATION_WRITER_TIMELINE_PROMISES=on（既定 off）の時だけ、今日以降の済みでない予定を3件まで足す（off は今と1文字も変わらない）
 */
export const situationWriterTimelinePromisesOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.SITUATION_WRITER_TIMELINE_PROMISES ?? "").trim().toLowerCase() === "on";
const TL_TYPE_JA: Record<string, string> = { property_send: "物件の送付", follow_up: "追いかけの連絡", estimate_sheet: "御見積書", phone: "電話", viewing: "内覧の調整", application: "申込", photo: "写真", other: "連絡" };
export function situationWriterNote(sn: unknown, nowMs: number, env?: Env): string {
  if (!sn || typeof sn !== "object") return "";
  const s = sn as SituationNow;
  const lines: string[] = [];
  for (const w of (s.timeline?.words ?? []).slice(-3)) lines.push(`- お客様の「${w.word}」（${jstMD(w.said)}に言った）＝${w.label}`);
  for (const v of (s.timeline?.viewings ?? []).filter((x) => !x.done && Date.parse(x.at) >= nowMs - 12 * 36e5).slice(0, 3)) {
    const d = new Date(Date.parse(v.at) + 9 * 36e5);
    lines.push(`- これからの内覧の予定: ${jstMD(v.at)} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`);
  }
  if (situationWriterTimelinePromisesOn(env)) {
    const dayStart = Date.parse(new Date(nowMs + 9 * 36e5).toISOString().slice(0, 10) + "T00:00:00+09:00");
    for (const p of (s.timeline?.promises ?? []).filter((x) => Date.parse(x.at) >= dayStart).slice(0, 3)) lines.push(`- カレンダーの約束と連絡の日: ${jstMD(p.at)}（${TL_TYPE_JA[p.type] ?? p.type}）`);
  }
  for (const p of (s.promises_open ?? []).slice(0, 3)) lines.push(`- 開いているこちらの約束: ${p.kind === "confirmation_promised" ? `確認${p.object ? `（${p.object}）` : ""}` : p.kind === "pickup_declared" ? "物件のピックアップ" : p.kind === "estimate_declared" ? "御見積書" : p.kind}・${jstMD(p.at)}にした約束（まだ果たしていない）`);
  for (const c of (s.checked ?? []).slice(-3)) if (c.props.length) lines.push(`- 確かめた結果（${jstMD(c.at)}にお送り済み）: ${c.props.slice(0, 3).join("・")}${c.result.length ? `＝${c.result.slice(0, 3).map((r) => STATUS_JA[r] ?? r).join("・")}` : ""}`);
  return lines.length ? `\n\n【今の状況（記録・日本時間・事実だけ）】\n${lines.join("\n")}` : "";
}
