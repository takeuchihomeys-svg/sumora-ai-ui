// 2026-10-08 初期費用のお金の時期から申込を逆算（payment-timing.ts）
// 実行: npx tsx app/lib/__tests__/payment-timing.test.ts
// お客様の発言は実物（scripts/_tmp の実データ検索で読んだ物・名前は伏せた）
import { extractMoneyReady, planApplyTiming, buildPaymentTimingNote, paymentTimingCoreText, mdw, APPLY_NOW_MAX_MONEY_LEAD_DAYS, PAY_DUE_BEFORE_MOVE_IN_DAYS, HOLD_DAYS } from "../payment-timing";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 300))} to contain ${JSON.stringify(sub)}`); }
const iso = (s: string) => new Date(Date.parse(`${s}+09:00`)).toISOString();
const at = (s: string) => Date.parse(`${s}+09:00`);
const md = (ms: number) => { const d = new Date(ms + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const one = (text: string, said: string, now = said) => extractMoneyReady([{ text, createdAt: iso(said) }], at(now));

console.log("お金を用意できる日（実物）");
it("初期費用の用意ができるのが10月の10日", () => eq(md(one("入居希望日は日割り家賃払ってもいいのでなるべく早く入居したいのですが、初期費用の用意ができるのが10月の10日になる為、それに合わせた日にちが好ましいです。", "2026-09-28T13:00:00")!.fromDayMs), "10/10"));
it("最短でも10月末にしか初期費用を用意出来ない", () => eq(md(one("私も最短でも10月末にしか初期費用を用意出来ないと思うので", "2026-09-02T05:02:00")!.fromDayMs), "10/25"));
it("10月にもらえる給料で…最短10月9日", () => eq(md(one("10月にもらえる給料でその日お支払いになるので最短10月9日になると思います。。", "2026-09-20T02:53:00")!.fromDayMs), "10/9"));
it("お給料が月末なので払えるのが月末以降", () => eq(md(one("お給料が月末なので、払えるのが月末以降になってしまうんです💦", "2026-08-17T08:35:00")!.fromDayMs), "8/25"));
it("資金を貯めないといけないため最短でも11月", () => eq(md(one("ただ、資金を貯めないといけないため最短でも11月になるのでは無いかと思っているのですが💦", "2026-08-23T05:59:00")!.fromDayMs), "11/1"));
it("給料明細（書類の話）は読まない", () => eq(one("多分、8/25にしか7月分の給料明細が出せないのですがどうしたらいいでしょうか？", "2026-08-06T10:00:00"), null));
it("条件のフォーム・申込の書類は読まない", () => eq(one("①【ご入居の時期】⇒12月以降 初期費用は12月から", "2026-10-01T10:00:00"), null));
it("用意できる日から30日過ぎたら落とす", () => eq(one("初期費用の用意ができるのが10月10日です", "2026-09-28T13:00:00", "2026-11-20T10:00:00"), null));

console.log("逆算・A/B");
it("線の定数: 振込は入居の10日前・抑えるのは1ヶ月・A の線は20日", () => eq([PAY_DUE_BEFORE_MOVE_IN_DAYS, HOLD_DAYS, APPLY_NOW_MAX_MONEY_LEAD_DAYS], [10, 30, 20]));
it("用意できる日まで20日＝A（境目）", () => eq(planApplyTiming({ moneyDayMs: at("2026-10-28T00:00:00"), nowMs: at("2026-10-08T12:00:00") }).decision, "A"));
it("用意できる日まで21日＝B（境目）", () => eq(planApplyTiming({ moneyDayMs: at("2026-10-29T00:00:00"), nowMs: at("2026-10-08T12:00:00") }).decision, "B"));
it("12月21日（12月下旬）→ B・申込 12/1〜12/11・入居 12/31 以降", () => {
  const p = planApplyTiming({ moneyDayMs: at("2026-12-21T00:00:00"), nowMs: at("2026-10-08T12:00:00") });
  eq([p.decision, md(p.applyFromMs), md(p.applyToMs), md(p.moveInFromMs)], ["B", "12/1", "12/11", "12/31"]);
});
it("969f01: 9/20 に 10/9 → A（竹内さんは抑えた状態でご内覧を勧めた）・入居は 10/19 以降", () => { const p = planApplyTiming({ moneyDayMs: at("2026-10-09T00:00:00"), nowMs: at("2026-09-20T03:00:00") }); eq([p.decision, md(p.moveInFromMs)], ["A", "10/19"]); });
it("A でも審査と期日の分は今日+20日より前に入居を置かない", () => eq(md(planApplyTiming({ moneyDayMs: at("2026-10-09T00:00:00"), nowMs: at("2026-10-08T12:00:00") }).moveInFromMs), "10/28"));
it("入居の希望が早すぎる時は食い違いを出す", () => has(planApplyTiming({ moneyDayMs: at("2026-12-21T00:00:00"), nowMs: at("2026-10-08T12:00:00"), desiredMoveInMs: at("2026-12-25T00:00:00") }).moveInConflict ?? "", "入居の希望"));
it("一文の型 A（竹内さんの実送信の語）", () => eq(paymentTimingCoreText(planApplyTiming({ moneyDayMs: at("2026-10-09T00:00:00"), nowMs: at("2026-09-20T03:00:00") })), "よろしければ一度お申込しお部屋を抑えた状態で、ご入居日を10月19日以降に設定させて頂きますので、初期費用のお振込は10月9日以降となります😊！！"));
it("一文の型 B（申込の時期＋連絡の約束＝カレンダーに入る形）", () => {
  const t = paymentTimingCoreText(planApplyTiming({ moneyDayMs: at("2026-12-21T00:00:00"), nowMs: at("2026-10-08T12:00:00") }), "YUMA");
  has(t, "12月1日〜12月11日頃にお申込み頂く形となります！！"); has(t, "12月1日に改めてご連絡させて頂きます😊！！");
});

console.log("注記");
const mr = one("初期費用の振込が12月下旬以降になりそうです", "2026-10-08T10:00:00")!;
it("12月下旬以降を読む", () => eq(md(mr.fromDayMs), "12/21"));
it("注記: B を明記・申込へを出さない", () => { const n = buildPaymentTimingNote(mr, { nowMs: at("2026-10-08T12:00:00"), scene: "viewing" }); has(n, "判断 B"); has(n, "AIX【申込へ】は出さない"); has(n, `${mdw(at("2026-12-01T00:00:00"))}〜`); });
it("条件の場面では出さない", () => eq(buildPaymentTimingNote(mr, { nowMs: at("2026-10-08T12:00:00"), scene: "conditions" }), ""));
it("無ければ空", () => eq(buildPaymentTimingNote(null, { nowMs: at("2026-10-08T12:00:00") }), ""));


console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
