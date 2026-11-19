// app/lib/material-on-hand.ts — ブレインが「材料に無かった」と言った物（material_missing・mm）が、実は手元にあった番の印（純関数・作業員22・2026-11-13）
//
// 統括役 11/13（点検役の文の組み立ての点検・案3 押さえの事実の出所）: mm の鍵を、物件の資料・送れる候補（pickup_ready）と結び付けて、
//   「mm に出た物が実は手元にある」番に印を付ける。実例 12548（床の色・空室は資料にあった）・12838（送れる候補があった）。
//   手元にあったのに無いと言った＝材料は届いていたのに読めていない（届き方の分けの c に近い）。手元に無い＝本当に材料が届いていない（a・b）。
// 見方: mm の1つずつを、ブレインに渡した材料の文（user の文の塊を全部つないだ物）と突き合わせる（語の芯がそのまま入っているか、芯の2字の組の半分以上が入っている）。
//   物件・候補・送れる 等の言葉の mm は、送れる候補（pickup_ready）が true なら手元にある。
// スイッチ: MATERIAL_ON_HAND（既定 off・shadow で meta.material_on_hand と digest.mh に記録だけ）。判断は変えない。
type Env = Record<string, string | undefined>;
export const materialOnHandMode = (env: Env = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" => { const v = (env.MATERIAL_ON_HAND ?? "").trim().toLowerCase(); return v === "shadow" || v === "on" ? "shadow" : "off"; };

export type OnHand = { item: string; onHand: boolean; where: "material" | "pickup_ready" | null };
const STOP = new Set(["物件", "お部屋", "部屋", "情報", "状況", "確認", "お客様", "こちら", "材料", "内容", "有無"]);
export const wordsOf = (t: string): string[] => [...new Set((t.match(/[一-龠々ァ-ヶー]{2,}/g) ?? []).filter((w) => !STOP.has(w)))];
const PICKUP_RE = /送れる|候補|ピックアップ|新着|空室の物件|オススメ/;

export function markOnHand(mm: ReadonlyArray<string>, materialsText: string, pickupReady: boolean | null | undefined): OnHand[] {
  const text = materialsText.normalize("NFKC");
  return mm.filter((x) => typeof x === "string" && x.trim()).map((item) => {
    if (PICKUP_RE.test(item) && pickupReady === true) return { item, onHand: true, where: "pickup_ready" };
    // 語の芯（末尾の「状況・有無・情報・確認」を外す）がそのまま材料にあるか、芯の2字の組（漢字かカタカナを含む物）の半分以上が材料にあるか
    const core = item.normalize("NFKC").replace(/\s+/g, "").replace(/(?:の)?(?:状況|有無|情報|について|確認|詳細)$/, "");
    const grams = [...new Set(Array.from({ length: Math.max(0, core.length - 1) }, (_, i) => core.slice(i, i + 2)).filter((g) => /[一-龠々ァ-ヶー]/.test(g)))];
    const share = grams.length ? grams.filter((g) => text.includes(g)).length / grams.length : 0;
    const onHand = core.length >= 2 && (text.includes(core) || share >= 0.5);
    return { item, onHand, where: onHand ? "material" : null };
  });
}
/** digest.mh の1行: 手元にあった数/mm の数（例 "2/3"） */
export const onHandDigest = (v: unknown): string | null => (Array.isArray(v) && v.length ? `${(v as OnHand[]).filter((x) => x.onHand).length}/${v.length}` : null);
