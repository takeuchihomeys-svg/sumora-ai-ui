// scripts/preview-staff-todo.ts — スタッフのグループに出す【やることリスト】の見本を本番のデータで出す
//   読むだけ（DB に書かない・LINE に送らない・LLM なし）。過去の日もその時点で開いていた物から組み立て直し、その日のうちに済んだかを数える。
// 実行:
//   npx tsx --env-file=.env.local scripts/preview-staff-todo.ts                       今の時点
//   npx tsx --env-file=.env.local scripts/preview-staff-todo.ts --days=3 --hm=10:30   今日と過去3日の 10:30（JST）＋その日の終わりに済んだか
//   --mask  お客様の名前を 顧客A・顧客B… に置き換える（見本を人に見せる時）
//   --rotate 今日の 10:30 の便と、その控えを使った 11:30 の便（長い時に④⑤を次の便へ回す見本）
import { supabase } from "@/app/lib/supabase-server";
import { loadStaffTodoList } from "@/app/lib/staff-todo-list-server";
import { renderStaffTodoList, composeStaffTodoPost, type TodoList } from "@/app/lib/staff-todo-list";
import { snapshotOf } from "@/app/lib/staff-todo-reply-server";
import { jstDayStartMs } from "@/app/lib/jst-date";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const mask = process.argv.includes("--mask");
const days = Number(arg("days") ?? 0);
const hm = arg("hm");

// 同じお客様は便をまたいで同じ仮名（--rotate の2便を見比べられるように）
const aliasBy = new Map<string, string>();
function masked(list: TodoList): TodoList {
  if (!mask) return list;
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return {
    ...list,
    customers: list.customers.map((c) => {
      if (!aliasBy.has(c.conversationId)) { const i = aliasBy.size; aliasBy.set(c.conversationId, `顧客${letters[i % 26]}${i >= 26 ? Math.floor(i / 26) : ""}`); }
      const alias = aliasBy.get(c.conversationId)!;
      const esc = c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = c.name && c.name !== "お客様" ? new RegExp(esc, "g") : null;
      return {
        ...c, name: alias, accountLabel: re ? c.accountLabel.replace(re, alias) : c.accountLabel,
        items: c.items.map((it) => ({ ...it, task: re ? it.task.replace(re, alias) : it.task, instruction: it.instruction && re ? it.instruction.replace(re, alias) : it.instruction })),
      };
    }),
    screening: list.screening?.map((_, i) => `審査中${letters[i % 26]}`),
  };
}

function atFor(dayOffset: number): number {
  const now = Date.now();
  if (!hm) return dayOffset === 0 ? now : jstDayStartMs(now) - dayOffset * 86_400_000 + 12 * 3600_000;
  const [h, m] = hm.split(":").map(Number);
  return jstDayStartMs(now) - dayOffset * 86_400_000 + (h * 60 + m) * 60_000;
}

async function rotatePreview() {
  const at1 = jstDayStartMs(Date.now()) + (10 * 60 + 30) * 60_000;
  const at2 = at1 + 3600_000;
  const p1 = composeStaffTodoPost(masked(await loadStaffTodoList(supabase, at1)));
  const snap1 = snapshotOf(p1.list, null, new Date(at1).toISOString());
  const p2 = composeStaffTodoPost(masked(await loadStaffTodoList(supabase, at2)), { snapshots: [snap1] });
  const daily = (l: TodoList) => l.customers.filter((c) => c.group === 4).map((c) => c.conversationId);
  for (const [label, p] of [["10:30", p1], ["11:30", p2]] as const) {
    console.log(`
==================== ${label} の便 ====================`);
    console.log(p.text ?? "（やる事なし）");
    console.log(`--- 長さ ${p.text?.length ?? 0}字・④に出した ${daily(p.list).length}人・次の便へ ④${p.carried[4]}人 ⑤${p.carried[5]}人`);
  }
  const both = new Set([...daily(p1.list), ...daily(p2.list)]);
  const again = daily(p2.list).filter((id) => daily(p1.list).includes(id)).length;
  console.log(`--- 2便で④に出た人 ${both.size}人（11:30 で 10:30 と重なった人 ${again}人）`);
}

async function main() {
  if (process.argv.includes("--rotate")) return rotatePreview();
  for (let d = 0; d <= days; d++) {
    const at = atFor(d);
    if (at > Date.now()) continue;
    const t0 = Date.now();
    const list = await loadStaffTodoList(supabase, at);
    const loadMs = Date.now() - t0;
    console.log(`\n==================== ${new Date(at).toISOString()} ====================`);
    const text = renderStaffTodoList(masked(list));
    console.log(text ?? "（やる事なし）");
    const groups: Record<string, number> = {};
    for (const c of list.customers) groups[String(c.group ?? "-")] = (groups[String(c.group ?? "-")] ?? 0) + 1;
    console.log(`--- 長さ ${text?.length ?? 0}字（上限 4900）・読み ${loadMs}ms・組ごとの人数 ${JSON.stringify(groups)}`);
    const bySource: Record<string, number> = {};
    for (const c of list.customers) for (const i of c.items) { const k = `${i.source}${i.doneAt ? ":done" : ":open"}`; bySource[k] = (bySource[k] ?? 0) + 1; }
    console.log(`--- お客様 ${list.customers.length}人・残り ${list.openCount}・済み ${list.doneCount}・材料別 ${JSON.stringify(bySource)}・外した ${JSON.stringify(list.skipped)}`);

    // 確かめ: この時点で開いていた物が、その日の終わり（今日なら今）までに済んだか・消えたか
    const endAt = Math.min(Date.now(), jstDayStartMs(at) + 86_400_000 - 1);
    if (endAt <= at) continue;
    const later = await loadStaffTodoList(supabase, endAt);
    const laterByKey = new Map(later.customers.flatMap((c) => c.items.map((i) => [i.key, i] as const)));
    const tally: Record<string, Record<string, number>> = {};
    for (const c of list.customers) for (const i of c.items) {
      if (i.doneAt) continue;
      const l = laterByKey.get(i.key);
      const outcome = !l ? "消えた（取り下げ・返信済み・閉じた）" : l.doneAt ? "済み✅" : "まだ";
      (tally[i.source] ??= {})[outcome] = ((tally[i.source] ??= {})[outcome] ?? 0) + 1;
    }
    console.log(`--- ${new Date(endAt).toISOString()} までに: ${JSON.stringify(tally)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
