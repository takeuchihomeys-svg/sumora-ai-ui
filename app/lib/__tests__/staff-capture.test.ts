// app/lib/__tests__/staff-capture.test.ts — 2026-10-14 取りこぼしの無い設計（37af1885）（実行: npx tsx app/lib/__tests__/staff-capture.test.ts）
import { alternativeBuildingFromText, alternativeCheckRecord, composeViewingReport, parseViewingReport, composeCallReport } from "../staff-capture";
import { resolvePropertyThreads, buildPropertyThreadNote, type PtMsg, type PtAix } from "../property-thread";
import { focusEventsFromAixRows } from "../customer-state";
import { applyMemoOps, buildCustomerMemoNote, EMPTY_MEMO } from "../customer-memo";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// ① 上の「別の部屋が募集してた」: 本文の建物名＋号室
const fixed = "お世話になっております！！\n\nお送り頂きましたプレサンス松屋町駅前デュオ302号室ですが確認しましたところ募集終了しておりました！！\n\n別の階数となりますが、同じ間取りで\nプレサンス松屋町駅前デュオで現在募集中のお部屋御座いましたので";
t("本文から建物名", alternativeBuildingFromText(fixed) === "プレサンス松屋町駅前デュオ", String(alternativeBuildingFromText(fixed)));
// fix(review): 本番の固定文の形（endedRoomStr＝「3階302号室」「3階部分」「のお部屋」）
for (const [s, want] of [["お送り頂きましたプレサンス松屋町駅前デュオ3階302号室ですが確認しましたところ", "プレサンス松屋町駅前デュオ"], ["お送り頂きましたプレサンス松屋町駅前デュオ3階部分ですが確認しましたところ", "プレサンス松屋町駅前デュオ"], ["お送り頂きましたプレサンス松屋町駅前デュオのお部屋ですが確認しましたところ", "プレサンス松屋町駅前デュオ"], ["お送り頂きましたシティタワー2 3階302号室ですが確認", "シティタワー2"]] as const)
  t(`本番の形: ${s.slice(9, 30)}`, alternativeBuildingFromText(s) === want, String(alternativeBuildingFromText(s)));
t("[物件名] のままは読まない", alternativeBuildingFromText("お送り頂きました[物件名]ですが確認しましたところ") === null);
const rec = alternativeCheckRecord({ text: fixed, endedUnit: "302", altUnit: "0502" });
t("代わり＝alternative・終了＝unavailable・0外し", JSON.stringify(rec) === JSON.stringify({ names: ["プレサンス松屋町駅前デュオ 502号室", "プレサンス松屋町駅前デュオ 302号室"], statuses: ["alternative", "unavailable"] }), JSON.stringify(rec));
t("号室が無い時は記録しない（建物だけだと終了の部屋に寄る）", alternativeCheckRecord({ text: fixed }).names.length === 0);

// ② 台帳: 別の部屋が「確認の結果 別の部屋が募集中」になり、主語の抜けた次の番の候補になる
const aix: PtAix[] = [{ created_at: "2026-10-12T02:39:00Z", aix_type: "property_check_result", check_pattern: "available",
  property_names: ["カーサ・エテルナ 201号室", "プレサンス松屋町駅前デュオ 502号室"], prop_statuses: ["unavailable", "alternative"] }];
const msgs: PtMsg[] = [
  { sender: "customer", text: "カーサ・エテルナ201とプレサンス松屋町駅前デュオ302空いてますか？", created_at: "2026-10-12T01:00:00Z" },
  { sender: "staff", text: "確認しましたところ…", created_at: "2026-10-12T02:39:00Z" },
  { sender: "customer", text: "そちら内覧できますか？", created_at: "2026-10-12T03:00:00Z" },
];
const s = resolvePropertyThreads({ messages: msgs, aix, imageLabels: new Map() });
const alt = s.rooms.find((r) => r.ref.display.includes("502"));
t("台帳に別の部屋の出来事", !!alt?.events.some((e) => e.kind === "check_alternative"), JSON.stringify(alt?.events));
t("別の部屋はこちらが案内した物件（ours）", alt?.origin === "ours", String(alt?.origin));
const note = buildPropertyThreadNote(s);
t("材料の文に「別の部屋が募集中」", /別の部屋が募集中/.test(note), note);
// fix(review): 同じ建物の別の部屋＋募集終了の部屋が同じ記録 → 主語の無い番の候補に募集終了の部屋を並べない
{
  const aix2: PtAix[] = [{ created_at: "2026-10-12T02:39:00Z", aix_type: "property_check_result", check_pattern: "alternative",
    property_names: ["プレサンス松屋町駅前デュオ 502号室", "プレサンス松屋町駅前デュオ 302号室"], prop_statuses: ["alternative", "unavailable"] }];
  const msgs2: PtMsg[] = [
    { sender: "customer", text: "プレサンス松屋町駅前デュオ302空いてますか？", created_at: "2026-10-12T01:00:00Z" },
    { sender: "staff", text: "確認しましたところ募集終了しておりました！！別の階数となりますが…", created_at: "2026-10-12T02:39:00Z" },
    { sender: "customer", text: "そちら見に行けますか", created_at: "2026-10-12T03:00:00Z" },
  ];
  const s2 = resolvePropertyThreads({ messages: msgs2, aix: aix2, imageLabels: new Map() });
  const cands = s2.turnReferent ? (s2.turnReferent.kind === "many" ? s2.turnReferent.candidates.map((c) => c.display) : [String((s2.turnReferent as { display?: string }).display ?? "")]) : [];
  t("主語の無い番の候補に募集終了の部屋が無い", cands.length >= 1 && !cands.some((d) => d.includes("302")) && cands.some((d) => d.includes("502")), JSON.stringify(s2.turnReferent));
}
process.env.STAFF_CAPTURE_ALTERNATIVE = "off";
const sOff = resolvePropertyThreads({ messages: msgs, aix, imageLabels: new Map() });
t("off で旧（出来事なし）", !sOff.rooms.some((r) => r.events.some((e) => e.kind === "check_alternative")));
delete process.env.STAFF_CAPTURE_ALTERNATIVE;

// お客様の状況: 主のお部屋の候補（関心の出来事）に別の部屋が入る
const fe = focusEventsFromAixRows([{ aix_type: "property_check_result", sent_at: "2026-10-12T02:39:00Z", created_at: "2026-10-12T02:39:00Z", generated_text: "", property_names: aix[0].property_names!, prop_statuses: aix[0].prop_statuses!, estimate_sent: false }] as never);
t("関心の出来事に別の部屋", fe.length === 1 && fe[0].names.join() === "プレサンス松屋町駅前デュオ 502号室", JSON.stringify(fe));

// ③ 内覧の結果
const vr = composeViewingReport({ mood: "迷っている", likes: ["日当たり"], concerns: ["家賃・初期費用", "駐車場"], next: ["家族と相談"] }, "契約は息子様");
t("内覧の内容の行", vr === "内覧の結果: 迷っている\n気に入った点: 日当たり\n気になった点: 家賃・初期費用、駐車場\n次の動き: 家族と相談\n契約は息子様", vr);
const back = parseViewingReport(vr);
t("開き直すとタップと自由入力に戻る", back.taps.mood === "迷っている" && back.taps.concerns?.length === 2 && back.free === "契約は息子様");
t("戻した物を組み直しても重ならない", composeViewingReport(back.taps, back.free) === vr);
t("タップ無しは自由入力のまま", composeViewingReport({}, "a\nb") === "a\nb");

// ④ 電話の結果 → お客様のメモ（kind=call）→ 場面に関係なくブレインへ
const cr = composeCallReport(["内覧の日程が決まった"], "10/18 14時 現地\n駐車場を気にしている");
t("電話の結果の1行", cr === "【内覧の日程が決まった】 10/18 14時 現地 ／ 駐車場を気にしている", cr);
const now = Date.parse("2026-10-14T05:00:00Z");
const r1 = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "call", text: cr, at: "2026-10-14T04:00:00Z", by: "staff", certainty: "sure", ttlDays: null }], { origin: "staff", nowIso: "2026-10-14T04:00:00Z", newId: () => "c1" });
t("スタッフは call を足せる", r1.applied === 1 && r1.memo.items[0].text === cr);
// fix(review): タップだけで「記録だけする」→ 本文を書き足して保存 → 前の行が書き足した中身に（捨てない）・全く同じは重ねない
const rTap = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "call", text: "【内覧の日程が決まった】", at: "2026-10-14T03:00:00Z", by: "staff", certainty: "sure", ttlDays: null }], { origin: "staff", nowIso: "2026-10-14T03:00:00Z", newId: () => "c0" });
const rExt = applyMemoOps(rTap.memo, [{ op: "add", kind: "call", text: cr, at: "2026-10-14T04:00:00Z", by: "staff", certainty: "sure", ttlDays: null }], { origin: "staff", nowIso: "2026-10-14T04:00:00Z", newId: () => "c9" });
t("書き足した電話の結果は前の行を書き換える", rExt.applied === 1 && rExt.memo.items.length === 1 && rExt.memo.items[0].text === cr, JSON.stringify(rExt.memo.items));
const rSame = applyMemoOps(rExt.memo, [{ op: "add", kind: "call", text: cr, at: "2026-10-14T04:10:00Z", by: "staff", certainty: "sure", ttlDays: null }], { origin: "staff", nowIso: "2026-10-14T04:10:00Z", newId: () => "c8" });
t("同じ中身は重ねない", rSame.applied === 0 && rSame.memo.items.length === 1);
const r2 = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "call", text: "x", at: null, by: "customer", certainty: "sure", ttlDays: null }], { origin: "llm", nowIso: "2026-10-14T04:00:00Z", newId: () => "c2" });
t("DeepSeek は call を足せない", r2.applied === 0);
const mn = buildCustomerMemoNote({ memo: r1.memo, told: [], scene: "cost", nowMs: now });
t("費用の場面でも電話で分かった事が渡る", /電話で分かった事【スタッフの記録/.test(mn) && mn.includes("駐車場を気にしている"), mn);
process.env.STAFF_CAPTURE_CALL = "off";
t("off で渡さない", buildCustomerMemoNote({ memo: r1.memo, told: [], scene: "cost", nowMs: now }) === "");
delete process.env.STAFF_CAPTURE_CALL;
// 竹内さん 10/14: 先頭に出すのは14日まで・古い物は普通のメモ／判断に使うが書かない
t("書き写さない指示が付く", /お客様への文にそのまま書き写さない/.test(mn), mn);
const old = buildCustomerMemoNote({ memo: r1.memo, told: [], scene: "cost", nowMs: now + 20 * 86_400_000 });
t("15日以上前は先頭に出さず普通のメモ（📞の行なし・電話で分かった事: の行あり）", !/📞/.test(old) && /- 電話で分かった事: /.test(old) && /書き写さない/.test(old), old);
t("14日以内は先頭", /📞/.test(buildCustomerMemoNote({ memo: r1.memo, told: [], scene: "cost", nowMs: now + 13 * 86_400_000 })));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
