// app/lib/compose-order-table.ts — 文の統括の「型ごとの組み立ての表」（竹内さんの198通の文の役目の並びから・純関数・既定 off）
//
// 2026-11-12 作業員10（統括役・竹内さん 11/12「文の統括がしっかりブレインの統括のように細分化してまとめれればより強化される」）。
//   ブレインの統括の「確認の順番・判断の順番」の型（作業員16 check-order.ts の T1〜T11＝場面×状態）と同じ型で、文の側の組み立てを決める:
//     どの役目の文を・どの順で・どれを主に・なぜ（竹内さんの実例の数）・押す強さ・締め。道（返信か AIX か）は決め直さない（受け取った設計図の行を並べ替えるだけ）。
//   表の元: exam-cache/anatomy-roles/roles-r1.json（作業員5 の198通の文の役目・3回読みの多数）× anatomy-seven/seven-all198.json（押す／待つ）。
//     型は場面（resolveReplyScene）と主の役目で決める: conditions→T1／question で主が確かめる約束→T3・それ以外→T2／property_share→T4／ack→T5／considering→T6／
//     viewing→T7／cost→T8／apply→T9（T10 結果がある・T11 初回の聞き取りは198通に組が無い＝表に無い）。
//     order＝その型で2割以上の通に出た役目を、1通の中の平均の位置の順に（挨拶・受け・締めを除く）。
//   使い方（COMPOSE_ORDER_TABLE=on）: 設計図の従の行を型の順に並べ替える（主は先のまま）・誘導の行に押す強さが無ければ型の多い形・締めを付けるかの1行。
//     判断の根拠（型・並べた順・主にした文となぜ）は off の時も digest.compose_plan に残す（書き手には渡さない）。
//   1通か2通か: 198通は返信の1通だけ（AIX の番は数えていない）＝表では決めない（2通は two-message-plan・ブレインの組み合わせが決める）
// テスト: npx tsx app/lib/__tests__/compose-order-table.test.ts
import type { SentenceRole } from "./takeuchi-anatomy-roles";
import { ROLE_LABEL } from "./takeuchi-anatomy-roles";
import type { SentencePlan, TurnUnderstanding } from "./compose-sentence-plan";

type Env = Record<string, string | undefined>;
export function composeOrderTableOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_ORDER_TABLE ?? "").trim().toLowerCase() === "on";
}

export type OrderRow = { n: number; order: SentenceRole[]; main: string; mainN: number; closeN: number; lead: string; leadN: number; push: string; pushN: number };
/** 型 → 竹内さんの組み立て（2026-11-12・198通の数え） */
export const COMPOSE_ORDER_TABLE: Readonly<Record<string, OrderRow>> = {
T1_conditions_first: { n: 22, order: ["keep","trust","barrier"] as SentenceRole[], main: "keep", mainN: 20, closeN: 13, lead: "keep", leadN: 18, push: "none", pushN: 21 }, // 役目の出た数 keep:20 trust:15 barrier:7
  T2_question_fact: { n: 18, order: ["keep","answer","viewing","trust"] as SentenceRole[], main: "answer", mainN: 5, closeN: 5, lead: "ask_send", leadN: 4, push: "none", pushN: 11 }, // 役目の出た数 keep:5 answer:10 viewing:4 trust:5
  T3_question_staff_only: { n: 4, order: ["answer","promise","worry"] as SentenceRole[], main: "promise", mainN: 4, closeN: 1, lead: "keep", leadN: 2, push: "none", pushN: 3 }, // 役目の出た数 answer:1 promise:4 worry:1
  T4_property_shared: { n: 22, order: ["trust","promise","answer","estimate","keep"] as SentenceRole[], main: "promise", mainN: 8, closeN: 4, lead: "keep", leadN: 10, push: "none", pushN: 14 }, // 役目の出た数 trust:7 promise:14 answer:6 estimate:7 keep:7
  T5_ack_hypothesis: { n: 22, order: ["viewing","keep"] as SentenceRole[], main: "viewing", mainN: 5, closeN: 12, lead: "keep", leadN: 8, push: "none", pushN: 20 }, // 役目の出た数 viewing:5 keep:6
  T6_considering: { n: 22, order: ["keep","viewing","trust"] as SentenceRole[], main: "keep", mainN: 11, closeN: 5, lead: "keep", leadN: 10, push: "none", pushN: 17 }, // 役目の出た数 keep:14 viewing:7 trust:5
  T7_viewing: { n: 22, order: ["promise","answer","viewing"] as SentenceRole[], main: "viewing", mainN: 7, closeN: 3, lead: "viewing", leadN: 12, push: "none", pushN: 14 }, // 役目の出た数 promise:5 answer:12 viewing:8
  T8_cost: { n: 22, order: ["answer","keep","barrier","trust"] as SentenceRole[], main: "answer", mainN: 8, closeN: 4, lead: "keep", leadN: 7, push: "none", pushN: 13 }, // 役目の出た数 answer:9 keep:9 barrier:6 trust:6
  T9_apply_signal: { n: 22, order: ["answer","viewing","apply","worry"] as SentenceRole[], main: "apply", mainN: 8, closeN: 3, lead: "apply", leadN: 10, push: "mid", pushN: 9 }, // 役目の出た数 answer:11 viewing:6 apply:8 worry:5
};
const SCENE_TYPE: Record<string, string> = { conditions: "T1_conditions_first", property_share: "T4_property_shared", ack: "T5_ack_hypothesis", considering: "T6_considering", viewing: "T7_viewing", cost: "T8_cost", apply: "T9_apply_signal" };
/** 型を決める（場面×主の役目・決まった計算。道は使わない） */
export function orderTypeOf(scene: string | null | undefined, mainRole: SentenceRole | null | undefined): string | null {
  if (!scene) return null;
  if (scene === "question") return mainRole === "promise" ? "T3_question_staff_only" : "T2_question_fact";
  return SCENE_TYPE[scene] ?? null;
}
const PUSH_JA: Record<string, string> = { none: "押さない", weak: "弱（お気に召されましたら）", mid: "中（如何でしょうか・時間枠）", strong: "強（推奨・抑えましょうまで）" };
/** 主にした文のなぜ（どの読みから主を決めたか） */
export function mainWhyOf(u: TurnUnderstanding): string {
  const src = u.src.main;
  return src === "turn_read" ? "一通の読み（主と従）の主" : src === "turn_contract" ? "依頼の一番（turn_contract の lead_with）" : src === "intent" ? "お客様の意図" : "主なし";
}
export type OrderBasis = { type: string | null; order: SentenceRole[]; main: SentenceRole | null; mainWhy: string; why: string; applied: boolean };
/** 判断の根拠（off でも作る）と、on の時の並べ替え・注記の行 */
export function applyOrderTable(p: SentencePlan, u: TurnUnderstanding, scene: string | null | undefined, env?: Env): { plan: SentencePlan; basis: OrderBasis; noteLine: string } {
  const main = p.rows.find((r) => r.rank === "main") ?? null;
  const type = orderTypeOf(scene, main?.role ?? null);
  const row = type ? COMPOSE_ORDER_TABLE[type] : undefined;
  const on = composeOrderTableOn(env) && !!row && !!main;
  let rows = p.rows;
  if (on && row) {
    const idx = (r: SentenceRole) => { const i = row.order.indexOf(r); return i < 0 ? row.order.length : i; };
    const subs = p.rows.filter((r) => r.rank === "sub").map((r, k) => ({ r, k })).sort((a, b) => idx(a.r.role) - idx(b.r.role) || a.k - b.k).map((x) => x.r);
    rows = [...p.rows.filter((r) => r.rank === "main"), ...subs].map((r) => {
      if (r.rank === "sub" && ["viewing", "apply", "estimate"].includes(r.role) && !(r.how ?? "").includes("押す強さ") && !(r.how ?? "").includes("押さない")) return { ...r, how: [r.how, `押す強さ（この型の竹内さんの多い形 ${row.pushN}/${row.n}）: ${PUSH_JA[row.push] ?? row.push}`].filter(Boolean).join("／") };
      return r;
    });
  }
  const basis: OrderBasis = {
    type, order: rows.map((r) => r.role), main: main?.role ?? null, mainWhy: mainWhyOf(u),
    why: row ? `竹内さんの${type} ${row.n}通: 並び ${row.order.join(">")}・主 ${row.main} ${row.mainN}/${row.n}・誘導 ${row.lead} ${row.leadN}/${row.n}・締め ${row.closeN}/${row.n}` : "型の表に無い（198通に組が無い場面）",
    applied: on,
  };
  const noteLine = on && row ? `- この番の型（${type}・竹内さんの${row.n}通）: 従は ${row.order.map((r) => ROLE_LABEL[r]).join("→")} の順。締め（何卒 等）は${row.closeN * 2 >= row.n ? `付けるのが多い（${row.closeN}/${row.n}）` : `無しが多い（付けたのは ${row.closeN}/${row.n}）`}` : "";
  return { plan: { ...p, rows }, basis, noteLine };
}
/** digest に足す判断の根拠（短い形） */
export function orderBasisDigest(b: OrderBasis): string {
  return `型=${b.type ?? "-"}${b.applied ? "(on)" : ""}｜順=${b.order.join(">") || "-"}｜主=${b.main ?? "-"}（${b.mainWhy}）`;
}
