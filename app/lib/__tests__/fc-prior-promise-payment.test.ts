// 最終チェックの直し 2・3（2026-11-13 作業員9・FC_CONFIRM_PRIOR_PROMISE・FC_PAYMENT_FACT_UNASKED・実物の文）
// 実行: npx tsx app/lib/__tests__/fc-prior-promise-payment.test.ts
import { priorStaffConfirmObject, isAckOnlyCustomer, confirmPriorPromiseOn } from "../confirm-prior-promise";
import { findCompanyFactContradiction, paymentFactUnaskedOn } from "../company-fact-guard";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };

// ── 2: 8f67f33b（11/08・名前は伏せた）
const recent8f = [
  { sender: "customer", text: "早々に情報頂きました\nありがとうございます。\n頂い件.確認させて頂きます。\nちなみに\nプレサンス立売堀アーバンスタイルも\n物件空き情報頂きたいのと\n管理費込み10万以下も\n情報頂けないでしょうか。" },
  { sender: "customer", text: "桜川•新町•西長堀等でも\n情報頂けたら有難いです。" },
  { sender: "staff", text: "かしこまりました！！\nプレサンス立売堀アーバンスタイルの募集状況確認させて頂きます！！" },
  { sender: "staff", text: "あわせて桜川・新町・西長堀周辺全域から管理費込み10万以下〇〇さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😊！！" },
  { sender: "customer", text: "ご協力ありがとうございます" },
];
t("既定 off", !confirmPriorPromiseOn({}) && !paymentFactUnaskedOn({}));
t("8f67f33b: 前の通の対象つきの確認の約束を返す", priorStaffConfirmObject(recent8f, "ご協力ありがとうございます") === "プレサンス立売堀アーバンスタイルの募集状況", priorStaffConfirmObject(recent8f, "ご協力ありがとうございます"));
t("問いがある番は返さない", priorStaffConfirmObject(recent8f, "ありがとうございます、いつ頃分かりますか？") === null);
t("AIX の通の約束は数えない", priorStaffConfirmObject([recent8f[0], { sender: "staff", text: "〇〇の募集状況確認させて頂きます！！", isAix: true }, { sender: "customer", text: "ありがとうございます" }], "ありがとうございます") === null);
t("前のお客様の発言より前の約束は数えない", priorStaffConfirmObject([{ sender: "staff", text: "〇〇の募集状況確認させて頂きます！！" }, { sender: "customer", text: "お願いします" }, { sender: "staff", text: "かしこまりました！！" }, { sender: "customer", text: "ありがとうございます" }], "ありがとうございます") === null);
// a1d43938（10/19）: お礼だけでも前に対象つきの約束が無い＝残る
t("a1d43938: 前に約束が無ければ残る", priorStaffConfirmObject([{ sender: "staff", text: "〇〇さんお気に召されましたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます！！" }, { sender: "customer", text: "遅くにすみません。よろしくお願いします！" }], "遅くにすみません。よろしくお願いします！") === null);
t("お礼・了承だけの見分け", isAckOnlyCustomer("ご協力ありがとうございます") && !isAckOnlyCustomer("4年間で更新なしってことですか？") && !isAckOnlyCustomer(""));

// ── 3: 61845054・2f3256e2（11/10）: 元の下書き「カード決済可能か管理会社に確認」→ 書き直し「お振込での一括のみ」・お客様は内覧の話
const revised = "〇〇さんお世話になっております！！\n全然大丈夫です😊\n初期費用のお支払い方法はお振込での一括のみでの対応となります！！\n内覧につきましては、日程のご案内をお送りさせて頂きます！！";
const original = "プレジオ阿波座1308号室の初期費用、カード決済可能か管理会社に確認させて頂きます！！\n本日営業時間外の為、明日確認出来次第ご連絡させて頂きます！！";
const cust = ["後内とかもしたいです"];
const sent = "〇〇さん\nお世話になっております！！\n全然大丈夫です😊\n\n弊社事務所にご来社いただく必要がございますが初期費用のお支払い方法カードでの決済も可能です！！\nカード取扱手数料として支払額の3.24%が決済手数料として追加で発生いたします！！";
delete process.env.FC_PAYMENT_FACT_UNASKED; delete process.env.COMPANY_FACT_PAYMENT_LUMP;
t("off: 聞かれていない番の「一括のみ」は今まで通り素通り", findCompanyFactContradiction(revised, cust) === null);
process.env.FC_PAYMENT_FACT_UNASKED = "on";
const hit = findCompanyFactContradiction(revised, cust);
t("on: 書き直しの「お振込での一括のみ」を止める", hit?.factId === "credit_card" && /一括のみ/.test(hit.sentence), hit);
t("on: 元の下書き（管理会社に確認）は止めない", findCompanyFactContradiction(original, cust) === null);
t("on: スタッフの送信（カード可・3.24%）は止めない", findCompanyFactContradiction(sent, cust) === null);
// 9/15・9/27 の下書き（入居に要る費用の話・支払い方法ではない）は外す
t("on: 「家賃・管理費のお振込みのみでのご入居は出来ず」は止めない", findCompanyFactContradiction("家賃・管理費のお振込みのみでのご入居は出来ず、こちらは初期費用39,300円となります！！", ["上の物件気になってます！"]) === null);
process.env.COMPANY_FACT_PAYMENT_LUMP = "on";
t("竹内さんの答えが「一括のみ」になったら向きが変わる（一括のみは止めない）", findCompanyFactContradiction(revised, cust) === null);
delete process.env.COMPANY_FACT_PAYMENT_LUMP; delete process.env.FC_PAYMENT_FACT_UNASKED;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
