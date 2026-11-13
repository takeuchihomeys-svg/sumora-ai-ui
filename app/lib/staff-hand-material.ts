// app/lib/staff-hand-material.ts — 「スタッフの手元にある物」を材料の1行にする（純関数・DB/LLM なし・2026-11-13 作業員C）
//
// 統括役の頼み①（組の違いの14日の監査 scripts/audit-combo-mismatch.ts・竹内さん本人の番の「道が違う・土台」）:
//   竹内さんは返信や約束でなく、すぐ AIX を送っていた番があった（約束した物件のリンク 2d7548d5・確認の結果 a8c55dde・見積書 65c2df5b）。
//   どの番も、その時点で記録に「送れる候補（property_pickups の pending・まだ送っていない）」や「開いている約束」があったが、ブレインには
//   「人の手元にあるからこの場で AIX で果たせる」という形で届いていなかった。P0 ca55d42b（人だけが知る情報は AIX で送る）。
//   どの欄から取れるか・届いていなかった理由（2026-11-13 本番の DB で確かめた）:
//     送れる候補 … property_pickups（status=pending・最後の送付より後）＝ brain-core の pickupReadyMaterial（既定で計算済み）。
//                  材料の行は SITUATION_NOW_FULFILLABLE（既定 off）と全力サポートの候補の中だけ＝「指示文で使われない・off」
//     作業中のタスク … line_tasks（status=pending）＝【この会話の未完了タスク】として届くが「next_steps を考慮」だけ＝ AIX で果たすという意味が無い
//     開いている約束 … 行動台帳 facts（pickup／estimate／confirmation の未履行）＝届いているが、果たせる物と並べていない
//     確認の結果・見積の金額そのもの … 記録に無い。line_tasks.result は 30日で 0/247（書く所が無い＝欄はあるが配線が無い）。
//                  estimate_records は AIX を送った時に作られる（送る前の「出来た」は残らない）＝この行では言わない（決めつけない）
//   判断はブレイン（返信か AIX か・どの AIX か）。この行は事実を並べるだけ。既定 off（BRAIN_STAFF_HAND=on）。
type Env = Record<string, string | undefined>;
export function staffHandMaterialOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_STAFF_HAND ?? "").trim().toLowerCase() === "on";
}

const TASK_JA: Record<string, string> = { property_check: "物件確認（募集状況）", estimate_sheet: "見積書", property_send: "物件の送付" };
export type StaffHand = {
  /** 送れる新しい候補（property_pickups の pending・最後の送付より後）。null は見ていない */
  pickupReady: boolean | null;
  /** 作業中のタスク（line_tasks の pending）の種類 */
  openTaskTypes: ReadonlyArray<string>;
  /** まだ果たしていない約束（行動台帳） */
  openPromises: { pickup: boolean; estimate: boolean; confirm: boolean };
};

/** 材料の1行（何も無ければ ""） */
export function staffHandLine(h: StaffHand): string {
  const parts: string[] = [];
  if (h.pickupReady === true) parts.push("送れる新しい候補あり（ピックアップ済み・まだ送っていない）");
  const tasks = [...new Set(h.openTaskTypes.map((t) => TASK_JA[t] ?? t))];
  if (tasks.length) parts.push(`作業中: ${tasks.join("・")}`);
  const pr = [h.openPromises.pickup ? "ピックアップ" : "", h.openPromises.estimate ? "見積書" : "", h.openPromises.confirm ? "募集状況の確認" : ""].filter(Boolean);
  if (pr.length) parts.push(`まだ果たしていない約束: ${pr.join("・")}`);
  if (!parts.length) return "";
  return `- スタッフの手元（記録から・人だけが知る物）: ${parts.join("／")}。人だけが知る情報（物件・確認の結果・見積の金額）は返信で中身を書かず AIX で送る（P0）。手元にある物で今果たせるなら AIX、まだ無い物は約束`;
}
