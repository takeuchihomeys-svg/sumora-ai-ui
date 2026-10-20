// scripts/preview-staff-todo.ts — スタッフのグループに出す【やることリスト】の見本を本番のデータで出す
//   読むだけ（DB に書かない・LINE に送らない・LLM なし）。過去の日もその時点で開いていた物から組み立て直し、その日のうちに済んだかを数える。
// 実行:
//   npx tsx --env-file=.env.local scripts/preview-staff-todo.ts                       今の時点
//   npx tsx --env-file=.env.local scripts/preview-staff-todo.ts --days=3 --hm=10:30   今日と過去3日の 10:30（JST）＋その日の終わりに済んだか
//   --mask  お客様の名前を 顧客A・顧客B… に置き換える（見本を人に見せる時）
import { supabase } from "@/app/lib/supabase";
import { loadStaffTodoList } from "@/app/lib/staff-todo-list-server";
import { renderStaffTodoList, type TodoList } from "@/app/lib/staff-todo-list";
import { jstDayStartMs } from "@/app/lib/jst-date";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const mask = process.argv.includes("--mask");
const days = Number(arg("days") ?? 0);
const hm = arg("hm");

function masked(list: TodoList): TodoList {
  if (!mask) return list;
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return {
    ...list,
    customers: list.customers.map((c, i) => {
      const alias = `顧客${letters[i % 26]}${i >= 26 ? Math.floor(i / 26) : ""}`;
      const esc = c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = c.name && c.name !== "お客様" ? new RegExp(esc, "g") : null;
      return {
        ...c, name: alias, accountLabel: re ? c.accountLabel.replace(re, alias) : c.accountLabel,
        items: c.items.map((it) => ({ ...it, task: re ? it.task.replace(re, alias) : it.task })),
      };
    }),
  };
}

function atFor(dayOffset: number): number {
  const now = Date.now();
  if (!hm) return dayOffset === 0 ? now : jstDayStartMs(now) - dayOffset * 86_400_000 + 12 * 3600_000;
  const [h, m] = hm.split(":").map(Number);
  return jstDayStartMs(now) - dayOffset * 86_400_000 + (h * 60 + m) * 60_000;
}

async function main() {
  for (let d = 0; d <= days; d++) {
    const at = atFor(d);
    if (at > Date.now()) continue;
    const list = await loadStaffTodoList(supabase, at);
    console.log(`\n==================== ${new Date(at).toISOString()} ====================`);
    console.log(renderStaffTodoList(masked(list)) ?? "（やる事なし）");
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
