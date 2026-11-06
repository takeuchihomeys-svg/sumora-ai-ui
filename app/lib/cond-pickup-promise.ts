// app/lib/cond-pickup-promise.ts — 条件の番の最初の一手を竹内さんの形に（ブレインの決まりの1行・純関数・DB/LLM なし）
//
// 2026-11-06 作業員4（統括役の決め・P0「判断はすべてブレイン」・P0 2e164f41「限りなく竹内さんに近づける」）:
//   竹内さんの番の本番の再生 tk1106（10/28 以降・9番）で、最終の道は 9/9 当たりなのに、ブレインの本質（最初の答え）は 3/9。
//   条件を言った・言い直した番で本質が AIX【物件送付】（4番）、初回に条件つきの番で本質が AIX【条件ヒアリング】（1番）になり、
//   決まった計算（2段の網・guard:first_contact）が約束の返信に直して当てていた＝判断を決まった計算が肩代わり。
//   根: ブレインの「AIX ボタン担当場面マップ」の property_send ①②（ヒアリング完了直後・条件の変更）が、今すぐ送る番のように読める。
//   竹内さんの送信: 「〜全域から…〇〇さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！」（その条件で探す約束）。
//   切替: BRAIN_COND_PICKUP_PROMISE（①）・BRAIN_FIRST_COND_PICKUP（②）。11/06 から既定 on（=off で止める）。確かめの物差しは本質の当たり（brain-exam の本質の道）。
// テスト: app/lib/__tests__/cond-pickup-promise.test.ts
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
// 2026-11-06 統括役の決め（試験 cond1-on・cond2-on: 狙った番の本質 1/5→3/5・q347 ○・守り q351・q107・q101 悪化0）: 既定 on。止める =off
const notOff = (v: string | undefined) => (v ?? "").trim().toLowerCase() !== "off";
export const condPickupPromiseOn = (env: Env = envOf()) => notOff(env.BRAIN_COND_PICKUP_PROMISE);
export const firstCondPickupOn = (env: Env = envOf()) => notOff(env.BRAIN_FIRST_COND_PICKUP);

export const COND_PICKUP_PROMISE_RULE = "【竹内さんの形・条件の番（11/06）】お客様が新しい条件・条件の言い直し・似た物件の依頼・地域や環境の希望を送ってきた番の最初の一手は、その条件で探してお送りする約束の返信（2段:pickup・竹内さんの言い方「〜全域から…〇〇さんにオススメできるお部屋ピックアップしてお送りさせて頂きます」）。AIX【物件送付】（property_send）にするのは、その条件で探した送れる物件が材料（売上サポの送れる候補）に既にある番だけ。上の場面マップの property_send ①②も、送れる物件が材料にある時の話。";
export const FIRST_COND_PICKUP_RULE = "【竹内さんの形・初回に条件つき（11/06）】初回の番は、材料の【初回の条件】の行に従う: 「そろっている」なら AIX【条件ヒアリング】にしない＝初回の挨拶＋その条件でピックアップしてお送りする約束の返信（2段:pickup）。「まだそろっていない」なら AIX【条件ヒアリング】。そろっているかの数え方は会社の1か所（hearing-form.pickupConditionsReady・作業員1）で、ここでは数えない。";

/** ブレインの決まりに足す行（スイッチが on の物だけ・無ければ ""） */
export function condPickupRules(env: Env = envOf()): string {
  return [condPickupPromiseOn(env) ? COND_PICKUP_PROMISE_RULE : "", firstCondPickupOn(env) ? FIRST_COND_PICKUP_RULE : ""].filter(Boolean).join("\n");
}

/** 2026-11-06 統括役の決め: ②の「初回で条件がそろったか」は hearing-form.pickupConditionsReady の1か所で数える（自分で数えない）。その答えを材料の1行にする */
export function firstCondMaterialLine(r: { ready: boolean; missing?: ReadonlyArray<string> } | null | undefined): string {
  if (!r) return "";
  const ja: Record<string, string> = { area: "エリア", rent: "家賃" };
  return r.ready ? "【初回の条件】ピックアップに要る条件はそろっている" : `【初回の条件】まだそろっていない（足りない: ${(r.missing ?? []).map((m) => ja[m] ?? m).join("・") || "不明"}）`;
}
