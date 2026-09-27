// app/lib/customer-sim-score.ts: お客様役の記録（jsonl の1行＝1往復）の点数。実物の行（2026-09-27 の YUMA の往復）で固定する
// 実行: npx tsx app/lib/__tests__/customer-sim-score.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { scoreSimRun, judgeSimRound, simStopKind, simSentLabel, formatSimScore, type SimRoundRow } from "../customer-sim-score";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, m = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// 実物（screening_failed_return-2026-09-27T0455.jsonl の1〜3往復・hesitate_compare-2026-09-27T0426 の1往復・like_estimate_viewing-2026-09-27T0403 の5往復）
const R_CHECK: SimRoundRow = { round: 1, plan: "AIX【property_check_result/available】を設定「募集中」で送る", draft: null,
  sent: "YUMAさん、ご事情お伝え頂きありがとうございます！！\n審査結果につきましては保証会社の審査次第となりますが、お部屋探しは引き続き全力でサポートさせて頂きます😊！！",
  sentKind: "AIX property_check_result/available", conflicts: 0, material: "物件確認した（設定=募集中/available・エステムコート大阪WEST・資料=ピックアップ#678）",
  findings: [{ kind: "repeat_promise", detail: "前の宣言: かしこまりました😊！！ 難波の1LDKのお部屋は新着が出次第お送りさせて頂きま" }, { kind: "material_missing", detail: "文に無い: エステムコート大阪WEST" }],
  shadowFindings: [], usd: 0.009779084, simUsd: 0 };
const R_STOP_MATERIAL: SimRoundRow = { round: 2, plan: "AIX【property_send】は材料が揃わない（送っていない・画像のあるピックアップが残っていない）→ 送らずに止める",
  note: "画面で AIX を送ってから、もう一度同じ命令で続きから進みます", draft: null, sent: null, sentKind: null, conflicts: 0, material: null, findings: [], shadowFindings: [], usd: 0.009802576, simUsd: 0.000366548 };
const R_STOP_GUARANTOR: SimRoundRow = { round: 3, plan: "AIX【guarantor_info】は材料が揃わない（物件ごとの保証会社名と種類の入力が要る。保存された値が無い）→ 送らずに止める",
  note: "画面で AIX を送ってから、もう一度同じ命令で続きから進みます", sent: null, sentKind: null, findings: [], shadowFindings: [], usd: 0.00765478, simUsd: 0.000320852 };
const R_CLEAN: SimRoundRow = { round: 1, plan: "AIX【property_send】をピックアップ3件で送る",
  sent: "YUMAさん\n\n梅田まで30分以内・家賃7万円以内・1Kのお部屋で、バストイレ別の物件も含めてピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！",
  sentKind: "AIX property_send", conflicts: 0, material: "ピックアップ3件（#665 インザライフ大正RESIDENCE 503・#673 MY江之子島マンション 403・#674 MY江之子島マンション 701）",
  findings: [], shadowFindings: [], usd: 0.011720128, simUsd: 0.000349328 };
const R_ESTIMATE: SimRoundRow = { round: 5, plan: "AIX【estimate_sheet】を保存済みの見積書で送る（物件名を保存済みの名前に手直し）",
  sent: "【エステムコート大阪WEST】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円", sentKind: "AIX estimate_sheet", conflicts: 0,
  material: "見積書#265（エステムコート大阪WEST・初期費用137,980円・割引124,050円・画像）",
  findings: [{ kind: "aix_followup_missing", detail: "実送信では 84%（n=164）が AIX の後に一言添える" }],
  shadowFindings: [{ kind: "aix_followup_missing", aix: "estimate_sheet", detail: "実送信では 84%（n=164）が AIX の後に一言添える" }], usd: 0.009997372, simUsd: 0.000261632 };

console.log("customer-sim-score");

it("止まった往復の分け方（材料が要る・判断が来ない・送る直前）", () => {
  eq(simStopKind(R_STOP_MATERIAL), "needs_material");
  eq(simStopKind({ plan: "判断が来ないので止める" }), "no_decision");
  eq(simStopKind({ plan: "AIX【viewing_invite】を候補（会話から）で送る（--no-send: 送る直前で止めた）" }), "dry");
});

it("送った物の種類（ピッカーを外す・文だけは下書き）", () => {
  eq(simSentLabel(R_CHECK), "AIX property_check_result");
  eq(simSentLabel({ sent: "はい！！", sentKind: null }), "下書き");
  eq(simSentLabel(R_STOP_MATERIAL), "（送っていない）");
});

it("実物: 約束の言い直し＋材料の取りこぼしは手直し／きれいな往復は自動で届いた／影と検査の同じ指摘は1つに数える", () => {
  eq(judgeSimRound(R_CHECK).fixKinds, ["repeat_promise", "material_missing"]);
  eq(judgeSimRound(R_CHECK).auto, false);
  eq(judgeSimRound(R_CLEAN).auto, true);
  eq(judgeSimRound(R_ESTIMATE).fixKinds, ["aix_followup_missing"]);
});

it("画面のズレの記録がある時は自動で届いたから外す（今の jsonl には無い＝null）", () => {
  eq(judgeSimRound(R_CLEAN).screenKinds, null);
  const withScreen = { ...R_CLEAN, screenFindings: [{ kind: "shown_differs" }] };
  eq([judgeSimRound(withScreen).auto, judgeSimRound(withScreen).screenKinds], [false, ["shown_differs"]]);
});

it("1回分の点数（実物5往復）", () => {
  const s = scoreSimRun([R_CHECK, R_STOP_MATERIAL, R_STOP_GUARANTOR, R_CLEAN, R_ESTIMATE]);
  eq([s.rounds, s.sent], [5, 3]);
  eq(Math.round((s.autoRate ?? 0) * 100), 20);           // 自動で届いた 1/5
  eq(Math.round((s.cleanRate ?? 0) * 100), 33);          // 手直しなし 1/3
  eq(s.stops, { needs_material: 2 });
  eq(s.fixes, { repeat_promise: 1, material_missing: 1, aix_followup_missing: 1 });
  eq(Math.round((s.materialMissRate ?? 0) * 100), 33);   // 材料つきで送った3往復のうち1
  eq([s.shadowMismatch, s.screenMismatch], [1, null]);
  eq(s.byLabel.map((b) => `${b.label}:${b.clean}/${b.n}`), ["AIX property_check_result:0/1", "AIX property_send:1/1", "AIX estimate_sheet:0/1"]);
  const text = formatSimScore(s);
  if (!/自動で届いた 20%/.test(text) || !/材料が要る（画面で送る） 2/.test(text)) throw new Error(text);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(" - " + f); process.exit(1); }
