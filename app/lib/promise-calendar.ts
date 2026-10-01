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
import { isConfirmPartyObject, confirmTopicForCheckPattern, type LedgerEntry, type LedgerKind } from "./action-ledger";
// 2026-10-01 竹内（和樹事例）「『引き続き新着で…お送り』は『新着が出たら送る』約束として扱う」: ピックアップの約束がいつやる約束か（promise-timing.ts）
import { classifyPickupPromiseTiming, isWaitPromiseNotes, PICKUP_TIMING_LABEL, WAIT_TIMINGS, type PickupPromiseTiming } from "./promise-timing";

/** お客様への約束の印（notes の先頭）。この印がある行＝履行するまで消えない */
export const PROMISE_MUST_MARK = "【必ず】";
const pad2 = (n: number) => String(n).padStart(2, "0");

export type PromiseKind = "pickup_declared" | "estimate_declared" | "confirmation_promised";
/**
 * その日のうちにやる約束（こちらの作業だけで完結し、送れば決まる）。
 * 2026-09-16 竹内（Hina 事例）「このように物件送ったら決まる場合は今日中のタスクなので【今日中】とつけてカレンダーに予定を入れる」。
 * 確認の約束は管理会社の回答待ちで当日とは限らないので付けない（実データ: 「明日管理会社に確認」の例が複数）
 */
const TODAY_KINDS: ReadonlySet<string> = new Set(["pickup_declared", "estimate_declared"]);
/** 今日中の印（カレンダーの行の頭） */
export const TODAY_MARK = "【今日中】";
/**
 * 確認の要件が「条件・交渉」（管理会社への確認結果を AIX【確認した（条件・交渉）】で送る種類）。
 * 2026-09-16 竹内（𝒮❦ 事例）: 入居時期の交渉の約束に「物件確認した（募集状況）」を案内していた（実データ: 入居時期の約束の後に
 * 募集状況の AIX が押された例は無い）。募集状況・空室・番手は従来どおり【物件確認した】
 */
const CONDITION_TOPIC_RE = /入居時期|初期費用|退去時費用|保証会社|代理契約|ペット|駐車場|設備|退去|審査|内覧可否/;
function confirmAixLabel(object: string | null | undefined): string {
  const o = (object ?? "").trim();
  return o && CONDITION_TOPIC_RE.test(o) ? `確認した（条件・交渉）→${o}` : "物件確認した（確認結果を送る）";
}
type PromiseDetail = { object?: string | null; estimateFor?: string[]; timing?: PickupPromiseTiming };
const PROMISE_SPEC: Record<PromiseKind, { eventType: string; label: (o: PromiseDetail) => string; aix: (o: { object?: string | null }) => string; fulfilledBy: LedgerKind }> = {
  // 2026-10-01: 待ちの約束は「新着が出たら物件送付【新着待ち】」等（promise-timing.PICKUP_TIMING_LABEL）。今日・日付は従来の「物件ピックアップ送付」
  pickup_declared: { eventType: "property_send", label: (o) => { const t = PICKUP_TIMING_LABEL[o.timing ?? "today"]; return `${t.label}${t.mark}`; }, aix: () => "物件ピックアップした（または 物件オススメ）", fulfilledBy: "properties_sent" },
  estimate_declared: { eventType: "estimate_sheet", label: (o) => o.estimateFor?.length ? `御見積書送付（${o.estimateFor.slice(0, 2).join("・")}${o.estimateFor.length > 2 ? " 他" : ""}）` : "御見積書送付", aix: () => "見積書送る", fulfilledBy: "estimate_sent" },
  confirmation_promised: { eventType: "follow_up", label: (o) => `${o.object ?? "確認事項"}の確認→ご連絡`, aix: (o) => confirmAixLabel(o.object), fulfilledBy: "confirmation_reported" },
};
export const PROMISE_KINDS = Object.keys(PROMISE_SPEC) as PromiseKind[];
/** 会話画面の【必ず】からそのまま開く AIX（event_type → AIX の action キー） */
export function promiseAixActionOf(eventType: string | null | undefined): "property_check_result" | "property_send" | "estimate_sheet" | null {
  switch (eventType) {
    case "follow_up": return "property_check_result";
    case "property_send": return "property_send";
    case "estimate_sheet": return "estimate_sheet";
    default: return null;
  }
}
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
export function promiseHeadline(kind: PromiseKind, detail: PromiseDetail = {}): string {
  return `${PROMISE_MUST_MARK}${PROMISE_SPEC[kind].label(detail)}`;
}
function jstLabel(iso: string): string {
  const p = jstParts(iso);
  return `${p.m}/${p.d} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 明日やる約束（「明日確認して連絡」「翌営業日」）。管理会社の営業時間外に約束した時の型 */
const TOMORROW_PROMISE_RE = /明日|翌営業日|朝イチ|朝一/;
/** 明日の約束をカレンダーに置く時刻（JST の午前中）。竹内「カレンダーには明日連絡午前中に必ず入れる」 */
const TOMORROW_PROMISE_HOUR = 10;
/**
 * 約束の行をカレンダーのいつに置くか。
 *   ふつうは約束した日（今日のうちにやること）。「明日確認してご連絡」と言った約束だけ翌日の午前中に置く
 *   （2026-09-16 竹内・💜 さん事例。19:20 に「明日〜確認出来次第ご連絡」と約束した行が 19:20 に立ち、
 *    その日の一覧の夜に埋もれていた＝翌朝やることが翌朝の場所に無かった）
 */
export function promiseStartAt(sentAt: string, sentence: string | null | undefined): string {
  if (!TOMORROW_PROMISE_RE.test(sentence ?? "")) return sentAt;
  const p = jstParts(sentAt);
  if (!Number.isFinite(p.y)) return sentAt;
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + 86_400_000);
  const ymd = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
  return new Date(`${ymd}T${pad2(TOMORROW_PROMISE_HOUR)}:00:00+09:00`).toISOString();
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
    // 2026-10-01 竹内（和樹事例）「『引き続き新着で…お送り』は『新着が出たら送る』約束として扱う形、これはLINEみていてもそうなっている」:
    //   ピックアップの約束がいつやる約束かを文から決める（promise-timing.classifyPickupPromiseTiming・実送信 979件で引いた線）。
    //   新着待ち・お客様待ち・時期待ちは【今日中】を付けず、見出しを「新着が出たら物件送付【新着待ち】」等にする（期日の無い約束）。
    //   旧: 「新着が出次第」（次第）だけは行を作らず（外の出来事待ち＝やることにしない・line_tasks と同じ）、それ以外は全部【今日中】。
    //   今は次第の約束も【新着待ち】の行にする（約束は消さない・物件を送ったら完了＝同じ property_send・赤帯では「必ず N日」にしない）
    const sentence = e.detail?.sentence ?? e.evidence ?? "";
    const timing: PickupPromiseTiming | undefined = e.kind === "pickup_declared" ? classifyPickupPromiseTiming(sentence).timing : undefined;
    const waiting = !!timing && WAIT_TIMINGS.has(timing);
    const detail: PromiseDetail = { object: e.detail?.object ?? null, estimateFor: e.detail?.estimateFor ?? [], timing };
    const head = promiseHeadline(e.kind, detail);
    if (out.some((r) => r.notes.split("\n")[0] === head)) continue;
    // 件名（title）には待ちの印を入れない（「和樹 新着が出たら物件送付」）
    const label = head.slice(PROMISE_MUST_MARK.length).replace(/【[^】]*待ち】$/, "");
    // 物件を送れば決まる約束（ピックアップ・御見積書）は今日中のタスク。カレンダーで一目で分かるよう頭に印を付ける
    //   2026-10-01: 待ちの約束と、日付の語（明日・週明け）がある約束には付けない（明日の約束に【今日中】が付いていた 𝑛𝑎 id 919）
    const today = TODAY_KINDS.has(e.kind) && !waiting && timing !== "date" ? TODAY_MARK : "";
    // 「明日確認してご連絡」と約束した分は翌日の午前中に置く（営業時間外の約束が当日の夜に埋もれない）。待ちの約束は約束した時のまま
    const startAt = waiting ? o.sentAt : promiseStartAt(o.sentAt, sentence);
    out.push({
      title: `${today}${name ? `${name} ${label}` : label}`,
      event_type: PROMISE_SPEC[e.kind].eventType,
      customer_name: name || null,
      conversation_id: o.conversationId,
      start_at: startAt,
      all_day: true,
      notes: [
        today ? `${head}${TODAY_MARK}` : head,
        // 約束の文（何を確認するか）。旧: 正規表現の一致部分「確認出来次第」の6文字だけで中身が読めなかった（𝒮❦ 事例）
        `約束: 「${(e.detail?.sentence ?? e.evidence ?? "").trim()}」`,
        `AIX: 【${PROMISE_SPEC[e.kind].aix(detail)}】を送ったら完了`,
        `（${jstLabel(o.sentAt)} の送信から）`,
      ].join("\n"),
    });
  }
  return out;
}

/**
 * 既にある未完了の約束の行と比べて、新しく作る行だけを返す（同じ会話・同じ要件の未完了があれば作らない）
 */
/** 同じ約束かを比べるための見出し（【今日中】の印は比べない＝印を足す前に作った行と二重にならない） */
function headlineOf(notes: string | null | undefined): string {
  return ((notes ?? "").trimStart().split("\n")[0] ?? "").split(TODAY_MARK).join("");
}

export function planPromiseInsert(
  rows: PromiseEventRow[],
  existingOpen: ReadonlyArray<{ id: number; notes: string | null; is_done?: boolean | null }>,
): PromiseEventRow[] {
  const openHeads = new Set(existingOpen.filter((r) => !r.is_done && isPromiseMustNotes(r.notes)).map((r) => headlineOf(r.notes)));
  return rows.filter((r) => !openHeads.has(headlineOf(r.notes)));
}

// ── 一覧の並び（2026-09-18 竹内「必ずのお客さんはLINEの上に上がるようにする。忘れないようにする為」）──
// 【必ず】は会話画面の赤帯と一覧のバッジには出ていたが、一覧は直近やり取り順だったため、
// 返事が来ていない約束ほど下に沈んでいた（新しいやり取りが上に積まれる＝放置が長いほど見えない）。
// バッジの経過日数と並びは同じ関数から作る（表示と並びが食い違わない）。

/** 一覧の並び・バッジが見る、その会話の未履行の約束（カレンダーの行の一部だけ） */
export type OpenPromiseRef = { start_at: string; notes?: string | null };

/** その会話の一番古い未履行の約束の時刻（ms）。約束が無ければ null */
export function oldestPromiseAtMs(promises: ReadonlyArray<OpenPromiseRef> | null | undefined): number | null {
  let oldest: number | null = null;
  for (const p of promises ?? []) {
    // 2026-10-01: 新着待ち・お客様待ち・時期待ちの約束は期日が無い＝経過日数（「🔴必ず N日」）に数えない（和樹 id 951 の形）
    if (isWaitPromiseNotes(p?.notes)) continue;
    const t = Date.parse(p?.start_at ?? "");
    if (!Number.isFinite(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest;
}

/** 一覧のバッジに出す経過日数（一番古い約束から）。約束が無ければ null */
export function promiseOverdueDays(
  promises: ReadonlyArray<OpenPromiseRef> | null | undefined,
  nowMs: number,
): number | null {
  const oldest = oldestPromiseAtMs(promises);
  if (oldest === null) return null;
  return Math.max(0, Math.floor((nowMs - oldest) / 86_400_000));
}

// ── お客様の今の依頼が約束より新しい時の並び（2026-10-01 竹内・和樹事例）──
// 「ここは物件確認したから送る形なので、そのようにする」: 9/30 の約束「引き続き新着でオススメできるお部屋ピックアップしお送り」の
//   【必ず】物件ピックアップ送付 が、10/1 12:45 にお客様が送った SUUMO の物件（「ここはどうでしょうか？」）より上に赤帯で出ていた。
//   実送信（scripts/audit-customer-property-inquiry.ts・7/17〜）: ピックアップの約束が未履行のままお客様がポータルの URL を送ってきた回で、
//   次に押された AIX は 物件確認した 24・見積書送る 6・物件ピックアップ 1（31回中30回がお客様の物件が先）。
//   → ブレインが今のお客様の発言に 物件確認した／見積書送る（お客様の物件の確認・見積）を判断した時は、それより前の物件ピックアップの約束を
//     「後で」に回す（消さない・完了にしない。確認を送った後もピックアップを送るまで残る）。AIX の種類はブレインの判断のまま（画面は並べ替えるだけ）

/** お客様の物件の確認・見積の AIX（この判断が今の発言に出ている間は、ピックアップの約束より先にやる） */
const INQUIRY_FIRST_ACTIONS: ReadonlySet<string> = new Set(["property_check_result", "estimate_sheet", "acknowledge_check"]);

/**
 * 未履行の約束を「今やる」と「後で（お客様の物件の確認の後）」に分ける。
 *   brainAction: 最新のお客様の発言を見たブレインの AIX（aix-button-view の brainAixAction。古い判断は渡さない）
 *   latestCustomerAt: 最新のお客様の発言の時刻
 * 後で になるのは 物件ピックアップの約束（event_type=property_send）で、約束の時刻が最新のお客様の発言より前の物だけ。
 * 確認・見積の約束は今のお客様の依頼と同じ物件のことがあるので並べ替えない。
 */
export function splitPromisesForFreshInquiry<T extends { event_type: string | null; start_at: string; notes?: string | null }>(
  promises: ReadonlyArray<T>,
  ctx: { brainAction: string | null | undefined; latestCustomerAt: string | null | undefined },
): { now: T[]; later: T[] } {
  const now: T[] = [], later: T[] = [];
  const custMs = Date.parse(ctx.latestCustomerAt ?? "");
  const inquiry = !!ctx.brainAction && INQUIRY_FIRST_ACTIONS.has(ctx.brainAction) && Number.isFinite(custMs);
  for (const p of promises) {
    const promisedMs = Date.parse(p.start_at);
    // 「明日」の約束は start_at が翌日の午前（promiseStartAt）。後ろにずれた約束も、約束した時（notes の「（M/D HH:MM の送信から）」）より
    // お客様の発言が新しければ同じ扱いにしたいが、start_at が発言より後なら今日やる予定として今のまま出す（取り違えるより安全）
    if (inquiry && p.event_type === PROMISE_SPEC.pickup_declared.eventType && Number.isFinite(promisedMs) && promisedMs < custMs) later.push(p);
    else now.push(p);
  }
  return { now, later };
}

// 並び順そのものは conversation-order.ts（compareConversationOrder）。
// 【必ず】は一覧全体の先頭ではなく「メッセージが来ている組／来ていない組のそれぞれの中」で上に来る
// （2026-09-18 竹内の指摘。ここに並びの規則を2つ置かないよう、この節は約束の材料だけにする）

/** 確認の約束の要件（notes 1行目「【必ず】保証会社の確認→ご連絡」→「保証会社」） */
function confirmObjectOfNotes(notes: string | null | undefined): string | null {
  const head = headlineOf(notes);
  const m = head.match(new RegExp(`^${PROMISE_MUST_MARK}(.+?)の確認→ご連絡$`));
  return m ? m[1] : null;
}
/**
 * 募集状況・空室・番手の確認は、物件や御見積書を送れば答えたことになる（確認結果は物件・見積に含まれる）。
 * 2026-09-16 𝒮❦ 事例: 入居時期・保証会社・退去などの条件・交渉の確認は、別の物件を送っても答えたことにならない（旧: 入居可能日も含めて閉じていた）。
 * 初期費用・割引は御見積書でだけ答えたことになる
 */
const CONFIRM_ANSWERED_BY_PROPERTY_RE = /募集状況|空室|空き|番手/;
const CONFIRM_ANSWERED_BY_ESTIMATE_RE = /募集状況|空室|空き|番手|初期費用|割引/;
/** 約束の要件と報告の要件が同じか（相手だけの要件＝管理会社・確認事項は何にでも当たる） */
function confirmObjectMatches(rowObj: string | null, doneObj: string | null | undefined): boolean {
  const d = (doneObj ?? "").trim();
  if (isConfirmPartyObject(rowObj) || isConfirmPartyObject(d)) return true;
  const r = rowObj as string;
  return r.includes(d) || d.includes(r);
}

/**
 * 履行した送信で完了にする約束の行の id（決定論）。
 *   物件送付 → ピックアップの約束（＋募集状況・空室・番手・中身不明 の確認の約束）
 *   御見積書送付 → 御見積書の約束（＋同上＋初期費用・割引の確認の約束）
 *   確認結果の報告 → 確認の約束（AIX の check_pattern か報告の要件が行の要件と同じ行。相手だけの要件は何にでも一致）
 *   募集終了・別部屋の報告 → 物件名の無い御見積書の約束も閉じる（対象の部屋が無くなった。実データ ev520）
 *   保証会社の案内 → 保証会社の確認の約束だけ
 *   批評（Fable5・2026-09-16）: 種類一致だけだと「確認します」と言って物件・見積書で答えた分（14日で 40件中 12件）が
 *   偽の連絡漏れとして残る。逆に 2026-09-16 𝒮❦ 事例: 要件の1語一致だと「オーナー様に確認したところ」の報告で閉じず、
 *   別物件の送付で閉じていた（相手の語を照合に使わない・条件の確認は送付で閉じない）
 */
export function planPromiseCompletion(
  done: ReadonlyArray<{ kind: LedgerKind; object?: string | null; checkPattern?: string | null }>,
  existingOpen: ReadonlyArray<{ id: number; event_type: string | null; notes: string | null; is_done?: boolean | null }>,
): number[] {
  const ids = new Set<number>();
  const open = existingOpen.filter((r) => !r.is_done && isPromiseMustNotes(r.notes) && !!r.event_type);
  for (const d of done) {
    const k = FULFILLS_PROMISE[d.kind];
    const patternTopic = confirmTopicForCheckPattern(d.checkPattern);
    for (const r of open) {
      const isConfirm = r.event_type === PROMISE_SPEC.confirmation_promised.eventType;
      const obj = isConfirm ? confirmObjectOfNotes(r.notes) : null;
      if (k && r.event_type === PROMISE_SPEC[k].eventType) {
        if (k === "confirmation_promised") {
          // AIX の check_pattern があればそれが報告の要件（本文の先頭語より確か）。無ければ報告の要件で照合
          const doneObj = patternTopic ?? d.object ?? null;
          if (!confirmObjectMatches(obj, doneObj)) continue;
        }
        ids.add(r.id);
        continue;
      }
      if (isConfirm && d.kind === "properties_sent" && (!obj || isConfirmPartyObject(obj) || CONFIRM_ANSWERED_BY_PROPERTY_RE.test(obj))) ids.add(r.id);
      if (isConfirm && d.kind === "estimate_sent" && (!obj || isConfirmPartyObject(obj) || CONFIRM_ANSWERED_BY_ESTIMATE_RE.test(obj))) ids.add(r.id);
      if (isConfirm && d.kind === "guarantor_explained" && obj && /保証会社|審査/.test(obj)) ids.add(r.id);
      // 募集終了・別のお部屋の報告: 対象の部屋が無くなったので、物件名を持たない御見積書の約束は閉じる
      if (r.event_type === PROMISE_SPEC.estimate_declared.eventType && d.kind === "confirmation_reported"
        && (d.checkPattern === "unavailable" || d.checkPattern === "alternative") && !headlineOf(r.notes).includes("（")) ids.add(r.id);
    }
  }
  return [...ids];
}
