// scripts/audit-staff-info-capture.ts — スタッフしか知らない事が AIX の入力からブレインの材料に届いているか（読み取りのみ・LLM なし・$0）
//   2026-10-14 竹内さん「取りこぼしがないよう設計すれば完全に理解できるようになる」（設計知見 37af1885）
//
// 数える物:
//   A 物件確認した → 別の部屋: ①上の「別の部屋が募集してた」（check_pattern=alternative）②物件カードの「別の部屋」（prop_statuses=alternative）
//     ③「別の部屋について確認した」（other_room_check）。記録に別の部屋の名前があるか・次のブレインの判断の今の物件（digest.prop）がその部屋か
//   B 内覧後の挨拶（greeting_viewing・app_sub_mode=after*）: 内覧の内容（viewing_history.viewing_report）が入っているか・
//     入った時刻が挨拶の生成の後か（生成の文に届かない）
//   C 電話終了後（phone_followup）: 電話の内容（スタッフのメモ）が残っているか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-info-capture.ts [--days=90] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { brainNameMatchesAny } from "../app/lib/property-name-loose";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "90"));
const SHOW = Number(arg("show", "10"));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const one = (s: unknown, n = 80) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type Log = {
  id: string; conversation_id: string; aix_type: string; check_pattern: string | null; app_sub_mode: string | null;
  property_names: string[] | null; prop_statuses: string[] | null; picker_choices: Record<string, unknown> | null;
  sent_at: string | null; created_at: string; generated_text: string | null;
};
type Dec = { conversation_id: string; created_at: string; prop: string | null };

async function main() {
  const logs = await pageAll<Log>((a, b) => sb.from("aix_usage_logs")
    .select("id, conversation_id, aix_type, check_pattern, app_sub_mode, property_names, prop_statuses, picker_choices, sent_at, created_at, generated_text")
    .in("aix_type", ["property_check_result", "greeting_viewing", "phone_followup"]).gte("created_at", since).order("created_at").range(a, b));
  const convIds = [...new Set(logs.map((l) => l.conversation_id).filter(Boolean))];
  const decs: Dec[] = [];
  for (let i = 0; i < convIds.length; i += 100) {
    decs.push(...await pageAll<Dec>((a, b) => sb.from("brain_decision_logs").select("conversation_id, created_at, prop:digest->>prop")
      .in("conversation_id", convIds.slice(i, i + 100)).gte("created_at", since).order("created_at").range(a, b)));
  }
  const decBy = new Map<string, Dec[]>();
  for (const d of decs) { const a = decBy.get(d.conversation_id) ?? []; a.push(d); decBy.set(d.conversation_id, a); }
  const nextDec = (conv: string, at: string) => (decBy.get(conv) ?? []).find((d) => ms(d.created_at) > ms(at) && ms(d.created_at) - ms(at) <= 7 * 86400_000) ?? null;

  // ── A 別の部屋 ──
  const pc = logs.filter((l) => l.aix_type === "property_check_result");
  const altTop = pc.filter((l) => l.check_pattern === "alternative");
  const altCard = pc.filter((l) => (l.prop_statuses ?? []).some((s) => s === "alternative"));
  const otherRoom = pc.filter((l) => l.check_pattern === "other_room_check");
  console.log(`\n=== A 物件確認した → 別の部屋（${days}日・物件確認した ${pc.length}番） ===`);
  const rep = (label: string, rows: Log[], namesOf: (l: Log) => string[]) => {
    let withName = 0, withDec = 0, hit = 0;
    const misses: string[] = [];
    for (const l of rows) {
      const names = namesOf(l).filter(Boolean);
      if (names.length) withName++;
      const d = nextDec(l.conversation_id, l.sent_at ?? l.created_at);
      if (!d) continue;
      withDec++;
      if (names.length && brainNameMatchesAny(d.prop, names)) hit++;
      else if (misses.length < SHOW) misses.push(`  ${l.conversation_id.slice(0, 8)} ${one(l.sent_at ?? l.created_at, 16)} 記録=${names.join("|") || "（名前なし）"} → ブレイン=${d.prop ?? "なし"}`);
    }
    console.log(`${label}: ${rows.length}番・記録に別の部屋の名前 ${withName}・次のブレインの判断あり ${withDec}・今の物件がその部屋 ${hit}`);
    for (const m of misses) console.log(m);
  };
  rep("① 上の「別の部屋が募集してた」", altTop, (l) => l.property_names ?? []);
  rep("② 物件カードの「別の部屋」", altCard, (l) => (l.property_names ?? []).filter((_, i) => l.prop_statuses?.[i] === "alternative"));
  rep("③ 別の部屋について確認した", otherRoom, (l) => l.property_names ?? []);

  // 前後: 次のお客様の発言の時点の台帳（ブレイン・返信の材料）に別の部屋が届くか（STAFF_CAPTURE_ALTERNATIVE=off＝前）
  {
    const { loadPropertyThreads } = await import("../app/lib/property-thread-server");
    const { buildPropertyThreadNote } = await import("../app/lib/property-thread");
    let n = 0; const cnt = { before: { ev: 0, note: 0, turn: 0 }, after: { ev: 0, note: 0, turn: 0 } };
    for (const l of altCard) {
      const alts = (l.property_names ?? []).filter((_, i) => l.prop_statuses?.[i] === "alternative");
      const at = l.sent_at ?? l.created_at;
      const { data: nx } = await sb.from("messages").select("created_at").eq("conversation_id", l.conversation_id).eq("sender", "customer").gt("created_at", at).order("created_at").limit(1);
      const asOf = (nx?.[0] as { created_at?: string } | undefined)?.created_at ?? new Date(ms(at) + 3600_000).toISOString();
      n++;
      for (const mode of ["before", "after"] as const) {
        process.env.STAFF_CAPTURE_ALTERNATIVE = mode === "before" ? "off" : "";
        const s = await loadPropertyThreads(l.conversation_id, { asOf });
        if (!s) continue;
        const room = s.rooms.find((r) => brainNameMatchesAny(r.ref.display, alts));
        if (room?.events.some((e) => e.kind === "check_alternative" || e.kind === "check_available")) cnt[mode].ev++;
        const note = buildPropertyThreadNote(s);
        if (mode === "after" && process.argv.includes("--debug")) console.log(`    ${l.conversation_id.slice(0, 8)} 材料の文 ${note.length}字 ${alts.join("|")} 載る=${alts.some((a) => note.includes(a.replace(/\s*\d+号室$/, "")))}`);
        if (alts.some((a) => note.includes(a.replace(/\s*\d+号室$/, ""))) && /別の部屋が募集中/.test(note)) cnt[mode].note++;
        const cands = [...s.turnTargets.map((x) => x.display), ...(s.turnReferent ? JSON.stringify(s.turnReferent).match(/"display":"[^"]+"/g) ?? [] : [])].join(" ");
        if (alts.some((a) => cands.includes(a.replace(/\s*\d+号室$/, "")))) cnt[mode].turn++;
      }
    }
    delete process.env.STAFF_CAPTURE_ALTERNATIVE;
    console.log(`  前後（物件カードの「別の部屋」${n}番・次のお客様の発言の時点の台帳）: 台帳に募集中の出来事 ${cnt.before.ev}→${cnt.after.ev}・材料の文に「別の部屋が募集中」${cnt.before.note}→${cnt.after.note}・今の番の物件の候補 ${cnt.before.turn}→${cnt.after.turn}`);
  }

  // ── B 内覧後の挨拶 ──
  const gvAfter = logs.filter((l) => l.aix_type === "greeting_viewing" && String(l.app_sub_mode ?? "").startsWith("after"));
  const gvConv = [...new Set(gvAfter.map((l) => l.conversation_id))];
  type VH = { conversation_id: string; viewing_report: string | null; viewing_report_at: string | null };
  const vh: VH[] = [];
  for (let i = 0; i < gvConv.length; i += 100) {
    vh.push(...await pageAll<VH>((a, b) => sb.from("viewing_history").select("conversation_id, viewing_report, viewing_report_at")
      .in("conversation_id", gvConv.slice(i, i + 100)).not("viewing_report", "is", null).range(a, b)));
  }
  let gvWith = 0, gvBeforeSend = 0;
  for (const l of gvAfter) {
    const at = ms(l.sent_at ?? l.created_at);
    const r = vh.filter((v) => v.conversation_id === l.conversation_id && Math.abs(ms(v.viewing_report_at) - at) <= 86400_000);
    if (r.length) { gvWith++; if (r.some((v) => ms(v.viewing_report_at) <= at)) gvBeforeSend++; }
  }
  console.log(`\n=== B 内覧後の挨拶（${gvAfter.length}番） ===`);
  console.log(`内覧の内容あり（±1日）: ${gvWith}・送る前に保存済み: ${gvBeforeSend}・内容なし: ${gvAfter.length - gvWith}`);
  const subModes = new Map<string, number>();
  for (const l of gvAfter) subModes.set(String(l.app_sub_mode), (subModes.get(String(l.app_sub_mode)) ?? 0) + 1);
  console.log(`  ピッカー: ${[...subModes.entries()].map(([k, v]) => `${k}=${v}`).join("・")}`);

  // ── C 電話終了後 ──
  const pf = logs.filter((l) => l.aix_type === "phone_followup");
  const pfNotes = pf.filter((l) => l.picker_choices && typeof l.picker_choices === "object" && String((l.picker_choices as Record<string, unknown>).call_notes ?? "").trim());
  console.log(`\n=== C 電話終了後（${pf.length}番） ===`);
  console.log(`電話の内容（スタッフのメモ）が残っている: ${pfNotes.length}・送った文だけ: ${pf.length - pfNotes.length}`);
  const calls = await pageAll<{ conversation_id: string; text: string | null }>((a, b) => sb.from("messages").select("conversation_id, text")
    .like("text", "[通話リクエスト]%").gte("created_at", since).range(a, b));
  console.log(`電話をかけるボタンを送った: ${calls.length}回（${new Set(calls.map((c) => c.conversation_id)).size}会話）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
