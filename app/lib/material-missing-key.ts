// app/lib/material-missing-key.ts — ブレインの自己申告「判断に要ったのに材料に無かった物」（material_missing）の自由な名前を、決まった鍵に寄せる（純関数）
//
// 2026-11-11 作業員1（統括役の A1・弱い所 326・KB P0 ca55d42b「外れの原因3つ」の1番＝材料が届いていない）:
//   brain_unknowns の material_missing は14日で 573回・名前が 437種類に割れていた（「送れる物件の候補」の書き方だけで十数通り）＝数えられず直せない。
//   437個の label を全部読んで、意味の同じ物を17の鍵に寄せた。鍵ごとに「誰が持っている事か」（side）を付ける:
//     staff    … スタッフしか知らない事（管理会社の回答・今の募集状況・審査・見積の金額・スタッフの予定・撮影）＝AIX／約束の番の印（P0 ca55d42b）
//     system   … システムが持っているのに届いていない事（売上サポの候補・送った物件の記録・物件資料・持ち込みの読み取り・会話の記録）＝材料の配線を直す
//     customer … お客様に聞く事（条件・感想・意向）＝聞き取りの番
//     knowledge… 会社の決まり・手順の知識＝会社の事実・KB
//   並びの順に当てる（上ほど強い）。どれにも当たらない物は other（鍵は残す・毎週の表で読む）。
//   判断・材料には使わない（数えて、直す順を決めるためだけ）。

export type MaterialSide = "staff" | "system" | "customer" | "knowledge" | "other";
export type MaterialKey =
  | "screening_status" | "viewing_slot" | "sendable_candidates" | "sent_property_status" | "estimate_amount"
  | "mgmt_answer" | "vacancy_status" | "guarantor_company" | "room_photos" | "brought_property_detail"
  | "move_in_date" | "company_knowledge" | "property_doc" | "viewing_record" | "conversation_context"
  | "customer_conditions" | "customer_feedback" | "other";

export const MATERIAL_KEY_SIDE: Record<MaterialKey, MaterialSide> = {
  screening_status: "staff", viewing_slot: "staff", estimate_amount: "staff", mgmt_answer: "staff", vacancy_status: "staff", room_photos: "staff",
  sendable_candidates: "system", sent_property_status: "system", guarantor_company: "system", brought_property_detail: "system",
  move_in_date: "system", property_doc: "system", viewing_record: "system", conversation_context: "system",
  company_knowledge: "knowledge", customer_conditions: "customer", customer_feedback: "customer", other: "other",
};

export const MATERIAL_KEY_JA: Record<MaterialKey, string> = {
  screening_status: "審査の状況・番手", viewing_slot: "内覧できる日時・スタッフの空き", sendable_candidates: "送れる物件の候補",
  sent_property_status: "送った物件の現況", estimate_amount: "見積の金額・初期費用", mgmt_answer: "管理会社の回答・可否",
  vacancy_status: "募集状況（確認の結果）", guarantor_company: "保証会社の名前・種類", room_photos: "撮影した室内写真",
  brought_property_detail: "持ち込みの物件の中身（物件名・家賃）", move_in_date: "入居可能日・入居時期（資料）", company_knowledge: "会社の見解・手順の知識",
  property_doc: "物件資料の項目（設備・条件・住所）", viewing_record: "内覧の記録（待ち合わせ・予定の物件）", conversation_context: "会話・記録の文脈（どの物件か・経緯）",
  customer_conditions: "お客様の条件", customer_feedback: "お客様の感想・意向", other: "その他",
};

// 上ほど強い（最初に当たった鍵）。実物の label（11/11 時点の 437個）で並びを決めた
const RULES: ReadonlyArray<[MaterialKey, RegExp]> = [
  // 申込の後の審査・番手（管理会社の回答待ちの番）
  ["screening_status", /審査(?:状況|の現況|の現状|の進捗|再開|の回答)|審査落ち|番手(?!保証)|申込順位|申込の実施/],
  // スタッフの予定・内覧できる日時（内覧の記録・感想は下）
  ["viewing_slot", /空き(?:時間|日時|枠)|スタッフの|内覧(?:可否|可能|枠|時刻|の候補|の連絡|\d)|内覧可能日|最短内覧|内覧時刻|\d{1,2}[:時]\d{0,2}.{0,4}(?:の可否|内覧)|今日の内覧|明日\d|再内覧/],
  // 会社の知識（手順・見解・アプリ・言葉の意味）。「アプリーレ」等の物件名に当てない
  ["company_knowledge", /見解|向いている時期|入居者アプリ|アプリの|ログイン|意味|手続きの日数|出るタイミング|日割額|日割家賃の入居月|引落日/],
  // 文脈（何のために送ったか・住所の用途）
  ["conversation_context", /意図|用途|目的/],
  // 条件の上限（費用の語があっても見積ではない）
  ["customer_conditions", /(?:初期費用|家賃)上限/],
  // 内覧の記録（待ち合わせの住所・予定の物件）
  ["viewing_record", /待ち合わせ|内覧する物件|内覧の組み直し|内覧の継続|内覧・審査の経緯/],
  // 持ち込み（お客様が送った物件）の今の空き＝確かめる事
  ["vacancy_status", /(?:お客様が送った|お客様持ち込み|持ち込み|持込|送られた物件)[^]*?(?:現況|募集|空き)/],
  ["brought_property_detail", /お客様が送った|お客様持ち込み|送られた物件/],
  // 送った物件の「今の」現況・空き＝確かめて分かる事（送った記録と資料の空きの写しは材料に届いている＝【すでに送付済みの物件】・brain:sent-sheet-vacancy）
  ["vacancy_status", /(?:送った|送付済み?|お送りした|\d+\/\d+送付)[^]*?(?:現況|空き|募集)/],
  // 送った物件の記録（こちらが送った物件の現況・資料・名前）
  ["sent_property_status", /(?:送った|送付済み?|お送りした|\d+\/\d+送付|最初に送った|送付\d)(?!.*(?:見積|初期費用))/],
  // 売上サポの候補・検索の結果（「送れる」「新着」「候補」）
  ["sendable_candidates", /送れる|新着|検索結果|物件の?候補|候補物件|新しい候補|空室候補|新規候補|条件に合う募集中|新しい条件で探した|ペット可物件の有無|物件一覧|物件の具体候補/],
  // 見積・初期費用の金額
  ["estimate_amount", /見積|初期費用|クリーニング代|割引|費用の内訳|アリバイ(?:会社)?の費用/],
  // 管理会社にしか答えられない可否・回答
  ["mgmt_answer", /管理会社|貸主|確認結果|回答|可否|保証人|名義|スライド|アリバイ|鍵交換|郵送|法人契約|敷金の|猶予|印鑑|身分証|本人確認書類|連絡期限|取り扱い$|工事状況|リノベ完成/],
  // 今の募集状況（確かめて分かる物）
  ["vacancy_status", /募集状況|現況|空き状況|空室|空き・|今の空き|申込可否|取り扱い|空き$|空き\b/],
  ["guarantor_company", /保証会社/],
  // 持ち込みの物件（お客様が送った URL・画像・TikTok）の中身
  ["brought_property_detail", /持ち込み|持込|お客様が送った|お客様持ち込み|TikTok|HOMES|homes|URL|送られた物件|画像の物件|動画物件|物件名・所在地|画像の内容|追加\d物件|新規\d件|物件の特定|物件名の確実|物件名$|の物件名/],
  ["room_photos", /写真|動画|室内イメージ/],
  ["move_in_date", /入居可能日|入居日|最短の入居|最短入居|入居開始|退去予定|入居月/],
  // 物件資料にある項目（設備・条件・住所）
  ["property_doc", /資料|エアコン|家具|収納|オートロック|クローゼット|広さ|トイレ|床|キッチン|設備|礼金|契約期間|契約条件|更新|住所|距離|両隣|バス|保証人要否|飼育(?:可否)?の条件/],
  // 会話・記録の文脈（どの物件の話か・経緯・直前の文）
  ["conversation_context", /どの物件|指す|直前|過去の|経緯|記録|お名前|意図|目的|挨拶|用途|画像の用件|写真の用件|外した物件|伝達済み|確定状況|変更の確定/],
  ["customer_feedback", /感想|継続意向|来られなかった理由|意向/],
  ["customer_conditions", /希望|条件|エリア|家賃上限|家賃以外|入居時期|入居人数|ペット|職業|属性|築年数|引越し時期|勤務地/],
];

/** 自由な名前 → 決まった鍵（読み取りの失敗「読めなかった材料: …」は system の conversation_context ではなく other に寄せない＝別に数える） */
export function materialMissingKey(label: string | null | undefined): MaterialKey {
  const s = String(label ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (!s) return "other";
  for (const [k, re] of RULES) if (re.test(s)) return k;
  return "other";
}

export function materialMissingSide(label: string | null | undefined): MaterialSide {
  return MATERIAL_KEY_SIDE[materialMissingKey(label)];
}

/** 数え: 名前と回数の組 → 鍵ごとの回数（多い順） */
export function tallyMaterialKeys(rows: ReadonlyArray<{ label: string; count?: number | null }>): Array<{ key: MaterialKey; side: MaterialSide; n: number; labels: number }> {
  const m = new Map<MaterialKey, { n: number; labels: number }>();
  for (const r of rows) {
    const k = materialMissingKey(r.label);
    const x = m.get(k) ?? { n: 0, labels: 0 };
    x.n += Math.max(1, Number(r.count ?? 1)); x.labels++;
    m.set(k, x);
  }
  return [...m].map(([key, v]) => ({ key, side: MATERIAL_KEY_SIDE[key], ...v })).sort((a, b) => b.n - a.n);
}
