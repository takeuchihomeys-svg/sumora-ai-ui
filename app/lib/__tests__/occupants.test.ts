// app/lib/__tests__/occupants.test.ts
// 2026-10-02 竹内さんの決定（2回目）「条件ヒアリングに入居人数を足す」「分割もクレジットカードの手数料いれる」の回帰テスト。
//   文はお客様・スタッフの実物の形（scripts/audit-occupants.ts・audit-card-fee-paths.ts で出た物・名前なし）。
// 実行: npx tsx app/lib/__tests__/occupants.test.ts
import { occupantsFromText, occupantsFromTexts, detectCoResidentWithOccupants } from "../co-resident";
import { buildHearingForm, hearingKnownFromCustomerTexts, parseConditionText, mergeHearingKnown } from "../hearing-form";
import { analyzeSumoraForm } from "../condition-format";
import { ensureCardFeeLine, CARD_FEE_LINE } from "../company-fact-guard";
import { buildApplicationFormat } from "../application-format";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const cnt = (s: string) => occupantsFromText(s)?.count ?? null;

console.log("── 入居人数を読む（数が書いてある時だけ）");
t("⑨ご入居人数　2名", cnt("⑨ご入居人数　2名") === 2);
t("お客様のフォーム「6入居予定人数 ⇒1人」", cnt("5引越し時期(○○月など) ⇒すぐに\n6入居予定人数 ⇒1人") === 1);
t("「住む人数が大人2 子ども1 小型犬1 猫1」→ 3（ペットは数えない）", cnt("住む人数が大人2 子ども1 小型犬1 猫1になる予定です") === 3);
t("「夫婦と子ども1人の3人家族での入居」→ 3", cnt("夫婦と子ども1人の3人家族での入居。") === 3);
t("「大人1名未就学児2名」→ 3", cnt("大人1名未就学児2名が転がり込んでくる可能性がある") === 3);
t("「2人で住みたいので広めだと」→ 2", cnt("2人で住みたいので広めだと助かります。") === 2);
t("「二人暮らしするつもり」→ 2", cnt("二人暮らしするつもりなので") === 2);
t("「娘の一人暮らし用」→ 1", cnt("娘の一人暮らし用の賃貸マンションを探しています。") === 1);
t("数の無い「同棲」「夫婦」は読まない（人数が分からない）", cnt("同棲予定です") === null && cnt("夫婦で住みます") === null);
t("「人数:私と赤ちゃんとペット2匹」は読まない（数を作らない）", cnt("・人数:私と赤ちゃんとペット2匹") === null);
t("「前の一人暮らしの時は」「一人暮らし延期」は読まない", cnt("前の一人暮らしの時はそれで審査してもらいました。") === null && cnt("一人暮らし延期になりました。") === null);
t("物件の説明「1LDK2人入居OK」・画像の読み取りは読まない", cnt("1LDK2人入居OKの物件") === null && cnt("[画像] 物件情報 二人入居可") === null);
t("新しい発言を優先", occupantsFromTexts(["一人暮らしを探してます", "やっぱり2人で住むことになりました"])?.count === 2);

console.log("── 条件ヒアリングのフォーム ⑨ご入居人数");
{
  const f = buildHearingForm("YUMA", { desired_area: "難波周辺", occupants: 2 });
  t("⑨ に 2名（全角の空白）", f.endsWith("\n⑨ご入居人数　2名"), f);
  t("①〜⑧ の番号と文言は変わらない", f.includes("\n⑧その他こだわり条件（ペット・保証人・駐車場等）\n⑨"), f);
  const k = hearingKnownFromCustomerTexts(["難波周辺で二人入居でお願いします"]);
  t("発言「二人入居」→ ⑨ 2名", buildHearingForm("Y", k).includes("⑨ご入居人数　2名"), JSON.stringify(k));
  t("条件の文字「入居人数: 3名」も読む", parseConditionText("エリア: 梅田\n入居人数: 3名").occupants === 3);
  t("行が先（行 1名・発言 2人）", mergeHearingKnown({ occupants: 1 }, { occupants: 2 }).occupants === 1);
  const back = analyzeSumoraForm(buildHearingForm("Y", { occupants: 2 }).replace("①ご入居時期", "①ご入居時期 11月"));
  t("返ってきたフォームの ⑨ も項目として読む", back.filled.includes("occupants") && back.labelCount === 9, JSON.stringify(back));
}

console.log("── 申込へのフォーマット: 入居人数で単独／同居あり");
t("入居人数 1 → 単独", detectCoResidentWithOccupants(["ここで申し込みします"], [], 1).value === "single");
t("入居人数 2 → 同居あり", detectCoResidentWithOccupants(["ここで申し込みします"], [], 2).value === "shared");
t("入居人数 2 なのに「一人暮らし」→ 分からない（スタッフが選ぶ）", detectCoResidentWithOccupants(["一人暮らしの部屋を探してます"], [], 2).value === "unknown");
t("入居人数なし・手がかりなし → 分からない", detectCoResidentWithOccupants(["ここで申し込みします"], [], null).value === "unknown");
t("入居人数なし・発言「大人2 子ども1」→ 同居あり（3名）", (() => { const v = detectCoResidentWithOccupants(["大人2 子ども1です"], []); return v.value === "shared" && v.occupants === 3; })());
t("同居ありのフォーマットには【同居人記入欄】", buildApplicationFormat("shared", "emergency").includes("【同居人記入欄】") && !buildApplicationFormat("single", "emergency").includes("【同居人記入欄】"));

console.log("── 分割の手数料（AIX の出口で足す・ensureCardFeeLine）");
{
  const ask = ["初期費用って分割できますか？"];
  const r = ensureCardFeeLine("はい😊！！\n初期費用はクレジットカード払いですと分割可能です！！\nお手隙の際にご確認ください！！", ask);
  t("手数料なし → カード払いの文の次の行に足す", r.added && r.text.split("\n")[2] === CARD_FEE_LINE, r.text);
  t("3.24% がある → 足さない", !ensureCardFeeLine("カード払いの場合、合計金額に3.24%が別途かかります。クレジットカード払いですと分割可能です！！", ask).added);
  t("お客様が聞いていない → 足さない", !ensureCardFeeLine("クレジットカード払いですと分割可能です！！", ["ありがとうございます"]).added);
  t("否定の文（対応しておらず）は出来ると読まない", !ensureCardFeeLine("クレジットカード払いは対応しておらず、現金でのお振込みとなります", ask).added);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
