// scripts/__tests__/owner-base-nightly.test.ts — 毎晩の取りこぼしの網の拾い方（shouldPick）
// 実行: npx tsx scripts/__tests__/owner-base-nightly.test.ts
import { shouldPick } from "../owner-base-nightly-pick";
let passed = 0, failed = 0; const fails: string[] = [];
const ok = (n: string, c: boolean) => { if (c) passed++; else { failed++; fails.push(n); } };
ok("LINE の指摘は拾う", shouldPick("ここ本日といわれていても本日で占めると圧をかなり感じてしまう 名前をいれてサポートの姿勢をとる形", 0).pick);
ok("スクショつきの LINE の指摘は拾う", shouldPick("これ文おかしい かしこまりましたが２つ続いている", 1).pick);
ok("選択式の答えは拾う", shouldPick("１ おすすめ ２ はい ３ 状況による", 0).pick);
ok("進み具合の問いは拾わない", !shouldPick("今の作業全部完了するまでどれくらいかかるかな？", 0).pick);
ok("他の AI の伝言は拾わない", !shouldPick("Cursor 側の実装が終わりました。app/lib/search-audit-check.ts を直してください。", 0).pick);
ok("拡張・PC の段取りは拾わない", !shouldPick("カーソルの方は拡張ツールの動きを強化していく形で", 0).pick);
ok("通知は拾わない", !shouldPick("<task-notification>x</task-notification>", 0).pick);
console.log(`owner-base-nightly: ${passed} passed, ${failed} failed`);
if (failed) { fails.forEach((f) => console.log("FAIL", f)); process.exit(1); }
