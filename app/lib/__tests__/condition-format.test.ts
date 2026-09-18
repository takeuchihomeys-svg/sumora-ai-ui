// app/lib/__tests__/condition-format.test.ts
// 2026-09-18 竹内（💋chibi💋 事例）「お客さんから物件の条件送られたのに条件として読みとってない／
//   物件検索の拡張ツールにも反映されていない」の回帰テスト。本物の文だけを使う。
// 実行: npx tsx app/lib/__tests__/condition-format.test.ts
import { analyzeSumoraForm, isFilledSumoraForm } from "../condition-format";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── chibi（今回・⑧に質問が入っている）");
{
  const text = "▶︎【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒最短\n②【ご希望の家賃（◯万円〜◯万円）】⇒45000~50000\n③【希望の広さ・間取り】⇒1LDK\n④【希望築年数】\n⑤【ご希望のエリア・駅名】⇒杉本町\n⑥【ご希望の駅徒歩分数】⇒15\n⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒本当に初期費用2980円なんでしょうか？\n________________________\n※ 💋chibi💋さんご希望のご条件お送りください😌✨";
  const v = analyzeSumoraForm(text);
  t("埋まったフォームとして確定する", v.isFilledForm, JSON.stringify(v));
  t("項目は8つ見つかる", v.labelCount === 8, String(v.labelCount));
  t("値が入っているのは 入居/家賃/間取り/エリア/徒歩/その他 の6つ",
    v.filled.sort().join(",") === "area,floor_plan,move_in,other,rent,walk", v.filled.sort().join(","));
  t("空欄（築年数・初期費用）は filled に入らない",
    !v.filled.includes("building_age") && !v.filled.includes("initial_cost"));
  t("⑧の質問を理由に落とさない", isFilledSumoraForm(text));
}

console.log("── 落ちていた他のお客様（実データ・120日で26人）");
{
  const cases: Array<[string, string]> = [
    ["c（9/11・飾りなし）", "①【ご入居の時期】⇒10月、11月予定\n②【ご希望の家賃（◯万円〜◯万円）】⇒11万まで\n③【希望の広さ・間取り】⇒1LDK以上\n④【希望築年数】\n⑤【ご希望のエリア・駅名】⇒桜川、心斎橋、難波\n⑥【ご希望の駅徒歩分数】⇒\n⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒ペット可、同棲、子供可"],
    ["アオ（9/7・末尾に別の案内）", "【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒即\n②【ご希望の家賃（◯万円〜◯万円）】⇒14以下\n③【希望の広さ・間取り】⇒1LDK 30㎡〜\n④【希望築年数】 綺麗だと築年気にしないです\n⑤【ご希望のエリア・駅名】⇒堀江本町\n⑥【ご希望の駅徒歩分数】⇒10以内\n⑦【初期費用の限度額】⇒30\n⑧【その他ご要望あれば】⇒\n________________________\n※ 審査に不安な事がある方お気軽にお伝えください😊"],
    ["ちよ（8/1・⑤⑥⑦に⇒が無い）", "（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒3ヶ月以内\n②【ご希望の家賃（◯万円〜◯万円）】⇒10万以内\n③【希望の広さ・間取り】⇒1K 15畳程度（正方形だとありがたいです）\n④【希望築年数】5年以内\n⑤【ご希望のエリア・駅名】なし\n⑥【ご希望の駅徒歩分数】10分以内\n⑦【初期費用の限度額】無し\n⑧【その他ご要望あれば】⇒\n・キッチン別\n・バストイレ別"],
    ["T.Y（7/22・②の項目名が崩れている）", "【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒8月末頃\n②【ご希望の家賃）】⇒15万前後\n③【希望の広さ・間取り】⇒1LDK・2LDK\n④【希望築年数】\n⑤【ご希望のエリア・駅名】⇒四ツ橋、心斎橋、西大橋\n⑥【ご希望の駅徒歩分数】⇒10分\n⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒エアコン付き・2F以上の部屋"],
    ["🍎なおちん（8/24・②が短いラベル）", "（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒9月から10月\n②【ご希望の家賃】⇒8万から10万\n③【希望の広さ・間取り】⇒1LDK(45平米以上)、2LDK\n④【希望築年数】10年以内\n⑤【ご希望のエリア・駅名】⇒梅田まで30分\n⑥【ご希望の駅徒歩分数】⇒10分以内\n⑦【初期費用の限度額】⇒20万\n⑧【その他ご要望あれば】⇒二人入居可、ペット可能"],
    ["わっち（8/22・エリアは空だが他は埋まっている）", "▶︎【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10月～11月\n②【ご希望の家賃（◯万円〜5万円代）】⇒\n③【希望の広さ・間取り】⇒\n④【希望築年数】特になし\n⑤【ご希望のエリア・駅名】⇒\n⑥【ご希望の駅徒歩分数】⇒10分\n⑦【初期費用の限度額】⇒少ないほどいい\n⑧【その他ご要望あれば】⇒ペット可"],
  ];
  for (const [name, text] of cases) t(`${name} → 拾う`, isFilledSumoraForm(text), JSON.stringify(analyzeSumoraForm(text)));
}

console.log("── 値が次の行に来る形（LINE の折り返し）");
{
  const text = "（ご希望のお部屋探しご条件）\n①【ご入居の時期】\n⇒最短\n②【ご希望の家賃（◯万円〜◯万円）】\n⇒45000~50000\n③【希望の広さ・間取り】\n⇒1LDK";
  const v = analyzeSumoraForm(text);
  t("次の行の ⇒値 も読む", v.isFilledForm && v.filled.length === 3, JSON.stringify(v));
}

console.log("── 拾ってはいけない物（安全側）");
{
  const empty = "（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒\n②【ご希望の家賃（◯万円〜◯万円）】⇒\n③【希望の広さ・間取り】⇒\n④【希望築年数】\n⑤【ご希望のエリア・駅名】⇒\n⑥【ご希望の駅徒歩分数】⇒\n⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒";
  t("空のテンプレート（スタッフが送る形）は拾わない", !isFilledSumoraForm(empty));
  t("申込フォームは拾わない", !isFilledSumoraForm("①申込書\n②本人確認書類\n③収入証明"));
  t("ふつうの質問は拾わない", !isFilledSumoraForm("初期費用本当に2980円なんでしょうか？"));
  t("物件の共有文は拾わない", !isFilledSumoraForm("物件名：プルス新北野\n交通：南方駅 徒歩5分\n賃料：8.5万円"));
  t("短い了承は拾わない", !isFilledSumoraForm("かしこまりました\nありがとうございます"));
  t("空・null でも落ちない", !isFilledSumoraForm("") && !isFilledSumoraForm(null) && !isFilledSumoraForm(undefined));
  t("項目が2つだけなら拾わない（フォームとは限らない）",
    !isFilledSumoraForm("ご入居の時期は10月で、ご希望の家賃は8万円です"));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
