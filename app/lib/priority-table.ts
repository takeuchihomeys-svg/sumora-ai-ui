// app/lib/priority-table.ts — 場面×状態ごとの「優先度の表」（純関数・定数だけ・作業員16・2026-11-13）
//
// 竹内さん 11/13「優先度の部分等を具体的にできるように。統括の部分を細分化して強化する」。
//   KB P1 d030d496（判断の順番・確認の順番・優先度の細分化）・P0 7d6fe3eb（統括が状況で確認の順番を選び、なぜを持つ）・ef6626d7・41dadfe6（竹内さんの番だけで作る）。
//   弱い所 conductor:order-table-single-line（順番の表が1本）・brain:aix-before-asks-no-now-later を、場面×状態の行に分けて直す土台。
// 1行＝1つの場面×状態（check-order の型 id ＋状態）。6つの欄:
//   ① first     一番先に応える事（どの依頼か・なぜか）＝judge-basis-types の Priority の名前
//   ② order     依頼の並べ順（主と従・後に回す依頼と理由）
//   ③ checks    確かめる順番と深さ（check-order の CheckStep・judge-basis-types の BasisDepth）
//   ④ nowLater  今やる事と後でやる事（brain-now-later の this_turn・作業員7b の ask-parts の route の名前）
//   ⑤ combo     返信と AIX の組と順番（作業員7b の send-combo-table の SendCombo の名前）
//   ⑥ avoid     やらない事（no_touch＝触れない話題・repeat_scope＝繰り返さない条件。作業員5 と名前を揃える前の案）
//   ＋ tags     なぜその順かの札
// 置き方: 統括の記録（check_order・conductor_record）に残し、文の設計図の why_order（作業員10）へ渡す。道は変えない（記録と設計図の材料だけ）。
// スイッチ: PRIORITY_TABLE（既定 off＝どこからも読まない）。

import type { Priority, BasisDepth } from "./judge-basis-types";
import type { CheckStep } from "./check-order";
import type { NowThisTurn } from "./brain-now-later";
import type { SendCombo } from "./send-combo-table";

export function priorityTableOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = String(env.PRIORITY_TABLE ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow";
}

export type PriorityRow = {
  /** check-order の型 id */
  type: string;
  /** その型の中の状態（例: 問いが複数・持ち込みで確認まだ） */
  state: string;
  first: { need: Priority; what: string; why: string };
  order: { main: string; subs: string[]; deferred: Array<{ what: string; why: string }> };
  checks: { steps: CheckStep[]; depth: BasisDepth; why: string };
  nowLater: Array<{ part: string; thisTurn: NowThisTurn; route: "reply" | "promise" | "aix" | "none" }>;
  combo: SendCombo;
  avoid: { no_touch: string[]; repeat_scope: string | null };
  tags: string[];
  /** 竹内さんの番の数・実例 */
  count: string;
};

export const PRIORITY_ROWS: readonly PriorityRow[] = [
  {
    type: "T2_question_fact", state: "問いが複数（この物件で良いかの確かめ＋空き・色・入居日）",
    first: { need: "answer", what: "この物件で良いかに当たる問い（空き・色など物件の中身）", why: "お客様は物件を決める手前。決め手の問いに先に答えないと、入居日の答えが空振りになる" },
    order: { main: "物件の中身の問い（空いている部屋・色）", subs: ["入居日（会社の事実の期間）", "事情（異動で11/16以降）への受け"], deferred: [{ what: "白基調の別の物件", why: "物件の中身の答えが『合わない』の時だけ、AIX で別の物件を出す" }] },
    checks: { steps: ["read_ask", "our_last_send", "fact_answer", "staff_only", "now_vs_later"], depth: "deep", why: "4つの問いの答えの出所が別（資料の値・会社の事実・代わりの物件）。出所ごとに分けないと、答えられる物まで確認の約束に倒れる" },
    nowLater: [{ part: "空いている部屋・色", thisTurn: "answer", route: "reply" }, { part: "入居日", thisTurn: "answer", route: "reply" }, { part: "白基調の別の物件", thisTurn: "deliver", route: "aix" }],
    combo: "reply_then_aix_quick",
    avoid: { no_touch: ["聞かれていない募集状況以外の条件"], repeat_scope: "事情（異動）は受けを1回だけ" },
    tags: ["決め手の問いが先", "答えの出所で分ける", "合わない時だけ代わり"],
    count: "点検役の19番の 12548（4つの問い）・竹内さんは返信→3分後に白基調の物件を AIX",
  },
  {
    type: "T12_hooked_comparing_taken", state: "抑えられる部屋の確かめ（申込の手前）",
    first: { need: "answer", what: "抑えられる部屋はどれか", why: "答えそのものが申込の手前の判断材料" },
    order: { main: "抑えられるのは送った202号室", subs: ["他の号室は申込が入り2番手以降", "202も申込が入る可能性"], deferred: [] },
    checks: { steps: ["read_ask", "hypothesize", "our_last_send", "fact_answer", "now_vs_later"], depth: "deep", why: "「間取りの確かめ」か「抑える手前」かを読みの候補で分けないと、取られる不安への先回りが落ちる" },
    nowLater: [{ part: "抑えられる部屋", thisTurn: "answer", route: "reply" }],
    combo: "reply_only",
    avoid: { no_touch: ["内覧の日程（聞かれていない）"], repeat_scope: null },
    tags: ["答えが先", "取られる不安の事実を同じ通で", "他の号室の申込状況"],
    count: "12362（ブレインの下書きは202の答えだけで、他の号室と取られる線が抜けた）",
  },
  {
    type: "T2_question_fact", state: "こちらの送信への問い返し（掲載との食い違い）",
    first: { need: "answer", what: "おとり物件という事か", why: "疑問に答えないまま約束を言うと、こちらへの不信が残る" },
    order: { main: "ポータルの掲載の仕組み（答え）", subs: ["掲載の物件も送ってもらえれば確認する"], deferred: [{ what: "新着のピックアップの約束", why: "答えの後の別の通（竹内さんは約10分後に2通目）" }] },
    checks: { steps: ["read_ask", "hypothesize", "our_last_send", "fact_answer", "now_vs_later"], depth: "normal", why: "こちらの直前の送信（掲載終了の確認）を見て、疑問が掲載へかこちらへかを分ける" },
    nowLater: [{ part: "掲載の仕組み", thisTurn: "answer", route: "reply" }, { part: "新着のピックアップ", thisTurn: "promise", route: "reply" }],
    combo: "reply_reply",
    avoid: { no_touch: [], repeat_scope: "ピックアップの約束は答えの後に1回" },
    tags: ["疑問への答えが先", "約束は後の通"],
    count: "11865（ブレインの下書きは約束が先・答えが後）",
  },
  {
    type: "T1_conditions_first", state: "送った物件を外す（場所の割に高い）",
    first: { need: "send_promise", what: "その物件を外して、条件の線で探し直す約束", why: "外す事を受けないと、合わない物件を押されたと感じる" },
    order: { main: "対象から外す", subs: ["エリアと家賃の上限を復唱して探す約束"], deferred: [{ what: "物件の束", why: "ピックアップが揃ってから AIX（竹内さんは11分後）" }] },
    checks: { steps: ["read_ask", "our_last_send", "now_vs_later"], depth: "normal", why: "どの送った物件のどの点（家賃×場所）が合わないかを、こちらの送信で確かめる" },
    nowLater: [{ part: "外して探す", thisTurn: "promise", route: "promise" }, { part: "物件の束", thisTurn: "deliver", route: "aix" }],
    combo: "promise_then_aix_later",
    avoid: { no_touch: ["お客様が言っていない条件の上乗せ（白基調・リフォーム済み 等）"], repeat_scope: "登録の条件の全部の復唱はしない（言い直した線だけ）" },
    tags: ["外す受けが先", "言っていない条件を足さない"],
    count: "12196（ブレインの下書きは言っていない条件を足した）",
  },
  {
    type: "T8_cost", state: "初期費用の項目を外せるか（必須か・外せるか）",
    first: { need: "answer", what: "鍵交換代は必須か（資料で言える部分）", why: "今言える部分を先に答え、確かめる部分は約束に分ける（両にらみにしない）" },
    order: { main: "必須かどうか（資料）", subs: ["外せるかは管理会社に確かめる約束"], deferred: [{ what: "外した額の御見積書", why: "管理会社の答えの後" }] },
    checks: { steps: ["read_ask", "fact_answer", "staff_only", "now_vs_later"], depth: "normal", why: "1つの依頼の中に資料で言える部分と管理会社の部分が混ざる（ask-parts）" },
    nowLater: [{ part: "必須か", thisTurn: "answer", route: "reply" }, { part: "外せるか", thisTurn: "promise", route: "promise" }],
    combo: "promise_then_aix_later",
    avoid: { no_touch: [], repeat_scope: null },
    tags: ["言える部分が先", "確かめる部分は約束", "前に言った初期費用5万以内"],
    count: "12643＝q411",
  },
];

/** 型と状態の手がかりから行を選ぶ（網・ブレインの決めではない＝P0 9eb6aa9c）。状態が分からなければ型の最初の行 */
export function priorityRowFor(type: string | null | undefined, stateHint?: string | null): PriorityRow | null {
  if (!type) return null;
  const rows = PRIORITY_ROWS.filter((r) => r.type === type);
  if (!rows.length) return null;
  if (stateHint) { const hit = rows.find((r) => r.state.includes(stateHint) || stateHint.includes(r.state.split("（")[0])); if (hit) return hit; }
  return rows[0];
}

/** 統括の記録（check_order）に残す短い印: "first=answer_question|main=…|combo=reply_then_aix_quick|defer=1" */
export function priorityDigest(r: PriorityRow | null | undefined): string | null {
  if (!r) return null;
  return `first=${r.first.need}|combo=${r.combo}|defer=${r.order.deferred.length}|depth=${r.checks.depth}`;
}

/** 文の設計図の why_order（作業員10）へ渡す1行（道が決まった後の設計図の材料） */
export function whyOrderLine(r: PriorityRow | null | undefined): string | null {
  if (!r) return null;
  return `先に: ${r.first.what}（${r.first.why}）／主: ${r.order.main}／従: ${r.order.subs.join("・") || "無し"}${r.order.deferred.length ? `／後に回す: ${r.order.deferred.map((d) => `${d.what}（${d.why}）`).join("・")}` : ""}`;
}
