// app/lib/resume-advice.ts — スタッフの文の「（お客様が）お部屋探しを再開いただくのをオススメ」型を、こちらのピックアップの約束と分ける（純関数）
//
// 2026-10-28 響夢さん（10/17 11:29 のスタッフ「12月末から1月前半ごろにお引っ越し予定お変わりない場合11月中旬ごろからお部屋探し再開いただくのをオススメ致します」）:
//   約束の網（reply-context.STAFF_PICKUP_DECL_RE の「お部屋探し…致します」）に当たり、台帳が pickup_declared（約束）と読んだ
//   → カレンダーに【必ず】物件ピックアップ送付【今日中】・宣言の後のブレインが AIX【物件ピックアップした】の要対応を立て、
//   お客様が「もう少し明確になってから探したい」と言った後も 12日 やることリストに「期限 過ぎ」で残った（竹内さん「今物件を探すわけではない」）。
//   主語はお客様（「再開いただく」「始めていただく」＋「のをオススメ／のがスムーズ」）＝こちらの約束ではない。
//   切替 LEDGER_RESUME_ADVICE_NOT_PROMISE=on の時だけ外す（既定 off＝今まで通り）。
// テスト: app/lib/__tests__/resume-advice.test.ts

export function ledgerResumeAdviceEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LEDGER_RESUME_ADVICE_NOT_PROMISE ?? "").trim().toLowerCase() === "on";
}

/** お客様の動き（探し・再開・開始）＋「いただく／頂く」 */
const CUSTOMER_SEARCH_ACT_RE = /(?:お部屋探し|お探し|探し)(?:を|の)?(?:再開|開始|スタート)?(?:して|し)?(?:頂|いただ)(?:く|ける|けれ)|(?:再開|開始)(?:して)?(?:頂|いただ)(?:く|ける|けれ)/;
/** 勧め・案内の結び（のをオススメ・のがスムーズ・と良い 等） */
const ADVICE_TAIL_RE = /(?:の|こと)(?:を|が)?[^\n。！!]{0,6}(?:オススメ|おすすめ|お勧め|お薦め|推奨|スムーズ|良い|よろしい|ベスト)|と(?:良い|よろしい|スムーズ)|(?:ば|たら)[^\n。！!]{0,4}(?:良い|よろしい|スムーズ)/;

/** 1文が「お客様にお部屋探しの再開・開始を勧める」文か（こちらがピックアップする約束ではない） */
export function isCustomerSearchAdvice(sentence: string | null | undefined): boolean {
  const s = String(sentence ?? "").normalize("NFKC");
  const m = s.match(CUSTOMER_SEARCH_ACT_RE);
  if (!m || m.index == null) return false;
  return ADVICE_TAIL_RE.test(s.slice(m.index));
}

/**
 * 約束の網に当たる文のうち、勧めの文を除いた最初の文（無ければ null）。enabled=false の時は今まで通り網に当たる最初の文。
 * evidence は当たった所（旧は本文全体の最初の当たり）
 */
export function pickupDeclSentence(sentences: ReadonlyArray<string>, re: RegExp, enabled: boolean): { sentence: string; evidence: string } | null {
  for (const s of sentences) {
    const m = s.match(re);
    if (!m) continue;
    if (enabled && isCustomerSearchAdvice(s)) continue;
    return { sentence: s, evidence: m[0] };
  }
  return null;
}
