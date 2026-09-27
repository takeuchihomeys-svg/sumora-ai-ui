// app/lib/aix-pickers.ts
// AIX の各ボタンの「ピッカー」（画面で選ぶ選択肢・入れる値）の一覧と、その記録・場面からの選び方（純関数・DB 依存なし）。
//
// 2026-09-27 竹内さん「初期費用しりたいはAIXの初期費用おくるから見積書おくってる／物件なければ物件確認したの募集終了していたのピッカーから／
//   それぞれのピッカーを理解したらもっと意味が分かる」＋「ピッカー選択した部分の記録はない状態なのか／無ければそこも作っておく」
//   （memory feedback_cost_request_estimate_or_ended）。
//
// 1か所に置く理由（設計知見「同じ事実を2か所に置かない」・UIピッカーのラベル/キーずれ）:
//   ①記録（/api/log-aix-usage の picker_choices を整える sanitizePickerChoices）
//   ②監査（scripts/audit-aix-pickers.ts が選択肢ごとに数える）
//   ③お客様役（scripts/customer-sim.ts が「場面 → ピッカー」を選ぶ pickerForScene）
//   が同じ定義を読む。値（キー）は画面（app/components/AixModal.tsx・app/page.tsx）の実物のまま。文言も画面のまま。
//
// 記録の列（aix_usage_logs）:
//   check_pattern（物件確認した／確認した（条件・交渉））・send_mode（物件ピックアップした）・app_sub_mode（申込へ）は従来の列のまま。
//   それ以外の選択・入力値は picker_choices（jsonb）に1つにまとめる（2026-09-27 追加・migrate-schema/route.ts）。

export type PickerValue = string | number | boolean | string[];
export type PickerChoices = Record<string, PickerValue>;

export type PickerOption = {
  /** 画面の値（キー）。記録にもこの値を入れる */
  value: string;
  /** 画面の文言 */
  label: string;
  /** 選ぶ場面（実送信で確かめた型） */
  when: string;
};

export type PickerDef = {
  /** picker_choices の鍵（check_pattern / send_mode / app_sub_mode は従来の列の名前のまま） */
  key: string;
  /** 画面の見出し */
  label: string;
  kind: "choice" | "multi" | "bool" | "text" | "date" | "number";
  /** 従来の列に入る物（picker_choices には入れない） */
  column?: "check_pattern" | "send_mode" | "app_sub_mode";
  options?: PickerOption[];
  /** この選択肢のときだけ出る子のピッカー */
  onlyWhen?: { key: string; values: string[] };
};

export type AixPickerSpec = {
  aixType: string;
  /** 画面のボタン名 */
  button: string;
  pickers: PickerDef[];
  /** 送る文の型（aix/action のどの分岐か・固定テンプレか LLM か） */
  textType: string;
};

// ─── 物件確認した（募集状況）: 結果で選ぶ（会話からは分からない＝スタッフが確認して選ぶ）────────────────
/** 「物件確認した（募集状況）」の結果ピッカー（AixModal.tsx「確認結果を選択」の実物） */
export const AVAILABILITY_RESULT_OPTIONS: PickerOption[] = [
  { value: "available", label: "物件あった", when: "募集中（入居可能）。持ち込み物件の確認・費用の質問には御見積書を同封して答える（入居日・設備の質問もこの報告に添える）" },
  { value: "alternative", label: "別の部屋が募集してた", when: "聞かれた部屋は満室だが同じ建物の別の部屋が募集中（同じ間取り／違う間取り）" },
  { value: "unavailable", label: "物件なかった", when: "募集終了・満室・空きなし（竹内さんの言う「募集終了していた」）。見積書を作ろうとして終わっていた時もここ。引き続き探す・代わりを送る" },
  { value: "exclusive", label: "専任物件だった", when: "専任のため弊社でご紹介できない" },
  { value: "move_in_date", label: "入居日確認した", when: "退去日から入居可能日を計算して送る（物件資料の画像）" },
  { value: "interior_photo", label: "室内写真を確認した", when: "室内の写真・動画・室内イメージURL を頼まれた。手元の写真／URL＋物件名で固定文（AI は使わない）" },
  { value: "other_room_check", label: "別の部屋について確認した", when: "同じ建物の別の部屋・別の間取りを聞かれた（ある／ない）" },
];

/** 「確認した（条件・交渉）」→ 管理会社に確認した の子（page.tsx の実物）。check_pattern に入る */
export const CONDITION_CHECK_OPTIONS: PickerOption[] = [
  { value: "mgmt_availability", label: "募集状況について", when: "管理会社に募集状況を聞いた（募集している／募集終了した）" },
  { value: "vacate_date", label: "退去予定日について", when: "退去予定日を管理会社に聞いた" },
  { value: "mgmt_move_in", label: "入居日について", when: "募集中と分かっているお部屋の入居可能日・希望日で入れるか" },
  { value: "mgmt_initial_cost", label: "初期費用について", when: "管理会社に初期費用の**交渉**（礼金・消臭代を外せるか等）をした結果。費用を知りたいだけの依頼は見積書送る" },
  { value: "mgmt_proxy", label: "代理契約について", when: "代理契約の可否（可能／不可）" },
  { value: "mgmt_guarantor", label: "保証会社について（審査面）", when: "募集中と分かっているお部屋の保証会社・保証人・審査の条件" },
  { value: "mgmt_parking", label: "駐車場について", when: "物件の駐車場の有無・料金・空き" },
  { value: "mgmt_pet", label: "ペット飼育について", when: "ペット可否・条件" },
  { value: "mgmt_equipment", label: "設備について", when: "設備の有無（エアコン・洗濯機置場 等）" },
  { value: "nearby_parking", label: "近隣の月極駐車場を確認した", when: "近くの月極駐車場（名前・距離・料金・空き）" },
  { value: "owner_other", label: "オーナーに確認した→その他", when: "オーナーに確認した内容と結果" },
];

export const AIX_PICKERS: Record<string, AixPickerSpec> = {
  property_check_result: {
    aixType: "property_check_result",
    button: "物件確認した（募集状況）／確認した（条件・交渉）",
    textType: "aix/action の property_check_result 分岐。物件あった・物件なかったは固定テンプレ中心（会話を合わせる時は LLM）・室内写真は画面の固定文・管理会社系は LLM",
    pickers: [
      { key: "check_pattern", label: "確認結果を選択／何を確認したか", kind: "choice", column: "check_pattern", options: [...AVAILABILITY_RESULT_OPTIONS, ...CONDITION_CHECK_OPTIONS] },
      { key: "check_who", label: "誰に確認したか（確認した（条件・交渉））", kind: "choice", options: [
        { value: "mgmt", label: "管理会社に確認した", when: "管理会社の回答" },
        { value: "daihyo", label: "代表に確認した", when: "代表からの特別割引など（初期費用／その他）" },
        { value: "owner", label: "オーナーに確認した", when: "オーナーの回答（初期費用／その他）" },
        { value: "nearby_parking", label: "近隣の月極駐車場を確認した", when: "近隣の月極" },
      ] },
      { key: "floor_plan", label: "同じ間取り／違う間取り", kind: "choice", onlyWhen: { key: "check_pattern", values: ["alternative"] }, options: [
        { value: "same", label: "同じ間取り", when: "" }, { value: "different", label: "違う間取り", when: "" },
      ] },
      { key: "other_room", label: "別の部屋", kind: "choice", onlyWhen: { key: "check_pattern", values: ["other_room_check"] }, options: [
        { value: "has_room", label: "別の部屋がある", when: "" }, { value: "no_room", label: "別の部屋が無い", when: "" },
      ] },
      { key: "mgmt_availability_status", label: "募集している／募集終了した", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_availability"] }, options: [
        { value: "available", label: "募集している", when: "" }, { value: "ended", label: "募集終了した", when: "" },
      ] },
      { key: "mgmt_cost_type", label: "見積書おくる／管理会社交渉", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_initial_cost"] }, options: [
        { value: "estimate", label: "見積書おくる", when: "" }, { value: "negotiation", label: "管理会社交渉", when: "" },
      ] },
      { key: "proxy_result", label: "代理契約 可能／不可", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_proxy"] }, options: [
        { value: "可能", label: "可能", when: "" }, { value: "不可", label: "不可", when: "" },
      ] },
      { key: "parking", label: "駐車場 あり／なし", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_parking"] }, options: [
        { value: "あり", label: "あり", when: "" }, { value: "なし", label: "なし", when: "" },
      ] },
      { key: "parking_vacancy", label: "駐車場の空き", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_parking", "nearby_parking"] }, options: [
        { value: "空きあり", label: "空きあり", when: "" }, { value: "空きなし", label: "空きなし", when: "" }, { value: "要確認", label: "要確認", when: "" },
      ] },
      { key: "pet_policy", label: "ペット 可／不可／相談可", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_pet"] }, options: [
        { value: "可", label: "可", when: "" }, { value: "不可", label: "不可", when: "" }, { value: "相談可", label: "相談可", when: "" },
      ] },
      { key: "guarantor_type", label: "保証会社の種類", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_guarantor"] }, options: [
        { value: "独立系", label: "独立系", when: "" }, { value: "信販系", label: "信販系", when: "" }, { value: "信用系", label: "信用系", when: "" }, { value: "不明", label: "不明", when: "" },
      ] },
      { key: "guidance", label: "誘導（申込／内覧）", kind: "choice", options: [
        { value: "申込", label: "申込", when: "" }, { value: "内覧", label: "内覧", when: "" }, { value: "apply", label: "申込", when: "" }, { value: "viewing", label: "内覧", when: "" },
      ] },
      { key: "move_in_period", label: "入居の旬", kind: "choice", onlyWhen: { key: "check_pattern", values: ["mgmt_move_in"] }, options: [
        { value: "上旬", label: "上旬", when: "" }, { value: "中旬", label: "中旬", when: "" }, { value: "下旬", label: "下旬", when: "" },
      ] },
      { key: "move_in_month", label: "入居月", kind: "text", onlyWhen: { key: "check_pattern", values: ["mgmt_move_in"] } },
      { key: "vacate_date", label: "退去日", kind: "text" },
      { key: "sent_property_count", label: "送った物件数", kind: "number" },
      { key: "check_property_count", label: "確認した物件数", kind: "number" },
      { key: "viewing_continue", label: "内覧誘導（流れを続ける）", kind: "bool" },
      { key: "application_invite", label: "申込誘導", kind: "bool" },
      { key: "all_available", label: "全て募集してた", kind: "bool" },
      { key: "estimate_text", label: "見積書テキスト同封", kind: "bool" },
      { key: "recommend_index", label: "特にオススメの物件（何件目）", kind: "number" },
      { key: "has_estimate_image", label: "見積書の画像を付けた", kind: "bool" },
    ],
  },
  property_send: {
    aixType: "property_send",
    button: "物件ピックアップした",
    textType: "aix/action 2875〜（send_mode ごとのプロンプト・LLM）",
    pickers: [
      { key: "send_mode", label: "まとめの種類", kind: "choice", column: "send_mode", options: [
        { value: "normal", label: "初回まとめ／新規物件", when: "希望条件に合う物件を初めて（通常どおり）送る" },
        { value: "new_arrival", label: "新着まとめ", when: "前に物件を送った後、新しく出た物件を送る（追客）" },
        { value: "widen", label: "条件広げまとめ", when: "希望どおりが無く、エリア・家賃・間取り等を広げて探した" },
        { value: "alternative", label: "代替物件送り", when: "気に入った物件が満室・紹介不可だった代わり（物件確認した→物件なかった の後）" },
      ] },
      { key: "new_arrival_apply", label: "新着の申込み誘導", kind: "bool" },
      { key: "include_viewing", label: "内覧提案あり", kind: "bool" },
      { key: "image_count", label: "送った画像の数", kind: "number" },
      { key: "vacating_count", label: "退去予定の物件の数", kind: "number" },
    ],
  },
  property_recommendation: {
    aixType: "property_recommendation",
    button: "物件オススメ（1件特にオススメ）",
    textType: "aix/action 2217〜（画像を読む LLM・🌟カード）",
    pickers: [
      { key: "pickup_type", label: "オススメの種類", kind: "choice", options: [
        { value: "新規ピックアップ", label: "初回・1件訴求", when: "初めて1件に絞って勧める" },
        { value: "新着1件", label: "新着・1件訴求", when: "前に送った後の新着を1件" },
        { value: "継続ピックアップ", label: "送った中から・1件訴求", when: "これまで送った中から1件を推す" },
        { value: "条件広げピックアップ", label: "条件広げ・1件訴求", when: "条件を広げて見つけた1件" },
        { value: "代替ピックアップ", label: "代替・1件訴求", when: "気に入った物件が無くなった代わりの1件" },
        { value: "現状伝えて1件", label: "現状伝えて・1件訴求", when: "希望どおりが無い現状を伝えてから1件" },
      ] },
      { key: "situation_kind", label: "現状の種類", kind: "choice", onlyWhen: { key: "pickup_type", values: ["現状伝えて1件"] }, options: [
        { value: "vacancy_none", label: "空室が無い", when: "" }, { value: "area_none", label: "エリアに無い", when: "" }, { value: "custom", label: "自由文", when: "" },
      ] },
      { key: "is_new_arrival", label: "新着", kind: "bool" },
      { key: "focus_points", label: "強調ポイント", kind: "multi", options: [
        { value: "家賃", label: "家賃", when: "" }, { value: "初期費用", label: "初期費用", when: "" }, { value: "お部屋の条件", label: "お部屋の条件", when: "" },
        { value: "設備", label: "設備", when: "" }, { value: "地域・駅", label: "地域・駅", when: "" },
      ] },
      { key: "simple", label: "シンプル", kind: "bool" },
      { key: "has_estimate_image", label: "見積書を付けた", kind: "bool" },
    ],
  },
  estimate_sheet: {
    aixType: "estimate_sheet",
    button: "見積書送る",
    textType: "aix/action 2594〜（見積書の読み取り＋金額計算・カバーレターは LLM）",
    pickers: [
      { key: "estimate_count", label: "1件／複数件", kind: "choice", options: [
        { value: "single", label: "1件", when: "お部屋1件の御見積書（こちらが送って気に入って頂いたお部屋への「初期費用しりたい」「見積もりお願い」）" },
        { value: "multi", label: "複数件", when: "2〜3件の御見積書を一度に" },
      ] },
      { key: "with_appeal", label: "申込誘導", kind: "bool" },
      { key: "campaign", label: "キャンペーン", kind: "text" },
      { key: "has_property_image", label: "物件資料を同封", kind: "bool" },
    ],
  },
  viewing_invite: {
    aixType: "viewing_invite",
    button: "内覧日調整（内覧へ！）",
    textType: "内覧日指定あり・退去予定物件は画面の固定テンプレ／通常・会話を合わせるは aix/action 3614〜（LLM）",
    pickers: [
      { key: "viewing_mode", label: "内覧の種類", kind: "choice", options: [
        { value: "通常", label: "内覧確定！（内覧日調整）", when: "内覧の希望に候補日を出す" },
        { value: "退去予定物件", label: "退去予定物件", when: "退去予定のお部屋（退去後の内覧・退去日）" },
        { value: "内覧日指定あり", label: "内覧日指定あり", when: "お客様が日時を言った" },
        { value: "日程変更", label: "日程変更", when: "決まった内覧の日時を変える" },
      ] },
      { key: "include_calendar", label: "カレンダーの枠を付けた", kind: "bool" },
    ],
  },
  meeting_place: {
    aixType: "meeting_place",
    button: "待ち合わせ",
    textType: "時間あり＝画面の固定文／時間なし＝aix/action 6318（LLM）",
    pickers: [
      { key: "has_time", label: "時間あり／なし", kind: "bool" },
      { key: "meeting_date", label: "日付", kind: "text" },
      { key: "meeting_time", label: "時刻", kind: "text" },
    ],
  },
  application_push: {
    aixType: "application_push",
    button: "申込へ！",
    textType: "format は画面の固定の申込書／他は aix/action 3978〜（LLM）",
    pickers: [
      { key: "app_sub_mode", label: "申込の場面", kind: "choice", column: "app_sub_mode", options: [
        { value: "push", label: "申込誘導", when: "まだ決めていないお客様の申込を後押し" },
        { value: "confirm", label: "申込確定", when: "お客様が申込を決めた（確定のご連絡と次の手順）" },
        { value: "format", label: "申込フォーマット送る", when: "申込書（記入フォーマット）を送る" },
        { value: "docs_request", label: "書類依頼", when: "不足している書類（本人確認・収入証明 等）を依頼" },
      ] },
      { key: "push_type", label: "申込誘導の種類", kind: "choice", onlyWhen: { key: "app_sub_mode", values: ["push"] }, options: [
        { value: "simple", label: "シンプル申込", when: "" }, { value: "scheduled", label: "退去予定", when: "" }, { value: "hold_view", label: "部屋抑えて内覧", when: "" },
      ] },
      { key: "appeal_points", label: "訴求ポイント", kind: "multi" },
      { key: "living_type", label: "単独／同居", kind: "choice", onlyWhen: { key: "app_sub_mode", values: ["format"] }, options: [
        { value: "single", label: "単独", when: "" }, { value: "shared", label: "同居あり", when: "" },
      ] },
      { key: "guarantor_kind", label: "緊急連絡先／連帯保証人", kind: "choice", onlyWhen: { key: "app_sub_mode", values: ["format"] }, options: [
        { value: "emergency", label: "緊急連絡先", when: "" }, { value: "guarantor", label: "連帯保証人", when: "" },
      ] },
    ],
  },
  followup_revive: {
    aixType: "followup_revive",
    button: "追客する",
    textType: "aix/action 6562〜（LLM）",
    pickers: [
      { key: "followup_sub_mode", label: "追客の種類", kind: "choice", options: [
        { value: "apply_supplement", label: "申込補足情報について催促", when: "" },
        { value: "search_continue", label: "物件探し継続中か催促", when: "" },
      ] },
    ],
  },
  acknowledge_check: {
    aixType: "acknowledge_check",
    button: "確認します",
    textType: "aix/action 6427（LLM）",
    pickers: [
      { key: "ack_preset", label: "確認の種類", kind: "choice", options: [
        { value: "daihyo_initial_cost", label: "代表確認（初期費用）", when: "" },
        { value: "kanri_boshu", label: "管理会社（募集状況）", when: "" },
      ] },
    ],
  },
  condition_hearing: {
    aixType: "condition_hearing",
    button: "条件ヒアリング",
    textType: "aix/action 5975（LLM＋固定のフォーム）",
    pickers: [
      { key: "hearing_mode", label: "送り方", kind: "choice", options: [
        { value: "generate", label: "AIX生成", when: "" }, { value: "conv_match", label: "会話を合わせる", when: "" }, { value: "form_only", label: "フォームのみ送る", when: "" },
      ] },
    ],
  },
  cost_explain: {
    aixType: "cost_explain",
    button: "初期費用を説明",
    textType: "AIX生成＝画面の固定文／会話を合わせる＝aix/action 3536（LLM）",
    pickers: [
      { key: "cost_explain_mode", label: "説明の種類", kind: "choice", options: [
        { value: "fee", label: "貸主から報酬あり", when: "" }, { value: "no_fee", label: "貸主から手数料なし", when: "" }, { value: "mechanism", label: "仕組みを説明（金額なし）", when: "" },
      ] },
      { key: "fee_label", label: "月数", kind: "text" },
    ],
  },
  cost_breakdown: { aixType: "cost_breakdown", button: "初期費用について", textType: "aix/action 6834（読み取り＋LLM）", pickers: [{ key: "image_count", label: "御見積書の画像の数", kind: "number" }] },
  guarantor_info: { aixType: "guarantor_info", button: "保証会社について", textType: "aix/action 7016（固定または LLM）", pickers: [{ key: "parallel", label: "並行審査", kind: "bool" }, { key: "card_count", label: "物件の数", kind: "number" }] },
  phone_call: { aixType: "phone_call", button: "電話をかける", textType: "画面の固定文＋通話ボタンのカード", pickers: [{ key: "has_purpose", label: "用件あり", kind: "bool" }] },
  phone_followup: { aixType: "phone_followup", button: "電話終了後", textType: "aix/action 6950（LLM）", pickers: [] },
  zenryoku_support: { aixType: "zenryoku_support", button: "全力サポート", textType: "aix/action 6774（LLM）", pickers: [{ key: "has_area", label: "エリアあり", kind: "bool" }] },
};

/** 選択肢の画面の文言（無ければ値のまま） */
export function pickerOptionLabel(aixType: string, key: string, value: string | null | undefined): string | null {
  if (!value) return null;
  const p = AIX_PICKERS[aixType]?.pickers.find((x) => x.key === key);
  return p?.options?.find((o) => o.value === value)?.label ?? value;
}

const AVAILABILITY_VALUES = new Set(AVAILABILITY_RESULT_OPTIONS.map((o) => o.value));

/**
 * 画面から来た picker_choices を記録用に整える（知らない鍵・選択肢に無い値・空は落とす。文字は短く）。
 * check_pattern / send_mode / app_sub_mode は従来の列に入るので picker_choices には入れない。
 * 「誰に確認したか」（check_who）は条件・交渉の check_pattern の時だけ残す（page.tsx の ref は消されずに残るため）。
 * @returns 空なら null
 */
export function sanitizePickerChoices(aixType: string, raw: unknown, ctx?: { checkPattern?: string | null; appSubMode?: string | null; sendMode?: string | null }): PickerChoices | null {
  const spec = AIX_PICKERS[aixType];
  if (!spec || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: PickerChoices = {};
  for (const p of spec.pickers) {
    if (p.column) continue;
    const v = src[p.key];
    if (v === undefined || v === null || v === "") continue;
    if (p.onlyWhen) {
      // 親が従来の列（check_pattern / app_sub_mode / send_mode）の時はその列の値で見る
      const fromCol = p.onlyWhen.key === "check_pattern" ? ctx?.checkPattern : p.onlyWhen.key === "app_sub_mode" ? ctx?.appSubMode : p.onlyWhen.key === "send_mode" ? ctx?.sendMode : undefined;
      const parent = fromCol ?? (src[p.onlyWhen.key] as string | undefined);
      if (!parent || !p.onlyWhen.values.includes(String(parent))) continue;
    }
    if (p.key === "check_who" && (!ctx?.checkPattern || AVAILABILITY_VALUES.has(ctx.checkPattern))) continue;
    if (p.kind === "choice") {
      if (typeof v !== "string") continue;
      if (p.options && !p.options.some((o) => o.value === v)) continue;
      out[p.key] = v;
    } else if (p.kind === "multi") {
      if (!Array.isArray(v)) continue;
      const arr = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.slice(0, 40)).slice(0, 10);
      if (arr.length) out[p.key] = arr;
    } else if (p.kind === "bool") {
      if (typeof v === "boolean") out[p.key] = v;
    } else if (p.kind === "number") {
      if (typeof v === "number" && Number.isFinite(v)) out[p.key] = v;
    } else {
      if (typeof v === "string" && v.trim()) out[p.key] = v.trim().slice(0, 100);
    }
  }
  return Object.keys(out).length ? out : null;
}

// ─── 物件確認した のピッカーの話題（ブレインの判断とスタッフの選択を比べる単位）───────────────
/**
 * check_pattern の話題。募集状況の結果（物件あった／なかった／別の部屋／専任）はスタッフが確認してから選ぶので
 * ブレイン（null＝募集状況）と比べる時は「availability」に寄せる。
 */
export function checkPatternTopic(cp: string | null | undefined): "availability" | "interior_photo" | "move_in" | "condition" {
  if (!cp || cp === "available" || cp === "alternative" || cp === "unavailable" || cp === "exclusive" || cp === "mgmt_availability") return "availability";
  if (cp === "interior_photo" || cp === "other_room_check") return "interior_photo";
  if (cp === "move_in_date") return "move_in";
  return "condition";
}

// ─── 場面 → ピッカー（お客様役・監査が使う）──────────────────────────────────────
export type PickerSceneInput = {
  aixType: string;
  /** お客様の今回の連投（改行でつないだ文字） */
  turnText?: string | null;
  /** 今回の連投にお客様の画像があるか */
  hasImage?: boolean;
  /** お部屋の募集状況（保存済みの材料・スタッフが確認した結果。分からなければ unknown） */
  roomStatus?: "available" | "vacating" | "ended" | "other_room" | "exclusive" | "unknown";
  /** これまでに物件を送った件数 */
  sentPropertyCount?: number;
  /** 前に送った物件（気に入って頂いた物件）が無くなった直後か（物件確認した→物件なかった の後） */
  afterEnded?: boolean;
  /** 希望どおりが無く条件を広げたか */
  widened?: boolean;
  /** 見積書にする物件の数 */
  estimateCount?: number;
  /** 退去予定のお部屋の内覧か */
  vacatingRoom?: boolean;
  /** 決まっている内覧の日時を変えるか */
  reschedule?: boolean;
};

export type PickerChoice = { field: string; value: string; label: string; reason: string };

const ROOM_PHOTO_ASK_RE = /(?:室内|お?部屋(?:の中)?|中)の?(?:写真|画像|動画|様子)|室内イメージ|内見の動画|(?:写真|画像|動画)(?:は|って|とか)?(?:あり|あれ|ある|欲しい|ほしい|見たい|送って|頂け|いただけ)/;
const VIEWING_DATE_GIVEN_RE = /[0-9０-９]{1,2}\s*[\/月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}\s*日|明日|あした|明後日|今日|本日|(?:月|火|水|木|金|土|日)曜|[0-9０-９]{1,2}\s*(?:時|:)/;
const APPLY_DECIDED_RE = /申(?:し)?込(?:み)?(?:ます|したい|させて|お願い|で(?:お願い|大丈夫))|ここに決め|こちらに決め|契約(?:したい|します)/;
const DOCS_RE = /書類|身分証|免許証|保険証|源泉|給与明細|収入証明|住民票/;

/**
 * 決まった AIX（aixType）で、どのピッカーを選ぶか（お客様役・監査用。ブレインの判断は変えない）。
 * 物件確認した の結果（あった／なかった）は会話からは分からないので、保存済みの材料（roomStatus）で選ぶ。
 *   ・室内写真の依頼 → 室内写真を確認した
 *   ・募集が終わっていた（ended）→ 物件なかった（竹内さんの「募集終了していた」）
 *   ・同じ建物の別の部屋だけ募集 → 別の部屋が募集してた ／ 専任 → 専任物件だった
 *   ・それ以外（募集中・退去予定・不明）→ 物件あった（費用・条件の質問にはこの報告に御見積書・答えを添える）
 * @returns ピッカーの無い AIX・選べない時は null
 */
export function pickerForScene(input: PickerSceneInput): PickerChoice | null {
  const t = (input.turnText ?? "").trim();
  const mk = (field: string, value: string, reason: string): PickerChoice => ({ field, value, label: pickerOptionLabel(input.aixType, field, value) ?? value, reason });
  switch (input.aixType) {
    case "property_check_result": {
      if (ROOM_PHOTO_ASK_RE.test(t)) return mk("check_pattern", "interior_photo", "室内の写真・動画の依頼");
      switch (input.roomStatus) {
        case "ended": return mk("check_pattern", "unavailable", "募集が終わっていた（募集終了していた）");
        case "other_room": return mk("check_pattern", "alternative", "聞かれた部屋は満室・同じ建物の別の部屋が募集中");
        case "exclusive": return mk("check_pattern", "exclusive", "専任のためご紹介できない");
        default: return mk("check_pattern", "available", input.roomStatus === "vacating" ? "退去予定で募集中" : "募集中（費用・条件の質問にはこの報告に御見積書・答えを添える）");
      }
    }
    case "property_send": {
      if (input.afterEnded) return mk("send_mode", "alternative", "気に入った物件が無くなった代わり");
      if (input.widened) return mk("send_mode", "widen", "条件を広げて探した");
      if ((input.sentPropertyCount ?? 0) > 0) return mk("send_mode", "new_arrival", "前に送った後の新着");
      return mk("send_mode", "normal", "初めてのピックアップ");
    }
    case "property_recommendation": {
      if (input.afterEnded) return mk("pickup_type", "代替ピックアップ", "気に入った物件が無くなった代わりの1件");
      if (input.widened) return mk("pickup_type", "条件広げピックアップ", "条件を広げて見つけた1件");
      if ((input.sentPropertyCount ?? 0) > 0) return mk("pickup_type", "新着1件", "前に送った後の新着1件");
      return mk("pickup_type", "新規ピックアップ", "初めて1件に絞って勧める");
    }
    case "estimate_sheet":
      return (input.estimateCount ?? 1) >= 2 ? mk("estimate_count", "multi", "2件以上の御見積書") : mk("estimate_count", "single", "お部屋1件の御見積書");
    case "viewing_invite":
      if (input.reschedule) return mk("viewing_mode", "日程変更", "決まった内覧の日時を変える");
      if (input.vacatingRoom) return mk("viewing_mode", "退去予定物件", "退去予定のお部屋");
      if (VIEWING_DATE_GIVEN_RE.test(t)) return mk("viewing_mode", "内覧日指定あり", "お客様が日時を言った");
      return mk("viewing_mode", "通常", "内覧の希望に候補日を出す");
    case "application_push":
      if (DOCS_RE.test(t)) return mk("app_sub_mode", "docs_request", "書類の話");
      if (APPLY_DECIDED_RE.test(t)) return mk("app_sub_mode", "format", "申込を決めた → 申込書を送る");
      return mk("app_sub_mode", "push", "申込の後押し");
    default:
      return null;
  }
}
