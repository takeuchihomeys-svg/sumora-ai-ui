// app/lib/counter-kitchen-image-judge.ts — カウンターキッチンの画像の読み（property_pickups.image_facts.counter_kitchen）を物件の判定の設備の照合に受ける（純関数・既定 off）
//
// 2026-11-21 作業員K2（統括役の頼み・作業員G の画像の読み COUNTER_KITCHEN_IMAGE_READ・2案目 78ba49509 の目の監査 22件・誤り0）。
//   資料の文字でカウンターキッチンが「記載なし（unlisted）」の候補に、G が画像を読んで image_facts.counter_kitchen を入れる（true＝有る・false＝無い・null＝分からない）。
//   判定は資料の文字だけで作られた後なので、その値を設備の照合の行（want.key=counter_kitchen・result=unlisted）に当て、
//   既存の property-brain.applyEquipmentMatch で点・判定・理由を付け直す（true は ok・false は ng・null は今まで通り unlisted）。
//   当てるのは送る前の候補（pickup-rejudge-equipment と同じ道・お客様がカウンターキッチンを希望している行だけ＝照合の行がある行）。
// ■ スイッチ COUNTER_KITCHEN_IMAGE_JUDGE: 既定 off／on
// テスト: app/lib/__tests__/counter-kitchen-image-judge.test.ts
import type { EquipmentMatch } from "./listing-equipment";

type Env = Record<string, string | undefined>;
export function counterKitchenImageJudgeOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.COUNTER_KITCHEN_IMAGE_JUDGE ?? "").trim().toLowerCase() === "on";
}

/** 画像の読みの値（true／false／それ以外は null） */
export function counterKitchenImageValue(imageFacts: unknown): boolean | null {
  const v = imageFacts && typeof imageFacts === "object" ? (imageFacts as Record<string, unknown>).counter_kitchen : null;
  return v === true ? true : v === false ? false : null;
}

/** 照合のカウンターキッチンの行が unlisted で、画像の読みが決まっている時だけ、その行を ok／ng にした照合を返す（変わらない時は null） */
export function applyCounterKitchenImage(m: EquipmentMatch, imageVal: boolean | null): EquipmentMatch | null {
  if (imageVal == null) return null;
  let changed = false;
  const rows = m.rows.map((r) => {
    if (r.want.key !== "counter_kitchen" || r.result !== "unlisted") return r;
    changed = true;
    const ok = r.want.mode === "ng" ? !imageVal : imageVal;
    return { ...r, result: (ok ? "ok" : "ng") as "ok" | "ng", mark: ok ? "○" : "×", why: imageVal ? "画像（間取り図・資料の画像）でカウンターキッチンと読めた" : "画像（間取り図・資料の画像）で壁付けと読めた" };
  });
  if (!changed) return null;
  return {
    rows,
    ok: rows.filter((r) => r.result === "ok").length,
    ng: rows.filter((r) => r.result === "ng").length,
    unlisted: rows.filter((r) => r.result === "unlisted").length,
    strongNg: rows.some((r) => r.result === "ng" && r.want.strong),
  };
}
