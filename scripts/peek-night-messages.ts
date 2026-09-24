// 夜間（JST 22:00〜9:00）に届くお客様メッセージの量と、その時間帯のブレイン費用を見る（読み取りのみ・お客様名は出さない）
// 実行: npx tsx --env-file=.env.local scripts/peek-night-messages.ts [--days=14] [--night=22-9]
// 目的: 「夜は分析せず 9:00 から」にした時、朝に溜まる会話数（generate-pending-drafts / brain-sweep の枠で足りるか）を実測で決める
import { createClient } from "@supabase/supabase-js";
import { jstParts } from "../app/lib/jst-date";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "14");
const [nightStart, nightEnd] = (arg("night") ?? "22-9").split("-").map(Number);
const isNight = (h: number) => (nightStart > nightEnd ? h >= nightStart || h < nightEnd : h >= nightStart && h < nightEnd);
/** 夜の「日付」は明ける朝の日付（22:00〜23:59 は翌日の朝に数える） */
const nightKey = (iso: string) => {
  const p = jstParts(iso);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d) + (p.hour >= nightStart ? 86_400_000 : 0));
  return d.toISOString().slice(0, 10);
};

const PRICE: Record<string, [number, number, number, number, number]> = { haiku: [1, 0.1, 1.25, 2, 5], sonnet: [3, 0.3, 3.75, 6, 15], opus: [5, 0.5, 6.25, 10, 25], deepseek: [0.28, 0.028, 0, 0, 0.42] };
type Usage = { created_at: string; action: string | null; model: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; thinking_tokens: number; conversation_id: string | null };
function tier(m: string | null) { const s = (m ?? "").toLowerCase(); return s.includes("haiku") ? "haiku" : s.includes("opus") ? "opus" : s.includes("deepseek") ? "deepseek" : "sonnet"; }
function usd(r: Usage): number {
  const p = PRICE[tier(r.model)];
  const w5 = r.cache_write_5m || (r.cache_write_1h ? 0 : r.cache_write) || 0;
  return (r.input_uncached * p[0] + r.cache_read * p[1] + w5 * p[2] + (r.cache_write_1h || 0) * p[3] + (r.output_tokens + (r.thinking_tokens || 0)) * p[4]) / 1e6;
}

async function readAll<T>(build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from);
    if (error) { console.log(error.message); process.exit(1); }
    const chunk = (data ?? []) as T[];
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Msg = { created_at: string; conversation_id: string };
  const msgs = await readAll<Msg>((from) => sb.from("messages").select("created_at, conversation_id").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999));
  console.log(`=== ${days}日分: お客様メッセージ ${msgs.length}通（夜＝JST ${nightStart}:00〜${nightEnd}:00） ===`);

  const byHour = new Array<number>(24).fill(0);
  for (const m of msgs) byHour[jstParts(m.created_at).hour]++;
  console.log("JST 時間帯ごとの通数:", byHour.map((n, h) => `${h}時:${n}`).join(" "));

  const nightMsgs = msgs.filter((m) => isNight(jstParts(m.created_at).hour));
  const perNight = new Map<string, { msgs: number; convs: Set<string> }>();
  for (const m of nightMsgs) {
    const k = nightKey(m.created_at);
    const e = perNight.get(k) ?? { msgs: 0, convs: new Set<string>() };
    e.msgs++; e.convs.add(m.conversation_id); perNight.set(k, e);
  }
  const nights = [...perNight.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\n=== 夜ごと（朝の日付・溜まる会話数＝9:00 に処理する件数） 夜の通数 ${nightMsgs.length}（全体の ${(100 * nightMsgs.length / Math.max(1, msgs.length)).toFixed(1)}%） ===`);
  for (const [k, e] of nights) console.log(`${k}: 会話 ${e.convs.size}件 / ${e.msgs}通`);
  const convCounts = nights.map(([, e]) => e.convs.size).sort((a, b) => a - b);
  const pct = (q: number) => convCounts[Math.min(convCounts.length - 1, Math.floor(q * convCounts.length))] ?? 0;
  console.log(`会話数: 中央値 ${pct(0.5)} / 90% ${pct(0.9)} / 最大 ${convCounts.at(-1) ?? 0}（夜の記録がある日 ${convCounts.length}/${days}）`);

  // 夜間に動いたブレイン（llm_usage_logs・action が brain で始まる行）
  const usage = await readAll<Usage>((from) => sb.from("llm_usage_logs").select("created_at, action, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, thinking_tokens, conversation_id").gte("created_at", since).like("action", "brain%").order("created_at", { ascending: true }).range(from, from + 999));
  const night = usage.filter((r) => isNight(jstParts(r.created_at).hour));
  const nightCold = night.filter((r) => r.cache_write_1h > 0);
  const dayCold = usage.filter((r) => !isNight(jstParts(r.created_at).hour) && r.cache_write_1h > 0);
  const sum = (rs: Usage[]) => rs.reduce((a, r) => a + usd(r), 0);
  console.log(`\n=== ブレイン呼び出し（${days}日）: 全 ${usage.length}回 $${sum(usage).toFixed(2)} / 夜 ${night.length}回 $${sum(night).toFixed(2)}（1回平均 $${(sum(night) / Math.max(1, night.length)).toFixed(3)}） ===`);
  console.log(`夜の cold（1h キャッシュを書いた回）: ${nightCold.length}回 $${sum(nightCold).toFixed(2)} / 昼の cold: ${dayCold.length}回`);
  console.log("夜の cold の時刻(JST):", nightCold.map((r) => { const p = jstParts(r.created_at); return `${p.m}/${p.d} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; }).join(", "));
  // 夜の呼び出しの action 内訳
  const byAction = new Map<string, number>();
  for (const r of night) byAction.set(r.action ?? "-", (byAction.get(r.action ?? "-") ?? 0) + 1);
  console.log("夜の action 内訳:", [...byAction.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
  console.log("※ action=brain_* の名札は 2026-09-23 から（それ以前のブレイン行は action が空）。多日の実測は下の route 別で見る");

  // 名札に頼らず route で見る（2026-09-14 の記録開始から）: 夜間の Claude 呼び出しと cold（1h キャッシュ書き込み）の費用
  type RouteRow = Usage & { route: string | null };
  const all = await readAll<RouteRow>((from) => sb.from("llm_usage_logs").select("created_at, route, action, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, thinking_tokens, conversation_id").gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999));
  const claudeNight = all.filter((r) => tier(r.model) !== "deepseek" && isNight(jstParts(r.created_at).hour));
  const byRoute = new Map<string, { n: number; usd: number; cold: number; coldUsd: number }>();
  for (const r of claudeNight) {
    const k = (r.route ?? "-").replace("/api/", "");
    const e = byRoute.get(k) ?? { n: 0, usd: 0, cold: 0, coldUsd: 0 };
    e.n++; e.usd += usd(r);
    if (r.cache_write_1h > 0) { e.cold++; e.coldUsd += (r.cache_write_1h * (PRICE[tier(r.model)][3] - PRICE[tier(r.model)][1])) / 1e6; }
    byRoute.set(k, e);
  }
  const nightsWithLogs = new Set(claudeNight.map((r) => nightKey(r.created_at))).size;
  console.log(`\n=== 夜間の Claude 呼び出し（route 別・記録がある夜 ${nightsWithLogs} 夜）: cold＝1h キャッシュを書いた回・coldUsd＝読みで済んだ場合との差 ===`);
  for (const [k, e] of [...byRoute.entries()].sort((x, y) => y[1].usd - x[1].usd).slice(0, 10)) {
    console.log(`${k}: ${e.n}回 $${e.usd.toFixed(2)}（1夜 $${(e.usd / Math.max(1, nightsWithLogs)).toFixed(2)}） cold ${e.cold}回 差 $${e.coldUsd.toFixed(2)}`);
  }
  const totalNight = [...byRoute.values()].reduce((a, e) => a + e.usd, 0);
  const totalCold = [...byRoute.values()].reduce((a, e) => a + e.coldUsd, 0);
  console.log(`夜間合計 $${totalNight.toFixed(2)}（1夜 $${(totalNight / Math.max(1, nightsWithLogs)).toFixed(2)}）/ うち cold の上乗せ $${totalCold.toFixed(2)}（1夜 $${(totalCold / Math.max(1, nightsWithLogs)).toFixed(2)}）`);

  // 2026-09-24 竹内「22時〜9時のお客さんは分析せずに9時から」（night-defer）が効いているかを翌日以降に読む節。
  //   お客様起点（generate-draft-bg-async / cron/generate-pending-drafts / cron/brain-sweep / line-webhook）の夜の行が 0 になっていれば効いている。
  //   スタッフ起点（send-line-message / generate-reply 手動 / aix/*）は夜も動いてよい（人の操作回数で有界）ので残ってよい。
  //   夜ごと（朝の日付）に route×action で数える。brain-warm（温め）は 9〜22 時の窓の外なので夜に出たら別の異常
  const CUSTOMER_ROUTES = new Set(["generate-draft-bg-async", "cron/generate-pending-drafts", "cron/brain-sweep", "line-webhook"]);
  const STAFF_ROUTES = new Set(["send-line-message", "generate-reply"]);
  const originOf = (route: string) => (CUSTOMER_ROUTES.has(route) ? "お客様起点" : STAFF_ROUTES.has(route) || route.startsWith("aix/") ? "スタッフ起点" : "その他");
  const perNightOrigin = new Map<string, Map<string, Map<string, number>>>(); // night → origin → route×action → n
  for (const r of claudeNight) {
    const route = (r.route ?? "-").replace("/api/", "");
    const k = nightKey(r.created_at);
    const o = perNightOrigin.get(k) ?? new Map<string, Map<string, number>>();
    const m = o.get(originOf(route)) ?? new Map<string, number>();
    const ra = `${route}×${r.action ?? "-"}`;
    m.set(ra, (m.get(ra) ?? 0) + 1);
    o.set(originOf(route), m); perNightOrigin.set(k, o);
  }
  console.log(`\n=== 夜間の Claude 呼び出し（夜ごと・お客様起点／スタッフ起点。night-defer 導入後はお客様起点が 0 になるのが正） ===`);
  for (const [k, o] of [...perNightOrigin.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const line = ["お客様起点", "スタッフ起点", "その他"].map((name) => {
      const m = o.get(name);
      const n = m ? [...m.values()].reduce((a, v) => a + v, 0) : 0;
      const detail = m ? [...m.entries()].sort((x, y) => y[1] - x[1]).map(([ra, v]) => `${ra}:${v}`).join(" ") : "";
      return `${name} ${n}回${detail ? `（${detail}）` : ""}`;
    });
    console.log(`${k}: ${line.join(" / ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
