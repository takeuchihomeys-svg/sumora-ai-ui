// app/lib/cron-chain.ts — 既にある1本の cron の後ろから、別の cron の処理を順に呼ぶ（同じ関数の中・Authorization をそのまま渡す）
//
// 2026-11-15 作業員H（統括役の頼み: vercel.json の cron が上限 100本に達した・今後は cron を足さない）:
//   毎朝の数え（読むだけ・LLM なし）の cron を1本ずつ持つと枠が足りない。宿の cron（例 prod-yardstick・JST 1:10）の後ろで、
//   子の cron の GET を順に呼ぶ（子の route は今のまま・単独でも呼べる）。子ごとの結果（ok・ms・要約）を宿の結果に残す。
//   既定の動きは変えない: CRON_CHAIN_<宿の名前>=on の時だけ子を呼ぶ（既定 off）。on で数えが残るのを確かめてから、vercel.json の子の行を外して枠を空ける。
//   子の時間: 宿の maxDuration の残りから、子ごとに budgetMs まで（越えたら次の子に進む・子は自分の cron_run_logs を書く）。
// テスト: app/lib/__tests__/cron-chain.test.ts
import { NextRequest } from "next/server";
type Env = Record<string, string | undefined>;
export type ChainStep = { name: string; run: (req: NextRequest) => Promise<Response> };
export type ChainResult = { name: string; ok: boolean; status: number | null; ms: number; summary: string | null; error: string | null };

export function cronChainOn(host: string, env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const k = `CRON_CHAIN_${host.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return (env[k] ?? "").trim().toLowerCase() === "on";
}

/** 子を順に呼ぶ（1つの子の失敗・時間切れで止めない）。req は宿が受けた物（Authorization を写す） */
export async function runCronChain(req: Request, steps: ReadonlyArray<ChainStep>, o: { budgetMs?: number; deadlineMs?: number; now?: () => number } = {}): Promise<ChainResult[]> {
  const now = o.now ?? Date.now;
  const out: ChainResult[] = [];
  const auth = req.headers.get("authorization") ?? "";
  for (const s of steps) {
    const t0 = now();
    if (o.deadlineMs && t0 >= o.deadlineMs) { out.push({ name: s.name, ok: false, status: null, ms: 0, summary: null, error: "宿の時間の残りが無い（次の朝に回る・子の cron を単独で呼べば動く）" }); continue; }
    const budget = Math.max(1000, Math.min(o.budgetMs ?? 110_000, o.deadlineMs ? o.deadlineMs - t0 : Infinity));
    const childUrl = new URL(req.url);
    childUrl.pathname = `/api/cron/${s.name}`;
    childUrl.search = "";
    const child = new NextRequest(childUrl.toString(), { method: "GET", headers: { authorization: auth } });
    try {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const res = await Promise.race([s.run(child), new Promise<null>((r) => { timer = setTimeout(() => r(null), budget); })]).finally(() => { if (timer) clearTimeout(timer); });
      if (!res) { out.push({ name: s.name, ok: false, status: null, ms: now() - t0, summary: null, error: `${budget}ms で時間切れ（子は裏で続く事がある）` }); continue; }
      let j: Record<string, unknown> | null = null;
      try { j = (await res.json()) as Record<string, unknown>; } catch { j = null; }
      out.push({ name: s.name, ok: res.ok && j?.ok !== false, status: res.status, ms: now() - t0, summary: typeof j?.summary === "string" ? j.summary.slice(0, 300) : (typeof j?.skipped === "string" ? `skipped: ${j.skipped}` : null), error: typeof j?.error === "string" ? j.error.slice(0, 200) : null });
    } catch (e) {
      out.push({ name: s.name, ok: false, status: null, ms: now() - t0, summary: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  return out;
}
