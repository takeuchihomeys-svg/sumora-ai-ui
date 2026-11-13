// app/lib/final-check-facts-source.ts — 最終チェックのプロンプトに直書きしていた会社の事実・時間の決まりを、company-facts と同じ出所から作る（純関数）
//
// 2026-11-13 作業員9（統括役・土台の直し ①・弱い所 686 fc:rules-duplicated-in-prompt）:
//   final-check.ts の判定役のプロンプトに会社の事実が直書きされていて、生成（company-facts・procedure-question）と食い違う所があった:
//     ・審査期間: 直書き「早ければ2〜3営業日、長くて1週間程」／company-facts の別の文「3日〜10日程」（数字が2つ）
//     ・支払い方法: 直書き「クレジットカード払いに対応」＝ company-facts は paymentLumpTransferOnly() で向きが変わる（竹内さんへの問い 36ca2676）
//       → 向きが変わっても判定役だけ古い向きで見る。61845054 の支払いの外れと同じ根（事実の出所が2つ）
//     ・夜の約束: 「18時以降・営業時間外」（context_check の 4.）と「日本の営業時間は一般的に9:00-18:00・22時以降」（タイムゾーンの注意）の2か所
//   何を: 会社の事実の箇条を COMPANY_FACTS の fact（生成に渡す物と同じ文）から作る。審査・入居の目安は PROCEDURE_FACTS から。
//     夜の約束は1つの文（管理会社の確認は JST 18時から翌9時前は営業時間外・夜は「明日確認」の形が正しい）にまとめる。
//   既定 off（FC_FACTS_FROM_COMPANY=on で入る）。off の時は呼び出し側が今までの直書きのまま。
import { COMPANY_FACTS } from "./company-facts";
import { PROCEDURE_FACTS } from "./procedure-question";

export function fcFactsFromCompanyOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FC_FACTS_FROM_COMPANY ?? "").trim().toLowerCase() === "on";
}

/** 管理会社の確認が営業時間外になる時刻（JST・mgmt-hours-split の夜の線と同じ 18 時） */
export const MGMT_AFTER_HOURS_FROM = 18;
export const MGMT_OPEN_HOUR = 9;

/** 判定役に渡す会社の事実の id（反する断定を FABRICATED_POLICY にする物） */
const POLICY_FACT_IDS = ["credit_card", "cancel", "store", "room_photo", "emergency_contact", "prorated_rent"] as const;

const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);

type Brand = "sumora" | "ieyasu" | "giga";
function brandOf(account: string | null | undefined): Brand | null {
  const a = String(account ?? "").toLowerCase();
  if (/ieyasu|イエヤス/.test(a)) return "ieyasu";
  if (/giga|ギガ/.test(a)) return "giga";
  if (/sumora|スモラ/.test(a)) return "sumora";
  return null;
}

/** 会社の事実の箇条（anomaly_scan の「6.」の代わり）。各行は COMPANY_FACTS の fact と同じ文 */
export function companyPolicyLinesForCheck(account?: string | null): string[] {
  const out: string[] = [];
  for (const id of POLICY_FACT_IDS) {
    const f = COMPANY_FACTS.find((x) => x.id === id);
    if (f?.fact) out.push(`・${clip(plain(f.fact), 220)}`);
  }
  const brand = brandOf(account);
  for (const f of COMPANY_FACTS) {
    if (!f.brand || !/^max_discount/.test(f.id)) continue;
    if (brand && !f.brand.includes(brand)) continue;
    out.push(`・（${f.brand.join("・")}）${clip(plain(f.fact), 200)}`);
  }
  return out;
}

/** anomaly_scan の「6.」の段落（FC_FACTS_FROM_COMPANY=on の時に直書きの段落と置き換える） */
export function companyPolicyBlockForCheck(account?: string | null): string {
  return `6. 会社の事実（生成に渡している物と同じ出所・company-facts）に**反する断定**は FABRICATED_POLICY。
   理由付きで物件固有の事情を説明している文（「建築中のため写真はまだ無い」）は指摘しない:
${companyPolicyLinesForCheck(account).map((l) => `   ${l}`).join("\n")}`;
}

/** 「会社標準案内・業界一般知識（情報源に無くても捏造でない）」の審査・入居の目安の行（直書きの代わり・PROCEDURE_FACTS と同じ数字） */
export function standardNoticeLinesForCheck(): string[] {
  return [
    `  ・${clip(plain(PROCEDURE_FACTS.flow), 200)}`,
    `  ・${plain(PROCEDURE_FACTS.lead)}`,
  ];
}

/** 夜の約束の決まり（context_check の 4. とタイムゾーンの注意を1つに） */
export function nightPromiseRuleForCheck(): string {
  return `管理会社への確認は JST ${MGMT_AFTER_HOURS_FROM}時以降と${MGMT_OPEN_HOUR}時前は営業時間外。その時間に「本日中に管理会社へ確認」等は実行不可能な約束。` +
    `夜の管理会社への確認は「本日管理会社営業時間外の為、明日確認させて頂き、確認出来次第ご連絡させて頂きます」の形が正しい（竹内さんの実送信）。`;
}

/**
 * 2026-11-13 作業員9（弱い所 685・FC_GOCHOUGO_DATE_ALIGN）: 本文に具体的な候補の日時（月/日・時刻・曜日）があるか。
 *   2026-11-13 作業員B: 既定 on（実送信365日の監査 scripts/audit-gochougo-after-date.ts: off で止まる実送信70通のうち on で40通が止まらなくなり、
 *   40通とも候補の日時つきの実送信＝正しい送信。on で新しく素通りする下書き33件も目で読み、候補なしで日にちを聞き直す形は0件＝誤り0）。戻す時は FC_GOCHOUGO_DATE_ALIGN=off
 *   GOCHOUGO_AFTER_DATE を、竹内さんの「10/24(土) 14:00〜16:00 ご案内可能です…ご都合よろしいお時間御座いますでしょうか」の形で止めないため
 */
export function gochougoDateAlignOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FC_GOCHOUGO_DATE_ALIGN ?? "").trim().toLowerCase() !== "off";
}
export function hasConcreteSlot(text: string): boolean {
  const t = String(text ?? "").normalize("NFKC");
  const date = /[0-9]{1,2}[\/月][0-9]{1,2}|\([月火水木金土日]\)|[月火水木金土日]曜/.test(t);
  const time = /[0-9]{1,2}[:時][0-9]{0,2}\s*[〜~～\-－]|[0-9]{1,2}:[0-9]{2}/.test(t);
  return date && time;
}

/**
 * 2026-11-14 作業員B（GOCHOUGO_AFTER_DATE の誤った止め・FC_GOCHOUGO_COND_TEMPLATE 既定 off）:
 *   お客様の条件の書式（「①【ご入居の時期】⇒9月以降 ②【ご希望の家賃】⇒…」）と、送った例に付いた注釈（〔AIX-META〕〔直前のAIX送信〕以降）を、
 *   「お客様が日にちを言った」の読みから外す。書式の「以降」「希望」で、日にちの指定と読んでいた（365日の実送信で on でも止まる30通の大半）
 * 2026-11-14 統括役: 365日の監査で誤り0（止まらなくなる14通・新しく素通りの下書き6件を目で読んだ）→ 既定 on・=off で戻す
 */
export function gochougoCondTemplateOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FC_GOCHOUGO_COND_TEMPLATE ?? "").trim().toLowerCase() !== "off";
}
const COND_TEMPLATE_LINE_RE = /⇒|=>|[①-⑳]\s*【|[①-⑳]\s*ご?(?:入居|希望|間取|築|エリア|駅|初期|その他)|【[^】]{0,20}(?:時期|家賃|間取り|広さ|築年数|エリア|駅|徒歩|初期費用|要望|こだわり|人数|条件)[^】]{0,20}】|^\s*[0-9０-９]{1,2}\s*[.．)）]\s*(?:ご?入居|ご?希望|間取|築|エリア|駅|初期)/;
export function stripConditionTemplate(cust: string): string {
  const body = String(cust ?? "").split(/〔(?:AIX-META|直前のAIX送信)[^〕]*〕/)[0];
  return body.split(/\n/).filter((l) => !COND_TEMPLATE_LINE_RE.test(l) && !/お部屋探しご?条件|お部屋お探し中/.test(l)).join("\n");
}
