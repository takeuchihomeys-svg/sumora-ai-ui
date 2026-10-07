// scripts/audit-property-thread.ts — 物件ごとの状況の台帳（app/lib/property-thread.ts）を本番の番に当てて読む（読み取りのみ・LLM なし）
//
// 2026-10-07 竹内（S❤ 事例）。見張りの番（line_watch_turns）のうち、お客様の今の番が物件の話（引用・名指し）になった番で、
//   台帳が「今の番の物件」をどれと読んだか・スタッフの実送信に出た物件名と合うか・AI の下書きの物件名と合うかを数える。
//   --conv=<id8> --at=<ISO> で1番だけ台帳の文を出す（S❤: --conv=d3a56a97 --at=2026-10-06T16:25:00Z）
// 実行: npx tsx --env-file=.env.local scripts/audit-property-thread.ts [--days=14] [--detail] | [--conv=.. --at=..]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const one = (s: string, n = 140) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);

async function main() {
  const { loadPropertyThreads } = await import("../app/lib/property-thread-server");
  const { buildPropertyThreadNote } = await import("../app/lib/property-thread");
  const { buildingKeyOf } = await import("../app/lib/customer-state");
  const nk = (s: string) => buildingKeyOf(s);
  const conv = arg("conv");
  if (conv) {
    const { data } = await sb.from("conversations").select("id").like("id", `${conv}%`).limit(1);
    const id = data?.[0]?.id as string;
    const s = await loadPropertyThreads(id, { asOf: arg("at") || null });
    if (!s) { console.log("読めない"); return; }
    for (const r of s.rooms) console.log(`- ${r.ref.display}${r.names.length > 1 ? `（${r.names.join("・")}）` : ""}: ${r.events.map((e) => `${e.kind}${e.topic ? `/${e.topic}` : ""}${e.by === "inferred" ? "(推定)" : ""}`).join(" → ")}`);
    console.log("\n" + (buildPropertyThreadNote(s) || "（今の番は物件の話ではない＝材料なし）"));
    return;
  }
  const days = Number(arg("days", "14"));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: turns } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, scene_key, draft_first, draft_last, staff_texts, verdict, verdict_detail")
    .gte("customer_turn_at", since).order("customer_turn_at").limit(1000);
  let n = 0, withNote = 0, staffHas = 0, staffAgree = 0, draftHas = 0, draftAgree = 0, draftWrongStaffRight = 0;
  for (const t of turns ?? []) {
    if (t.conversation_id === YUMA || String(t.scene_key ?? "").startsWith("対象外")) continue;
    n++;
    const s = await loadPropertyThreads(t.conversation_id, { asOf: new Date(Date.parse(t.customer_last_at ?? t.customer_turn_at) + 1000).toISOString() });
    if (!s || !s.turnTargets.length) continue;
    withNote++;
    const target = s.rooms.find((r) => r.key === s.turnTargets.at(-1)!.roomKey)!;
    const others = s.rooms.filter((r) => r !== target);
    const staff = (Array.isArray(t.staff_texts) ? t.staff_texts : []).map((x: { text?: string } | string) => (typeof x === "string" ? x : x?.text ?? "")).join("\n");
    const pick = (x: unknown) => { const v = String(x ?? ""); return /^__\w+__$/.test(v.trim()) ? "" : v; };
    const draft = pick(t.draft_last) || pick(t.draft_first);
    const mentions = (txt: string, r: typeof target) => nk(txt).includes(r.ref.buildingKey);
    const sT = mentions(staff, target), sO = others.some((r) => mentions(staff, r));
    const dT = mentions(draft, target), dO = others.some((r) => mentions(draft, r));
    if (sT || sO) { staffHas++; if (sT) staffAgree++; }
    if (dT || dO) { draftHas++; if (dT && !dO) draftAgree++; }
    if (sT && dO && !dT) draftWrongStaffRight++;
    if (process.argv.includes("--detail")) {
      console.log(`#${t.id} ${t.conversation_id.slice(0, 8)} ${t.customer_turn_at.slice(5, 16)} 台帳=${target.ref.display}（${s.turnTargets.map((x) => `${x.topic}/${x.by}`).join(",")}） スタッフ=${sT ? "同じ" : sO ? "別" : "名前なし"} 下書き=${dT ? "同じ" : dO ? "別" : "名前なし"}`);
      if ((sO && !sT) || (dO && !dT)) { console.log(`   下書き: ${one(draft)}\n   スタッフ: ${one(staff)}`); }
    }
  }
  console.log(`\n${days}日 ${n}番: 台帳が今の番を物件の話と読んだ ${withNote}`);
  console.log(`  スタッフの文に物件名あり ${staffHas} → 台帳の物件と同じ ${staffAgree}`);
  console.log(`  下書きに物件名あり ${draftHas} → 台帳の物件だけ ${draftAgree}・下書きが別の物件でスタッフは台帳の物件 ${draftWrongStaffRight}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
