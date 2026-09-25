// scripts/backfill-candidate-facts.ts
// 候補の記録を後から太くする（埋め戻し）。既定は数えるだけ（--apply で書く）。
//
// 2026-09-25 竹内「候補の記憶を太くする」
//   ① property_candidate_pools（facts_version が NULL の古い行）: 1件ごとに enrichCandidate（管理費＝家賃の読み違いを捨てる・
//      生の文字があれば読む）＋同じお客様・同じ時刻の売上サポの行（property_pickups の説明文・資料の文字層・🌟）で空いている所を埋め、
//      facts_version / enriched_at を付ける。既存の鍵の値は変えない（管理費＝家賃・範囲外の家賃・12ヶ月超の AD だけ捨てる）
//   ② --snapshots: 🌟の送信（messages）で recommendation_snapshots に行が無い物を、送った時点の候補一覧として足す（source='backfill'）
//
// 実行: npx tsx --env-file=.env.local scripts/backfill-candidate-facts.ts [--days=60] [--apply] [--snapshots]
import { createClient } from "@supabase/supabase-js";
import { FACTS_VERSION, clipRawForStorage, type CandidateFacts } from "../app/lib/candidate-facts";
import { fillPoolFromPickups, buildRecommendationSnapshot } from "../app/lib/recommendation-snapshot-server";
import { isGenericBuildingName } from "../app/lib/generic-building-name";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const APPLY = !!args.apply;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}
async function pmap<T>(xs: T[], n: number, f: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < xs.length) await f(xs[next++]); }));
}

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  console.log(`${APPLY ? "【書く】" : "【数えるだけ】"} ${since.slice(0, 10)} 以降`);

  // ① 拡張の回
  const pools = await all((a, b) => sb.from("property_candidate_pools").select("id, sent_at, property_customer_id, candidates").is("facts_version", null).gte("sent_at", since).order("sent_at").range(a, b) as never);
  const pickups = await all((a, b) => sb.from("property_pickups").select("id, batch_id, created_at, rank, property_name, room_no, summary_text, pdf_text, pdf_url, pdf_blob_url, recommended, property_customer_id").gte("created_at", since).range(a, b) as never);
  const pkBy = new Map<string, Row[]>();
  for (const p of pickups) { const k = String(p.property_customer_id ?? ""); if (!pkBy.has(k)) pkBy.set(k, []); pkBy.get(k)!.push(p); }
  let adminFixed = 0, cands = 0, filledFromPickup = 0, changedPools = 0, written = 0, errors = 0;
  const fieldAdds: Record<string, number> = {};
  const updates: Array<{ id: string; candidates: CandidateFacts[] }> = [];
  for (const p of pools) {
    const raw = (Array.isArray(p.candidates) ? p.candidates : []) as Row[];
    const r = fillPoolFromPickups({ sent_at: p.sent_at, candidates: raw }, pkBy.get(String(p.property_customer_id ?? "")) ?? []);
    filledFromPickup += r.filled;
    const out = r.candidates.map((c) => clipRawForStorage(c));
    out.forEach((c, i) => {
      cands++;
      if (c.src?.admin_fee_fix) adminFixed++;
      for (const k of Object.keys(c)) if (raw[i][k] == null && c[k] != null && !["src", "facts_v"].includes(k)) fieldAdds[k] = (fieldAdds[k] ?? 0) + 1;
    });
    changedPools++;
    updates.push({ id: p.id, candidates: out });
  }
  console.log(`拡張の回 ${pools.length}回・${cands}件: 管理費＝家賃を捨てた ${adminFixed}・売上サポの行で埋めた ${filledFromPickup}件`);
  console.log(`  足した項目: ${Object.entries(fieldAdds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  if (APPLY) {
    const now = new Date().toISOString();
    await pmap(updates, 6, async (u) => {
      const { error } = await sb.from("property_candidate_pools").update({ candidates: u.candidates, facts_version: FACTS_VERSION, enriched_at: now }).eq("id", u.id);
      if (error) { errors++; if (errors <= 3) console.warn("NG", u.id, error.message); } else written++;
    });
    console.log(`  書いた ${written}/${changedPools}（失敗 ${errors}）`);
  }

  // ② 🌟の候補一覧
  if (args.snapshots) {
    const msgs = await all((a, b) => sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "staff").like("text", "🌟%").gte("created_at", since).order("created_at").range(a, b) as never);
    const have = new Set((await all((a, b) => sb.from("recommendation_snapshots").select("message_id, conversation_id, sent_at").gte("sent_at", since).range(a, b) as never)).map((s) => `${s.message_id ?? ""}`));
    const haveConv = (await all((a, b) => sb.from("recommendation_snapshots").select("conversation_id, sent_at").gte("sent_at", since).range(a, b) as never));
    let built = 0, ins = 0, skip = 0, err = 0;
    await pmap(msgs, 4, async (m) => {
      const head = String(m.text ?? "").split("\n")[0].replace(/^🌟\s*/u, "").trim();
      if (!head || isGenericBuildingName(head) || have.has(m.id) || haveConv.some((s) => s.conversation_id === m.conversation_id && Math.abs(Date.parse(s.sent_at) - Date.parse(m.created_at)) < 120_000)) { skip++; return; }
      const row = await buildRecommendationSnapshot(sb as never, { conversationId: m.conversation_id, sentAt: m.created_at, starText: String(m.text), messageId: m.id, source: "backfill" });
      if (!row) { skip++; return; }
      built++;
      if (APPLY) {
        const { error } = await sb.from("recommendation_snapshots").insert(row);
        if (error) { err++; if (err <= 3) console.warn("NG", m.id, error.message); } else ins++;
      }
    });
    console.log(`🌟の送信 ${msgs.length}通: 組み立てた ${built}・${APPLY ? `書いた ${ins}（失敗 ${err}）・` : ""}飛ばした ${skip}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
