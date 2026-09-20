// app/lib/__tests__/apply-readiness.test.ts
// 実行: npx tsx app/lib/__tests__/apply-readiness.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「テストしながらおねがい／過去の成約データや直近の会話から学習して／
//   **文おかしい文が出来ないかテストしておこなう／いろんなパターンを想定してテスト行う**」
//
// 材料は**本番の実物**（scripts/audit-apply-threshold.ts で線を引いた時に読んだ会話）。
import { detectApplyReadiness, buildApplyReadinessNote, buildApplyReadinessBrainNote, APPLY_SIGNALS, HOT_SCORE, WARM_SCORE, APPLY_WINDOW_DAYS, type ApplyMsg } from "../apply-readiness";
import { stripMetaNarration, isWorkNoteLine } from "../meta-narration";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入っている`); },
    atLeast(n: number) { if (Number(actual) < n) throw new Error(`${actual} < ${n}`); },
    atMost(n: number) { if (Number(actual) > n) throw new Error(`${actual} > ${n}`); },
  };
}

const NOW = Date.parse("2026-09-20T12:00:00+09:00");
const d = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const staff = (text: string, daysAgo = 1): ApplyMsg => ({ sender: "staff", text, createdAt: d(daysAgo) });
const cust = (text: string, daysAgo = 1): ApplyMsg => ({ sender: "customer", text, createdAt: d(daysAgo) });
/** 窓の発言数だけ埋めるための当たり障りのないやり取り（合図に当たらない語だけ） */
const filler = (n: number): ApplyMsg[] =>
  Array.from({ length: n }, (_, i) => (i % 2 ? staff("かしこまりました", 2) : cust("はい", 2)));

console.log("\n── 基本の振る舞い ──");

it("合図が1つも無ければ low・根拠は空", () => {
  const r = detectApplyReadiness([...filler(6)], NOW);
  expect(r.level).toBe("low");
  expect(r.score).toBe(0);
  expect(r.reason).toBe("");
});

it("窓（7日）より前の発言は数えない", () => {
  const inWin = detectApplyReadiness([...filler(6), staff("御見積書をお送りします", 3)], NOW);
  const outWin = detectApplyReadiness([...filler(6), staff("御見積書をお送りします", APPLY_WINDOW_DAYS + 1)], NOW);
  expect(inWin.hits.some((h) => h.key === "estimate_sent")).toBe(true);
  expect(outWin.hits.some((h) => h.key === "estimate_sent")).toBe(false);
});

it("未来の発言は数えない（時刻がずれた材料で hot にしない）", () => {
  const r = detectApplyReadiness([...filler(6), staff("御見積書をお送りします", -2)], NOW);
  expect(r.hits.length).toBe(0);
});

it("createdAt が無い発言は窓に入れない（順不同・欠損に強い）", () => {
  const r = detectApplyReadiness([{ sender: "staff", text: "御見積書", createdAt: null }, ...filler(6)], NOW);
  expect(r.hits.length).toBe(0);
});

it("窓の発言が4通未満なら hot にしない（材料不足で騒がない）", () => {
  // 3通に合図を詰め込んで満点近くにしても、材料が少なければ level は上げない
  const rich = [
    staff("最大限割引しました初期費用の御見積書となります 待ち合わせは現地エントランスにて", 1),
    cust("内覧してみたいです この物件 審査はどうですか 入居日はいつから", 1),
    cust("いいですね", 1),
  ];
  const r = detectApplyReadiness(rich, NOW);
  expect(r.windowCount).toBe(3);
  expect(r.score).atLeast(HOT_SCORE);    // ← 点数自体は出ている
  expect(r.level).toBe("low");           // ← level だけ抑えている
});

console.log("\n── 誰の発言かを取り違えない（一番壊れやすい所）──");

it("スタッフが「ご内覧いかがですか」と言っただけでは『お客様が内覧を希望した』は立たない", () => {
  const r = detectApplyReadiness([...filler(6), staff("ご内覧のご都合いかがでしょうか", 1)], NOW);
  expect(r.hits.some((h) => h.key === "cust_viewing_req")).toBe(false);
});

it("お客様が「御見積書ありがとうございます」と言っただけでは『見積書を送った』は立たない", () => {
  const r = detectApplyReadiness([...filler(6), cust("御見積書ありがとうございます", 1)], NOW);
  expect(r.hits.some((h) => h.key === "estimate_sent")).toBe(false);
});

it("お客様の合図はスタッフの発言では立たない（8種類すべて向きが守られている）", () => {
  const probe: Record<string, string> = {
    estimate_sent: "御見積書", cust_viewing_req: "内覧してみたいです", discount_told: "最大限割引",
    cust_proc_q: "審査はどうなりますか", cust_positive: "いいですね", viewed: "待ち合わせ",
    cust_named: "この物件", cust_move_q: "入居日はいつから",
  };
  for (const s of APPLY_SIGNALS) {
    const wrongWay = s.who === "customer" ? staff : cust;   // わざと逆の話者で言わせる
    const r = detectApplyReadiness([...filler(6), wrongWay(probe[s.key], 1)], NOW);
    if (r.hits.some((h) => h.key === s.key)) throw new Error(`${s.key} が逆の話者で立った`);
  }
});

console.log("\n── 本番の実物（線を引いた時に読んだ会話）──");

// 前田さん（proposing・50点で失注）: 申込の話まで来て「中を見ていない」で止まった
const MAEDA: ApplyMsg[] = [
  cust("昨日はお見積もりの送付ありがとうございました！", 3),
  cust("こちらの物件、自分も彼女も大変興味あるのですが家賃が予算オーバーしているということもあり悩んでおりまして", 3),
  cust("ちなみに、303で2番手ということでしょうか！？", 2),
  cust("なるほど、、！ もう少し下がるならもう申し込みさせてもらおうかと思います！", 2),
  cust("ありがとうございます、、！ こちらで審査お願いしてもよろしいでしょうか！", 1),
  cust("私は大変気に入っていたので申し込もうと思っており、彼女からも了承得ていたのですが、いざとなると中を見ていないというところで話が進まずでした", 1),
  cust("一旦、他のところでまた探してお伺いするので、次は内覧も予約させていただければと思います。", 1),
];

it("前田さん: 申込直前の合図がそろって hot（この人に気づけていれば内覧を挟めた）", () => {
  const r = detectApplyReadiness(MAEDA, NOW);
  expect(r.level).toBe("hot");
  expect(r.reason).toContain("手続き");
  expect(r.reason).toContain("前向き");
});

// Runa さん（availability_check・52点で失注）: 見積書まで出して他社に流れた
const RUNA: ApplyMsg[] = [
  ...filler(2),
  staff("スプランディッド大阪EAST 603号室 初期費用さらに98,000円割引させて頂き", 2),
  staff("最大限割引しました初期費用の御見積書となります！！", 2),
  cust("ありがとうございます 検討させて頂きます！！！", 2),
  cust("こちらの物件を契約したく、606号室の申し込みを進めているのですが、見積もりを出していただいたところ", 1),
  cust("このような場合、審査は通りますでしょうか", 1),
];

it("Runa さん: 見積書＋割引＋審査の質問で hot（実際に申込直前だった）", () => {
  const r = detectApplyReadiness(RUNA, NOW);
  expect(r.level).toBe("hot");
  expect(r.hits.some((h) => h.key === "estimate_sent")).toBe(true);
  expect(r.hits.some((h) => h.key === "discount_told")).toBe(true);
});

// 友哉さん（applying・18点）: もう鍵渡しの段階
const TOMOYA: ApplyMsg[] = [
  cust("お願いいたします", 2),
  staff("管理会社より鍵受け取り完了しましたのでご連絡させていただきました", 1),
  cust("ありがとうございます！ 18:30~19:00になっちゃいそうです", 1),
  staff("かしこまりました！！ お気をつけてお越しください", 1),
  cust("19:00ギリギリつきます", 1),
];

it("友哉さん: 申込の後（鍵渡し）は hot にしない＝もう要らない人に出さない", () => {
  const r = detectApplyReadiness(TOMOYA, NOW);
  expect(r.level).toBe("low");
  expect(buildApplyReadinessNote(r)).toBe("");
});

// 💜 さん（applying・22点）: お客様から先に「審査出して欲しい」が来た
const YORITSUNE: ApplyMsg[] = [
  ...filler(2),
  staff("家賃8.9万円以内・1DK以上・バストイレ別のご条件でオススメできるお部屋ピックアップさせて頂きました", 2),
  cust("ファーイースト青谷審査出して欲しいです！", 1),
  staff("かしこまりました！！ お申込させて頂きます！！", 1),
];

it("💜さん: お客様が自分から申込を言ってきた場合は hot にならない（催促する相手ではない）", () => {
  const r = detectApplyReadiness(YORITSUNE, NOW);
  expect(r.level).toBe("low");
  expect(r.score).atMost(HOT_SCORE - 1);
});

console.log("\n── 覚え書きが「おかしな文」にならないか ──");

const HOT = detectApplyReadiness(MAEDA, NOW);

it("hot 以外では覚え書きを作らない（warm でも low でも空）", () => {
  expect(buildApplyReadinessNote({ ...HOT, level: "warm" })).toBe("");
  expect(buildApplyReadinessNote({ ...HOT, level: "low" })).toBe("");
});

it("★ 覚え書きが下書きに混ざっても stripMetaNarration が丸ごと落とす", () => {
  const note = buildApplyReadinessNote(HOT);
  expect(note.length).atLeast(1);
  expect(stripMetaNarration(note).text.trim()).toBe("");   // ← 1行も残らない
});

it("★ 覚え書きの全ての行が単独でも作業メモとして落ちる", () => {
  for (const line of buildApplyReadinessNote(HOT).split("\n")) {
    if (!isWorkNoteLine(line)) throw new Error(`落ちない行がある: ${line}`);
  }
});

it("★ 覚え書きが本物の返信の先頭に付いても、お客様への文は消えない", () => {
  const real = "前田さんお世話になっております！！\nご内覧のお日にち調整させて頂きますので、ご都合よろしいお日にちお聞かせください😊！！";
  const { text } = stripMetaNarration(`${buildApplyReadinessNote(HOT)}\n${real}`);
  expect(text).toContain("お世話になっております");
  expect(text).toContain("ご都合よろしいお日にち");
  expect(text).notToContain("申込が近い合図");
});

it("覚え書きは「申込を迫る」指示になっていない（前田さんの失注の型を繰り返さない）", () => {
  const note = buildApplyReadinessNote(HOT);
  expect(note).toContain("申込の話はお客様から出るまで待つ");
  expect(note).toContain("本文にこの文言をそのまま書かない");
});

// ── ブレインには「事実」だけ渡す（2026-09-20 実データで一度取り消した所）─────────────
// 前田さんの1件を根拠に「抜けている内覧を埋める AIX を先に選ぶ」と書いたが、対照群つきで測ると
// 申込到達の29%は内覧なしで申込しており（差 +5pt）、規則にする根拠が無かった。
// 今は「内覧の合図はまだ無い」という事実と割合だけを渡し、AIX の選択はブレインに任せる。
const hotWith = (extra: ApplyMsg[]) => detectApplyReadiness([
  ...filler(4),
  staff("最大限割引しました初期費用の御見積書となります", 2),
  cust("この物件 いいですね", 2),
  cust("審査はどうですか 入居日はいつから", 1),
  ...extra,
], NOW);

it("★ 内覧が抜けている時は「まだ内覧していない」と名指しする", () => {
  const r = hotWith([]);
  expect(r.level).toBe("hot");
  expect(r.hits.some((h) => h.key === "viewed" || h.key === "cust_viewing_req")).toBe(false);
  const note = buildApplyReadinessBrainNote(r);
  expect(note).toContain("内覧の合図はまだ無い");
  // ★ AIX を選ばせない（1件の実例から規則を作らない）
  expect(note).toContain("内覧が必須という意味ではない");
  expect(note).notToContain("先に選ぶ");
  // ★ 本文用には手順の話を入れない（本文では内覧を打診できない＝おかしな文の元）
  expect(buildApplyReadinessNote(r)).notToContain("内覧");
});

it("内覧が済んでいる時は内覧の話を出さない", () => {
  const note = buildApplyReadinessBrainNote(hotWith([staff("待ち合わせは現地エントランスにて", 1)]));
  expect(note).notToContain("内覧の合図はまだ無い");
});

it("見積書が抜けている時はその事実を渡す", () => {
  const r = detectApplyReadiness([
    ...filler(4),
    cust("内覧してみたいです この物件", 2),
    cust("審査はどうですか 入居日はいつから", 1),
    staff("待ち合わせは現地エントランスにて", 1),
  ], NOW);
  expect(r.level).toBe("hot");
  expect(buildApplyReadinessBrainNote(r)).toContain("御見積書はまだ送っていない");
});

it("★ ブレイン用も hot 以外では出さない・申込を迫る材料ではないと明示する", () => {
  expect(buildApplyReadinessBrainNote({ ...HOT, level: "warm" })).toBe("");
  expect(buildApplyReadinessBrainNote(HOT)).toContain("申込を迫る材料ではない");
  expect(buildApplyReadinessBrainNote(HOT)).toContain("お客様が申込を口にするまで待つ");
});

// 2026-09-20 本番で出したら「まりあは 見積書を送った…」と**敬称なしの名前**が入った。
//   プロンプトは元々1人のお客様の話なので名前は要らない。名前を入れる＝本文へ流れ込む経路を1つ増やすだけ。
it("★ 覚え書きにお客様の名前を入れない（名前が本文に流れ込む経路を作らない）", () => {
  const note = buildApplyReadinessNote(HOT);
  expect(note).toContain("このお客様は");
  expect(note).notToContain("さんは");
  expect(note).notToContain("undefined");
  expect(note).notToContain("null");
  for (const n of ["まりあ", "前田", "Runa", "YUYA"]) expect(note).notToContain(n);
});

it("全ての行が「- 」で始まる（体裁が崩れない）", () => {
  const lines = buildApplyReadinessNote(HOT).split("\n");
  expect(lines.length).atLeast(3);
  for (const l of lines) if (!l.startsWith("- ")) throw new Error(`行頭が崩れた: ${l}`);
});

console.log("\n── 点数と段階のつじつま ──");

it("段階が積み上がる（合図を足すほど low → warm → hot に上がる）", () => {
  expect(WARM_SCORE < HOT_SCORE).toBe(true);
  // 見積書だけ（49/274 ＝ 18点）
  const a = detectApplyReadiness([...filler(6), staff("御見積書", 1)], NOW);
  expect(a.level).toBe("low");
  // ＋内覧希望（97/274 ＝ 35点）
  const b = detectApplyReadiness([...filler(6), staff("御見積書", 1), cust("内覧してみたいです", 1)], NOW);
  expect(b.level).toBe("warm");
  // ＋割引・審査（163/274 ＝ 59点）＝ Runa さん・前田さんと同じ並び
  const c = detectApplyReadiness([...filler(6), staff("御見積書", 1), staff("最大限割引", 1), cust("内覧してみたいです", 1), cust("審査はどうですか", 1)], NOW);
  expect(c.level).toBe("hot");
  if (!(a.score < b.score && b.score < c.score)) throw new Error(`点数が単調に上がっていない: ${a.score} / ${b.score} / ${c.score}`);
});

it("合図が全部立っても100点を超えない", () => {
  const all: ApplyMsg[] = [
    staff("御見積書", 1), staff("最大限割引", 1), staff("待ち合わせ", 1),
    cust("内覧してみたいです", 1), cust("審査はどうですか", 1), cust("いいですね", 1),
    cust("この物件", 1), cust("入居日はいつから", 1),
  ];
  const r = detectApplyReadiness(all, NOW);
  expect(r.score).toBe(100);
  expect(r.hits.length).toBe(APPLY_SIGNALS.length);
});

it("同じ合図が何度出ても1回分しか足さない（連投で点数が跳ねない）", () => {
  const once = detectApplyReadiness([...filler(6), staff("御見積書", 1)], NOW);
  const many = detectApplyReadiness([...filler(6), staff("御見積書", 1), staff("御見積書", 1), staff("お見積書", 2)], NOW);
  expect(many.score).toBe(once.score);
});

it("空配列・空文字・null テキストで落ちない", () => {
  expect(detectApplyReadiness([], NOW).level).toBe("low");
  expect(detectApplyReadiness([{ sender: "staff", text: null, createdAt: d(1) }], NOW).windowCount).toBe(0);
  expect(detectApplyReadiness([{ sender: "staff", text: "   ", createdAt: d(1) }], NOW).windowCount).toBe(0);
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
