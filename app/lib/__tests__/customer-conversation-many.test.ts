// app/lib/__tests__/customer-conversation-many.test.ts
// 2026-10-20 決定 e06c795a ⑤: トーク一覧の『新着 N件』の印を、お客様が最後に話した会話に付ける（primaryConversationsForCustomers）。
//   DB の代わりに小さな偽物を使う（会話・発言は作った例）。
// 実行: npx tsx app/lib/__tests__/customer-conversation-many.test.ts
import { readFileSync } from "fs";
import { join } from "path";
import { primaryConversationsForCustomers } from "../customer-conversation-server";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name} ${extra !== undefined ? JSON.stringify(extra) : ""}`); } };

type Row = Record<string, unknown>;
function fakeSb(tables: Record<string, Row[]>) {
  let msgQueries = 0;
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let lim = Infinity;
    const q = {
      select: () => q,
      in: (col: string, vals: string[]) => { rows = rows.filter((r) => vals.includes(String(r[col]))); return q; },
      eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return q; },
      order: (col: string, o: { ascending: boolean }) => { rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (o.ascending ? 1 : -1)); return q; },
      limit: (n: number) => { lim = n; return q; },
      then: (res: (v: { data: Row[]; error: null }) => unknown) => { if (table === "messages") msgQueries++; return Promise.resolve({ data: rows.slice(0, lim), error: null }).then(res); },
    };
    return q;
  };
  return { sb: { from } as never, msgQueries: () => msgQueries };
}

(async () => {
  console.log("■ お客様が最後に話した会話に結ぶ");
  const f = fakeSb({
    conversations: [
      // pc-1: スモラの会話の方が updated_at は新しいが、お客様が最後に話したのはイエヤス
      { id: "c-sumora", account: "sumora", updated_at: "2026-10-19T10:00:00Z", property_customer_id: "pc-1" },
      { id: "c-ieyasu", account: "ieyasu", updated_at: "2026-10-18T10:00:00Z", property_customer_id: "pc-1" },
      // pc-2: 会話が1つ
      { id: "c-giga", account: "giga", updated_at: "2026-10-10T10:00:00Z", property_customer_id: "pc-2" },
    ],
    messages: [
      { conversation_id: "c-sumora", sender: "customer", created_at: "2026-10-01T00:00:00Z" },
      { conversation_id: "c-sumora", sender: "staff", created_at: "2026-10-19T10:00:00Z" },
      { conversation_id: "c-ieyasu", sender: "customer", created_at: "2026-10-18T09:00:00Z" },
    ],
  });
  const m = await primaryConversationsForCustomers(f.sb, ["pc-1", "pc-2", "pc-none", null]);
  t("2つのアカウント: お客様が最後に話したイエヤスの会話", m.get("pc-1")?.id === "c-ieyasu", m.get("pc-1"));
  t("2つのアカウントは ambiguous の印", m.get("pc-1")?.ambiguous === true);
  t("会話が1つ: その会話", m.get("pc-2")?.id === "c-giga");
  t("会話が無いお客様は入らない", !m.has("pc-none"));
  t("会話が1つの人の発言は読まない（2つ以上の人だけ）", f.msgQueries() === 2, f.msgQueries());
  const empty = await primaryConversationsForCustomers(f.sb, []);
  t("空なら空", empty.size === 0);

  console.log("■ 配線");
  const talk = readFileSync(join(process.cwd(), "app/api/property-pickups/talk/route.ts"), "utf8");
  t("トーク一覧の印: お客様 → 会話を最初に見つかった物で選ばない", /primaryConversationsForCustomers\(supabase, pcids\)/.test(talk) && !/if \(!convOfPc\.has\(c\.property_customer_id\)\) convOfPc\.set/.test(talk));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
