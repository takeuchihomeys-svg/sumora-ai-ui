// 「内覧したい」の番を、内覧を希望されたお部屋が退去予定か（viewing-check-first.viewingRoomVacating）で分けて、スタッフの最初の一手を数える（読み取りのみ・LLM 0）
// 2026-10-07 6巡目（竹内さん「１退去予定ではない場合は内覧誘導する」）: 確認を挟むのは退去予定のお部屋だけ、の線を実データで確かめる。
//   番の取り方・最初の一手の分け方は scripts/audit-viewing-wish-first-step.ts と同じ（申込以降・YUMA・身内は除く・同じ会話の同じ時間は1番）。
//   退去予定の判定は本番（brain-core）と同じ3つ: 台帳（property-thread の確認の結果・今の番のお部屋）／資料の退去予定日（property-send-state）／会話の退去予定の話（move-out-context）
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-wish-vacating.ts [--days=180] [--show=vacating|confirm|all] [--no-thread]
import { createClient } from "@supabase/supabase-js";
import { appendFileSync, writeFileSync } from "node:fs";
import { customerWishes, classifyCustomerDateReply } from "../app/lib/viewing-flow";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { classifyViewingFirstStep, viewingRoomVacating, threadRoomCheckForTurn, otherRoomSentAfterMoveOut, type MoveOutReason } from "../app/lib/viewing-check-first";
import { MOVE_OUT_PATTERN } from "../app/lib/move-out-context";
import { buildingKeyOf } from "../app/lib/customer-state";
import { moveOutViewingVerdict } from "../app/lib/move-out-context";
import { resolveBrainPropertyState } from "../app/lib/property-send-state";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 180);
const SHOW = (process.argv.find((a) => a.startsWith("--show="))?.slice(7) ?? "").split(",").filter(Boolean);
const NO_THREAD = process.argv.includes("--no-thread");
const JSONL = process.argv.find((a) => a.startsWith("--jsonl="))?.slice(8) ?? "";
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const skip = new Set<string>(TEST_CONVERSATION_IDS);
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
const one = (s: string | null | undefined, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const loadPropertyThreads = NO_THREAD ? null : (await import("../app/lib/property-thread-server")).loadPropertyThreads;
  const cand = await all<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").eq("sender", "customer").gte("created_at", since)
    .or("text.ilike.%内覧%,text.ilike.%内見%,text.ilike.%見学%,text.ilike.%見に%,text.ilike.%みに%").order("created_at").range(a, b));
  const wish = cand.filter((m) => !skip.has(m.conversation_id) && !/^\s*\[画像\]/.test(m.text ?? "") && customerWishes(m.text ?? ""));
  const applied = new Map<string, string>();
  const convs = [...new Set(wish.map((w) => w.conversation_id))];
  for (let i = 0; i < convs.length; i += 100) {
    const r = await sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", convs.slice(i, i + 100)).eq("aix_type", "application_push").order("created_at");
    for (const x of (r.data ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!applied.has(x.conversation_id)) applied.set(x.conversation_id, x.created_at);
  }
  if (JSONL) writeFileSync(JSONL, "");
  const seen = new Set<string>();
  const tally = new Map<string, Record<string, number>>();
  const add = (k: string, v: string) => { const t = tally.get(k) ?? {}; t[v] = (t[v] ?? 0) + 1; tally.set(k, t); };
  const whyCount = new Map<string, number>();
  for (const w of wish) {
    const ap = applied.get(w.conversation_id);
    if (ap && Date.parse(ap) <= Date.parse(w.created_at)) continue;
    const key = `${w.conversation_id}:${w.created_at.slice(0, 13)}`;
    if (seen.has(key)) continue; seen.add(key);
    const t0 = Date.parse(w.created_at);
    const [{ data: after }, { data: aix }, { data: before }] = await Promise.all([
      sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", w.conversation_id).gt("created_at", w.created_at).lt("created_at", new Date(t0 + 6 * 3600_000).toISOString()).order("created_at").limit(30),
      sb.from("aix_usage_logs").select("aix_type, created_at, sent_at").eq("conversation_id", w.conversation_id).gt("created_at", w.created_at).lt("created_at", new Date(t0 + 6 * 3600_000).toISOString()).not("sent_at", "is", null).order("created_at").limit(10),
      sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", w.conversation_id).lte("created_at", w.created_at).order("created_at", { ascending: false }).limit(15),
    ]);
    const msgs = (after ?? []) as Msg[];
    const staff = msgs.filter((m) => m.sender !== "customer");
    const firstAt = staff[0]?.created_at ?? null;
    const win = staff.filter((m) => firstAt && Date.parse(m.created_at) - Date.parse(firstAt) < 30 * 60_000).map((m) => m.text ?? "");
    const aixWin = ((aix ?? []) as Array<{ aix_type: string; created_at: string }>).filter((x) => firstAt && Date.parse(x.created_at) - Date.parse(firstAt) < 30 * 60_000).map((x) => x.aix_type);
    const step = firstAt ? classifyViewingFirstStep(win, aixWin) : "none";
    const dr = classifyCustomerDateReply(w.text ?? "", { atMs: t0, offeredDays: [], inFlow: false });
    const hasDate = dr.kind === "date_time" || dr.kind === "day_only" || dr.kind === "day_pick";
    // 本番の brain-core と同じ並び（新しい順・直近15通）
    const newest = ((before ?? []) as Msg[]).map((m) => ({ sender: m.sender, text: m.text }));
    const mo = moveOutViewingVerdict(newest, "newest_first");
    const ps = resolveBrainPropertyState({ messages: [...newest].reverse(), viewingReleased: mo.reason === "viewing_offered", nowMs: t0 });
    let threadCheck: ReturnType<typeof threadRoomCheckForTurn> = null;
    let otherRoomSentAfter = false;
    if (loadPropertyThreads) {
      const pt = await loadPropertyThreads(w.conversation_id, { asOf: w.created_at });
      threadCheck = threadRoomCheckForTurn(pt);
      const moMsg = ((before ?? []) as Msg[]).find((m) => m.sender !== "customer" && MOVE_OUT_PATTERN.test(m.text ?? ""));
      otherRoomSentAfter = otherRoomSentAfterMoveOut(pt?.rooms ?? null, moMsg?.created_at ?? null, moMsg ? buildingKeyOf(moMsg.text ?? "") : null);
    }
    const v = viewingRoomVacating({ threadCheck, notViewable: ps.notViewable, moveOutReason: mo.reason as MoveOutReason, otherRoomSentAfter });
    whyCount.set(v.why, (whyCount.get(v.why) ?? 0) + 1);
    // 再生（scripts/yuma-r6-replay.ts --src=path:<jsonl>）の材料: 人の最初の一手を道に（候補日・待ち合わせ＝AIX・確認の約束・他＝返信）
    if (JSONL && firstAt) appendFileSync(JSONL, JSON.stringify({ conv: w.conversation_id, at: w.created_at, scene: "viewing", staff: step === "invite" ? ["viewing_invite"] : step === "meeting" ? ["meeting_place"] : ["reply"], staffCp: [], staffText: win.join("\n"), step, vacating: v.vacating, why: v.why, dateKind: dr.kind }) + "\n");
    const vk = v.vacating ? "退去予定" : "今見られる";
    add(`${vk}`, step);
    add(`${vk}・日時${hasDate ? "あり" : "なし"}`, step);
    if (SHOW.includes(step) || SHOW.includes("all") || (SHOW.includes("vacating") && v.vacating)) console.log(`${step.padEnd(7)} ${vk} 日時${hasDate ? "○" : "×"} [${v.why}] ${w.conversation_id.slice(0, 8)} ${w.created_at.slice(0, 16)} 客「${one(w.text, 60)}」→ 店「${one(win.join(" / "), 100)}」${aixWin.length ? ` AIX=${aixWin.join(",")}` : ""}`);
  }
  console.log(`\n番 ${seen.size}（申込以降・YUMA を除く・同じ会話の同じ時間は1番）`);
  for (const [k, v] of [...tally.entries()].sort()) {
    const n = Object.values(v).reduce((a, b) => a + b, 0);
    const ci = (v.confirm ?? 0), iv = (v.invite ?? 0) + (v.meeting ?? 0);
    console.log(`  ${k.padEnd(18)} n=${String(n).padStart(3)}  ${["confirm", "invite", "meeting", "other", "none"].map((s) => `${s} ${v[s] ?? 0}`).join("・")}  ｜確認/(確認+候補日・待ち合わせ) ${ci + iv ? Math.round((100 * ci) / (ci + iv)) : 0}%`);
  }
  console.log("\n判定の理由:"); for (const [k, n] of [...whyCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)} ${k}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
