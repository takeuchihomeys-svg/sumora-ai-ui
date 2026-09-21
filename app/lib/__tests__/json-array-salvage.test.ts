// 途中で切れた JSON 配列から完結した要素だけ拾う（竹内 2026-09-21「なにかエラー起きている部分あるのか調査」）。
//
// 本番で起きていた事: /api/cron/rule-organize の Opus 出力が 7回中6回 stop_reason=max_tokens で切れ、
//   受け側が閉じ括弧 `]` を要求していたためバッチ丸ごと捨てられていた。
//
// 実行: npx tsx app/lib/__tests__/json-array-salvage.test.ts（全 PASS で exit 0）
import { parseJsonArrayLoose } from "../json-array-salvage";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}

// 本番ログ（2026-09-20T21:00:46）の実物に合わせた形
const ONE = `{"rule_key":"FEEDBACK-ec42cea5-3f99-4de2-a51b-f70e725d99f3-1-gr","judge":"merge","reason":"初期費用・見積依頼時のestimate_sheet誘導として同趣旨","action_type_correction":"generate_reply","merge_with_key":"X-1","merged_text":null}`;
const TWO = `{"rule_key":"FEEDBACK-135a2428-1-gr","judge":"keep","reason":"内覧希望日時提示時のviewing_invite利用ルール","action_type_correction":null,"merge_with_key":null,"merged_text":null}`;

describe("正しく閉じている配列", () => {
  it("★ P1 普通に読める", () => {
    const r = parseJsonArrayLoose(`[${ONE},${TWO}]`);
    expect(r.items.length).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.noArray).toBe(false);
  });
  it("P2 前後に説明文や ```json が付いていても読める", () => {
    const r = parseJsonArrayLoose("以下が判定結果です。\n```json\n[" + ONE + "]\n```\n以上です。");
    expect(r.items.length).toBe(1);
    expect(r.truncated).toBe(false);
  });
  it("P3 空配列", () => {
    const r = parseJsonArrayLoose("[]");
    expect(r.items.length).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe("途中で切れた配列（本番で起きていた形）", () => {
  it("★ T1 3件目の途中で切れたら、完結している2件は拾う", () => {
    const r = parseJsonArrayLoose(`[${ONE},${TWO},{"rule_key":"FEEDBACK-abc-1","judge":"dea`);
    expect(r.items.length).toBe(2);
    expect(r.truncated).toBe(true);
  });
  it("★ T2 1件目の途中で切れたら0件（拾える物が無い）でも落ちない", () => {
    const r = parseJsonArrayLoose(`[{"rule_key":"FEEDBACK-abc-1","judge":"dea`);
    expect(r.items.length).toBe(0);
    expect(r.truncated).toBe(true);
  });
  it("★ T3 閉じ括弧が無いだけで中身が全部そろっていれば全部拾う", () => {
    const r = parseJsonArrayLoose(`[${ONE},${TWO}`);
    expect(r.items.length).toBe(2);
    expect(r.truncated).toBe(true);
  });
});

describe("文字列の中の記号にだまされない", () => {
  it("★ S1 reason の中に } や ] が入っていても正しく数える", () => {
    const tricky = `{"rule_key":"K1","judge":"keep","reason":"本文に } や ] や { が入る場合がある","action_type_correction":null,"merge_with_key":null,"merged_text":null}`;
    const r = parseJsonArrayLoose(`[${tricky},${TWO}]`);
    expect(r.items.length).toBe(2);
  });
  it("★ S2 エスケープされた引用符をまたげる", () => {
    const tricky = `{"rule_key":"K2","judge":"keep","reason":"「\\"ご査収ください\\"」の扱い","action_type_correction":null,"merge_with_key":null,"merged_text":null}`;
    const r = parseJsonArrayLoose(`[${tricky}]`);
    expect(r.items.length).toBe(1);
  });
  it("S3 壊れた要素が混ざっても、その要素だけ捨てて続きを読む", () => {
    const broken = `{"rule_key":"K3","judge":}`;   // 値が無い
    const r = parseJsonArrayLoose(`[${broken},${TWO}]`);
    expect(r.items.length).toBe(1);
  });
});

describe("配列が無い時", () => {
  it("N1 配列が無ければ noArray", () => {
    const r = parseJsonArrayLoose("判定できませんでした。");
    expect(r.noArray).toBe(true);
    expect(r.items.length).toBe(0);
  });
  it("N2 空文字でも落ちない", () => {
    expect(parseJsonArrayLoose("").noArray).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
