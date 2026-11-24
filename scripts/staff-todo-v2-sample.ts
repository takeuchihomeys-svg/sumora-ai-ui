// scripts/staff-todo-v2-sample.ts — 【やることリスト】の今の形と新しい形（STAFF_TODO_FORMAT_V2・状況と次の一手は統括ブレインの判断から）を、実際のリストで並べた見本（読むだけ・送らない・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/staff-todo-v2-sample.ts [--people=3] [--at=<ISO>,<ISO>]
//   既定の時刻は昨日と今日の 10:30（JST）。名前は伏せる（頭の1字＋○）。
//   物差し: 1人あたりの字数・行数・重複・状況の1行／統括の欄が空・古い割合／リストのやる事と統括の次の一手の食い違い（link:todo_vs_conductor）と、
//   食い違った会話でスタッフが24時間以内に実際に送った AIX がどちらに合ったか
// 2026-11-24 作業員A（竹内さん 11/24 11:23・「統括ブレインと連携して」・統括役の頼み）
import { createClient } from "@supabase/supabase-js";
import { loadStaffTodoList } from "../app/lib/staff-todo-list-server";
import { renderTodoItem, numberTodoItems, renderCustomerV2, type TodoList, type TodoCustomer } from "../app/lib/staff-todo-list";
import { v2Measure, todoVsConductor, nextStepAixOf, type TodoVsConductor } from "../app/lib/staff-todo-format-v2";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const people = Number(arg("people", "3"));
const jst1030 = (daysAgo: number) => { const now = new Date(Date.now() + 9 * 3600e3); return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 1, 30); };
const ats = arg("at") ? arg("at").split(",").map((x) => Date.parse(x)) : [jst1030(1), jst1030(0)];
const mask = (s: string, c: TodoCustomer) => { const n = (c.name ?? "").trim(); return n && n !== "お客様" ? s.split(n).join(`${Array.from(n)[0]}○`) : s; };
const oldBlock = (list: TodoList, c: TodoCustomer, nums: Map<string, number>) =>
  [`${c.accountLabel}${c.why && c.items.some((i) => !i.doneAt) ? ` ▶${c.why}` : ""}`, ...c.items.map((i) => renderTodoItem(i, list.atMs, nums.get(i.key)))].join("\n");
const open = (c: TodoCustomer) => c.items.filter((i) => !i.doneAt && !i.waiting);

(async () => {
  process.env.STAFF_TODO_FORMAT_V2 = "on"; // 見本のためだけ（このプロセスの中）。本番の既定は off のまま
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const tot = { old: { chars: 0, lines: 0, dup: 0, sit: 0, n: 0 }, v2: { chars: 0, lines: 0, dup: 0, sit: 0, n: 0 } };
  const vs: Record<TodoVsConductor, number> = { match: 0, mismatch: 0, no_conductor: 0, stale: 0, unknown: 0 };
  let emptyField = 0, nCust = 0;
  const mismatches: Array<{ cid: string; at: number; list: string[]; cond: string | null }> = [];
  for (const at of ats) {
    const list = await loadStaffTodoList(sb, at, {});
    const nums = new Map(numberTodoItems(list).map((x) => [x.item.key, x.n]));
    const withTasks = list.customers.filter((c) => open(c).some((i) => i.source !== "target_new_arrival"));
    for (const c of list.customers.filter((x) => open(x).length)) {
      const o = oldBlock(list, c, nums), v = renderCustomerV2(c, list.atMs, nums).join("\n");
      const mo = v2Measure(o), mv = v2Measure(v);
      for (const [k, m] of [["old", mo], ["v2", mv]] as const) { const t = tot[k]; t.chars += m.chars; t.lines += m.lines; t.dup += m.dup; t.sit += m.hasSituation ? 1 : 0; t.n++; }
    }
    for (const c of withTasks) {
      nCust++;
      const cv = c.conductor ?? null;
      if (cv && !cv.stale && !cv.node && !cv.nextSteps.length) emptyField++;
      const r = todoVsConductor(open(c).map((i) => ({ action: i.action, checkPattern: i.checkPattern })), cv);
      vs[r]++;
      if (r === "mismatch") mismatches.push({ cid: c.conversationId, at, list: [...new Set(open(c).map((i) => i.action ?? "reply"))], cond: cv ? nextStepAixOf(cv.nextSteps[0]) : null });
    }
    const pick = withTasks.slice(0, people);
    console.log(`\n══════ ${new Date(at + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")}（JST）の【やることリスト】から ${pick.length}人 ══════`);
    for (const c of pick) {
      const cv = c.conductor ?? null;
      console.log(`\n── 今の形 ──\n${mask(oldBlock(list, c, nums), c)}`);
      console.log(`── 新しい形（状況と次の手は統括から）──\n${mask(renderCustomerV2(c, list.atMs, nums).join("\n"), c)}`);
      console.log(`  〔出所: 見出しの期限＝やる事の期限の一番過ぎた日数／今:＝統括 apply_route${cv?.node ? `（${cv.node}${cv.branch ? `・${cv.branch}` : ""}）` : "（空）"}＋situation_now.promises_open ${cv?.promisesOpen.length ?? 0}件／統括の次の手＝next_steps[0]${cv?.stale ? "（判断が古い＝出さない）" : ""}／①②…＝約束・AIX 要対応の記録（✅ の番号の元）〕`);
    }
  }
  // 食い違った会話で、スタッフが24時間以内に実際に送った AIX（どちらに合ったか・読むだけ）
  let followList = 0, followCond = 0, neither = 0, noSend = 0;
  for (const m of mismatches.slice(0, 60)) {
    const { data } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", m.cid).gte("created_at", new Date(m.at).toISOString()).lte("created_at", new Date(m.at + 86400e3).toISOString()).order("created_at").limit(1);
    const t = (data?.[0] as { aix_type?: string } | undefined)?.aix_type ?? null;
    const norm = (x: string | null) => (x === "property_recommendation" ? "property_send" : x);
    if (!t) noSend++;
    else if (m.list.map(norm).includes(norm(t))) followList++;
    else if (norm(m.cond) === norm(t)) followCond++;
    else neither++;
  }
  // --takeuchi（今夜の①の組・2026-11-24 統括役の頼み）: 食い違った会話で、竹内さん本人（端末の記録）の次の一手（24時間以内の最初の通）がリストか統括のどちらに合ったか
  const tk = { list: 0, cond: 0, neither: 0, none: 0 };
  if (process.argv.includes("--takeuchi")) {
    for (const m of mismatches) {
      const from = new Date(m.at).toISOString(), to = new Date(m.at + 86400e3).toISOString();
      const { data: ms } = await sb.from("messages").select("created_at, staff_writer, staff_writer_source, is_aix_generated").eq("conversation_id", m.cid).eq("sender", "staff").gte("created_at", from).lte("created_at", to).order("created_at").limit(40);
      const first = ((ms ?? []) as Array<{ created_at: string; staff_writer: string | null; staff_writer_source: string | null; is_aix_generated: boolean | null }>).find((x) => x.staff_writer === "takeuchi" && x.staff_writer_source === "device");
      if (!first) { tk.none++; continue; }
      let move = "reply";
      if (first.is_aix_generated) {
        const t0 = Date.parse(first.created_at);
        const { data: a } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", m.cid).gte("created_at", new Date(t0 - 10 * 60e3).toISOString()).lte("created_at", new Date(t0 + 2 * 60e3).toISOString()).order("created_at", { ascending: false }).limit(1);
        move = (a?.[0] as { aix_type?: string } | undefined)?.aix_type ?? "aix";
      }
      const norm = (x: string | null) => (x === "property_recommendation" ? "property_send" : x);
      if (m.list.map(norm).includes(norm(move))) tk.list++;
      else if (norm(m.cond) === norm(move)) tk.cond++;
      else tk.neither++;
    }
    console.log(`\n■ 食い違い ${mismatches.length}件を竹内さん本人（端末の記録）の次の一手で照らす（24時間以内の最初の通）: リスト ${tk.list}・統括 ${tk.cond}・どちらでもない ${tk.neither}・竹内さん本人の通なし ${tk.none}`);
  }
  const avg = (x: { chars: number; lines: number; dup: number; sit: number; n: number }) => `1人あたり ${(x.chars / Math.max(1, x.n)).toFixed(0)}字・${(x.lines / Math.max(1, x.n)).toFixed(1)}行・重複 ${(x.dup / Math.max(1, x.n)).toFixed(2)}・状況の1行 ${x.n ? Math.round((x.sit / x.n) * 100) : 0}%（${x.n}人）`;
  const pc = (a: number) => `${a}（${nCust ? Math.round((a / nCust) * 100) : 0}%）`;
  console.log(`\n■ 物差し（やる事が残っている全員・2回分）\n  今の形: ${avg(tot.old)}\n  新しい形: ${avg(tot.v2)}`);
  console.log(`\n■ 統括との連携（やる事のあるお客様 ${nCust}人・2回分）\n  統括の判断なし ${pc(vs.no_conductor)}・判断が古い ${pc(vs.stale)}・欄が空 ${pc(emptyField)}`);
  console.log(`  link:todo_vs_conductor: 合う ${vs.match}・食い違い ${vs.mismatch}・次の手の種類が読めない ${vs.unknown}`);
  console.log(`  食い違い ${mismatches.length}件のうち先頭 ${Math.min(60, mismatches.length)}件で、24時間以内にスタッフが送った AIX: リストの側 ${followList}・統括の側 ${followCond}・どちらでもない ${neither}・送っていない ${noSend}（スタッフの送信＝竹内さん本人とは限らない）`);
})().catch((e) => { console.error(e); process.exit(1); });
