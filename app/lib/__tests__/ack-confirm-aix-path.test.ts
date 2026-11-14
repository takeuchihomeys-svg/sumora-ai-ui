// app/lib/__tests__/ack-confirm-aix-path.test.ts — 確認・見積の約束への了承だけの番で、了承の材料に「道は約束を果たす AIX のまま」の1行を足す（ACK_CONFIRM_AIX_PATH・既定 off）
//   2026-11-14 作業員D（q091・BRAIN_MSG_WINDOW_UNITS の悪化の掘り）。実物: 試験 q091 の最後の2通（こちらの約束・お客様の了承）をそのまま使う
//   実行: npx tsx app/lib/__tests__/ack-confirm-aix-path.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ackFormFacts, ackFormMaterialLine, ackConfirmAixPathLine, ackConfirmAixPathOn } from "../repeat-brain-align";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const ON = { ACK_CONFIRM_AIX_PATH: "on" }, OFF = {};

// q091 の実物（スタッフの約束 → お客様の了承だけ）
const q091 = [
  { sender: "customer", text: "https://suumo.jp/chintai/bc_100372733288/", created_at: "2026-10-03T06:58:00Z" },
  { sender: "staff", text: "かしこまりました！！\nお送り頂きました2件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！", created_at: "2026-10-03T06:59:00Z" },
  { sender: "customer", text: "ありがとうございます🙇🏻‍♂️\nよろしくお願い致します🙏", created_at: "2026-10-03T06:59:54Z" },
];
const f = ackFormFacts(q091);
t("q091: 確認の約束への了承だけと読む", f?.family === "確認・連絡・見積・審査" && f.customer === "了承だけ");
t("q091: 最後の文は contact だけでも、通の全部から募集状況（vacancy）を拾う", !!f?.topics?.includes("vacancy") && f.topics.includes("contact"));
t("既定 off", !ackConfirmAixPathOn({}) && ackConfirmAixPathOn(ON) && ackConfirmAixPathLine(f, OFF) === "");
const line = ackConfirmAixPathLine(f, ON);
t("on: q091 は道の行が付く（物件確認した）", /property_check_result/.test(line) && /返信で締めず/.test(line) && /ack_form は形/.test(line));
t("on: 何を添えるか（御見積書等）は狭めない（11/14 試験 q094 で御見積書が抜けた）", /入口は/.test(line) && /狭めない/.test(line));
// 既定 off の時の材料は今までと1文字も変わらない（ACK_FORM_BRAIN は既定 on）
const base = ackFormMaterialLine(f, OFF), withOn = ackFormMaterialLine(f, ON);
t("off: 材料は今までどおり（道の行なし）", !!base && !/返信で締めず/.test(base) && !/property_check_result/.test(base));
t("on: 材料の後ろに道の行が1行増えるだけ", withOn === `${base}\n${line}`);

// 見積の約束 → 見積書送る
const est = ackFormFacts([
  { sender: "staff", text: "かしこまりました！！\n御見積書を作成しお送りさせて頂きます！！", created_at: "2026-10-03T06:59:00Z" },
  { sender: "customer", text: "ありがとうございます！よろしくお願いします", created_at: "2026-10-03T07:00:00Z" },
]);
t("見積の約束への了承: 見積書送る", !!est && /estimate_sheet/.test(ackConfirmAixPathLine(est, ON)));

// 当てない番
const pick = ackFormFacts([
  { sender: "staff", text: "かしこまりました！！\nご条件に合ったお部屋をピックアップしてお送りさせて頂きます😌！！", created_at: "2026-10-03T06:59:00Z" },
  { sender: "customer", text: "ありがとうございます！", created_at: "2026-10-03T07:00:00Z" },
]);
t("探す（ピックアップ）の約束には付けない（決定 C: ピックアップの後は返信で締める）", ackConfirmAixPathLine(pick, ON) === "");
const asked = ackFormFacts([
  { sender: "staff", text: "お送り頂きました2件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！", created_at: "2026-10-03T06:59:00Z" },
  { sender: "customer", text: "ありがとうございます！ちなみに初期費用はどれくらいですか？", created_at: "2026-10-03T07:00:00Z" },
]);
t("お客様が質問を足した番には付けない", ackConfirmAixPathLine(asked, ON) === "");
t("材料が無い番は空", ackConfirmAixPathLine(null, ON) === "");
// 試験の同じ場面の実物（正解は約束を果たす AIX）
const pair = (staff: string, cust: string) => ackFormFacts([{ sender: "staff", text: staff, created_at: "2026-10-03T06:59:00Z" }, { sender: "customer", text: cust, created_at: "2026-10-03T07:00:00Z" }]);
t("q103（募集状況＋見積を約束・お礼）→ 物件確認した", /property_check_result/.test(ackConfirmAixPathLine(pair("かしこまりました😊！！\nお部屋お送りいただきありがとうございます！！こちらの募集状況も確認させていただきます！！確認出来次第、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！", "ありがとうございます！\nよろしくお願いいたします(お願いします)"), ON)));
t("q178（管理会社に確認・明日10時から）→ 物件確認した", /property_check_result/.test(ackConfirmAixPathLine(pair("お送り頂きましたプラネットハイツのバルコニーの写真を確認させて頂いたのですが、バルコニー部分狭く、選択置き場が無い可能性御座います！！\n物件の管理会社明日10:00〜営業時間ですので、確認出来次第ご連絡させて頂きます😊！！", "よろしくお願いします🙇‍♀️"), ON)));
// q176（「お手隙おかけしますが、よろしく…」）は了承だけと読まない＝了承の材料自体が出ない（食い違いが起きない）ので対象外
// 守り: q390（正解 返信|ヒアリング）＝「お送り頂き次第〜お送りさせて頂きます」はお客様の動きを待つ条件つきの約束＝果たす番ではない
const q390 = pair("YUMAさんお世話になっております！！\n\nはい😊！！\n最大限初期費用割引させて頂きます！！\n気になるお部屋がございましたらいつでもお送りください！！\nお送り頂き次第、募集状況確認と最大限割引した初期費用の御見積書をあわせてお送りさせて頂きます😌！！\n何卒よろしくお願い致します！！", "ありがとうございます🙇");
t("守り q390: 条件つきの約束（お送り頂き次第）には付けない", q390?.conditional === true && ackConfirmAixPathLine(q390, ON) === "");

// 2026-11-15 守り q111（夜の試験 g3 で悪化 3/3→0/2・竹内さんの正解は「はい😊！！何卒よろしくお願い致します！！」の返信）
//   日にちの決まった先の報告（9月30日時点の募集状況）＋約束の後に締め＝了承は締めへの挨拶 → 付けない
const q111 = pair("はい😊！！\n9月30日に一度9月30日時点での募集状況をご連絡させて頂きます！！\nその間もお部屋抑えられる場合や気になる点出てきましたらお気軽にご連絡ください！！\n引き続き何卒よろしくお願い致します！！", "お願いします🙏");
t("守り q111: 先の日にちの報告と読む", q111?.scheduledLater === true && q111.pendingNow === false);
t("守り q111: 約束の後に締めがあると読む", q111?.closesAfter === true);
t("守り q111: 道の行を付けない", ackConfirmAixPathLine(q111, ON) === "");
// 並べ: q091・q178 は「確認出来次第」で通が約束で終わる＝付ける
t("q091 は 先の日にちでない・締めで終わらない", f?.pendingNow === true && !f.scheduledLater && !f.closesAfter);
const q178 = pair("お送り頂きましたプラネットハイツのバルコニーの写真を確認させて頂いたのですが、バルコニー部分狭く、選択置き場が無い可能性御座います！！\n物件の管理会社明日10:00〜営業時間ですので、確認出来次第ご連絡させて頂きます😊！！", "よろしくお願いします🙇‍♀️");
t("q178（明日の営業時間に確認・次第）は付ける＝「明日」は先の日にちの報告に数えない", q178?.pendingNow === true && !q178.scheduledLater && /property_check_result/.test(ackConfirmAixPathLine(q178, ON)));
// 締めだけ足した形（確認出来次第＋お気軽に）は付けない
t("確認出来次第の後に「お気軽にご連絡ください」の締め → 付けない", ackConfirmAixPathLine(pair("お送り頂きましたお部屋の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！\n気になる点ございましたらお気軽にご連絡ください！！", "ありがとうございます！"), ON) === "");
// 守り q152（正解 AIX【申込へ】）: 確認の結果は同じ通で伝え済み・「お気に召されましたらお申込みし…」は条件つき → 付けない
t("守り q152: 「お気に召されましたら」の約束には付けない", ackConfirmAixPathLine(pair("YUMAさん\nお世話になっております！！\n\nファーストフィオーレ難波ウエストの募集状況確認させていただき、現在1番手でお申込みが入っており2番手お申込みが可能なお部屋となります！！\n\n1番手の方審査否決・キャンセルで繰り上がり審査開始となりますがお部屋のお申込み自体は可能となりますのでお気に召されましたらお部屋お申込みし同時並行でお部屋探し継続させていただきます😊！！", "かしこまりました！\nその方向でお願い致します"), ON) === "");
// 配線: brain-core は ackFormMaterialLine を通して材料を入れている（道の行もそこから入る）
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: brain-core の了承の材料は ackFormMaterialLine(ackFormFacts(...))", bc.includes("ackFormMaterialLine(ackFormFacts("));

console.log(`ack-confirm-aix-path: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
