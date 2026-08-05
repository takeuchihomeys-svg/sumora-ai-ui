// AIXボタンの正準マッピング（UI ⇔ AI層の語彙統一）
//
// 背景: UIボタン「確認した（条件・交渉）」（app/page.tsx AIXメニュー、actionType: 'acknowledge_result'）は
// UI専用の幽霊タイプで、API上は property_check_result + check_pattern
// （mgmt_guarantor / mgmt_initial_cost / mgmt_parking / mgmt_pet / mgmt_equipment /
//   vacate_date / mgmt_move_in / nearby_parking 等）に変換されて送信される。
// そのためAI層のラベルマップ（suggest-next-action の Sonnet 選択肢・generate-reply の AIX_ACTION_NOTES・
// aix-weekly-learning の ACTION_LABELS・analyze-aix-flow の AIXボタン一覧・
// prompt-management の aix_logic_property_check）では property_check_result を
// 「物件確認した（募集状況）」と「確認した（条件・交渉）」の両方を包含するタイプとして説明すること。
// 各ラベルマップの説明文は下の PROPERTY_CHECK_RESULT_LABEL / PROPERTY_CHECK_RESULT_DESCRIPTION に統一する。

export const AIX_BUTTON_TAXONOMY = {
  property_check_result: {
    label: "物件確認した（募集状況）",
    // UI親ボタン「確認した（条件・交渉）」→ property_check_result + check_pattern で送信される
    sub_buttons: {
      "確認した（条件・交渉）": [
        "mgmt_guarantor",    // 管理会社: 保証会社・保証人
        "mgmt_initial_cost", // 管理会社: 初期費用交渉
        "mgmt_parking",      // 管理会社: 駐車場
        "mgmt_pet",          // 管理会社: ペット可否
        "mgmt_equipment",    // 管理会社: 設備
        "vacate_date",       // 退去予定日
        "mgmt_move_in",      // 入居可能日
        "nearby_parking",    // 近隣月極駐車場
      ],
    },
  },
} as const;

// 全ラベルマップ共通の property_check_result 統一ラベル
export const PROPERTY_CHECK_RESULT_LABEL = "物件確認した／確認した（条件・交渉）";

// 全ラベルマップ共通の property_check_result 統一説明文
export const PROPERTY_CHECK_RESULT_DESCRIPTION =
  "空室・退去日・入居可能日・保証会社・初期費用交渉・駐車場・ペット可否など、管理会社・代表・オーナー・近隣月極への確認結果を報告する（check_patternで切替）";
