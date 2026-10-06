// app/lib/__tests__/new-build-claim.test.ts
// 2026-10-06 竹内（ゆなまる）「新築とは新築で未入居の場合、新築となる。今回の物件は新築ではない」
// 実行: npx tsx app/lib/__tests__/new-build-claim.test.ts
import { fixStaleNewBuildClaim, findUnsupportedNewBuild } from "../new-build-claim";
import { normalizeBannedPhrasing } from "../banned-phrasing";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

const OCT6 = Date.parse("2026-10-06T08:41:44Z"); // 生成の時刻（aix_generate_log f87c0c12）
// 実物（会話を合わせるの生成そのまま）
const YUNA = "ゆなまるさんこちらのお部屋如何でしょうか！！\n2025年5月築の新築、谷町四丁目まで乗り換え1回で通える立地となります😊！！\nお手隙の際にご査収ください😌！！";
{
  const r = fixStaleNewBuildClaim(YUNA, OCT6);
  t("2025年5月築の新築 → 築浅物件（17か月）", r.text.includes("2025年5月築の築浅物件、谷町四丁目まで") && r.fixed.length === 1 && r.fixed[0].months === 17, JSON.stringify(r));
  t("他の文字は変わらない", r.text.replace("築浅物件", "新築") === YUNA);
  t("normalizeBannedPhrasing でも直る（全経路の入口）", normalizeBannedPhrasing(YUNA, { nowMs: OCT6 }).text.includes("2025年5月築の築浅物件") && normalizeBannedPhrasing(YUNA, { nowMs: OCT6 }).newBuild === 1);
}
{
  // 12か月以内は触らない（未入居か本文では分からない）
  const atr = "・2026年1月築の新築";
  t("2026年1月築の新築（9か月）はそのまま", fixStaleNewBuildClaim(atr, OCT6).text === atr);
  t("2025年10月築の新築（12か月・月末なら11か月）はそのまま", fixStaleNewBuildClaim("2025年10月築の新築", OCT6).text === "2025年10月築の新築");
  t("2025年9月築の新築（13か月）は直す", fixStaleNewBuildClaim("2025年9月築の新築で室内綺麗です", OCT6).text === "2025年9月築の築浅物件で室内綺麗です");
  t("年だけ 2025年築の新築（12月とみて10か月）はそのまま", fixStaleNewBuildClaim("2025年築の新築", OCT6).text === "2025年築の新築");
  t("年だけ 2024年築の新築（22か月）は直す", fixStaleNewBuildClaim("2024年築の新築のお部屋となります", OCT6).text === "2024年築の築浅のお部屋となります");
  t("新築物件 → 築浅物件", fixStaleNewBuildClaim("2024年3月築の新築物件です", OCT6).text === "2024年3月築の築浅物件です");
  t("新築マンション → 築浅マンション", fixStaleNewBuildClaim("2024年3月築の新築マンションです", OCT6).text === "2024年3月築の築浅マンションです");
  t("「築で新築」→「築の築浅物件」", fixStaleNewBuildClaim("2024年3月築で新築となります", OCT6).text === "2024年3月築の築浅物件となります");
  t("築年の無い新築はそのまま（本文だけでは決めない）", fixStaleNewBuildClaim("新築のお部屋です", OCT6).text === "新築のお部屋です");
  t("「新築物件のみ退去時」等は形が違うので触らない", fixStaleNewBuildClaim("※新築物件のみ退去時クリーニング", OCT6).text === "※新築物件のみ退去時クリーニング");
  t("築年数浅く はそのまま", fixStaleNewBuildClaim("2025年5月築で築年数浅く", OCT6).text === "2025年5月築で築年数浅く");
}
{
  t("資料が新築でない時の注意", findUnsupportedNewBuild("新築のお部屋です", { newBuild: false }) !== null);
  t("資料が新築・分からない時は言わない", findUnsupportedNewBuild("新築のお部屋です", { newBuild: true }) === null && findUnsupportedNewBuild("新築のお部屋です", { newBuild: null }) === null);
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
