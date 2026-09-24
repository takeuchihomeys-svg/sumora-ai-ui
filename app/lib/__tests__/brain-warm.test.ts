// 2026-09-24 竹内「実装する」（ブレインの前置きの温め・営業時間 JST 9〜22 だけ）
//   温める／温めないの判断（decideBrainWarm）の窓・上限・retire と、効いたかの読み方（classifyBrainWarmUsage）の閾値を固定する。
//   llm_usage_logs の印（x-sumora-llm-action: brain-warm）が action になり Anthropic には送られない事も既存の fetch ラッパーで1件確認する
// 実行: npx tsx app/lib/__tests__/brain-warm.test.ts（自己完結ハーネス・env 不要。全 OK で exit 0）
import { decideBrainWarm, classifyBrainWarmUsage, BRAIN_WARM_DEFAULTS, type BrainWarmInput } from "../brain-warm";
import { wrapFetchWithLlmUsageRecorder, LLM_ACTION_HEADER, type LlmUsageRow } from "../llm-usage-recorder";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}
const T = (iso: string) => Date.parse(iso);
// 2026-09-24 10:00 JST = 01:00 UTC（営業時間内）
const NOW = T("2026-09-24T01:00:00Z");
const ago = (min: number) => NOW - min * 60_000;
const base: BrainWarmInput = { nowMs: NOW, lastRealCallMs: ago(55), lastWarmedMs: null, retiredMs: null, warmedTodayCount: 3, enabled: true, altRouted: false };
const d = (o: Partial<BrainWarmInput>) => decideBrainWarm({ ...base, ...o });

console.log("── 既定値");
{
  t("hoursJst 9-22・50〜58分・1日20回・retire 6h", BRAIN_WARM_DEFAULTS.hoursJst === "9-22" && BRAIN_WARM_DEFAULTS.minGapMinutes === 50 && BRAIN_WARM_DEFAULTS.maxGapMinutes === 58 && BRAIN_WARM_DEFAULTS.maxPerDay === 20 && BRAIN_WARM_DEFAULTS.coldRetireHours === 6);
}

console.log("── 時間帯（JST 9-22）と止め方");
{
  t("8:59 JST（前日 23:59Z）→ outside_hours_jst(9-22)", d({ nowMs: T("2026-09-23T23:59:00Z"), lastRealCallMs: T("2026-09-23T23:59:00Z") - 55 * 60_000 }).reason === "outside_hours_jst(9-22)");
  t("9:00 JST（00:00Z）→ 対象（他条件を満たせば warm）", d({ nowMs: T("2026-09-24T00:00:00Z"), lastRealCallMs: T("2026-09-24T00:00:00Z") - 55 * 60_000 }).warm === true);
  t("21:59 JST（12:59Z）→ 対象", d({ nowMs: T("2026-09-24T12:59:00Z"), lastRealCallMs: T("2026-09-24T12:59:00Z") - 55 * 60_000 }).warm === true);
  t("22:00 JST（13:00Z）→ outside", d({ nowMs: T("2026-09-24T13:00:00Z"), lastRealCallMs: T("2026-09-24T13:00:00Z") - 55 * 60_000 }).reason === "outside_hours_jst(9-22)");
  t("enabled=false → disabled（時間帯より先）", d({ enabled: false, nowMs: T("2026-09-24T13:00:00Z") }).reason === "disabled");
  t("altRouted=true → alt_routed（時間帯より先）", d({ altRouted: true, nowMs: T("2026-09-24T13:00:00Z") }).reason === "alt_routed");
  t("hoursJst \"8-23\" を渡せば 22:30 JST も対象", d({ nowMs: T("2026-09-24T13:30:00Z"), lastRealCallMs: T("2026-09-24T13:30:00Z") - 55 * 60_000, hoursJst: "8-23" }).warm === true);
  t("壊れた hoursJst は既存 fallback 7-24（8:00 JST が対象になる）", d({ nowMs: T("2026-09-23T23:00:00Z"), lastRealCallMs: T("2026-09-23T23:00:00Z") - 55 * 60_000, hoursJst: "22-9" }).warm === true);
}

console.log("── 窓（50〜58分）と最後のタッチ");
{
  t("lastRealCall 49分前 → too_soon", d({ lastRealCallMs: ago(49) }).reason === "too_soon");
  t("50分前 → warm", d({ lastRealCallMs: ago(50) }).reason === "warm");
  t("58分前 → warm", d({ lastRealCallMs: ago(58) }).reason === "warm");
  t("59分前 → cold_skip", d({ lastRealCallMs: ago(59) }).reason === "cold_skip");
  t("120分前 → cold_skip（冷えていたら温めない・書き込みは本物に払わせる）", d({ lastRealCallMs: ago(120) }).reason === "cold_skip");
  t("lastRealCall 120分前・lastWarmed 52分前 → warm（GREATEST を取る）", d({ lastRealCallMs: ago(120), lastWarmedMs: ago(52) }).reason === "warm");
  t("lastRealCall 20分前・lastWarmed 52分前 → too_soon（本物の方が新しい）", d({ lastRealCallMs: ago(20), lastWarmedMs: ago(52) }).reason === "too_soon");
  t("lastRealCall null・lastWarmed null → no_prior_call（温めない）", d({ lastRealCallMs: null, lastWarmedMs: null }).reason === "no_prior_call");
  t("lastWarmed 52分前・lastRealCall null → warm（温めで延びた TTL を守る）", d({ lastRealCallMs: null, lastWarmedMs: ago(52) }).reason === "warm");
  const r = d({ lastRealCallMs: ago(55) });
  t("gapMinutes が数値で返る（55）", typeof r.gapMinutes === "number" && Math.abs(r.gapMinutes - 55) < 0.2, r);
  t("too_soon / cold_skip でも gapMinutes は数値", typeof d({ lastRealCallMs: ago(10) }).gapMinutes === "number" && typeof d({ lastRealCallMs: ago(90) }).gapMinutes === "number");
  t("no_prior_call の gapMinutes は null", d({ lastRealCallMs: null }).gapMinutes === null);
}

console.log("── retire（冷えていた後は本物が来るまで温めない）と1日の上限");
{
  t("retired 30分前・lastRealCall 55分前（retired より前）→ retired", d({ retiredMs: ago(30), lastRealCallMs: ago(55) }).reason === "retired");
  t("retired 30分前・lastRealCall 20分前（retired より後）→ too_soon（復活している）", d({ retiredMs: ago(30), lastRealCallMs: ago(20) }).reason === "too_soon");
  t("retired 30分前・lastRealCall 55分前・lastWarmed 52分前 → retired（温めの記録では復活しない）", d({ retiredMs: ago(30), lastRealCallMs: ago(55), lastWarmedMs: ago(52) }).reason === "retired");
  t("retired 7時間前 → 効かない（warm）", d({ retiredMs: ago(7 * 60), lastRealCallMs: ago(55) }).reason === "warm");
  t("retired 30分前・lastRealCall null・lastWarmed 52分前 → retired", d({ retiredMs: ago(30), lastRealCallMs: null, lastWarmedMs: ago(52) }).reason === "retired");
  t("warmedTodayCount 20 → day_cap", d({ warmedTodayCount: 20 }).reason === "day_cap");
  t("warmedTodayCount 19 → warm", d({ warmedTodayCount: 19 }).reason === "warm");
  t("day_cap は no_prior_call より先（DB を読まずに止められる順）", d({ warmedTodayCount: 20, lastRealCallMs: null }).reason === "day_cap");
  t("maxPerDay を渡せば変えられる", d({ warmedTodayCount: 5, maxPerDay: 5 }).reason === "day_cap");
}

console.log("── classifyBrainWarmUsage（system[1] ≈12k・全体 ≈39k の実測から）");
{
  t("{read 38500, write1h 0} → hit", classifyBrainWarmUsage({ cache_read: 38500, cache_write_1h: 0 }) === "hit");
  t("{read 26500, write1h 12000} → dynamic_rewrite（DB 更新の前払い）", classifyBrainWarmUsage({ cache_read: 26500, cache_write_1h: 12000 }) === "dynamic_rewrite");
  t("{read 0, write1h 39000} → cold", classifyBrainWarmUsage({ cache_read: 0, cache_write_1h: 39000 }) === "cold");
  t("{read 0, write1h 0} → no_cache", classifyBrainWarmUsage({ cache_read: 0, cache_write_1h: 0 }) === "no_cache");
  t("{read 5000, write1h 34000}（static まで書き直し）→ cold（read<20k）", classifyBrainWarmUsage({ cache_read: 5000, cache_write_1h: 34000 }) === "cold");
}

console.log("── 記録の型: x-sumora-llm-action: brain-warm を付けた fetch は action='brain-warm' で残り、Anthropic には送られない");
{
  const body = JSON.stringify({
    model: "claude-sonnet-5", max_tokens: 1, thinking: { type: "disabled" },
    system: [
      { type: "text", text: "あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "【絶対ルール（オペレーター設定）】\n- 来阪は使わない", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [{ role: "user", content: "." }],
  });
  const rows: LlmUsageRow[] = [];
  const pending: Promise<unknown>[] = [];
  let sentHeaders: Headers | null = null;
  const fake = async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ model: "claude-sonnet-5", stop_reason: "max_tokens", usage: { input_tokens: 3, cache_read_input_tokens: 38912, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_warm" } });
  };
  const f = wrapFetchWithLlmUsageRecorder(fake, { insert: async (r) => { rows.push(r); }, keepAlive: (p) => { pending.push(p); }, route: () => "/api/cron/brain-sweep", env: "test" });
  (async () => {
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body, headers: { [LLM_ACTION_HEADER]: "brain-warm", "content-type": "application/json" } });
    await Promise.all(pending);
    const h = sentHeaders as Headers | null;
    t("action が 'brain-warm' で1行残る", rows.length === 1 && rows[0].action === "brain-warm", rows[0]);
    t("印のヘッダは Anthropic に送られない", !!h && h.get(LLM_ACTION_HEADER) === null && h.get("content-type") === "application/json");
    t("効いた印の形: cache_read≈39k・cache_write_1h 0・output 1・max_tokens 1・thinking disabled・cache_breakpoints 2", rows[0].cache_read === 38912 && rows[0].cache_write_1h === 0 && rows[0].output_tokens === 1 && rows[0].max_tokens === 1 && rows[0].thinking_mode === "disabled" && rows[0].cache_breakpoints === 2, rows[0]);
    t("会話 ID は付けない（conversation_id null）", rows[0].conversation_id === null);
    t("classifyBrainWarmUsage(記録の行) → hit", classifyBrainWarmUsage({ cache_read: rows[0].cache_read, cache_write_1h: rows[0].cache_write_1h }) === "hit");
    console.log(`\n${passed} OK / ${failed} NG`);
    if (failed > 0) process.exit(1);
  })().catch((e) => { console.error(e); process.exit(1); });
}
