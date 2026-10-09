// app/lib/__tests__/image-label.test.ts
// 2026-10-01 竹内「送られてきた画像が物件なのか、物件以外なのか分かるためにも、画像分析したのを
//   今ある本人確認書類のように文字に出しといたら、文やAIXでの判断の質が上がる」
// 実行: npx tsx app/lib/__tests__/image-label.test.ts（全 PASS で exit 0）
// 本文は実データ（messages.text・お客様の画像）の形そのもの。氏名・住所・番号は伏せてある
import { readFileSync } from "node:fs";
import {
  parseVisionTypeOutput, splitLeakedTypeLine, classifyCustomerImage, labeledImageText,
  savedImageKind, stripImageLabel, customerImageGroup, IMAGE_KIND_LABEL,
} from "../image-label";
import { imageTextForSave, imageTypeForSave, ID_DOCUMENT_TEXT } from "../id-document-guard";
import { extractScreenshotProperty } from "../own-property-match";
import { countCustomerSentProperties } from "../customer-property-count";
import { classifyImageTranscript } from "../condition-source-gate";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const head = (s: string) => s.split("\n")[0];

// ── 実データの書き起こし ──
const MAISOKU = "物件種目：【住居用】マンション\n物件名：レオンコンフォート難波クレア\n号室名：503（5階部分）\n所在地：〒556-00XX 大阪府大阪市浪速区…\n賃料：65,000円";
const PORTAL = "3:39\n4G 76%\n\n物件情報\n\nアドバンス難波南ワイズ2階\n\n1/20\n\n6.4万円/管理費 4700円\n敷 - 礼 -\n\n間取り：1K　広さ：22.62㎡";
const TIKTOK = "1:24\n\n【検索画面】\n関連するコンテンツを見つける 検索\n\n【物件情報投稿】\nギガ賃貸・8-2\n\n難波駅徒歩4分！デザイナーズ1LDK❤️🏢\n【物件no.84】";
const ESTIMATE = "御見積書\n様\n\n2026年9月2日\n\nこの度は、〇〇株式会社をご利用頂きまして有り難うございました。";
const RECEIPT = "インターネット受付 払込受領証（お客様控え）\n\n受付日時：2026年 9月 4日 時間 16時 32分";
const DOG = "この画像にはテキストや会話が含まれていません。茶色と白色の毛並みを持つ犬が、木目調のフローリングの部屋で立っており、背景には白いドアフレームと水色の壁が見えます。";
const PERSON = "この画像は人物の顔写真です。テキストや会話、文書情報は含まれていません。";
const DEFECT = "項目追加\n\n不具合箇所のある場所 【必須】\n玄関\n\n不具合のある設備 【必須】\n不具合のある設備をご記入ください。";
const KIMAROOM = "16:34\n通話時間: 20分\n\nsigner.sign.kimaroom.jp\n\nキマルーム\n電子契約　　　賃貸借契約\n\n物件名\nヴィオラ〇〇 302";
const OTHER_AGENT = "お世話になっております。\nハウスコム〇〇店の〇〇です。\n近隣の駐車場が満車で見つかっておりません。";
const ROUTE = "15:55\n\n15:58→16:06（8分）9月6日（日）\nIC優先 240円 乗換0回 4.0km\n\nルートメモ、スクショ、共有";
const RABIES = "狂犬病予防注射済証\n\n第　号\n\n所有者(管理者)住所 京都市〇〇区〇〇町\n氏名　〇〇〇〇\n\n生年月日　2017.7.22";
const WATER = "16:25 11分通話中 52秒\n\n申込み完了\n\nこの度はお申込みをいただき誠にありがとうございます。\n浄水カートリッジ定期交換のお申込みを受け付けました。";
const ORGAN = "備考\n\n下の部分を使用して臓器提供に関する意思を表示することができます。(記入は自由です。)\n1. 私は、脳死後及び心臓が停止した死後のいずれでも、移植のために臓器を提供します。";
const ORGAN_MISREAD = "備　考\n\n以下の部分を使用して脳死提供に関する意思を表示することができます(記入は自由です)。\n1. 私は、脳死及び心臓が停止した死体のいずれでも";
const SHIKAKU = "【注意事項】\n有効期間中であっても、退職等の事由により継続被保険の資格を喪失した場合は、\nこの资格確認書は使用できません。\n\n住所";
const KOREAN = "[縦向き書類の韓国語テキスト]\n\n주민등록번호\n[개인식별정보 포함]";
const GUARANTOR = "【書類内容の転記】\n\n■賃貸人(乙)情報\n現在住所：〒721-0000 広島県〇〇市〇〇1-1-1\n氏名：〇〇\n\n■内連帯保証人情報\n現在住所：〒721-0000 広島県〇〇市\n氏名：〇〇";
const WEB_FORM = "20:00\n\n(株)〇〇管理　　〇〇さま\n\n入居予定者さま情報\n\n入居予定者①\n\n個人契約申込者\n\n氏名\n〇〇\n\n氏名フリガナ\n〇〇\n\n生年月日\n西暦　1997年　06月　10日";
const STORE_INFO = "17:38\n\n物件情報\n\n店舗情報\n\n取り扱い店舗：（株）〇〇\n\n営業時間/定休日：午前9:30～午後17:30/毎週水曜日";

console.log("── ★ Vision の返事の解析（TYPE の取りこぼしで書き起こしが残らない）");
{
  const a = parseVisionTypeOutput("TYPE: floor_plan\n物件名：〇〇");
  t("「TYPE: x」", a.imageType === "floor_plan" && a.content === "物件名：〇〇");
  const b = parseVisionTypeOutput("id_document\n\n【賃借人（乙）】\n現在住所：〒…");
  t("★ 「TYPE:」なしの「id_document」だけ（実データ fcd8b36b の形）", b.imageType === "id_document" && !b.content.startsWith("id_document"), JSON.stringify(b));
  t("「**TYPE:** other」", parseVisionTypeOutput("**TYPE:** other\n本文").imageType === "other");
  t("全角コロン", parseVisionTypeOutput("TYPE：estimate\n御見積書").imageType === "estimate");
  t("同じ行の続きは書き起こしに戻す", parseVisionTypeOutput("TYPE: other 物件名：〇〇").content === "物件名：〇〇");
  t("種類の行が無ければ other・全文が書き起こし", (() => { const r = parseVisionTypeOutput("この画像は…"); return r.imageType === "other" && r.content === "この画像は…"; })());
  t("一覧に無い TYPE の行は捨てる", (() => { const r = parseVisionTypeOutput("TYPE: screenshot\n本文"); return r.imageType === "other" && r.content === "本文"; })());
  t("空は空", parseVisionTypeOutput("").imageType === "" && parseVisionTypeOutput(null).content === "");
  t("書き起こしの1行目が物件名（Floor のような英単語）でも種類にしない", parseVisionTypeOutput("Floor plan 1K\n洋室").imageType === "other");
  const leak = splitLeakedTypeLine("id_document\n\n備考：令和〇年…");
  t("★ 保存済みの行に残った種類の行を外す", leak.leakedType === "id_document" && leak.content.startsWith("備考"));
  t("普通の書き起こしは外さない", splitLeakedTypeLine("物件情報\n〇〇").leakedType === null);
}

console.log("── ★ 物件の画像（Vision の分類はそのまま採る・中の種類を指紋で分ける）");
{
  t("マイソク → 物件の資料", classifyCustomerImage("floor_plan", MAISOKU) === "property_material");
  t("ポータルの画面 → 物件の画面（ポータル）", classifyCustomerImage("property_photo", PORTAL) === "property_screen");
  t("自社の TikTok → 物件の画面（SNS・広告）", classifyCustomerImage("floor_plan", TIKTOK) === "property_ad");
  t("文字の無い室内写真 → 物件の写真", classifyCustomerImage("property_photo", "この画像にはテキストが含まれていません。フローリングの洋室の写真です。") === "property_photo");
  t("★ 分類なし（昔の行）のポータルも物件の画面", classifyCustomerImage(null, PORTAL) === "property_screen");
  t("★ 分類 other の TikTok も物件の画面（SNS・広告）", classifyCustomerImage("other", TIKTOK) === "property_ad");
  t("見積書", classifyCustomerImage("estimate", ESTIMATE) === "estimate");
  t("★ 見積書と分類された払込受領証 → 振込・支払いの控え", classifyCustomerImage("estimate", RECEIPT) === "payment");
}

console.log("── ★ 物件以外（分類 other の実物）");
{
  t("犬の写真", classifyCustomerImage("other", DOG) === "pet_photo");
  t("人物の写真", classifyCustomerImage("other", PERSON) === "person_photo");
  t("不具合の報告", classifyCustomerImage("other", DEFECT) === "defect_report");
  t("電子契約の画面（物件名があっても手続き）", classifyCustomerImage("other", KIMAROOM) === "procedure");
  t("他社の担当者からの文面 → やり取りのスクショ", classifyCustomerImage("other", OTHER_AGENT) === "chat");
  t("乗換案内", classifyCustomerImage("other", ROUTE) === "route");
  t("★ 浄水器の申込み完了は検索条件の画面にしない（旧の条件の判定は語の数で当たった）", classifyCustomerImage("other", WATER) === "procedure");
  t("★ 迷う物は【種類不明】（ポータルの店舗情報＝家賃・間取りが無い）", classifyCustomerImage("other", STORE_INFO) === "unknown");
  t("文字の無い写真で何か分からない物は【種類不明】", classifyCustomerImage("other", "この画像にはテキストが含まれていません。夕方の空の写真です。") === "unknown");
}

console.log("── ★ 保存する本文の形");
{
  t("物件は見出し＋書き起こし", labeledImageText("property_material", MAISOKU) === `[画像] 【物件の資料】\n${MAISOKU}`);
  t("★ ペットの書類は書き起こしを残さない", labeledImageText("pet_document", RABIES) === "[画像] 【物件以外：ペットの書類】");
  t("★ 書き起こしが空なら「[画像]」のまま（読み取り前の判定 text='[画像]' を壊さない）", labeledImageText("unknown", "") === "[画像]");
  t("imageTextForSave も同じ", imageTextForSave("other", DOG) === `[画像] 【物件以外：ペットの写真】\n${DOG}`);
  t("★ 狂犬病の注射済証は氏名・住所を残さない", imageTextForSave("other", RABIES) === "[画像] 【物件以外：ペットの書類】" && !/京都市|氏名/.test(imageTextForSave("other", RABIES)));
  t("本人確認書類は従来の形のまま（見出しを足さない）", imageTextForSave("id_document", "氏名：〇〇") === ID_DOCUMENT_TEXT);
  t("見出しの文字は received-document の書類名の語を含まない", !Object.values(IMAGE_KIND_LABEL).some((l) => /申込書|口座|保険|免許|マイナンバー|住民票|通帳|収入証明/.test(l)));
}

console.log("── ★ 個人情報の取りこぼし（分類 other / 無しで全文が残っていた実物）");
{
  t("★ 免許証・保険証の裏（臓器提供の欄）", imageTextForSave("other", ORGAN) === ID_DOCUMENT_TEXT);
  t("★ 「臓器」を「脳死」と読み違えた形", imageTextForSave(null, ORGAN_MISREAD) === ID_DOCUMENT_TEXT);
  t("★ 健康保険の資格確認書", imageTextForSave("other", SHIKAKU) === ID_DOCUMENT_TEXT);
  t("★ 韓国の住民登録", imageTextForSave("other", KOREAN) === ID_DOCUMENT_TEXT);
  t("★ 「id_document」の行が残った保証会社の申込書（旧の解析の漏れ）", imageTextForSave("other", "id_document\n\n【賃借人（乙）】\n現在住所：〒721-0000 広島県〇〇市\n氏名（商号・代表者）：〇〇") === ID_DOCUMENT_TEXT);
  t("★ その image_type は id_document", imageTypeForSave("other", "id_document\n\n【賃借人（乙）】\n現在住所：〒…") === "id_document");
  t("★ 保証会社の申込書（現在住所＋氏名＋連帯保証人）→ 申込書", imageTextForSave("other", GUARANTOR) === "[画像] 申込書");
  t("★ 入居申込のウェブフォーム（フリガナ＋生年月日の値）→ 申込書", imageTextForSave("other", WEB_FORM) === "[画像] 申込書");
  t("「other」の行が残った物件資料は見出し＋書き起こし（種類の行は外す）",
    imageTextForSave("other", "floor_plan\n\n" + MAISOKU) === `[画像] 【物件の資料】\n${MAISOKU}`);
  // 誤爆しない（物件の資料の必要書類欄・所在地）
  t("物件資料の『所在地：〒』は申込書にしない", imageTextForSave("floor_plan", MAISOKU).startsWith("[画像] 【物件の資料】"));
}

console.log("── ★ 保存済みの本文から読む（ブレイン・物件の数・物件名の取り出し）");
{
  const dogText = imageTextForSave("other", DOG);
  const portalText = imageTextForSave("property_photo", PORTAL);
  t("見出しの種類を読む", savedImageKind(dogText) === "pet_photo" && savedImageKind(portalText) === "property_screen");
  t("書き起こしの【物件no.84】は見出しにしない", savedImageKind(`[画像] 【物件no.84】\n…`) === null);
  t("見出しの行を外す", stripImageLabel("【物件の資料】\n物件名：〇〇") === "物件名：〇〇");
  t("見出しでない【】は外さない", stripImageLabel("【物件概要】\n…").startsWith("【物件概要】"));
  t("区分: 物件以外", customerImageGroup(dogText, "other") === "non_property");
  t("区分: 物件（分類 other でも見出しで）", customerImageGroup(imageTextForSave("other", PORTAL), "other") === "property");
  t("区分: 本人確認書類", customerImageGroup(ID_DOCUMENT_TEXT, "id_document") === "personal_document");
  t("区分: 見出しの無い昔の other は unknown", customerImageGroup("[画像] 何かの書き起こし", "other") === "unknown");
  t("区分: 読み取り前の「[画像]」は unknown", customerImageGroup("[画像]", null) === "unknown");
  t("区分: 画像でなければ null", customerImageGroup("こんにちは", null) === null);
  // own-property-match: 見出しの行を飛ばして物件名・号室を取る
  const mai = extractScreenshotProperty(imageTextForSave("floor_plan", MAISOKU));
  t("★ 物件名の取り出しは見出しがあっても同じ", mai?.name === "レオンコンフォート難波クレア" && mai?.room === "503", JSON.stringify(mai));
  const firstLine = extractScreenshotProperty(imageTextForSave("floor_plan", "ラクラス阿倍野元町 0507 6.4万円（省なし）(+共 8,000円)\n募集中"));
  t("★ 1行目の『名前 号室』も見出しの行を飛ばして取る", firstLine?.name === "ラクラス阿倍野元町" && firstLine?.room === "507", JSON.stringify(firstLine));
  t("物件以外からは取り出さない", extractScreenshotProperty(imageTextForSave("other", KIMAROOM)) === null);
  // 物件の数（AIX 物件確認した の件数）
  const turn = (texts: string[]) => texts.map((text) => ({ sender: "customer", text }));
  t("★ 犬の写真は物件に数えない", countCustomerSentProperties(turn([dogText])).count === 0);
  t("★ 本人確認書類は物件に数えない", countCustomerSentProperties(turn([ID_DOCUMENT_TEXT, "[画像] 収入証明書（給与明細）"])).count === 0);
  t("物件の画面・見出しの無い昔の画像は今までどおり数える", countCustomerSentProperties(turn([portalText, "[画像] 何か"])).count === 2);
  // 条件の読み取り（condition-source-gate）: 見出しは書き起こしではない
  t("条件の読み取りの種類は見出しがあっても同じ", classifyImageTranscript(portalText.replace(/^\[画像\]\s*/, "")) === classifyImageTranscript(PORTAL));
  t("見出しだけの本文は条件の画面にしない", classifyImageTranscript(head("【物件以外：検索条件の画面】")) === "image_other");
}

console.log("── ★ 支払いの控え・携帯番号（2026-10-09）");
{
  // 実データの形（名前・番号は伏せ・桁は保つ）
  const TRANSFER = "21:08↑\n\n5G 50\n\n振込完了 ⊃ログアウト\n\n振込を正常に受け付けました。\n\n振込先口座　GMOあおぞらネット銀行\n普通 1542253\n\n振込金額　100,000円\n\n引落口座　〇〇支店\n普通\n0000000\n\n振込依頼人名　ヤマダ　ハナコ";
  const MEISAI = "ご利用明細\n\n取扱店：イオン銀行\n取扱店番号：104\n利用日：2026.9.25\n時刻：（記載あり）\n\n銀行業務：店業務\n口座番号：000000000000****3\n\n振込み\nお振込金額：¥49,000\n\nお振替人：ヤマダ タロウ 様";
  const RECEIPT_FULL = "インターネット受付　払込受領証（お客様控え）\n\nお客様氏名：山田花子\n電話番号：090-0000-0000\n\nお申込商品代金：20,000円\n発行者：全管協少額短期保険";
  const OVERLAP = "複数の書類が重なった状態で撮影されており、以下のテキストが確認できます：\n- \"090-0000-0000\"という電話番号\n- \"初期費用明細書\" と思われるテキスト";
  const EST_FURIKOMI = "御見積書\n様\n\n尚、振り込み期日は厳守願います。\n\n御請求金額 ¥292,500\n\n物件名：ISM大阪城公園\n家　賃：150,000";
  const on = (k: string, v: string | undefined, f: () => void) => { const o = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; try { f(); } finally { if (o == null) delete process.env[k]; else process.env[k] = o; } };
  t("★ 振込完了の画面 → 見出しだけ（振込依頼人名・口座を残さない）", imageTextForSave("other", TRANSFER) === "[画像] 【物件以外：振込・支払いの控え】");
  t("★ ご利用明細（振込）→ 見出しだけ", imageTextForSave("other", MEISAI) === "[画像] 【物件以外：振込・支払いの控え】");
  t("★ 見積書と分類された払込受領証 → 見出しだけ（氏名・携帯を残さない）", imageTextForSave("estimate", RECEIPT_FULL) === "[画像] 【物件以外：振込・支払いの控え】");
  t("支払いの控えの見出しは読み戻せる（物件以外）", customerImageGroup(imageTextForSave("estimate", RECEIPT_FULL), "estimate") === "non_property");
  t("★ 見積書の「振り込み期日」は支払いの控えにしない（書き起こしを残す）", imageTextForSave("estimate", EST_FURIKOMI) === `[画像] 【見積書・初期費用の明細】\n${EST_FURIKOMI}`);
  t("★ 種類不明の書き起こしの携帯番号は伏せる", imageTextForSave("other", OVERLAP).includes("（携帯番号）") && !imageTextForSave("other", OVERLAP).includes("090-0000-0000"));
  t("物件の資料の業者の番号（06・0120）は伏せない", labeledImageText("property_material", MAISOKU + "\nTEL 06-1234-5678 / 0120-000-000").includes("06-1234-5678"));
  on("IMAGE_PAYMENT_DROP", "off", () => t("IMAGE_PAYMENT_DROP=off で旧の形（見出し＋書き起こし）", imageTextForSave("other", TRANSFER).startsWith("[画像] 【物件以外：振込・支払いの控え】\n")));
  on("IMAGE_MOBILE_MASK", "off", () => t("IMAGE_MOBILE_MASK=off で伏せない", imageTextForSave("other", OVERLAP).includes("090-0000-0000")));
}

console.log("── ★ つながり（webhook・ブレイン）");
{
  const webhook = readFileSync("app/api/line-webhook/route.ts", "utf8");
  t("webhook は parseVisionTypeOutput で読む", /parseVisionTypeOutput\(raw\)/.test(webhook) && !/raw\.match\(\/\^TYPE:/.test(webhook));
  t("webhook は imageTextForSave を通して保存", /imageTextForSave\(extractedType, extracted\)/.test(webhook));
  const brain = readFileSync("app/lib/brain-core.ts", "utf8");
  t("ブレインの画像だけの矯正は見積書・種類不明の時だけ", /customerImageGroup\(lastCustomerMsg\.text, lastCustomerMsg\.image_type\)/.test(brain));
  t("ブレインの信号3.5は物件以外で見積書にしない", /g === "non_property" \|\| g === "personal_document"\) return null/.test(brain));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
