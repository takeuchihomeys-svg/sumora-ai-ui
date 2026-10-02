// app/lib/__tests__/rent-question.test.ts — 2026-10-02 ⑫ 相場の質問の見分けと返信への材料（実行: npx tsx app/lib/__tests__/rent-question.test.ts）
import { customerAsksRentLevel, buildRentMarketNote } from "../rent-question";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
for (const s of ["ペットおっけ、8.5までの家賃で1dkはやっぱりないですよね💦", "旭区の1LDKの家賃相場教えてください。", "この間取りで8万台は中々ないですよね(だよね)多少中心から外れても、、って感じなんですが", "ちなみに14万以下で2LDKないですか？ 中央区と浪速区で"]) t(`相場の質問: ${s.slice(0, 20)}`, customerAsksRentLevel(s));
for (const s of ["①11月以降 ②9万まで ③1LDK ④築5年まで ⑤桜川周辺", "家賃の支払いの案内や火災保険の支払いの仕方がわからないのですが", "こちら空いてますか？", "家賃は少しでもお安く出来ないですか？"]) t(`相場の質問ではない: ${s.slice(0, 20)}`, !customerAsksRentLevel(s));
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
