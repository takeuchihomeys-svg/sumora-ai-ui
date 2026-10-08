// app/lib/__tests__/aix-catalog.test.ts — 10巡目（10/08）AIX の全ボタン×全ピッカーの一覧（実行: npx tsx app/lib/__tests__/aix-catalog.test.ts）
import { AIX_CATALOG, catalogKeyOfPress, topicKey, catalogBlockForBrain, isConditionCheckPattern, MAIN_PICKER_FIELD } from "../aix-catalog";
import { AIX_PICKERS } from "../aix-pickers";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const keys = new Set(AIX_CATALOG.map((e) => e.key));

// 一覧はコードから作る（画面の選択肢が全部入る）
for (const [t0, field] of Object.entries(MAIN_PICKER_FIELD)) {
  const opts = AIX_PICKERS[t0]?.pickers.find((p) => p.key === field)?.options ?? [];
  const labels = new Set<string>();
  for (const o of opts) { if (labels.has(o.label)) continue; labels.add(o.label); t(`${t0}/${o.value} が一覧にある`, keys.has(`${t0}/${o.value}`)); }
}
t("内覧挨拶の after:search_new が一覧にある（AIX_PICKERS に足した）", keys.has("greeting_viewing/after:search_new"));
t("全力サポートがボタンとして一覧にある", keys.has("zenryoku_support"));
t("物件確認した の 管理会社系は 確認した（条件・交渉）のボタン", AIX_CATALOG.find((e) => e.key === "property_check_result/mgmt_parking")?.button === "確認した（条件・交渉）");
t("物件確認した の 物件あった は 物件確認した（募集状況）のボタン", AIX_CATALOG.find((e) => e.key === "property_check_result/available")?.button === "物件確認した（募集状況）");
t("isConditionCheckPattern: vacate_date / nearby_parking / owner_other は条件側", isConditionCheckPattern("vacate_date") && isConditionCheckPattern("nearby_parking") && isConditionCheckPattern("owner_other") && !isConditionCheckPattern("move_in_date"));
t("確認します は御見積書の後の更に安くで選べる（10/08 竹内さん）", AIX_CATALOG.some((e) => e.aixType === "acknowledge_check" && e.brainSelectable && /更に安く/.test(e.when)));

// 押した AIX → 鍵（記録 → 推定）
t("記録の check_pattern", catalogKeyOfPress({ aix_type: "property_check_result", check_pattern: "unavailable" }).key === "property_check_result/unavailable");
t("記録なし・本文に募集終了 → unavailable（推定）", (() => { const k = catalogKeyOfPress({ aix_type: "property_check_result", text: "こちらのお部屋、確認させて頂きましたところ募集終了しておりました！！" }); return k.key === "property_check_result/unavailable" && k.source === "inferred"; })());
t("記録なし・本文に募集中 → available（推定）", catalogKeyOfPress({ aix_type: "property_check_result", text: "確認しましたところ現在募集中となります😊！！" }).key === "property_check_result/available");
t("物件オススメの古い send_mode new_arrival → 新着1件", catalogKeyOfPress({ aix_type: "property_recommendation", send_mode: "new_arrival" }).key === "property_recommendation/新着1件");
t("物件オススメの pickup_type", catalogKeyOfPress({ aix_type: "property_recommendation", picker_choices: { pickup_type: "継続ピックアップ" } }).key === "property_recommendation/継続ピックアップ");
t("内覧挨拶 app_sub_mode after:search_new", catalogKeyOfPress({ aix_type: "greeting_viewing", app_sub_mode: "after:search_new" }).key === "greeting_viewing/after:search_new");
t("確認します 本文に代表 → daihyo_initial_cost（推定）", catalogKeyOfPress({ aix_type: "acknowledge_check", text: "弊社代表にさらに割引可能か確認させて頂きます！！" }).key === "acknowledge_check/daihyo_initial_cost");
t("記録も本文も無い → ボタンだけ", catalogKeyOfPress({ aix_type: "meeting_place" }).source === "button_only");
// 話題（ブレインと比べる粒度）
t("topicKey: 結果は募集状況に寄せる", topicKey("property_check_result/unavailable") === "property_check_result/募集状況" && topicKey("property_check_result/") === "property_check_result/募集状況");
t("topicKey: 入居日の2つのピッカーは同じ話題", topicKey("property_check_result/move_in_date") === topicKey("property_check_result/mgmt_move_in"));
t("topicKey: 条件は条件:〈値〉", topicKey("property_check_result/mgmt_pet") === "property_check_result/条件:mgmt_pet");

// ブレインに渡す一覧（場面で絞る）
const v = catalogBlockForBrain("viewing");
t("内覧の場面に 内覧日調整・待ち合わせ がある", /viewing_invite【/.test(v) && /meeting_place【/.test(v));
t("内覧の場面に 条件ヒアリング は無い", !/condition_hearing【/.test(v));
t("判断の順番が先頭", v.startsWith("【返信か AIX かの決め方"));
t("確認した（条件・交渉）に 代表／オーナー が出る", /代表に確認した/.test(catalogBlockForBrain("question")) && /オーナーに確認した/.test(catalogBlockForBrain("question")));
t("ブレインが選ばないボタン（電話終了後・物件を探す）は出ない", !/phone_followup【|property_search【/.test(catalogBlockForBrain(null)));
t("全力サポート・内覧挨拶はブレインに出る（10/08 竹内さん）", /zenryoku_support【/.test(catalogBlockForBrain("conditions")) && /greeting_viewing【/.test(catalogBlockForBrain("viewing")));
t("AIX で送る定型（条件ヒアリング・申込フォーマット・内覧挨拶）の決まりが判断の順番にある", /⑤ スタッフだけが知る情報が無くても AIX で送る物/.test(catalogBlockForBrain("other")));
t("結果のピッカー（物件あった等）はまとめて1行・ブレインは空", /結果のピッカー（物件あった／/.test(catalogBlockForBrain("property_share")));
const lens = (["ack", "question", "conditions", "property_share", "viewing", "cost", "apply", "considering", "other"] as const).map((s) => catalogBlockForBrain(s).length);
t(`場面ごとの長さは 5,000字以内（${lens.join("/")}）`, lens.every((n) => n <= 5000));
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
