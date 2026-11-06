// app/lib/reply-direction-keep.ts — 返信の番のブレインの方向の文に、竹内さんの形の継続の約束を1文足す（純関数）
//
// 2026-11-06 作業員9（弱い所 322・統括役の決め）: KB「書き手は下に足した注記より、ブレインの方向の文そのものに従う」の型。
//   2段:pickup の方向の文（two-stage PICKUP_DIRECTION_KEEP）はブレインが「返信」を選ぶ番（試験 q008 の 3/4）に届かない＝返信の番の reply_direction にも同じ1文を足す。
//   線（竹内さんの送信 1,211通・takeuchi_compose_examples）: 条件の番（AIX の後でない）で継続の約束を入れたのは 106/180＝59%（過半数）。
//   了承・検討の番（9〜12%）・物件への感想の番（q174）には入れない。同じ日にこちらがもう言っていれば入れない（KB 1d07b3df）。
// 切替: REPLY_DIRECTION_KEEP（11/06 既定 on・=off で止める）。テスト: app/lib/__tests__/reply-direction-keep.test.ts
import { hasKeepPromise } from "./reply-compose-conductor";

type Env = Record<string, string | undefined>;
export function replyDirectionKeepOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REPLY_DIRECTION_KEEP ?? "").trim().toLowerCase() !== "off"; // 2026-11-06 既定 on（keep-line-on: 初回 q019 3/4→4/4・2回目以降は足さない・悪化0・統括役の決め）
}
const LOOK_RE = /一旦見て|見てみたい|見てみます|気になります|気になってます|良さそう|いいですね|綺麗ですね/;
export const KEEP_LINE = "〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
// 2026-11-06 線（竹内さんの条件の番 180通・読むだけ）: 初回（はじめまして）は 86通中 80% で添える・2回目以降の言い直しは 94通中 39%（少数＝決まりで足すと誤る）。
//   2回目以降は近い竹内さんの番の過半数（anatomy.keep・nearKeepShare>0.5）の時だけ。「ピックアップ出来次第お送り」で締めた20通は 0%（締めの言い方の別の形）
export function replyDirectionWithKeep(o: { direction: string | null; scene: string | null; customerText: string; staffToday: ReadonlyArray<string>; firstContact?: boolean; nearKeepShare?: number | null }, env?: Env): string | null {
  if (!o.direction || !replyDirectionKeepOn(env)) return o.direction;
  if (o.scene !== "conditions") return o.direction;
  if (LOOK_RE.test(o.customerText)) return o.direction;
  if (o.staffToday.some((t) => hasKeepPromise(t))) return o.direction;
  if (hasKeepPromise(o.direction)) return o.direction;
  if (!o.firstContact && !((o.nearKeepShare ?? 0) > 0.5)) return o.direction;
  return `${o.direction}（約束の後・締めの前に、竹内さんの実送信の形の継続の約束を1文だけ入れる「${KEEP_LINE}」・約束の中身は省かない）`;
}

/**
 * 2026-11-06 作業員9（弱い所 61・統括役の決め 案2）: 返信の番のブレインの方向の文にも「『一旦見てみたい』は内覧の依頼ではない」を足す。
 *   2段の方向の文の線（two-stage PICKUP_DIRECTION_NO_VIEWING）は、ブレインが「返信」を選んだ番（試験 q174-ab #2）に届かない＝返信の方向にも同じ1文。
 *   お客様の発言が物件への感想（一旦見てみたい・良さそう・綺麗ですね）で、内覧・見学をはっきり頼んでいない番だけ。
 * 切替: REPLY_DIRECTION_NO_VIEWING=on の時だけ（既定 off）。
 */
export function replyDirectionNoViewingOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REPLY_DIRECTION_NO_VIEWING ?? "").trim().toLowerCase() !== "off"; // 2026-11-06 既定 on（q174-guard: q087・q129 確かな悪化0・統括役の決め）
}
const EXPLICIT_VIEWING_RE = /内覧|内見|見学/;
export function replyDirectionWithNoViewing(o: { direction: string | null; customerText: string }, env?: Env): string | null {
  if (!o.direction || !replyDirectionNoViewingOn(env)) return o.direction;
  if (!LOOK_RE.test(o.customerText) || EXPLICIT_VIEWING_RE.test(o.customerText)) return o.direction;
  return `${o.direction}（お客様の「一旦見てみたい」「良さそう」等は物件への感想で内覧の依頼ではない＝内覧・内覧の可否の確認・申込・お部屋を押さえる一文を足さない。竹内さんは新たにピックアップしてお送りする約束だけ）`;
}
