// app/lib/__tests__/aix-content-gate.test.ts — AIX の中身の言い切り（実行: npx tsx app/lib/__tests__/aix-content-gate.test.ts）
//   当たりは不一致の実物・竹内さんの手打ちの監査（名前は伏せた）。誤検知の実物（ポータルの説明・枠の空き・資料の列挙・会社の事実・一般の日付）も入れる
import { classifyAixContent, firstUngroundedAixContent, CATALOG_KEY_BY_KIND } from "../aix-content-gate";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const key = (d: string, g = "") => classifyAixContent(d, g).filter((h) => !h.grounded).map((h) => h.catalogKey);

// 当たる（AIX の中身）
t("募集終了の言い切り → 物件確認した/物件なかった", key("お送り頂いた物件ですが募集終了しておりました！！").includes("property_check_result/unavailable"));
t("募集中の言い切り → 物件確認した/物件あった", key("こちら2件現在募集中となります！！").includes("property_check_result/available"));
t("#222 フリーレントの月の言い切り → 確認した（初期費用）", key("12月分がフリーレントとなる形となります！！").includes("property_check_result/mgmt_initial_cost"));
t("審査の結果 → 確認した（保証会社）", key("無事保証会社の審査通過致しました！！").includes("property_check_result/mgmt_guarantor"));
t("割引額 → 見積書送る", key("こちらのお部屋30,000円割引させて頂きます！！").includes("estimate_sheet"));
t("電話の約束 → 電話をかける", key("今からお電話させて頂きます😊！！").includes("phone_call"));
t("探した結果（無い）→ 全力サポート", key("ご希望のご条件のお部屋は現在ございません！！").includes("zenryoku_support"));
t("内覧の枠の空き → 内覧日調整", key("12日13:00〜15:00現在空いております😊！！").includes("viewing_invite"));

// 当てない（返信で答えてよい・誤検知の実物）
t("ポータルの一般の説明", key("SUUMOやHOMESに載っているお部屋は、既に募集終了しているものや情報が古いまま掲載されているケースが多く").length === 0);
t("資料の募集条件の列挙", key("・家賃85,000円・管理費8,000円（合計93,000円）").length === 0 && key("- 家賃：100,000円・管理費：10,000円（合計110,000円）").length === 0);
t("会社の事実（スモ割・会社の住所）", key("気になるお部屋の初期費用がスモ割最大適用【2,980円＋前家賃】だけに✨").length === 0 && key("〒541-0048 大阪市中央区瓦町3-4-10").length === 0);
t("一般の日付の説明（1日入居は日割なし）", key("8月1日入居でしたら日割り家賃も発生せずご入居頂けます！！").length === 0);
t("確認の約束は当てない", key("募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！").length === 0);
t("会話にある値の引用は grounded", classifyAixContent("こちらのお部屋30,000円割引させて頂きます！！", "AIX: 🌟30,000円割引させて頂き").every((h) => h.grounded));
t("AIX_CONTENT_GATE=off", firstUngroundedAixContent("募集終了しておりました！！", "", { AIX_CONTENT_GATE: "off" }) === null);
t("全部の型に AIX の鍵", Object.values(CATALOG_KEY_BY_KIND).every((k) => !!k));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
