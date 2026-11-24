// app/lib/aix-state-card.ts — AIX の判断の土台「AIX ごとの状態の札」（台帳 #688・決まった計算・LLM なし）
// 2026-11-25 作業員A（竹内さん 11/25 深夜「AIX の判断の部分は、土台が必要なら追加して、細分化して強化していく」・統括役の頼み）
//   外れの多くは辞書（aix-catalog.ts の when・lines）の抜けではなく「状態の読み違い」（束を送った直後か・日時が決まったか）だった（60日 184番の読み）。
//   AIX を選ぶ時に要る状態を、送った物の記録（aix_usage_logs）・お客様の通・内覧の予定・タスクから決まった計算で1枚にする。
//   スイッチ AIX_STATE_CARD: 既定 shadow（記録だけ）／on（ブレインの材料に入れる口・別に作る）／off
import type { CustomerStateInput } from "./customer-state";
import { docFactsOf, docFactsLine, type DocFacts, type DocPickup } from "./aix-state-doc";

export type AixStateCard = {
  /** 物件の束（物件ピックアップ）を最後に送ってからの分・その後にお客様の通があったか・送った束の数（ピックアップ⇄オススメ） */
  bundle: { count: number; lastMinAgo: number | null; replyAfter: boolean; recMinAgo: number | null };
  /** 内覧: 候補日を出したか・日時が決まったか・何日後か・待ち合わせを送ったか・今日の挨拶を送ったか（内覧調整⇄待ち合わせ場所） */
  viewing: { invitedMinAgo: number | null; decided: boolean; daysTo: number | null; meetingSent: boolean; greetingToday: boolean; doneDaysAgo: number | null };
  /** 見積・空室: 見積書を送ったか・空室を確かめたか（結果）・その順（見積書送る⇄物件確認した） */
  estimate: { sentMinAgo: number | null; checkMinAgo: number | null; checkResult: string | null; checkedBeforeEstimate: boolean | null };
  /** 管理会社への確認: 開いている確認のタスク・最後の確認した（mgmt_*）の結果を送った時からの分（確認した⇄物件確認した） */
  mgmt: { openCheckTasks: number; lastMgmtAnswerMinAgo: number | null; lastMgmtPattern: string | null };
  /** お客様の最後の通からの分（スタッフだけが知る番の目安・20分以上でお礼だけ＝④） */
  customer: { lastMinAgo: number | null };
  /** 2026-11-25 土台の欠けを足す: 送れる候補（ピックアップの待ち）の数・最後の束より後に出た候補の数（新着1件のオススメ⇄束のピックアップ）。ピックアップを渡さない時は null */
  candidates: { pending: number | null; newSinceBundle: number | null };
  /** 2026-11-25 土台の欠けを足す: 送った物件のうち退去予定（入居中）の部屋の数（内覧開始日の確認の約束が先・現状を伝えて1件） */
  vacating: { rooms: number };
  /** 2026-11-25 土台の欠け「資料にある」: 最後の束で送った物件の資料で、項目ごとに資料で答えられる件数（aix-state-doc・送った物件の資料を渡さない時は null） */
  doc: DocFacts | null;
};
/** 資料の読みも札に入れるか（送った物件の資料＝pdf_text を読むので、既定 off・入れる AIX_STATE_CARD_DOC=on） */
export function aixStateCardDocOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean { return (env.AIX_STATE_CARD_DOC ?? "").trim().toLowerCase() === "on"; }

const minAgo = (now: number, iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) && t <= now ? Math.round((now - t) / 60_000) : null; };
const jstDay = (ms: number) => Math.floor((ms + 9 * 3_600_000) / 86_400_000);

export function aixStateCardMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" | "on" {
  const v = (env.AIX_STATE_CARD ?? "shadow").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}

/** 札（純関数）。now は判断の時刻（試験・照らしでは番の時刻） */
export function buildAixStateCard(input: Pick<CustomerStateInput, "messages" | "aixRows" | "viewingHistory" | "lineTasks"> & { pickups?: ReadonlyArray<{ created_at: string; status: string | null }> | null; docPickups?: ReadonlyArray<DocPickup> | null }, now: number): AixStateCard {
  const aix = [...input.aixRows].map((a) => ({ type: String(a.aix_type ?? ""), pat: (a as { check_pattern?: string | null }).check_pattern ?? null, t: Date.parse(String((a as { sent_at?: string | null }).sent_at ?? (a as { created_at?: string }).created_at ?? "")) }))
    .filter((a) => Number.isFinite(a.t) && a.t <= now).sort((a, b) => a.t - b.t);
  const last = (pred: (a: (typeof aix)[number]) => boolean) => [...aix].reverse().find(pred) ?? null;
  const cust = input.messages.filter((m) => m.sender === "customer" && Date.parse(m.createdAt) <= now);
  const lastCust = cust[cust.length - 1];
  const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
  // 束
  const bundles = aix.filter((a) => a.type === "property_send");
  const lb = bundles[bundles.length - 1];
  const lr = last((a) => a.type === "property_recommendation");
  const replyAfter = !!lb && cust.some((m) => Date.parse(m.createdAt) > lb.t);
  // 内覧
  const inv = last((a) => a.type === "viewing_invite");
  const meet = last((a) => a.type === "meeting_place");
  const greet = last((a) => a.type === "greeting_viewing");
  const vs = input.viewingHistory.map((v) => ({ t: Date.parse(`${v.scheduled_date}T${(v.scheduled_time ?? "12:00").slice(0, 5)}:00+09:00`), st: v.status ?? "" })).filter((v) => Number.isFinite(v.t));
  const upcoming = vs.filter((v) => v.t >= now && !/cancel|取消|キャンセル/.test(v.st)).sort((a, b) => a.t - b.t)[0];
  const done = vs.filter((v) => v.t < now).sort((a, b) => b.t - a.t)[0];
  // 見積・空室
  const est = last((a) => a.type === "estimate_sheet");
  const chk = last((a) => a.type === "property_check_result" && !String(a.pat ?? "").startsWith("mgmt_"));
  const mg = last((a) => a.type === "property_check_result" && String(a.pat ?? "").startsWith("mgmt_"));
  const tasks = (input.lineTasks ?? []).filter((t) => /check/.test(t.task_type) && t.status !== "completed" && (!t.created_at || Date.parse(t.created_at) <= now));
  return {
    bundle: { count: bundles.length, lastMinAgo: lb ? minAgo(now, iso(lb.t)) : null, replyAfter, recMinAgo: lr ? minAgo(now, iso(lr.t)) : null },
    viewing: {
      invitedMinAgo: inv ? minAgo(now, iso(inv.t)) : null,
      decided: !!upcoming || (!!meet && (!inv || meet.t > inv.t)),
      daysTo: upcoming ? jstDay(upcoming.t) - jstDay(now) : null,
      meetingSent: !!meet && (!inv || meet.t > inv.t),
      greetingToday: !!greet && jstDay(greet.t) === jstDay(now),
      doneDaysAgo: done ? jstDay(now) - jstDay(done.t) : null,
    },
    estimate: { sentMinAgo: est ? minAgo(now, iso(est.t)) : null, checkMinAgo: chk ? minAgo(now, iso(chk.t)) : null, checkResult: chk?.pat ?? null, checkedBeforeEstimate: est ? !!chk && chk.t < est.t : null },
    mgmt: { openCheckTasks: tasks.length, lastMgmtAnswerMinAgo: mg ? minAgo(now, iso(mg.t)) : null, lastMgmtPattern: mg?.pat ?? null },
    customer: { lastMinAgo: lastCust ? minAgo(now, lastCust.createdAt) : null },
    candidates: (() => {
      if (!input.pickups) return { pending: null, newSinceBundle: null };
      const pend = input.pickups.filter((x) => x.status === "pending" && Date.parse(x.created_at) <= now);
      return { pending: pend.length, newSinceBundle: lb ? pend.filter((x) => Date.parse(x.created_at) > lb.t).length : pend.length };
    })(),
    doc: input.docPickups ? docFactsOf(input.docPickups, now) : null,
    vacating: { rooms: input.aixRows.filter((a) => Date.parse(String((a as { sent_at?: string | null }).sent_at ?? a.created_at ?? "")) <= now).reduce((n, a) => n + ((a as { prop_statuses?: string[] | null }).prop_statuses ?? []).filter((st) => st === "vacating" || st === "move_out_planned").length, 0) },
  };
}

/** 札の1行（記録・材料の目録用・短く） */
export function aixStateCardLine(c: AixStateCard): string {
  const m = (x: number | null) => (x === null ? "なし" : x < 120 ? `${x}分前` : x < 2880 ? `${Math.round(x / 60)}時間前` : `${Math.round(x / 1440)}日前`);
  return [
    `束 ${c.bundle.count}回（最後 ${m(c.bundle.lastMinAgo)}・その後の返事 ${c.bundle.replyAfter ? "あり" : "なし"}）・オススメ ${m(c.bundle.recMinAgo)}`,
    `内覧 候補日 ${m(c.viewing.invitedMinAgo)}・日時 ${c.viewing.decided ? `決まった${c.viewing.daysTo !== null ? `（${c.viewing.daysTo}日後）` : ""}` : "未定"}・待ち合わせ ${c.viewing.meetingSent ? "送った" : "未"}・今日の挨拶 ${c.viewing.greetingToday ? "送った" : "未"}${c.viewing.doneDaysAgo !== null ? `・内覧 ${c.viewing.doneDaysAgo}日前` : ""}`,
    `見積書 ${m(c.estimate.sentMinAgo)}・空室の確認 ${m(c.estimate.checkMinAgo)}${c.estimate.checkResult ? `（${c.estimate.checkResult}）` : ""}`,
    `管理会社の確認 開いている ${c.mgmt.openCheckTasks}件・最後の答え ${m(c.mgmt.lastMgmtAnswerMinAgo)}${c.mgmt.lastMgmtPattern ? `（${c.mgmt.lastMgmtPattern}）` : ""}`,
    ...(c.candidates.pending !== null ? [`送れる候補 ${c.candidates.pending}件（最後の束より後 ${c.candidates.newSinceBundle}件）`] : []),
    ...(c.vacating.rooms ? [`退去予定の部屋 ${c.vacating.rooms}`] : []),
    ...(c.doc ? [docFactsLine(c.doc)] : []),
  ].join("／");
}

/**
 * 土台の欠け: 辞書（aix-catalog の when・lines）に出てくる条件の言葉を、札の欄に当てる。どの欄にも当たらない条件の言葉を返す（決まった表・推して埋めない）
 *   表は 11/25 の辞書の読みから。辞書が増えたら表も足す（当たらない言葉は「欠け」として毎朝の1枚に出る）
 */
export const CARD_FIELD_OF: ReadonlyArray<[RegExp, string]> = [
  [/束を送った直後|直後（1時間以内）|1時間以内|束から1時間超|複数件送った直後/, "bundle.lastMinAgo・bundle.replyAfter"],
  [/まだ物件を送っていない|初めて送る|初回/, "bundle.count"],
  [/前に送った後|前に物件を送った後/, "bundle.count"],
  [/候補日を出した後|候補日を出す前|日時を選んだ|日時が決まった|日時を指定/, "viewing.invitedMinAgo・viewing.decided"],
  [/決まった内覧の日時を変える/, "viewing.decided"],
  [/当日の朝・前日|今日もう当日の挨拶/, "viewing.daysTo・viewing.greetingToday"],
  [/内覧の後/, "viewing.doneDaysAgo"],
  [/見積る物件がまだ無い|作る前|見積書を作ろうとして/, "estimate.sentMinAgo"],
  [/確認の約束の後|結果がまだ無い/, "mgmt.openCheckTasks"],
  [/募集が終わっていた|募集終了|紹介不可|物件なかった/, "estimate.checkResult"],
  [/管理会社に.*(聞いた|確認した)/, "mgmt.lastMgmtPattern"],
  [/新着|新しく募集に出た/, "candidates.newSinceBundle"],
  [/資料に(?:書いてある|ある)/, "doc.topics"],
  [/退去予定|入居中/, "vacating.rooms"],
];
/** 欠けの候補になる条件の言葉（辞書の when・lines から拾う物・札に欄が無いと「欠け」） */
export const CONDITION_WORDS: readonly RegExp[] = [
  /束を送った直後|1時間以内|複数件送った直後/, /まだ物件を送っていない|初めて送る/, /前に送った後/, /候補日を出した後|日時を選んだ|日時が決まった|日時を指定/,
  /当日の朝・前日|今日もう当日の挨拶/, /内覧の後/, /作る前|見積書を作ろうとして/, /確認の約束の後|結果がまだ無い/, /募集が終わっていた|募集終了|紹介不可/,
  /退去予定|入居中/, /資料に(?:書いてある|ある)/, /新しく募集に出た|新着/, /条件を広げた/, /手元にある|手元に無い/, /同じ建物の別の部屋/, /頼まれて/,
];
export function cardGaps(entries: ReadonlyArray<{ key: string; when: string; lines?: string }>): Array<{ word: string; keys: string[] }> {
  const gaps = new Map<string, Set<string>>();
  for (const e of entries) {
    const text = `${e.when} ${e.lines ?? ""}`;
    for (const w of CONDITION_WORDS) {
      const m = text.match(w); if (!m) continue;
      if (CARD_FIELD_OF.some(([re]) => re.test(m[0]))) continue;
      const g = gaps.get(m[0]) ?? new Set<string>(); g.add(e.key); gaps.set(m[0], g);
    }
  }
  return [...gaps].map(([word, ks]) => ({ word, keys: [...ks] })).sort((a, b) => b.keys.length - a.keys.length);
}
