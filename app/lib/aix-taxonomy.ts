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
import { PROXY_CONTRACT_RE } from "./scene-patterns";

export const AIX_BUTTON_TAXONOMY = {
  property_check_result: {
    label: "物件確認した（募集状況）",
    // UI親ボタン「確認した（条件・交渉）」→ property_check_result + check_pattern で送信される
    sub_buttons: {
      "確認した（条件・交渉）": [
        "mgmt_proxy",        // 管理会社: 代理契約の可否（2026-09-16 竹内・カイナ事例）
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
  "空室・退去日・入居可能日・代理契約の可否・保証会社・初期費用交渉・駐車場・ペット可否など、管理会社・代表・オーナー・近隣月極への確認結果を報告する（check_patternで切替）";

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
  // 2026-09-12 竹内（あや事例）: 費用の安さを不審に思われた・聞かれた時の説明（仕組み＋この物件の具体額）
  cost_explain:            "初期費用を説明",
  // 2026-09-15 竹内（ゆうこ事例）: 初期費用の中身の質問（家賃だけで入居できるか・何が含まれるか）に御見積書の内訳で答える
  cost_breakdown:          "初期費用について",
  // 2026-09-15 竹内（H 事例）: お客様が電話で話したい → LINEコールの「電話をかける」ボタン＋案内文／電話の後のまとめ
  phone_call:              "電話をかける",
  phone_followup:          "電話終了後",
  // 2026-09-15 竹内（YUYA 事例）: 物件ごとの保証会社名と種類（独立系／LICC系／信販系）を一覧で案内し、かぶらない保証会社なら並行審査を勧める
  guarantor_info:          "保証会社について",
};

// ボタンキー → スタッフ向けアナウンス（「AIX【ボタン名】を押してください: 理由・タイミング」形式）。
// 曖昧な「AIXボタンを使ってください」ではなく、①どのボタンか ②なぜこのボタンか ③いつ押すか を1文で伝える。
export const AIX_STAFF_NOTES: Record<string, string> = {
  acknowledge_check:       "AIX【確認します】を押してください: お客様が物件の空室・募集状況の確認を求めています。受付宣言の返信を送った後、このボタンで管理会社への空室確認＋見積書依頼を生成します（宛先は管理会社。お客様ではありません）",
  property_check_result:   "管理会社・オーナー・近隣月極から回答が届いた場面です → 空室・募集状況の回答ならAIX【物件確認した（募集状況）】、保証会社・初期費用交渉・駐車場・ペット可否・退去日・入居可能日など条件・交渉系の回答ならAIX【確認した（条件・交渉）】を押してください: 回答内容を顧客への結果報告文に変換します（結果報告の手打ちはNG）",
  // 2026-09-23 S8 の実測: 「まず「お探しします」の旨を返信し」がブレインの方向に写り、未履行の宣言の後の短い了承にも同じ約束の3通目を書かせていた
  //   （実送信 S8: 返信なし24.3%／物件カード56.8%／再宣言5.4%）。宣言は最初の1回だけと明記する
  property_send:           "AIX【物件ピックアップした】を押してください: お客様が条件を伝えた/変更した場面です。まだ宣言していなければ「お探しします」の旨を返信し（既に宣言済みで未送付なら再宣言せず、物件そのものを送る）、Chrome拡張で検索して物件URLが揃ったらこのボタンでカバーメッセージを生成して一緒に送ります",
  property_recommendation: "AIX【物件オススメ】を押してください: 同棟別号室の依頼・「初期費用を抑えたい」等、条件に最も合う1件に絞って再提案する場面です。1件に絞った詳細訴求文を生成します",
  estimate_sheet:          "AIX【見積書送る】を押してください: お客様が初期費用・見積を質問しています（最ホット・即対応対象）。見積書画像を読み取って自動計算＋カバーメッセージを生成します（金額の手打ち・AI生成はNG）",
  viewing_invite:          "AIX【内覧日調整】を押してください: お客様が内覧希望を表明しています。内覧候補日時の提示はこのボタン専用（候補日時の手打ち・AI生成は禁止）。日程を選択して内覧案内を送信します",
  meeting_place:           "AIX【待ち合わせ】を押してください: 内覧の日時・物件が確定した場面です。物件住所入りの待ち合わせ確定メッセージを生成します",
  greeting_viewing:        "AIX【内覧挨拶】を押してください: 内覧当日・前後の挨拶/フォローの場面です。シーンに合わせたフォローメッセージを生成します",
  condition_hearing:       "AIX【条件ヒアリング】を押してください: 希望条件がまだ揃っていない場面です。既知情報をスキップして未取得の条件だけ質問する形式で送れます",
  application_push:        "AIX【申込へ！】を押してください: 内覧後にお客様が前向きな場面、またはお客様が自分から申込の意思を示した場面です（退去予定/入居中物件の先押さえもこのボタン。見積書送付後の前向き反応だけでは内覧のご案内が先）。クロージングメッセージを生成して申込へ誘導します",
  followup_revive:         "AIX【追客する】を押してください: お客様からの返信が3日以上止まっています。再接触メッセージを生成します",
  property_search:         "Chrome拡張ツール（リアプロ/itandi/レインズ）で物件を検索してください: お客様の条件に合う物件を探す場面です（送付済み物件は候補から除外）。URLが揃ったらAIX【物件ピックアップした】で送付します",
  cost_explain:            "AIX【初期費用を説明】を押してください: お客様が費用の安さを不審に思っている・安い理由を聞いています（「仲介手数料無しで大丈夫？」「安いのには理由が？」「他社は31万と言われた」）。貸主からの報酬と還元額を入力すると、仕組み（広告料の還元。仲介手数料はスモラ＝一律2,980円／イエヤス・ギガ＝0円）とこの物件の具体額を1通で説明します。金額が要らない時は「仕組みを説明（金額なし）」で作れます（金額の手打ち・AI生成はNG）",
  cost_breakdown:          "AIX【初期費用について】を押してください: お客様が初期費用の中身を聞いています（「家賃だけ払ったら住めるんですか？」「初期費用に何が含まれますか？」「火災保険は別ですか？」）。御見積書の画像を貼り付けて「会話を合わせる」を押すと、御見積書の内訳（項目と金額）でご質問に答える1通を作ります（見積書を見ずに本文で費用の中身を説明するのはNG）",
  phone_call:              "AIX【電話する → 電話をかける】を押してください: お客様が電話で話したい・相談したいと言っています（「お電話では無理でしょうか？」「電話いける時間ありますか？」）。「電話をかける」ボタン（LINEコール）と案内文を送ると、お客様がボタンから公式LINEに電話できます。電話の後は AIX【電話する → 電話終了後】で話した内容をまとめて送ります",
  phone_followup:          "AIX【電話する → 電話終了後】を押してください: お客様との電話が終わった場面です。電話でお話しした内容を入れると、お礼とまとめ（決まったこと・こちらがすること・お客様にお願いすること）の1通を作ります",
  guarantor_info:          "AIX【保証会社について】を押してください: お客様が審査・保証会社の不安を出した／保証会社を尋ねた／複数物件の保証会社を伝える場面で、管理会社に保証会社を確認した後に押します。物件ごとに①物件名②保証会社名③種類（独立系・LICC系・信販系）を入れて「文面を作る」か「会話を合わせる」を押すと、保証会社一覧と審査の通りやすさ（独立系＝審査基準が緩い）を1通で案内します。「並行して審査かける」ONで、保証会社がかぶっていない物件の並行審査を勧める文が入ります（会社名・種類は入力値のみ・審査通過の断言はしない）",
};

// ─── brain action → 顧客向け返信方向性（A-7 / 2026-09-08 Fable5）──────────────────
// generate-reply の brainGuidanceNote は従来 AIX_STAFF_NOTES（スタッフ操作文「AIX【〇〇】を押してください」）を
// 「推奨アクション」として LLM に二重注入していた。LLM が書くのは顧客向け本文なので、
// action ごとに「顧客向けの方向性 / WE DO 1文 / 禁止」を定義してこちらを注入する。
export type AixActionReplyDirection = { direction: string; weDo: string; forbid: string };
export const AIX_ACTION_REPLY_DIRECTION: Record<string, AixActionReplyDirection> = {
  acknowledge_check:       { direction: "お客様が示した物件の募集状況を確認する受付宣言のみで完結", weDo: "お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", forbid: "空室有無・退去日・入居可能日の断言／内覧誘導／申込誘導" },
  property_check_result:   { direction: "管理会社確認の結果報告（AIX送信済みの結果を踏まえ、お客様の反応に直接答える）", weDo: "お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます！！", forbid: "「これから確認します」の再宣言／未確認事実の創作" },
  // 2026-09-09 Fable5 往復文脈: 顧客が直前提案に懸念・持込予告を返した場合は reply-context.ts PAIR_MATRIX（override_wait）が本 direction より先に確定する
  property_send:           { direction: "条件受領→ピックアップ宣言（実物件はAIXで送付するため本文に物件名・家賃を書かない）。顧客が直前提案に懸念を返した場合は懸念→条件変換→再ピックアップ宣言", weDo: "〇〇周辺全域から〇〇さんにオススメできるお部屋ピックアップしお送りさせて頂きます！！", forbid: "物件名・家賃・間取りの初出提示／見積・申込誘導／条件の聞き返し／直前送付物への反応に答えずピックアップ宣言のみで終える" },
  property_recommendation: { direction: "1件に絞った再提案はAIXで行うため、本文は受付＋オススメ1件を送る宣言のみ。ただし顧客が別物件の持込を予告している場合は『お送り頂けましたら募集状況確認し御見積書とあわせてご連絡』に差替", weDo: "〇〇さんに特にオススメできるお部屋を1件に絞ってお送りさせて頂きます！！", forbid: "物件名・家賃の初出提示／複数物件の羅列／持込予告中の1件推し宣言" },
  // 2026-09-12 竹内（あや事例）: 見積書の後の総額確認にも使う（追加分を反映した御見積書を送り直す）。本文で総額を断言しない
  estimate_sheet:          { direction: "見積書の作成宣言のみ（金額・内訳はAIX見積書で送る）", weDo: "最大限割引させて頂いた初期費用の御見積書作成しお送りさせて頂きます！！", forbid: "金額・内訳・割引額の生成／総額の確認・断言（「〜円でお間違いございません」「〜円になります」）／「ご査収ください」等の添付済み文" },
  // 2026-09-23 S5 の実測（内覧の日程調整・生成12通）: weDo の疑問形「ご都合よろしいお日にち御座いますでしょうか」を候補日時なしで写す回が 25%。
  //   実送信でこの語形は 46通全部が日時とセット（AIX【内覧日調整】専用）・「ご都合だけ」は 7.0%。手打ちの受けは宣言形
  //   「〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」（実物 09-06・成約側）→ weDo を宣言形に置き換える
  //   （final-check VIEWING_DATE_ASK_WITHOUT_AIX の置換先と同じ [Y] 型）
  //   ⚠ 反証（2026-09-23）: 条件節なし・疑問形なしの裸型「〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます」は final-check V3
  //     （GOCHOUGO_NO_CONDITION）と line-reply-prompts 5か所の禁止に当たり、修正ループで往復する。実送信の裏付けも 2/123（1.6%）。
  //     → viewingOfferLiteral と同じ条件節付き（「よろしければ〜」）にする。疑問形の禁止（forbid）はそのまま
  viewing_invite:          { direction: "内覧希望の受付のみ（候補日時と「ご都合よろしいお日にち御座いますでしょうか」の確認はAIX内覧日調整で送る）", weDo: "かしこまりました！！よろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます！！", forbid: "具体的な候補日時・2択日程／「ご都合よろしいお日にち御座いますでしょうか」の疑問形（実送信では日時とセットの時だけ）／申込誘導／募集未確認物件への内覧確約" },
  meeting_place:           { direction: "内覧確定の受付（住所・集合場所・時間はAIX待ち合わせで送る）", weDo: "内覧の詳細についてはご連絡させて頂きます！！", forbid: "住所・集合場所・集合時間の記載" },
  greeting_viewing:        { direction: "内覧当日・前後の短い挨拶（40〜80字）", weDo: "本日何卒よろしくお願い致します！！", forbid: "感想ヒアリング／別物件提案／長文" },
  condition_hearing:       { direction: "未取得条件の確認（フォーム本体はAIXで送る）", weDo: "ご希望条件お聞かせ頂けますと幸いです！！", forbid: "①〜⑧フォーム全文の生成／確認済み条件の聞き返し" },
  application_push:        { direction: "お客様が前向きな場面での申込誘導（希少性煽り禁止・事実ベースの期限のみ）", weDo: "お気に召されましたらお申込みでお部屋押さえさせて頂きます！！", forbid: "「埋まってしまいます」「残り1部屋」等の煽り／書類リストの生成" },
  property_search:         { direction: "条件受領→ピックアップ宣言", weDo: "〇〇周辺全域から〇〇さんにオススメできるお部屋ピックアップしお送りさせて頂きます！！", forbid: "物件名・家賃の初出提示／条件の聞き返し" },
  // 説明本体（仕組み＋貸主からの報酬・還元額）は AIX【初期費用を説明】で送る。本文で金額・報酬額を作らない
  cost_explain:            { direction: "費用の安さへの不安・疑問への説明（仕組みと具体額はAIX初期費用を説明で送る）", weDo: "ご質問ありがとうございます😊！！", forbid: "貸主からの報酬額・還元額・割引額の生成／「見積書を作成しお送りします」の宣言（見積書は送付済み）" },
  // 2026-09-15 竹内（ゆうこ事例）「AIX から送る費用についての項目となるから適当なこと言わないため」:
  // 初期費用の中身（含まれる項目・家賃だけで入居できるか）は AIX【初期費用について】で御見積書の内訳を使って送る。本文では説明しない
  cost_breakdown:          { direction: "初期費用の中身のご質問への受付（内訳の説明はAIX初期費用についてで御見積書をもとに送る）", weDo: "ご質問ありがとうございます😊！！", forbid: "敷金・礼金・保証料・火災保険・鍵交換・日割家賃など初期費用に含まれる項目の説明／「家賃（・管理費）だけでは入居出来ない・出来る」の断言／金額" },
  // 2026-09-15 竹内（H 事例）: 電話のご依頼には「電話をかける」ボタン（LINEコール）と案内文を AIX で送る。本文で電話番号・折り返しの時刻を作らない
  phone_call:              { direction: "お電話のご依頼への受付（電話をかけるボタンと案内文はAIX電話をかけるで送る）", weDo: "お電話大丈夫です😊！！", forbid: "電話番号の記載／「こちらからお電話します」「〇時にお電話します」等の折り返しの約束・時刻／電話を断る文" },
  phone_followup:          { direction: "電話でお話しした内容のまとめ（AIX電話終了後でスタッフのメモから送る）", weDo: "お電話有難うございました😊！！", forbid: "電話で話していない内容・金額・日付の創作" },
  // 2026-09-15 竹内（YUYA 事例）: 保証会社名・審査基準の緩さ・並行審査の勧めは AIX【保証会社について】で送る。本文で保証会社名・「審査緩い」を作らない
  guarantor_info:          { direction: "審査・保証会社のご質問の受付（保証会社名・種類・並行審査の案内はAIX保証会社についてで送る）", weDo: "保証会社確認させて頂きます😊！！", forbid: "保証会社名の記載／審査の通りやすさ・通過の断言／並行審査の提案" },
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
  // 2026-09-16 竹内（カイナ事例）: 代理契約の可否は保証会社・審査より先に見る（「親御様連帯保証人…代理契約可能」は代理契約が主題）
  { pattern: "mgmt_proxy",        topic: "代理契約の可否",         re: PROXY_CONTRACT_RE },
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

// 2026-09-12 段2: check_pattern の値（場面の証拠 S2/S3 が出した mgmt_move_in / vacate_date / mgmt_guarantor 等）から
// detectPropertyCheckPattern と同じ形の PropertyCheckKind を作る（ブレインの note を同じ文面にするため）
// 2026-09-17 竹内（a🤫 事例）「この場合 AIX の物件確認したの室内写真を確認したのところから送る形となる」:
//   「物件確認した（募集状況）」側のサブパターン。ui_button も note も条件・交渉系とは別なので表で持つ。
//   9/17 18:17「この物件のいちばん広い部屋ありますか？」→ 実送信は [間取り図]＋「1番広いお部屋（65.02）の間取りとなります！！」
// 2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形」: 「別の部屋」限定から
//   室内の写真・動画・URL の依頼まで一般化（実データ365日・検出28通: スタッフは室内イメージURL／画像 13・撮影 2・理由付き 2）
const AVAILABILITY_CHECK_KINDS: Record<string, { topic: string; note: string }> = {
  interior_photo: {
    topic: "室内の写真・動画・URL／別の部屋・間取り",
    note: "AIX【物件確認した】→「室内写真を確認した」を押してください: お客様が室内の写真・動画・室内イメージURL を頼んだ、またはこちらの送った物件の別の部屋・間取りを聞いています。管理会社への空室確認ではなく、手元の写真・室内イメージURL・間取り図を物件名とあわせてピッカーから送る場面です（手元に無い時に撮影して送るか・建築中等の理由を返すかはスタッフが決める。本文で写真の有無を断定しない）",
  },
};

/** 「物件確認した（募集状況）」側のサブパターン（ピッカー）の表示名。AIX要対応・ブレインのカード・流れの文で同じ語にする（四者同名） */
export const AVAILABILITY_CHECK_PICKER_LABELS: Record<string, string> = {
  interior_photo: "室内写真を確認した",
};

/** 押すボタンの表記の中身（例: 物件確認した→室内写真を確認した）。条件・交渉系は null（呼び出し側が従来の表記にする） */
export function availabilityCheckButtonLabel(checkPattern: string | null | undefined): string | null {
  const l = checkPattern ? AVAILABILITY_CHECK_PICKER_LABELS[checkPattern] : undefined;
  return l ? `物件確認した→${l}` : null;
}

export function propertyCheckKindFor(pattern: string | null | undefined): PropertyCheckKind | null {
  const avail = pattern ? AVAILABILITY_CHECK_KINDS[pattern] : undefined;
  if (avail) {
    return { check_pattern: pattern as string, ui_button: "物件確認した（募集状況）", topic: avail.topic, note: avail.note };
  }
  const d = CHECK_PATTERN_DETECTORS.find((x) => x.pattern === pattern);
  if (!d) return null;
  return {
    check_pattern: d.pattern,
    ui_button: "確認した（条件・交渉）",
    topic: d.topic,
    note: `AIX【確認した（条件・交渉）】を押してください: ${d.topic}の確認結果を顧客への報告文に変換する場面です（サブパターン: ${d.pattern}。結果報告の手打ちはNG）`,
  };
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
  cost_explain:            "初期費用の説明",
  cost_breakdown:          "初期費用について",
  phone_call:              "電話のご依頼",
  phone_followup:          "電話後のまとめ",
  guarantor_info:          "保証会社の案内",
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
  cost_explain:            "貸主からの報酬を入力 → AIX【初期費用を説明】",
  cost_breakdown:          "御見積書の画像を貼り付け → AIX【初期費用について】",
  phone_call:              "AIX【電話する → 電話をかける】でボタンと案内文を送る",
  phone_followup:          "話した内容を入れて AIX【電話する → 電話終了後】",
  guarantor_info:          "物件ごとの保証会社名・種類を入れて AIX【保証会社について】",
};

// check_pattern → topic の簡易マップ（brain の check_pattern から topic を引くため）
const CHECK_PATTERN_TOPICS: Record<string, string> = {
  nearby_parking:    "近隣月極駐車場",
  mgmt_proxy:        "代理契約の可否",
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
  // 2026-09-23: 室内写真は「確認した（条件・交渉）」ではなく「物件確認した→室内写真を確認した」（誤表記で売上番長グループに出ていた）
  if (action === "property_check_result" && availabilityCheckButtonLabel(checkPattern)) {
    return `手元の写真・室内イメージURL を AIX【${availabilityCheckButtonLabel(checkPattern)}】で送る`;
  }
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
  cost_explanation:   "cost_explain",
  initial_cost_explain: "cost_explain",
  initial_cost_breakdown: "cost_breakdown",
  initial_cost_about: "cost_breakdown",
  cost_composition:   "cost_breakdown",
  call_request:       "phone_call",
  line_call:          "phone_call",
  phone_request:      "phone_call",
  call_followup:      "phone_followup",
  phone_after:        "phone_followup",
  guarantor_company:  "guarantor_info",
  guarantor_list:     "guarantor_info",
  guarantor_about:    "guarantor_info",
  guarantor_explain:  "guarantor_info",
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
