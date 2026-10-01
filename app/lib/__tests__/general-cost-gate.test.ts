// 実行: npx tsx app/lib/__tests__/general-cost-gate.test.ts
// 2026-10-02 竹内「見積・空室の断言ゲートの当てすぎを直す」: 一般の説明は見積金額内訳ゲートの対象外・特定のお部屋の金額は従来どおり止める
//   実送信（人の手打ち・AIX の生成文）の文をそのまま使う（scripts/audit-general-cost-gate.ts）
import { isGeneralCostExplanation, validateAndClean } from "../validate-reply";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }
const gate = (s: string) => validateAndClean(s, { aixGates: true, customerMessage: "大体お願いするといつもなんばから少し遠いとこですよね" });

for (const s of [
  "難波周辺の中央区浪速区の1LDK家賃相場は10万円から12万円となり、1Kの家賃相場が7万円から8万円程となります。",
  "ほとんどのお部屋を仲介手数料0円でご紹介可能ですが、中には仲介手数料をいただくお部屋もございます！",
  "都島区、旭区、城東区、鶴見区で家賃管理費込みで75,000円まで条件広げてお部屋探させていただきましたが現在エレベーター備わったお部屋は募集に出ておりませんでした。",
  "大阪市北区の1LDKの家賃相場は9万円から12万円程となります！",
]) {
  t(`一般の説明: ${s.slice(0, 28)}`, isGeneralCostExplanation(s));
  const r = gate(s);
  t(`  → 見積書の宣言に置き換えない`, r.cleaned === s && !r.issues.some((i) => /見積金額内訳/.test(i)), r.cleaned);
}
for (const s of [
  "イエヤスなら一般的な不動産業者より96,800円節約出来ます！",
  "こちらのお部屋は敷金としまして660,000円必要となりますが、敷金は退去時に精算されます！！",
  "🌟ハピネス岸里 104 家賃管理費込50,000円のワンルーム、2023年12月築の築浅物件となります！！",
  "こちら最終の最大限割引しました初期費用の御見積書となり合計で139,000円割引させて頂きます！！",
]) {
  t(`特定のお部屋の金額は対象外にしない: ${s.slice(0, 28)}`, !isGeneralCostExplanation(s));
  t(`  → 従来どおり見積金額内訳ゲート`, gate(s).issues.some((i) => /見積金額内訳|見積書カバー文/.test(i)), JSON.stringify(gate(s).issues));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
