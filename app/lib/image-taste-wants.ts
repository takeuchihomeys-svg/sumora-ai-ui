// app/lib/image-taste-wants.ts — 好みの手本の画像の特徴を、AIX ツール（物件出し）のお客様の要望の欄に足す形を決める（純関数・DB/LLM なし）
//
// 2026-11-15 竹内さんの決定（KB 1d2400c6・確認事項 H-14 ②）: 好みの手本の画像（「こういうお部屋が良い」）は、好みを条件に足して約束の返信→物件の AIX。
//   さらに画像から取れる物件の特徴（白基調・広いリビング・築浅・ペット可・駅近 など）を AIX ツールの要望・条件の欄に反映する。
// 決まり:
//   ・要望は「その他」に1つずつ分ける・設備は設備の欄（こだわり preferences）（memory feedback_wants_itemized）
//   ・今ある要望と重ねない（言い方が違っても同じ物は足さない・customer-image-link.tasteAlreadyIn）・今ある節は1つも消さない（condition-merge.mergeFreeTextClauses）
//   ・好みと必須を分ける（memory feedback_must_have_conditions）: 画像の手本から取った物は「できれば」＝[必須] を付けない。印 [画像の好み] を付ける
//     （節の重なりの鍵 clauseKey は [..] を外して比べる＝後でお客様が言葉で同じ事を言っても二重にならない）
//   ・NG の欄に当たる物は足さない（お客様が嫌と言った事を好みにしない）
//   ・築年数・駅徒歩などの登録の数の欄（building_age・walk_minutes）は変えない（言い直しではない＝登録の条件そのものを直すのはお客様が言い直した時だけ・feedback_condition_change_permanent）
// 書くのは image-taste-wants-server.ts（既定 off: CUSTOMER_IMAGE_TASTE_WANTS=on）。
import { mergeFreeTextClauses } from "./condition-merge";
import { tasteAlreadyIn, type TasteFeature } from "./customer-image-link";

type Env = Record<string, string | undefined>;
export function imageTasteWantsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CUSTOMER_IMAGE_TASTE_WANTS ?? "").trim().toLowerCase() === "on";
}
export const TASTE_TAG = "[画像の好み]";
export type WantFields = { preferences?: string | null; other_requests?: string | null; ng_points?: string | null };
export type TasteUpdate = { updates: Partial<Record<"preferences" | "other_requests", string>>; added: string[]; skipped: Array<{ label: string; why: "already" | "ng" }> };

/** 好みの特徴 → 要望の欄に足す更新（足す物が無ければ updates は空） */
export function tasteWantUpdates(existing: WantFields, features: ReadonlyArray<TasteFeature>): TasteUpdate {
  const out: TasteUpdate = { updates: {}, added: [], skipped: [] };
  const cur = { preferences: existing.preferences ?? null, other_requests: existing.other_requests ?? null };
  const all = `${existing.preferences ?? ""}・${existing.other_requests ?? ""}`;
  for (const f of features) {
    if (tasteAlreadyIn(f, all) || out.added.includes(f.label)) { out.skipped.push({ label: f.label, why: "already" }); continue; }
    if (tasteAlreadyIn(f, existing.ng_points)) { out.skipped.push({ label: f.label, why: "ng" }); continue; }
    const merged = mergeFreeTextClauses(cur[f.field], `${f.label}${TASTE_TAG}`);
    if (merged && merged !== cur[f.field]) { cur[f.field] = merged; out.updates[f.field] = merged; out.added.push(f.label); }
  }
  return out;
}
