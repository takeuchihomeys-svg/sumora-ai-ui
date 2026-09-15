// 2026-09-12 竹内（あや事例）: AI の作業メモは下書き欄に絶対に入れない
// 実行: npx tsx app/lib/__tests__/meta-narration.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { stripMetaNarration, isMetaNarrationLine } from "../meta-narration";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const AYA_DRAFT = "「284,500円になる感じですか？」という金額確認質問への直接回答を組み立てます。\n\nかしこまりました！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！";

it("あや: 先頭の作業メモ「〜への直接回答を組み立てます。」を消す", () => {
  const r = stripMetaNarration(AYA_DRAFT);
  expect(r.text).toBe("かしこまりました！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！");
  expect(r.removed.length).toBe(1);
});
it("過去に送られた作業メモ「シミズリルナさんへの返信案：」を消す", () => {
  expect(stripMetaNarration("シミズリルナさんへの返信案：\n\nシミズリルナさんお世話になっております！！").text).toBe("シミズリルナさんお世話になっております！！");
});
it("過去に送られた作業メモ「…親切に対応する返信を作成します。」を消す", () => {
  expect(isMetaNarrationLine("TikTokのリンク送信が続いているため、お客様の意図を確認しながら、親切に対応する返信を作成します。")).toBe(true);
});
it("見出しと本文が同じ行「修正後：〇〇さんお世話に…」→ 見出しだけ外す", () => {
  expect(stripMetaNarration("修正後：あやさんお世話になっております！！").text).toBe("あやさんお世話になっております！！");
});
it("お客様への問いかけ「「明日行けます」というお返事が、どのご質問に対するお返事なのか…」は消さない", () => {
  const t = "申し訳ございません、シミズリルナさんの「明日行けます」というお返事が、どのご質問に対するお返事なのかがちょっと理解できなくて申し訳ないです";
  expect(stripMetaNarration(t).text).toBe(t);
});
it("お客様への宣言「御見積書を作成しお送りさせて頂きます！！」は消さない", () => {
  expect(isMetaNarrationLine("最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！")).toBe(false);
});
it("「ご質問への回答をまとめさせて頂きます！！」（お客様への文）は消さない", () => {
  expect(isMetaNarrationLine("ご質問への回答をまとめさせて頂きます！！")).toBe(false);
});
it("YUMA 9/15「お客様がスタンプのみで返信されている状況ですね。…待つ姿勢のみを示します。」を消す", () => {
  const t = "お客様がスタンプのみで返信されている状況ですね。電話をかけてほしいという依頼を既に伝えているため、追加の催促にならないよう、短く待つ姿勢のみを示します。\n\nはい😊！！\nお電話お待ちしております！！";
  expect(stripMetaNarration(t).text).toBe("はい😊！！\nお電話お待ちしております！！");
});
it("方針の独り言「〜の方針で返信します。」だけの行を消す／お客様への文は消さない", () => {
  expect(isMetaNarrationLine("前向きな反応のため、内覧のご案内を添える方針で返信します。")).toBe(true);
  expect(isMetaNarrationLine("お客様のご都合に合わせてご案内させて頂きます！！")).toBe(false);
});
// 形で見分ける（AI 下書き180日の実際の作業メモ・言い回しの一覧に無い物）
const REAL_NARRATIONS = [
  "物件資料を確認します。",
  "まず物件情報を確認します。",
  "いくつか確認してから出力します。",
  "確認事項がいくつかあります。出力前に整理します。",
  "35万円の物件については、募集状況を確認する旨のみ伝え、断言はしないパターンで返信します。",
  "会社所在地の情報を持ち合わせていないため、正直に確認する形で対応します。",
  "分割払いの可否について、正確な回答が必要な質問です。",
  "クリーニング代の質問には物件固有の確認が必要な事項として即答せず、確認宣言で対応します。",
  "お客様名は「Nakayama」、送られてきた物件は1件と特定しました。",
  "「ここは誰か住んでましたか？」への回答が抜けているため、その点を踏まえます。",
];
for (const n of REAL_NARRATIONS) {
  it(`先頭の作業メモ「${n.slice(0, 24)}…」を落とす`, () => {
    expect(stripMetaNarration(`${n}\n\nかしこまりました！！\nお調べさせて頂きます😊！！`).text).toBe("かしこまりました！！\nお調べさせて頂きます😊！！");
  });
}
it("作業メモ＋「---」の区切り → 区切りごと落とす", () => {
  expect(stripMetaNarration("まず物件資料を確認します。\n\n---\n\nこちらのお部屋募集中となります！！").text).toBe("こちらのお部屋募集中となります！！");
});
// スタッフの実送信の先頭行（誤って消さない）
const STAFF_FIRST_LINES = [
  "住所は住民票記載の住所となります。",
  "こちら外観と室内の写真掲載されております。",
  "かしこまりました。",
  "承知しました。",
  "駅近のお部屋で本日ご案内可能なお部屋現在募集中では無い状況となります。",
  "管理会社定休日となり洋室にエアコンが設置可能か確認が取れませんでした。",
  "はい。",
];
for (const s of STAFF_FIRST_LINES) {
  it(`スタッフの先頭行「${s.slice(0, 20)}」は消さない`, () => {
    const t = `${s}\n\n何卒よろしくお願い致します！！`;
    expect(stripMetaNarration(t).text).toBe(t);
  });
}
it("全部が地の文なら触らない（空の下書きにしない）", () => {
  expect(stripMetaNarration("物件資料を確認します。").text).toBe("物件資料を確認します。");
});
it("仕上げ処理（applySurfaceFixes）でも消える", () => {
  const r = applySurfaceFixes(AYA_DRAFT, { customerName: "あや" });
  expect(r.text.startsWith("かしこまりました！！")).toBe(true);
  expect(r.applied.some((a) => a.startsWith("META_NARRATION_REMOVED"))).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
