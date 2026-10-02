// app/lib/__tests__/grounded-amount.test.ts
// 2026-10-02 ⑫: 見積金額内訳ゲートの「会話に既に出ている金額の引用」免除・待ち合わせ確定ゲートの中身の無い置換文をやめる（実物の文）
// 実行: npx tsx app/lib/__tests__/grounded-amount.test.ts
import { isGroundedAmountSentence, GROUND_SEP, validateAndClean } from "../validate-reply";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

const ground = ["🌟サンロール難波南 703\n・家賃53500円・管理費7500円(合計61000円)\n敷金礼金なし", "お手隙の際にご査収ください😌！！"].join(GROUND_SEP);
t("こちらが送った資料の金額の引用は根拠あり（実物 00a98cde）", isGroundedAmountSentence("サンロール難波南703が家賃管理費込61,000円と無料のインターネットで月額費用を抑える事ができ", ground));
t("会話に無い金額は根拠なし", !isGroundedAmountSentence("家賃管理費込59,000円のお部屋となります！！", ground));
t("1つでも会話に無い金額があれば根拠なし", !isGroundedAmountSentence("家賃管理費込61,000円・敷金50,000円となります", ground));
t("別々の通の数字の寄せ集めは根拠なし", !isGroundedAmountSentence("家賃53,500円・初期費用120,000円", ["家賃53500円", "初期費用120000円"].join(GROUND_SEP)));
t("金額の無い文は対象外（false）", !isGroundedAmountSentence("敷金礼金なしのお部屋です", ground));
t("610,000円 を 61000円 と取り違えない", !isGroundedAmountSentence("合計610,000円", ground));

{
  const draft = "YUMAさんお世話になっております！！\n家賃管理費込61,000円のサンロール難波南703、かなりオススメ出来るお部屋となります！！";
  const withGround = validateAndClean(draft, { aixGates: true, groundText: ground, customerMessage: "ここ気になります", lastStaffMsg: "お手隙の際にご査収ください😌！！" });
  t("validateAndClean: 根拠のある金額の文は見積書の宣言に置き換えない", withGround.cleaned.includes("61,000円"), withGround.cleaned);
  const noGround = validateAndClean(draft, { aixGates: true, customerMessage: "ここ気になります", lastStaffMsg: "お手隙の際にご査収ください😌！！" });
  t("validateAndClean: 根拠が無ければ従来どおり置き換える", !noGround.cleaned.includes("61,000円"), noGround.cleaned);
}
{
  const draft = "はい😊！！\n9/11 12:00に現地エントランス前でお待ちしております！！\nどうぞよろしくお願い致します😌！！";
  const r = validateAndClean(draft, { aixGates: true, customerMessage: "9/11何卒よろしくお願いします", lastStaffMsg: "" });
  t("待ち合わせ確定: 中身の無い「内覧の詳細についてはご連絡」を入れない", !r.cleaned.includes("内覧の詳細"), r.cleaned);
  t("待ち合わせ確定: 時刻・場所の文は落とす", !r.cleaned.includes("エントランス"), r.cleaned);
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
