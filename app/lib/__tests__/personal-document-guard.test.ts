// app/lib/__tests__/personal-document-guard.test.ts
// 2026-09-26 竹内「収入証明書なども収入証明書とするだけで、文字おこししないようにする」
// 実行: npx tsx app/lib/__tests__/personal-document-guard.test.ts（全 PASS で exit 0）
// 本文は実データ（messages.text の "[画像] …"）の形。氏名・会社名・金額・番号は架空に置き換えてある。
import { readFileSync } from "node:fs";
import {
  classifyPersonalDocument, isPersonalDocument, personalDocumentName, savedPersonalDocumentLabel,
  PERSONAL_DOCUMENT_LABELS, INCOME_DOCUMENT_TYPE,
} from "../personal-document-guard";
import { imageTextForSave, imageTypeForSave, ID_DOCUMENT_TEXT } from "../id-document-guard";
import { DOCUMENT_KINDS, detectReceivedDocuments, buildReceivedDocumentNote, provesEmployment } from "../received-document";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// ── 実データの形（中身は架空）
const PAYSLIP_A = "給与支払明細書\n【支給項目】\n基本給 200,000\n役職手当 10,000\n時間外手当 5,000\n支給額合計 215,000\n【控除項目】\n健康保険料 10,000\n厚生年金料 18,000\n雇用保険料 1,200\n所得税 4,000\n住民税 8,000\n控除額合計 41,200\n【勤怠】\n出勤日数 20\n当月支給額 173,800";
const PAYSLIP_B = "給与明細作成\n2025年9月25日支給 株式会社〇〇\n〇〇 〇〇 様\n支給期間 8月1日-8月31日\n基本給 180,000\n通勤費 10,000\n支給額合計 190,000\n健康保険 9,000\n厚生年金 16,000\n雇用保険 1,000\n所得税 3,000\n住民税 7,000\n控除計 36,000\n差引支給額 154,000";
const EMPLOYMENT = "雇用契約書兼労働条件通知書\n氏名 〇〇 〇〇\n事業主 株式会社〇〇\n【契約期間】 6ヶ月（その後原則更新）\n※勤務状況により更新しないことがあります\n【就業の場所】 〇〇保育園\n【始業・終業の時刻】 1 始業・終業の時刻 8:30〜17:30\n2 休憩時間 60分\n【休日】 1 定例日 土日祝\n【賃金】 1 基本賃金 基本給 200,000円";
const JIREI = "辞令\n氏名 〇〇 〇〇\n発令者 株式会社〇〇 代表取締役社長 〇〇\n下記の通り発令する\n発令日付 令和7年9月1日\n異動日 令和7年10月1日\n発令事項 〇〇事業本部 〇〇センター 勤務を命じる。";
const INSURANCE_FORM = "契約番号 0000\n契約内容 家財保険\n保険期間 2年\n物件住所 〒000-0000 大阪府〇〇\n入居者\n氏名（被保険者）\nカナ 〇〇\n漢字 〇〇\n生年月日\n1999 年 01月 01日\n携帯　090-0000-0000\n①契約者";

console.log("── ★ 実データの形を拾う（分類は外れている＝estimate / other）");
{
  t("★ 給与明細（Vision は estimate と分類）", classifyPersonalDocument(PAYSLIP_A) === "給与明細");
  t("★ 給与明細（見出しが「給与明細作成」）", classifyPersonalDocument(PAYSLIP_B) === "給与明細");
  t("★ 雇用契約書兼労働条件通知書", classifyPersonalDocument(EMPLOYMENT) === "労働条件通知書");
  t("★ 辞令", classifyPersonalDocument(JIREI) === "辞令");
  t("★ 保険の申込（氏名・生年月日・携帯が別の行・値あり）", classifyPersonalDocument(INSURANCE_FORM) === "申込書");
}

console.log("── ★ 実物の無い種類（形は公的書類の定型）");
{
  t("源泉徴収票", classifyPersonalDocument("令和6年分 給与所得の源泉徴収票\n支払を受ける者 住所 〇〇\n支払金額 3,000,000\n給与所得控除後の金額 2,020,000\n源泉徴収税額 50,000") === "源泉徴収票");
  t("課税証明書", classifyPersonalDocument("令和7年度 所得・課税証明書\n給与収入 3,000,000\n合計所得金額 2,020,000\n所得控除額合計 800,000") === "課税証明書");
  t("確定申告書", classifyPersonalDocument("令和6年分の所得税及び復興特別所得税の申告書 第一表\n収入金額等 事業 4,000,000\n所得金額等 2,500,000\n課される所得金額") === "確定申告書");
  t("在籍証明書", classifyPersonalDocument("在籍証明書\n氏名 〇〇 〇〇\n上記の者は当社に在籍していることを証明します。") === "在籍証明書");
  t("内定通知書", classifyPersonalDocument("内定通知書\n〇〇 〇〇 様\nこの度は貴殿を採用することに決定いたしました。\n入社予定日 令和7年11月1日") === "内定通知書");
  t("通帳", classifyPersonalDocument("普通預金\n年月日 お支払金額 お預り金額 差引残高\n7-09-25 給与 200,000 500,000") === "通帳");
  t("住民票", classifyPersonalDocument("住民票の写し\n世帯主 〇〇 〇〇\n続柄 本人\n住民となった年月日 令和2年4月1日\n本籍 省略") === "住民票");
  t("印鑑登録証明書", classifyPersonalDocument("印鑑登録証明書\n登録番号 0000\n氏名 〇〇\n生年月日 平成1年1月1日\nこの写しは登録されている印影と相違ないことを証明します") === "印鑑登録証明書");
}

console.log("── ★ 誤爆しない（実データで誤爆しかけた形・依頼文）");
{
  t("★ 物件資料の必要書類欄（収入証明・印鑑証明書の名前だけ）",
    classifyPersonalDocument("〇〇キャッスル 1K\n必要書類 契約者（個人）：顔写真/身分証・収入証明 連帯保証人様：印鑑証明書 ※属性により変動あり") === null);
  t("★ 条件のスクショ「普通預金の残高N万円以上」",
    classifyPersonalDocument("審査基準\n銀行の新規口座開設 & 普通預金の残高10万円以上") === null);
  t("★ 振込先口座のスクショ", classifyPersonalDocument("振込先口座 〇〇銀行 普通 0000000") === null);
  t("★ 見積書（給与・年金の語なし・敷金礼金）", classifyPersonalDocument("御見積書\n敷金 0円 礼金 0円 仲介手数料 2,980円 火災保険 15,000円 保証会社 初回 50%") === null);
  t("★ スタッフの依頼文（内定通知書・労働条件）",
    classifyPersonalDocument("現在作成依頼させていただいております内定通知書に労働条件や給与額も記載ございますので内定通知書のみの添付で大丈夫です！！") === null);
  t("★ お客様の文（給与明細に記載されている支給実績）",
    classifyPersonalDocument("既に提出済みの給与明細に記載されている実際の支給実績以外に提出可能な書類がないのですが") === null);
  t("★ 課税証明書の依頼文（住民税の語があっても）",
    classifyPersonalDocument("課税証明書（住民税の証明）をお送りいただけますと幸いです") === null);
  t("★ 空の申込フォーマット（値が無い）",
    classifyPersonalDocument("【お申込者様記入欄】\n・氏名、フリガナ\n・生年月日\n・現住所 〒（住民票記載）\n・携帯番号\n・勤務先名") === null);
  t("★ 記入済みフォームの「住民票記載」「続柄」で住民票にしない（値があれば申込書）",
    classifyPersonalDocument("【お申込者様記入欄】\n・氏名 〇〇\n・生年月日 2000/01/01\n・現住所 〒（住民票記載）000-0000 〇〇\n・携帯番号 090-0000-0000\n・続柄 本人") === "申込書");
  t("空文字は当てない", classifyPersonalDocument("") === null && !isPersonalDocument(null, ""));
}

console.log("── ★ 保存する本文（種類だけ・中身は残さない）");
{
  t("★ 給与明細 → [画像] 収入証明書（給与明細）", imageTextForSave("estimate", PAYSLIP_A) === "[画像] 収入証明書（給与明細）");
  t("★ 金額・氏名は残らない", !/200,000|〇〇/.test(imageTextForSave("estimate", PAYSLIP_B)));
  t("★ 申込書 → [画像] 申込書", imageTextForSave("other", INSURANCE_FORM) === "[画像] 申込書");
  t("★ 分類だけ income_document（中身から種類が決まらない）→ [画像] 収入証明書",
    imageTextForSave("income_document", "何かの書類") === "[画像] 収入証明書");
  t("★ 分類 income_document で書き起こしが空でも捨てる", imageTextForSave("income_document", "") === "[画像] 収入証明書");
  t("本人確認書類が先（氏名：＋生年月日）", imageTextForSave(null, "氏名：〇〇\n生年月日：平成1年1月1日生\n携帯 090-0000-0000 申込") === ID_DOCUMENT_TEXT);
  t("物件資料はそのまま", imageTextForSave("floor_plan", "セジュール〇〇 2LDK 家賃 70,000円") === "[画像] セジュール〇〇 2LDK 家賃 70,000円");
  t("★ image_type: 給与明細は estimate → income_document", imageTypeForSave("estimate", PAYSLIP_A) === INCOME_DOCUMENT_TYPE);
  t("image_type: 物件資料は元のまま", imageTypeForSave("floor_plan", "間取り") === "floor_plan");
  t("image_type: 身分証は id_document のまま", imageTypeForSave("id_document", PAYSLIP_A) === "id_document");
  t("personalDocumentName: 書類でなければ null", personalDocumentName("other", "LINE のスクショ") === null);
}

console.log("── ★ 保存した本文から種類を読み戻す（後ろの仕組み）");
{
  t("収入証明書（給与明細）→ 給与明細", savedPersonalDocumentLabel("[画像] 収入証明書（給与明細）") === "給与明細");
  t("収入証明書 → 収入証明書", savedPersonalDocumentLabel("[画像] 収入証明書") === "収入証明書");
  t("住民票 → 住民票", savedPersonalDocumentLabel("[画像] 住民票") === "住民票");
  t("★ 書き起こしの途中の「収入証明」は読まない", savedPersonalDocumentLabel("[画像] 必要書類 身分証・収入証明") === null);
  t("★ 種類の名前は全部 received-document にある",
    PERSONAL_DOCUMENT_LABELS.every((l) => DOCUMENT_KINDS.some((k) => k.label === l)),
    PERSONAL_DOCUMENT_LABELS.filter((l) => !DOCUMENT_KINDS.some((k) => k.label === l)).join(","));

  const docs = detectReceivedDocuments([{ sender: "customer", text: imageTextForSave("estimate", PAYSLIP_A), image_type: imageTypeForSave("estimate", PAYSLIP_A) }]);
  t("★ 給与明細が届いた（書き起こし無しで）", docs.length === 1 && docs[0].label === "給与明細");
  t("★ 在籍・収入の証明として効く（再依頼しない）", provesEmployment(docs[0]?.label) && buildReceivedDocumentNote(docs).includes("在籍証明の作成をお願いします"));
  const onlyType = detectReceivedDocuments([{ sender: "customer", text: "[画像] 収入証明書", image_type: "income_document" }]);
  t("★ 種類が決まらない収入証明書も届いた扱い・証明として効く", onlyType[0]?.label === "収入証明書" && provesEmployment(onlyType[0]?.label));
  const jirei = detectReceivedDocuments([{ sender: "customer", text: imageTextForSave("other", JIREI), image_type: "income_document" }]);
  t("★ 辞令も証明として効く", jirei[0]?.label === "辞令" && provesEmployment("辞令"));
  const residence = detectReceivedDocuments([{ sender: "customer", text: "[画像] 住民票", image_type: "income_document" }]);
  t("住民票は届いた扱い・在籍の証明にはしない", residence[0]?.label === "住民票" && !provesEmployment("住民票"));
  t("★ 昔の行（物件資料の書き起こし）の「収入証明」で書類にしない",
    detectReceivedDocuments([{ sender: "customer", text: "[画像] 〇〇キャッスル 必要書類 身分証・収入証明 連帯保証人様：印鑑証明書", image_type: "other" }]).length === 0);
}

console.log("── ★ 入口（line-webhook）が通しているか");
{
  const webhook = readFileSync("app/api/line-webhook/route.ts", "utf8");
  t("★ Vision の分類に income_document がある", /TYPE:\\s\*\(estimate\|floor_plan\|property_photo\|id_document\|income_document\|other\)/.test(webhook) || webhook.includes("id_document|income_document|other)/i"));
  t("★ 保存は imageTextForSave / imageTypeForSave を通る", /imageTextForSave\(/.test(webhook) && /imageTypeForSave\(/.test(webhook));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
