// 漢字とひらがなの混ぜ方を実送信に合わせる（竹内 2026-09-21）。
//
// 竹内「実際のスタッフが送るような文が生成されていない可能性があるってこと？」
// → 下書きと実送信の差分で、消される1位「内させて頂きます」201回・足される1位「せていただきます」262回
//   ＝ 同じ意味で表記だけ違った。
//
// 実行: npx tsx app/lib/__tests__/notation-mix.test.ts（全 PASS で exit 0）
import { notationGaps, checkNotationMix, NOTATION_GAP_PT } from "../notation-mix";
import { buildWaitedNote, buildWaitedOpeningChoice, isWaitedAllowed, waitedSentRate, waitedUsedLastTime, WAITED_SENT_RATE, WAITED_NOTE_MIN_PCT } from "../waited-scope";

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
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(item)}`); },
  };
}

describe("表記のずれ（監査の表示用・生成には渡さない）", () => {
  it("★ N1 ずれの大きい組を拾う（させて頂く +25.1pt・致します +17.7pt・いつでも -15.7pt）", () => {
    const names = notationGaps().map((p) => p.name);
    expect(names.includes("させて頂く／させていただく")).toBe(true);
    expect(names.includes("致します／いたします")).toBe(true);
    expect(names.includes("何時でも／いつでも")).toBe(true);
  });
  it("N2 線は10pt（小さいずれは拾わない）", () => {
    expect(NOTATION_GAP_PT).toBe(10);
    for (const p of notationGaps()) {
      if (Math.abs(p.sentKanaPct - p.draftKanaPct) < 10) throw new Error(`${p.name} を拾っている`);
    }
  });
  it("★ N3 生成に渡す関数を作らない（2026-09-21 監査で止めた）", () => {
    // 1通に1回しか出ない・会話に合わせても当たらない・AI の選択は既に多数派、の3点で配線しないと決めた。
    // 将来また材料にしたくなった時は scripts/audit-notation-signal.ts を回してから。
    const mod = require("../notation-mix") as Record<string, unknown>;
    if (typeof mod.buildNotationNote === "function") {
      throw new Error("buildNotationNote が復活している。notation-mix.ts のヘッダ「監査で止めた」を読むこと");
    }
  });
});

describe("出来た文の表記を数える（本文は書き換えない）", () => {
  it("★ C1 漢字とひらがなを数える", () => {
    const r = checkNotationMix("ピックアップさせて頂きます！！\nお送りさせていただきます！！");
    const p = r.find((x) => x.name.startsWith("させて頂く"));
    if (!p) throw new Error("組が見つからない");
    expect(p.kanji).toBe(1);
    expect(p.kana).toBe(1);
    expect(Math.round(p.kanaPct)).toBe(50);
  });
  it("★ C2 全部漢字なら実送信とのずれが大きく出る", () => {
    const r = checkNotationMix("探させて頂きます！！\nお送りさせて頂きます！！\nご案内させて頂きます！！");
    const p = r.find((x) => x.name.startsWith("させて頂く"));
    if (!p) throw new Error("組が見つからない");
    expect(p.kanaPct).toBe(0);
    expect(Math.round(p.gapPt)).toBe(-32);   // 実送信32.5% に対して 0%（-32.5 → 四捨五入で -32）
  });
  it("C3 その語が無ければ返さない", () => {
    expect(checkNotationMix("はい😊！！").length).toBe(0);
  });
  it("C4 空でも落ちない", () => {
    expect(checkNotationMix("").length).toBe(0);
    expect(checkNotationMix(null).length).toBe(0);
  });
  it("★ C5 正規表現は監査と同じ数を数える（四者同名）", () => {
    // 「させて頂き」は「して頂き」にも一致しうるので、組み分けが崩れていないか
    const r = checkNotationMix("確認させて頂きます");
    expect(r.length).toBe(1);
    expect(r[0].name.startsWith("させて頂く")).toBe(true);
  });
});

describe("お待たせ致しました — 許す場面では率を材料にする", () => {
  it("★ W1 実測が高い場面は率を出す（property_send 45.7%）", () => {
    const n = buildWaitedNote("property_send");
    expect(n).toContain("45.7%");
    expect(n).toContain("お待たせ致しました");
  });
  it("★ W2 AI が書けていなかった場面も出る（property_check_result_unavailable 33.3%）", () => {
    expect(buildWaitedNote("property_check_result_unavailable")).toContain("33.3%");
  });
  it("★ W3 許さない場面では何も出さない（内覧日調整・待ち合わせ・通常返信）", () => {
    expect(buildWaitedNote("viewing_invite")).toBe("");
    expect(buildWaitedNote("meeting_place")).toBe("");
    expect(buildWaitedNote(null)).toBe("");
    expect(buildWaitedNote("")).toBe("");
  });
  it("★ W4 「必ず書け」とは言わない（一番高い場面でも65.2%）", () => {
    for (const a of ["property_send", "estimate_sheet", "zenryoku_support"]) {
      expect(buildWaitedNote(a)).notToContain("必ず");
    }
  });
  it("★ W5 実測が支えない条件を足さない（時間・約束では分かれなかった）", () => {
    // audit-waited-when.ts: 〜15分 28.6% ／ 1〜2時間 40.0% ／ 1日〜 19.7%、約束あり28.2% 対 なし22.9%
    const n = buildWaitedNote("property_send");
    expect(n).notToContain("すぐ返している時は書かない");
    expect(n).notToContain("時間が空いている");
    expect(n).notToContain("約束");
  });
  it("W6 実測が低い場面（10%未満）は出さない", () => {
    expect(buildWaitedNote("property_recommendation")).toBe("");
    expect(waitedSentRate("property_recommendation")).toBe(null);
    expect(WAITED_NOTE_MIN_PCT).toBe(10);
  });
  it("★ W7 許す場面の表と isWaitedAllowed が食い違わない", () => {
    for (const k of Object.keys(WAITED_SENT_RATE)) {
      const allowed = isWaitedAllowed(k);
      const high = WAITED_SENT_RATE[k] >= 10;
      if (high && !allowed) throw new Error(`${k} は実送信 ${WAITED_SENT_RATE[k]}% なのに許していない`);
      if (!high && allowed) throw new Error(`${k} は実送信 ${WAITED_SENT_RATE[k]}% なのに許している`);
    }
  });
  it("★ W8 実測 0.2%/559件 の property_recommendation は許さない側（2026-09-21 に外した）", () => {
    expect(isWaitedAllowed("property_recommendation")).toBe(false);
    expect(isWaitedAllowed("acknowledge_check")).toBe(false);
    // 接頭辞で拾う枝も道連れにしない
    expect(isWaitedAllowed("property_recommendation_pet")).toBe(false);
  });
});

describe("挨拶行の2択 — 1つに固定しない（YUMA 0/2 の原因）", () => {
  it("★ O1 許す場面では「お待たせ致しました」と従来の挨拶の2択になる", () => {
    const c = buildWaitedOpeningChoice("property_send", "お世話になっております！！");
    expect(c).toContain("お待たせ致しました！！");
    expect(c).toContain("お世話になっております！！");
    expect(c).toContain("45.7%");
    expect(c).toContain("54.3%");   // 残りの率も見せる（片方だけ見せると寄る）
  });
  it("★ O2 どちらかを選ばせる（1つに決めない・重ねさせない）", () => {
    const c = buildWaitedOpeningChoice("property_send", "お世話になっております！！");
    expect(c).toContain("どちらかを選んで");
    expect(c).toContain("両方を重ねて書かない");
    expect(c).notToContain("必ず");
  });
  it("★ O3 選ぶ基準は「こちらが作業した結果を届ける通か」（実測で分かれた唯一の軸）", () => {
    expect(buildWaitedOpeningChoice("estimate_sheet", "お世話になっております！！")).toContain("作業した結果を届ける通なら前者");
  });
  it("★ O4 本日挨拶済み（挨拶が空）でも2択にする（実測 45.6% 対 45.7% で変わらなかった）", () => {
    const c = buildWaitedOpeningChoice("property_send", "");
    expect(c).toContain("お待たせ致しました！！");
    expect(c).toContain("挨拶行を書かず名前行または本題から始める");
  });
  it("★ O5 許さない場面では空（呼び出し側は従来の固定値のまま）", () => {
    expect(buildWaitedOpeningChoice("viewing_invite", "お世話になっております！！")).toBe("");
    expect(buildWaitedOpeningChoice("property_recommendation", "お世話になっております！！")).toBe("");
    expect(buildWaitedOpeningChoice(null, "お世話になっております！！")).toBe("");
  });
  it("O6 構成①の見出しで始まる（挨拶行の実値の差し替えなので）", () => {
    expect(buildWaitedOpeningChoice("property_send", "お世話になっております！！").startsWith("①")).toBe(true);
  });
  it("★ O8 前回使っていなければ後者に寄せる（YUMA 3/3＝100% に振り切った対策・実測 22.6%）", () => {
    const c = buildWaitedOpeningChoice("property_send", "お世話になっております！！", false);
    expect(c).toContain("22.6%");
    expect(c).toContain("基本は後者");
  });
  it("★ O9 前回使っていれば前者を指示する（実測 55.8%）", () => {
    const c = buildWaitedOpeningChoice("property_send", "お世話になっております！！", true);
    expect(c).toContain("55.8%");
    // ⚠ 「今回も前者でよい」と書いたら YUMA 0/5 になった（許可は指示にならない）。後者側と強さを揃える
    expect(c).toContain("今回も前者で書き出す");
    expect(c).notToContain("でよい");
    expect(c).notToContain("基本は後者");
  });
  it("O10 前回が分からなければ寄せない（率だけ）", () => {
    const c = buildWaitedOpeningChoice("property_send", "お世話になっております！！", null);
    expect(c).notToContain("55.8%");
    expect(c).notToContain("22.6%");
  });
  it("★ O11 前回の判定は冒頭だけ見る・画像は飛ばす", () => {
    expect(waitedUsedLastTime(["YUMAさんお待たせ致しました！！\n物件です"])).toBe(true);
    expect(waitedUsedLastTime(["YUMAさんお世話になっております！！"])).toBe(false);
    // 途中に出る「お待たせ」は挨拶ではない
    expect(waitedUsedLastTime(["内覧のご案内です！！\n現地でお待たせしましたら申し訳御座いません"])).toBe(false);
    // 最後の1件を見る（古い順で渡す）
    expect(waitedUsedLastTime(["お待たせ致しました！！", "お世話になっております！！"])).toBe(false);
    // 画像だけの通は飛ばしてその前を見る
    expect(waitedUsedLastTime(["YUMAさんお待たせ致しました！！", "[画像]"])).toBe(true);
    expect(waitedUsedLastTime([])).toBe(null);
    expect(waitedUsedLastTime(["", "  "])).toBe(null);
  });
  it("★ O7 buildWaitedNote と同じ率を言う（四者同名・食い違わせない）", () => {
    for (const a of ["property_send", "estimate_sheet", "zenryoku_support", "property_check_result"]) {
      const rate = waitedSentRate(a);
      if (rate === null) throw new Error(`${a} の率が無い`);
      expect(buildWaitedNote(a)).toContain(`${rate}%`);
      expect(buildWaitedOpeningChoice(a, "お世話になっております！！")).toContain(`${rate.toFixed(1)}%`);
    }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
