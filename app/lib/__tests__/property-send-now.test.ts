// app/lib/__tests__/property-send-now.test.ts
// 2026-10-06 ⑰: 会話を合わせるの物件ピックアップで、前回の送付より後のやり取りを時系列で読む（あかりさんの事例の形・名前と物件名は伏せる）
// 実行: npx tsx app/lib/__tests__/property-send-now.test.ts
import { readSendNow, effectiveSendFrame, buildSendNowBlock } from "../property-send-now";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

// あかりさんの形（10/01〜10/04）
const AKARI = [
  { sender: "staff", text: "〇〇さんお送り頂きました物件の中で\n・Aマンション 6FA\n・B大物町 301号室\nこちら2件どちらも…現在募集中となります！！\n最大限割引しました初期費用御見積書同封させて頂きました。\nお手隙の際にご査収ください！！" },
  { sender: "customer", text: "最短でどのくらいに入れるってなってますか！大物のほう！です" },
  { sender: "staff", text: "B大物町301号室\n最短での入居可能時期10/8日となります！！" },
  { sender: "customer", text: "ふたり入居可ですか？" },
  { sender: "staff", text: "B大物町お2人でのご入居可能なお部屋となります😌！！" },
  { sender: "customer", text: "一緒に住む人に相談します！" },
  { sender: "customer", text: "ブランシュール 2階\nhttps://suumo.jp/chintai/bc_000/\nby SUUMO" },
  { sender: "customer", text: "ここの初期費用と最短教えて欲しいです" },
  { sender: "staff", text: "〇〇さんお世話になっております！！\nお送り頂きました物件1件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！" },
  { sender: "customer", text: "別れることになって" },
  { sender: "customer", text: "私一人になるかもです" },
  { sender: "staff", text: "〇〇さん、お一人でのご入居となりますと、ご希望の条件が変わることもあるかと思いますので、改めて家賃・広さ・設備のご希望を教えて頂けますと幸いです！！" },
  { sender: "customer", text: "なんかいい部屋ありますかね" },
  { sender: "customer", text: "ここの部屋に似た感じでちっさくて大丈夫です！" },
  { sender: "staff", text: "かしこまりました！！\nオススメできるお部屋ピックアップさせていただきます😊！！" },
  { sender: "staff", text: "以前お送りいただきましたお部屋探しのご条件から変更される条件はございますでしょうか！！" },
];

{
  const now = readSendNow(AKARI);
  t("前回の送付（物件確認した・ご査収）を線にする", now.hasPreviousSend);
  t("お客様の依頼（いい部屋ありますか）とこちらの約束で requested", now.requested);
  t("条件の変化に「一人になる」「ちっさくて大丈夫」が入る", now.conditionChange.some((s) => s.includes("一人になる")) && now.conditionChange.some((s) => s.includes("ちっさく")), JSON.stringify(now.conditionChange));
  t("変化の前の質問「ふたり入居可ですか？」は条件の変化に入れない", !now.conditionChange.some((s) => s.includes("ふたり")), JSON.stringify(now.conditionChange));
  t("最新の発言が先頭（新しい順）", now.customerLatest[0]?.includes("似た感じ") === true, JSON.stringify(now.customerLatest.slice(0, 2)));
  t("URL の行は入れない", !now.customerLatest.some((s) => /https?:/.test(s)));
  t("こちらのピックアップの約束が入る", now.staffPromises.some((s) => s.includes("ピックアップさせていただきます")), JSON.stringify(now.staffPromises));
  t("送り方の既定が新着でも、依頼・条件の変化に応えた送付は requested", effectiveSendFrame("new_arrival", now) === "requested");
  const block = buildSendNowBlock(now);
  t("生成に渡すブロックに条件の変化・約束・最新の発言", block.includes("条件の変化") && block.includes("一人になる") && block.includes("約束"), block);
}
{
  // 前回の送付の後に何も無い（本当の新着）
  const plain = [
    { sender: "staff", text: "〇〇さん\n西区から1Kのお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！" },
    { sender: "customer", text: "ありがとうございます！" },
  ];
  const now = readSendNow(plain);
  t("お礼だけ → 依頼なし・変化なし", !now.requested && now.conditionChange.length === 0);
  t("本当の新着は新着のまま", effectiveSendFrame("new_arrival", now) === "new_arrival");
  t("送り方が新着でなければ触らない", effectiveSendFrame("normal", readSendNow(AKARI)) === "as_is" && effectiveSendFrame("widen", readSendNow(AKARI)) === "as_is");
}
{
  t("会話が空ならブロックも空", buildSendNowBlock(readSendNow([])) === "");
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
