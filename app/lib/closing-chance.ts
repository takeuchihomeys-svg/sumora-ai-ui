// app/lib/closing-chance.ts — 「決めに行く番」の見極めの物差し（純関数・DB/LLM なし・作業員P・2026-11-23・台帳 #658）
//
// 竹内さん 11/23（P0）「統括の部分の把握能力と、クロージングする際はちゃんと決めに行く、チャンス見極める能力もちゃんとあげるようにする、
//   そうすれば完全にまかせれるようになるから、人間を超えるように徹底的に強化する。徹底的におねがい、仕組化して強化していく」。
//   竹内さん本人が「決めに行った」番（申込の後押し・申込で抑える・審査の相談→電話）を拾い、送る直前のブレインもチャンスと見て決めに行ったかを並べる。
//     見逃し（missed）… 竹内さんは決めに行った・ブレインは待った
//     早すぎ（early） … ブレインは決めに行った・竹内さんは待った
//   決めに行った後に申込に届いたか（14日）と、決めに行く番で統括が持っていた材料（判断の記録 digest の欄）の欠けを並べる。
//   決まり: KB aef0a1df（訴求のタイミングは場面×反応×部屋の状況）・a92b6655（遠方・内覧まで期間がある時は申込で抑える）・701e2665（審査の相談は AIX【電話】）・
//          a9adff15（申込予測 apply-readiness・線 50）・2ac8d630（申込を決めたお客様に申込誘導の AIX を作らない）。
//   本文は出さない（印を見るだけ）。

/** 竹内さんの手打ちの「決めに行く」文の印（申込で抑える・申込を勧める・審査に出す）。お客様が既に決めた後の手順（申込書・フォーマット）は入れない */
export const CLOSE_TEXT_RE = /(?:申込|申し込み|お申込み?)(?:で|を)?(?:お部屋を)?(?:抑え|押さえ|進め|されますか|いかがでしょう|どうでしょう|頂けますと|して頂けますと|いただけますと)|(?:先に|まず)(?:お部屋を)?(?:抑え|押さえ)|審査(?:に|を)?(?:出し|進め|お出し|通し)(?:て(?:み)?)?(?:ませんか|ましょう|ますか|ても)/;
/** 決めに行く AIX の種類（申込の後押し・審査の相談の電話）。application_push/confirm・format はお客様が決めた後の手順＝入れない */
export function isClosingAix(aixType: string | null | undefined, customerText = ""): boolean {
  const t = String(aixType ?? "");
  // 11/23: staff_aix の aix_type には下の形が無い（application_push だけ）＝下の形が分かる時だけ push を決めに行くと数える（60日の申込の AIX は format 42・push 2＝下の形無しで数えると決めた後の申込書まで入る）
  if (t === "application_push/push") return true;
  if (/^phone_call/.test(t) && /審査/.test(customerText)) return true;
  return false;
}
/** ブレインの送る直前の一手が決めに行く一手か（application_push の後押し・審査の相談の電話） */
export function isBrainClosing(action: string | null | undefined, mode: string | null | undefined, customerText = ""): boolean {
  if (mode !== "aix") return false;
  // ブレインの判断の記録には申込の AIX の下の形が無い（application_push だけ）。監査は申込以降の番を外すので、申込の前の application_push は後押し（決めに行く）と見る
  if (action === "application_push") return true;
  return isClosingAix(action, customerText);
}

export type ClosingVerdict = "both" | "missed" | "early" | "neither";
export function closingVerdictOf(takeuchiClose: boolean, brainClose: boolean): ClosingVerdict {
  return takeuchiClose && brainClose ? "both" : takeuchiClose ? "missed" : brainClose ? "early" : "neither";
}

/** 決めに行く番で統括が持っていた材料（digest の欄）の欠け（純関数）。欄が無い・空なら欠け */
export const CLOSING_GRASP_FIELDS: Array<{ key: string; label: string }> = [
  { key: "emo", label: "お客様の気持ち" }, { key: "sig", label: "購買の合図" }, { key: "timeline", label: "入居時期" }, { key: "prop", label: "物件" },
  { key: "concern", label: "不安" }, { key: "cp", label: "申込までの段" }, { key: "op", label: "開いている約束" }, { key: "intent", label: "お客様の意図" },
];
export function graspGapsOf(digest: Record<string, unknown> | null | undefined): string[] {
  const d = digest ?? {};
  return CLOSING_GRASP_FIELDS.filter((f) => { const v = d[f.key]; return v == null || v === "" || (Array.isArray(v) && !v.length); }).map((f) => f.key);
}

/** 監査の1行（scripts/audit-closing-takeuchi.ts の json） */
export type ClosingRow = {
  id: number; conv: string; at: string; takeuchiClose: boolean; closeHow: string | null; brainClose: boolean; brainAct: string | null;
  readiness: number | null; level: string | null; verdict: ClosingVerdict; applied14: boolean | null; gaps: string[];
  /** 7日の窓の外（8〜28日前）にだけある申込予測の合図の鍵 */
  wideHits?: string[];
};
/** 決めに行った（または行くべきだった）番の数え（純関数） */
export function closingSummaryOf(rows: readonly ClosingRow[]) {
  const c = (v: ClosingVerdict) => rows.filter((r) => r.verdict === v).length;
  const tk = rows.filter((r) => r.takeuchiClose), br = rows.filter((r) => r.brainClose);
  const reached = (xs: readonly ClosingRow[]) => { const k = xs.filter((r) => r.applied14 != null); return { n: k.length, applied: k.filter((r) => r.applied14).length }; };
  const gapCount: Record<string, number> = {};
  for (const r of tk) for (const g of r.gaps) gapCount[g] = (gapCount[g] ?? 0) + 1;
  return {
    n: rows.length, both: c("both"), missed: c("missed"), early: c("early"), neither: c("neither"),
    takeuchiClose: tk.length, brainClose: br.length,
    /** 主: 決めに行くべき番（竹内さんが決めに行った番）でブレインも決めに行った割合 */
    closeRate: tk.length ? Math.round((c("both") / tk.length) * 1000) / 10 : null,
    /** ブレインが決めに行った番で竹内さんも決めに行った割合（早すぎの裏） */
    brainPrecision: br.length ? Math.round((c("both") / br.length) * 1000) / 10 : null,
    afterTakeuchiClose: reached(tk), afterBrainEarly: reached(rows.filter((r) => r.verdict === "early")),
    gapCount,
  };
}
