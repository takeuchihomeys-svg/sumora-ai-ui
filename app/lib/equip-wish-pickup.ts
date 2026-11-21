// app/lib/equip-wish-pickup.ts — お客様が言った設備の希望（カウンターキッチン・独立洗面台・コンロの口数…）を、次の AIX【物件ピックアップした】の文の軸に渡す（純関数・既定 off）
//
// 2026-11-21 作業員K2（竹内さん「カウンターキッチンが良いお客さんの場合、ちゃんと AIX ツールにもそのことを反映させて連携させて」・同日の決定
//   「設備の希望を言われた番は、その条件で探す約束を返信でし、次は AIX から送る（2段:pickup）」の後ろ半分）。
//   調べ（60日・設備の希望を言った会話 22）: 条件の欄（preferences・other_requests）には 19 で入っている＝判定（property-brain の EQUIP_ の札・customer-wants）・
//   🌟（pickup-rank は条件の文を読む）には届く。届いていないのは、約束の後に送るピックアップの文で「その希望で探した」と書く所（竹内さんの言葉:
//   「カウンターキッチン付のお部屋でピックアップさせて頂きました」）。今の文の②は条件の欄から最大1〜2つを選ぶだけで、直前の希望を軸にしない。
// 線: お客様の直近の発言（6通）の設備の希望だけ（equipment-question.detectEquipmentQuestion の wish）。資料で付いていると分からない部屋が混ざる時は「付き」と言い切らない。
// ■ スイッチ EQUIP_WISH_PICKUP: 既定 off（今と1文字も変わらない）／on
// テスト: app/lib/__tests__/equip-wish-pickup.test.ts
import { detectEquipmentQuestion, EQUIP_TOPIC_LABEL, type EquipTopic } from "@/app/lib/equipment-question";

type Env = Record<string, string | undefined>;
export function equipWishPickupOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.EQUIP_WISH_PICKUP ?? "").trim().toLowerCase() === "on";
}

// equipment-question の希望の網（WISH_RE）は「〜だと嬉しい」形だけで、「できれば〜がいいです」「〜が良いです」を拾わない（その網は質問の側の動きと共有なので触らない）。
//   ここでは希望の言い方を広く・設備の語は希望で出やすい物だけに絞った自前の網を足す（質問の形「？」は外す）
const WISH_WORD_RE = /できれば|出来れば|が(?:いい|良い|よい)(?:です|な|かな|ん)|希望|だと(?:嬉し|うれし|助かり|ありがた)|があれば|付きで|付きが|欲しい|ほしい/;
const WISH_TOPICS: Array<[EquipTopic, RegExp]> = [
  ["counter_kitchen", /カウンターキッチン|対面(?:式)?キッチン/], ["washbasin", /独立洗面|洗面台/], ["burners", /[2-3２-３二三]口(?:コンロ|以上)?/],
  ["bath_toilet", /バス・?トイレ別|風呂・?トイレ別|セパレート/], ["laundry_in", /室内洗濯/], ["autolock", /オートロック/], ["delivery_box", /宅配ボックス|宅配BOX/i],
  ["reheating", /追い?焚き|追焚/], ["bath_dryer", /浴室乾燥/], ["gas_stove", /ガスコンロ/], ["ih", /IH/i],
];
function ownWishTopics(text: string): EquipTopic[] {
  const out: EquipTopic[] = [];
  for (const s of String(text ?? "").normalize("NFKC").split(/(?<=[。！!\n])/)) {
    if (/[?？]/.test(s) || !WISH_WORD_RE.test(s)) continue;
    for (const [k, re] of WISH_TOPICS) if (re.test(s) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** お客様の直近の発言（古い順）→ 設備の希望の話題（新しい順・重なりなし） */
export function latestEquipWishTopics(customerTexts: ReadonlyArray<string | null | undefined>): EquipTopic[] {
  const out: EquipTopic[] = [];
  for (const t of [...customerTexts].reverse()) {
    const q = detectEquipmentQuestion(t, { EQUIPMENT_WISH_LOOKUP: "on" });
    const ks = [...(q?.wish ? q.topics : []), ...ownWishTopics(String(t ?? ""))];
    for (const k of ks) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** ピックアップの文の材料の1行（無ければ ""） */
export function equipWishPickupNote(topics: ReadonlyArray<EquipTopic>): string {
  if (!topics.length) return "";
  const label = topics.slice(0, 2).map((k) => EQUIP_TOPIC_LABEL[k]).join("・");
  return `【今回の束の軸（お客様が直前に言った設備の希望）】${label}。②のピックアップの1行はこの希望で探した事を書く（条件はこの希望を1つ・エリアの言い方はそのまま）。` +
    `今回の束の全部が資料で「付いている」と分かる時だけ「${label}付きのお部屋でピックアップさせて頂きました」と言い切り、資料で分からない部屋が混ざる時は「${label}のご希望でお探しさせて頂きました」の形にする（付いていると書かない）。`;
}
