// 2026-09-17 竹内（AIX キャッシュ点検）: AIX の system を「共通 prefix（1h）→ 準静的（1h）→ 経路固有（5m）→ 動的（なし）」に分ける純関数の回帰テスト
// 実行: npx tsx app/lib/__tests__/aix-system-blocks.test.ts（自己完結ハーネス。全 PASS で exit 0）
import * as fs from "fs";
import * as path from "path";
import {
  AIX_SHARED_SYSTEM_PREFIX, AIX_CACHE_MIN_CHARS, LLM_META_HEADER_ACTION, LLM_META_HEADER_CONVERSATION,
  splitSharedPrefix, buildSystemBlocks, joinSystemBlocks, systemStaticLength, normalizeSystemSpec, llmMetaHeaderValue,
} from "../aix-system-blocks";
import { GENERATION_SYSTEM, SMORA_COMMON_RULES } from "../line-reply-prompts";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}

const ROUTE_TEXT = "【重要】この経路の固有文。".repeat(200); // ≈2,600字（閾値 1,500字を超える）
const SHORT_ROUTE = "【短い固有文】JSON だけ返す。"; // 閾値未満
const FULL = `${AIX_SHARED_SYSTEM_PREFIX}\n\n${ROUTE_TEXT}`;

// ── 分割 ──
it("prefix 定数は GENERATION_SYSTEM + \\n\\n + SMORA_COMMON_RULES（末尾に \\n\\n を含まない）", () => {
  expect(AIX_SHARED_SYSTEM_PREFIX).toBe(`${GENERATION_SYSTEM}\n\n${SMORA_COMMON_RULES}`);
  expect(AIX_SHARED_SYSTEM_PREFIX.endsWith("\n\n")).toBe(false);
  expect(AIX_SHARED_SYSTEM_PREFIX.length >= AIX_CACHE_MIN_CHARS).toBe(true);
});

it("先頭一致で shared と routeStatic に分ける", () => {
  const s = splitSharedPrefix(FULL);
  expect(s.shared).toBe(AIX_SHARED_SYSTEM_PREFIX);
  expect(s.routeStatic).toBe(ROUTE_TEXT);
});

it("一致しなければ shared なし（全文が routeStatic）", () => {
  const s = splitSharedPrefix(`前置き\n\n${AIX_SHARED_SYSTEM_PREFIX}\n\n${ROUTE_TEXT}`);
  expect(s.shared).toBe("");
  expect(s.routeStatic).toBe(`前置き\n\n${AIX_SHARED_SYSTEM_PREFIX}\n\n${ROUTE_TEXT}`);
  expect(splitSharedPrefix(SHORT_ROUTE)).toEqual({ shared: "", routeStatic: SHORT_ROUTE });
});

it("prefix と完全一致なら shared だけ・prefix+\\n\\n で終わる（残りなし）は分けない", () => {
  expect(splitSharedPrefix(AIX_SHARED_SYSTEM_PREFIX)).toEqual({ shared: AIX_SHARED_SYSTEM_PREFIX, routeStatic: "" });
  const trailing = `${AIX_SHARED_SYSTEM_PREFIX}\n\n`;
  expect(splitSharedPrefix(trailing)).toEqual({ shared: "", routeStatic: trailing });
});

it("結合すると元に戻る（分割で LLM に届く文字列は変わらない）", () => {
  for (const sys of [FULL, SHORT_ROUTE, AIX_SHARED_SYSTEM_PREFIX, `${AIX_SHARED_SYSTEM_PREFIX}\n\n`, `${AIX_SHARED_SYSTEM_PREFIX}\n\n\n\nX`]) {
    const s = splitSharedPrefix(sys);
    expect([s.shared, s.routeStatic].filter(Boolean).join("\n\n")).toBe(sys);
    expect(joinSystemBlocks(buildSystemBlocks(sys))).toBe(sys);
  }
});

// ── ブロック並び・ttl ──
it("文字列呼び出し: [shared 1h][routeStatic 5m][dynamic なし] の並び。従来の system+\\n\\n+suffix と同じ文字列", () => {
  const blocks = buildSystemBlocks(FULL, { dynamicSuffix: "【顧客名】山田さん" });
  expect(blocks.length).toBe(3);
  expect(blocks[0].text).toBe(AIX_SHARED_SYSTEM_PREFIX);
  expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(blocks[1].text).toBe(ROUTE_TEXT);
  expect(blocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  expect(blocks[2].text).toBe("【顧客名】山田さん");
  expect(blocks[2].cache_control).toBe(undefined);
  expect(joinSystemBlocks(blocks)).toBe(`${FULL}\n\n【顧客名】山田さん`);
  expect(blocks.every((b) => b.type === "text")).toBe(true);
});

it("空のブロックは入れない（suffix なし・routeStatic なし）", () => {
  expect(buildSystemBlocks(FULL).length).toBe(2);
  expect(buildSystemBlocks(AIX_SHARED_SYSTEM_PREFIX).length).toBe(1);
  expect(buildSystemBlocks(FULL, { dynamicSuffix: "" }).length).toBe(2);
});

it("routeStatic が 1,500字未満なら cache_control を付けない（Sonnet の最小キャッシュ長未満は書き込まれず集計を誤読するだけ）", () => {
  const blocks = buildSystemBlocks(SHORT_ROUTE);
  expect(blocks.length).toBe(1);
  expect(blocks[0].cache_control).toBe(undefined);
  const mixed = buildSystemBlocks(`${AIX_SHARED_SYSTEM_PREFIX}\n\n${SHORT_ROUTE}`);
  expect(mixed[0].cache_control?.ttl).toBe("1h");
  expect(mixed[1].cache_control).toBe(undefined);
  const edge = "あ".repeat(AIX_CACHE_MIN_CHARS);
  expect(buildSystemBlocks(edge)[0].cache_control?.ttl).toBe("5m");
  expect(buildSystemBlocks(edge.slice(1))[0].cache_control).toBe(undefined);
});

it("ttl 既定: routeStatic=5m。defaultTtl none なら routeStatic に cache なし（Haiku の既定）。shared は常に 1h", () => {
  const none = buildSystemBlocks(FULL, { defaultTtl: "none" });
  expect(none[0].cache_control?.ttl).toBe("1h");
  expect(none[1].cache_control).toBe(undefined);
  const oneH = buildSystemBlocks(FULL, { defaultTtl: "1h" });
  expect(oneH[1].cache_control?.ttl).toBe("1h");
  expect(normalizeSystemSpec(FULL).ttl).toBe("5m");
  expect(normalizeSystemSpec(FULL, { defaultTtl: "none" }).ttl).toBe("none");
  // spec.ttl は defaultTtl より優先
  expect(normalizeSystemSpec({ routeStatic: ROUTE_TEXT, ttl: "none" }, { defaultTtl: "5m" }).ttl).toBe("none");
});

it("オブジェクト指定: [shared 1h][semiStatic 1h][routeStatic 5m][dynamic なし]・1h は 5m より前・区切りは最大3", () => {
  const semi = "・global ルール".repeat(300);
  const blocks = buildSystemBlocks({ shared: AIX_SHARED_SYSTEM_PREFIX, semiStatic: semi, routeStatic: ROUTE_TEXT, dynamic: "【本日】9/17" });
  expect(blocks.map((b) => b.cache_control?.ttl ?? "none")).toEqual(["1h", "1h", "5m", "none"]);
  expect(blocks.filter((b) => b.cache_control).length <= 3).toBe(true);
  expect(joinSystemBlocks(blocks)).toBe(`${AIX_SHARED_SYSTEM_PREFIX}\n\n${semi}\n\n${ROUTE_TEXT}\n\n【本日】9/17`);
  // spec.dynamic と第4引数の suffix が両方あれば "\n\n" で繋ぐ
  const both = buildSystemBlocks({ routeStatic: ROUTE_TEXT, dynamic: "A" }, { dynamicSuffix: "B" });
  expect(both[both.length - 1].text).toBe("A\n\nB");
  // shared を省いた時は自動分割しない（オブジェクトは呼び出し側の指定どおり）
  const noShared = buildSystemBlocks({ routeStatic: FULL });
  expect(noShared.length).toBe(1);
});

it("systemStaticLength は dynamic を除いた静的部分の長さ（従来の system.length 相当）", () => {
  expect(systemStaticLength(FULL)).toBe(FULL.length);
  expect(systemStaticLength({ shared: AIX_SHARED_SYSTEM_PREFIX, routeStatic: ROUTE_TEXT, dynamic: "X".repeat(999) })).toBe(FULL.length);
});

// ── 計測用ヘッダ ──
it("ヘッダ名と値の整形（非 ASCII は encodeURIComponent・ASCII はそのまま）", () => {
  expect(LLM_META_HEADER_ACTION).toBe("x-sumora-llm-action");
  expect(LLM_META_HEADER_CONVERSATION).toBe("x-sumora-llm-conversation");
  expect(llmMetaHeaderValue("property_send")).toBe("property_send");
  expect(llmMetaHeaderValue("dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7")).toBe("dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7");
  expect(decodeURIComponent(llmMetaHeaderValue("会話を合わせる:apply"))).toBe("会話を合わせる:apply");
  expect(/^[\x20-\x7e]*$/.test(llmMetaHeaderValue("会話を合わせる"))).toBe(true);
});

// ── 本番の経路が prefix で始まることを固定 ──
it("aix/action の「会話を合わせる」系 11 経路の system は `${GENERATION_SYSTEM}\\n\\n${SMORA_COMMON_RULES}\\n\\n` で始まる（自動分割の前提）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "api", "aix", "action", "route.ts"), "utf8");
  const names = ["adaptStaticSystem", "psmStaticSystem", "convMatchVISystem", "convMatchSystem", "pcrStaticSystem", "hearingCMSystem", "mpSystem", "followupCMSystem", "cbStaticSystem", "pfStaticSystem", "giStaticSystem"];
  for (const n of names) {
    const re = new RegExp(`const ${n} = \\\`\\$\\{GENERATION_SYSTEM\\}\\n\\n\\$\\{SMORA_COMMON_RULES\\}\\n\\n`);
    if (!re.test(src)) throw new Error(`${n} が共通 prefix で始まっていない`);
  }
  // callClaude 系は SystemSpec を受け、計測用ヘッダを付ける
  expect(/async function callClaude\(system: SystemSpec/.test(src)).toBe(true);
  expect(/async function callClaudeHaiku\(system: SystemSpec/.test(src)).toBe(true);
  expect(/async function callClaudeVision\(system: SystemSpec/.test(src)).toBe(true);
  expect((src.match(/\.\.\.llmMetaHeaders\(action\)/g) ?? []).length).toBe(3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
