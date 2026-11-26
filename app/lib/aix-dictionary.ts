// app/lib/aix-dictionary.ts — AIX の種類ごとの辞書の残り（前提・竹内さん本人の手本）（台帳 #688・竹内さん「ここ大切に」・決まった表・LLM なし）
// 2026-11-26 作業員A（統括役の頼み）:
//   aix-catalog（BUTTON_KNOW）には 送る物（staffOnly）・使う時（when）・似たボタンとの線（lines）がある。足りないのは
//     ① 前提（押す前にそろっている要る物）② 竹内さん本人の手本（お客様の発言 → 竹内さんが送った AIX の要約）の2つ。境目は aix-boundary。
//   手本の出所: 申込までの地図の json（11/26 06:33・竹内さん本人の番 226）で AIX の一手の後に駅が進んだ番、
//     無い種類は aix_usage_logs の60日でお客様が反応し・直しの無い番。本文は要約・お名前と物件名は伏せる。
//   60日の送信数: おすすめ 379・確認した 254・送る 246・内覧の誘い 103・見積 100・集合場所 73・内覧のご挨拶 68・申込の案内 41・電話 39・聞き取り 23（ほかは 5 以下）
//   ブレインには材料の1行で渡す（地図の次の一手の候補の AIX だけ・答えの規則ではない）。控えの行（キー aix_dictionary・from "route"）。
//   スイッチ AIX_DICTIONARY_LINE: 既定 off／on
export function aixDictionaryLineOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_DICTIONARY_LINE ?? "").trim().toLowerCase() === "on";
}
export type DictExample = { customer: string; takeuchi: string; from: string };
export type DictEntry = { aix: string; premise: string; examples: DictExample[] };
export const AIX_DICTIONARY: Record<string, DictEntry> = {
  property_recommendation: { aix: "property_recommendation", premise: "条件（エリア・家賃・間取り）がそろっていて、スタッフが選んだ物件がある",
    examples: [] },
  property_send: { aix: "property_send", premise: "条件がそろっている・送れる候補（ピックアップ）が揃っている",
    examples: [{ customer: "エリアと家賃の目安と「綺麗めの部屋を探して・見つかり次第連絡を」", takeuchi: "「お待たせいたしました」＋聞いた条件（エリア・家賃・間取り）を言い直して「オススメできるお部屋ピックアップさせて頂きました・お手隙の際にご査収ください」", from: "地図 json・進んだ番（4f1df513）" }] },
  property_check_result: { aix: "property_check_result", premise: "お客様が送ってきた物件か聞かれた条件を、管理会社などに確認して結果が出ている（まだなら確認の約束の返信）",
    examples: [
      { customer: "物件の画面2枚と「この2件割引は使えますか」", takeuchi: "2部屋とも募集中と伝え、最大限割引した初期費用の御見積書を同封・費用が上がる要因（クリーニング）も一言・「お手隙の際にご査収ください」", from: "地図 json・進んだ番（81a5eeb5）" },
      { customer: "物件の URL と「空いていますか」＋時期の家賃の一般的な質問", takeuchi: "募集状況を確認した結果（今は募集に出ていない）を伝える", from: "地図 json・進んだ番（58ae93f3）" }] },
  estimate_sheet: { aix: "estimate_sheet", premise: "見積を出す物件が決まっている（物件名・部屋が分かる）",
    examples: [
      { customer: "「今までで1番理想の部屋」＋「初期費用はいくらですか」", takeuchi: "部屋の見出し・割引額と初期費用・一般の業者より節約できる額・日割家賃の注記", from: "地図 json・進んだ番（5dd2d456）" },
      { customer: "物件の URL と「初期費用の見積もりをお願いできますか」", takeuchi: "部屋の見出し・初期費用・節約できる額・日割家賃の注記", from: "地図 json・進んだ番（3d2b1f6a）" }] },
  viewing_invite: { aix: "viewing_invite", premise: "内覧する部屋が決まっている・案内できる日時がスタッフに分かっている",
    examples: [{ customer: "「内見をしたいです」", takeuchi: "「かしこまりました」＋案内する部屋・直近の案内できる日時を2つ・「ご都合よろしいお日にち御座いますでしょうか」", from: "aix_usage_logs・反応あり直しなし（36bb96d9）" }] },
  application_push: { aix: "application_push", premise: "お客様に申込の意思がある（審査をかけてほしい・内覧で決めた）",
    examples: [
      { customer: "「審査かけてもらってもいいですか」", takeuchi: "申込者様の記入欄（入居希望日・勤務先・年収 等）と同居人の記入欄を送る", from: "地図 json・進んだ番（330ad233）" },
      { customer: "内覧の場に「到着しました」（内覧の後の流れ）", takeuchi: "申込者様の記入欄と緊急連絡先の記入欄を送る", from: "地図 json・進んだ番（79f97cea）" }] },
  phone_call: { aix: "phone_call", premise: "文より電話の方が早い説明（申込の手続き・契約者の変更など）がある",
    examples: [{ customer: "「契約者を知人にできますか」（申込の前の手続きの質問）", takeuchi: "「お申込みに関しまして5分程お電話でご説明させて頂ければ」＋電話をかけるボタンの案内", from: "aix_usage_logs・反応あり直しなし（c40e1625）" }] },
  meeting_place: { aix: "meeting_place", premise: "内覧の日時が決まっている", examples: [] },
  greeting_viewing: { aix: "greeting_viewing", premise: "内覧の日が今日か済んだ（内覧前／内覧後）", examples: [] },
  condition_hearing: { aix: "condition_hearing", premise: "物件を探すのに要る条件（エリア・家賃・間取り・入居時期）がそろっていない", examples: [] },
};
/** 手本がまだ無い種類（60日で反応あり直しなしの番も地図の進んだ番も無い・夜に増やす） */
export const DICT_GAPS = Object.values(AIX_DICTIONARY).filter((e) => !e.examples.length).map((e) => e.aix);
/** 材料の1行（地図の次の一手の候補の AIX だけ・2つまで・無い時は ""） */
export function aixDictionaryLine(aixTypes: readonly string[]): string {
  const es = [...new Set(aixTypes)].map((t) => AIX_DICTIONARY[String(t).split("/")[0]]).filter((e): e is DictEntry => !!e).slice(0, 2);
  if (!es.length) return "";
  return `【AIX の辞書（前提と竹内さん本人の手本・材料・決めるのはあなた）】${es.map((e) => `${e.aix}: 前提＝${e.premise}${e.examples[0] ? `／手本＝お客様「${e.examples[0].customer}」→ ${e.examples[0].takeuchi}` : ""}`).join("｜")}`;
}
