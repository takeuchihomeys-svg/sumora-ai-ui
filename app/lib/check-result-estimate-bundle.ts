// app/lib/check-result-estimate-bundle.ts
// AIX【物件確認した】（物件あった）で御見積書を同封する時の「送る並び」と「費用の文」を決める（純関数・画面とサーバの両方から使う）。
//
// 2026-10-13 竹内さん（会話「くれあ」の AIX【物件確認した】の画面）:
//   「今まで物件の募集状況を確認する時でも、併せて見積書を送る場合は AIX【見積書送る】から送る事が多かった（費用を分かりやすくするため）。
//    これを AIX【物件確認した】でも送れる方がきれいにまとまる」
//   → 見積書を同封する時は、物件ごとに ①物件資料の画像 ②見積書の画像 ③見積の文（AIX【見積書送る】で送っている費用の文）の3つを順に送り、
//     物件が複数ならこのセットを繰り返し、最後に募集状況を確認した文（確認の結果の文）を送る。
//     見積書を同封しない時は今まで通り（物件ごとの資料→本文）。
//   ③の文は新しく作らない: AIX【見積書送る】（1枚）の文の組み立て（estimate-body.buildEstimateMessage＋estimate-explain の札の1行）を
//   composeSingleEstimateCostText に寄せ、【見積書送る】もこの関数を通す（同じ見積書なら同じ文になる）。
//   見積書が無い物件・資料の画像が無い物件は、その物件の持っている物だけ送る（空のステップは作らない）。
//   戻す: NEXT_PUBLIC_CHECK_RESULT_ESTIMATE_BUNDLE=off（画面が estimate_bundle を送らない＝今まで通りの並び）

import { buildEstimateMessage, calcSavings } from "./estimate-body";
import { estimateExplain } from "./estimate-explain";

/** 「送られた物件数」「確認できた物件数」の上限（2026-10-13 竹内さん: 10件まで） */
export const CHECK_RESULT_MAX_PROPS = 10;
/** 物件の番号の丸数字（①〜⑩） */
export const CIRCLED_NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"] as const;
export const circled = (i: number): string => CIRCLED_NUMS[i] ?? `${i + 1}.`;

/** 見積書の同封を物件ごとのセットで送るか（既定 on・NEXT_PUBLIC_CHECK_RESULT_ESTIMATE_BUNDLE=off で今まで通り） */
export function checkResultEstimateBundleOn(v: string | undefined = process.env.NEXT_PUBLIC_CHECK_RESULT_ESTIMATE_BUNDLE): boolean {
  return (v ?? "").trim().toLowerCase() !== "off";
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 費用の文（AIX【見積書送る】の1枚の文と同じ組み立て）
// ─────────────────────────────────────────────────────────────────────────────

/** 見積書の読み取り（aix/action の1枚の OCR の JSON そのまま） */
export type SingleEstimateOcr = Record<string, unknown>;

export type SingleEstimateCostText = {
  /** 送る文（金額の札＋日割の注記＋費用の事情の1行） */
  text: string;
  /** 費用の事情の1行（estimate-explain の cardLine・無ければ null） */
  cardLine: string | null;
};

const num0 = (v: unknown): number => {
  const n = Number(v || 0);
  return isNaN(n) || n < 0 ? 0 : n;
};

/**
 * AIX【見積書送る】（1枚）の費用の文。aix/action の estimate_sheet（1枚）から移した物で、文の形は変えていない。
 * @param propertyName/roomNumber 指定した時はそれを使う（物件確認したでスタッフが入れた物件名）。未指定なら読み取りの値
 */
export function composeSingleEstimateCostText(
  est: SingleEstimateOcr,
  o: { accountName: string; account: string | null | undefined; propertyName?: string; roomNumber?: string },
): SingleEstimateCostText {
  const propertyName = o.propertyName !== undefined ? o.propertyName : String(est.property_name || "");
  const roomNumber = o.roomNumber !== undefined ? o.roomNumber : String(est.room_number || "");
  const total = num0(est.total);
  const discount = num0(est.discount);
  const rent = num0(est.rent);
  const commRaw = Number(est.commission || 0);
  const commTaxRaw = Number(est.commission_tax || 0);
  const commission = isNaN(commRaw) ? 0 : commRaw;
  const commTax = isNaN(commTaxRaw) ? 0 : commTaxRaw;
  // 見積書作成画面（estimate/page.tsx）と同じ式（estimate-body.calcSavings）
  const savings = calcSavings({ rent, commission, commissionTax: commTax, discount });
  let text = buildEstimateMessage([{ propertyName, roomNumber, total, discount, savings, accountName: o.accountName }]);
  // 2026-10-06 ⑫: このお部屋の費用の事情の1行を札の最後に（数字は読み取りの値だけ）
  const ex = estimateExplain({
    account: String(o.account || "sumora"),
    discountYen: typeof est.discount === "number" ? discount : null,
    commissionYen: typeof est.commission === "number" ? commission + (typeof est.commission_tax === "number" ? commTax : 0) : null,
    cleaningFeeYen: typeof est.cleaning_fee === "number" && est.cleaning_fee > 0 ? est.cleaning_fee : null,
  });
  if (ex.cardLine) text = `${text}\n\n${ex.cardLine}`;
  return { text, cardLine: ex.cardLine };
}

/**
 * 費用の文の見出しに使う物件名。スタッフが物件確認したに入れた物件名（確認の結果の文と同じ字）を優先する。
 * 号室は、スタッフの物件名にその号室が既に入っていれば足さない（「KTI 202号室 202号室」にしない）。
 * スタッフの物件名が空・仮の名前（物件①）の時は見積書の読み取りの値（【見積書送る】と同じ）。
 */
export function bundleEstimateName(
  staffName: string | null | undefined,
  ocrName: unknown,
  ocrRoom: unknown,
): { propertyName: string; roomNumber: string } {
  const s = String(staffName ?? "").trim();
  const room = String(ocrRoom ?? "").trim();
  const placeholder = !s || /^(?:物件|お?部屋|物件情報)\s*[①-⑳0-9０-９]*\s*$/.test(s);
  if (placeholder) return { propertyName: String(ocrName ?? "").trim(), roomNumber: room };
  const roomDigits = room.normalize("NFKC").replace(/号室\s*$/, "").trim();
  const staffHasRoom = /\d+\s*号室|\d{3,4}\s*$/.test(s.normalize("NFKC"))
    || (roomDigits !== "" && s.normalize("NFKC").includes(roomDigits));
  return { propertyName: s, roomNumber: staffHasRoom ? "" : room };
}

// ─────────────────────────────────────────────────────────────────────────────
// 送る並び
// ─────────────────────────────────────────────────────────────────────────────

export type BundlePropertyInput = {
  /** 物件名（画面の表示用） */
  name: string;
  /** 物件資料の画像の枚数 */
  docCount: number;
  /** 見積書の画像があるか */
  hasEstimate: boolean;
  /** ③ 費用の文（無い・空なら送らない） */
  costText?: string | null;
};

export type SendStep =
  | { id: string; kind: "images"; propIndex: number; docCount: number; hasEstimate: boolean }
  | { id: string; kind: "cost_text"; propIndex: number; text: string }
  | { id: string; kind: "main_text" };

/**
 * 見積書を同封する時の送る並び。物件ごとに [資料・見積書の画像（1回でまとめて・資料→見積書の順）] → [費用の文]、最後に確認の結果の文。
 * 持っていない物は飛ばす（資料も見積書も無い物件は画像のステップを作らない・費用の文が空なら作らない）。
 */
export function buildCheckResultSendPlan(props: ReadonlyArray<BundlePropertyInput>): SendStep[] {
  const steps: SendStep[] = [];
  props.forEach((p, i) => {
    const docCount = Math.max(0, Math.floor(p.docCount || 0));
    if (docCount > 0 || p.hasEstimate) steps.push({ id: `p${i}:images`, kind: "images", propIndex: i, docCount, hasEstimate: !!p.hasEstimate });
    const t = (p.costText ?? "").trim();
    if (t) steps.push({ id: `p${i}:cost`, kind: "cost_text", propIndex: i, text: t });
  });
  steps.push({ id: "main", kind: "main_text" });
  return steps;
}

/**
 * 2026-10-27 竹内さんの決定（P1 82027521・10/20 スマホの画面）: AIX【物件確認した】の「別の部屋が募集してた（alternative）」で見積書を同封した時も、
 *   見積書の文（割引・初期費用・節約）と申込の状況（申込あり＝2番手以降）が「物件あった」と同じように出るようにする。
 *   旧は画面（この関数）とサーバ（aix/action の見積の束・申込あり の足し）の両方で check_pattern === "available" だけに線が引かれていた。
 *   スイッチ: NEXT_PUBLIC_CHECK_ALT_ESTIMATE=on（画面とサーバの両方が読む・既定 off＝今と同じ）
 */
export function checkAltEstimateOn(env?: Record<string, string | undefined>): boolean {
  const v = env ? env.NEXT_PUBLIC_CHECK_ALT_ESTIMATE : (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_CHECK_ALT_ESTIMATE : undefined);
  return (v ?? "").trim().toLowerCase() === "on";
}
/** 見積書の同封の文・申込の状況の行を出す確認の結果か（物件あった／スイッチ on の時は別の部屋が募集してたも） */
export function checkPatternTakesEstimate(pattern: string | null | undefined, altOn: boolean = checkAltEstimateOn()): boolean {
  return pattern === "available" || (altOn && pattern === "alternative");
}

/** 物件ごとのセットで送るか: 見積書が1件以上ある時だけ（無ければ今まで通り） */
export function shouldUseEstimateBundle(o: { on: boolean; pattern: string | null | undefined; estimateCount: number; altOn?: boolean }): boolean {
  return o.on && checkPatternTakesEstimate(o.pattern, o.altOn ?? checkAltEstimateOn()) && o.estimateCount > 0;
}

/** 画面に出す並び（スタッフが送る前に見る） */
export function describeSendPlan(steps: ReadonlyArray<SendStep>, props: ReadonlyArray<BundlePropertyInput>): string[] {
  let n = 0;
  return steps.map((s) => {
    n += 1;
    if (s.kind === "main_text") return `${n}. 確認の結果の文（下の本文）`;
    const nm = (props[s.propIndex]?.name ?? "").trim() || `物件${circled(s.propIndex)}`;
    if (s.kind === "images") {
      const parts = [s.docCount > 0 ? `物件資料${s.docCount > 1 ? `${s.docCount}枚` : ""}` : "", s.hasEstimate ? "見積書" : ""].filter(Boolean);
      return `${n}. ${nm}: ${parts.join("＋")}の画像`;
    }
    return `${n}. ${nm}: 費用の文`;
  });
}
