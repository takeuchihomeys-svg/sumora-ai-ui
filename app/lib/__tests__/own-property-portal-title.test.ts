// ポータルの画面の見出しから物件名（2026-11-18 作業員H・OWN_PROPERTY_PORTAL_TITLE・既定 off）
// 実行: npx tsx app/lib/__tests__/own-property-portal-title.test.ts
import { extractScreenshotProperty, portalTitleName, ownPropertyPortalTitleOn } from "../own-property-match";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
// 実物（直近10日の読み取り文・電話やお客様の名前は含まない画面の文字だけ）
const suumo1 = "[画像] 【物件の画面（ポータル）】 着信/通知音量 suumo スーモ 最近みた物件 お気に入り メニュー ザ・タワー大阪(1LDK/9階/55.1m²)の賃貸住宅情報 2/20 [Floor plan image showing 1LDK layout]";
const suumo2 = "[画像] 【物件の画面（ポータル）】 20:56 suumo.jp SUUMO スーモ 最近みた物件 ♡4 お気に入り メニュー 第二福井マンション(2LDK/2階/65m²)の賃貸住宅情報｜エイブルネットワーク関大前店";
const suumo3 = "[画像] 【物件の画面（ポータル）】 セイバリーレイン(1LDK/1階/42.06m²)の賃貸住宅情報 2/20 玄関(SB) 洋室 6帖";
const homes = "[画像] 【物件の画面（ポータル）】 13:01 賃貸アパート シエーナ魚崎 9万円／管理費等5,000円 敷 無 礼 無 初期費用の目安を確認する";
const ours = ["[画像] 【物件の資料】", "物件名：アイボリーフロント雑賀WEST", "号室名：803（8階部分）"].join("\n");
t("既定 off", !ownPropertyPortalTitleOn({}) && ownPropertyPortalTitleOn({ OWN_PROPERTY_PORTAL_TITLE: "on" }));
t("SUUMO の見出し（画面の文字が前にある）", portalTitleName(suumo1) === "ザ・タワー大阪", portalTitleName(suumo1));
t("SUUMO の見出し（店名の続き）", portalTitleName(suumo2) === "第二福井マンション", portalTitleName(suumo2));
t("SUUMO の見出し（先頭）", portalTitleName(suumo3) === "セイバリーレイン", portalTitleName(suumo3));
t("HOME'S の種別＋名前＋家賃", portalTitleName(homes) === "シエーナ魚崎", portalTitleName(homes));
t("名前の無いポータルの画面は取らない", portalTitleName("[画像] 【物件の画面（ポータル）】 賃貸 6.2万円（13階建/5階） 管理費等：8,000円") === null);
const prev = process.env.OWN_PROPERTY_PORTAL_TITLE;
process.env.OWN_PROPERTY_PORTAL_TITLE = "on";
const a = extractScreenshotProperty(suumo1);
t("on: 取り出し（号室は分からない＝null）", !!a && a.name === "ザ・タワー大阪" && a.room === null, a);
const b = extractScreenshotProperty(ours);
t("on: 見出しの形（物件名：）は今まで通り先", !!b && b.name === "アイボリーフロント雑賀WEST" && b.room === "803", b);
process.env.OWN_PROPERTY_PORTAL_TITLE = "off";
t("off: 今まで通り取らない", extractScreenshotProperty(suumo1) === null);
if (prev === undefined) delete process.env.OWN_PROPERTY_PORTAL_TITLE; else process.env.OWN_PROPERTY_PORTAL_TITLE = prev;
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
