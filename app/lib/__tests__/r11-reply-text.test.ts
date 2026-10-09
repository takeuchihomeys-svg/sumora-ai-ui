// app/lib/__tests__/r11-reply-text.test.ts — 11巡目（10/08）の返信の文の部品（実行: npx tsx app/lib/__tests__/r11-reply-text.test.ts）
//   文は本番の実物（名前は伏せた）
import { sceneStyleNote, repeatCandidates, noRepeatNote, noNewArrivalNote } from "../reply-style-r11";
import { fixTakeuchiWording } from "../takeuchi-wording-r11";
import { readSituations, buildSituationNote } from "../customer-situation-r11";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

console.log("■ 質問の書き出しの注記");
t("質問の番だけ出る", sceneStyleNote("question").includes("答えそのものから") && sceneStyleNote("ack") === "" && sceneStyleNote("question", false) === "");

console.log("■ 繰り返さない（直前2通）");
{
  const prev = ["かしこまりました！！\n松屋町周辺全域から12万円程・綺麗めのお部屋でYUMAさんにオススメできるお部屋ピックアップしお送りさせて頂きます！！\nYUMAさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！",
    "🌟特にYUMAさんにオススメ物件\nhttps://suumo.jp/chintai/bc_100/\nお手隙の際にご査収ください😌！！"];
  const c = repeatCandidates(prev);
  t("約束・条件の文を取り出す（🌟・URL は除く）", c.some((x) => x.includes("周辺全域から")) && !c.some((x) => /🌟|https/.test(x)), c);
  const n = noRepeatNote(prev, "ack", true);
  t("受けだけの番は2〜3行の注記", n.includes("2〜3行") && n.includes("お伝え済み"));
  t("候補が無ければ出ない", noRepeatNote(["[画像]"], "ack", true) === "");
  t("off で出ない", noRepeatNote(prev, "ack", false) === "");
}
console.log("■ 在庫の状態");
t("物件0件の時だけ「新着で出次第」を止める", noNewArrivalNote(0, {}).includes("新着で") && noNewArrivalNote(3, {}) === "" && noNewArrivalNote(0, { REPLY_NO_NEWARRIVAL_R11: "off" }) === "");

console.log("■ 約束の文末の「ね」（本番の下書きの実物）");
{
  const a = fixTakeuchiWording("かしこまりました！！\nご都合よろしいお日にちお伝えさせて頂きますね😊！！", true);
  t("させて頂きますね😊 → させて頂きます😊", a.text.includes("お伝えさせて頂きます😊！！") && a.changes.length === 1, a);
  const b = fixTakeuchiWording("モラーダの礼金につきましては、月曜日に管理会社へ確認させて頂きますね😊！！", true);
  t("確認させて頂きますね → 確認させて頂きます", b.text.endsWith("確認させて頂きます😊！！"));
  t("竹内さんの「少なくなりますね😊」は変えない", fixTakeuchiWording("金額的にドイマンションの方がご負担少なくなりますね😊！！", true).changes.length === 0);
  t("竹内さんの「それは大変でしたね😌」は変えない", fixTakeuchiWording("それは大変でしたね😌💦", true).changes.length === 0);
  t("「」の中は変えない", fixTakeuchiWording("「確認させて頂きますね」とのことです", true).changes.length === 0);
  t("off", fixTakeuchiWording("確認させて頂きますね！！", false).changes.length === 0);
}
console.log("■ お客様の事情（180日の実物）");
t("審査の不安", readSituations("ここ審査厳しくないですか？？🤔").includes("credit"));
t("名義を貸す", readSituations("仕事のお客様に名義貸してもらおうと思ってるんですけど").includes("credit"));
t("条件のフォームは読まない", readSituations("▶︎【お部屋お探し中！】\n（ご希望のお部屋探しご条件）\n⑧【その他ご要望あれば】⇒ブラックでも可").length === 0);
t("お金の用意", readSituations("初期費用の用意ができるのが10月の10日になる為").includes("money"));
t("同居人と相談", readSituations("ありがとうございます！\n同居人と相談してまた連絡いたします！").includes("partner_hold"));
t("入院（人生の出来事）", readSituations("昨日親が急に体調崩し入院しました。").includes("life"));
t("転職したては人生の出来事にしない", !readSituations("転職したてで1ヶ月分しかないんです").includes("life"));
t("業者・代理", readSituations("自分のお客様が住む家なので また見つかり次第連絡ください！").includes("agent"));
t("注記の形", buildSituationNote("一度妻と話してみます！", true).includes("物件・見積を約束しない"));
t("何も無ければ空", buildSituationNote("ありがとうございます！", true) === "");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
