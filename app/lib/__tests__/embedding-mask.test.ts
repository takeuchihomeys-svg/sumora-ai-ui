// 2026-09-13 RAG 監査: 埋め込み（OpenAI 送信・embedding_cache 保存）の前に個人情報を伏せ字にする
// 実行: npx tsx app/lib/__tests__/embedding-mask.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { maskForEmbedding, maskPII } from "../pii-mask";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const has = (s: string, sub: string) => { if (!s.includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} in ${JSON.stringify(s)}`); };
const not = (s: string, sub: string) => { if (s.includes(sub)) throw new Error(`expected not to contain ${JSON.stringify(sub)} in ${JSON.stringify(s)}`); };

const FORM = "・入居希望日8月1日\n・氏名、フリガナ仲 杏香果\n・生年月日2006年10月5日\n・現住所 〒567-0010 大阪府茨木市\n・携帯番号 09069025774\n・メール test@example.com";
it("申込フォームの電話・郵便番号・生年月日・メールを伏せる", () => {
  const m = maskForEmbedding(FORM);
  not(m, "09069025774"); not(m, "567-0010"); not(m, "2006年10月5日"); not(m, "test@example.com");
  has(m, "[電話番号非表示]"); has(m, "[日付非表示]");
});
it("12桁の番号（マイナンバー等）を伏せる", () => {
  const m = maskForEmbedding("個人番号 1234 5678 9012 です");
  not(m, "1234 5678 9012"); has(m, "[番号非表示]");
});
it("検索の意味（場面・物件名・金額）は残す", () => {
  const m = maskForEmbedding("[物件送付後] LIVIAZ NAMBA KRASS 1201号室 初期費用284,500円 猫がいるのでプラス67000になりますか？");
  has(m, "LIVIAZ NAMBA KRASS 1201号室"); has(m, "284,500円"); has(m, "67000"); has(m, "物件送付後");
});

// 2026-10-18 弱い所A-3
it("① 空白区切りの電話番号を伏せる（携帯・固定・全角空白・記号との混ざり）・桁が合わない物は触らない", () => {
  for (const x of ["080 1234 5678", "携帯 090　1234　5678 です", "06 1234 5678", "090-1234 5678"]) { const m = maskPII(x, []); has(m, "[電話番号非表示]"); not(m, "5678"); }
  for (const x of ["0 120 5", "家賃 1 500", "0123 4567 8901"]) { const m = maskPII(x, []); not(m, "[電話番号非表示]"); }
});
it("② 物件名に付いた素の部屋番号を伏せる（maskForEmbedding）・号室は今まで通り残す・金額・日数・回数・築年は触らない", () => {
  has(maskForEmbedding("Mv.fm大阪大正405の内覧"), "大正◯の");
  has(maskForEmbedding("- ルクレ堺筋本町レジデンス 303（未送付）"), "レジデンス ◯（");
  for (const x of ["管理費8000の", "敷金1000、礼金0", "家賃119,000円", "365日", "131回のうち", "築2005年", "徒歩15分"]) has(maskForEmbedding(x), x);
  has(maskForEmbedding("LIVIAZ NAMBA KRASS 1201号室"), "1201号室");
});
it("② maskPII（生成に渡す文）は部屋番号を触らない・スイッチで旧に戻る", () => {
  has(maskPII("Mv.fm大阪大正405の内覧", []), "大正405");
  const prev = process.env.PII_MASK_BARE_ROOM; process.env.PII_MASK_BARE_ROOM = "off";
  try { has(maskForEmbedding("Mv.fm大阪大正405の内覧"), "大正405"); } finally { if (prev === undefined) delete process.env.PII_MASK_BARE_ROOM; else process.env.PII_MASK_BARE_ROOM = prev; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
