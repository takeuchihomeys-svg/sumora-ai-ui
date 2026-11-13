// app/lib/next-move-concrete.ts — 次の一手を番ごとの中身にする（何を・いつ・どの形で）（純関数・DB/LLM なし・作業員16・2026-11-13）
//
// 統括役の頼み 11/13: 統括の指示書の next は型の表の決まった値（keep_send・新着）だった。その番の材料から具体にする。
//   何を   どの物件・どの資料・どの AIX（後に回した依頼＝優先度の表の行の deferred → 開いている約束＝action_ledger.facts → 送れる候補＝now_vs_later.ready_now → 型の表）
//   いつ   お客様が言った時期（latent_five.expect・turn_aims・依頼の言葉）→ 約束の期日の言葉（promise-deadline-words.chooseDeadlineWord＝管理会社の営業時間・会社の時間の決まり）→ 型の表
//   どの形で 返信・AIX・2段・組（次の段の並び steps。組の正は send_combo_table＝統括役の決め・優先度の表の組は参考）
// 決まり: 道（今の番の返信か AIX か）は読むだけで変えない。材料に無い物件名・日時は作らない（item は材料の言葉か種類の名前だけ）。
// スイッチ: NEXT_MOVE_CONCRETE（既定 off＝指示書の next に concrete を足さない）。
// 実例: 12643（外した額の御見積書・管理会社の確認の後）・11865（新着のピックアップ・後の通）・12562（来週の連絡を待つ）。
import { chooseDeadlineWord, toNextMoveWhen, type PromiseWhenKind } from "./promise-deadline-words";
import type { SendCombo } from "./send-combo-table";
import type { PriorityRow } from "./priority-table";

type Env = Record<string, string | undefined>;
export function nextMoveConcreteOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NEXT_MOVE_CONCRETE ?? "").trim().toLowerCase() === "on";
}

export type ConcreteWhat = "property" | "estimate" | "check_result" | "doc" | "wait_contact" | "none";
export type ConcreteStep = {
  route: "reply" | "aix";
  /** route=aix の時の AIX の種類（aix-taxonomy の名前） */
  aix: string | null;
  what: ConcreteWhat;
  /** 材料の言葉（後に回した依頼の文・約束の対象）か種類の名前。物件名・日時は作らない */
  item: string;
  when: { at: "now" | "next_turn" | "hours" | "next_day" | "customer"; word: string | null; from: "customer" | "promise_deadline" | "mgmt_hours" | "priority_row" | "type_table" };
};
export type ConcreteNext = {
  steps: ConcreteStep[];
  /** 何を決めた材料 */
  from: "customer_wait" | "deferred" | "open_promise" | "ready_now" | "type_table";
  /** 今の番の組（send_combo_table が正）と優先度の表の組（参考） */
  combo: SendCombo | string | null;
  comboRef: SendCombo | null;
  why: string;
};

type M = Record<string, unknown>;
const obj = (v: unknown): M | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as M) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** お客様の言った時期の言葉（材料の言葉だけ拾う・作らない） */
export const TIME_WORD_RE = /来週(?:中|末|の[月火水木金土日]曜)?|今週(?:中|末)?|明後日|明日|週末|土日|月末|来月|年内|年明け|[0-9０-９]{1,2}月(?:[0-9０-９]{1,2}日)?(?:以降|頃)?|[月火水木金土日]曜(?:日)?/;
/** お客様がこちらに連絡すると言った（待つ番） */
export const WAIT_CONTACT_RE = /(?:ご?連絡|お返事|返事|返信)(?:します|しますね|させて|致します|いたします|入れます)|検討して(?:から|また)|相談して(?:から|また)|また(?:連絡|ご連絡)/;

/** 後に回した依頼の文 → 何を・どの AIX */
function classify(text: string): { what: ConcreteWhat; aix: string | null; kind: PromiseWhenKind | null } {
  if (/見積/.test(text)) return { what: "estimate", aix: "estimate_sheet", kind: /管理会社|交渉|外し/.test(text) ? "negotiate" : "estimate" };
  if (/新着/.test(text)) return { what: "property", aix: "property_send", kind: "new_arrival" };
  if (/ピックアップ|物件の束|別の物件|代わり|物件】|物件を送/.test(text)) return { what: "property", aix: "property_send", kind: "pickup" };
  if (/確認|結果|物件確認/.test(text)) return { what: "check_result", aix: "property_check_result", kind: "check_mgmt" };
  if (/条件ヒアリング|フォーム/.test(text)) return { what: "doc", aix: "hearing", kind: null };
  return { what: "none", aix: null, kind: null };
}
const deadlineOf = (kind: PromiseWhenKind | null, nowMs: number | null): ConcreteStep["when"] | null => {
  if (!kind || nowMs == null) return null;
  const c = chooseDeadlineWord({ kind, nowMs });
  const w = toNextMoveWhen(c);
  return { at: w.at, word: w.dueLabel, from: c.prefix || /営業|管理会社/.test(c.basis.join("")) ? "mgmt_hours" : "promise_deadline" };
};

export type ConcreteInput = {
  meta: M | null | undefined;
  /** 優先度の表の行（priority-table.priorityRowFor の行） */
  row?: PriorityRow | null;
  /** 今の番の組（send_combo_table の combo・指示書の combine.combo） */
  combo?: SendCombo | string | null;
  /** 時計（番の時刻。無ければ期日の言葉は作らない＝純関数のまま） */
  nowMs?: number | null;
  /** 型の表の次の一手（指示書の next.dest・材料が無い時の受け） */
  typeDest?: string | null;
};

export function concreteNextMove(i: ConcreteInput): ConcreteNext {
  const m = i.meta ?? {};
  const nowMs = i.nowMs ?? (typeof m.analyzed_msg_ts === "string" && Number.isFinite(Date.parse(m.analyzed_msg_ts)) ? Date.parse(m.analyzed_msg_ts) : null);
  const row = i.row ?? null;
  const comboRef = row?.combo ?? null;
  const asks = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is M => !!a);
  const lf = obj(m.latent_five), ta = obj(m.turn_aims);
  const timeSrc = [str(obj(lf?.expect)?.text), str(ta?.midAim), str(ta?.turnAim), ...arr(obj(m.now_vs_later)?.asked_now).map(str), ...asks.map((a) => str(a.quote)), str(m.customer_text)].filter((x): x is string => !!x);
  const custTime = timeSrc.map((t) => t.match(TIME_WORD_RE)?.[0]).find((x) => !!x) ?? null;
  const custWait = timeSrc.some((t) => WAIT_CONTACT_RE.test(t)) || arr(obj(m.check_order)?.cues).includes("considering");
  const base = { combo: i.combo ?? null, comboRef };

  // ① お客様がこちらへ連絡すると言った（時期つき）＝待つ番。押さない・AIX なし
  if (custWait && custTime) {
    return { ...base, from: "customer_wait", why: "お客様が時期を言って連絡すると言った＝こちらから押さず、言った時期を待つ（締めはその時期の言葉で）",
      steps: [{ route: "reply", aix: null, what: "wait_contact", item: `${custTime}のご連絡を待つ`, when: { at: "customer", word: custTime, from: "customer" } }] };
  }

  // ② 優先度の表の行で後に回した依頼（主の答えの後に果たす物）
  const d = row?.order.deferred[0];
  if (d) {
    const c = classify(`${d.what} ${d.why}`);
    const steps: ConcreteStep[] = [];
    const custW = custTime ? { at: "customer" as const, word: custTime, from: "customer" as const } : null;
    // 後の通の返信で約束してから AIX で果たす形（11865: 答えの後の別の通で新着の約束→募集に出次第 AIX）
    if (/約束/.test(d.what) && c.aix) {
      steps.push({ route: "reply", aix: null, what: c.what, item: d.what, when: { at: "hours", word: /分後|別の通|2通目/.test(d.why) ? "答えの後の別の通" : null, from: "priority_row" } });
      steps.push({ route: "aix", aix: c.aix, what: c.what, item: d.what.replace(/の約束$/, ""), when: custW ?? deadlineOf(c.kind, nowMs) ?? { at: "next_turn", word: null, from: "type_table" } });
    } else if (c.aix) {
      // 確かめた後で AIX（12643: 管理会社の答えの後に外した額の御見積書）
      const mgmt = /管理会社/.test(d.why) ? deadlineOf("check_mgmt", nowMs) : null;
      steps.push({ route: "aix", aix: c.aix, what: c.what, item: d.what, when: custW ?? mgmt ?? deadlineOf(c.kind, nowMs) ?? { at: "next_turn", word: /後/.test(d.why) ? d.why.slice(0, 20) : null, from: "priority_row" } });
    } else {
      steps.push({ route: "reply", aix: null, what: c.what, item: d.what, when: custW ?? { at: "next_turn", word: null, from: "priority_row" } });
    }
    return { ...base, from: "deferred", why: `後に回した依頼（${d.why}）`, steps };
  }

  // ③ 開いている約束（action_ledger の事実）
  const f = obj(obj(m.action_ledger)?.facts);
  const open: Array<{ what: ConcreteWhat; aix: string; item: string; kind: PromiseWhenKind }> = [];
  if (f?.confirmationPromisedUnfulfilled === true) open.push({ what: "check_result", aix: "property_check_result", item: str(f.confirmationPromisedObject) ?? "約束した確認の結果", kind: "check_mgmt" });
  if (f?.estimatePromisedUnfulfilled === true) open.push({ what: "estimate", aix: "estimate_sheet", item: "約束した御見積書", kind: "estimate" });
  if (f?.pickupPromisedUnfulfilled === true) open.push({ what: "property", aix: "property_send", item: "約束したピックアップ", kind: "pickup" });
  if (open.length) {
    // 約束した順に1つずつ（feedback_promise_order_split: 確認の結果→見積→ピックアップ）
    return { ...base, from: "open_promise", why: "開いている約束を約束の順に果たす（1通に詰めない）",
      steps: open.slice(0, 2).map((o) => ({ route: "aix", aix: o.aix, what: o.what, item: o.item, when: (custTime ? { at: "customer", word: custTime, from: "customer" } : null) ?? deadlineOf(o.kind, nowMs) ?? { at: "next_turn", word: null, from: "type_table" } })) };
  }

  // ④ 今送れる候補がある
  if (arr(obj(m.now_vs_later)?.ready_now).some((x) => typeof x === "string" && /送れる物件/.test(x))) {
    return { ...base, from: "ready_now", why: "送れる物件の候補が手元にある",
      steps: [{ route: "aix", aix: "property_send", what: "property", item: "送れる物件の候補", when: { at: "now", word: null, from: "type_table" } }] };
  }

  // ⑤ 材料が無い＝型の表の受け（具体にしない・何を作らない）
  return { ...base, from: "type_table", why: "番の材料に次の一手の中身が無い（型の表の受け）",
    steps: [{ route: "reply", aix: null, what: "none", item: i.typeDest ?? "未", when: custTime ? { at: "customer", word: custTime, from: "customer" } : { at: "next_turn", word: null, from: "type_table" } }] };
}

/** 記録の1行: "deferred|aix:estimate_sheet@明日一番に(mgmt_hours)" */
export function concreteNextDigest(c: ConcreteNext | null | undefined): string | null {
  if (!c) return null;
  return `${c.from}|${c.steps.map((s) => `${s.route}${s.aix ? `:${s.aix}` : ""}@${s.when.word ?? s.when.at}(${s.when.from})`).join(">")}`.slice(0, 100);
}
