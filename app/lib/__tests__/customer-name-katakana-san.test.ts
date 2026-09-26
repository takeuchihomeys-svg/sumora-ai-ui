// 2026-09-26 YUMA の前後比較（scripts/yuma-done-state-test.ts の S7）で発見:
//   enforceCustomerName の行頭の呼びかけの直し（②）が「テストハイツ梅田とサンプルコート中津」の「サン」を敬称と読み、
//   「YUMAさんプルコート中津」に書き換えて物件名を壊した（前の木でも後の木でも出る既存の不具合）。
//   片仮名の「サン」の直後に片仮名が続く物は語の一部 → 置き換えない。敬称の「サン」「さん」は従来どおり
// 実行: npx tsx app/lib/__tests__/customer-name-katakana-san.test.ts
import { enforceCustomerName } from "../validate-reply";

let passed = 0, failed = 0;
function check(name: string, got: string, want: string) {
  if (got === want) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`); }
}
const fix = (t: string) => enforceCustomerName(t, { customerName: "YUMA" }).cleaned;

// 実物（YUMA の生成・DeepSeek）: 2件の物件名を「と」でつないだ行
const s7 = "かしこまりました！！\nテストハイツ梅田とサンプルコート中津の駐車場の空き状況確認させて頂きます！！";
check("「〇〇とサン＋片仮名」の物件名は壊さない", fix(s7), s7);
const sunHeights = "かしこまりました！！\nエステムコート梅田とサンハイツ中津どちらも募集中となります！！";
check("サンハイツ（実在しうる形）も壊さない", fix(sunHeights), sunHeights);
// 従来どおり直す物（敬称のサン・さん）
check("行頭の崩れた呼びかけ（サン＋記号）は従来どおり直す", String(fix("てすとアカウント🌸サン！！\nお世話になっております！！").startsWith("YUMAさん")), "true");
check("行頭の崩れた呼びかけ（さん）は従来どおり直す", String(fix("てすとアカウント🌸さん\nお世話になっております！！").startsWith("YUMAさん")), "true");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
