/**
 * 市の名前だけの希望（「堺市」「堺市内」）→ その市の全区。
 *
 * 2026-11-19 かえさん「堺市・商店街近く」（地域のお客様・audit #1521）:
 *   「堺市」が JR阪和線の堺市駅として読まれ、沿線0本の駅検索になって途中で止まった。
 *   拡張の popup-maps.js の MULTI_WARD_MAP（堺市・堺市内）と同じ中身。
 *   「堺市駅」と書いてある時だけ駅として扱う。
 */
const SAKAI_ALL_WARDS = [
  "堺市堺区",
  "堺市中区",
  "堺市東区",
  "堺市西区",
  "堺市南区",
  "堺市北区",
  "堺市美原区",
] as const;

const CITY_ALL_WARDS: Record<string, readonly string[]> = {
  堺市: SAKAI_ALL_WARDS,
  堺市内: SAKAI_ALL_WARDS,
};

/** 市の名前のトークンなら全区を返す。「〇〇駅」と書いてあれば駅なので null */
export function cityAllWards(tok: string, desiredArea: string): readonly string[] | null {
  const t = String(tok || "").trim();
  const wards = CITY_ALL_WARDS[t];
  if (!wards) return null;
  if (String(desiredArea || "").includes(t.replace(/内$/, "") + "駅")) return null;
  return wards;
}

/**
 * LLM が駅として返した名前が、実は市の名前（全区に広げた物）か。
 *   実測: 「堺市・商店街近く」で LLM は「堺市」「堺」の2駅を返した。「堺」は「堺市」の一部でしか書かれていない。
 */
export function isCityNameNotStation(name: string, desiredArea: string): boolean {
  const n = String(name || "").replace(/駅$/, "").trim();
  const area = String(desiredArea || "");
  if (!n) return false;
  if (cityAllWards(n, area) !== null) return true;
  if (area.includes(n + "駅")) return false;
  for (const city of Object.keys(CITY_ALL_WARDS)) {
    if (!city.startsWith(n) || !area.includes(city)) continue;
    if (cityAllWards(city, area) === null) continue;
    if (!area.split(city).join("").includes(n)) return true;
  }
  return false;
}
