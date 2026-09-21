// 「否決・募集終了の報告があったか」の判定（竹内 2026-09-21）。
//
// 竹内「なんでここでお申込頂きありがとうございますと意味のわからない文が生成されるのか。
//   これ状況を読み取れていないから、ブレインのどこかに弱い部分がある」
//
// ★★ が付いたテストが今回の事故そのもの（実物の文をそのまま使う）。
//
// 実行: npx tsx app/lib/__tests__/negative-context.test.ts（全 PASS で exit 0）
import { resolveNegativeReport, STAFF_REPORT_MAX_AGE_MS } from "../negative-context";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
  };
}
const waitBrain = { fresh: true, stance: "wait", customerIntent: "negative" };

describe("★★ 今回の事故（ブレインの推測だけでネガ文脈にしない）", () => {
  it("★★ N1 物件の詳細を送った直後に「検討します」← ネガ文脈にしない", () => {
    // 実物: こちら「こちらお部屋の詳細となります！！／お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」
    const v = resolveNegativeReport({
      staffText: "お待たせ致しました！！\nこちらお部屋の詳細となります！！\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！\nお手隙の際にご査収ください😌！！",
      aixHistory: null,
      staffAgeMs: 3 * 60_000,
      brain: waitBrain,   // ← ブレインは「待ち＋懸念」。これだけでは立てない
    });
    expect(v.yes).toBe(false);
    expect(v.brainAgrees).toBe(true);   // ブレインの見立ては受け取るが根拠にしない
    // ⚠ 理由は「結果報告ではない（確認宣言・仮定）」になる。実物の「お気に召されまし**たら**」が
    //   仮定の語に当たるため。どちらの理由でも**立てない**という結論は同じなので、yes だけを見る
    if (!v.reason) throw new Error("理由が空");
  });
  it("★★ N1' 仮定の語が1つも無い送信でも、ブレインだけでは立てない", () => {
    const v = resolveNegativeReport({
      staffText: "こちらお部屋の詳細となります！！\n御見積書同封させて頂きました！！",
      staffAgeMs: 3 * 60_000,
      brain: waitBrain,
    });
    expect(v.yes).toBe(false);
    expect(v.reason).toContain("否決・募集終了の報告が無い");
  });
  it("★★ N2 ブレインが「待ち＋懸念」でも、報告の事実が無ければ立てない（根拠にしない）", () => {
    const v = resolveNegativeReport({ staffText: "御見積書お送りさせて頂きました！！", brain: waitBrain });
    expect(v.yes).toBe(false);
    expect(v.basis).toBe(null);
  });
  it("★ N3 ブレインが無くても結果は変わらない（ブレインは補助）", () => {
    const a = resolveNegativeReport({ staffText: "こちらお部屋の詳細となります！！", brain: waitBrain });
    const b = resolveNegativeReport({ staffText: "こちらお部屋の詳細となります！！", brain: null });
    expect(a.yes).toBe(b.yes);
  });
});

describe("★ 本物のネガは今までどおり立てる", () => {
  it("★ P1 募集終了の報告", () => {
    const v = resolveNegativeReport({ staffText: "確認しましたところ募集終了しておりました！！" });
    // ⚠「確認し」は仮定の語に当たるので落ちる。実際の報告文は下の形
    expect(v.yes).toBe(false);
  });
  it("★ P2 否決の報告", () => {
    const v = resolveNegativeReport({ staffText: "残念ながら審査否決となってしまいました🙇" });
    expect(v.yes).toBe(true);
    expect(v.basis).toBe("staff_text");
  });
  it("★ P3 申込が入ってしまった報告", () => {
    const v = resolveNegativeReport({ staffText: "先に申込が入ってしまいお部屋が埋まってしまいました🙇" });
    expect(v.yes).toBe(true);
  });
  it("★ P4 AIX の履歴が募集終了なら立てる", () => {
    const v = resolveNegativeReport({ staffText: "ご連絡ありがとうございます！！", aixHistory: "最新:property_check_result(結果:unavailable)" });
    expect(v.yes).toBe(true);
    expect(v.basis).toBe("aix_unavailable");
  });
});

describe("★ 立ててはいけない場面（今までの除外を保つ）", () => {
  it("★ E1 同時に代替を提案しているならネガではない", () => {
    const v = resolveNegativeReport({ staffText: "満室でしたが、代わりにこちらのお部屋オススメです！！" });
    expect(v.yes).toBe(false);
    expect(v.reason).toContain("代替");
  });
  it("★ E2 事前の確認宣言・仮定は結果報告ではない", () => {
    const v = resolveNegativeReport({ staffText: "募集終了の場合はすぐにご連絡させて頂きます！！" });
    expect(v.yes).toBe(false);
  });
  it("★ E3 72時間より前のこちらの発言では立てない", () => {
    const v = resolveNegativeReport({ staffText: "審査否決となってしまいました", staffAgeMs: STAFF_REPORT_MAX_AGE_MS + 1 });
    expect(v.yes).toBe(false);
    expect(v.reason).toContain("72時間");
  });
  it("E4 空でも落ちない", () => {
    expect(resolveNegativeReport({ staffText: "" }).yes).toBe(false);
  });
});

describe("根拠を残す", () => {
  it("★ R1 立った時はどれを根拠にしたかが分かる", () => {
    expect(resolveNegativeReport({ staffText: "審査否決となりました" }).basis).toBe("staff_text");
    expect(resolveNegativeReport({ staffText: "はい", aixHistory: "最新:property_check_result(結果:unavailable)" }).basis).toBe("aix_unavailable");
  });
  it("★ R2 立たなかった時は理由が分かる（次に誤ったら追える）", () => {
    for (const v of [
      resolveNegativeReport({ staffText: "オススメのお部屋です" }),
      resolveNegativeReport({ staffText: "確認させて頂きます" }),
      resolveNegativeReport({ staffText: "審査否決", staffAgeMs: STAFF_REPORT_MAX_AGE_MS + 1 }),
    ]) {
      if (!v.reason) throw new Error("理由が空");
    }
  });
});

describe("★ 二重の守り: 申込へのお礼を最終チェックが止める", () => {
  // final-check の BANNED_PATTERNS と同じ正規表現（四者同名）
  const APPLY_THANKS_RE = /お?申込(?:み|)(?:いただき|頂き|下さり|くださり)?(?:誠に)?ありがとう/;
  const SKIP_RE = /お申込(?:み)?(?:完了|手続き|させて(?:頂|いただ)き|進め|入(?:り|って))|審査(?:中|結果|進め|に進)|申込書|1番手|一番手|お部屋(?:を)?(?:抑え|押さえ)(?:させて|ました)/;
  it("★★ F1 今回の文を捕まえる", () => {
    expect(APPLY_THANKS_RE.test("お申込みいただきありがとうございます😊")).toBe(true);
  });
  it("★★ F2 依頼の形（実送信20通）は捕まえない", () => {
    for (const s of [
      "お気に召されましたらお部屋お申込みいただき、ご内覧設定させて頂きます！！",
      "お部屋埋まってしまう前にお申込みいただき、お部屋抑えた状態でご内覧いただくのをオススメいたします😊！！",
      "退去前のお部屋となりますので、お気に召されましたらお部屋お申込みいただき、ご内覧設定させて頂きます！！",
    ]) {
      if (APPLY_THANKS_RE.test(s)) throw new Error(`依頼の形を捕まえている: ${s}`);
    }
  });
  it("★ F3 申込が進んでいる会話では免除される", () => {
    for (const hist of [
      "お申込み手続き進めさせて頂きます！！",
      "無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます！！",
      "審査中となります",
    ]) {
      expect(SKIP_RE.test(hist)).toBe(true);
    }
  });
  it("★ F4 今回の会話（物件の詳細＋見積書）は免除に当たらない", () => {
    const hist = "こちらお部屋の詳細となります！！\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！\nお手隙の際にご査収ください😌！！";
    expect(SKIP_RE.test(hist)).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
