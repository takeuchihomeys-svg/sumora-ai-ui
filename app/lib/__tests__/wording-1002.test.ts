// app/lib/__tests__/wording-1002.test.ts
// 2026-10-02 竹内さんが YUMA の LINE で見つけた文（⑤一括確認・⑥お客様／それより前に・②入金で押さえる・⑧絵文字）の回帰テスト。
//   直す文は YUMA に届いた実物、変えない文は本番のスタッフの実送信（scripts/audit-okyaku-address.ts・audit-wording-exits-1002.ts で目で読んだ物）。
// 実行: npx tsx app/lib/__tests__/wording-1002.test.ts
import { fixSecondPersonOkyaku } from "../okyaku-address";
import { fixBulkCheckWording } from "../bulk-check-wording";
import { fixPaymentTimingWording } from "../payment-timing-wording";
import { applySituationalEmoji, emojiSituationOf, emojiSceneOf, EMOJI_SCENE_RATES, type EmojiScene } from "../emoji-situational";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── ⑥ 相手を「お客様」と呼ばない");
{
  const yuma = "はい😊！！\n初期費用はクレジットカード払いであれば分割可能です！！\nカード払いの際は合計金額に3.24%の手数料がかかりますが、分割回数はお客様のカード会社側で設定いただけます😌！！";
  const a = fixSecondPersonOkyaku(yuma, "YUMA");
  t("YUMA の実物: お客様のカード会社 → YUMAさんのカード会社", a.text.includes("YUMAさんのカード会社側で設定") && !a.text.includes("お客様"), a.text);
  const b = fixSecondPersonOkyaku(yuma, null);
  t("名前が無い時: ご自身のカード会社", b.text.includes("ご自身のカード会社側で設定"), b.text);
  const c = fixSecondPersonOkyaku("敷金礼金なし・家賃管理費込60,000円、お客様にかなりオススメ出来るお部屋となります！！", "");
  t("AIX の実物（名前なし）: 呼ばずに書く", c.text === "敷金礼金なし・家賃管理費込60,000円、かなりオススメ出来るお部屋となります！！", c.text);
  t("〇〇さん付きの名前を重ねない", fixSecondPersonOkyaku("お客様ご希望の南向き・2階以上の条件をクリアしております！！", "あやさん").text.startsWith("あやさんご希望の南向き"));
  for (const keep of [
    "現在1番手で別のお客様がお申込をされている状態となります！！",
    "1番手のお客様が審査否決またはキャンセルされた場合に",
    "他のお客様に取られてしまわないよう、こちらからも最優先で管理会社に確認させて頂きます",
    "多くのお客様がこの形で進められております！！",
    "ご紹介頂きましたお客様ご紹介料お支払いさせて頂きます！！",
    "スモ割はスモラのお客様限定の割引サービスとなっております",
    "弊社ではオーナーから頂く報酬をスモ割としましてお客様の初期費用に還元させて頂いております😊！！",
    "上記フォーマットご入力いただき、お客様名とご本人確認書類として運転免許証",
    "（お客様ご希望のお部屋探しご条件）",
    "契約名義人（お仕事のお客様）宛にのみ届く形となります",
  ]) t(`変えない: ${keep.slice(0, 26)}`, fixSecondPersonOkyaku(keep, "Aさん").changes.length === 0, fixSecondPersonOkyaku(keep, "Aさん").text);
}

console.log("── ⑥ 支払いの時期の言い切り・② 入金で押さえる");
{
  const y1 = "はい😊！！\n初期費用のお支払いは審査通過後に管理会社から請求書が届き次第、ご入居日の5日〜1週間前頃のお振込となります！！\nそれより前にお支払い頂くことはありませんのでご安心ください😌";
  const r1 = fixPaymentTimingWording(y1);
  t("YUMA の実物: 言い切りの行を落とす", !/それより前/.test(r1.text) && r1.text.endsWith("お振込となります！！"), r1.text);
  const y2 = "目安としてはご入居日の5日〜1週間前までのお振込となりますので、それより前にお支払い頂くことはございません！！";
  const r2 = fixPaymentTimingWording(y2);
  t("「…となりますので、それより前に…ございません！！」→「…となります！！」", r2.text === "目安としてはご入居日の5日〜1週間前までのお振込となります！！", r2.text);
  const y3 = "かしこまりました！！\nプレジオ十三の初期費用も最大限割引させていただいておりますので、費用面もかなり抑えられるお部屋となります！！\nまずは審査を進めて、ご希望に合えば今月のご入金でお部屋を押さえさせていただきます！！";
  const r3 = fixPaymentTimingWording(y3);
  t("YUMA の実物: 入金で押さえる文を落とす", !/ご入金でお部屋/.test(r3.text) && r3.text.includes("費用面もかなり抑えられるお部屋となります！！"), r3.text);
  t("スタッフの答えは変えない", fixPaymentTimingWording("初期費用のお支払いはご入居日から5日から１週間ほど前の日にちでお支払いとなります！！").changes.length === 0);
  t("お申込みで押さえる文は変えない", fixPaymentTimingWording("お気に召されましたらお申込しお部屋抑えさせて頂きます😌！！").changes.length === 0);
  t("初期費用を抑える文は変えない", fixPaymentTimingWording("初期費用も最大限割引させて頂きお引越しにかかる費用を出来る限り抑えさせて頂きます！！").changes.length === 0);
}

console.log("── ⑤ 一括確認／空きがございましたら");
{
  const y = "お送り頂きました7件の物件の募集状況を、本日管理会社の営業開始後に一括確認させて頂きます！！\n空きがございましたら、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！";
  const r = fixBulkCheckWording(y);
  t("一括 → 全て", r.text.includes("営業開始後に全て確認させて頂きます！！"), r.text);
  t("空きがございましたら → 募集されているお部屋の", r.text.includes("\n募集されているお部屋の最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！"), r.text);
  t("スタッフの実送信は変えない", fixBulkCheckWording("かしこまりました！！\nお送り頂きました7件全ての募集状況確認させて頂きます😊！！\n確認出来次第、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！").changes.length === 0);
  t("空きの後ろが見積書でない時は変えない", fixBulkCheckWording("空きがございましたらご連絡させて頂きます！！").changes.length === 0);
}

console.log("── ⑧ 絵文字の場面（2026-10-02 竹内「スタッフのを基に構成する」＝場面ごとにスタッフの割合で外す）");
{
  const sc: Array<[string, EmojiScene, { firstContact?: boolean; afterStaffSend?: boolean }?]> = [
    ["YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！", "first_greeting"],
    ["大変申し訳ございません😌！！\n確認が遅くなりました！！", "apology"],
    ["〇〇につきまして、募集終了となっておりました😊！！私の方でご条件に近いお部屋をピックアップさせて頂きます！！", "ended"],
    ["こちらのお部屋はペット飼育が難しいお部屋となります😌！！他のお部屋もお探しさせて頂きます！！", "decline"],
    ["かしこまりました😊！！", "short"],
    ["こちらのお部屋、ご内覧のお日にちご都合いかがでしょうか😊！！", "question"],
    ["お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！", "confirm_decl"],
    ["初期費用は最大限割引させて頂き、合計で18万円ほどとなります😊！！", "money"],
    ["はい😊！！お仕事の内容でも審査は通るお部屋となります！！", "contract"],
    ["本日の夕方以降でしたらお電話可能です😊！！ご都合の良いお時間お伝え頂けますと幸いです！！", "phone"],
    ["続けてお送りさせて頂きます😊！！こちらもオススメのお部屋となります！！", "second_message", { afterStaffSend: true }],
  ];
  for (const [text, want, o] of sc) t(`場面: ${want}`, emojiSceneOf(text, o ?? {}) === want, emojiSceneOf(text, o ?? {}));
  t("初回の挨拶はスタッフの 1%＝外さない", applySituationalEmoji(sc[0][0], { seed: "x" }).removed === 0);
  t("🌟（物件の見出し）は残す", applySituationalEmoji("🌟エスリード長居 503\n申し訳ございません😊", { seed: "a" }).text.startsWith("🌟エスリード長居 503"));
  t("同じ下書き・同じ会話なら毎回同じ（乱数でない）", emojiSituationOf(sc[6][0], { seed: "c1" }).drop === emojiSituationOf(sc[6][0], { seed: "c1" }).drop);
  // 場面ごとの外す割合が (スタッフ − AI が元から)／(1 − AI が元から) に一致する（2,000会話）
  for (const [text, want, o] of sc.slice(1)) {
    const r = EMOJI_SCENE_RATES[want];
    const p = Math.max(0, (r.rate - r.aiRate) / (1 - r.aiRate));
    let d = 0;
    for (let i = 0; i < 2000; i++) if (emojiSituationOf(text, { ...(o ?? {}), seed: `conv-${i}` }).drop) d++;
    t(`${r.ja}: 外す ${(d / 20).toFixed(1)}%（目標 ${(p * 100).toFixed(1)}%＝スタッフ ${Math.round(r.rate * 100)}%・AI 元から ${Math.round(r.aiRate * 100)}%）`, Math.abs(d / 2000 - p) < 0.035);
  }
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
