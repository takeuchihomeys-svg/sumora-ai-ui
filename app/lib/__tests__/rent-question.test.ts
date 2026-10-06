// app/lib/__tests__/rent-question.test.ts — 2026-10-02 ⑫ 相場の質問の見分けと返信への材料（実行: npx tsx app/lib/__tests__/rent-question.test.ts）
import { customerAsksRentLevel, buildRentMarketNote } from "../rent-question";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
for (const s of ["ペットおっけ、8.5までの家賃で1dkはやっぱりないですよね💦", "旭区の1LDKの家賃相場教えてください。", "この間取りで8万台は中々ないですよね(だよね)多少中心から外れても、、って感じなんですが", "ちなみに14万以下で2LDKないですか？ 中央区と浪速区で"]) t(`相場の質問: ${s.slice(0, 20)}`, customerAsksRentLevel(s));
for (const s of ["①11月以降 ②9万まで ③1LDK ④築5年まで ⑤桜川周辺", "家賃の支払いの案内や火災保険の支払いの仕方がわからないのですが", "こちら空いてますか？", "家賃は少しでもお安く出来ないですか？"]) t(`相場の質問ではない: ${s.slice(0, 20)}`, !customerAsksRentLevel(s));
// 2026-10-07 返信の質の1巡目（穴:G1）: スタッフが相場の事実で答えていたのに当たらなかった問い（本番の実物）
for (const s of [
  "2LDKだともう少し上がりますか？",
  "家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？",
  "なるほどです！ ありがとうございます！ ちなみに6万以下は厳しいですよね💦",
  "福島ってなると野田駅周辺より家賃って上がりますか？💭",
  "共益費も含めて8万未満だと1LDKはむずかしいですか？",
  "ちなみになんですが、1LDKだと平均的に家賃いくらくらいなんでしょうか？",
  "家賃8万円くらいに抑えたいのでその場合は1Kになりますよね？",
  "平野区とかは家賃高いですか？",
  "エリアめちゃくちゃ悩んでて家賃安めのエリアだとどこら辺になりますか？😿",
  "初期費用を10万以下と家賃5万円代の物件ってやはり築が古くなりますか？",
  "10万だと2LDKは厳しいですか？",
]) t(`相場の質問（10/07）: ${s.slice(0, 24)}`, customerAsksRentLevel(s));
for (const s of [
  "1LDKにしたら2人入居は厳しいでしょうか？",
  "家賃をあげるのは厳しいです。",
  "10万超える物件は厳しいのでこの物件諦めます！",
  "家賃81000円ですよね？",
  "桜川の物件の家賃はいくらでしょうか？",
  "初期費用10万位内は厳しいでしょうか？",
  "今回の初期費用が会社からでるのですが、敷金礼金しか出なくて前家賃等を別の項目で書き換えることは厳しいですか？",
  "惹かれる物件なんですが、 共益費込で10万に納めたい所なんですが、その条件は難しいでしょうか。",
  "もし、7月下旬に契約となると、家賃日割り計算ですか？？",
]) t(`相場の質問ではない（10/07）: ${s.slice(0, 24)}`, !customerAsksRentLevel(s));
// 問いが名指しした間取り（登録と別の間取りの相場を渡す）
import("../rent-question").then(({ askedFloorPlan }) => {
  t("名指し: 2LDKだと", askedFloorPlan("2LDKだともう少し上がりますか？") === "2LDK");
  t("名指し: 1LDKだと平均的に", askedFloorPlan("ちなみになんですが、1LDKだと平均的に家賃いくらくらいなんでしょうか？") === "1LDK");
  t("名指し: 8万未満だと1LDKは", askedFloorPlan("共益費も含めて8万未満だと1LDKはむずかしいですか？") === "1LDK");
  t("名指しなし → null", askedFloorPlan("家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？") === null);
  t("2つ → null", askedFloorPlan("1LDKか2LDKはないでしょうか？") === null);
});
// 相場の問いは2段（ピックアップの約束）より先に答える
import("../rent-question").then(({ rentAnswerFirst, RENT_ANSWER_KEY_TOPIC }) => {
  const pickupDir = "新しいご条件でお部屋をピックアップしてお送りすると約束する返信にする（物件名・家賃は書かない・送るのは後で AIX）。";
  const rm = { sentences: ["都島区周辺の2LDKの家賃相場は10万円から11万円程となります！！"] };
  const r = rentAnswerFirst(pickupDir, ["お部屋ピックアップしお送りする約束", "お客様の質問「2LDKだともう少し上がりますか？」への答え（会話・資料にある事実で。無ければ確認の約束）"], "2LDKだともう少し上がりますか？", rm);
  t("相場の答えが先", r.applied && r.direction!.startsWith("お客様は家賃の相場") && r.keyTopics[0] === RENT_ANSWER_KEY_TOPIC);
  t("同じ問いの重複を外す", r.keyTopics.length === 2 && !r.keyTopics.some((k) => k.startsWith("お客様の質問「2LDK")));
  t("家賃を書かない指示とぶつけない", !/物件名・家賃は書かない/.test(r.direction!) && /家賃の数字は相場の文の物だけ/.test(r.direction!));
  t("材料の文が無い → そのまま", !rentAnswerFirst(pickupDir, [], "2LDKだともう少し上がりますか？", { sentences: [] }).applied);
  t("相場の問いでない → そのまま", !rentAnswerFirst(pickupDir, [], "2LDKで探してください", rm).applied);
});
const note = buildRentMarketNote({ area: "なんば", facts: ["なんばの1DKで8.5万以内（12件）の築年の中央値は38年"], sentences: ["なんば周辺の1DKの家賃相場は8万円から10万円程となります！！"] });
t("材料の文はそのまま渡す", note.includes("「なんば周辺の1DKの家賃相場は8万円から10万円程となります！！」"));
t("事実の数字はお客様に書かない", /ここの数字はお客様に書かない/.test(note));
t("材料が無ければ空", buildRentMarketNote(null) === "");
// 2026-10-02 竹内さん「要約したら築年数古めとなるってことをちゃんとお客さんに伝える」
const budget = "8.5万円以内の1DKですと築年数は古めのお部屋が中心となり、築30年程・25〜30㎡程が目安となります！！";
const old = buildRentMarketNote({ area: "なんば・梅田", facts: [], sentences: [budget], budgetSentence: budget, ageTendency: "old" });
t("築年数古め → 必ず入れる文", old.includes("必ずこの文をそのまま入れる") && old.includes("築年数は古め"));
t("築年数古め → スタッフの実際の次の一手", old.includes("家賃帯やご希望のエリア広げていただけましたら"));
t("古めでない → 次の一手は付けない", !buildRentMarketNote({ area: null, facts: [], sentences: [budget], budgetSentence: budget, ageTendency: null }).includes("次の一手"));
// 出口: 要の語（古め・築◯年程・◯〜◯㎡程）が残っていれば言い換えてよい（最後の確かめの Claude の下書きの実物）
import("../rent-question").then(({ budgetSentenceKept }) => {
  const b2 = "8.5万円以内の1DKですと築年数は古めのお部屋が中心となり、築30年程・25〜35㎡程が目安となります！！";
  const claudeDraft = "かしこまりました！！\n\n全然大丈夫です！！\n\nペット可・家賃8.5万円以内の1DKですと、築年数は古めのお部屋が中心となり、築30年程・25〜35㎡程が目安となりますが、なんば・梅田に出やすいエリア全域からYUMAさんにオススメできるお部屋をピックアップさせて頂きます！！";
  t("言い換えても要の語が残る → 通す", budgetSentenceKept(claudeDraft, b2));
  t("古めが抜けた → 止める", !budgetSentenceKept("8.5万円以内の1DKのお部屋をピックアップさせて頂きます！！", b2));
  t("目安の文が無い → 判定しない", budgetSentenceKept("何でも", null));
  console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
});
