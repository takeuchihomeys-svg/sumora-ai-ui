// app/lib/aix-sendback.ts — AIX の統括からの差し戻しを、LINE の統括（ブレイン）が読み直す時の材料の1行（純関数）
//
// 2026-10-29 竹内さん（KB 7bbb1760: LINE の統括と AIX の統括をしっかりつなぐ）・作業員1の AixVerdict.sendBack（aix-desk-types.ts）と合わせた形。
//   AIX の統括が「AIX の番ではない（not_aix）／今は結果が無いので約束の返信にすべき（promise）」と返した時、ブレインをもう1回だけ呼び、
//   この1行を材料に入れる。決めるのはブレイン（P0）＝決まった書き換え（finalAix を約束に置き換える等）はしない。読み直しは1番につき1回まで。
// テスト: app/lib/__tests__/aix-sendback.test.ts
export type AixSendBack = { kind: "not_aix" | "promise"; why: string };

export function sendBackMaterialLine(sb: AixSendBack | null | undefined, firstAix: string | null | undefined): string {
  if (!sb || !String(sb.why ?? "").trim()) return "";
  const what = sb.kind === "promise"
    ? "今は返せる結果・物が無いので、AIX ではなく確かめる・探す約束の返信にすべき"
    : "この番は AIX の番ではない（返信で答えられる・AIX で送る物が無い）";
  return `【AIX の統括からの差し戻し（材料・1回だけの読み直し）】あなたの最初の判断${firstAix ? `（AIX ${firstAix}）` : ""}について、AIX の担当が「${what}」と返した。理由: ${String(sb.why).replace(/\s+/g, " ").slice(0, 120)}。会話をもう一度読み、同じ連投の他の依頼も落とさないように決め直す（差し戻しが会話と合わない時は最初の判断のままでよい）。`;
}
