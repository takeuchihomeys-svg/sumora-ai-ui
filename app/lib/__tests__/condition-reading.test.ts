// app/lib/__tests__/condition-reading.test.ts — お客様の LINE から条件の発言を種類ごとに読む（実行: npx tsx app/lib/__tests__/condition-reading.test.ts）
// 2026-10-06 ⑫ 竹内さん（質問4「入居時期いれる」・質問5「会話によって読みとる部分でたりていないところあればつける」）。本番の実物で
import { readConditionStatements, moveInStatementOf } from "../condition-reading";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const kinds = (s: string) => readConditionStatements(s).map((x) => x.kind).sort().join(",");

// 入居時期（本番の実物）
t("「11月1日入居希望です。」→ 11月1日", moveInStatementOf("11月1日入居希望です。") === "11月1日");
t("「入居は年内くらい」→ 年内", moveInStatementOf("駅近家賃12万以内\n入居は年内くらい\n2dk以上") === "年内");
t("「2028/3月以降入居」→ 2028/3月以降", moveInStatementOf("2028/3月以降入居\n4~7万\n2LDK") === "2028/3月以降", String(moveInStatementOf("2028/3月以降入居\n4~7万\n2LDK")));
t("「入居時期が12月中旬になりそうです」→ 12月中旬", moveInStatementOf("入居時期が12月中旬になりそうです") === "12月中旬");
// 読まない（物件1件の入居可能日の質問）
t("「最短でも入居可能日は11月中旬でしょうか？」は読まない", moveInStatementOf("最短でも入居可能日は11月中旬でしょうか？") === null);
t("「ここは最短11月中旬でしょうか？」は読まない", moveInStatementOf("ここは最短11月中旬でしょうか？") === null);
t("物件の URL つきは読まない", moveInStatementOf("https://suumo.jp/chintai/bc_1/ ここ11月入居できますか") === null);

// まとめて読む
t("R の文 → エリア", kinds("詳細ありがとうございます！\n\nちなみに旭区、都島区、城東区、阿倍野区、今里方面で同じような条件でお部屋はありますか？") === "エリア");
t("条件の一覧 → エリア・家賃・間取り・入居時期・設備（二人入居）", kinds("彼女と二人で住む部屋探してます。\n天王寺か阿倍野あたりで1LDK、家賃10万までで探せますか？\n入居は12月希望です") === ["エリア", "家賃", "間取り", "入居時期", "設備"].sort().join(","), kinds("彼女と二人で住む部屋探してます。\n天王寺か阿倍野あたりで1LDK、家賃10万までで探せますか？\n入居は12月希望です"));
t("「ちなみに1LDKじゃなくて2LDKとかないでしょうか？」→ 間取り", kinds("ちなみに1LDKじゃなくて\n2LDKとかないでしょうか？").includes("間取り"));
t("「梅田まで30分以内」→ 通勤", kinds("梅田まで30分以内で、家賃7万くらいまでの1Kか1DK探してます！").includes("通勤"));
t("「1階はNGです」→ NG", kinds("1階はNGでお願いします").includes("NG"));
t("「猫を飼っています」→ ペット", kinds("猫を1匹飼っているのでペット可でお願いします").includes("ペット"));
t("「独立洗面台が欲しい」→ 設備", kinds("独立洗面台がある部屋がいいです").includes("設備"));
// 誤って捉えない（物件1件への質問・物件の問い合わせ）
t("「ガスコンロはついてないのですか？」は条件にしない", kinds("ガスコンロはついてないのですか？") === "");
t("「ここ駐車場と駐輪場ありますか？」は条件にしない", kinds("ここ駐車場と駐輪場ありますか？") === "");
t("物件の URL＋号室は条件にしない", kinds("https://www.homes.co.jp/chintai/b-1522840038291/\nこの物件の見積もりと入居可能日を教えていただきたいです。") === "");
t("初期費用の金額は家賃にしない", !kinds("初期費用10万以下だと助かります").includes("家賃"));

t("「即入居可ですか、？」は読まない（物件の質問）", moveInStatementOf("ありがとうございます！\n即入居可ですか、？") === null);
t("物件の一覧の見出し「＜北摂エリア＞」はエリアにしない", !kinds("ありがとうございます。\n＜北摂エリア＞\n・サンハイツ101\n・レオパレスイルリビエル 102号室").includes("エリア"));
t("物件の話と同居の「近大周辺でも同じ条件で探して欲しい」はエリア", kinds("この物件だと初期費用はどのくらいでしょうか？\nあと、近大周辺でも同じ条件で探して欲しいです。。").includes("エリア"));

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
