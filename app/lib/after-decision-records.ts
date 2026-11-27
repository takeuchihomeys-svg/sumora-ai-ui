// app/lib/after-decision-records.ts — 判断の後に決まった計算で作る記録（ブレインの出力の欄にはしない・turn-aims-after と同じ形・純関数・2026-11-27 作業員A）
//
// 統括役の頼み（11/27・受け持ち表の土台の穴）: 葉「入居の時期と期限」の反映が0・葉「次に来る LINE の見込み」の持つが0。
//   大事な線: ブレインの出力に欄を足すと道が引かれた前例（q406・q065・turn-aims の凍結）＝ここは判断の後に、決まった計算で記録を作るだけ。判断・文は変えない。
//   ① 入居の期限に向いた一手か（1語）: 入居の希望日と申込の目安（time-map の APPLY_LEAD_DAYS＝入居の30〜14日前）と、ブレインが選んだ一手を並べる
//   ② 次に来やすい通の種類の上位2つ: #804 の分かれ道の表（竹内さん本人の番・60日・木の深さ3の数）から。予想の当て物ではなく「備え」＝次の通が来た時に当たったかを数える
// スイッチ AFTER_DECISION_RECORDS（既定 off）: on の時だけ meta.after_records に残す（digest.mif・digest.nl）
import { APPLY_LEAD_DAYS } from "./time-map";

type Env = Record<string, string | undefined>;
export const afterDecisionRecordsOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.AFTER_DECISION_RECORDS ?? "").trim().toLowerCase() === "on";

// ── ① 入居の期限に向いた一手か ───────────────────────────
/** 申込へ向かう一手（物件確認・見積・内覧・待ち合わせ・申込の案内） */
const TOWARD_APPLY = new Set(["application_push", "viewing_invite", "meeting_place", "estimate_sheet", "property_check_result", "greeting_viewing"]);
export type MoveInFit = "期限なし" | "余裕あり" | "期限に向く" | "期限の内で外れ" | "期限を過ぎて向く" | "期限を過ぎた";
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** 入居の希望日（YYYY-MM-DD・分からなければ null）・今日・選んだ AIX（返信は null） */
export function moveInFitOf(o: { moveInYmd: string | null | undefined; todayYmd: string; finalAix: string | null | undefined }): MoveInFit {
  if (!o.moveInYmd) return "期限なし";
  const from = addDays(o.moveInYmd, -APPLY_LEAD_DAYS.from), to = addDays(o.moveInYmd, -APPLY_LEAD_DAYS.to);
  const toward = !!o.finalAix && TOWARD_APPLY.has(o.finalAix);
  if (o.todayYmd < from) return "余裕あり";
  if (o.todayYmd <= to) return toward ? "期限に向く" : "期限の内で外れ";
  return toward ? "期限を過ぎて向く" : "期限を過ぎた";
}

// ── ② 次に来やすい通の種類の上位2つ ───────────────────────
/** #804 の分かれ道の表（audit-scene-branches --tree-out・60日・竹内さん本人の番・2026-11-27 の木）。n≥5 の節だけ。作り直すのは scripts/build-next-line-table.ts（同じ木から） */
export const NEXT_LINE_TABLE: Readonly<Record<string, { n: number; top: readonly string[] }>> = {
  "inquiry": { n: 14, top: ["お礼・了承","返事なし"] },
  "inquiry > （状態なし）": { n: 11, top: ["お礼・了承","返事なし"] },
  "分:screening_concern": { n: 10, top: ["お礼・了承","質問"] },
  "分:screening_concern > apply_screening_worry": { n: 10, top: ["お礼・了承","質問"] },
  "proposing": { n: 33, top: ["質問","返事なし"] },
  "proposing > （状態なし）": { n: 26, top: ["質問","返事なし"] },
  "分:brought_property": { n: 28, top: ["お礼・了承","質問"] },
  "分:brought_property > brought_vacancy": { n: 27, top: ["お礼・了承","質問"] },
  "viewing_arrange": { n: 14, top: ["お礼・了承","質問"] },
  "viewing_arrange > （状態なし）": { n: 12, top: ["お礼・了承","質問"] },
  "viewing_scheduled": { n: 19, top: ["質問","お礼・了承"] },
  "viewing_scheduled > （状態なし）": { n: 18, top: ["質問","その他"] },
  "分:move_in_later": { n: 7, top: ["質問","お礼・了承"] },
  "estimate": { n: 16, top: ["質問","お礼・了承"] },
  "estimate > （状態なし）": { n: 12, top: ["質問","お礼・了承"] },
  "分:condition_change": { n: 17, top: ["お礼・了承","その他"] },
  "分:condition_change > （状態なし）": { n: 14, top: ["お礼・了承","その他"] },
  "pickup": { n: 27, top: ["お礼・了承","質問"] },
  "pickup > （状態なし）": { n: 23, top: ["お礼・了承","質問"] },
  "hearing": { n: 21, top: ["お礼・了承","その他"] },
  "hearing > （状態なし）": { n: 7, top: ["お礼・了承","その他"] },
  "interested": { n: 7, top: ["お礼・了承","返事なし"] },
  "interested > （状態なし）": { n: 6, top: ["お礼・了承","返事なし"] },
  "hearing > cost_over_budget": { n: 6, top: ["その他","返事なし"] },
  "hearing > apply_screening_worry": { n: 5, top: ["お礼・了承","その他"] },
};
/** 表全体の上位2つ（比べる時の物差し＝どの場面でも同じ2つを言った時の当たり） */
export const NEXT_LINE_BASE: readonly string[] = ["お礼・了承", "質問"];
/** 駅（分かれ道は「分:<id>」）と細かい状態から、上位2つ（細かい節に n が無ければ駅に戻る・無ければ null） */
export function nextLineTopOf(station: string | null | undefined, sub: string | null | undefined): { key: string; top: readonly string[] } | null {
  if (!station) return null;
  const k2 = `${station} > ${sub ?? "（状態なし）"}`;
  if (NEXT_LINE_TABLE[k2]) return { key: k2, top: NEXT_LINE_TABLE[k2].top };
  if (NEXT_LINE_TABLE[station]) return { key: station, top: NEXT_LINE_TABLE[station].top };
  return null;
}
export type AfterRecords = { mif: MoveInFit; nl: readonly string[] | null; nlKey: string | null };
export function buildAfterRecords(o: { moveInYmd: string | null | undefined; todayYmd: string; finalAix: string | null | undefined; station: string | null | undefined; sub: string | null | undefined }): AfterRecords {
  const nl = nextLineTopOf(o.station, o.sub);
  return { mif: moveInFitOf(o), nl: nl?.top ?? null, nlKey: nl?.key ?? null };
}
