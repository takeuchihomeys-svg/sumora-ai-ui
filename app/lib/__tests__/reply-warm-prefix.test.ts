// 2026-09-17 竹内（返信生成の keep-warm）: 実際に送った prefix の取り出し（extractWarmPrefix）と読み直し対象の選び方（selectWarmTargets）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/reply-warm-prefix.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { extractWarmPrefix, selectWarmTargets, parseHoursJst, isWarmHourJst, recordWarmPrefix, sys0HashOf, KEEP_WARM_TAIL_TEXT, KEEP_WARM_DEFAULTS, type WarmPrefixRow } from "../reply-warm-prefix";
import { REPLY_GENERATION_MODEL } from "../reply-generation-model";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}

// 本番の buildGenerationMessages と同じ形（system 2ブロック・human 3ブロック・cache_control は system[0]・system[1]・human[0]・human[1] の4つ・全て 1h）
const cc = { type: "ephemeral" as const, ttl: "1h" as const };
function buildMessages(over: { sys0?: string; sys1?: string; h0?: string; h1?: string; dyn?: string } = {}) {
  const systemBlocks = [
    { type: "text" as const, text: over.sys0 ?? "【指示の優先順位】…\n\nあなたは不動産仲介「スモラ」のLINE返信を書くスタッフです。", cache_control: cc },
    { type: "text" as const, text: over.sys1 ?? "【DB ルール】hearing × 初回…", cache_control: cc },
  ];
  const humanBlocks = [
    { type: "text" as const, text: over.h0 ?? "【全顧客共通ルール】…", cache_control: cc },
    { type: "text" as const, text: over.h1 ?? "【PHASE_GUIDE hearing】…", cache_control: cc },
    { type: "text" as const, text: over.dyn ?? "【顧客固有】お客様: 初期費用はどれくらいですか？" },
  ];
  return [new SystemMessage({ content: systemBlocks }), new HumanMessage({ content: humanBlocks })];
}

const T = (iso: string) => Date.parse(iso);
// 2026-09-17 10:00 JST = 01:00 UTC
const NOW = T("2026-09-17T01:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (hash: string, o: Partial<WarmPrefixRow> = {}): WarmPrefixRow => ({ hash, use_count: 3, last_used_at: ago(60), last_warmed_at: null, ...o });

async function main() {
  await it("extractWarmPrefix: cache_control 付きのブロックだけ（system 2＋human 2）で、dynamicBlock（顧客固有）は含めない", () => {
    const p = extractWarmPrefix(buildMessages());
    expect(p !== null).toBe(true);
    expect(p!.model).toBe(REPLY_GENERATION_MODEL);
    expect(p!.systemBlocks.length).toBe(2);
    expect(p!.humanBlocks.length).toBe(2);
    expect(JSON.stringify(p).includes("初期費用")).toBe(false);
    expect(p!.humanBlocks[1].cache_control?.ttl).toBe("1h");
    expect(p!.chars).toBe(p!.systemBlocks.concat(p!.humanBlocks).reduce((n, b) => n + b.text.length, 0));
  });

  await it("同じ入力なら同じ hash・dynamicBlock（お客様の発言）が違っても同じ hash", () => {
    const a = extractWarmPrefix(buildMessages())!;
    const b = extractWarmPrefix(buildMessages({ dyn: "【顧客固有】お客様: 内覧できますか" }))!;
    expect(a.hash).toBe(b.hash);
    expect(a.hash.length).toBe(16);
  });

  await it("text が1文字違えば別 hash（system[0]・system[1]・human[0]・human[1] のどれでも）", () => {
    const base = extractWarmPrefix(buildMessages())!.hash;
    expect(extractWarmPrefix(buildMessages({ sys0: "【指示の優先順位】…\n\nあなたは不動産仲介「スモラ」のLINE返信を書くスタッフです！" }))!.hash === base).toBe(false);
    expect(extractWarmPrefix(buildMessages({ sys1: "【DB ルール】hearing × 2回目…" }))!.hash === base).toBe(false);
    expect(extractWarmPrefix(buildMessages({ h0: "【全顧客共通ルール】…（挨拶済み）" }))!.hash === base).toBe(false);
    expect(extractWarmPrefix(buildMessages({ h1: "【PHASE_GUIDE proposing】…" }))!.hash === base).toBe(false);
  });

  await it("cache_control（ttl）や model が違えば別 hash（キャッシュの鍵と同じ物だけ同じ値）", () => {
    const base = extractWarmPrefix(buildMessages())!.hash;
    const m = buildMessages();
    (m[0].content as Array<{ cache_control?: unknown }>)[0].cache_control = { type: "ephemeral", ttl: "5m" };
    expect(extractWarmPrefix(m)!.hash === base).toBe(false);
    expect(extractWarmPrefix(buildMessages(), "claude-opus-5")!.hash === base).toBe(false);
  });

  await it("cache_control が1つも無い・文字列 content・メッセージが足りない時は null（記録しない）", () => {
    const m = buildMessages();
    for (const msg of m) for (const b of msg.content as Array<{ cache_control?: unknown }>) delete b.cache_control;
    expect(extractWarmPrefix(m)).toBe(null);
    expect(extractWarmPrefix([new SystemMessage("x"), new HumanMessage("y")])).toBe(null);
    expect(extractWarmPrefix([new SystemMessage({ content: [{ type: "text", text: "x", cache_control: cc }] })])).toBe(null);
  });

  await it("recordWarmPrefix: 行が無ければ全部 insert・あれば last_used_at と use_count だけ update（本文を書き直さない）・失敗しても投げない", async () => {
    const p = extractWarmPrefix(buildMessages())!;
    const calls: string[] = [];
    let existing: { use_count: number } | null = null;
    let updated: Record<string, unknown> | null = null;
    let inserted: Record<string, unknown> | null = null;
    const db = {
      from: (table: string) => ({
        select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: async () => { calls.push(`select:${table}:${v}`); return { data: existing, error: null }; } }) }),
        update: (v: Record<string, unknown>) => ({ eq: async () => { calls.push("update"); updated = v; return { error: null }; } }),
        insert: async (v: Record<string, unknown>) => { calls.push("insert"); inserted = v; return { error: null }; },
      }),
    };
    expect(await recordWarmPrefix(p, db, "2026-09-17T01:00:00.000Z")).toBe("inserted");
    expect(calls).toEqual([`select:llm_warm_prefixes:${p.hash}`, "insert"]);
    expect(inserted!.use_count).toBe(1);
    expect(inserted!.warm_count).toBe(0);
    expect(inserted!.model).toBe(REPLY_GENERATION_MODEL);
    expect(Array.isArray(inserted!.system_blocks)).toBe(true);
    // sys0_hash は system[0] の text だけのハッシュ（human 側が違っても同じ・system[0] が違えば別）
    expect(inserted!.sys0_hash).toBe(p.sys0Hash);
    expect(p.sys0Hash).toBe(sys0HashOf(p.systemBlocks));
    expect(extractWarmPrefix(buildMessages({ h1: "【PHASE_GUIDE proposing】…", sys1: "【DB ルール】hearing × 2回目…" }))!.sys0Hash).toBe(p.sys0Hash);
    expect(extractWarmPrefix(buildMessages({ sys0: "【指示の優先順位】…（デプロイで変わった）" }))!.sys0Hash === p.sys0Hash).toBe(false);
    existing = { use_count: 4 };
    expect(await recordWarmPrefix(p, db, "2026-09-17T01:05:00.000Z")).toBe("updated");
    expect(updated).toEqual({ last_used_at: "2026-09-17T01:05:00.000Z", use_count: 5 });
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error("db down"); } }) }), update: () => ({ eq: async () => ({ error: null }) }), insert: async () => ({ error: null }) }) };
    expect(await recordWarmPrefix(p, broken)).toBe("failed");
  });

  await it("時間帯: 既定 7-24（JST 7:00〜23:59）・壊れた値は既定・KEEP_WARM_HOURS_JST の形で変えられる", () => {
    expect(parseHoursJst(undefined)).toEqual({ start: 7, end: 24 });
    expect(parseHoursJst("9-21")).toEqual({ start: 9, end: 21 });
    expect(parseHoursJst("abc")).toEqual({ start: 7, end: 24 });
    expect(parseHoursJst("20-8")).toEqual({ start: 7, end: 24 });
    expect(isWarmHourJst(T("2026-09-16T22:00:00Z"), "7-24")).toBe(true);   // JST 7:00
    expect(isWarmHourJst(T("2026-09-16T21:59:00Z"), "7-24")).toBe(false);  // JST 6:59
    expect(isWarmHourJst(T("2026-09-17T14:59:00Z"), "7-24")).toBe(true);   // JST 23:59
    expect(isWarmHourJst(T("2026-09-17T15:00:00Z"), "7-24")).toBe(false);  // JST 0:00
    expect(isWarmHourJst(T("2026-09-17T01:00:00Z"), "12-18")).toBe(false); // JST 10:00
  });

  await it("selectWarmTargets: 直近5時間に使われ・use_count≥2 の行を last_used_at 降順に上位3変種だけ残し、その中で 40〜55分の窓にある行だけ", () => {
    const rows: WarmPrefixRow[] = [
      row("a", { last_used_at: ago(45) }),                              // 上位3・窓の中 → 対象
      row("b", { last_used_at: ago(30) }),                              // 上位3・30分前に使われた → まだ温かい
      row("c", { last_used_at: ago(120), last_warmed_at: ago(20) }),    // 上位3の外（4番目）
      row("d", { last_used_at: ago(120), last_warmed_at: ago(50) }),    // 上位3の外
      row("e", { last_used_at: ago(6 * 60) }),                          // 6時間前 → 直近5時間の外
      row("f", { last_used_at: ago(60), use_count: 1 }),                // 1回だけ → 対象外（上位3の数にも入らない）
      row("g", { last_used_at: ago(90) }),                              // 上位3（3番目）だが 90分 → 冷えている（55分超）→ 読まない
      row("h", { last_used_at: ago(100) }),                             // 上位3の外
      row("j", { last_used_at: null }),                                 // 使われた記録なし
      row("k", { last_used_at: ago(60), chars: 700_000 }),              // 異常に大きい（上位3の数にも入らない）
    ];
    const r = selectWarmTargets(rows, NOW);
    expect(r.reason).toBe(null);
    expect(r.targets.map((t) => t.hash)).toEqual(["a"]);
    // 上位3の中で 50分前に読み直した行は対象（last_warmed_at で窓を判定）
    const r2 = selectWarmTargets([row("a", { last_used_at: ago(45) }), row("b", { last_used_at: ago(30) }), row("c", { last_used_at: ago(120), last_warmed_at: ago(50) })], NOW);
    expect(r2.targets.map((t) => t.hash)).toEqual(["a", "c"]);
    // maxTracked を広げれば従来どおり（最大 maxPerRun 件）
    const r3 = selectWarmTargets([row("a", { last_used_at: ago(45) }), row("b", { last_used_at: ago(50) }), row("c", { last_used_at: ago(120), last_warmed_at: ago(50) }), row("d", { last_used_at: ago(130), last_warmed_at: ago(52) }), row("e", { last_used_at: ago(140), last_warmed_at: ago(54) })], NOW, { maxTracked: 10 });
    expect(r3.targets.map((t) => t.hash)).toEqual(["a", "b", "c", "d"]);
  });

  await it("冷えた行（前回のタッチから 55分超）は読まない: 4時間前に使われ一度も温めていない行・cron が1スロット飛んで 60分超えた行は対象外", () => {
    const rows = [
      row("cold", { last_used_at: ago(4 * 60) }),                          // 深夜に使われ 7:00 の初回 cron が拾うケース → 読まない（次の実リクエストに書かせる）
      row("skip", { last_used_at: ago(120), last_warmed_at: ago(61) }),    // スロットが飛んで 61分 → 読まない
      row("edge", { last_used_at: ago(55) }),                              // ちょうど 55分 → 読む
    ];
    expect(selectWarmTargets(rows, NOW).targets.map((t) => t.hash)).toEqual(["edge"]);
    expect(selectWarmTargets(rows, NOW, { maxGapMinutes: 70 }).targets.map((t) => t.hash)).toEqual(["edge", "skip"]);
  });

  await it("retired（読み直しが丸ごと冷えていた）行は候補から外れ、その後に実リクエストが来る（last_used_at > retired_at）と復活する", () => {
    const dead = row("dead", { last_used_at: ago(120), last_warmed_at: ago(45), retired_at: ago(44) });   // 温めた直後に retired
    expect(selectWarmTargets([dead], NOW).reason).toBe("no_targets");
    // 実リクエストが来て last_used_at が retired_at より後になった → 復活（recordWarmPrefix は last_used_at を進めるだけ・retired_at は触らない）
    const revived = { ...dead, last_used_at: ago(42) };
    expect(selectWarmTargets([revived], NOW).targets.map((t) => t.hash)).toEqual(["dead"]);
    // retired の行は上位3の枠も占めない（生きた変種が後回しにならない）
    const live = [row("a", { last_used_at: ago(45) }), row("b", { last_used_at: ago(46) }), row("c", { last_used_at: ago(47) })];
    const withDead = [row("x", { last_used_at: ago(41), retired_at: ago(40) }), row("y", { last_used_at: ago(42), retired_at: ago(40) }), ...live];
    expect(selectWarmTargets(withDead, NOW).targets.map((t) => t.hash)).toEqual(["a", "b", "c"]);
  });

  await it("sys0_hash: 最新の行と違う sys0_hash の行（コードのデプロイで死んだ行）は候補から外れる・未記録（null）の行は比較しない", () => {
    const rows = [
      row("new1", { last_used_at: ago(45), sys0_hash: "v2" }),
      row("old1", { last_used_at: ago(46), sys0_hash: "v1" }),   // デプロイ前の prefix → 外す
      row("old2", { last_used_at: ago(47), sys0_hash: "v1" }),
      row("legacy", { last_used_at: ago(48), sys0_hash: null }), // 列が無かった頃の行 → 比較しない
    ];
    expect(selectWarmTargets(rows, NOW).targets.map((t) => t.hash)).toEqual(["new1", "legacy"]);
    // 最新の行に sys0_hash が無ければ何も外さない
    const noSys0 = [row("a", { last_used_at: ago(45) }), row("b", { last_used_at: ago(46), sys0_hash: "v1" })];
    expect(selectWarmTargets(noSys0, NOW).targets.map((t) => t.hash)).toEqual(["a", "b"]);
  });

  await it("変種が10あっても 1時間に読み直すのは上位3変種 × 1〜2回（cron 10分毎をシミュレート）", () => {
    // 10 変種・全て use_count≥2・直近5時間内。last_used_at は 41〜50 分前に散らす
    const rows: WarmPrefixRow[] = Array.from({ length: 10 }, (_, i) => row(`v${i}`, { last_used_at: ago(41 + i) }));
    let total = 0;
    for (let slot = 0; slot < 6; slot++) {
      const now = NOW + slot * 10 * 60_000;
      const { targets } = selectWarmTargets(rows, now);
      total += targets.length;
      for (const t of targets) { const r = rows.find((x) => x.hash === t.hash)!; r.last_warmed_at = new Date(now).toISOString(); }
    }
    // 上位3（v0・v1・v2）だけが 40分毎 → 60分で 3 × 2 = 6 回まで（従来は延べ 18 回）
    expect(total <= 6).toBe(true);
    expect(total >= 3).toBe(true);
    expect(rows.slice(3).every((r) => r.last_warmed_at === null)).toBe(true);
    expect(KEEP_WARM_DEFAULTS.maxTracked).toBe(3);
    expect(KEEP_WARM_DEFAULTS.maxGapMinutes).toBe(55);
  });

  await it("selectWarmTargets: 時間帯外は何もしない（reason）・対象なしは no_targets・opts で上限を変えられる", () => {
    const rows = [row("a", { last_used_at: ago(45) }), row("b", { last_used_at: ago(50) })];
    const night = selectWarmTargets(rows, T("2026-09-17T17:00:00Z")); // JST 2:00
    expect(night.targets.length).toBe(0);
    expect(night.reason).toBe("outside_hours_jst(7-24)");
    expect(selectWarmTargets([row("b", { last_used_at: ago(10) })], NOW).reason).toBe("no_targets");
    expect(selectWarmTargets(rows, NOW, { maxPerRun: 1 }).targets.map((t) => t.hash)).toEqual(["a"]);
    expect(selectWarmTargets(rows, NOW, { minGapMinutes: 60 }).targets.length).toBe(0);
    // 深夜でも hoursJst を "0-24" にすれば読む（行の last_used_at はその時刻からの相対）
    const NIGHT = T("2026-09-17T17:00:00Z");
    const nightRows = [row("a", { last_used_at: new Date(NIGHT - 45 * 60_000).toISOString() }), row("b", { last_used_at: new Date(NIGHT - 50 * 60_000).toISOString() })];
    expect(selectWarmTargets(nightRows, NIGHT).reason).toBe("outside_hours_jst(7-24)");
    expect(selectWarmTargets(nightRows, NIGHT, { hoursJst: "0-24" }).targets.length).toBe(2);
  });

  await it("読み直しの末尾の1文は cache_control 付きブロックの後ろに足す（鍵に影響しない・返事は「.」だけ）", () => {
    expect(KEEP_WARM_TAIL_TEXT.includes("「.」")).toBe(true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main();
