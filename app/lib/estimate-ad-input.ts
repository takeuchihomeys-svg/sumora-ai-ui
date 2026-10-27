// app/lib/estimate-ad-input.ts — 見積書の画面で AD を入力・選択し、割引が AD のどれだけか・利益を出す（純関数・画面からも import できる）
//
// 2026-10-28 竹内さん（10/20・owner-fb:1020-estimate-ad-input）「見積書の作成画面に AD の入力・選択欄を作り、どれだけ割引しているか分かるようにする」
//   旧: AD は売上サポ・送付記録から分かった時だけ（handoff）で、分からない時は「AD が分からないので利益は出せません」で止まっていた。
//       LINE から来ずに見積書ツールを直接開いた時は割引の欄そのものが出なかった。
//   新（NEXT_PUBLIC_ESTIMATE_AD_INPUT=on の時だけ・既定 off）: AD を「ヶ月」の札（0.5〜3）か円で入れられる。入れた値が分かった AD より先。
//     出す物: AD（円）・割引・利益（AD − 割引）・割引が AD の何%か。AD は画面だけ（見積書の画像・本文には出ない＝今まで通り）。
// テスト: app/lib/__tests__/estimate-ad-input.test.ts

export function estimateAdInputEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NEXT_PUBLIC_ESTIMATE_AD_INPUT ?? "").trim().toLowerCase() === "on";
}

/** 札で選べる AD（ヶ月） */
export const AD_MONTH_CHOICES: ReadonlyArray<number> = [0.5, 1, 1.5, 2, 3];

/** スタッフが入れた AD（ヶ月か円のどちらか・無ければ null） */
export type AdOverride = { months: number | null; yen: number | null } | null;

/** 使う AD（円）: 入れた円 → 入れたヶ月×家賃 → 分かっている AD（円）→ 分かっている AD（ヶ月）×家賃。どれも無ければ null */
export function resolveAdYen(o: { override?: AdOverride; knownYen?: number | null; knownMonths?: number | null; rent?: number | null }): { yen: number | null; source: "input_yen" | "input_months" | "known_yen" | "known_months" | null } {
  const rent = o.rent && o.rent > 0 ? o.rent : null;
  const ov = o.override ?? null;
  if (ov?.yen != null && ov.yen > 0) return { yen: Math.round(ov.yen), source: "input_yen" };
  if (ov?.months != null && ov.months > 0 && rent) return { yen: Math.round(ov.months * rent), source: "input_months" };
  if (o.knownYen != null && o.knownYen > 0) return { yen: Math.round(o.knownYen), source: "known_yen" };
  if (o.knownMonths != null && o.knownMonths > 0 && rent) return { yen: Math.round(o.knownMonths * rent), source: "known_months" };
  return { yen: null, source: null };
}

/** 割引が AD の何%か・利益の1行（画面用）。AD が無ければ null */
export function discountShareLine(adYen: number | null | undefined, discountYen: number | null | undefined): string | null {
  if (!adYen || adYen <= 0) return null;
  const d = Math.max(0, discountYen ?? 0);
  const pct = Math.round((d / adYen) * 100);
  const p = adYen - d;
  return `AD ${adYen.toLocaleString()}円のうち割引 ${d.toLocaleString()}円（${pct}%）・利益 ${p.toLocaleString()}円${p < 0 ? "（マイナス）" : ""}`;
}

/** 円の入力（「65,000」「6.5万」）を数に。読めなければ null */
export function parseYenInput(s: string | null | undefined): number | null {
  const t = String(s ?? "").normalize("NFKC").replace(/[,\s円]/g, "");
  if (!t) return null;
  const man = t.match(/^([0-9]+(?:\.[0-9]+)?)万$/);
  if (man) return Math.round(Number(man[1]) * 10000);
  return /^[0-9]+$/.test(t) ? Number(t) : null;
}
