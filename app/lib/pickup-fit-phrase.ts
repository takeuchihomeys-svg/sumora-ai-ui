// app/lib/pickup-fit-phrase.ts — 選んだ理由の札の「合う点」が、お客様への文に入ったかの網（竹内さん本人の文の言い方・純関数・LLM なし）（台帳 #793）
// 2026-11-26 作業員A（統括役の頼み）: 前の網は条件の言葉（ご希望・条件・お探し）の粗い網で 98/547 だった。札（property_pickups.reason_codes）ごとに、
//   竹内さん本人の AIX の文で合う点を言う時の言い方（例: 「15万円以内に収まる」「敷金礼金なし」「築年数浅く」「駅徒歩7分」「独立洗面台」「専有面積44.84㎡と広く」「ペット飼育可能」）で網を作り直す。
//   スタッフだけの札（広告料 AD_*・検索の札 SEARCH_*）と、合わない点の札（*_NOT_*・*_UNKNOWN・*_FAR・*_ASK・*_UNLISTED）は数えない
export const FIT_PHRASE: Readonly<Record<string, RegExp>> = {
  FLOOR_PLAN_MATCH: /[1-4１-４]\s*(?:LDK|SLDK|DK|K|R)|ワンルーム|間取り/i,
  RENT_OK: /(?:万円?|円)(?:以内|以下)|(?:以内|以下)に収ま|ご予算(?:内|に収ま)|家賃[^。\n]{0,12}(?:円|万)/,
  RENT_BAND_LOW: /(?:万円?|円)(?:以内|以下)|お手頃|お安く|抑え(?:て|られ)/,
  WALK_OK: /徒歩\s*[0-9０-９]+\s*分|駅近|駅から近/,
  WALK_NEAR_N: /徒歩\s*[0-9０-９]+\s*分|駅近|駅から近/,
  MOVE_IN_OK: /即入居|入居可能|ご入居(?:頂け|可能)|[0-9０-９]+月(?:上旬|中旬|下旬|頃)?(?:から)?(?:ご)?入居/,
  BUILDING_AGE_OK: /築浅|築年数(?:浅|新し)|新築|築\s*[0-9０-９]+\s*年|[0-9０-９]{4}年[0-9０-９]*月?築/,
  AGE_N5: /築浅|築年数(?:浅|新し)|新築|築\s*[0-9０-９]+\s*年|[0-9０-９]{4}年[0-9０-９]*月?築/,
  AREA_WARD_MATCH: /[^\s]{1,4}区|エリア/,
  AREA_STATION_MATCH: /「[^」]{1,10}」駅|[^\s「」]{1,8}駅/,
  EQUIP_BATH_TOILET_MUST_OK: /バス(?:・|\s)?トイレ別|風呂トイレ別|セパレート/,
  ZERO_ZERO_MATCH: /敷金(?:・|\s)?礼金(?:なし|無し|0|０|ゼロ)|敷礼(?:なし|0|０|ゼロ)|初期費用[^。\n]{0,6}(?:抑え|安)/,
  ZERO_ZERO: /敷金(?:・|\s)?礼金(?:なし|無し|0|０|ゼロ)|敷礼(?:なし|0|０|ゼロ)/,
  SQM_OK: /[0-9０-９.]+\s*(?:㎡|平米|帖|畳)|広く|広々/,
  EQUIP_PET_OK: /ペット(?:飼育)?(?:可|相談|OK)/i,
  EQUIP_FLOOR2_OK: /[2-9２-９]階以上|[2-9２-９０-９]{1,2}階(?:の|部分|角)/,
  EQUIP_WASHBASIN_OK: /独立洗面/,
};
export const FIT_CODES = Object.keys(FIT_PHRASE);
/** 札の中の合う点と、文に入った合う点（純関数） */
export function fitInText(codes: readonly string[], text: string): { fit: string[]; hit: string[] } {
  const t = String(text ?? "").normalize("NFKC");
  const fit = [...new Set(codes.filter((c) => FIT_PHRASE[c]))];
  return { fit, hit: fit.filter((c) => FIT_PHRASE[c].test(t)) };
}
