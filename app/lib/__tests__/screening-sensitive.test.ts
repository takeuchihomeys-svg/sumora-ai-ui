// 審査の事情の判定（screening-sensitive）のテスト（LLM なし・DB なし）
// 実行: npx tsx app/lib/__tests__/screening-sensitive.test.ts
// ⚠ 実際のお客様の文は使わない（言い換えた作り文だけ）
import { readFileSync } from "node:fs";
import {
  screeningSensitiveSignal, screeningSensitiveInMessages, screeningPiiClaudeEnabled, isScreeningCheckPattern,
  SCREENING_SENSITIVE_PREFILTER_WORDS,
} from "../screening-sensitive";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const hit = (t: string) => screeningSensitiveSignal(t);

console.log("当てる（お客様の打ち明け）");
const positives: Array<[string, string]> = [
  ["仕事は夜の方なので審査が心配です。夜職でも大丈夫でしょうか", "職業"],
  ["水商売をしていて給与明細が出せません", "職業"],
  ["今は無職で、来月から働く予定です", "職業"],
  ["同居する人がいま就活中です", "職業"],
  ["相方が外国籍なんですが契約できますか", "国籍"],
  ["在留カードの期限が来年までです", "国籍"],
  ["事情があって保証人が使えないです", "保証人"],
  ["連帯保証人がいないのですが", "保証人"],
  ["恋人の名義で審査を出したいです", "名義"],
  ["彼氏の名義でもいけますか", "名義"],
  ["親名義にするかもしれません", "名義"],
  ["昔カードの滞納があって", "借金"],
  ["自己破産していますが入れる所ありますか", "借金"],
  ["ブラックなんですが通りますか", "借金"],
  ["生活保護を受けています", "生活保護"],
  ["離婚調停中で別居しています", "家庭"],
];
for (const [t, cat] of positives) it(`当たる: ${t}`, () => { const h = hit(t); ok(h && h.category.includes(cat === "借金" ? "借金" : cat === "家庭" ? "家庭" : cat), `外れた: ${JSON.stringify(h)}`); });

it("10/20 の打ち明けの言い換え（夜の仕事・保証人・恋人の名義・外国籍・求職）", () => {
  ok(hit("審査の件ですが、こちら夜職で事情があり保証人が立てられないので、恋人の名義で通したいです。恋人は外国人で今は就活中です"), "外れた");
});

console.log("当てない（物件の条件・一般語）");
const negatives = [
  "保証会社はどこになりますか",
  "保証会社の審査はどれくらいかかりますか",
  "職場から近い所がいいです",
  "勤務先は梅田です",
  "外国人可の物件です",
  "外国籍OK・ペット相談",
  "外国人契約可能、2人入居可",
  "外国人受け入れ可・保証人不要",
  "保証人不要の物件を探しています",
  "保証人なし・初期費用分割可",
  "生活保護相談可の物件もあります",
  "水商売不可",
  "ブラックの家具が好きです",
  "ラウンジ付きのマンション",
  "名義変更の書類はどこに出せばいいですか",
  "審査通りますか？",
  "https://example.com/gaikokujin-ka/外国人",
];
for (const t of negatives) it(`当たらない: ${t}`, () => { const h = hit(t); ok(!h, `当たった: ${JSON.stringify(h)}`); });

console.log("会話の窓");
it("お客様の通は見る", () => ok(screeningSensitiveInMessages([{ sender: "staff", text: "こんにちは" }, { sender: "customer", text: "夜職です" }]), "外れた"));
it("印の無いスタッフの通は見ない（物件紹介の定型）", () => ok(!screeningSensitiveInMessages([{ sender: "staff", text: "夜職の方でもご入居いただけるお部屋です" }]), "当たった"));
it("AIX の審査の確認（mgmt_guarantor / mgmt_screening）は見る", () => {
  ok(screeningSensitiveInMessages([{ sender: "staff", text: "管理会社より、外国籍の方は在留カードが必要とのことです", checkPattern: "mgmt_guarantor" }]), "外れた");
  ok(isScreeningCheckPattern("mgmt_screening") && isScreeningCheckPattern("mgmt_guarantor") && !isScreeningCheckPattern("mgmt_pet") && !isScreeningCheckPattern(null), "印の判定");
});

console.log("スイッチ");
it("既定 on・off で止まる", () => {
  ok(screeningPiiClaudeEnabled({}) === true, "既定");
  ok(screeningPiiClaudeEnabled({ SCREENING_PII_CLAUDE: "off" }) === false, "off");
  ok(screeningPiiClaudeEnabled({ SCREENING_PII_CLAUDE: "OFF " }) === false, "OFF");
});

console.log("DB の先絞りの語");
it("当たる作り文はどれも先絞りの語を含む（取りこぼし 0）", () => {
  for (const [t] of positives) {
    if (!hit(t)) continue;
    ok(SCREENING_SENSITIVE_PREFILTER_WORDS.some((w) => t.toLowerCase().includes(w.toLowerCase())), `先絞りに無い: ${t}`);
  }
});

console.log("配線（ソースを読んで確かめる）");
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
it("generate-reply: 当たれば deepseekBlocked（申込以降と同じ blocked の印）", () => {
  const s = src("../../api/generate-reply/route.ts");
  const i = s.indexOf("screeningSensitiveInMessages([");
  const j = s.indexOf("const replyCutMark");
  ok(i > 0 && j > i, "replyCutMark の前で判定していない");
  ok(/if \(hit\) \{\s*deepseekBlocked = true;\s*deepseekCutActive = false;/.test(s), "blocked にしていない");
});
it("customer-memo: 当たれば LLM で読まない", () => ok(/reason: "screening_sensitive"/.test(src("../customer-memo-server.ts")), "止めていない"));
it("llm-alt-provider: learn_* は審査の事情があれば Claude", () => ok(/routeName\?\.startsWith\("learn_"\) && screeningPiiClaudeEnabled\(\)/.test(src("../llm-alt-provider.ts")), "門が無い"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
