// app/lib/__tests__/pickup-fit-now.test.ts — 送れる候補が今の条件にも合うか（#821・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/pickup-fit-now.test.ts
//   候補の要約は本番の property_pickups.summary_text の形（物件名は架空にした）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickupFitNowLine, candFacts, wantsOf, pickupFitNowOn } from "../pickup-fit-now";
import { SWITCH_TARGET_MARK } from "../../../scripts/lib/exam-snapshot-need";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const C = (s: string) => ({ property_name: "テスト", summary_text: s });
const cands = [C("【1】テストA 0303号室\n68,000円 15,500円\n2DK 46㎡\n四つ橋線「四ツ橋」徒歩3分\nAD 1.5ヶ月"), C("【2】テストB 0216号室\n132,000円 12,000円\n1LDK 39.32㎡\n堺筋線「堺筋本町」徒歩4分"), C("【3】テストC 1108号室\n98,000円 8,000円\n1LDK 40㎡ カウンターキッチン\n御堂筋線「本町」徒歩12分")];
t("要約から 家賃・間取り・徒歩", JSON.stringify(candFacts(cands[1])).includes("\"rent\":132000") && candFacts(cands[0]).layout === "2DK" && candFacts(cands[2]).walk === 12);
t("言い足しの設備の語", wantsOf("できればカウンターキッチンだと嬉しいです").join() === "カウンターキッチン");
const line = pickupFitNowLine({ candidates: cands, row: { rent_max: 110000, floor_plan: "1LDK", walk_minutes: 10 }, customerText: "できればカウンターキッチンだと嬉しいです" });
t("1行: 家賃・間取り・徒歩・言い足しの語の数（書いていない＝分からない）・決めるのはあなた", /候補 3件/.test(line) && /家賃 11万以内 2\/3/.test(line) && /間取り 1LDK 2\/3/.test(line) && /徒歩 10分以内 2\/3/.test(line) && /「カウンターキッチン」が要約に書いてある 1\/3/.test(line) && /決めるのはあなた/.test(line));
t("候補が無ければ出さない", pickupFitNowLine({ candidates: [], row: { rent_max: 110000 }, customerText: "x" }) === "");
t("条件も言い足しも無ければ出さない", pickupFitNowLine({ candidates: cands, row: {}, customerText: "ありがとうございます" }) === "");
t("事実だけ（送るべき・約束すべき の言葉が無い）", !/すべき|送ってください|約束して/.test(line));
t("既定 off・印", !pickupFitNowOn({}) && pickupFitNowOn({ PICKUP_FIT_NOW_LINE: "on" }) && SWITCH_TARGET_MARK.PICKUP_FIT_NOW_LINE === "pickup_fit_now");
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: 同じ読みに列を足すだけ・印は materialMarks を作った後", bc.includes("candList || fitNowOn ?") && bc.includes("if (pickupFitNowLen > 0) materialMarks.pickup_fit_now = pickupFitNowLen;") && bc.indexOf("const materialMarks: Record<string, number> = {};") < bc.indexOf("materialMarks.pickup_fit_now"));
console.log(`pickup-fit-now: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
