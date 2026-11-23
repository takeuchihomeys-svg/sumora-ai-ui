// scripts/audit-situation-check.ts — 現状把握の物差し（根 situation:match・台帳 #17）: 竹内さん本人の番で、ブレインが持っていた今の状況の数が実物と合っているか（読むだけ・LLM なし）
// 2026-11-23 作業員L。決めは scripts/lib/situation-check.ts。会話の文は読まない（数と会話の頭8字だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-situation-check.ts [--days=14] [--out=<json>]（14日を超えるのは夜だけ・JST 22〜9時）
//   --out の json は { root, turns: [{ id, kind, scene, miss, cause }], nodes, unmeasured, takeuchi_turns }（作業員P の地図の builder が turns を読める形）
//     unmeasured＝送る前の判断の記録に sn が無く測れなかった竹内さん本人の番の数（木にも割合の分母にも入れない・P の頼みで並べて出す）
//   ⚠ 実物の約束の閉じ（closed_by）は今の値で見る（判断の後に閉じた印が付いた約束は「帳面が多い」に見える）＝ over の一部は数え方
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { sceneOfWatchKey } from "../app/lib/metric-map";
import { situationFieldsOf, situationTurns, buildSituationTree, truthOpenPromises, truthTimedViewings, SITUATION_FIELD_JA, SITUATION_MISS_JA, type SituationCheckRow } from "./lib/situation-check";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const days = Number(arg("days", "14")) || 14;
  const jstH = new Date(Date.now() + 9 * 36e5).getUTCHours();
  if (days > 14 && jstH >= 9 && jstH < 22 && !process.argv.includes("--force")) throw new Error("14日を超える読みは夜だけ（JST 22〜9時）。昼は --days=14 まで");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const turns: Array<{ id: number; conversation_id: string; customer_turn_at: string; staff_first_at: string | null; scene_key: string | null }> = [];
  for (let f = 0; f < 10000; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, staff_first_at, scene_key").gte("customer_turn_at", since).eq("verdict_detail->>staff_writer", "takeuchi").range(f, f + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as typeof turns)); if ((data ?? []).length < 1000) break;
  }
  const rows: SituationCheckRow[] = [];
  let noDigest = 0;
  for (let k = 0; k < turns.length; k += 4) await Promise.all(turns.slice(k, k + 4).map(async (t) => {
    const until = t.staff_first_at ?? new Date(Date.parse(t.customer_turn_at) + 3 * 36e5).toISOString();
    const { data: d } = await sb.from("brain_decision_logs").select("created_at, digest->sn").eq("conversation_id", t.conversation_id).gte("created_at", t.customer_turn_at).lte("created_at", until).not("digest->sn", "is", null).order("created_at", { ascending: false }).limit(1);
    const dec = ((d ?? []) as Array<{ created_at: string; sn: unknown }>)[0];
    if (!dec) { noDigest++; return; }
    const at = Date.parse(dec.created_at);
    const [{ data: facts }, { data: cal }] = await Promise.all([
      sb.from("sent_facts").select("kind, status, sent_at, detail").eq("conversation_id", t.conversation_id).gte("sent_at", new Date(at - 60 * 864e5).toISOString()).lte("sent_at", dec.created_at).limit(800),
      sb.from("calendar_events").select("start_at, all_day, created_at").eq("conversation_id", t.conversation_id).gte("start_at", new Date(at - 60 * 864e5).toISOString()).limit(200),
    ]);
    const f = situationFieldsOf(dec.sn);
    const scene = sceneOfWatchKey(t.scene_key);
    const id = `${t.conversation_id.slice(0, 8)}@${t.customer_turn_at.slice(0, 16)}`;
    if (typeof f.po === "number") rows.push({ id, scene, field: "po", got: f.po, truth: truthOpenPromises((facts ?? []) as never, at) });
    if (typeof f.tv === "number") rows.push({ id, scene, field: "tv", got: f.tv, truth: truthTimedViewings((cal ?? []) as never, at) });
  }));
  const st = situationTurns(rows);
  const nodes = buildSituationTree(st);
  const root = nodes[0];
  console.log(`現状把握の物差し（根 situation:match・${days}日・竹内さん本人の番 ${turns.length}・判断の記録の sn が無い番 ${noDigest}）: 欄×番 ${root?.n ?? 0}・実物と合う ${root?.ok ?? 0}（${root?.value ?? "—"}%）`);
  for (const x of nodes.slice(1)) {
    const label = x.dim === "kind" ? SITUATION_FIELD_JA[x.val as never] ?? x.val : x.dim === "miss" ? SITUATION_MISS_JA[x.val as never] ?? x.val : x.val;
    console.log(`${"  ".repeat(x.depth)}${x.dim}: ${label}  n=${x.n}・外れ ${x.misses}`);
  }
  const bad = rows.filter((r) => r.got !== r.truth).slice(0, 20);
  console.log(`\n外れの例（会話の頭8字@番・欄・帳面→実物）: ${bad.map((r) => `${r.id}:${r.field}:${r.got}→${r.truth}`).join(" ")}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ root: "situation:match", turns: st, nodes, unmeasured: noDigest, takeuchi_turns: turns.length }, null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
