// 「お送り頂きました物件」への置き換えの守り（2026-11-21 作業員G・#454・SHARED_REF_GUARD_1121・既定 off）
// 実行: npx tsx app/lib/__tests__/shared-ref-guard-1121.test.ts
import { normalizeSharedPropertyReference, sharedRefGuard1121On } from "../shared-property-ref";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const turn = "[画像] 【物件の画面（SNS・広告）】 北浜駅徒歩2分 WIC付き 1LDK 9.8万円";
const on = (s: string) => { process.env.SHARED_REF_GUARD_1121 = "on"; const r = normalizeSharedPropertyReference(s, turn).text; delete process.env.SHARED_REF_GUARD_1121; return r; };
const off = (s: string) => { process.env.SHARED_REF_GUARD_1121 = "off"; const r = normalizeSharedPropertyReference(s, turn).text; delete process.env.SHARED_REF_GUARD_1121; return r; };
t("既定 off", !sharedRefGuard1121On({}) && sharedRefGuard1121On({ SHARED_REF_GUARD_1121: "on" }));
// 実物の形（120日の監査で見つけた壊れた置き換え）
const a = "お送り頂きました北浜駅徒歩2分・WIC付き1LDKのお部屋、募集状況確認させて頂きます！！";
t("off は語の途中から置き換えて壊していた（今の動き）", off(a).includes("WIC付きお送り頂きました"), off(a));
t("on: 徒歩分のある描写を丸ごと外す", on(a) === "お送り頂きましたお部屋、募集状況確認させて頂きます！！", on(a));
const b = "また家賃15万円のハウスメーカーのお部屋を生野区、東住吉区、平野区全域からお調べさせて頂きます！！";
t("on: 探す約束の文は触らない", on(b) === b, on(b));
const c = "aさんにオススメできる大型犬飼育可の3LDKのお部屋ピックアップしてお送りさせて頂きます！！";
t("on: ピックアップの約束は触らない", on(c) === c, on(c));
// 店が実際に使う呼び方（建物名・地域・間取り・階）は残す
for (const s of ["お送り頂きました園田1LDK3階のお部屋、募集状況確認させて頂きます！！", "お送り頂きましたTikTokの堀江エリア2LDKのお部屋は、募集状況を確認させて頂きます！！", "お送り頂きました千里丘の物件の募集状況確認させて頂きます！！"]) t(`on: 店の呼び方を残す「${s.slice(8, 22)}」`, on(s) === s, on(s));
// 竹内さんの 9/12 の形（徒歩分）は今まで通り置き換える
const d = "かしこまりました！！ 十三徒歩7分の物件、募集状況確認させて頂きます！！";
t("on: 「十三徒歩7分の物件」は今まで通り", on(d) === "かしこまりました！！ お送り頂きました物件、募集状況確認させて頂きます！！", on(d));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
