// ブレインの「毎回の分析（fresh）」を Claude と DeepSeek でそれぞれ走らせ、判断が一致するかを測る（影の比較）
//
// 2026-09-23 竹内「ブレインのフル分析はクロードやけど、毎回の限定的な分析の部分は deepseek が行う形は出来るのか？
//   そうすれば質が高くなる可能性高い」
//   設計知見「分析強化の原則」: 替える前に**同じ入力で両方を走らせて差を数える**。
//
// ⚠ 会話には書き込まない（layer=fresh・propertyCustomerId=null で ai_summary の保存に入らない）。LLM の費用はかかる。
// ⚠ 差し替え（installAltProvider）は**起動時に1回だけ設定を読む**ので、モデルごとに別々に実行して突き合わせる。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/shadow-brain-deepseek.ts --provider=claude   --n=8
//   npx tsx --env-file=.env.local scripts/shadow-brain-deepseek.ts --provider=deepseek --n=8 [--model=deepseek-v4-pro]
//   npx tsx --env-file=.env.local scripts/shadow-brain-deepseek.ts --compare
import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const PROVIDER = arg("provider", "claude");
const N = Number(arg("n", "8"));
const MODEL = arg("model", "deepseek-v4-pro");
const OUT_DIR = arg("out", path.join(process.cwd(), ".shadow-brain"));
const COMPARE = process.argv.includes("--compare");

// ⚠ import より前に環境変数を決める（差し替えは起動時の設定を読むため）
if (PROVIDER === "deepseek" && !COMPARE) {
  process.env.LLM_ALT_PROVIDER = "deepseek";
  process.env.LLM_ALT_ACTIONS = "brain_fresh";
  process.env.LLM_ALT_FALLBACK = "off";          // 落ちても Claude に戻さない（本当に DeepSeek で測る）
  process.env.DEEPSEEK_MODEL = MODEL;
} else {
  process.env.LLM_ALT_ACTIONS = "";
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Meta = Record<string, unknown> | null;
type Row = { id: string; status: string | null; ms: number; err: string | null; meta: Meta };
const file = (p: string) => path.join(OUT_DIR, `${p}.json`);
const short = (s: unknown, n = 70) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const same = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

async function pickConversations(): Promise<Array<{ id: string; status: string | null; customer_name: string | null; brain_strategy: unknown; last_brain_meta: unknown }>> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: msgs } = await sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).limit(400);
  const ids = [...new Set(((msgs ?? []) as Array<{ conversation_id: string }>).map((m) => m.conversation_id))].slice(0, N * 3);
  const { data: convs } = await sb.from("conversations").select("id, status, customer_name, brain_strategy, last_brain_meta").in("id", ids);
  // 申込以降は対象外（竹内「申込以降はいれない」）。順番を固定して、両方の実行で同じ会話を見る
  return ((convs ?? []) as Array<{ id: string; status: string | null; customer_name: string | null; brain_strategy: unknown; last_brain_meta: unknown }>)
    .filter((c) => !["applying", "screening", "approved", "contract", "closed_won", "closed_lost"].includes(String(c.status ?? "")))
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, N);
}

async function run() {
  const { installAltProvider } = await import("../app/lib/llm-alt-provider");
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const installed = PROVIDER === "deepseek" ? installAltProvider() : false;
  console.log(`=== ${PROVIDER}${PROVIDER === "deepseek" ? `（${MODEL}・差し替え ${installed ? "有効" : "⚠無効"}）` : ""} で ${N}会話 ===`);
  if (PROVIDER === "deepseek" && !installed) { console.error("差し替えが有効になっていません（DEEPSEEK_API_KEY / LLM_ALT_DEEPSEEK_KEY を確認）"); process.exit(1); }
  const pool = await pickConversations();
  const rows: Row[] = [];
  for (const c of pool) {
    const t0 = Date.now();
    try {
      const meta = await analyzeConversation(c.id, false, c.status, null, "shadow", {
        mode: "incremental", layer: "fresh",
        strategy: (c.brain_strategy ?? null) as never,
        prevMeta: (c.last_brain_meta ?? undefined) as never,
        customerName: c.customer_name ?? undefined,
      });
      rows.push({ id: c.id, status: c.status, ms: Date.now() - t0, err: null, meta: meta as unknown as Meta });
    } catch (e) {
      rows.push({ id: c.id, status: c.status, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e), meta: null });
    }
    const r = rows[rows.length - 1];
    console.log(`${c.id.slice(0, 8)} ${String(c.status ?? "").padEnd(10)} ${r.ms}ms ${r.err ? `⚠${r.err.slice(0, 60)}` : `action=${short(r.meta?.action, 24)} intent=${short(r.meta?.customer_intent, 14)}`}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file(PROVIDER === "deepseek" ? MODEL : "claude"), JSON.stringify(rows, null, 2), "utf8");
  console.log(`\n保存: ${file(PROVIDER === "deepseek" ? MODEL : "claude")}`);
}

function compare() {
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json"));
  const claude = JSON.parse(fs.readFileSync(file("claude"), "utf8")) as Row[];
  for (const f of files.filter((x) => x !== "claude.json")) {
    const other = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")) as Row[];
    const name = f.replace(".json", "");
    const byId = new Map(other.map((r) => [r.id, r]));
    const pairs = claude.map((a) => ({ a, b: byId.get(a.id) })).filter((p) => p.b) as Array<{ a: Row; b: Row }>;
    console.log(`\n${"═".repeat(70)}\n=== Claude vs ${name}（${pairs.length}会話）===`);
    const keys = ["action", "customer_intent", "checkpoint_stage", "reply_mode", "check_pattern"];
    for (const k of keys) {
      const n = pairs.filter((p) => same(p.a.meta?.[k], p.b.meta?.[k])).length;
      console.log(`   ${k.padEnd(18)} 一致 ${n}/${pairs.length}（${Math.round((n / (pairs.length || 1)) * 100)}%）`);
    }
    const failed = pairs.filter((p) => !p.b.meta || p.b.err).length;
    const med = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
    console.log(`   結果が出なかった: ${failed}件 ／ 所要(中央値): Claude ${med(pairs.map((p) => p.a.ms))}ms ・ ${name} ${med(pairs.map((p) => p.b.ms))}ms`);
    console.log(`\n   【判断が割れた会話】`);
    for (const p of pairs.filter((x) => !same(x.a.meta?.action, x.b.meta?.action) || !same(x.a.meta?.customer_intent, x.b.meta?.customer_intent))) {
      console.log(`   ${p.a.id.slice(0, 8)} ${String(p.a.status ?? "")}\n     Claude: action=${short(p.a.meta?.action, 26)} intent=${short(p.a.meta?.customer_intent, 14)} 方向=${short(p.a.meta?.reply_direction, 70)}\n     ${name}: action=${short(p.b.meta?.action, 26)} intent=${short(p.b.meta?.customer_intent, 14)} 方向=${short(p.b.meta?.reply_direction, 70)}`);
    }
    console.log(`\n   【返信の方向（全会話・目で読む用）】`);
    for (const p of pairs) console.log(`   ${p.a.id.slice(0, 8)}\n     Claude: ${short(p.a.meta?.reply_direction, 100)}\n     ${name}: ${short(p.b.meta?.reply_direction, 100)}`);
  }
}

if (COMPARE) compare();
else run().catch((e) => { console.error(e); process.exit(1); });
