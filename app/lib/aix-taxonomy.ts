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

// ─── AIXボタン種別アナウンス統一マップ（2026-08）──────────────────────────────
// 従来 generate-reply の AIX_ACTION_NOTES と brain-core の AIX_BRAIN_NOTES が二重管理され
// 文言が乖離していた（property_check_result の2ボタン併記有無・property_search の有無）。
// 本モジュールを単一ソースとし、両ファイルはここを import する（二重定義禁止）。

// ボタンキー → UIボタン表示名（page.tsx の AIX_ACTION_META / BRAIN_AIX_LABELS と整合させること）
export const AIX_BUTTON_LABELS: Record<string, string> = {
  acknowledge_check:       "確認します",
  property_check_result:   "物件確認した（募集状況）",
  property_send:           "物件ピックアップした",
  property_recommendation: "物件オススメ",
  estimate_sheet:          "見積書送る",
  viewing_invite:          "内覧日調整",
  meeting_place:           "待ち合わせ",
  greeting_viewing:        "内覧挨拶",
  condition_hearing:       "条件ヒアリング",
  application_push:        "申込へ！",
  followup_revive:         "追客する",
  property_search:         "物件を探す",
};

// ボタンキー → スタッフ向けアナウンス（「AIX【ボタン名】を押してください: 理由・タイミング」形式）。
// 曖昧な「AIXボタンを使ってください」ではなく、①どのボタンか ②なぜこのボタンか ③いつ押すか を1文で伝える。
export const AIX_STAFF_NOTES: Record<string, string> = {
  acknowledge_check:       "AIX【確認します】を押してください: お客様が物件の空室・募集状況の確認を求めています。受付宣言の返信を送った後、このボタンで管理会社への空室確認＋見積書依頼を生成します（宛先は管理会社。お客様ではありません）",
  property_check_result:   "管理会社・オーナー・近隣月極から回答が届いた場面です → 空室・募集状況の回答ならAIX【物件確認した（募集状況）】、保証会社・初期費用交渉・駐車場・ペット可否・退去日・入居可能日など条件・交渉系の回答ならAIX【確認した（条件・交渉）】を押してください: 回答内容を顧客への結果報告文に変換します（結果報告の手打ちはNG）",
  property_send:           "AIX【物件ピックアップした】を押してください: お客様が条件を伝えた/変更した場面です。まず「お探しします」の旨を返信し、Chrome拡張で検索して物件URLが揃ったらこのボタンでカバーメッセージを生成して一緒に送ります",
  property_recommendation: "AIX【物件オススメ】を押してください: 同棟別号室の依頼・「初期費用を抑えたい」等、条件に最も合う1件に絞って再提案する場面です。1件に絞った詳細訴求文を生成します",
  estimate_sheet:          "AIX【見積書送る】を押してください: お客様が初期費用・見積を質問しています（最ホット・即対応対象）。見積書画像を読み取って自動計算＋カバーメッセージを生成します（金額の手打ち・AI生成はNG）",
  viewing_invite:          "AIX【内覧日調整】を押してください: お客様が内覧希望を表明しています。内覧候補日時の提示はこのボタン専用（候補日時の手打ち・AI生成は禁止）。日程を選択して内覧案内を送信します",
  meeting_place:           "AIX【待ち合わせ】を押してください: 内覧の日時・物件が確定した場面です。物件住所入りの待ち合わせ確定メッセージを生成します",
  greeting_viewing:        "AIX【内覧挨拶】を押してください: 内覧当日・前後の挨拶/フォローの場面です。シーンに合わせたフォローメッセージを生成します",
  condition_hearing:       "AIX【条件ヒアリング】を押してください: 希望条件がまだ揃っていない場面です。既知情報をスキップして未取得の条件だけ質問する形式で送れます",
  application_push:        "AIX【申込へ！】を押してください: 内覧後・見積送付後にお客様が前向きな場面です（退去予定/入居中物件の先押さえもこのボタン）。クロージングメッセージを生成して申込へ誘導します",
  followup_revive:         "AIX【追客する】を押してください: お客様からの返信が3日以上止まっています。再接触メッセージを生成します",
  property_search:         "Chrome拡張ツール（リアプロ/itandi/レインズ）で物件を検索してください: お客様の条件に合う物件を探す場面です（送付済み物件は候補から除外）。URLが揃ったらAIX【物件ピックアップした】で送付します",
};

// ─── property_check_result の check_pattern 決定論判定 ─────────────────────────
// brain の action 語彙は property_check_result 1キーだが、UIは
// 「物件確認した（募集状況）」と「確認した（条件・交渉）」の2親ボタンに分かれる（1キー多義問題）。
// 会話文脈からサブパターンを判定し、スタッフに「どちらのボタンのどのサブパターンか」を明示する。
export type PropertyCheckKind = {
  check_pattern: string;  // API送信時の check_pattern 値
  ui_button: string;      // 押すべきUIボタン名
  topic: string;          // 確認対象の話題ラベル
  note: string;           // スタッフ向け具体的指示文
};

// 判定順序が重要: nearby_parking（月極）は mgmt_parking（物件付帯駐車場）より先、
// mgmt_initial_cost（交渉）は汎用語より先に評価する。mgmt_equipment は最も広いため最後。
const CHECK_PATTERN_DETECTORS: Array<{ pattern: string; topic: string; re: RegExp }> = [
  { pattern: "nearby_parking",    topic: "近隣月極駐車場",         re: /月極|近隣[^\n]{0,10}駐車場|周辺[^\n]{0,10}駐車場/ },
  { pattern: "mgmt_initial_cost", topic: "初期費用・礼金等の交渉", re: /(礼金|敷金|初期費用|フリーレント|家賃)[^\n]{0,12}(交渉|減額|値引|割引|下げ|無料)|(交渉|減額|値引)[^\n]{0,10}(礼金|敷金|初期費用)/ },
  { pattern: "mgmt_guarantor",    topic: "保証会社・保証人",       re: /保証会社|連帯保証|保証人/ },
  { pattern: "mgmt_pet",          topic: "ペット可否",             re: /ペット|猫[^\n]{0,6}(飼|可|OK)|犬[^\n]{0,6}(飼|可|OK)/ },
  { pattern: "vacate_date",       topic: "退去予定日",             re: /退去(予定)?日|いつ[^\n]{0,4}退去/ },
  { pattern: "mgmt_move_in",      topic: "入居可能日",             re: /入居可能日|入居日|いつから[^\n]{0,4}(入居|住め)/ },
  { pattern: "mgmt_parking",      topic: "駐車場",                 re: /駐車場|バイク置|駐輪/ },
  { pattern: "mgmt_equipment",    topic: "設備",                   re: /エアコン|コンロ|ウォシュレット|洗濯機置|インターネット無料|ネット無料|設備/ },
];

export function detectPropertyCheckPattern(recentText: string): PropertyCheckKind | null {
  if (!recentText) return null;
  for (const d of CHECK_PATTERN_DETECTORS) {
    if (d.re.test(recentText)) {
      return {
        check_pattern: d.pattern,
        ui_button: "確認した（条件・交渉）",
        topic: d.topic,
        note: `AIX【確認した（条件・交渉）】を押してください: ${d.topic}の確認結果を顧客への報告文に変換する場面です（サブパターン: ${d.pattern}。結果報告の手打ちはNG）`,
      };
    }
  }
  return null;
}

// action キー＋check_pattern 判定結果からスタッフ向けアナウンスを1文で組み立てる。
// property_check_result で条件・交渉系サブパターンが特定できた場合は
// 2ボタン併記の丸投げ文言ではなく「確認した（条件・交渉）」への具体的指示に切り替える。
export function buildAixStaffNote(action: string, checkKind?: PropertyCheckKind | null): string {
  if (action === "property_check_result" && checkKind) return checkKind.note;
  return AIX_STAFF_NOTES[action] ?? `AIX【${AIX_BUTTON_LABELS[action] ?? action}】を押してください`;
}

// ─── LINE グループ通知用 短縮ラベル・ノート ─────────────────────────────────────
// brain required通知 / AIXゲート通知向け。最大3行に収める。
// UIや prompt の AIX_STAFF_NOTES（長文）とは別管理。

// 通知ヘッダー右辺: 「{name}さん｜{短ラベル}」の短ラベル部分
export const AIX_LINE_LABELS: Record<string, string> = {
  acknowledge_check:       "空室確認",
  property_check_result:   "確認結果の報告",
  property_send:           "物件ピックアップ",
  property_recommendation: "物件オススメ",
  estimate_sheet:          "見積書",
  viewing_invite:          "内覧日調整",
  meeting_place:           "待ち合わせ確定",
  greeting_viewing:        "内覧フォロー",
  condition_hearing:       "条件ヒアリング",
  application_push:        "申込クロージング",
  followup_revive:         "追客",
  property_search:         "物件ピックアップ",
};

// 通知2行目: 「次にやること」を1行で
export const AIX_LINE_NOTES: Record<string, string> = {
  acknowledge_check:       "受付返信 → AIX【確認します】",
  property_check_result:   "回答を AIX【物件確認した（募集状況）】で送る",
  property_send:           "「お探しします」返信 → Chrome拡張 → AIX【物件ピックアップした】",
  property_recommendation: "1件に絞って AIX【物件オススメ】",
  estimate_sheet:          "AIX【見積書送る】",
  viewing_invite:          "AIX【内覧日調整】で候補日を送る",
  meeting_place:           "AIX【待ち合わせ】",
  greeting_viewing:        "AIX【内覧挨拶】",
  condition_hearing:       "AIX【条件ヒアリング】",
  application_push:        "AIX【申込へ！】",
  followup_revive:         "AIX【追客する】で再接触",
  property_search:         "Chrome拡張で検索 → AIX【物件ピックアップした】",
};

// check_pattern → topic の簡易マップ（brain の check_pattern から topic を引くため）
const CHECK_PATTERN_TOPICS: Record<string, string> = {
  nearby_parking:    "近隣月極駐車場",
  mgmt_initial_cost: "初期費用・礼金等の交渉",
  mgmt_guarantor:    "保証会社・保証人",
  mgmt_pet:          "ペット可否",
  vacate_date:       "退去予定日",
  mgmt_move_in:      "入居可能日",
  mgmt_parking:      "駐車場",
  mgmt_equipment:    "設備",
};

/** LINE通知用の短縮アクションノート（最大1行）を生成する。 */
export function buildAixLineNote(action: string, checkPattern?: string | null): string {
  if (action === "property_check_result" && checkPattern) {
    const topic = CHECK_PATTERN_TOPICS[checkPattern] ?? checkPattern;
    return `回答を AIX【確認した（条件・交渉）】で送る（${topic}）`;
  }
  return AIX_LINE_NOTES[action] ?? `AIX【${AIX_BUTTON_LABELS[action] ?? action}】`;
}

// ─── LLM出力の正規化: 生文字列 → 正準ボタンキー ────────────────────────────────
// brain の parsed.aix / parsed.action は語彙外の文字列（"acknowledge_result"・日本語ラベル・
// 「AIX【見積書送る】で〜」等の自由記述）を返すことがある。既知ボタンへ写像できる場合は
// 正準キーに正規化し、「action=""＋フリーテキストnote」でボタン特定不能になるケースを減らす。
const AIX_ACTION_ALIASES: Record<string, string> = {
  acknowledge_result: "property_check_result", // UI幽霊タイプ（API上は property_check_result + check_pattern）
  property_check:     "property_check_result",
  check_result:       "property_check_result",
  estimate:           "estimate_sheet",
  estimate_send:      "estimate_sheet",
  alternative_send:   "property_send",
  property_pickup:    "property_send",
  viewing:            "viewing_invite",
  viewing_adjust:     "viewing_invite",
  application:        "application_push",
  followup:           "followup_revive",
  follow_up:          "followup_revive",
  greeting:           "greeting_viewing",
};

export function normalizeAixActionKey(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (AIX_STAFF_NOTES[s]) return s;
  const lower = s.toLowerCase();
  if (AIX_STAFF_NOTES[lower]) return lower;
  if (AIX_ACTION_ALIASES[lower]) return AIX_ACTION_ALIASES[lower];
  // 日本語ラベル・自由記述からの推定（「見積書送る」「内覧日調整」等がテキスト内に含まれる場合）
  if (s.includes("確認した（条件・交渉）") || s.includes("条件・交渉")) return "property_check_result";
  for (const [key, label] of Object.entries(AIX_BUTTON_LABELS)) {
    if (s.includes(label)) return key;
  }
  for (const [alias, key] of Object.entries(AIX_ACTION_ALIASES)) {
    if (lower.includes(alias)) return key;
  }
  return null;
}
