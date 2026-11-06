// 近い番の後ろの読みを台本が先に控える（scripts/lib/exam-near-followups.ts）のテスト（DB も LLM も使わない）
// 実行: npx tsx --env-file=.env.local scripts/lib/__tests__/exam-near-followups.test.ts（全 PASS で exit 0・app/lib の読み込みに URL が要る・DB は読まない）
// 確かめる事（2026-11-07 統括役）: 台本が RPC の答えから作った後ろの読みの控えだけで、試験の道（nearKeepShareFor・turnMetaQuery）が on 1回で全部当たる
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { followupUrls } from "../exam-near-followups";
import { installDbSnapshot, keyedKey, reduceKeyedBody } from "../exam-frozen-input";
import { nearFromFocusRows, nearKeepShareFor } from "../../../app/lib/conductor-focus-server";
import { turnMetaQuery, nearOpinionRows } from "../../../app/lib/conductor-near-opinion-server";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const BASE = "https://x.supabase.co";
// RPC（match_conductor_focus）の答え（台本が絞った後の形）: 束の中 6件
const rpc = Array.from({ length: 6 }, (_, i) => ({ source_key: `msg:m${i + 1}`, scene: "S1", focus: i < 4 ? "promise_keep" : "answer", distance: 0.05 + i * 0.02, turn_at: "2026-11-01T00:00:00Z", actual: { aix: i % 2 ? "property_check_result" : null, route: i % 2 ? "aix" : "reply", shape: "R", picker: null } }));

(async () => {
  const now = Date.parse("2026-11-07T03:00:00Z");
  const fus = await followupUrls(BASE, "match_conductor_focus", rpc, now);
  ok("後ろの読みを2つ作る（keep の表・番のベクトルの表）", fus.length === 2 && fus.some((f) => f.name === "takeuchi_compose_examples") && fus.some((f) => f.name === "conductor_turn_vectors"), JSON.stringify(fus));
  ok("別の RPC からは作らない・空なら作らない", (await followupUrls(BASE, "match_templates", rpc, now)).length === 0 && (await followupUrls(BASE, "match_conductor_focus", [], now)).length === 0);

  // 台本が書く控え（同じ鍵）
  const dir = mkdtempSync(join(tmpdir(), "near-fu-"));
  const day = "2026-11-07"; mkdirSync(join(dir, day), { recursive: true });
  const keepRows = ["m1", "m2", "m3", "m4", "m5"].map((m, i) => ({ message_id: m, keep: i < 4 }));
  for (const fu of fus) {
    const body = fu.name === "takeuchi_compose_examples" ? reduceKeyedBody(fu.name, JSON.stringify(keepRows)) : reduceKeyedBody(fu.name, JSON.stringify(rpc.slice(0, 5).map((r) => ({ source_key: r.source_key, situation: "お客様: x" }))), { "msg:m1": "伏せた要約" });
    writeFileSync(join(dir, day, `k-${keyedKey(fu.url, "GET", "", [])}.json`), JSON.stringify({ status: 200, contentType: "application/json", contentRange: null, body, at: "x", table: fu.name }));
  }

  // 試験の道（公開キー・控えだけで動くか）: 中の fetch が呼ばれたら当たっていない
  const orig = globalThis.fetch;
  let inner = 0;
  globalThis.fetch = (async () => { inner++; return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    process.env.EXAM_DB_SNAPSHOT_DAY = day;
    installDbSnapshot({ dir, excludeIds: () => ["lane-conv"], keyHint: () => "q999" });
    const sb = createClient(BASE, "anon-key", { auth: { persistSession: false, autoRefreshToken: false } });
    const near = nearFromFocusRows(rpc, "S1");
    const share = await nearKeepShareFor(sb as never, near?.ids ?? []);
    ok("文の統括: keep の読みが控えに当たる（4/5＝0.8・中の fetch を呼ばない）", share === 0.8 && inner === 0, `share=${share} inner=${inner}`);
    const rows0 = nearOpinionRows(rpc, now);
    const { data } = await turnMetaQuery(sb as never, rows0.slice(0, 5).map((h) => h.source_key));
    const meta = (data ?? []) as Array<{ source_key: string; situation: string | null }>;
    ok("入口の意見: 状況の文の読みが控えに当たる（一番近い番だけ要約・中の fetch を呼ばない）", meta.length === 5 && meta[0].situation === "伏せた要約" && meta[1].situation === null && inner === 0, JSON.stringify(meta).slice(0, 200) + ` inner=${inner}`);
  } finally { globalThis.fetch = orig; delete process.env.EXAM_DB_SNAPSHOT_DAY; rmSync(dir, { recursive: true, force: true }); }
  console.log(`${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
