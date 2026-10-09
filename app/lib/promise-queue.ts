// app/lib/promise-queue.ts — 複数の依頼を「約束した事」ごとに並べ、どの AIX で果たすか・次に送る AIX・取りこぼしを組み立てる（純関数・DB も fetch も持たない）
//
// 2026-10-09 竹内さん「複数の依頼が重なる番は、ちゃんと返信して約束してから AIX をセットしたらどうか。複数の依頼を読み込めているのか。
//   読み込んで約束して、約束した事を記録して、それを AIX で送っていけば完全にできる」。
//
// 今ある物との分け方（重ねない）:
//   ・request-ledger … お客様の連投の依頼を1つずつ（読む側）。ここは「こちらが約束した事」（書く側）を1つずつ
//   ・action-ledger／sent_facts … 送った通ごとの約束（estimate_declared・pickup_declared・confirmation_promised）。1通に複数の約束があっても
//     種類ごとに1行ずつ記録済み＝「約束した事の記録」はもうある。足りなかったのは ①どの AIX で果たすか ②1つ果たした後の「次の AIX」
//   ・aix-task-link.resolveStaffPromiseAix … 最後の約束から AIX を1つだけ選ぶ（確認・見積を先に）。AIX を1本送ると要対応は済みになり、
//     残りの約束の AIX はお客様が次に話すまで立たなかった（log-aix-usage はブレインを回し直さない）
//   → ここで、約束の通（手打ち・下書き・AIX の本文の書き足し）から約束を種類ごとに取り出し、その後の AIX の送信・手打ちの報告で果たしたかを毎回組み立てる（保存しない）。
//     使い道: ①AIX を1本送った後に次の要対応を立てる（promise-queue-server.advancePromiseQueue）②画面「次に送る AIX」と残り ③監査（scripts/audit-multi-request-turns.ts）
//
// 順番（竹内さんの「５それで大丈夫」10/07＝確認・見積を先に／物件の話はその後）: 募集状況の確認 → 条件・設備の確認 → 室内写真 → 見積書 → 内覧の確認 → ピックアップ
// 入れる: PROMISE_QUEUE=on（既定 off・2026-10-09 時点）。on で次の要対応を立てる・画面に出す（画面は NEXT_PUBLIC_PROMISE_QUEUE=on も）
// テスト: app/lib/__tests__/promise-queue.test.ts（実物の約束の文）

import { classifyStaffTextFacts, checkPatternForConfirmTopic } from "./action-ledger";
import { VIEWING_CHECK_PROMISE_RE } from "./viewing-check-first";
import { AIX_BUTTON_LABELS } from "./aix-taxonomy";

export type PromiseKind = "check" | "confirm" | "photo" | "estimate" | "viewing_check" | "pickup";
export type PromiseStep = {
  kind: PromiseKind;
  /** 果たす AIX（ボタン・ピッカー） */
  action: string;
  checkPattern: string | null;
  /** 約束の中身（約束の文の要件・物件名）。分からなければ null */
  object: string | null;
  /** 約束の言葉（40字まで） */
  evidence: string;
  promisedAt: string;
  status: "pending" | "done" | "dropped";
  doneAt: string | null;
  /** 果たした物（"AIX【見積書送る】" 等）・やめた理由（"募集終了"） */
  doneBy: string | null;
  /** 探し続ける約束（「新着出次第お送り」「随時確認し出次第」）＝次の AIX には並べない（いつ果たすかは新着しだい・pending-pickup が持つ） */
  watch?: boolean;
};
export type QueueMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null };
export type QueueAixLog = { aixType: string; checkPattern?: string | null; sentAt: string; estimateSent?: boolean | null; text?: string | null };

export const PROMISE_ORDER: readonly PromiseKind[] = ["check", "confirm", "photo", "estimate", "viewing_check", "pickup"];
export const PROMISE_KIND_JA: Record<PromiseKind, string> = {
  check: "募集状況の確認", confirm: "条件・設備の確認", photo: "室内写真", estimate: "御見積書", viewing_check: "内覧の確認・日程", pickup: "お部屋のピックアップ",
};

export function promiseQueueEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-10-09 本番に入れる前の区切り（竹内さん「本番に入れていく」）: 既定は off・入れる時は PROMISE_QUEUE=on
  return (env.PROMISE_QUEUE ?? "").trim().toLowerCase() === "on";
}

const PHOTO_PROMISE_RE = /(?:室内)?(?:の)?(?:お)?写真[^\n。！!]{0,12}(?:撮影|お撮り)[^\n。！!]{0,12}(?:次第|させて(?:頂|いただ)きます)|撮影(?:出来|でき)次第[^\n。！!]{0,12}(?:お写真|写真|動画)?[^\n。！!]{0,6}お送り/;
/** 「日程調整させて頂き確認後…ご連絡させて頂きます」＝内覧の日程の約束（AIX【内覧日調整】で果たす） */
const VIEWING_SCHEDULE_PROMISE_RE = /(?:日程|お日にち|内覧日|ご内覧)[^\n。！!]{0,10}調整[^\n。！!]{0,24}(?:ご連絡|させて(?:頂|いただ)きます)/;
const EXTRA_ESTIMATE_RE = /御?見積(?:書|もり|り)?[^\n。！!？?]{0,8}(?:し|を)?(?:送らせて|お送り|ご用意|作成)[^\n。！!？?]{0,8}(?:させて(?:頂|いただ)きます|致します|いたします|頂きます)/;
const NEGOTIATE_PROMISE_RE = /交渉[^\n。！!？?]{0,10}(?:させて(?:頂|いただ)きます|致します|いたします)|交渉[^\n。！!？?]{0,20}確認させて(?:頂|いただ)きます/;
const VACANCY_WORD_RE =/募集|空室|空き|お部屋の状況|現況|まだ(?:あり|残)/;
/** 申込の進捗（番手・お部屋止め・審査）の確認は AIX の約束ではない（aix-task-link の APPLY_PROGRESS_CHECK_RE と同じ向き） */
const APPLY_PROGRESS_RE = /番手|お部屋止め|部屋止め|お申込(?:み)?(?:完了|状況)|審査(?:結果|状況)/;

/** 確認の約束を果たす AIX（要件ごと）。要件が分からない募集状況の確認は 物件確認した（ピッカーはスタッフが結果で選ぶ） */
function confirmStep(object: string | null, sentence: string): Pick<PromiseStep, "kind" | "action" | "checkPattern"> {
  if (VIEWING_CHECK_PROMISE_RE.test(sentence)) return { kind: "viewing_check", action: "viewing_invite", checkPattern: null };
  const cp = checkPatternForConfirmTopic(object);
  if (cp && cp !== "mgmt_initial_cost") return { kind: "confirm", action: "property_check_result", checkPattern: cp };
  return { kind: "check", action: "property_check_result", checkPattern: null };
}

/**
 * こちらの1通（手打ち・下書き・AIX の本文）に入っている約束を種類ごとに取り出す（行動台帳の分け方を使う・同じ種類は1つ）。
 *   約束が無ければ []（報告・物件送付だけの通も []）
 */
export function promisesInStaffText(text: string | null | undefined, at: string): PromiseStep[] {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  const out: PromiseStep[] = [];
  const push = (s: Omit<PromiseStep, "promisedAt" | "status" | "doneAt" | "doneBy">) => {
    if (out.some((x) => x.kind === s.kind)) return;
    out.push({ ...s, promisedAt: at, status: "pending", doneAt: null, doneBy: null });
  };
  const sentences = t.split(/\n+|(?<=[。！!？?])/).map((s) => s.trim()).filter(Boolean);
  for (const e of classifyStaffTextFacts(t, at)) {
    if (e.status !== "promised") continue;
    if (e.kind === "estimate_declared") {
      const labels = (e.detail as { estimateFor?: string[] } | undefined)?.estimateFor ?? [];
      push({ kind: "estimate", action: "estimate_sheet", checkPattern: null, object: labels.length ? labels.join("・").slice(0, 40) : null, evidence: e.evidence ?? "" });
    } else if (e.kind === "pickup_declared") {
      const d = (e.detail ?? {}) as { watch?: boolean; sentence?: string | null };
      push({ kind: "pickup", action: "property_send", checkPattern: null, object: null, evidence: e.evidence ?? "", watch: d.watch === true || /新着|随時|出次第|出(?:て|た)?(?:き)?次第|見つかり次第|お部屋探し/.test(`${d.sentence ?? ""} ${e.evidence ?? ""}`) });
    } else if (e.kind === "confirmation_promised") {
      const d = (e.detail ?? {}) as { object?: string | null; sentence?: string | null };
      const sentence = d.sentence ?? sentences.find((s) => (e.evidence ?? "") && s.includes(String(e.evidence).slice(0, 6))) ?? t;
      if (APPLY_PROGRESS_RE.test(`${d.object ?? ""} ${sentence}`)) continue;
      // 「初期費用の確認」で同じ通が御見積書を約束していれば見積の約束（estimate）に任せる
      if (d.object === "初期費用" && /見積/.test(t)) continue;
      const k = confirmStep(d.object ?? null, sentence);
      push({ ...k, object: d.object ?? null, evidence: e.evidence ?? "" });
    }
  }
  // 台帳の確認の約束は1通に1つ（最初の文）。同じ通の別の文の内覧の確認・募集状況の確認・撮影の約束も拾う
  for (const s of sentences) {
    if (VIEWING_CHECK_PROMISE_RE.test(s) || VIEWING_SCHEDULE_PROMISE_RE.test(s)) push({ kind: "viewing_check", action: "viewing_invite", checkPattern: null, object: null, evidence: s.slice(0, 40) });
    else if (VACANCY_WORD_RE.test(s) && /確認[^\n。！!]{0,8}(?:させて(?:頂|いただ)きます|致します|いたします)/.test(s) && !APPLY_PROGRESS_RE.test(s)) {
      push({ kind: "check", action: "property_check_result", checkPattern: null, object: null, evidence: s.slice(0, 40) });
    }
    // 「募集状況と初期費用（まとめて）確認させて頂きます」＝竹内さんの初期費用は最大限割引の御見積書（2段の brought_both と同じ）
    if (/初期費用|御?見積/.test(s) && /確認[^\n。！!]{0,8}(?:させて(?:頂|いただ)きます|致します|いたします)/.test(s) && !/更に|さらに|代表|交渉|割引の?確認/.test(s)) {
      push({ kind: "estimate", action: "estimate_sheet", checkPattern: null, object: null, evidence: s.slice(0, 40) });
    }
    // 台帳が拾わない見積の約束の言い方（実物 288d47「最大限割引しました初期費用御見積し送らせて頂きます」・ac7c7f「最大限割引して御見積書をご用意いたします」）
    if (EXTRA_ESTIMATE_RE.test(s) && !/(?:頂|いただ)けましたら|でしたら|あれば/.test(s)) push({ kind: "estimate", action: "estimate_sheet", checkPattern: null, object: null, evidence: s.slice(0, 40) });
    // 交渉の約束（ae3217「10月末ご入居出来るか…明日管理会社営業次第交渉させて頂きます」・2ae0d9「礼金の交渉…管理会社に確認させて頂きます」）＝ AIX【確認した→管理会社に確認した】
    //   ⚠ 試算（audit-multi-request-turns ⑥）で交渉の約束の次の要対応は 72時間で果たした 7/14 だけ（結果を手打ち・電話で伝える・交渉中が続く）＝画面には出すが次の要対応には並べない（watch）
    if (NEGOTIATE_PROMISE_RE.test(s) && !/代表/.test(s)) push({ kind: "confirm", action: "property_check_result", checkPattern: /入居|日にち|延ば/.test(s) ? "mgmt_move_in" : "mgmt_initial_cost", object: /入居|日にち|延ば/.test(s) ? "入居時期" : "初期費用", evidence: s.slice(0, 40), watch: true });
    // 「お送り頂きましたお部屋全て確認させて頂きます」（d25e07）＝募集状況の確認
    if (/(?:お部屋|物件)[^\n。！!]{0,8}確認させて(?:頂|いただ)きます/.test(s) && !APPLY_PROGRESS_RE.test(s)) push({ kind: "check", action: "property_check_result", checkPattern: null, object: null, evidence: s.slice(0, 40) });
    if (PHOTO_PROMISE_RE.test(s) && !/場合|でしたら|であれば|ご希望/.test(s)) push({ kind: "photo", action: "property_check_result", checkPattern: "interior_photo", object: null, evidence: s.slice(0, 40) });
  }
  return out;
}

/** AIX の送信がその約束を果たしたか */
function aixFulfills(step: PromiseStep, log: QueueAixLog): boolean {
  const a = log.aixType === "property_check" ? "property_check_result" : log.aixType;
  switch (step.kind) {
    // 確認の後で送る見積書・申込へ・内覧調整・待ち合わせは、空いていた（確認した）結果を伝えた送信（試算の外れ f568a1・732692: 「確認させて頂き…御見積書とあわせてご連絡」の後に見積書だけ送った）
    case "check": return a === "property_check_result" || a === "viewing_invite" || a === "estimate_sheet" || a === "application_push" || a === "meeting_place";
    case "confirm": return a === "property_check_result" || a === "acknowledge_check" || a === "guarantor_info" || a === "cost_breakdown";
    case "photo": return a === "property_check_result";
    // 物件の AIX（ピックアップ・オススメ）に御見積書を同封した送信も見積の約束を果たす（試算の外れ 7462e5）
    case "estimate": return a === "estimate_sheet" || ((a === "property_check_result" || a === "property_send" || a === "property_recommendation") && (log.estimateSent === true || /御?見積書|お見積/.test(log.text ?? "")));
    case "viewing_check": return a === "viewing_invite" || a === "meeting_place" || a === "property_check_result";
    case "pickup": return a === "property_send" || a === "property_recommendation" || a === "property_search" || a === "zenryoku_support";
  }
}
/** 手打ち（AIX でない）の通がその約束を果たしたか（台帳の done の行で見る） */
function handFulfills(step: PromiseStep, text: string, at: string): boolean {
  const kinds = new Set(classifyStaffTextFacts(text, at).filter((e) => e.status === "done").map((e) => e.kind));
  switch (step.kind) {
    case "check": case "confirm": case "viewing_check": return kinds.has("confirmation_reported");
    case "estimate": return kinds.has("estimate_sent");
    case "pickup": return kinds.has("properties_sent");
    case "photo": return kinds.has("media_sent");
  }
}
const ENDED_RE = /募集終了|お申込みが入|お申込が入|申込(?:み)?が入っ|成約済|募集(?:を)?(?:停止|止め)|ご紹介(?:出来|でき)ない/;

/**
 * 直近 windowDays 日のこちらの約束を並べ、その後の AIX・手打ちで果たしたかを組み立てる（古い約束から・同じ種類の未果たしの約束は1つにまとめる）。
 *   msgs は会話の通（順不同でよい）・aixLogs は AIX の送信（aix_usage_logs）
 */
export function buildPromiseQueue(msgs: ReadonlyArray<QueueMsg>, aixLogs: ReadonlyArray<QueueAixLog>, nowMs: number, o: { windowDays?: number } = {}): PromiseStep[] {
  const win = (o.windowDays ?? 7) * 86_400_000;
  const sorted = [...msgs].filter((m) => Number.isFinite(Date.parse(m.createdAt)) && Date.parse(m.createdAt) <= nowMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const logs = [...aixLogs].filter((l) => Number.isFinite(Date.parse(l.sentAt))).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const steps: PromiseStep[] = [];
  for (const m of sorted) {
    if (m.sender === "customer") continue;
    const at = m.createdAt;
    const atMs = Date.parse(at);
    const text = String(m.text ?? "");
    // 先に、この通が今までの約束を果たしたか（手打ちの報告・AIX の本文）
    for (const s of steps) {
      if (s.status !== "pending" || atMs <= Date.parse(s.promisedAt)) continue;
      if (!m.isAix && handFulfills(s, text, at)) { s.status = "done"; s.doneAt = at; s.doneBy = "返信"; }
    }
    if (nowMs - atMs > win) continue;
    for (const p of promisesInStaffText(text, at)) {
      if (steps.some((s) => s.status === "pending" && s.kind === p.kind)) continue;
      steps.push(p);
    }
  }
  for (const l of logs) {
    const lMs = Date.parse(l.sentAt);
    // 1本の AIX は1つの約束を果たす（物件確認した＋御見積書同封だけは確認と見積の両方）
    const hit = PROMISE_ORDER.map((k) => steps.find((s) => s.status === "pending" && s.kind === k && lMs > Date.parse(s.promisedAt) - 60_000 && aixFulfills(s, l)))
      .filter((x): x is PromiseStep => !!x);
    if (!hit.length) continue;
    const label = `AIX【${AIX_BUTTON_LABELS[l.aixType] ?? l.aixType}】`;
    const first = hit[0];
    first.status = "done"; first.doneAt = l.sentAt; first.doneBy = label;
    const est = hit.find((s) => s.kind === "estimate" && s !== first);
    if (est && first.kind === "check" && (l.estimateSent === true || /御?見積書|お見積/.test(l.text ?? ""))) { est.status = "done"; est.doneAt = l.sentAt; est.doneBy = label; }
    // 募集状況の確認の結果が募集終了 → 同じ物件の見積・内覧の確認の約束は果たせない（やめた・新しい物件のピックアップは残す）
    if (first.kind === "check" && ENDED_RE.test(l.text ?? "") && !/御?見積書|お見積/.test(l.text ?? "")) {
      for (const s of steps) if (s.status === "pending" && (s.kind === "estimate" || s.kind === "viewing_check")) { s.status = "dropped"; s.doneAt = l.sentAt; s.doneBy = "募集終了"; }
    }
  }
  return steps;
}

/** 次の AIX に並べる約束の古さの上限（竹内さんの番で全部果たすまで中央 32時間・audit-multi-request-turns）。それより古い約束は画面に出すが要対応は立てない */
export const PROMISE_QUEUE_MAX_AGE_MS = 72 * 3600_000;
/** 次に送る AIX と残り（順番どおり）。探し続ける約束・古い約束は入れない。無ければ null */
export function nextPromiseAix(steps: ReadonlyArray<PromiseStep>, o: { nowMs?: number; maxAgeMs?: number } = {}): { next: PromiseStep; rest: PromiseStep[] } | null {
  const now = o.nowMs ?? Date.now(); const age = o.maxAgeMs ?? PROMISE_QUEUE_MAX_AGE_MS;
  const pending = steps.filter((s) => s.status === "pending" && !s.watch && now - Date.parse(s.promisedAt) <= age).sort((a, b) => PROMISE_ORDER.indexOf(a.kind) - PROMISE_ORDER.indexOf(b.kind) || Date.parse(a.promisedAt) - Date.parse(b.promisedAt));
  if (!pending.length) return null;
  return { next: pending[0], rest: pending.slice(1) };
}

export function promiseStepLabel(s: Pick<PromiseStep, "kind" | "action" | "object">): string {
  return `${PROMISE_KIND_JA[s.kind]}${s.object ? `（${s.object}）` : ""} → AIX【${AIX_BUTTON_LABELS[s.action] ?? s.action}】`;
}

/** 要対応の行の resolution_note（main の行のまま＝朝の挨拶の印と別）。advancePromiseQueue が書き、画面・取り下げの判定が読む */
export const PROMISE_QUEUE_NOTE_PREFIX = "rule:promise_queue";
export function promiseQueueNote(next: PromiseStep, rest: ReadonlyArray<PromiseStep>): string {
  return `${PROMISE_QUEUE_NOTE_PREFIX}｜次: ${promiseStepLabel(next)}${rest.length ? `｜残り: ${rest.map((s) => PROMISE_KIND_JA[s.kind]).join("・")}` : ""}`.slice(0, 200);
}
/** 約束の続きの要対応か（72時間以内・戻していない）。ブレインの「今回の発言に AIX は要らない」で取り下げない（aix-action-items.syncAixActionItem） */
export function keepPromiseQueueItem(row: { resolution_note?: string | null; created_at?: string | null }, nowMs = Date.now(), env?: Record<string, string | undefined>): boolean {
  if (!promiseQueueEnabled(env)) return false;
  if (!String(row.resolution_note ?? "").startsWith(PROMISE_QUEUE_NOTE_PREFIX)) return false;
  const c = Date.parse(row.created_at ?? "");
  return Number.isFinite(c) && nowMs - c <= PROMISE_QUEUE_MAX_AGE_MS;
}
