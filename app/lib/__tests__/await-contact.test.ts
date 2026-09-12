// 2026-09-12 竹内方針B: 「ご連絡お待ちしております」「承りました」の場面判定の回帰テスト。
//   根拠: スタッフ手打ち 6,107通中「ご連絡お待ちしております」12通（10通は顧客の連絡予告の直後・2通は顧客側が次に動く場面・依頼/質問の直後は0通）、
//   条件付きの予告の後は 0/11 件、「承りました」6通は全て「目的語＋承りました」。
// 実行: npx tsx app/lib/__tests__/await-contact.test.ts（全 PASS で exit 0）
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveCloser, predictCloserSignals, resolveAwaitContact,
} from "../reply-context";
import { runDeterministicChecks } from "../final-check";
import { normalizeBannedPhrasing, findUnanchoredUketamawari } from "../banned-phrasing";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) {
      const ok = Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" && actual.includes(String(item));
      if (!ok) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`);
    },
    not: { toContain(item: unknown) {
      const hit = Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" && actual.includes(String(item));
      if (hit) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`);
    } },
  };
}

const STAFF_PICKUP_DONE = "🌟メゾン難波 302号室\n家賃6.5万円\nお手隙の際にご査収ください😌！！";
const pairOf = (cust: string, staffText = STAFF_PICKUP_DONE, prior = "") => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: "2026-09-12T01:00:00Z" });
  const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, staff, {});
  return resolveTurnPair(staff, customer, sub, staffText, { priorCustomerText: prior, customerName: "ハル" });
};
const closerOf = (cust: string, staffText = STAFF_PICKUP_DONE, prior = "") =>
  resolveCloser(pairOf(cust, staffText, prior), predictCloserSignals({}), { customerName: "ハル" });
const codesOf = (text: string, cust: string, staffText = STAFF_PICKUP_DONE, prior = "") =>
  runDeterministicChecks(text, {
    lastCustomerMessage: cust, customerName: "ハル",
    recentMessages: [
      ...(prior ? [{ sender: "customer", text: prior, createdAt: "2026-09-12T00:30:00Z" }] : []),
      { sender: "staff", text: staffText, createdAt: "2026-09-12T01:00:00Z" },
      { sender: "customer", text: cust, createdAt: "2026-09-12T01:39:00Z" },
    ],
  }).map((i) => `${i.code}:${i.severity}`);

// 顧客の連絡予告（スタッフが「ご連絡お待ちしております」で返した実例の型）
const WILL_CONTACT = [
  "本日中にご連絡します",
  "火曜の日中までに調整してご連絡させていただきます",
  "明日また連絡します！",
  "帰宅後、連絡しますね",
  "また連絡します",
  "またご連絡させて頂きます",
  "必ずご連絡はいたします",
  // 「近隣駐車場を調べてご連絡します」（実例）は analyzeSubstance が「駐車場」を condition と数えるため allowed にならない（保守側・既定の締めのまま）
];

describe("resolveAwaitContact: 使ってよい場面", () => {
  for (const c of WILL_CONTACT)
    it(`予告「${c}」→ allowed`, () => {
      const v = resolveAwaitContact({ customerMessage: c, substance: analyzeSubstance(c) });
      expect(v.allowed).toBe(true);
    });
  it("時期のなぞり: 明日また連絡します → 「明日のご連絡お待ちしております」", () => {
    const v = closerOf("明日また連絡します！");
    expect(v.closer).toBe("await_contact");
    expect(v.text).toContain("明日のご連絡お待ちしております");
  });
  it("「今日」は「本日」でなぞる", () => {
    expect(closerOf("今日中にまた連絡します").text).toContain("本日のご連絡お待ちしております");
  });
  it("ハル型: 「1日ほどお待ちいただけますか」→ allowed", () => {
    expect(closerOf("すみません、1日ほどお待ちいただけますか？").closer).toBe("await_contact");
  });
  it("予告の後の了承（ありがとうございます）→ allowed（prior で判定）", () => {
    expect(closerOf("ありがとうございます！", "かしこまりました😊！！", "明日また連絡します").closer).toBe("await_contact");
  });
  it("締めに使った下書きは AWAIT_CONTACT_MISPLACED を出さない", () => {
    const draft = "はい😊！！\n明日のご連絡お待ちしております😊！！";
    expect(codesOf(draft, "明日また連絡します！")).not.toContain("AWAIT_CONTACT_MISPLACED:warning");
    expect(codesOf(draft, "明日また連絡します！")).not.toContain("BANNED_WORD:block");
  });
});

describe("resolveAwaitContact: 使わない場面", () => {
  it("依頼（初期費用を教えて）→ not allowed・下書きにあれば AWAIT_CONTACT_MISPLACED(warning)", () => {
    const cust = "この部屋の初期費用教えてください";
    expect(resolveAwaitContact({ customerMessage: cust, substance: analyzeSubstance(cust) }).allowed).toBe(false);
    const draft = "かしこまりました！！\nメゾン難波302号室の御見積書作成しお送りさせて頂きます！！\nご連絡お待ちしております😊！！";
    expect(codesOf(draft, cust)).toContain("AWAIT_CONTACT_MISPLACED:warning");
  });
  it("質問（空室確認＋内覧日）→ not allowed", () => {
    const cust = "302号室まだ空いてますか？土曜に内覧できますか？";
    expect(resolveAwaitContact({ customerMessage: cust, substance: analyzeSubstance(cust) }).allowed).toBe(false);
  });
  it("未履行のピックアップ約束がある（あい型）→ not allowed", () => {
    const cust = "また連絡します";
    const ledger = { facts: { pickupPromisedUnfulfilled: true } } as unknown as Parameters<typeof resolveAwaitContact>[0]["ledger"];
    expect(resolveAwaitContact({ customerMessage: cust, substance: analyzeSubstance(cust), ledger }).allowed).toBe(false);
  });
  it("条件付きの予告（決まり次第連絡します）→ open_door で条件をなぞる", () => {
    const v = closerOf("日程決まり次第連絡します");
    expect(v.closer).toBe("open_door");
    expect(v.text).toContain("決まりましたらいつでもお気軽にご連絡ください");
    expect(v.text).not.toContain("お待ちしております");
  });
  it("条件付きの予告（何かあれば連絡します）→ 「何かございましたら」", () => {
    const v = closerOf("何かあればまた連絡しますね");
    expect(v.closer).toBe("open_door");
    expect(v.text).toContain("何かございましたら");
  });
  it("検討してから連絡（検討系）→ 既定の wait_softly のまま", () => {
    expect(closerOf("一度家族と相談してから連絡します").closer).toBe("wait_softly");
  });
  it("予告の無い了承のみ → allowed でない", () => {
    expect(resolveAwaitContact({ customerMessage: "ありがとうございます", priorCustomerText: "", substance: analyzeSubstance("ありがとうございます") }).allowed).toBe(false);
  });
});

describe("承りました", () => {
  it("U1 単独・開口語の「承りました」→「かしこまりました」", () => {
    expect(normalizeBannedPhrasing("承りました！！\nピックアップしてお送りさせて頂きます！！").text).toBe("かしこまりました！！\nピックアップしてお送りさせて頂きます！！");
  });
  it("U2 「かしこまりました！！承りました！！」→ かしこまりましたを重ねない", () => {
    expect(normalizeBannedPhrasing("かしこまりました！！承りました！！\n確認させて頂きます！！").text).toBe("かしこまりました！！\n確認させて頂きます！！");
  });
  it("U3 目的語付きは残す（スタッフ実送信6通の型）", () => {
    for (const s of ["内覧のキャンセル承りました！！", "礼金なしのご希望も承りました😊！！", "本来のご希望は5.6万円程とのこと、承りました😊！！", "M’s Ring Grande 春日出北のご内覧、承りました！！", "Luxe難波西2の内覧キャンセル承りました！！"])
      expect(normalizeBannedPhrasing(s).text).toBe(s);
  });
  // スタッフ実送信6通（顧客の直近の発言3件を結合）→ 偽陽性0
  const REAL: Array<[string, string]> = [
    ["礼金なしのご希望も承りました😊！！", "礼金なしとかだと嬉しいです"],
    ["本来のご希望は5.6万円程とのこと、承りました😊！！", "8万も検討可というわけで、本来の希望は5.6万程です😭"],
    ["かしこまりました！！\n内覧のキャンセル承りました！！", "申し訳ないです\nすみません一旦引越し考え直すことになったので明日キャンセルでお願いします🙇‍♀️💦\n了解です！"],
    ["M’s Ring Grande 春日出北、フェルザ住之江公園のご内覧、承りました！！", "夜分遅くにすみません。\nこちらの2件を内見させて頂きたいのです。"],
    ["Luxe難波西2の内覧キャンセル承りました！！", "申し訳ありませんが、予定していたLuxe難波西2の内覧をキャンセルさせていただきたいです。"],
    ["かしこまりました！！\n内覧のキャンセル承りました！！", "ネットで見つけた気になる部屋を送っても大丈夫でしょうか？\nこちらの内覧はやはりキャンセルでお願いします\nこちらは内覧可能でしょうか？"],
  ];
  REAL.forEach(([staff, cust], i) => it(`U4-${i + 1} 正解文は UKETAMAWARI_OBJECT_UNANCHORED にならない`, () => {
    expect(findUnanchoredUketamawari(staff, cust)).toBe(null);
  }));
  it("U5 SHIGI 型: キャンセルしていない顧客へ「内覧のキャンセル承りました」→ block", () => {
    const cust = "302号室の初期費用も教えてほしいです";
    const draft = "かしこまりました！！\n内覧のキャンセル承りました！！\nメゾン難波302号室の御見積書作成しお送りさせて頂きます！！";
    expect(codesOf(draft, cust)).toContain("UKETAMAWARI_OBJECT_UNANCHORED:block");
  });
  it("U6 禁止語から外したので「承りました」単体では BANNED_WORD にならない", () => {
    const cust = "明日の内覧キャンセルでお願いします";
    const draft = "かしこまりました！！\n内覧のキャンセル承りました！！\nまたご都合よろしい際はお気軽にご連絡ください😊！！";
    const c = codesOf(draft, cust);
    expect(c).not.toContain("BANNED_WORD:block");
    expect(c).not.toContain("UKETAMAWARI_OBJECT_UNANCHORED:block");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
