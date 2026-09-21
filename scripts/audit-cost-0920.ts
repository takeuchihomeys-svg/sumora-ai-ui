// 9/20 の API 費用が跳ねた原因を割る（読み取りのみ）
//
// 2026-09-21 竹内「昨日なんでこんなにAPI消費したんかな？テストでの量が原因なのかな？
//   昨日テストでどれくらいAPI消費したのか、またはなにかエラー起きている部分あるのか」
//   （画面: Claude Console 9/20 UTC 請求合計 $37.04 — Sonnet5 $33.76 / Haiku4.5 $3.14 / Opus5 $0.12 / Sonnet4.6 $0.02）
//
// 設計知見:
//   ・「始めたばかりの物を30日の合計で読むと桁がずれる」→ **日別**に並べて平常日と比べる
//   ・「記録を書いているのが誰かを先に確かめる」→ llm_usage_logs / llm_usage_daily は
//     instrumentation.ts の fetch ラッパーが書く。**Claude Code（このセッション）の分は入らない**。
//     画面の合計と合わなければ、その差がツール外（Claude Code・コンソール）の分。
//   ・「切り替えの名前が1つの受け皿に潰れている」→ route だけで割らず、会話ID でも割る
//
// 【費用の出し方】llm_usage_daily.est_usd の定義をそのまま使う（サンプルで検算済み）:
//   input_equiv = uncached + write_5m×1.25 + write_1h×2.0 + cache_read×0.1 + output×5
//   est_usd     = input_equiv × 入力単価/1e6   （Sonnet5 $3 / Haiku4.5 $1 / Opus5 $15）
//   ※ DeepSeek は Claude の請求に入らないので分けて出す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-cost-0920.ts
//   TARGET=2026-09-20（JST の日付）/ DAYS=12
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function page(table: string, select: string, order: string, sinceIso: string | null): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (sinceIso) q = q.gte(order, sinceIso);
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const usd = (v: number) => `$${v.toFixed(2)}`;

/** 入力単価（$/1M）。llm_usage_daily.est_usd と同じ定義 */
const INPUT_PRICE: Record<string, number> = {
  "claude-sonnet-5": 3, "claude-haiku-4-5-20251001": 1, "claude-opus-5": 15, "claude-sonnet-4-6": 3,
};
const isClaude = (m: string) => m.startsWith("claude-");

/** 1行の費用（llm_usage_logs 用・daily と同じ式） */
function costOfLog(r: Record<string, unknown>): number {
  const model = String(r.model ?? "");
  const price = INPUT_PRICE[model];
  if (!price) return 0;   // DeepSeek 等は Claude の請求ではない
  const equiv = n(r.input_uncached) + n(r.cache_write_5m) * 1.25 + n(r.cache_write_1h) * 2.0
    + n(r.cache_read) * 0.1 + n(r.output_tokens) * 5;
  return equiv * price / 1e6;
}
/** JST の日付 */
const dayJst = (iso: string) => new Date(new Date(String(iso)).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const days = Number(process.env.DAYS ?? 12);
  const target = process.env.TARGET ?? "2026-09-20";
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // ═══ A. 日別（llm_usage_daily・ツールが払った分）═══
  const daily = await page("llm_usage_daily", "day_jst, model, route, calls, errors, cache_hits, uncached, cache_read, write_5m, write_1h, output_tokens, input_equiv, est_usd", "day_jst", null);
  const recent = daily.filter((r) => String(r.day_jst) >= since.slice(0, 10));
  console.log(`=== ① 日別の合計（JST・ツールが払った分だけ）===`);
  const byDay = new Map<string, { usd: number; calls: number; errors: number }>();
  for (const r of recent) {
    const d = String(r.day_jst);
    const b = byDay.get(d) ?? { usd: 0, calls: 0, errors: 0 };
    if (isClaude(String(r.model))) b.usd += n(r.est_usd);
    b.calls += n(r.calls); b.errors += n(r.errors);
    byDay.set(d, b);
  }
  const sorted = [...byDay.entries()].sort();
  for (const [d, v] of sorted) {
    console.log(`   ${d}  ${usd(v.usd).padStart(8)}  ${String(v.calls).padStart(5)}回  エラー ${v.errors}${d === target ? "   ← 調べる日" : ""}`);
  }
  const tgt = byDay.get(target)?.usd ?? 0;
  const others = sorted.filter(([d]) => d !== target && d !== sorted.at(-1)?.[0]);
  const avg = others.length ? others.reduce((a, [, v]) => a + v.usd, 0) / others.length : 0;
  console.log(`\n   ${target}: ${usd(tgt)} ／ 他の日の平均: ${usd(avg)} ／ 差: ${usd(tgt - avg)}`);
  console.log(`   ※ 画面（Claude Console 9/20 UTC）は $37.04。差はツールの外（Claude Code のセッション・コンソール）の分。`);

  // ═══ B. その日の経路別 ═══
  const tRows = recent.filter((r) => String(r.day_jst) === target && isClaude(String(r.model)));
  const tUsd = tRows.reduce((a, r) => a + n(r.est_usd), 0);
  console.log(`\n=== ② ${target} の経路別（ツール内 ${usd(tUsd)}）===`);
  const byRoute = new Map<string, { usd: number; calls: number; errors: number }>();
  for (const r of tRows) {
    const k = String(r.route ?? "(不明)");
    const b = byRoute.get(k) ?? { usd: 0, calls: 0, errors: 0 };
    b.usd += n(r.est_usd); b.calls += n(r.calls); b.errors += n(r.errors); byRoute.set(k, b);
  }
  for (const [k, v] of [...byRoute.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 20)) {
    console.log(`   ${usd(v.usd).padStart(8)}  ${String(v.calls).padStart(5)}回  ${(v.usd / tUsd * 100).toFixed(1).padStart(5)}%  ${k}${v.errors ? `  ⚠エラー${v.errors}` : ""}`);
  }

  // ═══ C. 平常日と比べて増えた経路 ═══
  console.log(`\n=== ③ 平常日と比べて増えた経路（1日あたり）===`);
  const baseDays = others.map(([d]) => d);
  const baseByRoute = new Map<string, number>();
  for (const r of recent) {
    if (!baseDays.includes(String(r.day_jst)) || !isClaude(String(r.model))) continue;
    const k = String(r.route ?? "(不明)");
    baseByRoute.set(k, (baseByRoute.get(k) ?? 0) + n(r.est_usd));
  }
  const diffs: Array<{ route: string; diff: number; t: number; b: number }> = [];
  for (const [k, v] of byRoute) {
    const b = (baseByRoute.get(k) ?? 0) / Math.max(1, baseDays.length);
    diffs.push({ route: k, diff: v.usd - b, t: v.usd, b });
  }
  for (const d of diffs.sort((a, b) => b.diff - a.diff).slice(0, 12)) {
    console.log(`   ${(d.diff >= 0 ? "+" : "") + d.diff.toFixed(2).padStart(7)}  ${target} ${usd(d.t).padStart(8)} ← 平常 ${usd(d.b).padStart(8)}  ${d.route}`);
  }

  // ═══ D. テスト（YUMA）の分 — llm_usage_logs を会話IDで割る ═══
  console.log(`\n=== ④ ${target} のうち YUMA（テスト会話）の分 ===`);
  const logs = await page("llm_usage_logs", "created_at, route, model, status, error_type, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, thinking_tokens, conversation_id, action, duration_ms, env", "created_at", since);
  const tLogs = logs.filter((r) => dayJst(String(r.created_at)) === target);
  const logUsd = tLogs.reduce((a, r) => a + costOfLog(r), 0);
  const yumaLogs = tLogs.filter((r) => String(r.conversation_id ?? "") === YUMA);
  const yumaUsd = yumaLogs.reduce((a, r) => a + costOfLog(r), 0);
  const noConv = tLogs.filter((r) => !String(r.conversation_id ?? ""));
  const noConvUsd = noConv.reduce((a, r) => a + costOfLog(r), 0);
  console.log(`   この日の記録の合計 ${usd(logUsd)}（${tLogs.length}回）※ ① の日別と近ければ計算は合っている`);
  console.log(`   ├ YUMA（テスト）    ${usd(yumaUsd).padStart(8)}  ${String(yumaLogs.length).padStart(4)}回  ${(yumaUsd / logUsd * 100).toFixed(1)}%`);
  console.log(`   ├ 会話IDなし        ${usd(noConvUsd).padStart(8)}  ${String(noConv.length).padStart(4)}回  ${(noConvUsd / logUsd * 100).toFixed(1)}%（学習・cron・画像・管理画面）`);
  console.log(`   └ お客様の会話      ${usd(logUsd - yumaUsd - noConvUsd).padStart(8)}  ${String(tLogs.length - yumaLogs.length - noConv.length).padStart(4)}回`);
  if (yumaLogs.length) {
    const m = new Map<string, { usd: number; calls: number }>();
    for (const r of yumaLogs) { const k = String(r.route); const b = m.get(k) ?? { usd: 0, calls: 0 }; b.usd += costOfLog(r); b.calls++; m.set(k, b); }
    console.log(`   YUMA の経路別:`);
    for (const [k, v] of [...m.entries()].sort((a, b) => b[1].usd - a[1].usd)) console.log(`     ${usd(v.usd).padStart(8)}  ${String(v.calls).padStart(4)}回  ${k}`);
    const h = new Map<number, number>();
    for (const r of yumaLogs) { const t = new Date(new Date(String(r.created_at)).getTime() + 9 * 3600_000).getUTCHours(); h.set(t, (h.get(t) ?? 0) + costOfLog(r)); }
    console.log(`   YUMA の時刻別（JST）: ${[...h.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}時 ${usd(v)}`).join(" / ")}`);
  }

  // ═══ E. 1会話に集中していないか ═══
  console.log(`\n=== ⑤ ${target} の会話別 上位8（1つに集中していれば暴走の疑い）===`);
  const byConv = new Map<string, { usd: number; calls: number }>();
  for (const r of tLogs) {
    const k = String(r.conversation_id ?? "") || "(会話IDなし)";
    const b = byConv.get(k) ?? { usd: 0, calls: 0 };
    b.usd += costOfLog(r); b.calls++; byConv.set(k, b);
  }
  for (const [k, v] of [...byConv.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 8)) {
    console.log(`   ${usd(v.usd).padStart(8)}  ${String(v.calls).padStart(4)}回  ${k === YUMA ? "YUMA（テスト）" : k.slice(0, 8)}`);
  }

  // ═══ F. エラー（払っているのに結果が出ていない分）═══
  console.log(`\n=== ⑥ エラー（直近${days}日・日別）===`);
  const errByDay = new Map<string, { n: number; usd: number }>();
  for (const r of logs) {
    const st = n(r.status);
    if (st && st < 400 && !r.error_type) continue;
    const d = dayJst(String(r.created_at));
    const b = errByDay.get(d) ?? { n: 0, usd: 0 };
    b.n++; b.usd += costOfLog(r); errByDay.set(d, b);
  }
  if (errByDay.size === 0) console.log(`   エラーは1件も無い`);
  for (const [d, v] of [...errByDay.entries()].sort()) console.log(`   ${d}  ${String(v.n).padStart(4)}回  ${usd(v.usd)}`);
  const tErrs = tLogs.filter((r) => { const st = n(r.status); return (st && st >= 400) || r.error_type; });
  if (tErrs.length) {
    const m = new Map<string, number>();
    for (const r of tErrs) m.set(`${r.route} ${r.status} ${r.error_type ?? ""}`, (m.get(`${r.route} ${r.status} ${r.error_type ?? ""}`) ?? 0) + 1);
    console.log(`   ${target} の内訳:`);
    for (const [k, c] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`     ${String(c).padStart(4)}回  ${k}`);
  }

  // ═══ G. キャッシュの全書き直し（TTL 失効の丸ごと書き直し）═══
  console.log(`\n=== ⑦ プロンプトキャッシュの全書き直し（書き≧50k）日別 ===`);
  for (const [d] of sorted) {
    const rr = logs.filter((r) => dayJst(String(r.created_at)) === d);
    const w = rr.filter((r) => n(r.cache_write_5m) + n(r.cache_write_1h) >= 50000);
    const hit = rr.reduce((a, r) => a + n(r.cache_read), 0);
    const wr = rr.reduce((a, r) => a + n(r.cache_write_5m) + n(r.cache_write_1h), 0);
    const unc = rr.reduce((a, r) => a + n(r.input_uncached), 0);
    const tot = hit + wr + unc;
    console.log(`   ${d}  全書き直し ${String(w.length).padStart(4)}回 ${usd(w.reduce((a, r) => a + costOfLog(r), 0)).padStart(8)}`
      + `  ｜ 入力の内訳 読み${(hit / tot * 100).toFixed(0)}% 書き${(wr / tot * 100).toFixed(0)}% 素${(unc / tot * 100).toFixed(0)}%`);
  }

  // ═══ H. モデル別 ═══
  console.log(`\n=== ⑧ ${target} のモデル別 ===`);
  const byModel = new Map<string, { usd: number; calls: number }>();
  for (const r of recent.filter((x) => String(x.day_jst) === target)) {
    const k = String(r.model);
    const b = byModel.get(k) ?? { usd: 0, calls: 0 };
    if (isClaude(k)) b.usd += n(r.est_usd);
    b.calls += n(r.calls); byModel.set(k, b);
  }
  for (const [k, v] of [...byModel.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`   ${usd(v.usd).padStart(8)}  ${String(v.calls).padStart(5)}回  ${k}${isClaude(k) ? "" : "  ← Claude の請求ではない"}`);
  }
  console.log(`\n   ※ 画面（9/20 UTC）: Sonnet5 $33.76 / Haiku4.5 $3.14 / Opus5 $0.12 / Sonnet4.6 $0.02 ＝ $37.04`);

  // ═══ I. 画面と同じ UTC の区切りで並べ直す（JST とは9時間ずれる）═══
  //   Opus5 が $0.12/3回 で画面と一致した＝同じ API キーの記録。差がどこから来るかは
  //   まず**日付の区切り**を合わせないと分からない。
  console.log(`\n=== ⑨ UTC の区切り（画面と同じ）でモデル別 ===`);
  const dayUtc = (iso: string) => String(iso).slice(0, 10);
  const utcDays = new Map<string, Map<string, { usd: number; calls: number }>>();
  for (const r of logs) {
    const d = dayUtc(String(r.created_at));
    if (!utcDays.has(d)) utcDays.set(d, new Map());
    const m = utcDays.get(d)!;
    const k = String(r.model);
    const b = m.get(k) ?? { usd: 0, calls: 0 };
    b.usd += costOfLog(r); b.calls++; m.set(k, b);
  }
  for (const [d, m] of [...utcDays.entries()].sort()) {
    const tot = [...m.values()].reduce((a, v) => a + v.usd, 0);
    const detail = [...m.entries()].sort((a, b) => b[1].usd - a[1].usd)
      .map(([k, v]) => `${k.replace("claude-", "").replace("-20251001", "")} ${usd(v.usd)}(${v.calls})`).join(" / ");
    console.log(`   ${d}  合計 ${usd(tot).padStart(8)}  ｜ ${detail}`);
  }

  // ═══ J. 記録を書いているのは誰か（env・thinking の取りこぼし）═══
  console.log(`\n=== ⑩ 記録の内訳（差がツール外か、記録漏れかを分ける）===`);
  const tUtc = logs.filter((r) => dayUtc(String(r.created_at)) === target);
  const byEnv = new Map<string, { usd: number; calls: number }>();
  for (const r of tUtc) {
    const k = String((r as Record<string, unknown>).env ?? "(なし)");
    const b = byEnv.get(k) ?? { usd: 0, calls: 0 };
    b.usd += costOfLog(r); b.calls++; byEnv.set(k, b);
  }
  console.log(`   ${target}(UTC) の env 別:`);
  for (const [k, v] of [...byEnv.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`     ${usd(v.usd).padStart(8)}  ${String(v.calls).padStart(5)}回  env=${k}`);
  }
  const think = tUtc.reduce((a, r) => a + n(r.thinking_tokens), 0);
  const outp = tUtc.reduce((a, r) => a + n(r.output_tokens), 0);
  console.log(`   thinking_tokens 合計 ${(think / 1000).toFixed(0)}k ／ output_tokens 合計 ${(outp / 1000).toFixed(0)}k`);
  console.log(`   → output に thinking が含まれていなければ、その分だけこの計算は安く出る`);
}
main().catch((e) => { console.error(e); process.exit(1); });
