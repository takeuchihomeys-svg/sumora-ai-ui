// scripts/lib/dev-server-test-guard.ts — 開発サーバを HTTP で叩く YUMA のテストが、送る前に「サーバがテストとして起動しているか」を確かめる
//
// 2026-10-02 竹内「テストはテストやで」（手順書 memory/test_protocol_brain.md）:
//   LLM を自分で呼ぶスクリプトは scripts/lib/llm-test-harness.ts を通すが、/api/generate-reply 等を HTTP で叩くスクリプト（約40本）は
//   サーバの起動の印を確かめていなかった（印なしのサーバ＝判定・最終チェックが Claude で黙って走る・本番の URL を既定にした物もあった）。
//   → 最初のリクエストの前に requireTestServer(BASE, 名前) を呼ぶ:
//     ・手元（localhost／127.0.0.1）以外の URL は止める（本番の Vercel に向けない）
//     ・GET <BASE>/api/test/llm-mode（開発サーバだけが答える・本番は 404）で run が deepseek-all／final-claude でなければ止める
//     ・スクリプト自身に印が付いていてサーバと違えば止める（どちらのつもりか分からない）
//     ・終わる時（process.exit／自然な終わり）に、開始以降の開発サーバの行（env=local:<run>・route=/api/...）を model・回数・費用で出す。
//       ⚠ 同じ時間に他の担当が同じ印のサーバを使っていると、その行も入る（route と時刻で読む）。deepseek-all で Claude があれば終了コード 1
import { createClient } from "@supabase/supabase-js";
import { readTestRun } from "../../app/lib/llm-test-mode";
import { claudeUsageUsd, altUsageUsd } from "../../app/lib/llm-price";

export type TestServerInfo = { base: string; run: "deepseek-all" | "final-claude"; envLabel: string; t0: string };

const servers: TestServerInfo[] = [];
let hooked = false;
let reported = false;

function stop(msg: string): never {
  console.error(`\n⛔ ${msg}\n  手順書: memory/test_protocol_brain.md\n`);
  process.exit(1);
}

export async function requireTestServer(base: string, name: string): Promise<TestServerInfo> {
  let url: URL;
  try { url = new URL(base); } catch { stop(`テストの送り先 ${base} が URL ではありません`); }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    stop(`テスト「${name}」の送り先が手元の開発サーバではありません（${base}）。本番に向けてテストを流さない。BASE_URL 等を http://localhost:<port> にしてください`);
  }
  let info: { run?: string | null; envLabel?: string } | null = null;
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/test/llm-mode`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    info = r.ok ? await r.json() as { run?: string | null; envLabel?: string } : null;
    if (!r.ok) stop(`開発サーバ ${base} がテストの印を答えません（HTTP ${r.status}）。古いコードのまま動いているか本番ビルドです。LLM_TEST_MODE=deepseek-all（試行錯誤）か LLM_TEST_FINAL_CLAUDE=1（最後の確かめ）を付けて開発サーバを起動し直してください`);
  } catch (e) {
    stop(`開発サーバ ${base} に届きません（${e instanceof Error ? e.message : String(e)}）。LLM_TEST_MODE=deepseek-all か LLM_TEST_FINAL_CLAUDE=1 を付けて起動してから流してください`);
  }
  const run = info?.run;
  if (run !== "deepseek-all" && run !== "final-claude") {
    stop(`開発サーバ ${base} がテストの印なしで起動しています（本番と同じ Claude の判定・最終チェックが黙って走る）。LLM_TEST_MODE=deepseek-all（試行錯誤）か LLM_TEST_FINAL_CLAUDE=1（最後の確かめ）を付けて起動し直してください`);
  }
  const mine = readTestRun(process.env);
  if (mine && mine !== run) stop(`このスクリプトは ${mine}、開発サーバ ${base} は ${run} で起動しています。どちらかにそろえてください`);
  const s: TestServerInfo = { base, run, envLabel: info?.envLabel ?? `local:${run}`, t0: new Date().toISOString() };
  servers.push(s);
  console.log(`[テスト] 「${name}」→ 開発サーバ ${base}（${run === "deepseek-all" ? "試行錯誤・全部 DeepSeek" : "最後の確かめ・Claude あり（場面ごとに1〜2回）"}）開始 ${s.t0}`);
  hookExit();
  return s;
}

async function report(): Promise<void> {
  if (reported || servers.length === 0) return;
  reported = true;
  try {
    await new Promise((r) => setTimeout(r, 1500)); // 開発サーバの記録の書き込み待ち
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
    const t0 = servers.map((s) => s.t0).sort()[0];
    const envs = [...new Set(servers.map((s) => s.envLabel))];
    const { data } = await sb.from("llm_usage_logs").select("action, model, status, error_type, env, created_at, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens")
      .gte("created_at", t0).in("env", envs).or("route.is.null,route.not.like.script:*").limit(5000); // 開発サーバの DeepSeek の行は route が空のことがある（HMR 後の別の束の記録口）
    const rows = (data ?? []) as Array<Record<string, unknown> & { action: string | null; model: string | null; status: number; error_type: string | null; created_at: string }>;
    const by = new Map<string, { n: number; usd: number }>();
    let claudeN = 0, claudeUsd = 0, altN = 0, altUsd = 0, blocked = 0;
    for (const r of rows) {
      if (r.error_type === "test_blocked") { blocked++; continue; }
      const isClaude = /claude/.test(r.model ?? "");
      const usd = isClaude ? claudeUsageUsd(r) : altUsageUsd(r);
      if (isClaude) { if (r.status > 0 && r.status < 400) { claudeN++; claudeUsd += usd; } } else { altN++; altUsd += usd; }
      const k = `${r.action ?? "(名札なし)"} ${r.model}`;
      const v = by.get(k) ?? { n: 0, usd: 0 }; v.n++; v.usd += usd; by.set(k, v);
    }
    console.log(`\n=== 開発サーバの LLM（env=${envs.join(",")}・route=/api/* と空（script: 以外）・${t0} 以降・他の担当の行を含みうる）: ${rows.length}行 ===`);
    for (const [k, v] of [...by].sort((a, b) => b[1].usd - a[1].usd).slice(0, 15)) console.log(`  ${String(v.n).padStart(3)}回 $${v.usd.toFixed(4)}  ${k}`);
    console.log(`  Claude ${claudeN}回 $${claudeUsd.toFixed(4)}／DeepSeek・Jev 等 ${altN}回 $${altUsd.toFixed(4)}／止めた ${blocked}回`);
    if (servers.some((s) => s.run === "deepseek-all") && claudeN > 0) {
      console.error(`⛔ deepseek-all のサーバで Claude が ${claudeN}回（LLM_TEST_ALLOW_CLAUDE で通した物か確かめる・scripts/test-llm-usage.ts --since=${t0}）`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.warn("[テスト] 費用の集計に失敗:", e instanceof Error ? e.message : String(e));
  }
}

/** process.exit と自然な終わりの前に1回だけ集計を出す（集計は最大10秒で打ち切る） */
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  const realExit = process.exit.bind(process) as (code?: number) => never;
  let exiting = false;
  process.exit = ((code?: number) => {
    if (exiting || reported) return realExit(code ?? (process.exitCode as number | undefined));
    exiting = true;
    const c = code ?? (process.exitCode as number | undefined);
    void Promise.race([report(), new Promise((r) => setTimeout(r, 10_000))]).finally(() => realExit((process.exitCode as number | undefined) && !c ? (process.exitCode as number) : c));
    return undefined as never;
  }) as typeof process.exit;
  process.once("beforeExit", () => { if (!reported) void report(); });
}
