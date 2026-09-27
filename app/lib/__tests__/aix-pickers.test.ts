// 2026-09-27 竹内「それぞれのピッカーを理解したらもっと意味が分かる」「ピッカー選択した部分の記録はない状態なのか／無ければそこも作っておく」
//   app/lib/aix-pickers.ts: ピッカーの一覧（画面の値・文言）・記録の整え方（sanitizePickerChoices）・場面 → ピッカー（pickerForScene）
// 実行: npx tsx app/lib/__tests__/aix-pickers.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { AIX_PICKERS, AVAILABILITY_RESULT_OPTIONS, checkPatternTopic, pickerForScene, pickerOptionLabel, sanitizePickerChoices } from "../aix-pickers";
import { AIX_BUTTON_LABELS } from "../aix-taxonomy";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("\n■ 一覧（画面の値・文言のまま）");
it("物件確認した の結果は画面の7つ（物件あった／別の部屋が募集してた／物件なかった／専任物件だった／入居日確認した／室内写真を確認した／別の部屋について確認した）", () => {
  eq(AVAILABILITY_RESULT_OPTIONS.map((o) => o.value), ["available", "alternative", "unavailable", "exclusive", "move_in_date", "interior_photo", "other_room_check"]);
  eq(pickerOptionLabel("property_check_result", "check_pattern", "unavailable"), "物件なかった");
});
it("AIX ボタンの名前の一覧にある AIX は全部ここにもある（増えた時に気付く）", () => {
  const missing = Object.keys(AIX_BUTTON_LABELS).filter((k) => k !== "property_search" && k !== "greeting_viewing" && !(k in AIX_PICKERS));
  eq(missing, []);
});

console.log("\n■ 記録を整える（sanitizePickerChoices）");
it("見積書: 1件／複数件・申込誘導・キャンペーンを残し、知らない鍵・空は落とす", () => {
  eq(sanitizePickerChoices("estimate_sheet", { estimate_count: "multi", with_appeal: true, campaign: "", foo: 1, has_property_image: false }),
    { estimate_count: "multi", with_appeal: true, has_property_image: false });
});
it("選択肢に無い値は落とす（画面と記録のずれを残さない）", () => {
  eq(sanitizePickerChoices("viewing_invite", { viewing_mode: "よく分からない", include_calendar: true }), { include_calendar: true });
});
it("物件確認した: 誰に確認したか は条件・交渉の時だけ（物件あった の時は ref の古い値なので落とす）", () => {
  eq(sanitizePickerChoices("property_check_result", { check_who: "mgmt", sent_property_count: 2 }, { checkPattern: "available" }), { sent_property_count: 2 });
  eq(sanitizePickerChoices("property_check_result", { check_who: "mgmt", pet_policy: "可" }, { checkPattern: "mgmt_pet" }), { check_who: "mgmt", pet_policy: "可" });
});
it("子のピッカーは親の選択の時だけ（別の部屋が募集してた の時だけ 同じ／違う間取り）", () => {
  eq(sanitizePickerChoices("property_check_result", { floor_plan: "same" }, { checkPattern: "unavailable" }), null);
  eq(sanitizePickerChoices("property_check_result", { floor_plan: "same" }, { checkPattern: "alternative" }), { floor_plan: "same" });
  eq(sanitizePickerChoices("property_recommendation", { pickup_type: "新着1件", situation_kind: "vacancy_none" }), { pickup_type: "新着1件" });
  eq(sanitizePickerChoices("property_recommendation", { pickup_type: "現状伝えて1件", situation_kind: "vacancy_none" }), { pickup_type: "現状伝えて1件", situation_kind: "vacancy_none" });
});
it("従来の列（check_pattern・send_mode・app_sub_mode）は picker_choices に入れない", () => {
  eq(sanitizePickerChoices("application_push", { app_sub_mode: "format" }, { appSubMode: "format" }), null);
  // 子のピッカーの親は従来の列の値で見る（申込フォーマットの時だけ 単独／同居・申込誘導の時だけ 誘導の種類）
  eq(sanitizePickerChoices("application_push", { living_type: "single", push_type: "simple" }, { appSubMode: "format" }), { living_type: "single" });
  eq(sanitizePickerChoices("application_push", { living_type: "single", push_type: "simple" }, { appSubMode: "push" }), { push_type: "simple" });
});
it("知らない AIX・形の違う値は null", () => {
  eq(sanitizePickerChoices("nope", { a: 1 }), null);
  eq(sanitizePickerChoices("estimate_sheet", "x"), null);
  eq(sanitizePickerChoices("estimate_sheet", ["single"]), null);
});

console.log("\n■ 話題（ブレインとスタッフの比べ方）");
it("物件あった・なかった・別の部屋・専任・空（ブレイン）は同じ話題（募集状況）", () => {
  eq(["available", "unavailable", "alternative", "exclusive", null, ""].map(checkPatternTopic), ["availability", "availability", "availability", "availability", "availability", "availability"]);
  eq(checkPatternTopic("interior_photo"), "interior_photo");
  eq(checkPatternTopic("mgmt_guarantor"), "condition");
});

console.log("\n■ 場面 → ピッカー（お客様役・監査）");
it("物件確認した: 募集が終わっていた → 物件なかった（竹内さんの「募集終了していた」）", () => {
  const c = pickerForScene({ aixType: "property_check_result", turnText: "こちら初期費用しりたいです！", roomStatus: "ended" });
  eq([c?.field, c?.value, c?.label], ["check_pattern", "unavailable", "物件なかった"]);
});
it("物件確認した: 室内の写真の依頼 → 室内写真を確認した（募集状況より先）", () => {
  eq(pickerForScene({ aixType: "property_check_result", turnText: "これ室内写真欲しいです", roomStatus: "available" })?.value, "interior_photo");
});
it("物件確認した: 募集中・退去予定・不明 → 物件あった／同じ建物の別の部屋 → 別の部屋が募集してた／専任 → 専任物件だった", () => {
  eq(pickerForScene({ aixType: "property_check_result", roomStatus: "vacating" })?.value, "available");
  eq(pickerForScene({ aixType: "property_check_result" })?.value, "available");
  eq(pickerForScene({ aixType: "property_check_result", roomStatus: "other_room" })?.value, "alternative");
  eq(pickerForScene({ aixType: "property_check_result", roomStatus: "exclusive" })?.value, "exclusive");
});
it("物件ピックアップした: 代わり → alternative／条件を広げた → widen／前に送った → new_arrival／初回 → normal", () => {
  eq(pickerForScene({ aixType: "property_send", afterEnded: true, sentPropertyCount: 3 })?.value, "alternative");
  eq(pickerForScene({ aixType: "property_send", widened: true, sentPropertyCount: 3 })?.value, "widen");
  eq(pickerForScene({ aixType: "property_send", sentPropertyCount: 3 })?.value, "new_arrival");
  eq(pickerForScene({ aixType: "property_send", sentPropertyCount: 0 })?.value, "normal");
});
it("見積書: 1件／複数件", () => {
  eq(pickerForScene({ aixType: "estimate_sheet" })?.value, "single");
  eq(pickerForScene({ aixType: "estimate_sheet", estimateCount: 2 })?.value, "multi");
});
it("内覧日調整: 日時を言った → 内覧日指定あり／退去予定 → 退去予定物件／日程変更／それ以外 → 通常", () => {
  eq(pickerForScene({ aixType: "viewing_invite", turnText: "あした18時から内覧お願いしたいです" })?.value, "内覧日指定あり");
  eq(pickerForScene({ aixType: "viewing_invite", turnText: "内覧したいです", vacatingRoom: true })?.value, "退去予定物件");
  eq(pickerForScene({ aixType: "viewing_invite", turnText: "内覧の日を変えたいです", reschedule: true })?.value, "日程変更");
  eq(pickerForScene({ aixType: "viewing_invite", turnText: "こちらのお部屋、ぜひ内覧したいのですが" })?.value, "通常");
});
it("申込へ: 申込を決めた → 申込フォーマット／書類 → 書類依頼／それ以外 → 申込誘導", () => {
  eq(pickerForScene({ aixType: "application_push", turnText: "ここに決めたいです！申込お願いします" })?.value, "format");
  eq(pickerForScene({ aixType: "application_push", turnText: "身分証の写真これで大丈夫ですか" })?.value, "docs_request");
  eq(pickerForScene({ aixType: "application_push", turnText: "少し考えます" })?.value, "push");
});
it("ピッカーの無い AIX は null", () => {
  eq(pickerForScene({ aixType: "phone_followup" }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
