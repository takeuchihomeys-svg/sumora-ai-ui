// app/lib/__tests__/example-pii-guard.test.ts
// 2026-10-08 手本（ai_reply_examples）に別のお客様の記入済み申込フォームが入っていて LLM に渡っていた事故（9bbf9b90）の歯止め。
// 本文は全部作り物（実在の個人情報は使わない）。形は本番の行の骨組み（scripts/audit-example-pii.ts --skeleton）に合わせた。
// 実行: npx tsx app/lib/__tests__/example-pii-guard.test.ts（全 PASS で exit 0）
import {
  examplePiiReason, sanitizeExampleText, sanitizeExampleFields, redactExampleSpansInPrompt, mightHaveExamplePii,
  APPLICATION_FORM_PLACEHOLDER, STAFF_PII_PLACEHOLDER, PERSONAL_DOCUMENT_PLACEHOLDER,
} from "../example-pii-guard";
import { redactExamplePiiInJsonBody, wrapFetchWithLlmSanitizer } from "../llm-request-sanitize";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// ── 作り物の実例 ──
const FILLED_FORM = [
  "よろしくお願いします",
  "【個人申込用】",
  "・入居希望日　11月1日",
  "・氏名、フリガナ　山田太郎、ヤマダタロウ",
  "・生年月日　1998.4.12",
  "・現住所 〒（必須）　530-0001 大阪府大阪市北区梅田1-2-3",
  "・住居年数　3年",
  "・携帯番号　090-1234-5678",
  "・メールアドレス　taro.yamada@example.com",
  "・勤務先名　株式会社サンプル",
  "・年収　350万",
].join("\n");
const BLANK_FORMAT = [
  "ありがとうございます！！",
  "お申込みのフォーマットをお送りします😊！！",
  "【個人申込用】",
  "・入居希望日",
  "・氏名、フリガナ",
  "・生年月日",
  "・現住所 〒（必須）",
  "・携帯番号",
  "・メールアドレス",
  "・勤務先名",
  "・勤続年数",
  "・年収",
].join("\n");
const ID_REQUEST = "お申込みには本人確認書類（運転免許証・マイナンバーカード）の裏表のお写真と、氏名・生年月日・住所が分かる物をお送りください😊！！";
const PROPERTY_TEXT = "🌟サンプルマンション 302\n家賃65,000円\n2015年3月10日築（築10年）\n住所：大阪府大阪市西区1-2-3\n管理会社 06-1234-5678";
const LICENSE = "[画像] 運転免許証\n氏名 山田 太郎\n平成10年4月12日生\n住所 大阪府大阪市北区梅田1-2-3\n交付 令和5年5月1日\n大阪府公安委員会";
const STAFF_FORWARD = "管理会社様\n山田太郎（ヤマダタロウ）様のお申込みです\n【申込者】\n勤務先 株式会社サンプル\n勤続 3年\n年収 350万円\n〒530-0001 大阪府大阪市北区梅田1-2-3";

console.log("── 判定（当てる物）");
{
  const h = examplePiiReason(FILLED_FORM);
  t("記入済みの申込フォーム → application_form", h?.kind === "application_form", JSON.stringify(h));
  t("身分証の書き起こし → id_document", examplePiiReason(LICENSE)?.kind === "id_document", JSON.stringify(examplePiiReason(LICENSE)));
  t("管理会社へ回した申込の情報（年収＋勤務先） → application_form", examplePiiReason(STAFF_FORWARD)?.kind === "application_form", JSON.stringify(examplePiiReason(STAFF_FORWARD)));
  t("携帯番号だけ → personal_value", examplePiiReason("電話番号は090-1111-2222です")?.kind === "personal_value");
  t("生年月日のラベル＋値 → personal_value", examplePiiReason("生年月日は1995年3月2日です")?.kind === "personal_value");
}

console.log("── 判定（当てない物＝誤検知の線）");
{
  t("空の申込フォーマット（スタッフが送る記入欄）は当てない", examplePiiReason(BLANK_FORMAT) === null, JSON.stringify(examplePiiReason(BLANK_FORMAT)));
  t("本人確認書類の依頼文は当てない", examplePiiReason(ID_REQUEST) === null, JSON.stringify(examplePiiReason(ID_REQUEST)));
  t("物件の資料（築年月日・物件の住所・管理会社の固定電話）は当てない", examplePiiReason(PROPERTY_TEXT) === null, JSON.stringify(examplePiiReason(PROPERTY_TEXT)));
  t("年収の目安の説明は当てない", examplePiiReason("審査は年収300万円以上が目安です😊！！") === null);
  t("入居希望日は当てない", examplePiiReason("2026年11月1日から入居希望です") === null);
  t("保存済みの見出し（中身なし）は当てない", examplePiiReason("[画像] 本人確認書類") === null);
}

console.log("── 伏せ方");
{
  const withCtx = `${FILLED_FORM}\n〔直前のAIX送信〕🌟サンプルマンション 302 のご案内`;
  const s = sanitizeExampleText(withCtx, "customer");
  t("お客様の記入済みフォーム → 伏せ字＋こちらの文脈の行は残す", s.changed && s.text.startsWith(APPLICATION_FORM_PLACEHOLDER) && s.text.includes("〔直前のAIX送信〕🌟サンプルマンション"), s.text);
  t("伏せた後に名前・番号・生年月日が残らない", !/山田|ヤマダ|090-1234|1998|taro\.yamada|梅田1-2-3/.test(s.text), s.text);
  t("伏せた後の文は判定に当たらない", examplePiiReason(s.text) === null);
  const st = sanitizeExampleText(STAFF_FORWARD, "staff");
  t("こちらの文 → 申込の情報の伏せ字", st.text === STAFF_PII_PLACEHOLDER, st.text);
  const doc = sanitizeExampleText(LICENSE, "customer");
  t("身分証 → 個人の書類の伏せ字", doc.text === PERSONAL_DOCUMENT_PLACEHOLDER, doc.text);
  const v = sanitizeExampleText("こちらにお電話ください 080-2222-3333 よろしくお願いします", "customer");
  t("値だけ → 値だけ伏せて文は残す", v.changed && v.text.includes("よろしくお願いします") && !v.text.includes("080-2222-3333"), v.text);
  const ok = sanitizeExampleText(BLANK_FORMAT, "staff");
  t("空のフォーマットは変えない", !ok.changed && ok.text === BLANK_FORMAT);
}

console.log("── 入口（sanitizeExampleFields）");
{
  const r = sanitizeExampleFields({ customer_message: FILLED_FORM, sent_reply: "ありがとうございます！！確認致します😊！！", ai_draft: null }, {});
  t("customer_message だけ伏せる", r.fields.customer_message === APPLICATION_FORM_PLACEHOLDER && r.fields.sent_reply === "ありがとうございます！！確認致します😊！！" && r.hits.length === 1, JSON.stringify(r));
  const off = sanitizeExampleFields({ customer_message: FILLED_FORM }, { EXAMPLE_PII_SAVE_GUARD: "off" });
  t("EXAMPLE_PII_SAVE_GUARD=off で今まで通り", off.fields.customer_message === FILLED_FORM && off.hits.length === 0);
}

console.log("── 出口（プロンプトの手本だけ伏せる）");
{
  const prompt = [
    "【今の会話】",
    "お客様: 子ども不可ですか？",
    "",
    "【⭐ スモラの実際の返信例（状況が最も類似した実例・類似度順）】",
    `[例1]\nお客様: 「${FILLED_FORM}」\nスモラ: 「ありがとうございます！！確認致します😊！！」`,
    "",
    `[例2]\nお客様:「ペット可ですか？」\nスモラ:「「サンプルマンション」はペット可となっております😊！！」`,
    "",
    `[例3]\nお客様: 「よろしくお願いします」\nスモラ: 「${STAFF_FORWARD}」`,
    "",
    `[お客様の状況] 「${FILLED_FORM}」`,
  ].join("\n");
  const r = redactExampleSpansInPrompt(prompt);
  t("3か所伏せる（例1のお客様・例3のスモラ・状況）", r.redacted === 3, String(r.redacted));
  t("名前・番号・生年月日・年収が残らない", !/山田|ヤマダ|090-1234|1998\.4|350万/.test(r.text), r.text);
  t("今の会話・普通の手本（例2・中の「」も）はそのまま", r.text.includes("お客様: 子ども不可ですか？") && r.text.includes("スモラ:「「サンプルマンション」はペット可となっております😊！！」"));
  t("手本の形は保つ（お客様: 「伏せ字」\\nスモラ: 「…」）", r.text.includes(`お客様: 「${APPLICATION_FORM_PLACEHOLDER}」\nスモラ: 「ありがとうございます！！確認致します😊！！」`));
  const brain = `【成約した会話の実際の返信例（現フェーズ:applying優先）】\n- [成約] (applying段階) 「${STAFF_FORWARD.replace(/\n/g, " ")}」\n- [申込] (viewing段階) 「ご内覧ありがとうございました！！」`;
  const rb = redactExampleSpansInPrompt(brain);
  t("ブレインの成約の返信例（1行の形）も伏せる・他の行はそのまま", rb.redacted === 1 && !/350万|山田/.test(rb.text) && rb.text.includes("「ご内覧ありがとうございました！！」"), rb.text);
  const plain = "お客様: 「ペット可ですか？」\nスモラ: 「可能です！！」";
  t("個人情報が無ければ文字列は同一（キャッシュを壊さない）", redactExampleSpansInPrompt(plain).text === plain);
  t("今の会話の申込フォーム（鉤括弧の無い形）には触らない", redactExampleSpansInPrompt(`お客様: ${FILLED_FORM}`).redacted === 0);
}

console.log("── 出口（fetch の本文）");
{
  const body = JSON.stringify({ model: "x", system: [{ type: "text", text: "ルール", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: `[例1]\nお客様: 「${FILLED_FORM}」\nスモラ: 「了解です！！」` }] }] });
  t("速い判定が当たる", mightHaveExamplePii(body));
  const r = redactExamplePiiInJsonBody(body, {});
  t("JSON の中の手本を伏せる", r.redacted === 1 && !r.body.includes("090-1234-5678") && JSON.parse(r.body).system[0].cache_control.type === "ephemeral", r.body.slice(0, 200));
  t("EXAMPLE_PII_GUARD=off で素通し", redactExamplePiiInJsonBody(body, { EXAMPLE_PII_GUARD: "off" }).body === body);
  const clean = JSON.stringify({ messages: [{ role: "user", content: "お客様: 「ペット可ですか？」\nスモラ: 「可能です」" }] });
  t("個人情報が無い本文は同一の文字列", redactExamplePiiInJsonBody(clean, {}).body === clean);
}

// ─── 2026-10-09 ラベル無しの住所（監査 scripts/audit-example-pii-unlabeled-address.ts の実物の形・氏名と住所は作り物に置き換えた）───
{
  const FAMILY = "山田花子ヤマダハナコ 〇〇年〇月〇日 兵庫県神戸市中央区港島11-22 知らない 〇〇〇-〇〇〇〇-〇〇〇〇 母 専業主婦";
  const FAMILY_RAW_BIRTH = "山田太郎ヤマダタロウ 1960.4.1 兵庫県神戸市中央区港島11-22 知らない 知らない 父 自営業(タクシー) 自宅";
  t("ご家族の情報の並び（伏せ済みの値＋続柄）→ 塊ごと伏せる", examplePiiReason(FAMILY)?.kind === "application_form" && sanitizeExampleText(FAMILY, "customer").text === APPLICATION_FORM_PLACEHOLDER);
  t("西暦の生年月日のまま＋続柄・職業", examplePiiReason(FAMILY_RAW_BIRTH)?.kind === "application_form");
  t("こちらの文に引用された時も塊ごと（スタッフ側の伏せ字）", sanitizeExampleText(`${FAMILY}\n前回頂いております緊急連絡先のご情報でお母様のお名前がお父様のお名前になっております。`, "staff").text === STAFF_PII_PLACEHOLDER);
  const VISIT = "はい！！ 大丈夫です😊！！ お伺いさせていただくご住所枚方市岡本町7-8-9でよろしいでしょうか！！";
  const v = sanitizeExampleText(VISIT, "staff");
  t("お客様の自宅（ご住所）だけの文 → 住所だけ伏せる", examplePiiReason(VISIT)?.kind === "personal_value" && v.changed && !v.text.includes("7-8-9") && v.text.includes("でよろしいでしょうか"), v.text);
  t("★ 待ち合わせの住所（住所: の後）は伏せない", examplePiiReason("15:00に現地エントランス前お待ち合わせで何卒よろしくお願い致します！！ 住所: 大阪府大阪市淀川区西中島2丁目14-20") === null);
  t("★ 物件資料の所在地は伏せない", examplePiiReason("号室名：402（4階部分） 所在地：大阪府大阪市淀川区十三東1丁目10-5 交通：阪急京都線") === null);
  t("★ 弊社の住所の案内は伏せない（ご住所の言い方でも）", examplePiiReason("レターパックをお送りさせていただくご住所は 大阪市中央区瓦町3-4-10 日宝御堂ビル5F 蓮産業株式会社") === null);
  t("★ 事故物件サイトの投稿日（平成の日付）＋物件の住所は伏せない", examplePiiReason("[画像] 平成31年2月13日 大阪府大阪市浪速区数津西一丁目1-31 投稿年月日 平成31年2月13日") === null);
  t("★ 物件の一覧（住所＋築年）は伏せない", examplePiiReason("ジェイラピス ナンバ 大阪府大阪市浪速区元町３丁目10-20 築10年 / 9階 100,000円") === null);
  t("★ 職場の場所（宗右衛門町2-3から自転車）は伏せない", examplePiiReason("③職場が宗右衛門町2-3なのでそこから自転車で10分か") === null);
  t("出口: 手本の中のご家族の情報も伏せる", !redactExampleSpansInPrompt(`お客様: 「${FAMILY}」\nスモラ: 「お送り頂きありがとうございます！！」`).text.includes("港島11-22"));
  t("出口の速い判定に掛かる", mightHaveExamplePii(JSON.stringify({ c: `お客様: 「${FAMILY}」` })));
}

async function fetchCases() {
  console.log("── 出口（fetch の包み・DeepSeek の宛先も）");
  const seen: string[] = [];
  const fake = (async (_i: RequestInfo | URL, init?: RequestInit) => { seen.push(String(init?.body ?? "")); return new Response("{}"); }) as typeof fetch;
  const f = wrapFetchWithLlmSanitizer(fake);
  const body = JSON.stringify({ messages: [{ role: "user", content: `お客様: 「${FILLED_FORM}」\nスモラ: 「了解です！！」` }] });
  await f("https://api.anthropic.com/v1/messages", { method: "POST", body });
  await f("https://api.deepseek.com/v1/chat/completions", { method: "POST", body });
  await f("https://example.services.ai.azure.com/openai/v1/chat/completions", { method: "POST", body });
  await f("https://example.com/other", { method: "POST", body });
  t("Anthropic へ送る本文は伏せる", !seen[0].includes("090-1234-5678"));
  t("DeepSeek へ送る本文は伏せる", !seen[1].includes("090-1234-5678"));
  t("Azure の chat/completions も伏せる", !seen[2].includes("090-1234-5678"));
  t("LLM 以外の宛先は触らない", seen[3] === body);
}

fetchCases().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
