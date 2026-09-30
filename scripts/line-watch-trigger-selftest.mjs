// scripts/line-watch-trigger-selftest.mjs
// 見張りのトリガー（capture_line_watch_turn）を本物の Postgres（PGlite・WASM）で当てる自己完結のテスト。本番 DB には触らない。
//   ① 控えの形（番1つ＝1行・作り直しで draft_versions が増えて draft_first が残る・連投は同じ行・印・指摘の段・壊れた時刻）
//   ② 安全: トリガーの中で何が失敗しても conversations の更新が通る（表を消す・列を消す・設定の行が無い・止める設定）
//   ③ migrate-schema/route.ts に同じ SQL が入っているか（作成の節の文が一字一句同じ）
// 実行（PGlite はプロジェクトの依存に入れていないので別の場所に入れて渡す）:
//   mkdir %TEMP%\pgtest && cd %TEMP%\pgtest && npm i @electric-sql/pglite
//   set PGLITE_MODULE=file:///C:/.../pgtest/node_modules/@electric-sql/pglite/dist/index.js
//   node scripts/line-watch-trigger-selftest.mjs      → 全 PASS で exit 0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");

const full = readFileSync(path.join(here, "line-watch-migration.sql"), "utf8");
const cut = full.indexOf("-- 2. 止め方");
if (cut < 0) throw new Error("止め方の節が見つからない");
// 作成の節（1. の見出しの後〜2. の見出しの前の区切り線まで）
const createPart = full.slice(full.indexOf("CREATE TABLE IF NOT EXISTS line_watch_settings"), full.lastIndexOf("-- ═", cut)).trim();

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✗ ${name} ${detail}`); }
}

// ③ route.ts と同じ文か
{
  const route = readFileSync(path.join(here, "..", "app", "api", "migrate-schema", "route.ts"), "utf8").replace(/\r\n/g, "\n");
  ok(route.includes(createPart), "migrate-schema/route.ts に作成の節が一字一句同じで入っている");
  ok(!/[\\`]|\$\{/.test(createPart), "作成の節にバックスラッシュ・バッククォート・ドル波括弧が無い（テンプレート文字列で壊れない）");
}

async function freshDb() {
  const db = new PGlite();
  // 本番と同じ形の最小の表（列は本番の information_schema から）
  await db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, customer_name TEXT, status TEXT, ai_draft TEXT, ai_draft_check JSONB, suggested_aix_meta JSONB, updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, sender TEXT, text TEXT, created_at TIMESTAMPTZ);
  `);
  await db.exec(createPart);
  return db;
}
const C = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA の形
async function msg(db, id, sender, iso, text = "") {
  await db.query("INSERT INTO messages (id, conversation_id, sender, text, created_at) VALUES ($1, $2, $3, $4, $5)", [id, C, sender, text, iso]);
}
async function rows(db) {
  return (await db.query("SELECT * FROM line_watch_turns ORDER BY customer_turn_at")).rows;
}

// 本番の ai_draft_check の実物の形（fecda03f の行から名前以外そのまま・tpo_debug は必要な所だけ）
const CHECK_REAL = {
  ok: true,
  issues: [
    { code: "MISSED_QUESTION", pass: "context_check", message: "顧客が新規物件のURLを提示し「空いていますか？」と質問しているが、返信はこれに触れていない。", evidence: "こちら新しく出ていたのですが空いていますか？", severity: "warning", suggestion: "確認宣言を追加する。" },
    { code: "NAME_MISMATCH", pass: "rule_check", message: "確定名以外の名前（入居者）があります", evidence: "入居者", severity: "warning", suggestion: "呼びかけを統一" },
  ],
  pre_revision_issues: ["NAME_MISMATCH:warning", "WE_DO_MISSING_DET:info", "MISSED_QUESTION:warning", "STAFF_REQUEST_OMITTED:warning"],
  passes_completed: ["rule_check", "anomaly_scan", "context_check"],
  revision_count: 1, regen_count: 0, elapsed_ms: 3510, checked_text_hash: "d65df0f2",
  tpo_debug: { tpo_label: "質問回答（往復: その他 → 質問（対象: 駐車場）｜台帳: 物件送付2件）", revisionOutcome: "ok", finalCheckCodes: ["MISSED_QUESTION"], ledger: { big: "x".repeat(5000) } },
};
const META_REAL = {
  action: "property_check_result", reply_mode: "aix", check_pattern: "vacancy", analyzed_msg_ts: "2026-10-01T01:00:00.000Z",
  scene_evidence: "お客様が送った物件の空室の質問", property_search_params: { area: ["浪速区"], rent_max: 80000 }, condition_change_scope: "temporary",
};

console.log("① 控えの形");
{
  const db = await freshDb();
  await db.query("INSERT INTO conversations (id, customer_name, status) VALUES ($1, 'YUMA', 'proposing')", [C]);
  await msg(db, "s1", "staff", "2026-10-01T00:00:00Z", "物件お送りしました");
  await msg(db, "c1", "customer", "2026-10-01T01:00:00Z", "このお部屋空いてますか？");

  await db.query("UPDATE conversations SET suggested_aix_meta = $2 WHERE id = $1", [C, META_REAL]);
  let r = await rows(db);
  ok(r.length === 1, "ブレインの判断だけで1行（AIX の番は下書きが無い）", JSON.stringify(r.length));
  ok(r[0]?.brain_action === "property_check_result" && r[0]?.brain_reply_mode === "aix" && r[0]?.brain_versions === 1, "brain_action・reply_mode・回数");
  ok(new Date(r[0]?.brain_analyzed_msg_ts).toISOString() === "2026-10-01T01:00:00.000Z", "analyzed_msg_ts を時刻で");
  ok(r[0]?.search_hint?.change_scope === "temporary" && r[0]?.search_hint?.params?.rent_max === 80000, "検索の手掛かり（条件・今回だけ）");
  ok(new Date(r[0]?.customer_turn_at).toISOString() === "2026-10-01T01:00:00.000Z", "番の時刻 = 最後のスタッフより後の最初のお客様の発言");

  await db.query("UPDATE conversations SET ai_draft = $2, ai_draft_check = $3 WHERE id = $1", [C, "YUMAさん\n\n空室状況確認させて頂きます😊！！", CHECK_REAL]);
  r = await rows(db);
  ok(r.length === 1 && r[0].draft_versions === 1 && r[0].draft_first === r[0].draft_last, "下書き1回目: draft_first = draft_last・回数1");
  const fc = r[0].final_check;
  ok(Array.isArray(fc?.issues) && fc.issues.length === 2 && fc.issues[0].pass === "context_check" && fc.issues[1].pass === "rule_check", "指摘は段（pass）つき");
  ok(Array.isArray(fc?.pre) && fc.pre.length === 4 && fc.revision_count === 1 && fc.revision_outcome === "ok", "修正前の指摘・修正回数・結果");
  ok(!JSON.stringify(fc).includes("xxxxxxxxxx"), "tpo_debug の大きな中身は持たない");
  ok(r[0].tpo_label?.startsWith("質問回答"), "tpo_label");
  ok(r[0].brain_action === "property_check_result", "下書きの更新でブレインの判断は消えない");

  // 作り直し（同じ番）
  await db.query("UPDATE conversations SET ai_draft = $2 WHERE id = $1", [C, "YUMAさん\n\nお送り頂きましたお部屋の募集状況確認させて頂きます😊！！"]);
  r = await rows(db);
  ok(r.length === 1 && r[0].draft_versions === 2, "作り直しで draft_versions=2（同じ行）");
  ok(r[0].draft_first.includes("空室状況") && r[0].draft_last.includes("募集状況"), "draft_first は残り draft_last が新しい");

  // 連投（同じ番）
  await msg(db, "c2", "customer", "2026-10-01T01:03:00Z", "あと駐車場ありますか");
  await db.query("UPDATE conversations SET ai_draft = $2 WHERE id = $1", [C, "3回目"]);
  r = await rows(db);
  ok(r.length === 1 && r[0].draft_versions === 3 && new Date(r[0].customer_last_at).toISOString() === "2026-10-01T01:03:00.000Z", "連投は同じ行で customer_last_at だけ進む");

  // 印
  await db.query("UPDATE conversations SET ai_draft = '[AIX誘導中]' WHERE id = $1", [C]);
  r = await rows(db);
  ok(r[0].draft_sentinel === "[AIX誘導中]" && r[0].draft_versions === 3 && r[0].draft_last === "3回目", "[AIX誘導中] は印の列へ（本文の回数に数えない）");

  // 同じ値の更新（WHEN で弾く）→ 何も変わらない
  const before = r[0].updated_at;
  await db.query("UPDATE conversations SET ai_draft = '[AIX誘導中]' WHERE id = $1", [C]);
  r = await rows(db);
  ok(String(r[0].updated_at) === String(before), "値が同じ更新では書かない");

  // スタッフが送った → 下書きを消す: 番が開いていないので控えない
  await msg(db, "s2", "staff", "2026-10-01T01:10:00Z", "確認します");
  await db.query("UPDATE conversations SET ai_draft = NULL, ai_draft_check = NULL WHERE id = $1", [C]);
  r = await rows(db);
  ok(r.length === 1, "送った後（最後がスタッフ）は新しい行を作らない");

  // 次の番
  await msg(db, "c3", "customer", "2026-10-01T02:00:00Z", "ありがとうございます");
  await db.query("UPDATE conversations SET ai_draft = 'はい😊！！' WHERE id = $1", [C]);
  r = await rows(db);
  ok(r.length === 2 && r[1].draft_versions === 1 && r[1].brain_action === null, "次のお客様の番は別の行");

  // 壊れた材料（時刻が読めない・issues が配列でない・check が配列）
  await db.query("UPDATE conversations SET suggested_aix_meta = $2, ai_draft_check = $3 WHERE id = $1", [C, { action: "", reply_mode: "auto_reply", analyzed_msg_ts: "昨日" }, { ok: false, issues: "壊れた" }]);
  r = await rows(db);
  ok(r[1].brain_reply_mode === "auto_reply" && r[1].brain_analyzed_msg_ts === null && Array.isArray(r[1].final_check?.issues) && r[1].final_check.issues.length === 0, "読めない時刻は NULL・配列でない issues は空");
  await db.query("UPDATE conversations SET ai_draft_check = '[1,2]'::jsonb WHERE id = $1", [C]);
  r = await rows(db);
  ok(r[1].final_check?.ok === false, "オブジェクトでない check は控えを変えない");

  // 長い下書きは 4,000字で切る
  await db.query("UPDATE conversations SET ai_draft = $2 WHERE id = $1", [C, "あ".repeat(9000)]);
  r = await rows(db);
  ok(r[1].draft_last.length === 4000, "下書きは 4,000字まで");
  await db.close();
}

console.log("② 安全（中で失敗しても元の更新が通る）");
async function mustUpdate(db, name, draft) {
  try {
    await db.query("UPDATE conversations SET ai_draft = $2 WHERE id = $1", [C, draft]);
    const v = (await db.query("SELECT ai_draft FROM conversations WHERE id = $1", [C])).rows[0]?.ai_draft;
    ok(v === draft, name);
  } catch (e) { ok(false, name, String(e)); }
}
{
  const db = await freshDb();
  await db.query("INSERT INTO conversations (id, customer_name, status) VALUES ($1, 'YUMA', 'proposing')", [C]);
  await msg(db, "c1", "customer", "2026-10-01T01:00:00Z", "質問");

  await db.exec("UPDATE line_watch_settings SET capture_enabled = false WHERE id = 1");
  await mustUpdate(db, "止める設定（capture_enabled=false）でも更新は通る", "a1");
  ok((await rows(db)).length === 0, "止める設定の間は控えない");
  await db.exec("UPDATE line_watch_settings SET capture_enabled = true WHERE id = 1");

  await db.exec("DELETE FROM line_watch_settings");
  await mustUpdate(db, "設定の行が無くても更新は通る（控えない）", "a2");
  ok((await rows(db)).length === 0, "設定の行が無い時は控えない（安全側）");
  await db.exec("INSERT INTO line_watch_settings (id) VALUES (1)");

  await db.exec("ALTER TABLE line_watch_turns DROP COLUMN draft_sentinel");
  await mustUpdate(db, "控えの表の列が消えていても更新は通る", "a3");

  await db.exec("DROP TABLE line_watch_turns");
  await mustUpdate(db, "控えの表が無くても更新は通る", "a4");

  await db.exec("DROP TABLE line_watch_settings");
  await mustUpdate(db, "設定の表が無くても更新は通る", "a5");

  await db.exec("ALTER TABLE messages RENAME TO messages_x");
  await mustUpdate(db, "messages が読めなくても更新は通る", "a6");

  // 一意の制約違反を起こす（控えの表を別の形で作り直す: customer_turn_at を NOT NULL の別列に）
  await db.exec("ALTER TABLE messages_x RENAME TO messages");
  await db.exec(createPart.slice(0, createPart.indexOf("CREATE OR REPLACE FUNCTION")));
  await db.exec("ALTER TABLE line_watch_turns ADD COLUMN must_fill TEXT NOT NULL DEFAULT 'x'; ALTER TABLE line_watch_turns ALTER COLUMN must_fill DROP DEFAULT");
  await mustUpdate(db, "控えの INSERT が制約で落ちても更新は通る", "a7");

  // 同じ取引の中で元の更新が後から使える（トリガーの失敗が取引を壊していない）
  try {
    await db.exec("BEGIN; UPDATE conversations SET ai_draft = 'b1' WHERE id = '" + C + "'; UPDATE conversations SET status = 'viewing' WHERE id = '" + C + "'; COMMIT;");
    const v = (await db.query("SELECT ai_draft, status FROM conversations WHERE id = $1", [C])).rows[0];
    ok(v.ai_draft === "b1" && v.status === "viewing", "トリガーが失敗した後も同じ取引の続きの更新が通る（取引が壊れない）");
  } catch (e) { ok(false, "取引が壊れない", String(e)); }

  // 時間切れ（query_canceled）: 設定を読む所を遅い関数にすり替える
  await db.exec("DROP TABLE line_watch_turns");
  await db.exec(createPart.slice(0, createPart.indexOf("CREATE OR REPLACE FUNCTION")));
  await db.exec("DROP TABLE line_watch_settings; CREATE VIEW line_watch_settings AS SELECT 1 AS id, (pg_sleep(1.5) IS NOT NULL) AS capture_enabled");
  try {
    await db.exec("SET statement_timeout = '500ms'");
    const t0 = Date.now();
    await db.query("UPDATE conversations SET ai_draft = 'c1' WHERE id = $1", [C]);
    const ms = Date.now() - t0;
    const v = (await db.query("SELECT ai_draft FROM conversations WHERE id = $1", [C])).rows[0]?.ai_draft;
    if (ms >= 1400) console.log(`  - 時間切れの当て: PGlite では statement_timeout が効かない（${ms}ms 待った）＝ここでは確かめられない。本番は EXCEPTION の query_canceled で握る`);
    else ok(v === "c1", `時間切れ（statement_timeout）がトリガーの中で起きても更新は通る（${ms}ms）`);
  } catch (e) {
    const m = String(e);
    // PGlite が時間切れを実装していない時は当てられない（本番の Postgres では query_canceled を握る）
    console.log(`  - 時間切れの当て: ${/timeout|cancel/i.test(m) ? "✗ 更新が止まった " + m : "PGlite では確かめられない " + m}`);
    if (/timeout|cancel/i.test(m)) { failed++; fails.push("statement_timeout"); }
  } finally { await db.exec("SET statement_timeout = 0").catch(() => undefined); }

  // 取り消し（query_canceled＝57014。本番で statement_timeout が当たった時と同じ SQLSTATE）をトリガーの中で起こす
  await db.exec(`DROP VIEW line_watch_settings;
    CREATE FUNCTION boom_cancel() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = 'query_canceled'; END; $$;
    CREATE VIEW line_watch_settings AS SELECT 1 AS id, boom_cancel() AS capture_enabled;`);
  await mustUpdate(db, "トリガーの中で query_canceled（57014）が起きても更新は通る", "c2");
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(fails.join("\n")); process.exit(1); }
