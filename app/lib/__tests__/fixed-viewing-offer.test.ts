// app/lib/__tests__/fixed-viewing-offer.test.ts
// 実行: npx tsx app/lib/__tests__/fixed-viewing-offer.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内（まりあさん事例）
//   「内覧予定なのに約束覚えていない」「文制止するとまたいみのわからないぶんが生成されてしまっている。
//    お申込み情報らうけとっていないし、お客さんとは内覧に行く予定」
//
// 実物: 9/21 16:00 の内覧が決まっているまりあさんの「全て見に行きたいです！」に対し
//   AI 下書き「かしこまりました！！ お申込み情報受け取りました😊！！ こちらのお部屋、お申込み完了次第ご連絡させて頂きますので…」
//   スタッフの正解「かしこまりました！！ 明日全てご案内させていただきます！！ 何卒よろしくお願い致します！！」
//
// 生成の記録（reply_context_snapshot）が示した事実:
//   tier=T1（ブレインの判断は新鮮）／ledger.summary に「内覧の待ち合わせ=9/21 16:00（明日）現地待ち合わせ」
//   positive.kind=viewing_explicit（内覧希望と正しく認識）／turnPair=ES_POSITIVE
//   → **材料は全て正しく渡っていた。他のお客様のデータの混入は0件。**
//
// 根本原因: 2つの必須が正面衝突していた
//   行動台帳 : 「この内覧は決まっている。新しい内覧日程の打診（…「ご案内させて頂きます」）は書かない」
//   ES_POSITIVE: 「『ご都合よろしいお日にちにご案内させて頂きます😊！！』を1文入れる」（必須）
//   書くなと書けを同時に渡され、LLM はどちらも避けた第三の文＝受け取ってもいない申込の捏造を作った。
//
// 実データ（scripts/audit-fixed-viewing-reply.ts）: 内覧が決まっている間のスタッフ返信で
//   「ご都合よろしいお日にち」型の新規打診は 0/6（0%）。正解形は決まっている日時をそのまま言う。
import {
  viewingOfferLiteral, fixedViewingOfferLiteral, formatAppointmentTime,
  VIEWING_DATE_ASK_RE, isBareViewingOffer, type FixedViewing,
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair,
  fillPairPlaceholders, selectPairExample,
} from "../reply-context";
import { buildActionLedger, buildActionLedgerNote, type LedgerAixRow, type LedgerMessage } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入ってはいけない`); },
  };
}
const appt = (o: Partial<FixedViewing>): FixedViewing =>
  ({ dateMD: null, time: null, place: null, day: "unknown", sentAt: null, ...o }) as FixedViewing;

console.log("\n── 時刻の言い方（台帳の値だけを使う・創作しない）──");

it("16:00 → 16時", () => { expect(formatAppointmentTime("16:00")).toBe("16時"); });
it("16:30 → 16時30分", () => { expect(formatAppointmentTime("16:30")).toBe("16時30分"); });
it("9:00 → 9時", () => { expect(formatAppointmentTime("9:00")).toBe("9時"); });
it("秒付きでも読める", () => { expect(formatAppointmentTime("16:00:00")).toBe("16時"); });
it("★ 読めない時は空（時刻を作らない）", () => {
  for (const v of [null, undefined, "", "未定", "夕方", "25:00", "12:99"]) expect(formatAppointmentTime(v)).toBe("");
});

console.log("\n── ★ 決まっている内覧の案内文（実送信の形）──");

it("★ まりあさん事例: 明日16時 → 「明日16時お部屋ご案内させて頂きます！！」", () => {
  const s = fixedViewingOfferLiteral("まりあ", appt({ dateMD: "9/21", time: "16:00", day: "tomorrow" }));
  expect(s).toBe("まりあさん明日16時お部屋ご案内させて頂きます！！");
});

it("本日の内覧（実送信「本日16時お部屋ご案内させて頂きます！」と同型）", () => {
  const s = fixedViewingOfferLiteral("ニア", appt({ time: "16:00", day: "today" }));
  expect(s).toBe("ニアさん本日16時お部屋ご案内させて頂きます！！");
});

it("先の日付は M/D をそのまま言う", () => {
  const s = fixedViewingOfferLiteral("あやぴ", appt({ dateMD: "9/25", time: "12:00", day: "later" }));
  expect(s).toContain("9/25");
  expect(s).toContain("12時");
});

it("日時が読めない時は日時を書かない（決まっている事実だけ言う）", () => {
  const s = fixedViewingOfferLiteral("YUMA", appt({ day: "unknown" }));
  expect(s).toBe("YUMAさんお部屋ご案内させて頂きます！！");
});

it("名前が分からない時は呼びかけを書かない（〇〇さん を作らない）", () => {
  const s = fixedViewingOfferLiteral("", appt({ time: "16:00", day: "tomorrow" }));
  expect(s).toBe("明日16時お部屋ご案内させて頂きます！！");
  expect(s).notToContain("〇〇");
});

it("複数部屋の指名があれば部屋数で受ける", () => {
  const s = fixedViewingOfferLiteral("まりあ", appt({ time: "16:00", day: "tomorrow" }), 3);
  expect(s).toContain("3部屋");
});

console.log("\n── ★ ここが事故の核（書くなと書けの衝突を消す）──");

it("★ 内覧が決まっている時は「ご都合よろしいお日にち」を絶対に返さない", () => {
  for (const day of ["today", "tomorrow", "later", "unknown"] as const) {
    const s = viewingOfferLiteral("まりあ", true, 1, appt({ dateMD: "9/21", time: "16:00", day }));
    expect(s).notToContain("ご都合");
    expect(s).notToContain("お気に召され");
    expect(s).notToContain("よろしければ");
  }
});

it("★ 決まっていない時は従来どおり [Y] 型（退行させない）", () => {
  expect(viewingOfferLiteral("まりあ", true, 1)).toBe("よろしければまりあさんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！");
  expect(viewingOfferLiteral("まりあ", false, 1)).toBe("まりあさんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！");
  expect(viewingOfferLiteral("まりあ", true, 1, null)).toContain("ご都合よろしいお日にち");
});

it("★ 返す文が AIX 専用の疑問形（VIEWING_DATE_ASK）に当たらない", () => {
  const s = fixedViewingOfferLiteral("まりあ", appt({ time: "16:00", day: "tomorrow" }));
  expect(VIEWING_DATE_ASK_RE.test(s)).toBe(false);
});

it("★ 返す文が禁止形の裸の内覧提案（isBareViewingOffer）に当たらない", () => {
  const s = fixedViewingOfferLiteral("まりあ", appt({ time: "16:00", day: "tomorrow" }));
  expect(isBareViewingOffer(s)).toBe(false);
});

it("★ ES_POSITIVE の必須要素（内覧のご案内）を満たす形である", () => {
  const s = fixedViewingOfferLiteral("まりあ", appt({ time: "16:00", day: "tomorrow" }));
  expect(/ご案内|ご内覧|内覧|内見/.test(s)).toBe(true);
  // NEXT_MOVE_RE（PS_POSITIVE / CR_POSITIVE の「次の一手」）の「ご案内させて頂きます」側
  expect(/ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます/.test(s)).toBe(true);
});

it("★ 申込に一切触れない（受け取っていない申込を書かせない）", () => {
  const s = fixedViewingOfferLiteral("まりあ", appt({ time: "16:00", day: "tomorrow" }));
  expect(s).notToContain("申込");
  expect(s).notToContain("受け取り");
});

// ─────────────────────────────────────────────────────────────
// まりあさん事例をそのまま組み立てて、生成に渡る材料が矛盾しないことを見る
//   9/19 AIX【待ち合わせ】で 9/21 16:00 を案内 → 9/20 AIX 見積書 → 顧客「全て見に行きたいです！」
// ─────────────────────────────────────────────────────────────
console.log("\n── ★ まりあさん事例の再現（台帳 → 往復文脈 → 渡る文）──");

const T = (s: string) => new Date(`2026-${s}:00+09:00`).toISOString();
const MEETING_BODY = "9/21 16:00にお部屋\n現地エントランスお待ち合わせでお願い致します！！";
const ESTIMATE_BODY = "お世話になっております！！\n初期費用の御見積書お送りさせて頂きます！！\nお手隙の際にご査収ください😌！！";
const CUST = "全て見に行きたいです！";

const mariaMessages: LedgerMessage[] = [
  { sender: "staff", text: MEETING_BODY, createdAt: T("09-19T12:46") },
  { sender: "staff", text: ESTIMATE_BODY, createdAt: T("09-20T12:51") },
  { sender: "customer", text: CUST, createdAt: T("09-20T13:33") },
];
const mariaAix: LedgerAixRow[] = [
  { aix_type: "meeting_place", created_at: T("09-19T12:46"), sent_at: T("09-19T12:46"), generated_text: MEETING_BODY },
  { aix_type: "estimate_sheet", created_at: T("09-20T12:51"), sent_at: T("09-20T12:51"), generated_text: ESTIMATE_BODY, estimate_sent: true },
];
const mariaLedger = buildActionLedger({
  recentAixRows: mariaAix, messages: mariaMessages, lineTasks: [],
  lastCustomerAt: T("09-20T13:33"), now: Date.parse(T("09-20T13:35")),
});

it("★ 台帳が 9/21 16:00 の内覧を「明日」として持っている（お客様ごとの予定の把握）", () => {
  const a = mariaLedger.facts.viewingAppointment;
  if (!a) throw new Error(`台帳が内覧の待ち合わせを持っていない: ${mariaLedger.summary}`);
  expect(a.dateMD).toBe("9/21");
  expect(a.time).toBe("16:00");
  expect(a.day).toBe("tomorrow");
});

const mariaPair = (() => {
  const staff = classifyLastStaffTurn(ESTIMATE_BODY, { recentAixRows: [], lastStaffAt: T("09-20T12:51"), ledger: mariaLedger });
  const sub = analyzeSubstance(CUST, undefined, { staffAskedQuestion: false });
  const customer = classifyCustomerResponse(sub, staff, { ledger: mariaLedger });
  return resolveTurnPair(staff, customer, sub, ESTIMATE_BODY, { ledger: mariaLedger, customerName: "まりあ" });
})();

it("★ 台帳の注記が「ご案内させて頂きます」を丸ごと禁止しない（旧: 必須要素と正面衝突していた）", () => {
  const note = buildActionLedgerNote(mariaLedger, { customerName: "まりあ" });
  expect(note).toContain("この内覧は決まっている");
  // 決まっている日時を言う正解形が注記の中に示されている
  expect(note).toContain("16時お部屋ご案内させて頂きます");
  // 旧注記の「『ご案内させて頂きます』は書かない」が消えていること
  if (/「ご都合よろしいお日にち」「ご案内させて頂きます」/.test(note)) throw new Error("旧注記（ご案内させて頂きますごと禁止）が残っている");
});

it("★ 台帳の注記が「申込は受け取っていない」を明示する", () => {
  const note = buildActionLedgerNote(mariaLedger, { customerName: "まりあ" });
  expect(note).toContain("申込は受け取っていない");
});

it("★ この場面で LLM に渡る必須要素の文が「明日16時…」になる（旧:「ご都合よろしいお日にちに」）", () => {
  const active = (mariaPair.rule?.mustInclude ?? []).filter((m) => !m.when || m.when(mariaPair));
  if (active.length === 0) throw new Error(`必須要素が無い（rule=${mariaPair.ruleId}）`);
  const fixes = active.map((m) => fillPairPlaceholders(m.fix, mariaPair)).join("\n");
  expect(fixes).toContain("明日16時");
  expect(fixes).notToContain("ご都合よろしいお日にち");
});

it("★ この場面で LLM に渡る例文も「明日16時…」になる", () => {
  const ex = selectPairExample(mariaPair, CUST);
  if (!ex.text) throw new Error("例文が渡らない");
  expect(ex.text).toContain("明日16時");
  expect(ex.text).notToContain("ご都合よろしいお日にち");
});

it("★ 渡る材料のどこにも「申込を受け取った」を誘う文が無い", () => {
  const all = [
    buildActionLedgerNote(mariaLedger, { customerName: "まりあ" }),
    fillPairPlaceholders(mariaPair.rule?.direction ?? "", mariaPair),
    ...(mariaPair.rule?.mustInclude ?? []).map((m) => fillPairPlaceholders(m.fix, mariaPair)),
    selectPairExample(mariaPair, CUST).text ?? "",
  ].join("\n");
  if (/申込[^\n。！!]{0,10}(?:受け取り|受領|拝受)(?!ました」等|ません)/.test(all)) {
    throw new Error(`申込受領を誘う文が材料に残っている`);
  }
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
