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

/**
 * スタッフの未履行の宣言 → それを履行する AIX（ブレインの AIX 判断基準・2026-09-12 竹内）。
 *   「見積書送る宣言したら AIX 見積書送る をセットする。これも AIX でセットした状態。LINE グループにアナウンスするまでがセット」
 *   会話の最後がスタッフの宣言（まだ履行していない）の時だけ:
 *     見積書の宣言（estimate_declared）            → estimate_sheet（見積書送る）
 *     今ピックアップする宣言（pickup_declared）      → property_send（物件ピックアップした）
 *   「新着が出次第お送り」のような条件付き（次第）の宣言は、いつ届けるか決まっていないので対象外（毎回の締めに AIX が付くのを防ぐ）。
 *   宣言の判定は action-ledger（classifyStaffTextForLedger・buildActionLedger）と同じ結果を使う。
 */
export function resolveStaffPromiseAix(
  facts: {
    lastStaffEntry: { kind: string; status: string; evidence?: string | null } | null;
    estimatePromisedUnfulfilled: boolean;
    pickupPromisedUnfulfilled: boolean;
  },
  messages: ReadonlyArray<{ sender: string; text?: string | null }>,
): { action: "estimate_sheet" | "property_send"; kind: "estimate" | "pickup" } | null {
  const last = [...messages].reverse().find((m) => {
    const t = (m.text ?? "").trim();
    return t && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test(t);
  });
  if (!last || last.sender !== "staff") return null;
  const e = facts.lastStaffEntry;
  if (!e || e.status !== "promised") return null;
  if (e.kind === "estimate_declared" && facts.estimatePromisedUnfulfilled) return { action: "estimate_sheet", kind: "estimate" };
  if (e.kind === "pickup_declared" && facts.pickupPromisedUnfulfilled && !/次第/.test(e.evidence ?? "")) return { action: "property_send", kind: "pickup" };
  return null;
}
