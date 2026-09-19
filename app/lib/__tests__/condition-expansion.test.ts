// app/lib/__tests__/condition-expansion.test.ts
// 実行: npx tsx app/lib/__tests__/condition-expansion.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { detectConditionExpansion, buildExpansionNote } from "../condition-expansion";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual).slice(0, 160)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual).slice(0, 160)}" に "${sub}" が入っている`); },
  };
}

// ── 追加・許容の判定（実データの文をそのまま） ───────────────────────────────
it("タマキ事例: 「その周辺でも大丈夫です」は追加（変更ではない）", () => {
  const v = detectConditionExpansion("よろしくお願いします\n職場が 1人は淀川区（柴島とか新大阪、三国、）と1人は天六あたりなので その周辺でも大丈夫です");
  expect(v.expanded).toBe(true);
  expect(v.vague).toBe(false);
});
it("実送信にあった追加の言い方を全部拾う", () => {
  expect(detectConditionExpansion("服部天神、曽根などの豊中市。武庫之荘などでも大丈夫です。").expanded).toBe(true);
  expect(detectConditionExpansion("玉造付近も安いとこがあるみたいなのでそのエリアまで広げていただいても大丈夫です").expanded).toBe(true);
  expect(detectConditionExpansion("伏見駅と竹田駅周辺でも探していただきたいです").expanded).toBe(true);
  expect(detectConditionExpansion("環状線の駅ならどこでも大丈夫です").expanded).toBe(true);
});
it("行き先が曖昧な許容（どこでも）は vague＝エリア名を書かせない", () => {
  expect(detectConditionExpansion("何度もすみません\nダブルのベットが入る寝室があるお部屋はありますか？\n駅はどこら辺でも大丈夫です\n広めがいいです").vague).toBe(true);
  expect(detectConditionExpansion("桜川駅周辺がありがたいですが最悪どこでもいいっす場所は").vague).toBe(true);
});
it("時期だけの許容は追加ではない（エリアの話ではない）", () => {
  expect(detectConditionExpansion("入居はいつでも大丈夫です").expanded).toBe(false);
  expect(detectConditionExpansion("① 入居時期 いつでも大丈夫").expanded).toBe(false);
  // 時期の許容とエリアの許容が同じ文にある時は追加として拾う
  expect(detectConditionExpansion("入居はいつでも大丈夫です。エリアは西区でも大丈夫です").expanded).toBe(true);
});
it("条件の話でなければ追加にしない（誤爆を止める）", () => {
  expect(detectConditionExpansion("ありがとうございます、こちらでも大丈夫です").expanded).toBe(false); // 条件語なし
  expect(detectConditionExpansion("かしこまりました").expanded).toBe(false);
  expect(detectConditionExpansion("").expanded).toBe(false);
  expect(detectConditionExpansion(null).expanded).toBe(false);
});

// ── 材料の文（限定を禁止し、実送信の型だけを渡す） ──────────────────────────
it("材料: 限定を禁止し「も含めて」の型を渡す。曖昧ならエリア名を書かせない", () => {
  const n = buildExpansionNote(detectConditionExpansion("天六あたりなので その周辺でも大丈夫です"), "タマキさん");
  expect(n).toContain("も含めて");
  expect(n).toContain("限定する形は禁止");
  expect(n).toContain("今までの条件・エリアを打ち消さない");
  const vagueNote = buildExpansionNote(detectConditionExpansion("駅はどこら辺でも大丈夫です"), "うのさん");
  expect(vagueNote).toContain("エリア名は書かない");
  expect(buildExpansionNote(detectConditionExpansion("かしこまりました"), "x")).toBe("");
});

// ── 誤爆の回帰（2026-09-19 実データ9,026件の監査で拾ってしまっていた実物） ──────
it("書類・手続きの「〜でも大丈夫」は条件の追加にしない", () => {
  expect(detectConditionExpansion("新しく市に確定申告し、コピーを写真提出でも大丈夫でしょうか？").expanded).toBe(false);
  expect(detectConditionExpansion("以前契約の際にお世話になったのですが、2台目の駐車場の契約って可能ですか？").expanded).toBe(false);
  expect(detectConditionExpansion("必要書類を今まとめて全て教えて貰っても良いでしょうか。").expanded).toBe(false);
});
it("既にやり取りしている物件への言及は条件の追加にしない", () => {
  expect(detectConditionExpansion("アーバネックス京町堀の11階の部屋でもいいなと考えてます！").expanded).toBe(false);
  expect(detectConditionExpansion("送って頂いた物件でも大丈夫です").expanded).toBe(false);
});
it("許容の言い方と同じ文（か直前の文）にエリア・条件が要る", () => {
  expect(detectConditionExpansion("ありがとうございます、それでも大丈夫です").expanded).toBe(false);
  expect(detectConditionExpansion("中崎町でも大丈夫です！").expanded).toBe(true);
  // タマキ事例: 許容は次の文にあり、エリアは直前の文にある
  expect(detectConditionExpansion("職場が1人は淀川区、1人は天六あたりなので。その周辺でも大丈夫です").expanded).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
