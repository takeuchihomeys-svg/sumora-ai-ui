// app/lib/__tests__/must-include-loosen.test.ts
// 実行: npx tsx app/lib/__tests__/must-include-loosen.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「（次の一手の必須を緩めるのを）おこなう／テストしながら行う」
//
// 背景（scripts/audit-cell-vs-sent.ts・scripts/audit-deleted-lines.ts）:
//   ・セルの必須要素を「スタッフが実際に送った文」に当てると、検討中・了承・懸念の場面が低かった
//   ・スタッフが下書きから削っているのも「次の一手」の宣言だった（内覧提案44回・見積33回・探索23回）
//   ・原因は**必須が厳しすぎる**のではなく **detect が狭くてスタッフの実文を取りこぼしていた**
//     （「ごゆっくり」1語だけ／「いつでも」はあるのに「何時でも」が無い 等）
//
// 直しは「必須を外す」ではなく「**同じ意味の実文を認める**」。
//   外すと direction・final-check の suggestion・regen の材料が同時に消えて修正ループが枯れる
//   （設計知見「3経路から同時に内覧提案が消えるため、修正ループは材料不足で枯れた」）。
import {
  GENTLE_WAIT_RE, DOOR_OPEN_ANY_RE, OPEN_DOOR_RE, PAIR_MATRIX,
} from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); } };
}
const mustOf = (id: string, label: RegExp) => {
  const r = PAIR_MATRIX.find((x) => x.id === id);
  if (!r) throw new Error(`セル ${id} が無い`);
  const m = r.mustInclude.find((x) => label.test(x.label));
  if (!m) throw new Error(`${id} に ${label} の必須要素が無い`);
  return m;
};

console.log("\n── ★ 急かさない受け止め（本物の実送信を認める）──");

it("★ 今までの形（ごゆっくり）は今までどおり満たす", () => {
  for (const s of ["ごゆっくりご検討頂けますと幸いです😊！！", "ごゆっくりご確認頂けますと幸いです！！", "ごゆっくりご相談頂けますと幸いです😊！！"]) {
    expect(GENTLE_WAIT_RE.test(s)).toBe(true);
  }
});

it("★ スタッフの実送信（同じ意味の別の言い方）も満たす", () => {
  // 本物: VI_THINKING / ES_THINKING の場面でスタッフが実際に送った文
  for (const s of [
    "はい！！\nお手隙の際にご確認よろしくお願い致します😊！！",
    "はい！！\nSさんお手隙の際にご確認いただけますと幸いです😊！！",
    "はい😊！！\nぜひゆっくりご覧いただけますと幸いです😌！！",
    "かしこまりました！！お手隙の際にご査収よろしくお願いいたします😊！！",
  ]) {
    if (!GENTLE_WAIT_RE.test(s)) throw new Error(`実送信が満たさない: ${s.replace(/\n/g, " ")}`);
  }
});

it("★ 急かす文・無関係な文は満たさない（広げすぎない）", () => {
  for (const s of [
    "人気のお部屋のため早めのお申込みをオススメいたします！！",
    "🌟B-PROUD天満橋 1202\n新着でかなり条件のいいお部屋となります！！",
    "明日16時お部屋ご案内させて頂きます！！",
  ]) {
    if (GENTLE_WAIT_RE.test(s)) throw new Error(`満たしてはいけない: ${s.replace(/\n/g, " ")}`);
  }
});

it("★ 3セル（VI/ES/PS_THINKING）が同じ定数を見ている（四者同名）", () => {
  for (const id of ["VI_THINKING", "ES_THINKING", "PS_THINKING"]) {
    const m = mustOf(id, /急かさない受け止め/);
    expect(m.detect.source).toBe(GENTLE_WAIT_RE.source);
  }
});

console.log("\n── ★ 扉を開ける1文（「何時でも」の表記揺れ）──");

it("★ 本物の実送信「何時でも」（漢字）が満たす — 旧 detect が取りこぼしていた形", () => {
  const real = "はい！！\nごゆっくりご検討頂けますと幸いです😊！！\nもえかさん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！";
  expect(DOOR_OPEN_ANY_RE.test(real)).toBe(true);
});

it("★ 「いつでも」「お気軽に」「お待ちしております」も満たす", () => {
  for (const s of [
    "ご内覧出来ますので、気になる点出てきましたらいつでもお気軽にご連絡ください😌！！",
    "お気に召されましたお部屋のご案内もさせていただきますのでお気軽にお知らせください！！",
    "かしこまりました😊！！\nご連絡お待ちしております！！",
    "また〇〇さんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きます！！",
  ]) {
    if (!DOOR_OPEN_ANY_RE.test(s)) throw new Error(`実送信が満たさない: ${s.replace(/\n/g, " ")}`);
  }
});

it("★ 締めの種別を決める OPEN_DOOR_RE とは別物（あちらは完成形だけを見る厳しい判定）", () => {
  const loose = "気になる点出てきましたら何時でもお気軽にご連絡ください😌！！";
  expect(DOOR_OPEN_ANY_RE.test(loose)).toBe(true);
  // 締めの判定は「いつでもお気軽に〜ください」の完成形のみ＝この文では立たない。両者を混ぜない
  expect(OPEN_DOOR_RE.test(loose)).toBe(false);
});

console.log("\n── ★ 回答を前提にした次工程（QC_ANSWER）──");

it("★ 本物の実送信（電話を待つ・連絡する・フォームを送る）が満たす", () => {
  const m = mustOf("QC_ANSWER", /次工程/);
  for (const s of [
    "かしこまりました！！\n10時半頃のお電話お待ちしております😊！！",
    "かしこまりました！！\nマンション下に到着時間分かりましたらご連絡させていただきます😌！！",
    "かしこまりました！！\nただいまからお申込みフォームお送りさせていただきます！！",
  ]) {
    if (!m.detect.test(s)) throw new Error(`実送信が満たさない: ${s.replace(/\n/g, " ")}`);
  }
});

it("★ 今までの形（見積作成・ピックアップ）も満たす", () => {
  const m = mustOf("QC_ANSWER", /次工程/);
  for (const s of [
    "初期費用も最大限割引させていただいたお見積書作成しお送りさせていただきます😊！！",
    "お伺いしたご条件でオススメできるお部屋ピックアップしてお送りさせて頂きます😊！！",
  ]) {
    if (!m.detect.test(s)) throw new Error(`今までの形が満たさない: ${s}`);
  }
});

it("★ 次工程を書いていない文は満たさない（広げすぎない）", () => {
  const m = mustOf("QC_ANSWER", /次工程/);
  for (const s of ["かしこまりました！！", "ありがとうございます😊！！", "はい！！"]) {
    if (m.detect.test(s)) throw new Error(`満たしてはいけない: ${s}`);
  }
});

console.log("\n── ★ 懸念への探索宣言（PS_CONCERN）──");

it("★ 本物の実送信「オススメ出来るお部屋で次第お送りさせていただきます」が満たす", () => {
  const m = mustOf("PS_CONCERN", /ピックアップ宣言/);
  for (const s of [
    "引き続きオススメ出来るお部屋で次第お送りさせていただきます😌！！",
    "引き続き新着でオススメできるお部屋で次第お送りさせていただきます😌！！",
    "私の方でも新着でオススメできるお部屋募集で次第お送りさせていただきます😌！！",
  ]) {
    if (!m.detect.test(s)) throw new Error(`実送信が満たさない: ${s}`);
  }
});

it("★ 今までの形（ピックアップ・お調べ）も満たす", () => {
  const m = mustOf("PS_CONCERN", /ピックアップ宣言/);
  for (const s of [
    "お風呂広めのお部屋を中心にオススメできるお部屋お調べさせて頂きます！！",
    "1階のお部屋も含めて改めてピックアップさせて頂きます！！",
  ]) {
    if (!m.detect.test(s)) throw new Error(`今までの形が満たさない: ${s}`);
  }
});

console.log("\n── 必須を外していない（材料を消さない）──");

it("★ 緩めたセルの必須要素の数は変わっていない", () => {
  const counts: Record<string, number> = { VI_THINKING: 2, ES_THINKING: 2, PS_THINKING: 2, QC_ANSWER: 2, PS_CONCERN: 2 };
  for (const [id, n] of Object.entries(counts)) {
    const r = PAIR_MATRIX.find((x) => x.id === id)!;
    expect(r.mustInclude.length).toBe(n);
  }
});

it("★ fix（修正案のリテラル）はそのまま残っている（修正ループの材料）", () => {
  for (const id of ["VI_THINKING", "ES_THINKING", "PS_THINKING", "QC_ANSWER", "PS_CONCERN"]) {
    const r = PAIR_MATRIX.find((x) => x.id === id)!;
    for (const m of r.mustInclude) {
      if (!m.fix || m.fix.length < 10) throw new Error(`${id} の fix が空`);
    }
  }
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
