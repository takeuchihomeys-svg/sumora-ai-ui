// 2026-09-14 竹内「自分が送った内容を記憶して次の解析に引き継ぐ」: 送信時の記録（sent_facts）を行動台帳の一次証拠にする。
//   ・1通に複数の行為（見積書の約束＋ピックアップの約束）を全部記録する
//   ・記録があれば本文の読み直しより優先・メッセージの取得範囲より古い送信も台帳に入る
//   ・AIX 待ち合わせ場所は画面入力の日時・物件で台帳の内覧の予定になる
// 実行: npx tsx app/lib/__tests__/sent-facts.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildActionLedger, classifyStaffTextFacts, appointmentFromMeetingInput, appointmentYmd, buildLedgerLinesForBrain, type RecordedFact } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const YUKO = "初期費用のお支払いは一括でのお振込のみとなりますが、最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！\n夜職・ブラックリストの方でもご入居可能なお部屋多数ございますので、審査に通りやすい保証会社中心にお部屋ピックアップさせて頂きます！！";

it("1通に複数の行為: 見積書の約束＋ピックアップの約束を両方記録（ゆうこ）", () => {
  const f = classifyStaffTextFacts(YUKO, "2026-09-14T03:57:46Z");
  expect(f.map((e) => e.kind).join(",")).toBe("estimate_declared,pickup_declared");
  const l = buildActionLedger({ messages: [{ sender: "staff", text: YUKO, createdAt: "2026-09-14T03:57:46Z" }], now: Date.parse("2026-09-14T04:00:00Z") });
  expect(l.facts.estimatePromisedUnfulfilled).toBe(true); expect(l.facts.pickupPromisedUnfulfilled).toBe(true);
  expect(l.facts.lastStaffEntry?.kind).toBe("estimate_declared");
});
it("「御見積書、現在確認中となります」「ご査収いただきありがとうございます」は見積書の送付にしない", () => {
  expect(classifyStaffTextFacts("かしこまりました！！\n残り3件の初期費用御見積書、現在確認中となります！！確認出来次第お送りさせて頂きます😊！！", null)[0]?.kind === "estimate_sent").toBe(false);
  expect(classifyStaffTextFacts("ご査収いただきありがとうございます😊！！\n他にもお気に召されましたお部屋御座いましたらお見積書作成させていただきます😌！！", null)[0]?.kind === "estimate_sent").toBe(false);
});
it("物件の送付＋待ち合わせの案内の1通は両方（物件送付・待ち合わせ）", () => {
  const f = classifyStaffTextFacts("お部屋お送りさせて頂きました！！ご査収ください！！\n明日11:30にアーバネックス東梅田現地エントランス前お待ち合わせ何卒よろしくお願い致します！！", "2026-09-08T02:00:00Z");
  expect(f.some((e) => e.kind === "meeting_place_sent")).toBe(true);
});
it("送信時の記録があれば本文の読み直しより優先（記録は約束のみ・本文は送付に見えても約束として扱う）", () => {
  const text = "こちら初期費用の御見積書となります！";
  const rec: RecordedFact[] = [{ sent_at: "2026-09-14T03:57:47Z", origin: "staff_text", kind: "estimate_declared", status: "promised", detail: {}, evidence: "記録" }];
  const l = buildActionLedger({ messages: [{ sender: "staff", text, createdAt: "2026-09-14T03:57:46Z" }], recordedFacts: rec, now: Date.parse("2026-09-14T04:00:00Z") });
  expect(l.facts.estimateSent).toBe(false); expect(l.facts.estimatePromisedUnfulfilled).toBe(true);
  expect(l.entries.filter((e) => e.kind.startsWith("estimate")).length).toBe(1);
});
it("メッセージの取得範囲より古い送信の記録も台帳に入る（範囲外でも忘れない）", () => {
  const rec: RecordedFact[] = [{ sent_at: "2026-09-01T03:00:00Z", origin: "aix", aix_type: "estimate_sheet", kind: "estimate_sent", status: "done", detail: { estimateFor: ["昭和グランドハイツ恵美須 803号室"] } }];
  const l = buildActionLedger({ messages: [{ sender: "customer", text: "ありがとうございます", createdAt: "2026-09-14T02:00:00Z" }], recordedFacts: rec, now: Date.parse("2026-09-14T03:00:00Z") });
  expect(l.facts.estimateSent).toBe(true); expect(/見積送付済\(AIX\)/.test(l.summary)).toBe(true);
});
it("AIX 待ち合わせ場所: 記録（画面入力の日時・物件）が本文の読み取りより正・AIX 行と二重にしない", () => {
  const at = "2026-09-13T02:24:03Z";
  const rec: RecordedFact[] = [{ sent_at: at, origin: "aix", aix_type: "meeting_place", kind: "meeting_place_sent", status: "done", detail: { appointment: { dateMD: "9/14", time: "12:00", place: "メゾン加美北 305号室" } } }];
  const l = buildActionLedger({ recentAixRows: [{ aix_type: "meeting_place", created_at: at, sent_at: at, generated_text: "かしこまりました！！" }], messages: [], recordedFacts: rec, now: Date.parse("2026-09-14T01:00:00Z") });
  expect(l.entries.filter((e) => e.kind === "meeting_place_sent").length).toBe(1);
  expect(l.facts.viewingAppointment?.time).toBe("12:00"); expect(l.facts.viewingAppointment?.day).toBe("today");
});
it("画面入力の読み取り: 「9/14（月）」「12:00〜14:00」→ 9/14 12:00・年は案内した日から（12月の 1/5 は翌年）", () => {
  const a = appointmentFromMeetingInput({ date: "9/14（月）", time: "12:00〜14:00", propertyName: "メゾン加美北 305号室" });
  expect(a?.dateMD).toBe("9/14"); expect(a?.time).toBe("12:00"); expect(a?.place).toBe("メゾン加美北 305号室");
  expect(appointmentYmd("9/14", "2026-09-13T02:24:03Z")).toBe("2026-09-14");
  expect(appointmentYmd("1/5", "2026-12-20T02:00:00Z")).toBe("2027-01-05");
  expect(appointmentFromMeetingInput({ date: "", time: "12:00" })).toBe(null);
});
it("ブレインに渡す台帳の行: 何を・いつ・どの物件に（AIX／手打ち・送信時の記録の区別つき）", () => {
  const rec: RecordedFact[] = [{ sent_at: "2026-09-13T02:24:03Z", origin: "aix", aix_type: "meeting_place", kind: "meeting_place_sent", status: "done", detail: { appointment: { dateMD: "9/14", time: "12:00", place: "メゾン加美北 305号室" } } }];
  const l = buildActionLedger({ messages: [{ sender: "staff", text: YUKO, createdAt: "2026-09-14T03:57:46Z" }], recordedFacts: rec, now: Date.parse("2026-09-14T04:00:00Z") });
  const txt = buildLedgerLinesForBrain(l);
  expect(/待ち合わせ案内を実行（9\/14 12:00 メゾン加美北 305号室）［AIX］/.test(txt)).toBe(true);
  expect(/見積書作成を宣言（まだ履行していない）［手打ち］/.test(txt)).toBe(true);
  expect(/物件ピックアップを宣言/.test(txt)).toBe(true);
});

// 2026-09-16 竹内（慶次事例）「今日約束した事はカレンダーに【必ず】…連絡漏れが多い」: 確認の約束を文単位で拾う
const KEIJI = "とんでもございません😊！！\n慶次さんにオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！\n保証会社の件も確認させて頂きますので、何卒よろしくお願い致します！！";
it("慶次: ピックアップの約束＋保証会社の確認の約束を両方記録（旧は確認が丸ごと落ちていた）", () => {
  const f = classifyStaffTextFacts(KEIJI, "2026-09-16T01:28:41Z");
  expect(f.map((e) => e.kind).join(",")).toBe("pickup_declared,confirmation_promised");
  expect(f[1].detail.object ?? null).toBe("保証会社");
});
it("「〇〇の募集状況確認させていただきます」だけの通（ご連絡・出来次第が無い）も確認の約束", () => {
  const f = classifyStaffTextFacts("かしこまりました！！\nNicher’a 加美の募集状況確認させていただきます！！", null);
  expect(f.map((e) => e.kind).join(",")).toBe("confirmation_promised");
  expect(f[0].detail.object ?? null).toBe("募集状況");
  const g = classifyStaffTextFacts("かしこまりました！！\n上記4件お申込みさせていただきます😊！！\n\nお申込み完了しましたら、それぞれの受付番手確認させていただきます！！", null);
  expect(g.some((e) => e.kind === "confirmation_promised" && e.detail.object === "番手")).toBe(true);
});
it("お客様の行動が先に要る条件付きは約束にしない（お送りいただき次第…確認）", () => {
  const f = classifyStaffTextFacts("はい😊！！\n気になる物件がございましたらいつでもお気軽にお送りください！！お送りいただき次第、募集状況を確認させて頂きます！！", null);
  expect(f.some((e) => e.kind === "confirmation_promised")).toBe(false);
});
it("「ピックアップ出来次第お送り」だけの通は確認の約束にしない（従来どおり）", () => {
  const f = classifyStaffTextFacts("かしこまりました！！\nオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！", null);
  expect(f.map((e) => e.kind).join(",")).toBe("pickup_declared");
});
it("𝒮: 「管理会社に…交渉頂きます／確認出来次第ご連絡」は確認の約束（対象=管理会社）", () => {
  const f = classifyStaffTextFacts("お世話になっております！！\n\n改めて管理会社に11月中旬でのご入居が可能か交渉頂きます！！\n確認出来次第ご連絡させて頂きます😊！", null);
  expect(f[0]?.kind).toBe("confirmation_promised");
  expect(f[0]?.detail.object ?? null).toBe("管理会社");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
