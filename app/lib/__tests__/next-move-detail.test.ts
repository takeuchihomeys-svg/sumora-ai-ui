// app/lib/__tests__/next-move-detail.test.ts — 次の一手の具体的な中身（NEXT_MOVE_DETAIL）
//   実行: npx tsx app/lib/__tests__/next-move-detail.test.ts
import { buildNextMoveDetail, plantsFor, nextMoveDetailLine, nextMoveDetailOn, whenFor, PLANT_ROWS } from "../next-move-detail";

let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.error(`NG ${n}`); } };

t("既定 off", !nextMoveDetailOn({}) && nextMoveDetailOn({ NEXT_MOVE_DETAIL: "on" }));
// q425 の形（内覧なしで決める迷い・1部屋のみ）
const q425 = buildNextMoveDetail({ dest: "apply", situation: { property: "one_left", worry: "taken" }, combo: "reply_only" });
t("q425: 1部屋のみ・抑える・キャンセル料（事実だけ）", q425.plants.map((p) => p.fact).join(",") === "one_room_only,hold_by_apply,cancel_fee_free");
t("q425: 刺さった物件・今・返信", q425.offer.property === "hooked" && q425.when.at === "now" && q425.form === "reply");
// 内覧へ: 直近の3日
t("内覧へ: 直近の空いている日を3つ", buildNextMoveDetail({ dest: "viewing", situation: {}, combo: "reply_only" }).offer.date === "three_nearest");
// 確認の結果待ち: 翌営業日（期限の文は渡された時だけ）
t("確認の結果を待つ: 翌営業日＋期限", whenFor("wait_check", "明日11/13(木)").at === "next_day" && whenFor("wait_check", "明日11/13(木)").dueLabel === "明日11/13(木)");
// 審査の不安
t("審査の不安: 独立系・審査の段階", plantsFor({ worry: "screening", dest: "apply" }).map((p) => p.fact).join(",") === "independent_guarantor,screening_stage");
// 仕込みは最大3つ・重ならない
t("仕込みは最大3つ・重ならない", plantsFor({ property: "one_left", worry: "taken", dest: "viewing" }).length <= 3);
// 組の表につなぐ
t("組（返信→数秒後の AIX）は形 combo", buildNextMoveDetail({ dest: "ask_condition", situation: { checkType: "T11_first_contact_hearing" }, combo: "reply_then_aix_quick" }).form === "combo");
// 受け渡しの1行に確認・約束の語が無い（仕込みは事実だけ）
const line = nextMoveDetailLine(q425);
t("1行: 中身・仕込み・いつ", line.includes("刺さった物件") && line.includes("1部屋のみの募集") && line.includes("次を送るのは 今"));
t("仕込みの表に確認・約束の語が無い", PLANT_ROWS.every((r) => r.facts.every((f) => !/check|confirm/.test(f))));
t("どの行にもなぜと数", PLANT_ROWS.every((r) => r.why.length > 10 && r.count.length > 0));

console.log(`next-move-detail: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
