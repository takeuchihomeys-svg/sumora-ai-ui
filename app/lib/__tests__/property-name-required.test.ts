// app/lib/__tests__/property-name-required.test.ts — 2026-10-07 5巡目「物件名にする」（実行: npx tsx app/lib/__tests__/property-name-required.test.ts）
import { isPlaceholderPropertyName, missingPropertyNameIndexes, missingPropertyNameMessage } from "../property-name-required";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
for (const n of ["", "  ", "物件①", "物件②", "物件1", "物件", "お部屋③", "物件情報"]) t(`仮の名前・空「${n}」→ 送れない`, isPlaceholderPropertyName(n));
for (const n of ["シャーメゾン ソレイユ 202号室", "フェリオ永田", "物件名A棟 101", "KTIレジデンス西中島II 202号室"]) t(`本当の名前「${n}」→ 送れる`, !isPlaceholderPropertyName(n));
t("2件目だけ仮の名前 → [1]", JSON.stringify(missingPropertyNameIndexes(["フェリオ永田 301", "物件②"], 2)) === "[1]");
t("件数より後ろの欄は見ない", missingPropertyNameIndexes(["フェリオ永田 301", ""], 1).length === 0);
t("文: 複数なら物件②", missingPropertyNameMessage([1], 2).startsWith("物件②の物件名"));
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
