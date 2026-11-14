// 2026-11-15 作業員H（個人情報・統括役の頼み）: お客様の画像の書き起こしの書類の網（IMAGE_LABEL_1115）・読む時の置き換え（IMAGE_DOC_READ_REDACT）・出口の網（ALT_IMAGE_DOC_GATE）
//   元の書き起こしの形（名前・住所・番号は架空の物に置き換えた）でのテスト。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/image-doc-guard-1115.test.ts
import { classifyCustomerImage, labeledImageText, imageLabel1115On, maskEstimateAddressee } from "../image-label";
import { imageTextForSave } from "../id-document-guard";
import { redactImageDocs, redactImageDocsInJsonBody, imageDocReadRedactOn } from "../image-doc-redact";
import { altImageDocSignal, altImageDocGateOn, altPiiSignal } from "../alt-pii-gate";
import { wrapFetchWithLlmSanitizer } from "../llm-request-sanitize";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

// c024b7b9 11/12 の形（Vision は estimate と分けた）
const ASSIST = "アシストレント契約書\n\n契約内容：「個人情報保護方針」のお客様に同意し、本契約内容に同意いただきます。\n\n【貸貸人（甲）】\n氏名：氏名\n住所：〒000-0000 兵庫県尼崎市架空町1丁目1番1号\n\n【借主（乙）】\n氏名：山田 花子\n住所：〒000-0000 神奈川県横浜市架空区1-2-3";
// fbffca3d 10/26 の形（保証委託の条文）
const ITAKU = "16:08\n◀メッセージ\nZ・SIGN\n委託契約 1/2 ☑ チェックリスト\n2 保証委託料、保証の範囲及び保証限度額\n保証委託料\nご契約のプランに従って…\n保証の範囲\n保証対象物件の賃貸借契約…";
// 13f37ce2 11/12・11/13 の形
const MYPAGE = "17:29\n5G 84\nマイページ\n山田 太郎\nアカウントを編集\n契約物件\nサンプル南 303\n契約情報 アカウント";
const FURIKOMI = "20:29\n振込出金｜ヤマダ タロウ\n-¥158,960\nメモを入力\n振込金額 ¥158,960\n振込手数料（注） ¥200\n合計引落金額 ¥159,160\n振込先\nGMOあおぞらネット銀行";
// 弊社の見積書（宛名つき）・物件の資料
const OWN_EST = "見積書\n\n2026/10/30\n\nタツヤ　様\n\n物件名：サンプル日本橋　502号室\n初月賃料\n家賃　¥63,000\n共益費　¥8,000\n礼金　¥63,000\n保証会社代　¥35,500\n火災保険代　¥15,000\n鍵交換代　¥27,500\n仲介手数料　¥0\n合計　¥221,800\n蓮産業株式会社";
const MATERIAL = "物件種目 マンション\n号室名 0102\n賃料 6.3万円 管理費 8,000円\n1K 25.2㎡\n保証会社：アシストレント（保証委託料 初回50%）\n取引態様 仲介";

ok("既定 on（=off で戻す）", imageLabel1115On({}) && !imageLabel1115On({ IMAGE_LABEL_1115: "off" }));
ok("アシストレント契約書（estimate と分けられた）→ 契約書の種類だけ", classifyCustomerImage("estimate", ASSIST) === "contract_document");
ok("保存の本文は見出しだけ（氏名・住所を残さない）", imageTextForSave("estimate", ASSIST) === "[画像] 【書類：契約書・保証会社の書類】", imageTextForSave("estimate", ASSIST));
ok("保証委託の条文 → 契約書の種類だけ", classifyCustomerImage("other", ITAKU) === "contract_document");
ok("マイページの姓名 → 個人情報の画像（書き起こしを残さない）", imageTextForSave("other", MYPAGE) === "[画像] 【物件以外：個人情報の載った画像】", imageTextForSave("other", MYPAGE));
ok("振込出金の画面 → 支払いの控え（書き起こしを残さない）", imageTextForSave("other", FURIKOMI) === "[画像] 【物件以外：振込・支払いの控え】", imageTextForSave("other", FURIKOMI));
ok("物件の資料の「保証会社：アシストレント」は契約書にしない", classifyCustomerImage("floor_plan", MATERIAL) === "property_material");
ok("弊社の見積書は見積書のまま・宛名だけ伏せる", classifyCustomerImage("estimate", OWN_EST) === "estimate" && /（お名前）様/.test(labeledImageText("estimate", OWN_EST)) && !/タツヤ/.test(labeledImageText("estimate", OWN_EST)) && /¥221,800/.test(labeledImageText("estimate", OWN_EST)));
ok("宛名の網: 物件名の行・会社の語・「御見積書／様」は伏せない", maskEstimateAddressee("物件名 サンプル乗本町日様 102号") === "物件名 サンプル乗本町日様 102号" && maskEstimateAddressee("この度は、建築業様") === "この度は、建築業様" && maskEstimateAddressee("御見積書\n様") === "御見積書\n様" && maskEstimateAddressee("入居者 様") === "入居者 様");
ok("宛名の網: 「しゅんや  2026年10月28日\\n様」の形は名前を伏せる", /^（お名前）/.test(maskEstimateAddressee("しゅんや　　　　2026年10月28日\n様")));
{
  process.env.IMAGE_LABEL_1115 = "off";
  ok("off なら前の形（見積書の見出しで中身が残る）", classifyCustomerImage("estimate", ASSIST) === "estimate");
  delete process.env.IMAGE_LABEL_1115;
}

// ─── 読む時の置き換え（保存済みの昔の行）──────────────────
const convo = `[顧客 11/12 12:36] [画像] 【見積書・初期費用の明細】\n${ASSIST}\n[スタッフ 11/12 12:40] 保証会社はアシストレントと言う保証会社となります！！\n[顧客 11/12 12:41] よろしくお願いします`;
{
  const r = redactImageDocs(convo);
  ok("既定 on", imageDocReadRedactOn({}) && !imageDocReadRedactOn({ IMAGE_DOC_READ_REDACT: "off" }));
  ok("昔の行の契約書の中身は種類だけに（前後の発言は残す）", r.hits.join() === "contract" && !/山田|横浜市/.test(r.text) && /\[スタッフ 11\/12 12:40\] 保証会社はアシストレント/.test(r.text) && /よろしくお願いします/.test(r.text), r.text);
  const m = redactImageDocs(`[顧客] [画像] 【種類不明】\n${MYPAGE}\n[顧客] 契約物件の確認です`);
  ok("マイページの姓名は個人情報の画像に", m.hits.join() === "mypage" && !/山田 太郎/.test(m.text) && /契約物件の確認です/.test(m.text));
  const e = redactImageDocs(`[顧客] [画像] 【見積書・初期費用の明細】\n${OWN_EST}`);
  ok("見積書は宛名だけ伏せ、金額は残す", e.hits.join() === "addressee" && !/タツヤ/.test(e.text) && /¥221,800/.test(e.text));
  ok("当たらない本文はそのまま（同じ文字列）", redactImageDocs("[顧客] [画像] 【物件の資料】\n" + MATERIAL).text === "[顧客] [画像] 【物件の資料】\n" + MATERIAL);
  const body = JSON.stringify({ model: "x", messages: [{ role: "user", content: convo }] });
  const jb = redactImageDocsInJsonBody(body);
  ok("JSON の本文でも置き換える", jb.hits === 1 && !/山田/.test(jb.body));
  ok("当たらない JSON は元の文字列のまま（キャッシュを壊さない）", redactImageDocsInJsonBody(JSON.stringify({ a: "[画像] 【物件の資料】\n" + MATERIAL })).body === JSON.stringify({ a: "[画像] 【物件の資料】\n" + MATERIAL }));
}

// ─── 出口の網（DeepSeek に出す前）────────────────────────
ok("出口の網 既定 on", altImageDocGateOn({}) && !altImageDocGateOn({ ALT_IMAGE_DOC_GATE: "off" }));
ok("契約書の中身が残る本文は止める", altImageDocSignal(convo) !== null && altPiiSignal(convo) !== null);
ok("マイページの氏名は止める", altImageDocSignal(`[画像] 【種類不明】\n${MYPAGE}`) !== null);
ok("見積書の宛名だけは止めない（伏せる側）・物件の資料も止めない", altImageDocSignal(`[画像] 【見積書・初期費用の明細】\n${OWN_EST}`) === null && altImageDocSignal(`[画像] 【物件の資料】\n${MATERIAL}`) === null);
ok("指示文の語（「契約書」「アシストレント」が画像の外）では止めない", altImageDocSignal("保証会社はアシストレントです。賃貸借契約書の借主の氏名：欄は伏せる") === null);

// ─── fetch の包み（配線）──────────────────────────────
(async () => {
  let sent = "";
  const fake = (async (_i: RequestInfo | URL, init?: RequestInit) => { sent = String(init?.body ?? ""); return new Response("{}"); }) as typeof fetch;
  const w = wrapFetchWithLlmSanitizer(fake);
  await w("https://api.deepseek.com/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: convo }] }) });
  ok("DeepSeek へのリクエストで置き換わる（配線）", !/山田|横浜市/.test(sent) && /書類：契約書・保証会社の書類/.test(sent));
  await w("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: `[画像] 【見積書・初期費用の明細】\n${OWN_EST}` }] }) });
  ok("Anthropic へのリクエストで宛名が伏せられる（配線）", !/タツヤ/.test(sent) && /（お名前）様/.test(sent));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
