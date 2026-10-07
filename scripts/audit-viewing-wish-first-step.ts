// 「内覧したい」の番でスタッフが最初に何をしたか（読み取りのみ・LLM 0）
// 2026-10-07 5巡目（竹内さん「内覧できるか確認」）: 内覧の依頼には、まず「内覧できるか確認」を挟む（内覧可能かの確認の約束→確認後に AIX【内覧調整】）。
//   今日の決め「お客様が日時を指定・変更した時は AIX【内覧調整】を直接」と両立させる線を、実データで引く。
//   番＝お客様の内覧の希望（viewing-flow.customerWishes）を含む連投（申込以降・YUMA・身内は除く）。日時の指定の有無（classifyCustomerDateReply）×
//   内覧の流れの段階（その時点）× スタッフの最初の返し（6時間・同じ30分のまとまり）:
//     confirm … 内覧可能か（ご内覧可否）を確認する約束の手打ち
//     invite  … AIX【内覧調整】／手打ちの候補日・ご都合の打診
//     meeting … AIX【待ち合わせ場所】
//     other   … それ以外（質問への答え・物件の送付 等）／none … 返し無し
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-wish-first-step.ts [--days=180] [--show=confirm,invite]
import { createClient } from "@supabase/supabase-js";
import { customerWishes, classifyCustomerDateReply } from "../app/lib/viewing-flow";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { classifyViewingFirstStep, VIEWING_CHECK_PROMISE_RE } from "../app/lib/viewing-check-first";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 180);
const SHOW = (process.argv.find((a) => a.startsWith("--show="))?.slice(7) ?? "").split(",").filter(Boolean);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const testSet = new Set(TEST_CONVERSATION_IDS);
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
const RECENT_OK_RE = /現在募集中|募集中となります|ご案内可能|ご内覧可能|内見可能|即日|退去済|空室/;
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
  const cand = await all<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").eq("sender", "customer").gte("created_at", since)
    .or("text.ilike.%内覧%,text.ilike.%内見%,text.ilike.%見学%,text.ilike.%見に%,text.ilike.%みに%").order("created_at").range(a, b));
  const wish = cand.filter((m) => !testSet.has(m.conversation_id) && !/^\s*\[画像\]/.test(m.text ?? "") && customerWishes(m.text ?? ""));
  const applied = new Map<string, string>();
  const convs = [...new Set(wish.map((w) => w.conversation_id))];
  for (let i = 0; i < convs.length; i += 100) {
    const r = await sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", convs.slice(i, i + 100)).eq("aix_type", "application_push").order("created_at");
    for (const x of (r.data ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!applied.has(x.conversation_id)) applied.set(x.conversation_id, x.created_at);
  }
  const seen = new Set<string>();
  const tally = new Map<string, Record<string, number>>();
  const add = (k: string, v: string) => { const t = tally.get(k) ?? {}; t[v] = (t[v] ?? 0) + 1; tally.set(k, t); };
  for (const w of wish) {
    const ap = applied.get(w.conversation_id);
    if (ap && Date.parse(ap) <= Date.parse(w.created_at)) continue;
    const key = `${w.conversation_id}:${w.created_at.slice(0, 13)}`;
    if (seen.has(key)) continue; seen.add(key);
    const t0 = Date.parse(w.created_at);
    const [{ data: after }, { data: aix }, { data: before }] = await Promise.all([
      sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", w.conversation_id).gt("created_at", w.created_at).lt("created_at", new Date(t0 + 6 * 3600_000).toISOString()).order("created_at").limit(30),
      sb.from("aix_usage_logs").select("aix_type, created_at, sent_at").eq("conversation_id", w.conversation_id).gt("created_at", w.created_at).lt("created_at", new Date(t0 + 6 * 3600_000).toISOString()).not("sent_at", "is", null).order("created_at").limit(10),
      sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", w.conversation_id).lt("created_at", w.created_at).order("created_at", { ascending: false }).limit(20),
    ]);
    const msgs = (after ?? []) as Msg[];
    const staff = msgs.filter((m) => m.sender !== "customer");
    const firstAt = staff[0]?.created_at ?? null;
    const win = staff.filter((m) => firstAt && Date.parse(m.created_at) - Date.parse(firstAt) < 30 * 60_000).map((m) => m.text ?? "");
    const aixWin = ((aix ?? []) as Array<{ aix_type: string; created_at: string }>).filter((x) => firstAt && Date.parse(x.created_at) - Date.parse(firstAt) < 30 * 60_000).map((x) => x.aix_type);
    const step = firstAt ? classifyViewingFirstStep(win, aixWin) : "none";
    const dr = classifyCustomerDateReply(w.text ?? "", { atMs: t0, offeredDays: [], inFlow: false });
    const hasDate = dr.kind === "date_time" || dr.kind === "day_only" || dr.kind === "day_pick";
    const prevStaff = ((before ?? []) as Msg[]).filter((m) => m.sender !== "customer").map((m) => m.text ?? "");
    const vacatePending = prevStaff.some((t) => /退去予定|入居中|居住中|退去後/.test(t));
    const confirmedBefore = prevStaff.some((t) => /内覧可能|ご内覧可能|内見可能|ご案内可能/.test(t));
    add(`日時${hasDate ? "あり" : "なし"}`, step);
    add(`日時の形=${dr.kind}`, step);
    const prevAll = ((before ?? []) as Msg[]);
    const recentConfirm = prevAll.some((m) => m.sender !== "customer" && t0 - Date.parse(m.created_at) <= 72 * 3600_000 && RECENT_OK_RE.test(m.text ?? ""));
    const hourJst = (new Date(t0).getUTCHours() + 9) % 24;
    const afterHours = hourJst >= 19 || hourJst < 10;
    add(`日時${hasDate ? "あり" : "なし"}・72h以内に募集中/案内可能=${recentConfirm ? "済" : "未"}`, step);
    add(`日時${hasDate ? "あり" : "なし"}・管理会社の時間外(19-10時)=${afterHours ? "外" : "内"}`, step);
    add(`日時${hasDate ? "あり" : "なし"}・72h確認${recentConfirm ? "済" : "未"}×時間${afterHours ? "外" : "内"}`, step);
    add(`日時${hasDate ? "あり" : "なし"}・前に内覧可能を伝えた=${confirmedBefore ? "済" : "未"}`, step);
    if (vacatePending) add(`日時${hasDate ? "あり" : "なし"}・退去予定/入居中の話あり`, step);
    if (SHOW.includes(step) || SHOW.includes("all")) console.log(`${step.padEnd(7)} 日時${hasDate ? "○" : "×"}${confirmedBefore ? " 可能済" : ""} ${w.conversation_id.slice(0, 8)} ${w.created_at.slice(0, 16)} 客「${one(w.text, 60)}」→ 店「${one(win.join(" / "), 90)}」${aixWin.length ? ` AIX=${aixWin.join(",")}` : ""}`);
  }
  console.log(`\n番 ${seen.size}（申込以降・YUMA・身内を除く・同じ会話の同じ時間は1番）`);
  for (const [k, v] of [...tally.entries()].sort()) {
    const n = Object.values(v).reduce((a, b) => a + b, 0);
    console.log(`  ${k.padEnd(28)} n=${n}  ${["confirm", "invite", "meeting", "other", "none"].map((s) => `${s} ${v[s] ?? 0}`).join("・")}`);
  }
  void VIEWING_CHECK_PROMISE_RE;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
