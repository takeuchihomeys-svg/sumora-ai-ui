// app/lib/__tests__/customer-sent-property.test.ts
// 2026-10-14 竹内さん「お客さんから送られてきた物件の画像や物件 URL…お客さん毎の AIX ツールに転送」「本人確認書類と明確に分ける」
// 実行: npx tsx app/lib/__tests__/customer-sent-property.test.ts（全 PASS で exit 0）
// 本文は実データ（messages.text・お客様の画像／共有文）の形。氏名・住所・番号は伏せてある
import { readFileSync } from "node:fs";
import {
  customerImagePropertyGate, factsFromPropertyText, factsFromShareText, collectCustomerSentProperties, customerSentPropertyBlock,
  imageTextForDeepSeekRead, customerSentPropertyEnabled,
} from "../customer-sent-property";
import { buildRankPrompt } from "../pickup-rank";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

const PORTAL = "[画像] 【物件の画面（ポータル）】\n賃貸マンション 10階\n7.2万円 管理費 12,000円\n敷金 なし 礼金 1ヶ月\n1K / 26.75m²\n築12年\nお問い合わせ";
const MAISOKU = "[画像] 【物件の資料】\n物件種目：マンション\n物件名：エスリード〇〇\n号室名：502\n賃料 6.5万円 管理費 8,000円\n1K 25.3㎡\n地下鉄御堂筋線「本町」徒歩5分\n新築";
const ID = "[画像] 本人確認書類";
const INCOME = "[画像] 収入証明書（給与明細）";
const PORTAL_WITH_PII = "[画像] 【物件の画面（ポータル）】\n6.0万円 1K 22㎡\nお名前 〇〇\n生年月日 1990年1月1日";
const OLD_NO_HEAD_ID = "[画像] 氏名：〇〇 〇〇\n生年月日：平成2年1月1日\n住所：大阪市〇〇";
const UNKNOWN = "[画像] 【種類不明】\n何かの紙の写真";

console.log("── 線（customerImagePropertyGate）");
{
  t("物件の画面は通る", customerImagePropertyGate(PORTAL, "property_photo").ok);
  t("物件の資料は通る", customerImagePropertyGate(MAISOKU, "floor_plan").ok);
  const g1 = customerImagePropertyGate(ID, "id_document");
  t("本人確認書類は個人情報で落とす", !g1.ok && g1.reason === "personal");
  const g1b = customerImagePropertyGate(ID, null);
  t("本人確認書類（type なし・本文だけ）も落とす", !g1b.ok && g1b.reason === "personal");
  const g2 = customerImagePropertyGate(INCOME, "income_document");
  t("収入証明書は落とす", !g2.ok && g2.reason === "personal");
  const g3 = customerImagePropertyGate(PORTAL_WITH_PII, "property_photo");
  t("見出しが物件でも生年月日があれば落とす（Vision を信用しきらない）", !g3.ok && g3.reason === "personal");
  const g4 = customerImagePropertyGate(OLD_NO_HEAD_ID, "other");
  t("見出しの無い昔の行の身分証の書き起こしも落とす", !g4.ok && g4.reason === "personal");
  const g5 = customerImagePropertyGate(UNKNOWN, "other");
  t("種類不明は通さない（迷う物は通さない）", !g5.ok && g5.reason === "not_property");
  const g6 = customerImagePropertyGate("[画像]", null);
  t("読み取り前は通さない", !g6.ok && g6.reason === "unread");
  const g7 = customerImagePropertyGate("[画像] 【見積書・初期費用の明細】\n賃料 60,000円", "estimate");
  t("見積書は通さない（お客様の氏名が載る・好みの材料ではない）", !g7.ok);
  t("文字の発言は画像ではない", !customerImagePropertyGate("このお部屋いいです", null).ok);
}

console.log("── 物件の値（決定論）");
{
  const f = factsFromPropertyText(PORTAL.replace(/^\[画像\]\s*【[^】]+】\n/, ""));
  t("家賃 7.2万", f.rentYen === 72000, String(f.rentYen));
  t("管理費 12000", f.adminYen === 12000, String(f.adminYen));
  t("間取り 1K", f.madori === "1K", String(f.madori));
  t("広さ 26.75", f.areaSqm === 26.75, String(f.areaSqm));
  t("階 10", f.floor === 10, String(f.floor));
  t("築12年", f.ageYears === 12, String(f.ageYears));
  const m = factsFromPropertyText(MAISOKU.replace(/^\[画像\]\s*【[^】]+】\n/, ""));
  t("資料: 物件名", m.name === "エスリード〇〇", String(m.name));
  t("資料: 駅と徒歩", m.station === "本町" && m.walk === 5, `${m.station} ${m.walk}`);
  t("資料: 新築", m.ageYears === 0);
  const s1 = factsFromShareText("プルス新北野 3階\nhttps://suumo.jp/chintai/bc_100000000000/\nby SUUMO");
  t("SUUMO の共有文: 名前と階", s1.name === "プルス新北野" && s1.floor === 3, `${s1.name} ${s1.floor}`);
  const s2 = factsFromShareText("西大橋 1LDK 4階\nhttps://suumo.jp/chintai/jnc_000000000000/\nby SUUMO");
  t("名前の無い掲載（駅＋間取り）は名前にしない・駅にする", s2.name === null && s2.station === "西大橋" && s2.madori === "1LDK" && s2.floor === 4, JSON.stringify(s2));
  const s3 = factsFromShareText("地下鉄堺筋線 恵美須町 徒歩5分\n1R 5.2万円\n[詳細]\nhttps://myhome.nifty.com/rent/x");
  t("ニフティの共有文: 駅・徒歩・間取り・家賃", s3.station === "恵美須町" && s3.walk === 5 && s3.madori === "1R" && s3.rentYen === 52000, JSON.stringify(s3));
}

console.log("── 集める（一言・重複・個人情報）");
{
  const msgs = [
    { sender: "customer", text: ID, image_type: "id_document", created_at: "2026-10-10T01:00:00Z" },
    { sender: "customer", text: PORTAL, image_type: "property_photo", created_at: "2026-10-10T02:00:00Z" },
    { sender: "customer", text: "こういう感じのお部屋が良いです！", image_type: null, created_at: "2026-10-10T02:01:00Z" },
    { sender: "staff", text: "かしこまりました", image_type: null, created_at: "2026-10-10T02:05:00Z" },
    { sender: "customer", text: "プルス新北野 3階\nhttps://suumo.jp/chintai/bc_100000000000/\nby SUUMO", image_type: null, created_at: "2026-10-11T03:00:00Z" },
    { sender: "customer", text: "プルス新北野 3階\nhttps://suumo.jp/chintai/bc_100000000000/\nby SUUMO", image_type: null, created_at: "2026-10-11T03:02:00Z" },
    { sender: "customer", text: "ここは高いので無しです 090-1234-5678", image_type: null, created_at: "2026-10-11T03:03:00Z" },
    { sender: "customer", text: PORTAL_WITH_PII, image_type: "property_photo", created_at: "2026-10-12T03:00:00Z" },
  ];
  const r = collectCustomerSentProperties(msgs, { mask: (s) => s.replace(/0[789]0-\d{4}-\d{4}/g, "（電話番号）") });
  t("個人情報の画像は集めない（本人確認書類・生年月日つき）", r.stats.personal === 2, JSON.stringify(r.stats));
  t("物件は2件（同じ URL の2回は1件）", r.items.length === 2, String(r.items.length));
  t("新しい順（URL が先）", r.items[0]?.source === "url" && r.items[1]?.source === "image");
  t("一言を添える（向きは書かない）", (r.items[1]?.words ?? "").includes("こういう感じ") && (r.items[0]?.words ?? "").includes("無しです"));
  t("一言は伏せ字を掛ける", !(r.items[0]?.words ?? "").includes("090-1234"));
  t("こちらの発言は一言にしない", !(r.items[1]?.words ?? "").includes("かしこまりました"));
  const block = customerSentPropertyBlock(r.items) ?? "";
  t("ブロック: 見出し・値・一言", block.startsWith("【お客様が自分で送ってきた物件") && block.includes("7.2万円") && block.includes("プルス新北野 3階"));
  t("ブロックに生年月日・本人確認書類の中身が無い", !/生年月日|1990/.test(block));
  t("物件が無ければブロックなし", customerSentPropertyBlock([]) === null);
  const env = { ...process.env, CUSTOMER_SENT_PROPERTY: "off" };
  t("CUSTOMER_SENT_PROPERTY=off で止まる", customerSentPropertyEnabled(env) === false && customerSentPropertyEnabled({}) === true);
}

console.log("── 🌟 の文（条件の見出しの外に置く）");
{
  const cond = "家賃 8万円以内｜1K\n\n【お客様が自分で送ってきた物件（好みの参考）】\n- 10/10 画像: 7.2万円・1K";
  const p = buildRankPrompt(["【1】A", "【2】B"], cond, null);
  const iCond = p.indexOf("【お客様の希望条件（最優先で照らし合わせること）】");
  const iSent = p.indexOf("【お客様が自分で送ってきた物件");
  const iList = p.lastIndexOf("【物件一覧】");
  t("条件 → 送ってきた物件 → 物件一覧 の順", iCond >= 0 && iCond < iSent && iSent < iList);
  t("条件の見出しの中に送ってきた物件が入らない", !p.slice(iCond, iSent).includes("7.2万円"));
  const p2 = buildRankPrompt(["【1】A", "【2】B"], "家賃 8万円以内", null);
  t("送ってきた物件が無い時は今までどおり", !p2.includes("自分で送ってきた") && p2.includes("家賃 8万円以内"));
}

console.log("── 毎週の好みの読みに渡す画像の行");
{
  t("物件の画像は物件の値だけ", imageTextForDeepSeekRead(PORTAL, "property_photo") === "[画像] 【物件の画面（ポータル）】 10階・7.2万円（管理費 12,000円）・1K・26.75㎡・築12年", imageTextForDeepSeekRead(PORTAL, "property_photo"));
  t("本人確認書類はそのまま（種類だけ）", imageTextForDeepSeekRead(ID, "id_document") === ID);
  t("種類不明は見出しだけ（書き起こしを渡さない）", imageTextForDeepSeekRead(UNKNOWN, "other") === "[画像] 【種類不明】");
  t("見出しの無い身分証の書き起こしは渡さない", !imageTextForDeepSeekRead(OLD_NO_HEAD_ID, "other").includes("生年月日"));
  t("生年月日つきの物件の画面も渡さない", !imageTextForDeepSeekRead(PORTAL_WITH_PII, "property_photo").includes("生年月日"));
  t("文字の発言は変えない", imageTextForDeepSeekRead("駅近がいいです", null) === "駅近がいいです");
  t("CUSTOMER_PREF_IMAGE_GATE=off で旧", imageTextForDeepSeekRead(UNKNOWN, "other", { CUSTOMER_PREF_IMAGE_GATE: "off" }) === UNKNOWN);
}

console.log("── ★ つながり");
{
  const merge = readFileSync("app/api/merge-pdfs/route.ts", "utf8");
  t("merge-pdfs は会話 ID を渡して🌟の条件を作る", /loadRankConditions\(resolvedCustomerId, customer_conditions, convIdEff\)/.test(merge));
  const rank = readFileSync("app/lib/pickup-rank.ts", "utf8");
  t("pickup-rank は Anthropic を import しない（🌟は DeepSeek だけ）", !/@anthropic-ai|api\.anthropic\.com/.test(rank));
  const pref = readFileSync("app/lib/customer-pref-learning-server.ts", "utf8");
  t("毎週の好みの読みは画像の行を線に通す", /imageTextForDeepSeekRead\(String\(x\.text/.test(pref));
  const srv = readFileSync("app/lib/customer-sent-property-server.ts", "utf8");
  t("サーバーは申込の線を見る・伏せ字を掛ける", /loadDeepseekCutoff/.test(srv) && /filterAfterCutoff/.test(srv) && /maskPII/.test(srv));
  t("サーバーは画像を開かない（image_url を読まない）", !/image_url/.test(srv));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
