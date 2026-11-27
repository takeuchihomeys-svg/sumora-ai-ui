// app/lib/hook-points.ts — 送った物件のどの点がお客様に刺さったか（家賃・広さ・間取り・駅・新しさ・設備…）を、引用の返信から読む（純関数・LLM なし）
//
// 2026-11-21 作業員K2（台帳 #469 の (a)・統括役の決め）: 物件選び ← LINE の穴「刺さった点」。今の反応の記録（sent_properties.customer_reaction）は
//   良い／断りの2値だけで、どの点が刺さったかは判定にも🌟の並べ方にも届かない。
//   元: お客様がこちらの物件の通を引用して返した時（line-webhook-text.resolvePropertyReference）の、引用先の文とお客様の文。
//   読み方: 作業員16 の our-send-uptake（splitOurSend → readUptake の刺さりの網）をそのまま使う（新しい網を作らない）。網は候補の網で、決めるのはブレイン（P0 9eb6aa9c）。
//   ここでの使い方は判定の「像」の比べの軸の重みだけ（条件より弱い・加点だけ・上限は sent-like-fit の SENT_LIKE_RULE.max のまま）。
// ■ スイッチ
//   SENT_HOOK_POINTS … 引用の返信の時に sent_properties.customer_hook_points に残す（11/21 から既定 on・=off で止まる）
//   SENT_HOOK_WEIGHT=on … 🌟の像の比べ（STAR_SENT_LIKE=on の時）で、刺さった点の軸の点を2倍にする（既定 off）
// テスト: app/lib/__tests__/hook-points.test.ts
import { splitOurSend, readUptake, HOOK_POINTS, type HookPoint } from "@/app/lib/our-send-uptake";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
// 2026-11-21 統括役の決め（列を本番に当て・775eb95be が main 5de23bfd7 で READY の後）: 記録だけなので既定 on（=off で止まる）
export const sentHookRecordOn = (env: Env = envOf()) => String(env.SENT_HOOK_POINTS ?? "").trim().toLowerCase() !== "off";
export const sentHookWeightOn = (env: Env = envOf()) => String(env.SENT_HOOK_WEIGHT ?? "").trim().toLowerCase() === "on";

/** 引用先のこちらの文とお客様の返信 → 刺さった点（無ければ []）。刺さらなかった・断りの時は [] */
export function hookPointsOf(quotedText: string, replyText: string): HookPoint[] {
  const parts = splitOurSend(quotedText);
  if (!parts.length) return [];
  const ups = readUptake(parts, replyText);
  if (ups.some((u) => u.hook?.kind === "not_hooked")) return [];
  if (!ups.some((u) => u.hook?.kind === "hooked")) return [];
  // 網の刺さりの点は物件の名前の行（号室・🌟）だけを見るので、物件の通のオススメポイントの行（広さ・築年・駅）は拾わない。
  //   刺さった時は「お客様の文の点」と「引用先の文の全部の行の点」の重なりを刺さった点にする（重ならない点は入れない）
  const ours = new Set(parts.flatMap((p) => p.points));
  const theirs = splitOurSend(replyText.length >= 4 ? replyText : `${replyText}。。。`).flatMap((p) => p.points);
  return [...new Set(theirs.filter((x) => ours.has(x)))];
}

/**
 * 2026-11-26 作業員A（台帳 #793・刺さった点が全期間で 0 の原因）: お客様の引用の半分超（14日 7/13）は物件カードの画像＝引用先の文が「[画像]」だけで、
 *   splitOurSend が空＝hookPointsOf が必ず [] だった。画像の引用の時は、結び付いた送った物件の資料の文（売上サポの要約 summary_text・物件名と号室）を引用先の文の代わりにする。
 *   スイッチ SENT_HOOK_IMAGE_TEXT: 既定 on（記録だけ・customer_hook_points を書く時の読み元だけ）／off で前と同じ
 */
export const sentHookImageTextOn = (env: Env = envOf()) => String(env.SENT_HOOK_IMAGE_TEXT ?? "").trim().toLowerCase() !== "off";
export const isImageOnlyQuote = (q: string | null | undefined) => { const t = String(q ?? "").replace(/\[画像\]|\s/g, ""); return t.length < 4; };
/** 引用先の文の代わり（物件名・号室＋資料の要約）。資料が無ければ "" */
export function quotedTextForHook(propertyName: string | null | undefined, roomNo: string | null | undefined, summary: string | null | undefined): string {
  const head = [propertyName, roomNo].filter(Boolean).join(" ");
  const body = String(summary ?? "").trim();
  return body ? `${head ? `【${head}】\n` : ""}${body}` : "";
}

/** 保存された値を読む（知らない語は捨てる） */
export function normalizeHookPoints(raw: unknown): HookPoint[] {
  const xs = Array.isArray(raw) ? raw : [];
  return [...new Set(xs.filter((x): x is HookPoint => typeof x === "string" && (HOOK_POINTS as readonly string[]).includes(x)))];
}

/** 像の比べの軸（sent-like-fit）→ その軸を重くする刺さった点 */
export const AXIS_OF_HOOK: Readonly<Record<"plan" | "area" | "age" | "walk", HookPoint>> = { plan: "広さ・間取り", area: "広さ・間取り", age: "新しさ", walk: "駅・場所" };
