// 2026-09-11 竹内方針4・5: 「承知しました」系→「かしこまりました」・約束の「すぐに」除去（banned-phrasing.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/banned-phrasing.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { normalizeShochi, stripHastyAdverb, normalizeBannedPhrasing, stripHeadGreeting, HASTY_ADVERB_TEST_RE } from "../banned-phrasing";
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
  // 2026-09-12 竹内方針E: 「次第」起点の取りこぼし（20字超・一覧外の動詞）
  it("H6 「次第すぐに」＋20字超の動詞 →「すぐに」だけ除去", () => {
    const src = "確認取れ次第すぐに空き状況と初期費用の詳細を最大限割引したお見積書にまとめてご連絡させて頂きます！！";
    expect(stripHastyAdverb(src).text).toBe("確認取れ次第空き状況と初期費用の詳細を最大限割引したお見積書にまとめてご連絡させて頂きます！！");
    expect(HASTY_ADVERB_TEST_RE.test(src)).toBe(true);
  });
  it("H7 「出次第すぐにお電話差し上げます」→「出次第お電話差し上げます」", () => {
    expect(stripHastyAdverb("出次第すぐにお電話差し上げます！！").text).toBe("出次第お電話差し上げます！！");
  });
  it("H8 変えない: 顧客の希望を伝える「審査通過次第すぐにご入居したい旨」", () => {
    const s = "審査通過次第すぐにご入居したい旨管理会社にお伝えさせて頂きます！！";
    expect(stripHastyAdverb(s).text).toBe(s);
  });
  it("H9 「新着物件が出次第、すぐにお送り」→ 読点は残して「すぐに」だけ除去", () => {
    expect(stripHastyAdverb("新着物件が出次第、すぐにお送りさせて頂きます！！").text).toBe("新着物件が出次第、お送りさせて頂きます！！");
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

describe("2026-09-12 竹内（Aoi 事例）: 返信に夜間挨拶を入れない", () => {
  it("N1 「夜遅くに失礼します！！Aoiさんお世話になっております！！」→ 夜間挨拶だけ除去", () => {
    const r = normalizeBannedPhrasing("夜遅くに失礼します！！Aoiさんお世話になっております！！\nかしこまりました！！");
    expect(r.text).toBe("Aoiさんお世話になっております！！\nかしこまりました！！"); expect(r.night).toBe(1);
  });
  it("N2 行単独の「夜分遅くに失礼致します！！」→ 行ごと除去", () => {
    expect(normalizeBannedPhrasing("夜分遅くに失礼致します！！\nこちら初期費用の御見積書となります！！").text).toBe("こちら初期費用の御見積書となります！！");
  });
  it("N3 本文中の無関係な「夜」は残す（夜間の内覧も可能です）", () => {
    expect(normalizeBannedPhrasing("夜間のご内覧も可能です！！").text).toBe("夜間のご内覧も可能です！！");
  });
});

describe("2026-09-12 竹内: 挨拶を重ねない（1通に挨拶は1つ）", () => {
  it("G1 はじめまして＋お世話になっております → はじめまして（初回の名乗り）だけ残す", () => {
    const r = normalizeBannedPhrasing("HNKAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\nHNKAさんお世話になっております！！\n御堂筋線・新大阪駅周辺全域からピックアップさせて頂きます！！");
    expect(r.text).toBe("HNKAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n御堂筋線・新大阪駅周辺全域からピックアップさせて頂きます！！");
    expect(r.greetDup).toBe(1);
  });
  it("G2 お世話になっております が2回 → 1回目だけ", () => {
    expect(normalizeBannedPhrasing("Aoiさんお世話になっております！！\nかしこまりました！！\nいつもお世話になっております！！\n何卒よろしくお願い致します！！").text)
      .toBe("Aoiさんお世話になっております！！\nかしこまりました！！\n何卒よろしくお願い致します！！");
  });
  it("G3 夜間挨拶＋お世話になっております → お世話になっております だけ（夜間は除去）", () => {
    expect(normalizeBannedPhrasing("夜遅くに失礼します！！みくさんお世話になっております！！\nはい😊！！").text).toBe("みくさんお世話になっております！！\nはい😊！！");
  });
  it("G4 挨拶が1つなら何もしない", () => {
    const t = "じゅにあさんお世話になっております！！\nかしこまりました！！";
    expect(normalizeBannedPhrasing(t).text).toBe(t);
  });
});

describe("2026-09-15 竹内（慶次事例）: 夜にこちらから届ける AIX は夜間挨拶を残す（keepNightGreeting）", () => {
  it("K1 「慶次さん夜分遅くに失礼致します！！」はそのまま残る", () => {
    const t = "慶次さん夜分遅くに失礼致します！！\n\n無事ご入居間に合いますようにサポートさせて頂きます！！\nお手隙の際にご査収ください😌！！";
    const r = normalizeBannedPhrasing(t, { keepNightGreeting: true });
    expect(r.text).toBe(t); expect(r.night).toBe(0);
  });
  it("K2 夜間挨拶＋お世話になっております（重ね）→ お世話になっておりますを落とす", () => {
    expect(normalizeBannedPhrasing("慶次さん夜分遅くに失礼致します！！\n慶次さんお世話になっております！！\nお手隙の際にご査収ください😌！！", { keepNightGreeting: true }).text)
      .toBe("慶次さん夜分遅くに失礼致します！！\nお手隙の際にご査収ください😌！！");
  });
  it("K3 夜間挨拶が2つ → 1つ目だけ", () => {
    expect(normalizeBannedPhrasing("慶次さん夜分遅くに失礼致します！！\n夜分遅くに失礼致します！！\nお手隙の際にご査収ください😌！！", { keepNightGreeting: true }).text)
      .toBe("慶次さん夜分遅くに失礼致します！！\nお手隙の際にご査収ください😌！！");
  });
  it("K5 夜分に決まっているのに LLM が「〇〇さんお世話になっております！！」で書いた → 先頭の挨拶を夜分に", () => {
    expect(normalizeBannedPhrasing("慶次さんお世話になっております！！\n無事ご入居間に合いますようにサポートさせて頂きます！！", { keepNightGreeting: true }).text)
      .toBe("慶次さん夜分遅くに失礼致します！！\n無事ご入居間に合いますようにサポートさせて頂きます！！");
  });
  it("K6 先頭が挨拶でなければ触らない（本文中のお世話になっておりますは対象外）", () => {
    const t = "こちら初期費用の御見積書となります！！\nいつもお世話になっております";
    expect(normalizeBannedPhrasing(t, { keepNightGreeting: true }).text).toBe(t);
  });
  it("K4 オプション無し（返信）は従来どおり除去", () => {
    expect(normalizeBannedPhrasing("慶次さん夜分遅くに失礼致します！！\nお手隙の際にご査収ください😌！！").text).toBe("お手隙の際にご査収ください😌！！");
  });
});

// 2026-09-16 竹内（カイナ事例・AIX 代理契約）: お客様の依頼への返答は本題から入る
it("先頭の挨拶行を落とす（お世話になっております・夜分遅くに）", () => {
  expect(stripHeadGreeting("カイナさんお世話になっております！！\n\nアーバンフラッツ心斎橋に代理契約可能か管理会社に確認させて頂きましたところ\n代理契約可能となります😊！！").text)
    .toBe("アーバンフラッツ心斎橋に代理契約可能か管理会社に確認させて頂きましたところ\n代理契約可能となります😊！！");
  expect(stripHeadGreeting("慶次さん夜分遅くに失礼致します！！\n代理契約可能となります😊！！").text).toBe("代理契約可能となります😊！！");
  // 同じ行に本題が続く時は挨拶だけ落とす
  expect(stripHeadGreeting("お世話になっております！！代理契約可能となります😊！！").text).toBe("代理契約可能となります😊！！");
  // 挨拶が無ければそのまま
  const t = "アーバンフラッツ心斎橋に代理契約可能か管理会社に確認させて頂きましたところ\n代理契約可能となります😊！！";
  expect(stripHeadGreeting(t).text).toBe(t);
  expect(stripHeadGreeting(t).count).toBe(0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
