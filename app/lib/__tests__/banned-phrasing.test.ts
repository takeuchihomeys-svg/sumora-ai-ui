// 2026-09-11 竹内方針4・5: 「承知しました」系→「かしこまりました」・約束の「すぐに」除去（banned-phrasing.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/banned-phrasing.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { normalizeShochi, stripHastyAdverb, normalizeBannedPhrasing } from "../banned-phrasing";
import { runDeterministicChecks } from "../final-check";

// ── ミニハーネス ──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (!Array.isArray(actual) || !actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) && actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}
const codesOf = (text: string) => runDeterministicChecks(text, { customerName: "佐藤" }).map((i) => `${i.code}:${i.severity}`);

describe("方針4 承知→かしこまりました", () => {
  it("B1 文中の「〜とのこと、承知いたしました」→「〜とのこと、かしこまりました」", () => {
    expect(normalizeShochi("法人契約ご希望とのこと、承知いたしました！！").text).toBe("法人契約ご希望とのこと、かしこまりました！！");
  });
  it("B2 行頭の開口語と文中の承知が両方ある時は行頭側を削る（かしこまりましたを2回にしない）", () => {
    expect(normalizeShochi("かしこまりました！！\n12月更新とのこと承知致しました😊！！").text).toBe("12月更新とのことかしこまりました😊！！");
  });
  it("B3 開口が「はい」の時は削らない", () => {
    expect(normalizeShochi("はい！！\nかしこまりました！！\nご希望の件承知しました！！").text).toBe("はい！！\nかしこまりました！！\nご希望の件かしこまりました！！");
  });
  it("B4 開口語の承知だけ → かしこまりました（本文は残す）", () => {
    expect(normalizeShochi("承知しました！！\n募集状況確認させて頂きます！！").text).toBe("かしこまりました！！\n募集状況確認させて頂きます！！");
  });
});

describe("方針5 すぐに除去", () => {
  it("H1 「確認出来次第すぐにご連絡」→「確認出来次第ご連絡」", () => {
    expect(stripHastyAdverb("確認出来次第すぐにご連絡させて頂きます！！").text).toBe("確認出来次第ご連絡させて頂きます！！");
  });
  it("H2 「退去後すぐにご案内させて頂きます」→「退去後ご案内させて頂きます」", () => {
    expect(stripHastyAdverb("退去後すぐにご案内させて頂きます！！").text).toBe("退去後ご案内させて頂きます！！");
  });
  it("H3 「今すぐピックアップしてお送り」→「ピックアップしてお送り」", () => {
    expect(stripHastyAdverb("今すぐピックアップしてお送りさせて頂きます！！").text).toBe("ピックアップしてお送りさせて頂きます！！");
  });
  it("H4 変えない: 希少性の事実・すぐにご入居・すぐには・玄関入ってすぐ", () => {
    for (const s of ["好条件のお部屋はすぐに埋まってしまう可能性が高いです！！", "すぐにご入居可能なお部屋ピックアップさせて頂きます！！", "すぐにはできない状況です", "玄関入ってすぐ手前が洗面所となります！！"]) {
      expect(stripHastyAdverb(s).text).toBe(s);
    }
  });
  it("H5 「すぐご案内」（に なし）も除く", () => {
    expect(stripHastyAdverb("確認してすぐご案内させて頂きます！！").text).toBe("確認してご案内させて頂きます！！");
  });
});

describe("置換後は検査に出ない（後処理と検査が同じ定義）", () => {
  it("V1 置換後の文に HASTY_PROMISE と BANNED_WORD（承知）が出ない", () => {
    const src = "承知いたしました！！\n確認出来次第すぐにご連絡させて頂きます！！";
    const before = codesOf(src);
    expect(before).toContain("HASTY_PROMISE:block");
    expect(before).toContain("BANNED_WORD:block");
    const after = codesOf(normalizeBannedPhrasing(src).text);
    expect(after).not.toContain("HASTY_PROMISE:block");
    expect(after).not.toContain("BANNED_WORD:block");
  });
  it("V2 件数を返す（tpo_debug の観測用）", () => {
    const r = normalizeBannedPhrasing("承知しました！！\nすぐにお送りさせて頂きます！！");
    expect(r.shochi).toBe(1);
    expect(r.hasty).toBe(1);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
