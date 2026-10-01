// app/lib/__tests__/co-resident.test.ts
// 2026-10-02 竹内さん「申込へのフォーマットは同居人の有無で形が違う。会話・条件から判断・分からなければ選ばずスタッフに選ばせる」の回帰テスト。
//   文は本番のお客様の発言の形（名前・個人の値は入れていない）。
// 実行: npx tsx app/lib/__tests__/co-resident.test.ts
import { detectCoResident } from "../co-resident";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const v = (c: string[], cond: string[] = []) => detectCoResident(c, cond).value;

console.log("── 同居あり");
t("彼女と一緒に住みますので", v(["ご回答ありがとうございます", "彼女と一緒に住みますので、彼女の意向も聞いて判断してから"]) === "shared");
t("こちらかなり僕の嫁も気に入っている物件です", v(["こちらかなり僕の嫁も気に入っている物件です"]) === "shared");
t("主人が行けなくて", v(["その日だと主人が行けなくて、私一人なので"]) === "shared");
t("同棲予定です", v(["同棲予定です！"]) === "shared");
t("子供が1人います", v(["子供1人います"]) === "shared");
t("二人入居でお願いします", v(["二人入居でお願いします"]) === "shared");
t("条件の欄「二人入居可・トイレと風呂別」→ 同居あり", v([], ["二人入居可・トイレと風呂別・独立洗面台"]) === "shared");

console.log("── 単独");
t("一人暮らしにいい物件", v(["一人暮らしにいい物件で、可能であれば5階以上希望します。"]) === "single");
t("単身です", v(["単身での入居になります"]) === "single");

console.log("── 分からない（選ばない）");
t("手がかりなし", v(["初期費用いくらですか？", "内覧したいです"]) === "unknown");
t("「大丈夫です」の『夫』を拾わない", v(["大丈夫です！", "8月の末で大丈夫です！！"]) === "unknown");
t("物件の画像の読み取りの「2人入居可能」は使わない", v(["[画像] 物件種目：【住居用】マンション 備考： ★2人入居可能 ★ペット1匹相談可能"]) === "unknown");
t("URL の通の「1LDK2人入居OK」も使わない", v(["https://suumo.jp/chintai/x 1LDK2人入居OK"]) === "unknown");
t("緊急連絡先・保証人の話（母に連絡）は使わない", v(["緊急連絡先は母でお願いします"]) === "unknown");
t("否定（同棲ではない）は使わない", v(["同棲ではないです"]) === "unknown");
t("ペットは同居人ではない", v(["猫1匹います", "ペット可でお願いします"]) === "unknown");
t("同じ発言に両方 → 分からない", v(["今は一人暮らしですが彼女と住む予定です"]) === "unknown");

console.log("── 言い直し（新しい発言を優先）");
t("前に一人暮らし → 後で同棲予定", v(["一人暮らしの部屋を探してます", "やっぱり同棲予定になりました"]) === "shared");
t("手がかりの語を返す", detectCoResident(["同棲予定です！"]).evidence === "同棲");

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
