// app/lib/__tests__/property-name-verbatim.test.ts — 2026-10-02 ⑫: 物件名はデータの字のまま（実行: npx tsx app/lib/__tests__/property-name-verbatim.test.ts）
import { enforceVerbatimPropertyNames, knownPropertyNamesFrom } from "../property-name-verbatim";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} -- ${extra}`); } };

const known = knownPropertyNamesFrom(["エグゼ難波西Ⅱの募集状況確認させていただきましたが、既にご契約が決まったお部屋となります！！", "🌟エグゼ難波西Ⅱ 202\n家賃管理費込68,000円"]);
t("🌟の見出しから名前を拾う", known.includes("エグゼ難波西Ⅱ"), JSON.stringify(known));
{
  // 実物（YUMA 再生 flow1_3db9db t05・DeepSeek の AIX【内覧調整】）
  const r = enforceVerbatimPropertyNames("かしこまりました😊！！\nエヴゼ峰渡西Ⅱ 202号室ご内覧可能です！！", known);
  t("化けた名前を元の字に直す", r.text.includes("エグゼ難波西Ⅱ 202号室") && r.fixes.length === 1, r.text);
}
{
  const r = enforceVerbatimPropertyNames("エグゼ難波西Ⅱ 202号室ご内覧可能です！！", known);
  t("正しい名前は触らない", r.fixes.length === 0 && r.text.includes("エグゼ難波西Ⅱ"));
}
{
  const k2 = ["エスリード難波", "エスリード長居"];
  const r = enforceVerbatimPropertyNames("エスリード長居503号室", k2);
  t("知っている別の名前そのものは直さない", r.fixes.length === 0, r.text);
  const r2 = enforceVerbatimPropertyNames("エスリード長堀のお部屋", k2);
  t("同じくらい近い名前が2つ以上なら直さない…ではなく近い方（長居/難波で差が同じなら直さない）", r2.fixes.length === 0 || r2.text.includes("エスリード長居"), JSON.stringify(r2));
}
{
  const r = enforceVerbatimPropertyNames("ご都合よろしいお日にち御座いますでしょうか😌！！", known);
  t("名前の無い文は変えない", r.fixes.length === 0);
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
