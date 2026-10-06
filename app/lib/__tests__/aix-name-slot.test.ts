// app/lib/__tests__/aix-name-slot.test.ts
// 2026-10-06 ⑰: AIX の下書きの名前の欄の「お客様」（行頭）を、名前があれば名前・無ければ呼ばない／スタッフが冒頭で2回以上呼んだ名前は形を問わず使う
// 実行: npx tsx app/lib/__tests__/aix-name-slot.test.ts
import { fixSecondPersonOkyaku } from "../okyaku-address";
import { staffCalledName } from "../aix-staff-called-name";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

// ── 行頭の名前の欄（実物の形・10/02〜10/06 の下書き）
{
  const d = "お客様  \n\n吹田市・茨木市周辺全域から、今月末までにご入居いただける1LDK以上・小型犬可のお部屋をピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！";
  const r = fixSecondPersonOkyaku(d, null);
  t("名前が無い: 「お客様」だけの行は行ごと書かない", r.text.startsWith("吹田市・茨木市") && !r.text.includes("お客様"), JSON.stringify(r.text.slice(0, 30)));
  const r2 = fixSecondPersonOkyaku(d, "R");
  t("名前がある: 「Rさん」の行にする", r2.text.startsWith("Rさん\n") && !r2.text.includes("お客様"), JSON.stringify(r2.text.slice(0, 20)));
}
{
  const d = "お客様確認させていただきました！！\nシャーメゾン セゾン ヴェール 0203号室現在募集中となります！！";
  t("名前が無い: 「お客様確認させていただきました」→「確認させていただきました」（スタッフの実送信と同じ）", fixSecondPersonOkyaku(d, null).text.startsWith("確認させていただきました！！\n"));
  t("名前がある: 「Sさん確認させていただきました」", fixSecondPersonOkyaku(d, "Sさん").text.startsWith("Sさん確認させていただきました！！"));
  const d2 = "お客様お送り頂きました物件の中で\n・T-SPACE（東住吉区）";
  t("「お客様お送り頂きました物件の中で」→「お送り頂きました物件の中で」", fixSecondPersonOkyaku(d2, null).text.startsWith("お送り頂きました物件の中で"));
  const d3 = "お客様お世話になっております！！\n御見積書同封させて頂きました！！";
  t("「お客様お世話になっております」→ 名前で呼ぶ", fixSecondPersonOkyaku(d3, "あ").text.startsWith("あさんお世話になっております！！"));
}
// ── 他の人を指す「お客様」・文の途中は触らない（前からの決まり）
{
  const third = "1番手で別のお客様がお申込みされております！！";
  t("他の人の「お客様」は触らない", fixSecondPersonOkyaku(third, null).text === third);
  const mid = "ご紹介頂きましたお客様には紹介料をお支払いしております！！";
  t("ご紹介頂きましたお客様は触らない", fixSecondPersonOkyaku(mid, null).text === mid);
  const listHead = "お客様名（記入欄）\n・氏名";
  t("行頭でも「お客様名」（記入欄）は触らない", fixSecondPersonOkyaku(listHead, null).text === listHead);
}
// ── スタッフが冒頭で呼んだ名前
{
  const msgs = [
    { sender: "staff", text: "Rさんお世話になっております！！" },
    { sender: "customer", text: "よろしくお願いします" },
    { sender: "staff", text: "Rさん\n物件ピックアップさせて頂きました！！" },
  ];
  t("2回以上呼んだ1文字の名前を拾う", staffCalledName(msgs) === "R");
  t("1回だけは拾わない", staffCalledName(msgs.slice(0, 2)) === "");
  const heart = [{ sender: "staff", text: "❤︎さんお世話になっております！！" }, { sender: "staff", text: "❤︎さん\nかしこまりました！！" }];
  t("記号の名前も、スタッフが2回呼んでいれば拾う", staffCalledName(heart) === "❤︎");
  const owner = [{ sender: "staff", text: "オーナーさんに確認します" }, { sender: "staff", text: "オーナーさんから返事がありました" }];
  t("名前でない語（オーナー）は拾わない", staffCalledName(owner) === "");
  const cust = [{ sender: "customer", text: "Rさん" }, { sender: "customer", text: "Rさん" }];
  t("お客様の発言は見ない", staffCalledName(cust) === "");
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
