// 2026-09-17 竹内（あや事例）: 対象の無い「ご案内させて頂きます」を落とす／この会話で既に使った文を繰り返さない
// 実行: npx tsx app/lib/__tests__/reply-phrasing.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { splitSentences, stripPointlessGuidance, recentUsedSentences, findRepeatedSentences, buildAvoidRepeatNote } from "../reply-phrasing";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

// ─── 文の分割 ───
it("「！！」「。」「改行」で文に分ける（絵文字の後の「！！」も1文の終わり）", () => {
  expect(splitSentences("はい😊！！\nごゆっくりご検討頂けますと幸いです！！\n気になる点等出てきましたらご連絡ください😌！！"))
    .toBe(["はい😊！！", "ごゆっくりご検討頂けますと幸いです！！", "気になる点等出てきましたらご連絡ください😌！！"]);
  expect(splitSentences("1文だけ。2文目です！！")).toBe(["1文だけ。", "2文目です！！"]);
  expect(splitSentences("")).toBe([]);
});

// ─── ①対象の無い「ご案内させて頂きます」───
it("あや 9/16 22:17 の下書き: 「気になる点等出てきましたらご案内させて頂きますので、」の節が落ちて実送信の形になる", () => {
  const draft = "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\n気になる点等出てきましたらご案内させて頂きますので、いつでもお気軽にご連絡ください😌！！";
  expect(stripPointlessGuidance(draft)).toBe("はい😊！！\nごゆっくりご検討頂けますと幸いです！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください😌！！");
});
it("正しい「ご案内」は触らない（対象がある・スタッフの実送信）", () => {
  const keep = [
    // あや 9/16 17:42（対象＝お部屋）
    "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
    // 実送信（条件節は「お気に召されましたら」）
    "お部屋のご案内も可能ですのでお気に召されましたらご案内させていただきます！！",
    "アーバンフラッツ心斎橋のお部屋、確認させて頂きましたところ、こちらの3部屋現在募集中となっております！！\nよろしければご案内させて頂きます！！",
    // 時刻・物件名が対象
    "本日12時グレイスフルヴィラよりお部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！",
    "お友達の方も一緒にご案内させていただきます😊！！",
    "体調が戻られましたら改めてご案内させて頂きます！！",
    // 「ご連絡ください」があっても対象があるなら触らない
    "お気に召されましたらご都合よろしいお日にちにご案内させて頂きますので、お気軽にご連絡ください！！",
  ];
  for (const t of keep) expect(stripPointlessGuidance(t)).toBe(t);
});
it("「ご案内」が無い文・落とすと空になる文は触らない", () => {
  expect(stripPointlessGuidance("はい😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！"))
    .toBe("はい😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！");
  expect(stripPointlessGuidance("ご案内させて頂きます！！")).toBe("ご案内させて頂きます！！");   // 締めの語が無い＝別の場面
  expect(stripPointlessGuidance("")).toBe("");
});
it("丁寧形のゆれ（させていただきます・いたします）も同じように落とす", () => {
  expect(stripPointlessGuidance("ご不明な点が出てきましたらご案内いたしますので、いつでもお気軽にお知らせください！！"))
    .toBe("ご不明な点が出てきましたらいつでもお気軽にお知らせください！！");
});

// ─── ②繰り返しの検出 ───
const AYA_STAFF = [
  "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\n気になるお部屋ございましたらお送りください！！",
  "あやさんお世話になっております！！\n新着であやさんにオススメ出来るお部屋が募集に出ました😊！！",
  "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
];
it("既に使った文を集める（相槌「はい！！」や短い文は入れない・新しい通から）", () => {
  const used = recentUsedSentences(AYA_STAFF);
  // 一番新しい通（3通目）の文が先に入る
  expect(used.slice(0, 2)).toBe(["ごゆっくりご検討頂けますと幸いです！！", "お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！"]);
  expect(used.some((s) => s.startsWith("はい"))).toBe(false);
  expect(used.includes("ごゆっくりご検討頂けますと幸いです！！")).toBe(true);
  // 同じ文が2通に出ても1つだけ
  expect(used.filter((s) => s === "ごゆっくりご検討頂けますと幸いです！！").length).toBe(1);
});
it("下書きの締めが既出とほぼ同じなら気付く（言い回しの揺れ・敬語の違いは同じ扱い）", () => {
  const used = recentUsedSentences(AYA_STAFF);
  const hits = findRepeatedSentences("はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nあやさん気になる点等出てきましたら何時でもお気軽にご連絡ください！！", used);
  expect(hits.map((h) => h.sentence)).toBe(["ごゆっくりご検討頂けますと幸いです！！"]);
});
it("新しい内容の文は繰り返しにしない", () => {
  const used = recentUsedSentences(AYA_STAFF);
  const hits = findRepeatedSentences("あやさんのご条件に合うお部屋、新着で募集に出次第すぐにお送りさせて頂きます！！", used);
  expect(hits.length).toBe(0);
});
it("材料の文: 使った文が無ければ空・あれば箇条書きで渡す", () => {
  expect(buildAvoidRepeatNote([])).toBe("");
  const note = buildAvoidRepeatNote(["ごゆっくりご検討頂けますと幸いです！！"]);
  expect(note).toContain("【この会話で既に送った言い回し");
  expect(note).toContain("・ごゆっくりご検討頂けますと幸いです！！");
  expect(note).toContain("挨拶・相槌");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
