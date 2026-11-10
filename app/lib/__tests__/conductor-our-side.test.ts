// app/lib/__tests__/conductor-our-side.test.ts — 入口の統括に渡す「こちら側の状態」（純関数）
// 実行: npx tsx app/lib/__tests__/conductor-our-side.test.ts
import { ourSideBlock, promiseKindOf, conductorOurSideOn, ourSideBrainOn } from "../conductor-our-side";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} → ${JSON.stringify(info)}`); } };
const now = Date.parse("2026-11-03T10:36:00Z");

t("既定 off・on で動く", !conductorOurSideOn({}) && conductorOurSideOn({ CONDUCTOR_OUR_SIDE: "on" }));
t("ブレインの側も既定 off・別のスイッチ", !ourSideBrainOn({}) && !ourSideBrainOn({ CONDUCTOR_OUR_SIDE: "on" }) && ourSideBrainOn({ CONDUCTOR_OUR_SIDE_BRAIN: "on" }));
t("約束の種類", promiseKindOf("お送り頂きました新大阪グランドハイツの募集状況確認させて頂きます") === "確認" && promiseKindOf("最大限割引させて頂いた御見積書を作成しお送りさせて頂きます") === "見積"
  && promiseKindOf("浪速区周辺全域からピックアップしてお送りさせて頂きます") === "探す" && promiseKindOf("内覧の候補日お送りさせて頂きます") === "内覧");

// q371 の元の番（13分前の確認の約束・新しい1件）: 約束は開いている・結果はまだ
{
  const b = ourSideBlock({ nowMs: now, msgs: [
    { sender: "staff", text: "お送り頂きました新大阪グランドハイツと新大阪ステーションビルの募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😌！！", created_at: "2026-11-03T10:22:00Z" },
    { sender: "customer", text: "ART TENDOU WEST 1階", created_at: "2026-11-03T10:35:50Z" },
  ], aix: [
    { aix_type: "property_check_result", check_pattern: "unavailable", created_at: "2026-11-02T09:00:00Z", property_names: ["A", "B", "C"] },
    { aix_type: "property_send", created_at: "2026-11-03T09:06:00Z" },
  ] });
  t("q371: 確認の約束が開いている（14分前）", /開いている約束: 確認の約束「お送り頂きました新大阪グランドハイツと新大阪ステーションビルの募集状況確認させて頂きます！」（14分前/.test(b), b);
  t("q371: 直前の AIX は物件送付（束）・送った物件の回数", /直前の AIX: 物件送付（束）/.test(b) && /束 1回・1件のオススメ 0回/.test(b), b);
}
// 9758 型: 物件確認した（募集中・見積書同封）の後の「初期費用は」→ 約束は果たし済み・直前の AIX が見積書同封
{
  const b = ourSideBlock({ nowMs: Date.parse("2026-11-01T07:03:00Z"), msgs: [
    { sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！", created_at: "2026-10-31T10:00:00Z" },
    { sender: "staff", text: "こちら2件現在募集中となります！！", created_at: "2026-11-01T02:44:00Z", is_aix_generated: true },
  ], aix: [{ aix_type: "property_check_result", check_pattern: "available", created_at: "2026-11-01T02:44:00Z", property_names: ["アーバネックス四ツ橋 1308", "アーバネックス四ツ橋 203", "X"], estimate_sent: true }] });
  t("9758: 約束は AIX で果たした＝なし", /開いている約束: なし/.test(b), b);
  t("9758: 直前の AIX の意味・ピッカー・物件名2件・見積書", /物件確認した（物件そのもの＝空き・募集）＝募集中（アーバネックス四ツ橋 1308・アーバネックス四ツ橋 203）・御見積書を同封（4時間前）/.test(b), b);
}
// 11932 型: 確認した（管理会社の設備）の意味・mgmt_ のピッカー
{
  const b = ourSideBlock({ nowMs: now, msgs: [], aix: [{ aix_type: "acknowledge_check", check_pattern: "mgmt_equipment", created_at: "2026-11-03T08:00:00Z" }] });
  t("確認した＝設備・mgmt_ は管理会社に確認した", /確認した（設備・条件＝管理会社に確認）＝管理会社に確認した（equipment）/.test(b), b);
}
// 今より後の通・AIX は見ない（答えの漏れ）
{
  const b = ourSideBlock({ nowMs: now, msgs: [{ sender: "staff", text: "確認させて頂きます", created_at: "2026-11-03T11:00:00Z" }], aix: [{ aix_type: "estimate_sheet", created_at: "2026-11-03T11:30:00Z" }] });
  t("今より後は見ない", /開いている約束: なし/.test(b) && /直前の AIX: なし/.test(b) && /まだ無い/.test(b), b);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
