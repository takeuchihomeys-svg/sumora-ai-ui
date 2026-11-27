// app/lib/__tests__/check-now-possible.test.ts — 今確かめられるか（#821・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/check-now-possible.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkNowPossibleLine, priorChecksFor, checkNowPossibleOn } from "../check-now-possible";
import { SWITCH_TARGET_MARK } from "../../../scripts/lib/exam-snapshot-need";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
// 2026-11-25（水）14:00 JST・2026-11-28（土）14:00 JST
const WED14 = Date.parse("2026-11-25T14:00:00+09:00"), SAT14 = Date.parse("2026-11-28T14:00:00+09:00"), WED20 = Date.parse("2026-11-25T20:00:00+09:00");
const aix = [{ aix_type: "property_check_result", check_pattern: "available", property_names: ["エグゼ堺筋本町 604号室"], sent_at: "2026-11-24T03:00:00Z", created_at: "2026-11-24T03:00:00Z" }];
const l1 = checkNowPossibleLine({ customerText: "エグゼ堺筋本町はまだ空いてますか？", aix, nowMs: WED14, hour: 14 });
t("平日の昼: 営業時間の内・同じ物件の確認の結果（いつ・何と）", /営業時間の内/.test(l1) && /同じ物件（エグゼ堺筋本町 604号室）の物件確認した: 11\/24/.test(l1) && /決めるのはあなた/.test(l1));
t("土曜の昼: 営業時間の外・次に開く日（決まりの値＝土日祝は休みの扱い）", /営業時間の外（次に開くのは 11\/30（月）9時の扱い）/.test(checkNowPossibleLine({ customerText: "空いてますか？", aix: [], nowMs: SAT14, hour: 14 })));
t("平日の夜: 営業時間の外", /営業時間の外/.test(checkNowPossibleLine({ customerText: "見積もりお願いします", aix: [], nowMs: WED20, hour: 20 })));
t("記録が無ければ「なし」", /今の通の物件の 物件確認した の記録（14日）: なし/.test(checkNowPossibleLine({ customerText: "別の物件ですが空いてますか？", aix, nowMs: WED14, hour: 14 })));
t("確かめる事が無い番（お礼だけ）は出さない", checkNowPossibleLine({ customerText: "ありがとうございます！", aix, nowMs: WED14, hour: 14 }) === "");
t("事実だけ（すぐ AIX にせよ・送るべき、の言葉が無い）", !/すべき|送ってください|AIX にする|約束する/.test(l1));
t("14日より前の確認は出さない", priorChecksFor("エグゼ堺筋本町", aix, Date.parse("2026-12-20T14:00:00+09:00")).length === 0);
t("既定 off・印", !checkNowPossibleOn({}) && checkNowPossibleOn({ CHECK_NOW_POSSIBLE_LINE: "on" }) && SWITCH_TARGET_MARK.CHECK_NOW_POSSIBLE_LINE === "check_now_possible");
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・材料の1行・印・控えの行・申込以降は出さない", bc.includes("cnp.checkNowPossibleOn()") && bc.includes("materialMarks.check_now_possible = ln.length") && bc.includes('key: "check_now_possible"'));
console.log(`check-now-possible: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
