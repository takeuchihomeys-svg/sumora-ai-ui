// app/lib/aix-confirm-items.ts — ピッカーごとの「確認事項」（スタッフが管理会社・元付・オーナー・現地で確かめる事）の一覧（純関数・DB も LLM も持たない）
//
// 2026-10-22 竹内さんの決定（55575458）「それぞれのピッカーでの確認事項で足りないボタンなども見つけ出していく。そして強化していく」／
//   （d04ed51b）「竹内も AIX で送れていない所がある。ボタンとピッカーの意味が分かれば、どこの AIX のどのピッカーから送れば一番良いのか分かる」。
//   ①ピッカーごとに確認事項を並べる（AIX のブレイン・ブレインのカタログが読む言葉）
//   ②竹内さんの手打ちの「確認した結果」の文を、どのピッカーで送る物か当てはめる（topicsOf）→ どこにも当たらない確認事項＝足りないピッカーの候補
//      （scripts/audit-aix-missing-pickers.ts が数えて owner_questions に質問として足す・判断は竹内さん）
// 語の網は「候補を拾う」だけ（P0 9eb6aa9c: 判断はブレイン・竹内さん）。

export type ConfirmItem = {
  /** aix-catalog の鍵（ボタン／ピッカーの値） */
  key: string;
  button: string;
  picker: string;
  /** 確認事項（スタッフが確かめる事） */
  items: string[];
  /** 手打ちの確認の結果の文にこの話題があるか（候補の網） */
  re: RegExp;
};

export const AIX_CONFIRM_ITEMS: ConfirmItem[] = [
  { key: "property_check_result/available", button: "物件確認した（募集状況）", picker: "物件あった／物件なかった／別の部屋が募集してた／専任物件だった", items: ["募集中か・募集終了か", "申込が入っているか", "同じ建物の別の部屋・別の間取りの募集", "専任（弊社で紹介できない）か"], re: /募集|空き(?:状況|が|は)|空室|満室|埋ま|申込(?:み)?(?:が)?入|成約|専任|ご紹介(?:が)?(?:出来|でき)/ },
  { key: "property_check_result/vacate_date", button: "確認した（条件・交渉）", picker: "退去予定日について", items: ["退去予定日", "退去後の内覧開始日"], re: /退去(?:予定)?日|退去予定|退去(?:後|され)/ },
  { key: "property_check_result/mgmt_move_in", button: "確認した（条件・交渉）", picker: "入居日について／入居日確認した", items: ["入居可能日", "希望の入居日で入れるか"], re: /入居(?:可能)?日|入居(?:時期|可能)|(?:から|より)(?:ご)?入居/ },
  { key: "property_check_result/interior_photo", button: "物件確認した", picker: "室内写真を確認した", items: ["室内の写真・動画・室内イメージ URL", "現地で撮影した写真・動画"], re: /室内(?:写真|画像|動画|イメージ)|写真|動画/ },
  { key: "property_check_result/other_room_check", button: "物件確認した", picker: "別の部屋について確認した", items: ["同じ建物の別の部屋・別の間取りの有無"], re: /(?:別|他|ほか)の(?:お)?部屋|別の間取り/ },
  { key: "property_check_result/room_vacancies", button: "物件について", picker: "募集号室について", items: ["建物の募集中の号室・部屋数・間取り・家賃"], re: /何部屋|部屋数|号室.{0,8}募集|募集(?:中)?の号室/ },
  { key: "property_check_result/mgmt_initial_cost", button: "確認した（条件・交渉）", picker: "初期費用について", items: ["礼金・消臭代・鍵交換等を外せるか（交渉の結果）"], re: /礼金|消臭|鍵交換|抗菌|初期費用.{0,8}(?:交渉|外|減額|下が|お安く|なし)/ },
  { key: "property_check_result/mgmt_proxy", button: "確認した（条件・交渉）", picker: "代理契約について", items: ["代理契約の可否"], re: /代理(?:契約|で)/ },
  { key: "property_check_result/mgmt_lifeline", button: "確認した（条件・交渉）", picker: "ライフラインについて", items: ["電気・ガス・水道の指定の有無と連絡先"], re: /ライフライン|電気|ガス(?!コンロ)|水道/ },
  { key: "property_check_result/mgmt_two_person", button: "確認した（条件・交渉）", picker: "二人入居について", items: ["二人入居の可否"], re: /二人入居|2人入居|ふたり入居|同棲|ルームシェア|二人暮らし/ },
  { key: "property_check_result/mgmt_guarantor", button: "審査について", picker: "保証会社について（審査面）", items: ["保証会社・保証人・審査の条件"], re: /保証会社|保証人|連帯保証/ },
  { key: "property_check_result/mgmt_screening", button: "審査について", picker: "審査について（ご相談）", items: ["名義・保証人・職業と収入・国籍・審査の見込み・時期"], re: /審査|名義|職業|国籍|外国籍|収入/ },
  { key: "property_check_result/mgmt_application_status", button: "確認した（条件・交渉）", picker: "申込状況について", items: ["申込の有無・何番手・何人待ち・1番手の審査の状況"], re: /何番手|番手|何人待ち|申込(?:み)?(?:状況|の有無)/ },
  { key: "property_check_result/mgmt_company", button: "確認した（条件・交渉）", picker: "管理会社について", items: ["管理会社の名前・連絡先"], re: /管理会社(?:名|は|の名前|の連絡先)/ },
  { key: "property_check_result/mgmt_parking", button: "確認した（条件・交渉）", picker: "駐車場について", items: ["駐車場・バイク置き場の有無・料金・空き"], re: /駐車場|バイク|駐輪/ },
  { key: "property_check_result/mgmt_pet", button: "確認した（条件・交渉）", picker: "ペット飼育について", items: ["ペットの可否・条件（種類・頭数・敷金の加算）"], re: /ペット|猫|犬|小型犬|飼育/ },
  { key: "property_check_result/mgmt_equipment", button: "確認した（条件・交渉）", picker: "設備について", items: ["設備の有無（エアコン・洗濯機置場・インターネット 等）"], re: /設備|エアコン|洗濯機|インターネット|ネット(?:回線|無料)|wi-?fi|宅配ボックス|オートロック|浴室乾燥|追い焚き|独立洗面|コンロ|照明|カーテン|収納|網戸|モニター/i },
  { key: "property_check_result/mgmt_contract_terms", button: "確認した（条件・交渉）", picker: "契約の条件について", items: ["短期解約の違約金・退去時のクリーニング代・フリーレント"], re: /違約金|短期解約|クリーニング|フリーレント/ },
  { key: "property_check_result/mgmt_rent_negotiation", button: "確認した（条件・交渉）", picker: "家賃の交渉について", items: ["家賃の値下げの交渉の結果"], re: /家賃.{0,8}(?:交渉|下が|値下|お安く)|値下げ/ },
  { key: "property_check_result/mgmt_surroundings", button: "確認した（条件・交渉）", picker: "周辺の様子について", items: ["日当たり・音・周辺の様子（現地・管理会社）"], re: /日当たり|騒音|音(?:が|は|の)|周辺の様子|治安|眺望/ },
  { key: "property_check_result/nearby_parking", button: "確認した（条件・交渉）", picker: "近隣の月極駐車場を確認した", items: ["近くの月極駐車場（名前・距離・料金・空き）"], re: /月極|近隣.{0,4}駐車/ },
  { key: "property_check_result/owner_other", button: "確認した（条件・交渉）", picker: "オーナーに確認した→その他", items: ["オーナーに確認した内容と結果"], re: /オーナー|大家/ },
  { key: "viewing_invite", button: "内覧日調整", picker: "内覧確定！／退去予定物件／日程変更", items: ["内覧できる日時（スタッフの予定・管理会社の鍵の手配）"], re: /内覧|内見|ご案内(?:可能|出来|でき)/ },
  { key: "meeting_place", button: "待ち合わせ", picker: "固定", items: ["待ち合わせの日時・場所"], re: /待ち合わせ|現地集合|現地に/ },
  { key: "estimate_sheet", button: "見積書送る", picker: "1件／複数件", items: ["初期費用の金額（最大限割引）"], re: /見積|初期費用.{0,12}円/ },
];

/**
 * ピッカーの無い確認事項の候補（竹内さんの手打ちで見つかったら質問にする話題の網）。
 * 当たっても、上のどのピッカーにも当たらない時だけ「足りないピッカーの候補」に数える。
 */
export const UNCOVERED_TOPICS: Array<{ topic: string; re: RegExp; /** 物件ごとに管理会社・貸主で確かめる事（スタッフだけが知る＝AIX の番になり得る） */ staffFact?: boolean }> = [
  { topic: "鍵の受け取り・鍵渡し", re: /鍵(?:の)?(?:受け取り|受取|お渡し|渡し)|鍵渡し/, staffFact: true },
  { topic: "契約日・契約の方法（電子契約・来店）", re: /契約日|電子契約|ご契約(?:の)?(?:日|方法|手続き)|重説|重要事項説明/ },
  { topic: "初期費用の支払い（期限・振込・カード）", re: /(?:お)?振込|支払(?:い)?期限|お支払い|カード(?:払い|決済)|分割/ },
  { topic: "火災保険（物件ごとの費用・指定）", re: /火災保険/, staffFact: true },
  { topic: "家具家電・備品", re: /家具(?:家電)?付|家電付|備え付け|冷蔵庫|洗濯機付/, staffFact: true },
  { topic: "楽器・事務所利用・法人契約", re: /楽器|ピアノ|事務所(?:利用|使用)|SOHO|法人(?:契約|名義)/i, staffFact: true },
  { topic: "喫煙", re: /喫煙|タバコ|たばこ/, staffFact: true },
  { topic: "更新料・解約予告（物件ごと）", re: /更新料|更新(?:の)?(?:費用|手数料)|解約予告|退去予告/, staffFact: true },
  { topic: "リフォーム・内装の予定", re: /リフォーム(?:予定|中|後)|内装(?:工事)?(?:予定|中)|クロス(?:張替|の張替)/, staffFact: true },
  { topic: "ゴミ出し・共用部", re: /ゴミ|ごみ|共用部|エレベーター/ },
  { topic: "入居審査の書類（必要書類）", re: /必要書類|書類|住民票|源泉|在籍証明/ },
];

export function confirmTopicsOf(text: string): string[] {
  const t = String(text ?? "").normalize("NFKC");
  return AIX_CONFIRM_ITEMS.filter((c) => c.re.test(t)).map((c) => c.key);
}
export function uncoveredTopicsOf(text: string): string[] {
  const t = String(text ?? "").normalize("NFKC");
  return UNCOVERED_TOPICS.filter((u) => u.re.test(t)).map((u) => u.topic);
}

/** 物件ごとの事実を言い切る文の終わり（手打ちで管理会社に確かめた事を伝えている形）*/
export const STAFF_FACT_END_RE = /となります|となっております|必要(?:となります|です)|可能(?:です|となります)|不可|出来ません|できません|との(?:事|こと)/;

/** 確かめた事の報告の文（手打ちの中で AIX の番になり得る文）。約束（確認させて頂きます）は数えない */
export const CONFIRM_REPORT_RE = /(?:確認|交渉|問い合わせ|お問い合わせ)(?:させて(?:頂|いただ)|致し|いたし|し)(?:きました|ました|た(?:ところ|所|のですが|結果))|確認(?:が)?取れ|(?:管理会社|オーナー|大家|元付|貸主)(?:様|側|さん|担当)?(?:より|から)(?:回答|ご回答|ご連絡|連絡|返答|お返事)|との(?:事|こと)(?:でした|です|となります)|とのご回答|ご回答(?:頂|いただ)き|回答(?:が)?(?:ありました|来ました|届き)|現地で(?:確認|撮影|見)/;

/** 文に分ける（改行と句点・！！） */
export function reportSentencesOf(text: string): string[] {
  return String(text ?? "").split(/\n+|(?<=[。！!？?])/).map((s) => s.trim()).filter((s) => s.length >= 6 && CONFIRM_REPORT_RE.test(s.normalize("NFKC")));
}

/** ピッカーごとの確認事項を1行ずつ（ブレイン・人が読む表） */
export function renderConfirmItems(): string {
  return AIX_CONFIRM_ITEMS.map((c) => `- ${c.button}→${c.picker}（${c.key}）: ${c.items.join("・")}`).join("\n");
}
