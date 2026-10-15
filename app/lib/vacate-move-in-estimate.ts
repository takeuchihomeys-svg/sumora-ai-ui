// app/lib/vacate-move-in-estimate.ts — 退去予定のお部屋の「最短の入居時期の目安」を退去予定日から逆算する（純関数・DB/LLM なし）
//
// 2026-10-15 竹内さんの決定②「退去予定の物件の最短の入居時期の目安は返信で答えてよい。ちゃんと逆算して入れる」
//   退去予定日 ＋ 退去後の工事（クリーニング・鍵交換・原状回復）の期間 ＝ 最短の入居時期の目安（旬で言う）。
//   確定の日は退去後の業者の手配で決まる＝確定は AIX【確認した→入居可能日】・目安は返信（ブレインの「入居日の確定は AIX」の線とぶつけない）。
//
// ■ 期間の根拠（scripts/audit-vacate-movein-gap.ts・150日・退去と入居の語のあるスタッフの送信 29通）
//   工事の期間をそのまま書いた文: 竹内さん「退去後クリーニング、鍵交換完了後ご入居可能です！！2週間〜3週間程必要となります」(749c5559 09-13)／
//     「退去後のクリーニング・鍵交換で通常2〜3週間程かかり」(5254182a 06-27)／「内装クリーニングが2週間から3週間程…早ければ2週間後遅くても1ヶ月後」(749c5559 06-09)
//   退去予定日 → 答えた最短の入居時期: 10月末→11月中旬〜下旬（竹内さん 8590144d 09-23・従業員 22b2511e 09-18）／9月末→10月中旬（竹内さん 22b2511e 08-31）／
//     9/29→10月下旬（竹内さん）／7/20→8月中旬（竹内さん）／8/30→9月中旬／8/19→9月上旬／7/31→8月下旬／6/20→7/4／6月末→7月下旬
//   ＝ 2週間〜4週間（14〜28日）を足して旬で言う。日付が分からない（「退去予定」だけ・旬だけ）時は逆算しない＝今まで通り確認の約束。
//   竹内さんは具体の日（「早くて何日から」）には「退去後の室内状況で業者の手配が変わるので、退去後まで期間は分からない」と答えた（8590144d 09-23）。
// 戻す: VACATE_MOVE_IN_ESTIMATE=off
import { viewableFromVacancyYmd } from "./vacating-notice";

type Env = Record<string, string | undefined>;
export function vacateMoveInEstimateEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.VACATE_MOVE_IN_ESTIMATE ?? "").trim().toLowerCase() !== "off";
}

/** 退去後の工事の期間（日）。実送信「2週間〜3週間程」「早ければ2週間後遅くても1ヶ月後」。退去予定日→答えた旬の11組が全部入る幅（14〜21日だと4組で1旬早い＝早めない） */
export const VACATE_WORK_DAYS = { min: 14, max: 28 } as const;

const jun = (d: number) => (d <= 10 ? "上旬" : d <= 20 ? "中旬" : "下旬");
function ymdPlus(ymd: string, days: number): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export type MoveInEstimate = {
  /** 退去予定日の表記（「10月末」「10月31日」） */
  vacate: string;
  /** 最短の入居時期の目安（「11月中旬〜下旬」「9月上旬」） */
  label: string;
  /** 材料・最終チェックに渡す1行 */
  fact: string;
};

/**
 * 退去予定日（「10月31日」「10月末」）→ 最短の入居時期の目安。日・末の無い表記（旬だけ・月だけ）は null（逆算しない）。
 * 退去予定日がもう過ぎている時も null（退去済み＝工事の進み具合で決まる・確認が要る）
 */
export function moveInEstimateFromVacate(vacateRaw: string | null | undefined, nowMs: number = Date.now(), env?: Env): MoveInEstimate | null {
  if (!vacateMoveInEstimateEnabled(env)) return null;
  const raw = String(vacateRaw ?? "").normalize("NFKC").trim();
  if (!/\d{1,2}\s*月\s*(?:\d{1,2}\s*日|末)/.test(raw)) return null;
  const next = viewableFromVacancyYmd(raw, nowMs); // 退去日の翌日
  if (!next) return null;
  const jst = new Date(nowMs + 9 * 3600_000);
  const today = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  if (next <= today) return null;
  const a = ymdPlus(next, VACATE_WORK_DAYS.min - 1);
  const b = ymdPlus(next, VACATE_WORK_DAYS.max - 1);
  const la = `${a.m}月${jun(a.d)}`;
  const label = a.m === b.m ? (jun(a.d) === jun(b.d) ? la : `${la}〜${jun(b.d)}`) : `${la}〜${b.m}月${jun(b.d)}`;
  const vacate = raw.replace(/^\d{4}\s*年/, "").replace(/\s+/g, "");
  return {
    vacate, label,
    fact: `最短の入居時期の目安（逆算）: ${vacate}退去予定＋退去後のクリーニング・鍵交換（2〜3週間程・遅くても1ヶ月程）→ 最短で${label}のご入居（目安。確定の日は退去後の室内の状況・業者の手配で決まる）`,
  };
}

/** 返信の答え方（材料の注に添える・竹内さんの実送信の形） */
export const MOVE_IN_ESTIMATE_HOW =
  "退去予定日から逆算した目安を「〇月末退去予定のため、最短で〇月〇旬〜〇旬のご入居となります！！」の形で答えてよい（竹内さんの実送信の形）。目安なので、具体の日（何日から）を聞かれた時・言い切る時は「退去後の室内の状況でクリーニングの業者の手配が変わるため、確定のご入居日は退去後に決まる形となります」を添える（日付を作らない）。確定の入居可能日は AIX【確認した→入居可能日】";

/**
 * 生成の注の「退去予定の物件の入居時期」の1文（材料に目安がある時だけ目安を写す・無い時は今まで通り確認）。
 * 書けと書くなを並べないため、旧の「日程の自動計算は絶対禁止」をこの1文に置き換える
 */
export function vacatingMoveInPromptLine(env?: Env): string {
  if (!vacateMoveInEstimateEnabled(env)) return "「ご入居可能日を管理会社に確認しご連絡させて頂きます😊！！」のみ伝える（AIが「クリーニング・鍵交換で2〜3週間」等から日程を自動計算して断定案内することは絶対禁止）";
  return "材料に【最短の入居時期の目安（逆算）】がある時はその目安（「最短で〇月〇旬〜〇旬のご入居」）を目安として答え、確定の日は退去後に決まると添える（AI が自分で日程を計算しない・材料の目安を写す）。材料に目安が無い時は「ご入居可能日を管理会社に確認しご連絡させて頂きます😊！！」";
}
