// npx tsx app/lib/__tests__/todo-old-promises-combo.test.ts
// 2026-11-24 作業員L（台帳 #667・統括役の頼み）: STAFF_TODO_FORMAT_V2・STAFF_TODO_CLOSE_BY_SENT・STAFF_TODO_OLD_PROMISES の組み合わせ。
//   3つとも off の時、やることリストの文は今の main（#667 の前）と1字も変わらない（staff-todo-list.main-snapshot は git show で写した main の版を使う）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStaffTodoList, renderStaffTodoList, type TodoInput } from "../staff-todo-list";

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("ok", name); };
const AT = Date.parse("2026-11-24T03:00:00Z");
const iso = (d: number) => new Date(AT - d * 86_400_000).toISOString();
const input = (): TodoInput => ({
  atMs: AT,
  conversations: [
    { id: "c1aaaaaa-0000", customer_name: "テストA", account: null, status: "proposing", is_post_apply: false },
    { id: "c2bbbbbb-0000", customer_name: "テストB", account: null, status: "proposing", is_post_apply: false },
    { id: "c3cccccc-0000", customer_name: "テストC", account: null, status: "proposing", is_post_apply: false },
  ] as never,
  aixItems: [],
  promises: [
    { id: 1, conversation_id: "c1aaaaaa-0000", customer_name: "テストA", event_type: "property_send", start_at: iso(30), created_at: iso(30), notes: "【必ず】物件ピックアップ送付【今日中】", is_done: false },
    { id: 2, conversation_id: "c2bbbbbb-0000", customer_name: "テストB", event_type: "follow_up", start_at: iso(25), created_at: iso(25), notes: "【必ず】保証会社の確認→ご連絡", is_done: false },
    { id: 3, conversation_id: "c3cccccc-0000", customer_name: "テストC", event_type: "property_send", start_at: iso(1), created_at: iso(1), notes: "【必ず】物件ピックアップ送付【今日中】", is_done: false },
  ],
  facts: [], viewings: [], messages: [],
  propertySends: [{ conversation_id: "c1aaaaaa-0000", at: iso(20) }],
});
const SW = ["STAFF_TODO_FORMAT_V2", "STAFF_TODO_CLOSE_BY_SENT", "STAFF_TODO_OLD_PROMISES"] as const;
const withEnv = <T,>(on: readonly string[], f: () => T): T => {
  const prev = SW.map((k) => [k, process.env[k]] as const);
  for (const k of SW) { if (on.includes(k)) process.env[k] = "on"; else delete process.env[k]; }
  try { return f(); } finally { for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

(async () => {
  await t("3つとも off: main の版と文が1字も変わらない", async () => {
    // main の staff-todo-list.ts を、同じ app/lib の並びの一時の置き場に写して読み込む（import の相手は今の作業ツリーの物）
    const here = join(__dirname, "..");
    let mainSrc = "";
    try { mainSrc = execFileSync("git", ["show", "origin/main:app/lib/staff-todo-list.ts"], { cwd: here, encoding: "utf8", maxBuffer: 1 << 26 }); } catch { console.log("  （origin/main が読めないので飛ばす）"); return; }
    const p = join(here, "staff-todo-list.main-snapshot.ts");
    writeFileSync(p, mainSrc);
    try {
      const old = (await import(pathToFileURL(p).href)) as { buildStaffTodoList: typeof buildStaffTodoList; renderStaffTodoList: typeof renderStaffTodoList };
      const a = withEnv([], () => renderStaffTodoList(buildStaffTodoList(input())));
      const b = withEnv([], () => old.renderStaffTodoList(old.buildStaffTodoList(input() as never)));
      assert.equal(a, b);
      const a2 = withEnv(["STAFF_TODO_FORMAT_V2"], () => renderStaffTodoList(buildStaffTodoList(input())));
      const b2 = withEnv(["STAFF_TODO_FORMAT_V2"], () => old.renderStaffTodoList(old.buildStaffTodoList(input() as never)));
      assert.equal(a2, b2, "FORMAT_V2 だけ on でも #667 の前と同じ");
    } finally { try { (await import("node:fs")).rmSync(p); } catch { /* */ } }
  });
  await t("組み合わせ8通りで壊れない・古い約束の段は OLD_PROMISES の時だけ・閉じ忘れは CLOSE_BY_SENT の時だけ", () => {
    for (let mask = 0; mask < 8; mask++) {
      const on = SW.filter((_, i) => mask & (1 << i));
      const text = withEnv(on, () => renderStaffTodoList(buildStaffTodoList(input()))) ?? "";
      const old = on.includes("STAFF_TODO_OLD_PROMISES");
      assert.equal(/【古い約束/.test(text), old, `${on.join("+") || "なし"}: 古い約束の段`);
      if (old) {
        const closed = on.includes("STAFF_TODO_CLOSE_BY_SENT");
        assert.equal(/古い約束（期日から2週間を過ぎて開いたまま・(\d)件）/.exec(text)?.[1], closed ? "1" : "2", `${on.join("+")}: 送った記録で閉じた約束は古い約束に出ない`);
      }
      assert.match(text, /【やることリスト】/);
    }
  });
  console.log(`todo-old-promises-combo: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
