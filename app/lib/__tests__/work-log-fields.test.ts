// app/lib/__tests__/work-log-fields.test.ts — 実行: npx tsx app/lib/__tests__/work-log-fields.test.ts
import { normalizeActor, parseKbIds } from "../work-log-fields";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${n}`); } else { fail++; console.log(`  NG  ${n}`); } };
t("worker:作業員7 → 作業員7", normalizeActor("worker:作業員7") === "作業員7");
t("作業員7 はそのまま・空は session・統括役はそのまま", normalizeActor("作業員7") === "作業員7" && normalizeActor("") === "session" && normalizeActor("統括役") === "統括役");
t("worker:つなぎの芯 → つなぎの芯", normalizeActor("worker:つなぎの芯") === "つなぎの芯");
const a = parseKbIds("575A7CD5, 2e164f41,575a7cd5");
t("id8 を小文字・重なりなしで", a.ids.join() === "575a7cd5,2e164f41" && !a.bad.length && !a.none);
t("none は引かなかった印", parseKbIds("none").none && parseKbIds("なし").none);
t("8字でない物は bad", parseKbIds("575a7cd,xyz").bad.length === 2);
t("空は ids も none も無し", parseKbIds("").ids.length === 0 && !parseKbIds("").none);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
