// app/lib/__tests__/lp-evidence.test.ts
// LP の「◯月実績｜平均 ◯◯◯,◯◯◯円 節約」（public/lp-evidence.js）。
// 2026-09-18 竹内「実績の月を9月に／平均金額は毎日変更（108,220〜123,450のランダム）／
//   月が替わったら実績もその月に（10月なら10月）」
// 実行: npx tsx app/lib/__tests__/lp-evidence.test.ts
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

const LP = require_("../../../public/lp-evidence.js") as {
  MIN: number; MAX: number;
  dailyAmount(y: number, m: number, d: number): number;
  formatYen(n: number): string;
  evidenceFor(now?: Date): { year: number; month: number; amount: number; monthLabel: string; amountLabel: string; ymLabel: string };
};

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── 竹内さん指定の範囲を絶対に外れない");
{
  t("下限・上限が指定どおり", LP.MIN === 108220 && LP.MAX === 123450, `${LP.MIN}〜${LP.MAX}`);
  let min = Infinity, max = -Infinity;
  const seen = new Set<number>();
  // 3年分（約1,100日）を全部回す
  for (let y = 2026; y <= 2028; y++) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const v = LP.dailyAmount(y, m, d);
        if (v < min) min = v;
        if (v > max) max = v;
        seen.add(v);
      }
    }
  }
  t("3年分どの日も範囲の中", min >= LP.MIN && max <= LP.MAX, `${min}〜${max}`);
  t("同じ数字ばかりにならない（1,100日で500種類以上）", seen.size >= 500, String(seen.size));
  t("範囲の両端近くまで散る", min < LP.MIN + 2000 && max > LP.MAX - 2000, `${min}〜${max}`);
}

console.log("── 同じ日は何回見ても同じ・翌日は変わる");
{
  t("同じ日は同じ", LP.dailyAmount(2026, 9, 18) === LP.dailyAmount(2026, 9, 18));
  let sameAsNext = 0;
  for (let d = 1; d <= 29; d++) if (LP.dailyAmount(2026, 9, d) === LP.dailyAmount(2026, 9, d + 1)) sameAsNext++;
  t("9月の連続する日で同じ値が続かない", sameAsNext === 0, String(sameAsNext));
  // 「毎日変わる」＝ページを開き直しても変わらないこと（同じ日で複数回呼ぶ）
  const a = [LP.dailyAmount(2026, 10, 1), LP.dailyAmount(2026, 10, 1), LP.dailyAmount(2026, 10, 1)];
  t("再読み込みでも変わらない（決定論）", a[0] === a[1] && a[1] === a[2]);
}

console.log("── 月が替わったらラベルも替わる（JST）");
{
  const sep = LP.evidenceFor(new Date("2026-09-18T12:00:00+09:00"));
  t("9月は「9月実績」", sep.monthLabel === "9月実績", sep.monthLabel);
  t("注記は「2026年9月」", sep.ymLabel === "2026年9月", sep.ymLabel);

  const oct = LP.evidenceFor(new Date("2026-10-01T00:30:00+09:00"));
  t("10月1日になったら「10月実績」", oct.monthLabel === "10月実績", oct.monthLabel);
  t("注記も「2026年10月」", oct.ymLabel === "2026年10月", oct.ymLabel);

  const jan = LP.evidenceFor(new Date("2027-01-01T09:00:00+09:00"));
  t("年をまたいでも正しい", jan.monthLabel === "1月実績" && jan.ymLabel === "2027年1月", jan.ymLabel);
}

console.log("── 日本時間で揃える（端末の時計がどこでも同じ日付）");
{
  // 9/30 23:30 JST は、UTC ではまだ 9/30 14:30。JST で見ているので 9月のまま
  const late = LP.evidenceFor(new Date("2026-09-30T23:30:00+09:00"));
  t("9/30 23:30 JST は「9月実績」", late.monthLabel === "9月実績", late.monthLabel);
  // 10/1 00:30 JST は UTC ではまだ 9/30。JST で見るので 10月
  const early = LP.evidenceFor(new Date("2026-10-01T00:30:00+09:00"));
  t("10/1 00:30 JST は「10月実績」", early.monthLabel === "10月実績", early.monthLabel);
  t("同じ瞬間なら日付は1つ", LP.evidenceFor(new Date("2026-10-01T00:30:00+09:00")).amount === early.amount);
}

console.log("── 金額の書き方");
{
  t("3桁区切り＋円", LP.formatYen(118220) === "118,220円", LP.formatYen(118220));
  t("下限も上限も5桁区切りにならない",
    LP.formatYen(LP.MIN) === "108,220円" && LP.formatYen(LP.MAX) === "123,450円",
    `${LP.formatYen(LP.MIN)} / ${LP.formatYen(LP.MAX)}`);
  const e = LP.evidenceFor(new Date("2026-09-18T12:00:00+09:00"));
  t("表示用の文字列が金額と一致", e.amountLabel === LP.formatYen(e.amount), `${e.amountLabel} / ${e.amount}`);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
