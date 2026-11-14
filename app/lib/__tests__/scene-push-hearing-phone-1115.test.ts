// 2026-11-15 作業員H（統括役の頼み）: 本番の物差しの弱い場面（AIX:application_push・AIX:condition_hearing）と弱い所 aix:screening-consult-phone-call の直し
//   元の番の形（本番の竹内さんの番のお客様の文をそのまま・名前と番号は入っていない）でのテスト。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/scene-push-hearing-phone-1115.test.ts
import { screeningRiskHereTurn, screeningRiskHerePhoneEnabled, screeningPhoneTurnLine, screeningConsultTurn } from "../screening-phone-material";
import { buildReapplyBrainNote, reapplyFormOnHandLineOn, formOnHand, REAPPLY_FORM_ON_HAND_LINE, type ReapplyInfo } from "../reapply-customer";
import { driftStaffFamily, yardstickDriftComboOn } from "../../../scripts/lib/prod-yardstick";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

// ─── ① 審査の相談 → AIX【電話をかける】（SCREENING_RISK_HERE_PHONE・既定 off）────────────
const FFF5 = "よろしくお願いします！！ 彼氏との同棲で家探してて、ここ住みたかったんですけど、彼氏名義で審査落ちててここって厳しいですよね？？"; // 見張り 12348・竹内さん AIX【電話】
const P732 = "ここの物件、日本セーフティと全保連だと思うのですが。 日本セーフティが通らなさそうみたいで。 審査面が心配なんですよ。"; // 09/28・竹内さん AIX【電話】
const ON = { SCREENING_RISK_HERE_PHONE: "on" };
ok("既定 off", screeningRiskHerePhoneEnabled({}) === false && screeningRiskHerePhoneEnabled(ON) === true);
ok("12348（竹内さん 電話）は網に掛かる", screeningRiskHereTurn(FFF5));
ok("09/28 732692f2（竹内さん 電話）は網に掛かる", screeningRiskHereTurn(P732));
ok("12348 は今までの網（審査＋相談）には掛かっていなかった＝材料が届いていなかった", !screeningConsultTurn(FFF5));
ok("off なら材料の行は出ない", screeningPhoneTurnLine(FFF5, {}) === "");
{
  const t = screeningPhoneTurnLine(FFF5, ON);
  ok("on: 電話をかける の行", /電話をかける/.test(t) && /phone_call/.test(t) && /保証会社について/.test(t), t);
}
// 竹内さん・スタッフが電話にしていない本番の言い方（掛けない）
const NOT = [
  "ここって私、審査的には通りそうですかね?！😭", // 傷を言っていない＝AIX【保証会社について】（a0c5ecf0）
  "ちなみにここの物件が審査厳しいって聞いたんですけど、やっぱり審査難しいんですかね😭", // 物件の噂
  "こことか、前のところより審査厳しいって聞いてたんですけど大丈夫な感じですか〜？？",
  "こっちの審査落ちたら", // 先の話
  "前の物件が審査落ちした為新たに物件を紹介してほしいです!!", // 探す依頼
  "角部屋はもう空いてないですか？ 一度、違う不動産でそこも審査してもらってます。 1番手の保証会社のところは審査通りませんでした。 初期費用も高かったので、キャンセルしました", // q117 型
  "どちらか審査通る方でお願いできますか？できればフェニックスの方がいいです",
  "ブラックなど審査は通らないですか（ ; ; ）", // q021・初回
  "⑧【その他ご要望あれば】⇒ホストしているので審査が不安なのでよろしくお願いしたいです。",
  "夜職でも審査通りそうな物件紹介して欲しいです😭",
];
for (const s of NOT) ok(`掛けない: ${s.slice(0, 24)}`, !screeningRiskHereTurn(s));
ok("審査＋相談の網に掛かる番は今までの行（10/28）のまま", /竹内さんの決定 10\/28）】お客様の今の発言は審査についての相談/.test(screeningPhoneTurnLine("入居審査についてご相談です！私自身、夜職での勤務ということと、過去に支払いの滞納歴があるため", { ...ON })));

// ─── ② 申込歴あり・フォームと本人確認書類が手元にある → AIX【申込へ】を送り直さない材料（REAPPLY_FORM_ON_HAND_LINE・既定 off）──
const info: ReapplyInfo = { reapply: true, returnedAt: "2026-11-01T00:00:00Z", pattern: "screening_denied", source: "auto" };
ok("既定 off", reapplyFormOnHandLineOn({}) === false);
ok("615499ba（フォームと本人確認書類あり）", formOnHand({ applicationFormAt: "2026-10-26T10:40:42Z", idDocumentAt: "2026-10-26T10:45:00Z" }));
ok("3db9db75（フォーム未提出）は出ない", !formOnHand({ applicationFormAt: null, idDocumentAt: null }) && !formOnHand({ applicationFormAt: null, idDocumentAt: "2026-10-24T00:00:00Z" }));
ok("off なら前の材料と同じ", buildReapplyBrainNote(info, Date.parse("2026-11-14T05:03:39Z"), { formOnHand: true, env: {} }) === buildReapplyBrainNote(info, Date.parse("2026-11-14T05:03:39Z")));
{
  const n = buildReapplyBrainNote(info, Date.parse("2026-11-14T05:03:39Z"), { formOnHand: true, env: { REAPPLY_FORM_ON_HAND_LINE: "on" } });
  ok("on＋手元にある: 送り直さない行が入る", n.includes(REAPPLY_FORM_ON_HAND_LINE) && /送り直さず/.test(n), n);
  const n2 = buildReapplyBrainNote(info, Date.parse("2026-11-14T05:03:39Z"), { formOnHand: false, env: { REAPPLY_FORM_ON_HAND_LINE: "on" } });
  ok("on＋手元に無い: 行は入らない（今まで通り AIX【申込へ】）", !n2.includes(REAPPLY_FORM_ON_HAND_LINE));
  ok("行に個人の値は書かない", !/生年月日\s*\d|\d{3}-?\d{4}-?\d{4}/.test(REAPPLY_FORM_ON_HAND_LINE));
}

// ─── ③ 物差しの場面ごとの比べに組の窓（YARDSTICK_DRIFT_COMBO・既定 off・数えだけ）───────────
{
  // 見張り 12306: お客様 11/08 01:50:06 → 竹内さん 04:01（初回の挨拶の返信）→ 04:01 AIX【条件ヒアリング】
  const tAt = Date.parse("2026-11-08T01:50:06.589Z");
  const moves = [{ at: Date.parse("2026-11-08T04:01:20Z"), family: "返信" }, { at: Date.parse("2026-11-08T04:01:50Z"), family: "condition_hearing" }, { at: Date.parse("2026-11-08T04:02:30Z"), family: "返信" }];
  ok("既定 off", yardstickDriftComboOn({}) === false && yardstickDriftComboOn({ YARDSTICK_DRIFT_COMBO: "on" }) === true);
  ok("12306: 返信→2分以内の AIX は AIX の系統（ブレインの condition_hearing と当たり）", driftStaffFamily("返信", tAt, moves) === "condition_hearing");
  ok("最初が AIX ならそのまま", driftStaffFamily("見積", tAt, moves) === "見積");
  ok("2分を過ぎた AIX は返信のまま（後の約束の果たし）", driftStaffFamily("返信", tAt, [{ at: tAt + 60_000, family: "返信" }, { at: tAt + 10 * 60_000, family: "condition_hearing" }]) === "返信");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
