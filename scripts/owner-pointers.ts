// scripts/owner-pointers.ts — 竹内さんの指摘の帳面（owner_pointers）を見る・過去分を埋める（LLM なし・作業員N・2026-11-21・台帳 #472）
//   使い方（鍵のある .env で）:
//     --list [--state=fixing]                 型ごと・状態ごとの数と上位
//     --backfill [--since=2026-11-10T15:00Z] [--dry]   台帳の owner_request の行から埋める（(source, source_ref) で重ならない・何度流しても同じ）
//   お客様の文・名前は入れない（引用は竹内さんの言葉だけ）。
import { createClient } from "@supabase/supabase-js";
import { pointerFromWorkItem, POINTER_KIND_JA, type PointerKind, type WorkItemLite } from "../app/lib/owner-pointers";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

async function backfill() {
  const since = arg("since", "2026-11-10T15:00:00Z");
  const { data, error } = await sb().from("work_items").select("id,title,requested_quote,requested_at,created_at,stage,kb_ids,switch_name,origin").eq("origin", "owner_request").limit(3000);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<WorkItemLite & { origin: string }>).filter((w) => (w.requested_at ?? w.created_at) >= since).map(pointerFromWorkItem);
  const by: Record<string, number> = {};
  for (const r of rows) by[r.kinds[0]] = (by[r.kinds[0]] ?? 0) + 1;
  console.log(`埋める ${rows.length}行（${since} 以降の owner_request）・主の型 ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${POINTER_KIND_JA[k as PointerKind]} ${n}`).join("・")}`);
  if (flag("dry")) return;
  // 一意の索引は部分索引（source_ref が null でない行だけ）なので PostgREST の onConflict に使えない＝先に入っている source_ref を読んで外す
  const { data: have } = await sb().from("owner_pointers").select("source_ref").eq("source", "work_item").limit(5000);
  const seen = new Set(((have ?? []) as Array<{ source_ref: string }>).map((r) => r.source_ref));
  const fresh = rows.filter((r) => !seen.has(r.source_ref));
  for (let i = 0; i < fresh.length; i += 50) {
    const { error: e2 } = await sb().from("owner_pointers").insert(fresh.slice(i, i + 50));
    if (e2) throw new Error(e2.message);
  }
  console.log(`新しく ${fresh.length}行・もう入っていた ${rows.length - fresh.length}行`);
  const { count } = await sb().from("owner_pointers").select("id", { count: "exact", head: true });
  console.log(`入れた（表の行 ${count}）`);
}

async function list() {
  let q = sb().from("owner_pointers").select("id,said_at,quote,kinds,areas,state,work_item_ids").order("said_at", { ascending: false }).limit(2000);
  if (arg("state")) q = q.eq("state", arg("state"));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const by: Record<string, number> = {}, st: Record<string, number> = {};
  for (const r of rows) { by[r.kinds?.[0] ?? "other"] = (by[r.kinds?.[0] ?? "other"] ?? 0) + 1; st[r.state] = (st[r.state] ?? 0) + 1; }
  console.log(`指摘 ${rows.length}行｜状態 ${JSON.stringify(st)}｜主の型 ${JSON.stringify(by)}`);
  for (const r of rows.slice(0, Number(arg("top", "20")) || 20)) console.log(`- P${r.id} [${r.state}] ${String(r.said_at).slice(5, 10)} ${(r.kinds ?? []).join(",")}｜${String(r.quote).slice(0, 60)}｜台帳 ${(r.work_item_ids ?? []).map((x: number) => "#" + x).join(" ")}`);
}

/** 型と分野の決まりが変わった時に、台帳から来た行の kinds・areas だけを分け直す（状態・つなぎは触らない） */
async function reclassify() {
  const { data: ps, error } = await sb().from("owner_pointers").select("id,source_ref,kinds,areas").eq("source", "work_item").limit(5000);
  if (error) throw new Error(error.message);
  const ids = ((ps ?? []) as Array<{ source_ref: string }>).map((p) => Number(p.source_ref)).filter(Boolean);
  const { data: ws } = await sb().from("work_items").select("id,title,requested_quote,requested_at,created_at,stage,kb_ids,switch_name").in("id", ids).limit(5000);
  const byId = new Map(((ws ?? []) as WorkItemLite[]).map((w) => [String(w.id), w]));
  let changed = 0;
  for (const p of (ps ?? []) as Array<{ id: number; source_ref: string; kinds: string[]; areas: string[] }>) {
    const w = byId.get(p.source_ref); if (!w) continue;
    const r = pointerFromWorkItem(w);
    if (JSON.stringify(r.kinds) === JSON.stringify(p.kinds) && JSON.stringify(r.areas) === JSON.stringify(p.areas)) continue;
    if (!flag("dry")) await sb().from("owner_pointers").update({ kinds: r.kinds, areas: r.areas, updated_at: new Date().toISOString() }).eq("id", p.id);
    changed++;
  }
  console.log(`分け直した ${changed}行${flag("dry") ? "（--dry・書いていない）" : ""}`);
}

(async () => {
  if (flag("reclassify")) await reclassify();
  else if (flag("backfill")) await backfill();
  else if (flag("list")) await list();
  else console.log("使い方: --list [--state=] ／ --backfill [--since=] [--dry]");
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
