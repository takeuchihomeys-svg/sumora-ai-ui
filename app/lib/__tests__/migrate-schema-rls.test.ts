// 2026-10-21 RLS ②: 毎晩の migrate-schema がサーバーだけの表の RLS を OFF に戻さないこと・messages のトリガーが (a) の表を読めること
// 実行: npx tsx app/lib/__tests__/migrate-schema-rls.test.ts
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

let passed = 0, failed = 0;
const it = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };

const ROOT = join(__dirname, "..", "..", "..");
const src = readFileSync(join(ROOT, "app", "api", "migrate-schema", "route.ts"), "utf8");
const a = src.indexOf("const SQL = `"), b = src.indexOf("`.trim();", a);
const SQL = src.slice(a + "const SQL = `".length, b > a ? b : undefined);

// 画面（公開キー）が読む・書く・Realtime で購読する表＝RLS ③ で anon の方針を決めるまで DISABLE を残してよい表
const SCREEN_TABLES = new Set([
  "ai_reply_examples", "aix_action_items", "aix_usage_logs", "sent_image_properties", "sent_properties", "viewings",
  "automation_commands", "brain_decision_logs", "calendar_events", "conversation_stage_history", "conversations", "messages",
  "property_customers", "scheduled_messages", "line_tasks",
]);
// (a) サーバーだけの表の例（前に DISABLE があったもの）
const SERVER_ONLY_SAMPLE = ["line_contacts", "staff_send_log", "staff_devices", "hanbancyo_settings", "cron_run_logs", "line_watch_turns", "staff_todo_marks", "templates", "phrase_dictionary"];

const DISABLE_RE = /ALTER TABLE (?:IF EXISTS )?(?:public\.)?"?([a-z0-9_]+)"? DISABLE ROW LEVEL SECURITY/gi;
const disabledIn = (text: string) => [...text.matchAll(DISABLE_RE)].map((m) => m[1].toLowerCase());

it("migrate-schema の DISABLE ROW LEVEL SECURITY は画面の表だけ", () => {
  const bad = disabledIn(SQL).filter((t) => !SCREEN_TABLES.has(t));
  if (bad.length) throw new Error(`サーバーだけの表に DISABLE がある（毎晩 RLS が OFF に戻る）: ${bad.join(", ")}`);
});

it("サーバーだけの表の例に DISABLE が無い", () => {
  const d = new Set(disabledIn(SQL));
  const bad = SERVER_ONLY_SAMPLE.filter((t) => d.has(t));
  if (bad.length) throw new Error(bad.join(", "));
});

it("migrate-schema は allow_anon_all の方針を作らない", () => {
  if (/CREATE POLICY\s+"?allow_anon_all"?/i.test(SQL)) throw new Error("allow_anon_all を作っている");
});

it("fill_message_staff_writer は SECURITY DEFINER・search_path 固定", () => {
  const i = SQL.indexOf("CREATE OR REPLACE FUNCTION fill_message_staff_writer()");
  if (i < 0) throw new Error("定義が無い");
  const end = SQL.indexOf("$func$ LANGUAGE", i);
  const tail = SQL.slice(end, SQL.indexOf(";", end) + 1);
  if (!/SECURITY DEFINER/.test(tail) || !/SET search_path = public/.test(tail)) throw new Error(`定義の終わり: ${tail}`);
});

it("手で流す scripts/ にもサーバーだけの表の DISABLE が無い", () => {
  const dir = join(ROOT, "scripts");
  const bad: string[] = [];
  for (const n of readdirSync(dir)) {
    if (!/\.(ts|sql)$/.test(n)) continue;
    for (const t of disabledIn(readFileSync(join(dir, n), "utf8"))) if (!SCREEN_TABLES.has(t)) bad.push(`${n}: ${t}`);
  }
  if (bad.length) throw new Error(bad.join(" / "));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
