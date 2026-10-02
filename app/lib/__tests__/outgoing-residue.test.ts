// app/lib/__tests__/outgoing-residue.test.ts
// 2026-10-02 竹内「監視が防げる部分」「テスト送信入っている。紛れないように」の回帰テスト（送る直前の最後の網）。
//   止める文は YUMA に届いた実物・手本に入っていた実物。通す文は本番のスタッフの送信の実物（記号・引用・顔文字・円記号）。
// 実行: npx tsx app/lib/__tests__/outgoing-residue.test.ts
import { detectOutgoingResidue, hasOutgoingResidue, describeOutgoingResidue } from "../outgoing-residue";
import { isUsableExampleText } from "../example-hygiene";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── 止める（実物）");
const stop: Array<[string, string]> = [
  ["YUMA 10/02 6:58 AIX【内覧調整】の JSON の名残", "10/3(土) 11:00〜13:00\n10/4(日) 14:00〜16:00にてご案内可能です😊！！\",\"closing\":\"YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！\"}"],
  ["YUMA 10/02 テストの印", "【テスト送信・絵文字の重なりの点検】\nYUMAさん、お部屋お送り頂きありがとうございます😊！！\nこちらのお部屋の募集状況確認させて頂きます！！"],
  ["テストの印（書式の点検）", "【テスト送信】YUMAさん（書式の点検・お客様には送っていません）\n\n🌟エスリード長居 503"],
  ["⭐手本に入っていた JSON（8/28）", "{\"greeting\":\"はい！！\",\"situation\":\"\",\"invite\":\"来週でしたらお部屋ご案内させて頂きます😊！！\",\"dates\":\"直近ですと\\n7/16（木）11:00〜13:00\"}"],
  ["AIX の下書きの末尾の \"}（スタッフが直して送った）", "お気に召されたお部屋駐車場の空き状況も確認させて頂きます！！\nお手隙の際にご査収ください😌！！\"}"],
  ["エスケープの名残 \\n", "はい😊！！\\n確認させて頂きます！！"],
  ["中身の無い値", "undefined様\nお部屋ご案内させて頂きます！！"],
  ["コードの囲い", "```\nはい😊！！\n```"],
];
for (const [name, text] of stop) t(name, hasOutgoingResidue(text), JSON.stringify(detectOutgoingResidue(text)));

console.log("── 通す（本番のスタッフの送信の形）");
const pass_: Array<[string, string]> = [
  ["引用の「」", "「お部屋お探し中！」のフォーマットにご記入ください😊！！"],
  ["顔文字・記号", "Naaao88❥❥(⃔ *`꒳´ * )⃕↝さん\nご質問ありがとうございます😊"],
  ["表示名の記号", "⟡.·さん、ありがとうございます😊"],
  ["円の金額・全角の￥", "家賃管理費込68,000円・￥11,000（税込）\nお手隙の際にご査収ください😌！！"],
  ["URL（? と = と &）", "https://suumo.jp/chintai/jnc_000000000000/?bc=100000000000&ar=060"],
  ["二重引用符で囲んだ物件名（鍵が無い）", "\"エスリード長居\" 503号室の募集状況確認させて頂きます！！"],
  ["波括弧（笑）", "{笑}ありがとうございます！！"],
  ["テストの語（本文の中の普通の語）", "審査のテストではなく本審査となります！！"],
  ["スタッフの電話の文", "19時までですと何時でもお電話可能です😊！！"],
];
for (const [name, text] of pass_) t(name, !hasOutgoingResidue(text), JSON.stringify(detectOutgoingResidue(text)));

console.log("── 理由の文・手本");
t("理由は日本語の1行", /機械の名残/.test(describeOutgoingResidue(detectOutgoingResidue(stop[0][1]))));
t("JSON の文は手本にしない（example-hygiene）", !isUsableExampleText(stop[3][1]));
t("テストの印の文は手本にしない", !isUsableExampleText(stop[1][1]));
t("普通の文は手本にしてよい", isUsableExampleText("かしこまりました！！\nお部屋お申込みさせていただきます😊！！"));

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
