// 2026-09-14 竹内「自分が送った内容を把握できていない」:
//   ゆうこ: 見積書は約束しただけ（AIX 見積書送るの記録なし）なのに、台帳が送付済みにして「こちらは御見積書の金額に加えまして…」
//   名無しの権兵衛: 当日12:00の内覧の待ち合わせを案内済みなのに、当日の「着きました！」に「ご都合よろしいお日にちにご案内」
// 実行: npx tsx app/lib/__tests__/ledger-sent-memory.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildActionLedger, classifyStaffTextForLedger, extractViewingAppointment, buildActionLedgerNote } from "../action-ledger";
import { classifyLastStaffTurn, staffEstimateDelivered } from "../reply-context";
import { resolveStaffPromiseAix } from "../aix-task-link";
import { isMisumoriContextAppropriate } from "../estimate-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const YUKO_STAFF = "ゆうこさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\n動画みていただきありがとうございます！！\n\n初期費用のお支払いは一括でのお振込のみとなりますが、最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！\n夜職・ブラックリストの方でもご入居可能なお部屋多数ございますので、審査に通りやすい保証会社中心にお部屋ピックアップさせて頂きます！！";

it("ゆうこ: 「〜となりますが、御見積書を作成しお送りさせて頂きます」は約束（送付済みにしない）", () => {
  expect(staffEstimateDelivered(YUKO_STAFF)).toBe(false);
  const e = classifyStaffTextForLedger(YUKO_STAFF, "2026-09-14T03:57:46Z");
  expect(e?.kind).toBe("estimate_declared"); expect(e?.status).toBe("promised");
  expect(classifyLastStaffTurn(YUKO_STAFF, {}).kind).toBe("estimate_promised");
});
it("ゆうこ: 台帳は「見積 約束済み・未送付」、直前は見積書の作成の宣言、往復文脈は estimate_promised", () => {
  const l = buildActionLedger({ messages: [{ sender: "customer", text: "これは分割払いで初期費用ですか？", createdAt: "2026-09-12T22:42:25Z" }, { sender: "staff", text: YUKO_STAFF, createdAt: "2026-09-14T03:57:46Z" }, { sender: "customer", text: "初期費用やく3000円と家賃払えば入居できると思いました💦", createdAt: "2026-09-14T03:59:10Z" }], now: Date.parse("2026-09-14T04:04:00Z") });
  expect(l.facts.estimateSent).toBe(false); expect(l.facts.estimatePromisedUnfulfilled).toBe(true);
  expect(/見積約束済み・未送付/.test(l.summary)).toBe(true);
  expect(classifyLastStaffTurn(YUKO_STAFF, { ledger: l, lastStaffAt: "2026-09-14T03:57:46Z" }).kind).toBe("estimate_promised");
  expect(/まだ送っていない/.test(buildActionLedgerNote(l))).toBe(true);
});
it("見積書の送付は従来どおり送付済み（お送りさせて頂きました／となります／ご査収＋金額）", () => {
  expect(staffEstimateDelivered("昭和グランドハイツ恵美須の初期費用お見積書お送りさせていただきました！！\nお手隙の際にご査収ください！")).toBe(true);
  expect(staffEstimateDelivered("あいさんお世話になっております！！\nこちら初期費用の御見積書となります！")).toBe(true);
  expect(staffEstimateDelivered("【エストレーラ 305号室】\n初期費用の御見積書お送りさせて頂きます！！\n🌟13,250円割引させて頂いております！！\nお手隙の際にご査収ください😌！！")).toBe(true);
  expect(classifyStaffTextForLedger("こちら初期費用の御見積書となります！", null)?.kind).toBe("estimate_sent");
});
it("ゆうこ: 物件が無いまま見積書を約束済み（未送付）→ 見積の判定は約束の復唱もしない（forbid）・物件ありの約束は従来どおり復唱", () => {
  const v = isMisumoriContextAppropriate({ customerMessage: "初期費用やく3000円と家賃払えば入居できると思いました💦", recentCustomerMessages: [], lastStaffMessage: YUKO_STAFF, sentPropertiesCount: 0, estimatePromised: true, estimateActuallySent: false });
  expect(v.mode).toBe("forbid"); expect(v.signals.includes("estimate_promise_no_property")).toBe(true);
  const w = isMisumoriContextAppropriate({ customerMessage: "ありがとうございます", recentCustomerMessages: [], lastStaffMessage: "お送りさせて頂きました2件の最大限割引した初期費用の御見積書出来次第お送りさせて頂きます😊！！", sentPropertiesCount: 2, estimatePromised: true, estimateActuallySent: false });
  expect(w.mode).toBe("echo_only");
});
it("物件が無い時の見積書の約束では 見積書送る をセットしない（propertyInPlay=false）・物件があれば従来どおり", () => {
  const facts = { lastStaffEntry: { kind: "estimate_declared", status: "promised", evidence: "御見積書を作成しお送り" }, estimatePromisedUnfulfilled: true, pickupPromisedUnfulfilled: false };
  const msgs = [{ sender: "customer", text: "初期費用いくらですか" }, { sender: "staff", text: YUKO_STAFF }];
  expect(resolveStaffPromiseAix(facts, msgs, { propertyInPlay: false })).toBe(null);
  expect(resolveStaffPromiseAix(facts, msgs, { propertyInPlay: true })?.action ?? null).toBe("estimate_sheet");
});

const MEET_AIX = "かしこまりました！！\n9/14（月）12:00よりご案内させて頂きます！！\n\n9/14 12:00にメゾン加美北 305号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市平野区加美北9丁目2-7";
const MEET_STAFF = "名無しの権兵衛さん\nお世話になっております！！\n\nかしこまりました！！\n昭和グランドハイツ恵美須からお部屋ご案内させていただきます😊！！\n\n本日12:00に昭和グランドハイツ恵美須現地エントランス前待ち合わせの程よろしくお願いいたします！！\n\n住所:大阪市浪速区恵美須東1-5-17";
it("待ち合わせの取り出し: AIX 本文（9/14 12:00・メゾン加美北 305号室）・スタッフ本文（本日12:00→9/14）", () => {
  const a = extractViewingAppointment(MEET_AIX, "2026-09-13T02:24:03Z");
  expect(a?.dateMD).toBe("9/14"); expect(a?.time).toBe("12:00"); expect(a?.place).toBe("メゾン加美北 305号室");
  const b = extractViewingAppointment(MEET_STAFF, "2026-09-14T02:07:22Z");
  expect(b?.dateMD).toBe("9/14"); expect(b?.time).toBe("12:00"); expect(b?.place).toBe("昭和グランドハイツ恵美須");
});
it("待ち合わせの取り出し: 「10日12時半に」「11:50分に」「明日11:30に」", () => {
  const a = extractViewingAppointment("大丈夫です！！\n10日12時半に現地エントランスお待ち合わせで何卒よろしくお願い致します！！", "2026-09-08T02:00:00Z");
  expect(a?.dateMD).toBe("9/10"); expect(a?.time).toBe("12:30");
  const b = extractViewingAppointment("かしこまりました！！\n11:50分に現地エントランス前待ち合わせよろしくお願いいたします😊！！", "2026-09-08T02:00:00Z");
  expect(b?.time).toBe("11:50"); expect(b?.place).toBe(null);
  const c = extractViewingAppointment("明日11:30にアーバネックス東梅田現地エントランス前お待ち合わせ何卒よろしくお願い致します！！", "2026-09-08T02:00:00Z");
  expect(c?.dateMD).toBe("9/9"); expect(c?.place).toBe("アーバネックス東梅田");
});
it("物件の送付＋条件付きの見積書の案内（お気に召されましたら…御見積書も）は物件送付（見積書の送付・約束にしない）", () => {
  const e = classifyStaffTextForLedger("1件新着でオススメできるお部屋が募集に出ておりましたのでお送りさせて頂きました😊！！\nお気に召されましたら最大限割引させていただいた初期費用のお見積書もお送りさせていただきます😌！！", null);
  expect(e?.kind).toBe("properties_sent");
});
it("日程の打診（ご都合よろしいお日にち）は待ち合わせにしない", () =>
  expect(classifyStaffTextForLedger("直近ですと\n9/14(月) 12:00〜14:00 現地待ち合わせでご案内可能です😊！！\nご都合よろしいお日にち御座いますでしょうか！！", null)?.kind === "meeting_place_sent").toBe(false));
it("名無しの権兵衛: 当日の台帳に「内覧の待ち合わせ=9/14 12:00（本日）」・返信の注意に「着きました」の返し方（場所＝物件名は書かない）", () => {
  const l = buildActionLedger({
    recentAixRows: [{ aix_type: "meeting_place", created_at: "2026-09-13T02:24:05Z", sent_at: "2026-09-13T02:24:03Z", generated_text: MEET_AIX }],
    messages: [
      { sender: "staff", text: MEET_AIX, createdAt: "2026-09-13T02:24:03Z", isAix: true },
      { sender: "customer", text: "地下鉄平野駅集合が無理だったら下からの順番に変更お願いしたいです。", createdAt: "2026-09-14T01:56:48Z" },
      { sender: "staff", text: MEET_STAFF, createdAt: "2026-09-14T02:07:22Z" },
      { sender: "customer", text: "すみません、少し遅れます。", createdAt: "2026-09-14T02:48:54Z" },
      { sender: "staff", text: "かしこまりました！！\nお気をつけてお越しください！！", createdAt: "2026-09-14T02:53:15Z" },
      { sender: "customer", text: "着きました！", createdAt: "2026-09-14T02:59:03Z" },
    ],
    now: Date.parse("2026-09-14T02:59:20Z"),
  });
  expect(l.facts.viewingAppointment?.day).toBe("today"); expect(l.facts.viewingAppointment?.place).toBe("昭和グランドハイツ恵美須");
  expect(/内覧の待ち合わせ=9\/14 12:00（本日） 現地待ち合わせ/.test(l.summary)).toBe(true);
  const note = buildActionLedgerNote(l);
  expect(/着きました/.test(note) && /少々お待ちください/.test(note)).toBe(true);
  expect(/昭和グランドハイツ/.test(note) || /昭和グランドハイツ/.test(l.summary)).toBe(false);
});
it("過ぎた内覧の待ち合わせは載せない（翌日以降）", () => {
  const l = buildActionLedger({ recentAixRows: [{ aix_type: "meeting_place", created_at: "2026-09-13T02:24:05Z", sent_at: "2026-09-13T02:24:03Z", generated_text: MEET_AIX }], messages: [], now: Date.parse("2026-09-15T03:00:00Z") });
  expect(l.facts.viewingAppointment).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
