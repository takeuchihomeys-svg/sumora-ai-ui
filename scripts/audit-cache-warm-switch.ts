// scripts/audit-cache-warm-switch.ts — お客様ごと・1日ごとの温めのスイッチ（cache-warm-switch.ts）の損得を実物で測る（読み取りのみ・LLM を呼ばない）
//
// 2026-10-02 竹内「温めするお客さんは1日のなかでも連絡多い人でやるとキャッシュきくのか、どのような配分が良いか調査する」
//   ①1日のやり取り（お客様＋スタッフ・JST の日）の帯ごとの会話×日の数と brain_fresh の間隔
//   ②会話専用ブロック（brain_fresh の 5分の土台）が次の本物まで変わらない率 q
//      ・llm_usage_logs から: 0.5〜5分の組で当たった率（間に戦略／全体分析／セーブデータが走った組は別に数える）
//      ・影の記録から: brain_decision_logs.digest.cw.h（会話専用ブロックの指紋）が同じ日の次の回と同じ率（BRAIN_CACHE_WARM=shadow で溜まる）
//   ③閾値 N ごとに「1h にして 55分ごとに温め・静か120分で止める」時の1日の損得（q は ②の実測と仮定の値）
//   → q（指紋の一致率）が 0.7 を超えるまで BRAIN_CACHE_WARM=on にしない（0.43 ではどの N でも損）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-cache-warm-switch.ts [--days=9]
import { createClient } from "@supabase/supabase-js";
import { decideCacheWarm, CACHE_WARM_DEFAULTS } from "../app/lib/cache-warm-switch";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "9"));
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const n = (v: unknown) => Number(v ?? 0) || 0;
const PR = { w5: 2.5, w1h: 4, read: 0.2 };
const jstDay = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const jstH = (t: number) => new Date(t + 9 * 3600e3).getUTCHours();

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 100; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type U = { created_at: string; action: string; model: string; conversation_id: string | null; sys_key_full: string | null; cache_read: number; cache_write_5m: number; cache_write_1h: number; status: number };
type M = { conversation_id: string; sender: string; created_at: string };

async function main() {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const usage = (await pageAll<U>((a, b) => sb.from("llm_usage_logs").select("created_at, action, model, conversation_id, sys_key_full, cache_read, cache_write_5m, cache_write_1h, status")
    .gte("created_at", since).eq("env", "production").like("action", "brain%").like("model", "claude%").order("created_at", { ascending: true }).range(a, b)))
    .filter((r) => r.status < 400 && r.conversation_id && r.conversation_id !== YUMA);
  const msgs = (await pageAll<M>((a, b) => sb.from("messages").select("conversation_id, sender, created_at").gte("created_at", since).order("created_at", { ascending: true }).range(a, b)))
    .filter((m) => m.conversation_id !== YUMA);
  if (!usage.length) { console.log("brain の行がありません"); return; }
  const span = (Date.parse(usage[usage.length - 1].created_at) - Date.parse(usage[0].created_at)) / 86400e3;
  const ex = new Map<string, number[]>(), cust = new Map<string, number[]>();
  for (const m of msgs) { const t = Date.parse(m.created_at); (ex.get(m.conversation_id) ?? ex.set(m.conversation_id, []).get(m.conversation_id)!).push(t); if (m.sender === "customer") (cust.get(m.conversation_id) ?? cust.set(m.conversation_id, []).get(m.conversation_id)!).push(t); }
  const countToday = (arr: number[], t: number) => { const d = jstDay(t); return arr.filter((x) => x <= t && jstDay(x) === d).length; };
  const lastBefore = (arr: number[], t: number) => { let r: number | null = null; for (const x of arr) if (x <= t) r = x; else break; return r; };

  // ① 帯
  const dayEx = new Map<string, number>();
  for (const [c, arr] of ex) for (const t of arr) { const k = c + "|" + jstDay(t); dayEx.set(k, (dayEx.get(k) ?? 0) + 1); }
  const band = (v: number) => (v <= 2 ? "1-2" : v <= 5 ? "3-5" : v <= 9 ? "6-9" : v <= 14 ? "10-14" : v <= 19 ? "15-19" : "20+");
  const hist: Record<string, number> = {};
  for (const v of dayEx.values()) hist[band(v)] = (hist[band(v)] ?? 0) + 1;
  console.log(`=== 温めのスイッチの監査（本番・${span.toFixed(1)}日分・YUMA を除く）===`);
  console.log("① 1日のやり取り（お客様＋スタッフ）の帯ごとの会話×日:", hist);

  // ② q（llm_usage_logs の 0.5〜5分の組）
  const bf = usage.filter((r) => r.action === "brain_fresh");
  const S = new Map<string, number>();
  for (const r of bf) if (n(r.cache_write_5m) > 0) { const k = r.model + r.sys_key_full; S.set(k, Math.min(S.get(k) ?? 1e9, n(r.cache_read) + n(r.cache_write_1h))); }
  const byConv = new Map<string, U[]>();
  for (const r of usage) (byConv.get(r.conversation_id!) ?? byConv.set(r.conversation_id!, []).get(r.conversation_id!)!).push(r);
  let pairs = 0, hits = 0, pairsClean = 0, hitsClean = 0; const P: number[] = [];
  for (const list of byConv.values()) {
    let prev: U | null = null; let between = false;
    for (const r of list) {
      if (r.action !== "brain_fresh") { if (prev && /brain_(strategy|checkpoint|full)/.test(r.action)) between = true; continue; }
      const s = S.get(r.model + r.sys_key_full) ?? 40000;
      const p = n(r.cache_read) + n(r.cache_write_5m) + n(r.cache_write_1h) - s; if (p > 200) P.push(p);
      if (prev) {
        const g = (Date.parse(r.created_at) - Date.parse(prev.created_at)) / 60e3;
        if (g >= 0.5 && g <= 5) { const hit = n(r.cache_read) > s + 200; pairs++; if (hit) hits++; if (!between) { pairsClean++; if (hit) hitsClean++; } }
      }
      prev = r; between = false;
    }
  }
  const qMeasured = pairs ? hits / pairs : 0;
  const Pmed = P.sort((a, b) => a - b)[Math.floor(P.length / 2)] ?? 3000;
  console.log(`② 会話専用ブロック: 中央値 ${Pmed} トークン／0.5〜5分の組で当たった率 q=${qMeasured.toFixed(2)}（${hits}/${pairs}）・間に戦略/全体分析/セーブデータが無い組だけ ${pairsClean ? (hitsClean / pairsClean).toFixed(2) : "-"}（${hitsClean}/${pairsClean}）`);

  // ② 影の記録（digest.cw）
  const logs = await pageAll<{ conversation_id: string; created_at: string; digest: { cw?: { on: boolean; h: string | null; n: number | null } } | null }>((a, b) =>
    sb.from("brain_decision_logs").select("conversation_id, created_at, digest").gte("created_at", since).not("digest->cw", "is", null).order("created_at", { ascending: true }).range(a, b));
  if (logs.length) {
    let onPairs = 0, same = 0; const onDays = new Set<string>();
    const lastOf = new Map<string, { t: number; h: string | null; on: boolean }>();
    for (const l of logs) {
      const cw = l.digest?.cw; if (!cw) continue; const t = Date.parse(l.created_at);
      if (cw.on) onDays.add(l.conversation_id + jstDay(t));
      const prev = lastOf.get(l.conversation_id);
      if (prev && prev.on && cw.on && jstDay(prev.t) === jstDay(t) && t - prev.t <= 60 * 60e3) { onPairs++; if (prev.h && prev.h === cw.h) same++; }
      lastOf.set(l.conversation_id, { t, h: cw.h, on: cw.on });
    }
    console.log(`② 影の記録（digest.cw・${logs.length}回）: ON の会話×日 ${onDays.size}（1日 ${(onDays.size / span).toFixed(1)}）／ON の続く組（1時間以内）で指紋が同じ率 q=${onPairs ? (same / onPairs).toFixed(2) : "-"}（${same}/${onPairs}）← これが 0.7 を超えたら on を検討`);
  } else {
    console.log("② 影の記録（digest.cw）: まだありません（BRAIN_CACHE_WARM=shadow のデプロイ後に溜まる）");
  }

  // ③ 閾値 N ごとの損得（1h＋温め・静か120分）
  const calls = new Map<string, number[]>();
  for (const r of bf) (calls.get(r.conversation_id!) ?? calls.set(r.conversation_id!, []).get(r.conversation_id!)!).push(Date.parse(r.created_at));
  const Sbrain = 40000;
  const sim = (N: number, Pv: number, q: number) => {
    let base = 0, pol = 0, warms = 0; const onDays = new Set<string>();
    for (const [c, ts] of calls) {
      const exArr = ex.get(c) ?? [], cArr = cust.get(c) ?? [];
      let lastBase = -Infinity, lastTouch = -Infinity, prevT = -Infinity, prevOn = false;
      for (const t of ts) {
        base += ((t - lastBase) / 60e3 <= 5 ? q * Pv * PR.read + (1 - q) * Pv * PR.w5 : Pv * PR.w5) / 1e6; lastBase = t;
        const sw = decideCacheWarm({ nowMs: t, exchangesToday: countToday(exArr, t), lastCustomerMsgMs: lastBefore(cArr, t), minExchangesToday: N });
        if (prevOn && jstDay(prevT) === jstDay(t)) {
          for (let w = lastTouch + 55 * 60e3; w < t; w += 55 * 60e3) {
            if (jstH(w) >= 22) break;
            const lc = lastBefore(cArr, w); if (lc == null || w - lc > CACHE_WARM_DEFAULTS.quietMinutes * 60e3) break;
            pol += (Sbrain + Pv) * PR.read / 1e6; warms++; lastTouch = w;
          }
        }
        const g = (t - lastTouch) / 60e3;
        if (sw.on) { onDays.add(c + jstDay(t)); pol += (g <= 60 && jstDay(lastTouch) === jstDay(t) ? q * Pv * PR.read + (1 - q) * Pv * PR.w1h : Pv * PR.w1h) / 1e6; }
        else pol += (g <= 5 ? q * Pv * PR.read + (1 - q) * Pv * PR.w5 : Pv * PR.w5) / 1e6;
        lastTouch = t; prevT = t; prevOn = sw.on;
      }
    }
    return { net: (base - pol) / span, on: onDays.size / span, warms: warms / span };
  };
  console.log("③ 閾値 N ごとの1日の損得（今の 5分 → ON の会話だけ 1h＋55分ごとの温め・静か120分で止める）");
  for (const [Pv, q, label] of [[Pmed, qMeasured, "今の実測"], [Pmed, 0.9, "q=0.9"], [8000, 0.9, "ブロック 8k・q=0.9（並べ替えた場合の仮定）"]] as Array<[number, number, string]>) {
    const line = [6, 10, 15, 20, 30].map((N) => { const r = sim(N, Pv, q); return `N=${N}: ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(3)}（ON ${r.on.toFixed(1)}人・温め ${r.warms.toFixed(1)}回）`; }).join("／");
    console.log(`  [${label}・P=${Pv}・q=${q.toFixed(2)}] ${line}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
