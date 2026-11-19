// app/lib/conversation-fact-kinds.ts — 「会話の中の事実」の種類の語彙（純関数・DB/LLM なし）
//
// 2026-11-12 作業員1（材料の抜けの台帳 ③・統括役）: 人が直した番（weak-spots 2026-10-16）37件と作業員10 の「文の事実が届いていない」のその他 9件は
//   「会話の中の事実（種類が決まらない）」に落ち、何の事実かが決まらないので届け先も決まらなかった。46件を目で読んで種類に分けた。
//   各種類は 情報の種類 K1〜K16（作業員21 aix-catalog-map の INFO_KINDS_16）と、情報の土台の項目 INFO_KEYS（作業員1 info-fill-map）に読み替える。
//   読み替えの表は作業員22 の conductor-field-links の K_TO_INFO_KEYS と同じ向き（K → INFO_KEYS）に揃えた（型は文字列で持つ＝まだ main に無い部品に依存しない）。
//   kind を決めるのは、お客様の文と、人（スタッフ）が送った文の両方の言葉（決まった線）。

export const CONVERSATION_FACT_KINDS = [
  "viewing_logistics", "viewing_schedule", "check_result", "vacancy_result", "search_scope", "company_knowledge",
  "doc_fact", "cost_breakdown", "apply_procedure", "customer_circumstance", "ack_only",
] as const;
export type ConversationFactKind = typeof CONVERSATION_FACT_KINDS[number];

export const CONVERSATION_FACT_SPEC: Record<ConversationFactKind, { label: string; k: readonly string[]; infoKeys: readonly string[]; staffOnly: boolean; example: string }> = {
  viewing_logistics: { label: "内覧の当日の段取り（所要時間・駐車場・付き添い・同じ日の他の部屋）", k: ["K8", "K6"], infoKeys: ["viewing_date"], staffOnly: false, example: "お部屋のご内覧お時間30分程／お近くのパーキングにお停めください" },
  viewing_schedule: { label: "内覧の日時の決まり・変更・空き枠", k: ["K6"], infoKeys: ["viewing_date"], staffOnly: true, example: "本日ご案内可能です😊！！ 14:00〜17:00" },
  check_result: { label: "管理会社に確かめた結果（子供可・代理契約・設備の変更 等）", k: ["K2"], infoKeys: ["screening_info", "move_in"], staffOnly: true, example: "管理会社に確認させていただき、ご両親での代理契約でのお申込みも可能とのことです" },
  vacancy_result: { label: "物件の募集状況の確認の結果", k: ["K1", "K13"], infoKeys: ["vacancy_checked"], staffOnly: true, example: "募集状況確認させて頂きましたところ、現在募集に出ていないお部屋" },
  search_scope: { label: "探す範囲・条件（エリア・価格帯・階・間取り）の受け止め", k: ["K11"], infoKeys: ["area", "rent", "layout", "size"], staffOnly: false, example: "心斎橋周辺全域から10階以上のタワーマンションのお部屋ピックアップ" },
  company_knowledge: { label: "会社・地域の一般の知識（治安・相場・手続きの一般）", k: ["K8"], infoKeys: [], staffOnly: false, example: "治安が良くないと言われるエリアは西成区…" },
  doc_fact: { label: "物件の資料に書いてある事（間取りの形・設備・名称）", k: ["K9"], infoKeys: [], staffOnly: false, example: "洗面台とトイレが同じ間取りであるアメリカンセパレートの間取り" },
  cost_breakdown: { label: "初期費用の内訳・金額", k: ["K5"], infoKeys: ["estimate_sent"], staffOnly: false, example: "初期費用170,480円には、前家賃（翌月分家賃…）" },
  apply_procedure: { label: "申込の手続き（フォーマット・名義・代理契約・審査の進め方）", k: ["K15"], infoKeys: ["apply_intent", "apply_form"], staffOnly: false, example: "【代理契約 〇〇様ご入力欄】" },
  customer_circumstance: { label: "お客様の事情（付き添い・家族・お客様のお客様の家）", k: ["K11", "K14"], infoKeys: ["screening_info"], staffOnly: false, example: "付き添いで1人着いてきます" },
  ack_only: { label: "お礼・了承だけ（届ける事実なし）", k: [], infoKeys: [], staffOnly: false, example: "当日は何卒よろしくお願い致します" },
};

const n = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");
/**
 * お客様の文と人の送信の文から種類を決める（上から順に当てる）。
 *   スタッフしか知らない種類（確かめた結果・空き枠・募集状況）は人の送信の言葉で決める（お客様の文だけでは決めない）。
 */
export function conversationFactKind(customerText: string | null | undefined, sentText: string | null | undefined): ConversationFactKind {
  const c = n(customerText), s = n(sentText);
  if (/募集状況確認|募集に出(?:ていない|ておらず)/.test(s)) return "vacancy_result";
  if (/管理(?:会社|お客様)(?:担当者)?(?:へ|に)?(?:確認|お電話)|とのことです|確認いただいております/.test(s)) return "check_result";
  if (/記入欄】|フォーマット|名義|代理契約|審査(?:通過|かけ)/.test(s) || /名義|代理|審査通るか/.test(c)) return "apply_procedure";
  if (/初期費用[\d,]*円?には|内訳|前家賃|日割/.test(s)) return "cost_breakdown";
  if (/内覧[^。\n]{0,6}時間|パーキング|駐車|付き添い|同じ日|その日のうちに|も見に行/.test(c + s) && !/変更/.test(c)) return "viewing_logistics";
  if (/ご案内可能|お日にち変更|\d{1,2}:\d{2}〜|お待ち合わせ/.test(s) || /内覧[^。\n]{0,10}(?:変更|今日|明日)|今日とかいけ/.test(c)) return "viewing_schedule";
  if (/治安|相場|と言われ/.test(s)) return "company_knowledge";
  if (/間取り(?:と|の)|セパレート|和室|洋室|入力ミス|正しい名称/.test(s)) return "doc_fact";
  if (/全域から|ピックアップ|価格帯|階以上|類似条件/.test(s) || /物件あれ|ありますでしょうか|取り扱い/.test(c)) return "search_scope";
  if (/付き添い|自分のお客様|家族|旦那|妻|子ども|子供/.test(c)) return "customer_circumstance";
  // 人の送信が無い時（作業員10 の行）: 物件の設備・条件を変えられるか・できるかの問いは管理会社に確かめる事
  if (!s.trim() && /(?:変え|変更|可能|不可|でき)[^。\n]{0,8}(?:ますか|ですか|か[？?])/.test(c)) return "check_result";
  return "ack_only";
}
