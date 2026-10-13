// 2026-10-13 当たり率の直し（区切り3・記録）: AIX の記録の物件名が送った本文と違う時は本文の名前を正にする（aix-sent-names.reconcileAixPropertyNames）
// 実行: npx tsx app/lib/__tests__/aix-names-from-text.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileAixPropertyNames, reportNamesFromText } from "../aix-sent-names";
import { matchLoose, isSameLoose } from "../property-name-loose";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
const same = (a: string, b: string) => isSameLoose(matchLoose(a, b));

const MIOU = "未桜さんお待たせしました！！\n\nレジュールアッシュ難波MINAMIの募集状況確認させて頂きました！！\n現在1番手でお申込が入っており、2番手以降でお申込可能となります！！\n\n最大限割引しました初期費用の御見積書同封させて頂きました！！";
const YUMA1 = "YUMAさん\n\nプレサンス難波WEST 0205号室の募集状況確認させて頂きましたところ、現在も募集中のお部屋となります！！";
const YUMA2 = "YUMAさん\nRainbow Court 立売堀の募集状況を確認しましたが、現在募集に出ていないお部屋となります。\nお送りいただいた他の52件につきましても、いずれも募集終了";
const YUMA3 = "YUMAさん、ご事情お伝え頂きありがとうございます！！\n審査結果につきましては保証会社の審査次第となりますが";

console.log("■ 本文の物件名");
t("未桜: レジュールアッシュ難波MINAMI", JSON.stringify(reportNamesFromText(MIOU)) === JSON.stringify(["レジュールアッシュ難波MINAMI"]), reportNamesFromText(MIOU));
t("YUMA: プレサンス難波WEST 0205号室", JSON.stringify(reportNamesFromText(YUMA1)) === JSON.stringify(["プレサンス難波WEST 0205号室"]), reportNamesFromText(YUMA1));
t("YUMA: Rainbow Court 立売堀（「他の52件につきまして」は名前にしない）", JSON.stringify(reportNamesFromText(YUMA2)) === JSON.stringify(["Rainbow Court 立売堀"]), reportNamesFromText(YUMA2));
t("「大阪市内」「梅田駅徒歩10分圏内」は物件名にしない", reportNamesFromText("大阪市内の募集状況確認させて頂きます！！\n梅田駅徒歩10分圏内の募集状況も確認させて頂きます！！").length === 0, reportNamesFromText("大阪市内の募集状況確認させて頂きます！！\n梅田駅徒歩10分圏内の募集状況も確認させて頂きます！！"));
t("名前の無い本文", reportNamesFromText(YUMA3).length === 0, reportNamesFromText(YUMA3));
t("ブラービ南船場 / 7階…607号室現在募集中", reportNamesFromText("ブラービ南船場\n7階のお部屋は募集に出ておらず、同じ間取りの 607号室現在募集中となります！！").every((n) => !/間取り/.test(n)), reportNamesFromText("ブラービ南船場\n7階のお部屋は募集に出ておらず、同じ間取りの 607号室現在募集中となります！！"));

console.log("■ 記録の物件名を本文に合わせる");
t("未桜 10/9: エステムコート難波IVアトリ → レジュールアッシュ難波MINAMI", JSON.stringify(reconcileAixPropertyNames(["エステムコート難波IVアトリ"], MIOU, same, {}).names) === JSON.stringify(["レジュールアッシュ難波MINAMI"]));
t("YUMA 9/27: エステムコート大阪WEST → プレサンス難波WEST 0205号室", reconcileAixPropertyNames(["エステムコート大阪WEST"], YUMA1, same, {}).names?.[0] === "プレサンス難波WEST 0205号室");
t("本文に名前が無ければ触らない", reconcileAixPropertyNames(["エステムコート大阪WEST"], YUMA3, same, {}).changed === false);
t("画面の名前が本文に出る時は触らない", reconcileAixPropertyNames(["レジュールアッシュ難波MINAMI"], MIOU, same, {}).changed === false);
t("書き方の違いでも同じ物件なら触らない（サンライトあべの8／阿倍野8）", reconcileAixPropertyNames(["サンライト阿倍野8 202号室"], "サンライトあべの8 202号室につきまして確認中です", same, {}).changed === false);
t("件数が違う時は触らない（物件ごとの結果の並びを崩さない）", reconcileAixPropertyNames(["A棟", "B棟"], MIOU, same, {}).changed === false);
t("【ペット飼育不可】の見出しは名前にしない", reconcileAixPropertyNames(["小若江 貸家"], "KAORIさん小若江の貸家、ペット飼育の可否確認させて頂きましたところ、【ペット飼育不可】とのことでした。", same, {}).changed === false);
t("物件送付（本文はご条件の文）は触らない", reconcileAixPropertyNames(["ディアコート曽根 202号室"], "豊中市、茨木市全域から現在募集中の家賃抑えられるお部屋もお送りさせていただきました！！", same, {}, "property_send").changed === false);
t("AIX_NAMES_FROM_TEXT=off", reconcileAixPropertyNames(["エステムコート難波IVアトリ"], MIOU, same, { AIX_NAMES_FROM_TEXT: "off" }).changed === false);

console.log("■ 画面: 売上サポの物件名は同じ種類の AIX にだけ先入れ");
const page = readFileSync(join(__dirname, "..", "..", "page.tsx"), "utf8");
t("prefillPropertyNames は handoff の aix と同じ種類の時だけ", /pickupHandoffRef\.current\?\.aix === aixModalType/.test(page));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
