// app/lib/__tests__/aix-hold-floor-picker.test.ts — 竹内さんの指摘 #7・#27（お部屋止めについて・床の色について）
//   実行: npx tsx app/lib/__tests__/aix-hold-floor-picker.test.ts
import { holdFloorPickerUiOn, holdFloorPickerForBrain, buildHoldMgmtInfo, holdFormat, ensureHoldResult, buildFloorMgmtInfo, floorFormat, ensureFloorColor } from "../aix-hold-floor-picker";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("スイッチ既定 off", !holdFloorPickerUiOn(undefined) && holdFloorPickerUiOn("on") && !holdFloorPickerForBrain({}) && holdFloorPickerForBrain({ AIX_HOLD_FLOOR_PICKER: "on" }));

// KID 10/25 の手打ちの実物
const kid = "こちらお申込みしてお部屋押さえることができるか管理会社確認しましたところ11月末退去予定の為期間が長く\nお部屋止めをできないとのことでした。";
t("申込不可＋理由＝KID の手打ちと同じ文", holdFormat("申込不可", "11月末退去予定の為期間が長く") === kid);
t("理由が「〜の為」で終わらない字はつなぎを足す", holdFormat("申込不可", "退去予定日が未定").includes("退去予定日が未定の為\nお部屋止めをできない"));
t("申込可能は打ち消しが無い", !/できない|出来ない/.test(holdFormat("申込可能", "")) && /お部屋止めできる/.test(holdFormat("申込可能", "")));
t("物件名があれば頭に", holdFormat("申込不可", "", "アーバンフラッツ心斎橋 502号室").startsWith("アーバンフラッツ心斎橋 502号室お申込みして"));
t("入力情報: 結果が無ければ止める", (() => { try { buildHoldMgmtInfo({ result: "x" }); return false; } catch { return true; } })());
t("入力情報: 理由・物件名を字のまま", buildHoldMgmtInfo({ result: "申込不可", reason: "11月末退去予定の為期間が長く", propertyName: "A 502号室" }).includes("理由（管理会社の回答のまま）：11月末退去予定の為期間が長く"));
// 出口
t("出口: 申込不可なのに打ち消しが無い → 型に差し替え", ensureHoldResult("こちらお申込みでお部屋止めできるとのことでした😊！！", "申込不可", "11月末退去予定の為期間が長く") === kid);
t("出口: 申込不可で理由の字があればそのまま", ensureHoldResult(`KIDさんお世話になっております！！\n${kid}`, "申込不可", "11月末退去予定の為期間が長く").startsWith("KIDさん"));
t("出口: 申込可能に打ち消しが混ざれば差し替え", ensureHoldResult("お部屋止めできないとのことでした。", "申込可能", "") === holdFormat("申込可能", ""));
t("出口: 「できるか確認」は打ち消しと読まない", ensureHoldResult("こちらお申込みしてお部屋押さえることができるか管理会社確認しましたところ\nお申込みでお部屋止めできるとのことでした😊！！", "申込可能", "").includes("止めできる"));

// 床の色（10/26 の手打ち）
t("床の色: 型", floorFormat("グレー") === "こちら床の色グレーとなります！！");
t("床の色: 補足は次の行に字のまま", floorFormat("グレー", "偶数階のお部屋が白色、奇数階のお部屋がグレー") === "こちら床の色グレーとなります！！\n偶数階のお部屋が白色、奇数階のお部屋がグレー");
t("床の色: 色が無ければ止める", (() => { try { buildFloorMgmtInfo({ color: " " }); return false; } catch { return true; } })());
t("床の色: 出口 色の字が無ければ差し替え", ensureFloorColor("こちら床の色ブラウンとなります！！", "グレー") === "こちら床の色グレーとなります！！");
t("床の色: 出口 色の字があればそのまま", ensureFloorColor("こちら床の色グレーとなります！！\nよろしければ一度ご案内させて頂きます！！", "グレー").includes("ご案内"));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
