// staff-writer（書き手＝竹内さん／従業員）と staff-device（端末の印）のテスト。実物の文（10/08 の監査で読んだ送信）をそのまま使う
// 実行: npx tsx app/lib/__tests__/staff-writer.test.ts（全 PASS で exit 0）
import { writerFromText, writerFromEdit, writerFromContext, writerFromIdentity, writerUse, cannedSkeleton, inAutoReplyPeriod, staffWriterOfBurst, sortExamplesByWriter } from "../staff-writer";
import { deviceLabelOf, parseStaffDeviceId } from "../staff-device";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 竹内さん（A）の実物
const A1 = "全然です😊！！\nご満足頂くお部屋探しが出来ますよう全力でサポートさせて頂きます！！";
const A2 = "かしこまりました😊！！\nお部屋ご案内させて頂きます！！\n\n直近ですと\n6/13日　12:00〜15:00\n6/14日    12:00〜15:00  \nご案内可能です！！\nくぼさんご都合如何でしょうか😌！";
// 従業員（B）の実物
const B1 = "お送りいただきありがとうございます！！\nお部屋の募集状況確認させていただきます😊！！";
const B2 = "審査通過完了メールからURL押していただく形となります。\n念のため明日管理会社に審査通過メール再送していただきます。";

it("竹内さんの手打ちは takeuchi（確か）", () => { const w = writerFromText(A1); eq(w.writer, "takeuchi"); eq(w.confidence, "sure"); });
it("候補日の文（頂・如何）も takeuchi", () => { eq(writerFromText(A2).writer, "takeuchi"); });
it("従業員の手打ちは employee（確か）", () => { const w = writerFromText(B1); eq(w.writer, "employee"); eq(w.confidence, "sure"); });
it("グループの鈴木さんの文も employee", () => { eq(writerFromText(B2).writer, "employee"); });
it("手掛かりの無い短い文は不明", () => { const w = writerFromText("かしこまりました😊！！"); eq(w.writer, null); eq(w.confidence, "unknown"); });
it("「ございます」は手掛かりにしない（竹内さんも打つ）", () => { eq(writerFromText("ありがとうございます！！").writer, null); });
it("名乗り（鈴木と申します）は手掛かりにしない", () => { eq(writerFromText("担当の鈴木と申します！！").writer, null); });
it("混ざった文は差で決めて「たぶん」", () => { const w = writerFromText("確認させて頂きます！！ご連絡いただきありがとうございます"); eq(w.writer, null); const w2 = writerFromText("確認させて頂き、出来次第ご連絡いただけますと"); eq(w2.writer, "takeuchi"); eq(w2.confidence, "likely"); });
it("🌟物件カード（資料文）は不明（道具が作る文）", () => { const w = writerFromText("🌟クラウンハイム北心斎橋フラワーコート 302号室\n\n夏奈さんにかなりオススメ出来るお部屋となります！！\n\n（オススメポイント）\n・家賃82,000円"); eq(w.writer, null); });
it("直した所だけで決める: 下書きの「頂き」を残しただけは不明", () => { eq(writerFromEdit("確認させて頂きます！！", "確認させて頂きます😊！！").writer, null); });
it("直した所だけで決める: 頂き→いただき に直したら employee", () => { eq(writerFromEdit("確認させて頂きます！！お送りさせて頂きます！！", "確認させていただきます！！お送りさせていただきます！！").writer, "employee"); });
it("直した所だけで決める: いただき→頂き なら takeuchi", () => { eq(writerFromEdit("ご連絡いただきありがとうございます", "ご連絡頂きありがとうございます").writer, "takeuchi"); });
it("文脈: 前後30分の決まった通が同じなら たぶん", () => {
  const L = (w: "takeuchi" | "employee") => ({ writer: w, confidence: "sure" as const, score: 2, cues: [] });
  const c = writerFromContext(1000_000, [{ at: 1000_000 - 60_000, label: L("employee") }, { at: 1000_000 + 120_000, label: L("employee") }], 30 * 60_000);
  eq(c.writer, "employee"); eq(c.confidence, "likely");
  const d = writerFromContext(1000_000, [{ at: 1000_000 - 60_000, label: L("employee") }, { at: 1000_000 + 120_000, label: L("takeuchi") }], 30 * 60_000);
  eq(d.writer, null);
  eq(writerFromContext(0, [{ at: 3 * 3600_000, label: L("takeuchi") }], 30 * 60_000).writer, null);
});
it("端末・グループの発言者が先", () => {
  eq(writerFromIdentity({ deviceWriter: "employee" }), { writer: "employee", source: "device" });
  eq(writerFromIdentity({ speakerUserId: "U1", takeuchiLineIds: ["U1"] }), { writer: "takeuchi", source: "group_speaker" });
  eq(writerFromIdentity({ speakerUserId: "U9", takeuchiLineIds: ["U1"], employeeLineIds: ["U2"] }), null);
});
it("使い方の線: 竹内さん＝書き方も中身も／従業員＝中身だけ／不明＝旧", () => { eq(writerUse("takeuchi", "sure"), "style_and_content"); eq(writerUse("employee", "likely"), "content_only"); eq(writerUse(null), "legacy"); });
it("定型の骨: 呼び名・挨拶・お待たせ・数字を外す", () => {
  eq(cannedSkeleton("いつきさん\nお待たせ致しました！！\n\nなんば・日本橋周辺全域から"), cannedSkeleton("夏奈さんお待たせ致しました！！\n\nなんば・日本橋周辺全域から"));
});
it("自動返信の期間（8/16〜8/17 JST）", () => { eq(inAutoReplyPeriod("2026-08-16T12:00:00Z"), true); eq(inAutoReplyPeriod("2026-08-17T16:00:00Z"), false); eq(inAutoReplyPeriod("2026-08-15T16:00:00Z"), true); });
it("見張りのまとまり: 直した所→無ければ文全体の確かだけ", () => {
  eq(staffWriterOfBurst("確認させて頂きます！！お送りさせて頂きます！！", "確認させていただきます！！お送りさせていただきます！！")?.writer, "employee");
  eq(staffWriterOfBurst(null, A1)?.source, "style");
  eq(staffWriterOfBurst(null, "ご連絡頂き"), null);
});
it("手本の並び: 竹内さん → 不明 → 従業員（同じ中の順は保つ）", () => {
  const out = sortExamplesByWriter([{ sent_reply: B1, k: 1 }, { sent_reply: "かしこまりました！！", k: 2 }, { sent_reply: A1, k: 3 }, { sent_reply: A2, k: 4 }]);
  eq(out.map((x) => x.k), [3, 4, 2, 1]);
  eq(sortExamplesByWriter([{ sent_reply: A1, staff_writer: "employee", k: 1 }, { sent_reply: B1, staff_writer: "takeuchi", k: 2 }]).map((x) => x.k), [2, 1]);
});
it("端末名（IP は持たない）", () => {
  eq(deviceLabelOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1"), "iPhone iOS18.7 Safari26.6.1");
  eq(deviceLabelOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"), "Windows Chrome154");
  eq(deviceLabelOf(""), "不明");
  eq(parseStaffDeviceId("3f2a9c1e-5b7d-4e2f-9a1b-0c3d4e5f6a7b"), "3f2a9c1e-5b7d-4e2f-9a1b-0c3d4e5f6a7b");
  eq(parseStaffDeviceId("x; drop"), null);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
