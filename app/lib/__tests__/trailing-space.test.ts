// app/lib/__tests__/trailing-space.test.ts — 2026-10-02 ⑫: 下書きの行末の空白を落とす（実行: npx tsx app/lib/__tests__/trailing-space.test.ts）
import { stripTrailingLineSpaces } from "../draft-text";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
t("行末の半角・全角の空白を落とす", stripTrailingLineSpaces("Rさんお世話になっております！！　\n9日 12:00〜15:00  \n何卒") === "Rさんお世話になっております！！\n9日 12:00〜15:00\n何卒");
t("空白だけの行は空行に", stripTrailingLineSpaces("はい！！\n　\n何卒") === "はい！！\n\n何卒");
t("行の途中の空白は触らない", stripTrailingLineSpaces("6/19日　12:00〜14:00") === "6/19日　12:00〜14:00");
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
