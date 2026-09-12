// app/lib/aix-task-link.ts
// AIX の送信と「やること（line_tasks）」・物件出しの完了（✅）の対応表（2026-09-12 竹内方針）。
//   「AIX 物件オススメ・物件ピックアップで送ったときに物件出し完了となる。ここちゃんとリンクさせる」
//   旧: AIX を何か1つ送ると、その会話の未完了タスクを種類を問わず全部完了にしていた
//       （名無しの権兵衛さんに「内覧へ！」を送っただけで「✅【物件出し 完了】」が売上番長グループに流れた）。
//   物件出しの完了・一覧の✅・物件出し顧客の送付記録は、すべてこの表だけを見る。依存なし（画面・API どちらからも使える）。

/** 物件を届けた AIX（物件出しの完了になる AIX） */
export const PROPERTY_DELIVERY_AIX: readonly string[] = ["property_send", "property_recommendation"];

export function isPropertyDeliveryAix(aixType: string | null | undefined): boolean {
  return !!aixType && PROPERTY_DELIVERY_AIX.includes(aixType);
}

/**
 * その AIX を送った時に完了にする「やること」の種類。
 *   物件出し（property_send）  ← 物件ピックアップした／物件オススメ
 *   物件確認（property_check） ← 物件確認した（結果の報告。確認します＝管理会社への依頼では完了しない）
 *   見積書対応（estimate_sheet）← 見積書送る
 *   それ以外の AIX（内覧へ！・待ち合わせ・申込へ！ 等）は、どのやることも完了にしない
 */
export function taskTypesCompletedByAix(aixType: string | null | undefined): string[] {
  if (isPropertyDeliveryAix(aixType)) return ["property_send"];
  if (aixType === "property_check_result") return ["property_check"];
  if (aixType === "estimate_sheet") return ["estimate_sheet"];
  return [];
}
