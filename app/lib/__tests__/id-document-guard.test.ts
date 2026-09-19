// app/lib/__tests__/id-document-guard.test.ts
// 2026-09-19 竹内「マイナンバーカードや運転免許証の個人情報は本人確認書類とだけ文字にして
//   情報が文字お越しされないようにする」
// 実行: npx tsx app/lib/__tests__/id-document-guard.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { isIdDocument, imageTextForSave, imageTypeForSave, ID_DOCUMENT_TEXT } from "../id-document-guard";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── ★ 分類が id_document なら、中身に関わらず捨てる");
{
  t("type が id_document なら捨てる", isIdDocument("id_document", "なんでも書いてある"));
  t("大文字・前後の空白も同じ", isIdDocument(" ID_Document ", "なんでも"));
  t("書き起こしが空でも身分証として扱う", isIdDocument("id_document", ""));
}

console.log("── ★ 分類が外れても中身の指紋で拾う（実データの形）");
{
  // 以下はすべて実データ（messages.text）に実在した形。個人情報は伏せてある
  t("★ 免許証: 氏名＋生年月日＋住所",
    isIdDocument(null, "氏名：〇〇 〇〇\n生年月日：平成N年N月NN日生\n\n住所：大阪府大阪市〇〇区〇〇N丁目\n交付：令和NN年"));
  // 実データは「生年月日」という語を持たず「平成7年　3月1日生」とだけ書く形がある（全角スペース入り）
  t("★ 免許証: 「◯年◯月◯日生」の形（生年月日という語が無い・全角スペース）",
    isIdDocument("", "氏名：〇〇　〇〇\n平成7年　3月1日生\n\n住所：大阪府大阪市〇〇区"));
  t("★ マイナンバーカード裏面の定型文",
    isIdDocument("other", "このカードを拾得された方は、お手数ですが、下記連絡先までご連絡ください。《連絡先》マイナンバー総合フリーダイヤル"));
  t("★ 運転免許証（公安委員会）", isIdDocument(null, "運転免許証 〇〇県公安委員会"));
  t("★ パスポート", isIdDocument(null, "# パスポート情報の転記\n**PASSPORT**\n国籍: JAPAN\n氏名: 〇〇"));
  t("★ 身分証の見出しつき", isIdDocument("", "# 身分証の内容\n\n**氏名：** 〇〇 〇〇\n\n**住所：** 大阪府\n\n**生年月日：** 昭和NN年"));
}

console.log("── ★ 誤爆しない（物件・見積書・依頼文は捨てない）実データで確認済み");
{
  t("★ 間取り図（有効期限という語があっても捨てない）",
    !isIdDocument("floor_plan", "賃貸アパート　N時間前　更新\n\nセジュール〇〇（N階/NLDK/NN㎡）\n\n物入　玄関　ベランダ\n有効期限：N/NN"));
  t("★ 物件写真", !isIdDocument("property_photo", "室内の写真 フローリング 洋室"));
  t("★ 見積書（氏名はあっても生年月日が無い）",
    !isIdDocument("estimate", "御見積書\n氏名：〇〇様\n敷金 0円 礼金 0円 仲介手数料 2,980円"));
  t("★ 「本人確認書類をお送りください」という依頼文は捨てない",
    !isIdDocument("other", "こちらお申込に必要なご情報となります😊！！\n\n上記フォーマットご入力いただき、ご本人確認書類として運転免許証またはマイナンバーカードを"));
  t("★ 「マイナンバー」という語だけの注意文は捨てない（こちらの案内）",
    !isIdDocument("other", "送る際の大切な注意点\n\n• 裏面の写真は絶対に送らない\n裏面にはNN桁の個人番号（マイナンバー）が記載されています"));
  t("★ 空の書き起こし（[画像]だけ）は身分証ではない", !isIdDocument(null, ""));
  t("★ 「交付：」だけでは捨てない（単独では指紋にしない）", !isIdDocument(null, "交付：令和N年"));
  t("★ 「有効期限」だけでは捨てない", !isIdDocument(null, "有効期限：NNNN年N月"));
}

console.log("── ★ 保存する文字列");
{
  t("★ 身分証は「[画像] 本人確認書類」だけになる",
    imageTextForSave("id_document", "氏名：〇〇 生年月日：平成N年") === ID_DOCUMENT_TEXT);
  t("★ 中身の指紋で拾った時も同じ",
    imageTextForSave(null, "氏名：〇〇\n生年月日：平成N年N月N日生") === "[画像] 本人確認書類");
  t("身分証でなければ今までどおり書き起こしを付ける",
    imageTextForSave("floor_plan", "セジュール〇〇 2LDK") === "[画像] セジュール〇〇 2LDK");
  t("書き起こしが空なら「[画像]」だけ", imageTextForSave("other", "") === "[画像]");
  t("書き起こしが空白だけでも「[画像]」だけ", imageTextForSave("other", "   \n ") === "[画像]");
}

console.log("── ★ image_type は必ず立てる（本文を捨てる代わりに、ここで事実を伝える）");
{
  t("★ 指紋で拾った物は type が空でも id_document にする",
    imageTypeForSave("", "氏名：〇〇\n生年月日：平成N年N月N日生") === "id_document");
  t("★ other と判定されていても指紋に当たれば id_document に上書き",
    imageTypeForSave("other", "マイナンバー総合フリーダイヤル") === "id_document");
  t("身分証でなければ元の type のまま", imageTypeForSave("floor_plan", "間取り") === "floor_plan");
  t("type も中身も無ければ空のまま（Vision 失敗時は NULL を保つ）", imageTypeForSave("", "") === "");
}

console.log("── ★ 捨てても事実が伝わる受け皿が実在するか（静かに壊れるのを防ぐ）");
{
  // 本文を捨てるので、「本人確認書類が届いた」は image_type だけで伝わる必要がある。
  // 受け皿が消えると、書類が届いたことに誰も気付かなくなる。
  const received = readFileSync("app/lib/received-document.ts", "utf8");
  t("★ received-document が image_type==='id_document' を本文なしで拾う",
    /image_type\s*!==\s*"id_document"/.test(received) && /label\s*\?\?\s*"本人確認書類"/.test(received),
    "app/lib/received-document.ts の判定を変えたらここも直す");

  const brain = readFileSync("app/lib/brain-core.ts", "utf8");
  t("★ ブレインの履歴ラベルに id_document がある",
    /id_document:\s*"本人確認書類"/.test(brain),
    "app/lib/brain-core.ts の IMAGE_TYPE_LABEL を変えたらここも直す");

  // 入口（line-webhook）がこの関数を通しているか。通さないと書き起こしがそのまま保存される
  const webhook = readFileSync("app/api/line-webhook/route.ts", "utf8");
  t("★ line-webhook が imageTextForSave を通して保存している",
    /imageTextForSave\(/.test(webhook) && /imageTypeForSave\(/.test(webhook),
    "保存の1行を直接書き戻すと、この守りが効かなくなる");
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
