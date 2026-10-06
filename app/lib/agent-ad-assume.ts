// app/lib/agent-ad-assume.ts（純関数・import なし・画面とサーバーで共用）
// 元付業者ごとの「AD の記載が無くてもこの AD とみなす」決まり。
//
// 2026-09-27 竹内「スコアリング AD 1ヶ月未満の物件は点数かなり落とす／しかし元付業者が株式会社アズ・スタットの場合は例外／
//   株式会社アズ・スタットは AD 記載なくても基本的に 200% あるから 200% とみなす」
//   実物: リアプロの資料の元付業者のページ（偶数ページ）の末尾に
//     「国土交通大臣免許(2)第8096号 / 株式会社アズ・スタット 大阪本社 / 大阪市淀川区東三国… / https://trader-vacancy.az-stat.com/admin/」
//     と書かれ、AD の欄は「A D」だけで値が無い（property_pickups #621〜#626 等・9/27 時点の 150行中 12行）→ 今まで AD_UNKNOWN（0点）
// 決まり:
//   - 資料に AD の値が読めた時（「A D 100%」「広告料 なし」も）はその値のまま（みなさない）。値が無い時だけ 200% とみなす
//   - 画面の札は資料の文字でないと分かる形「AD 200%（アズ・スタット）」・判定には 0点の札 AD_ASSUMED_AGENT を添える
//   - 見分けは会社名の書き方の揺れ（アズ・スタット／アズスタット／ｱｽﾞ･ｽﾀｯﾄ）と、資料の URL（az-stat.com）

export type AssumedAdAgent = { name: string; adMonths: number };

/**
 * 2026-10-06 竹内さん「だいじょうぶ」: 元付の決まりの次に「同じ建物の別の部屋の AD」でみなす（building-ad-assume.ts）。
 *   みなしの名前（facts.adAssumedBy・説明文の行「AD 1.5ヶ月（同じ建物の別の部屋・記載なしのため150%とみなす）」）。
 *   property-brain はこの名前なら札 AD_ASSUMED_BUILDING（アズ・スタットは AD_ASSUMED_AGENT）。import の輪を作らないようにここに置く
 */
export const BUILDING_AD_NAME = "同じ建物の別の部屋";

/** 株式会社アズ・スタット（中黒・空白・半角カナの揺れ・資料の URL） */
export const AZ_STAT_RE = /ア[ \t　]*ズ[ \t　]*[・･]?[ \t　]*ス[ \t　]*タ[ \t　]*ッ[ \t　]*ト|ｱ[ \t　]*ｽﾞ[ \t　]*[・･]?[ \t　]*ｽ[ \t　]*ﾀ[ \t　]*ｯ[ \t　]*ﾄ|az-stat\.com/i;

const AGENTS: Array<{ name: string; re: RegExp; adMonths: number }> = [
  { name: "アズ・スタット", re: AZ_STAT_RE, adMonths: 2 },
];

/** 資料の文字（元付業者のページ・無ければ全文）から、AD をみなす元付業者（無ければ null） */
export function assumedAdAgentOf(text: string | null | undefined): AssumedAdAgent | null {
  const t = String(text ?? "");
  if (!t) return null;
  for (const a of AGENTS) if (a.re.test(t)) return { name: a.name, adMonths: a.adMonths };
  return null;
}

/** 札の文字（「AD 200%（アズ・スタット）」）。資料の文字ではなく、みなした値だと分かる形 */
export function assumedAdStamp(a: AssumedAdAgent): string {
  return `AD ${Math.round(a.adMonths * 100)}%（${a.name}）`;
}

/**
 * 説明文に足す行（「AD 2ヶ月（アズ・スタット・記載なしのため200%とみなす）」）。
 * parsePropertyFacts がこの行から 2ヶ月と「みなし」の印（assumedAdAgentInLine）を読む
 */
export function assumedAdSummaryLine(a: AssumedAdAgent): string {
  return `AD ${String(a.adMonths).replace(/\.0$/, "")}ヶ月（${a.name}・記載なしのため${Math.round(a.adMonths * 100)}%とみなす）`;
}

/** 説明文の AD の行が「みなし」の行か（元付業者の名前を返す） */
export function assumedAdAgentInLine(line: string | null | undefined): string | null {
  const m = String(line ?? "").match(/[（(]([^）)]+?)・記載なしのため\d+%とみなす[）)]/);
  return m ? m[1] : null;
}
