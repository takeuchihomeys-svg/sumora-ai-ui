// app/lib/compose-plan-reuse.ts — 文の設計図（compose_plan）を、判断を使い回した番でも前の判断の meta から作ってよいか（純関数・DB/LLM なし）
//
// 2026-11-24 作業員A（竹内さん 11/24「まだ off の部分も、統括の土台をちゃんと細分化して…on にできるものも多い」・統括役の決め・台帳の off の理由の分け 3cd458f89 の上位1）:
//   設計図は generate-reply で brainLocalFresh（今の発言を見た新しい判断・取り置きでない）の番にしか作られず、7日の下書き 128 のうち 9 にしか無かった（KB 89672025）。
//   そのため設計図を読む部品（compose-*.ts の10行・地図で設計図を読む #306・#343）が、まとめて止まっている。
//   COMPOSE_PLAN_REUSE（既定 off）:
//     cached … 今の発言の後の判断だが取り置き（source=cached・enforcement_level=optional）の番だけ使い回す（同じ番の判断＝取り違えが起きにくい）
//     on     … cached に加えて、今の発言より前の判断（not_fresh）でも使い回す（別の発言の読みが混ざりうる＝試験で確かめてから）
//   作る材料は前の判断の meta だけ（buildSentencePlan は純関数）＝LLM の呼び出しは増えない。
//   物差し: 見張りの compose_plan_skip の理由の数（generate-reply・c89fbc471）と、使い回した番の印 compose_plan_reuse（cached／stale）・連携の見張りの設計図の届き（今 4〜5%）
type Env = Record<string, string | undefined>;
export type ComposePlanReuseMode = "off" | "cached" | "on";
export function composePlanReuseMode(env: Env = typeof process !== "undefined" ? process.env : {}): ComposePlanReuseMode {
  const v = (env.COMPOSE_PLAN_REUSE ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "cached" ? "cached" : "off";
}
export type ComposePlanGate = { ok: boolean; reused: null | "cached" | "stale" };
/**
 * 設計図を作ってよいか。fresh＝今の発言を見た判断（brainFreshForMessage）・cached＝取り置きの判断（isCachedMeta）。
 * 新しい判断（fresh かつ取り置きでない）は今まで通り作る。off の時は今と1つも変わらない。
 */
export function composePlanGate(i: { fresh: boolean; cached: boolean; hasMeta: boolean }, mode: ComposePlanReuseMode = composePlanReuseMode()): ComposePlanGate {
  if (!i.hasMeta) return { ok: false, reused: null };
  if (i.fresh && !i.cached) return { ok: true, reused: null };
  if (mode === "off") return { ok: false, reused: null };
  if (i.fresh && i.cached) return { ok: true, reused: "cached" };
  if (!i.fresh && mode === "on") return { ok: true, reused: "stale" };
  return { ok: false, reused: null };
}
