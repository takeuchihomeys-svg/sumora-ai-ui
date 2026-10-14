// 2026-10-14 P0 89bc2c3e「漢字は必ず日本語の漢字」— 読み取りの出力の中国の字形を日本の字形に直す（ja-kanji.ts）
// 実行: npx tsx app/lib/__tests__/ja-kanji.test.ts
import { toJapaneseKanji, toJapaneseKanjiCount, jaKanji, jaKanjiDeep, CHINESE_FORM_RE, JA_KANJI_INSTRUCTION } from "../ja-kanji";
import { parseReadResult, parseDetailResult, parseTranscript, PROPERTY_IMAGE_PROMPT, PROPERTY_IMAGE_DETAIL_PROMPT, PROPERTY_IMAGE_TRANSCRIBE_PROMPT } from "../property-image-read";
import { parseSheetImageFacts, SHEET_COMMON_HEAD } from "../sheet-prompt";
import { PROPERTY_TEXT_DETAIL_SYSTEM, PROPERTY_TRANSCRIPT_DETAIL_SYSTEM } from "../property-detail-source";
import { parseExtractVacancyResponse, extractVacancyDateSystem } from "../extract-vacancy-date-prompt";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

console.log("■ 保存済みの読み取りに実際にあった字（2026-10-14 の全件）");
t("1住戶 → 1住戸", toJapaneseKanji("駐輪場: 1住戶1台のみ") === "駐輪場: 1住戸1台のみ");
t("浴室內 → 浴室内", toJapaneseKanji("洗面台(浴室內)") === "洗面台(浴室内)");
t("1住户 → 1住戸", toJapaneseKanji("駐輪場: 無料(1住户2台迄)") === "駐輪場: 無料(1住戸2台迄)");
t("総戶数 → 総戸数", toJapaneseKanji("総戶数 12") === "総戸数 12");
console.log("■ 竹内さんが挙げた字（区→區・駅→驿・楽→乐・様→样・広→广・浜→滨・话・费）");
t("區 → 区", toJapaneseKanji("大阪市北區") === "大阪市北区");
t("驿 → 駅", toJapaneseKanji("梅田驿 徒歩5分") === "梅田駅 徒歩5分");
t("驛 → 駅", toJapaneseKanji("梅田驛") === "梅田駅");
t("乐 → 楽", toJapaneseKanji("楽器: 乐器不可").includes("楽器不可"));
t("样 → 様", toJapaneseKanji("〇〇样") === "〇〇様");
t("广 → 広", toJapaneseKanji("广い") === "広い");
t("滨 → 浜", toJapaneseKanji("尼崎市滨田町") === "尼崎市浜田町");
t("话 → 話", toJapaneseKanji("电话") === "電話");
t("费 → 費", toJapaneseKanji("管理费") === "管理費");
t("数を返す", toJapaneseKanjiCount("电话 费").changed === 3);
console.log("■ 日本の名前に普通にある旧字は直さない（資料の文字層にもある）");
for (const s of ["淺沼谷町マンション", "龍の樹マンション", "リベルテコーポ保澤", "高濱エルガンス", "TIO四條畷", "シティライフ有萬", "眞柄ビル", "髙松エステート", "川﨑様平屋", "國分町"]) {
  t(`そのまま: ${s}`, toJapaneseKanji(s) === s, toJapaneseKanji(s));
}
console.log("■ 日本の字・かな・英数字・記号は1字も変えない");
const jp = "エステムコート梅田・天神橋Ⅱ 1LDK 42.11㎡ 敷金１ヶ月 礼金0円【ペット可】駐車場: 空有 （大阪市北区）";
t("変えない", toJapaneseKanji(jp) === jp);
t("空文字", toJapaneseKanji("") === "");
console.log("■ 互換漢字・部首の字");
t("康煕部首 ⼈⾞ → 人車", toJapaneseKanji("駐⾞場 2⼈入居") === "駐車場 2人入居");
t("互換漢字 塚(FA10) → 塚", toJapaneseKanji("塚本") === "塚本");
t("﨑(FA11) はそのまま", toJapaneseKanji("川﨑") === "川﨑");
console.log("■ 戻す・深い値");
t("JA_KANJI_NORMALIZE=off でそのまま", jaKanji("1住戶", { JA_KANJI_NORMALIZE: "off" }) === "1住戶");
const deep = jaKanjiDeep({ a: "浴室內", b: ["1住戶", 3, null], c: { d: "驿" } });
t("形を変えずに中の文字だけ", JSON.stringify(deep) === JSON.stringify({ a: "浴室内", b: ["1住戸", 3, null], c: { d: "駅" } }), deep);
console.log("■ 読み取りの出口（parse）で直る");
const r = parseReadResult(JSON.stringify({ items: [{ property_name: "グランパシフィック北區", room_number: "302", station: "大國町驿", floor_plan: "1K" }], is_property: true }));
t("物件名", r.items[0]?.propertyName === "グランパシフィック北区", r.items[0]);
t("駅（驿だけ直す・國は地名の表で直す＝ここでは直さない）", r.items[0]?.station === "大國町駅", r.items[0]?.station);
const d = parseDetailResult(JSON.stringify({ kind: "property", lines: ["洗濯機置場: 浴室內", "駐輪場: 1住戶1台"] }));
t("条件の行", d.lines.join("|") === "洗濯機置場: 浴室内|駐輪場: 1住戸1台", d.lines);
const tr = parseTranscript("【物件の資料】\n総戶数: 12戶\n备考: 9/30退去予定");
t("書き写し", tr.kind === "property" && tr.body === "総戸数: 12戸\n備考: 9/30退去予定", tr);
const sf = parseSheetImageFacts(JSON.stringify({ see: "中央の間取り図。洗面台は浴室內", note: "1住戶", fp_ok: true }));
t("画像で分析（see・note）", sf?.see === "中央の間取り図。洗面台は浴室内" && sf?.note === "1住戸", sf);
const ev = parseExtractVacancyResponse(JSON.stringify({ propertyName: "セレニテ梅田驿前 302号室", fields: ["备考: 9/30退去予定"] }));
t("物件確認の読み取り（物件名・欄）", ev.propertyName === "セレニテ梅田駅前 302号室" && ev.fields?.[0] === "備考: 9/30退去予定", ev);
console.log("■ 読み取りの指示に必ず入っている（d6d4d331: 中国の字形の例は書かない）");
for (const [n, p] of [["物件名", PROPERTY_IMAGE_PROMPT], ["条件の行", PROPERTY_IMAGE_DETAIL_PROMPT], ["書き写し", PROPERTY_IMAGE_TRANSCRIBE_PROMPT], ["画像で分析", SHEET_COMMON_HEAD], ["文字層", PROPERTY_TEXT_DETAIL_SYSTEM], ["書き写しの文字", PROPERTY_TRANSCRIPT_DETAIL_SYSTEM], ["物件確認", extractVacancyDateSystem({})]] as const) {
  t(`${n}: 指示あり`, p.includes(JA_KANJI_INSTRUCTION));
}
t("指示に中国の字形が無い", !CHINESE_FORM_RE.test(JA_KANJI_INSTRUCTION));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
