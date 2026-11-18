// scripts/work-items.ts — 仕事の台帳（work_items・仕事1件＝1行で今の段）を見る・足す・段を進める（作業員M・2026-11-18）
//   竹内さん 11/18「その作業を全部把握するために必要な事は保管するようにデータベースを強化する」（統括役の頼み）。
//   work_log は経過を書き足す日誌、work_items は「何が終わっていないか」を1行で持つ台帳。段の変わりは work_item_events に1行ずつ。
//   段: todo → building → built_off → testing → passed → on → done（ほかに blocked・waiting_owner・dropped）
//   使い方（鍵のある .env で）:
//     --list [--stage=built_off] [--area=2通] [--owner=作業員M]      段ごとの残りの件数と上位
//     --add --title=... [--area= --origin= --stage= --owner= --switch= --switch-default= --priority= --quote= --next= --work-log-task= --kb=a,b]
//     --stage=<id> <新しい段> [--note=...] [--actor=作業員M] [--exam=<label> --result=<要約>] [--commit=<hash>]
//     --done-check                                                  見張り（on なのに READY の印が無い・built_off のまま7日・testing のまま3日・passed のまま3日）
//     --import=<json> [--dry]                                        scripts/unfinished-inventory.ts --json-out の行を一括で（switch_name か work_log_task が同じ行は更新）
//   お客様の文・名前は入れない。費用 0（LLM なし）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

export const STAGES = ["todo", "building", "built_off", "testing", "passed", "on", "done", "blocked", "waiting_owner", "dropped"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_JA: Record<Stage, string> = {
  todo: "まだ", building: "作っている", built_off: "作った（off）", testing: "試験中", passed: "悪化0", on: "既定 on", done: "本番 READY",
  blocked: "止まっている", waiting_owner: "竹内さん待ち", dropped: "やめた",
};
const ORDER: Stage[] = ["todo", "building", "built_off", "testing", "passed", "on"];
export const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);
/** 段の進み方の確かめ（純関数）: 前に戻る・飛ばすのは note が要る（戻った・止まった理由を残す） */
export function stageMoveNeedsNote(from: string | null, to: Stage): boolean {
  if (!from || !isStage(from)) return false;
  if (to === "blocked" || to === "dropped" || to === "waiting_owner") return true;
  const a = ORDER.indexOf(from as Stage), b = ORDER.indexOf(to);
  if (a < 0 || b < 0) return false;
  return b < a || b > a + 2;
}
/** 見張り（純関数）: 段と日付から気づく事 */
export function doneCheckOf(r: { id: number; title: string; stage: string; updated_at: string; commits?: string[] | null; next_step?: string | null }, nowMs = Date.now()): string | null {
  const days = (nowMs - Date.parse(r.updated_at)) / 86_400_000;
  if (r.stage === "on" && !(r.commits ?? []).length) return "既定 on なのにコミットの記録が無い（本番 READY を確かめて done に）";
  if (r.stage === "on" && days >= 2) return `既定 on のまま ${Math.floor(days)}日（本番 READY を確かめて done に）`;
  if (r.stage === "built_off" && days >= 7) return `作った（off）のまま ${Math.floor(days)}日（試験を積む・要らなければ dropped の案）`;
  if (r.stage === "testing" && days >= 3) return `試験中のまま ${Math.floor(days)}日（試験の結果を読む）`;
  if (r.stage === "passed" && days >= 3) return `悪化0 のまま ${Math.floor(days)}日（既定 on のコミット）`;
  if (r.stage === "building" && days >= 10) return `作っているまま ${Math.floor(days)}日（持ち主が居るか）`;
  return null;
}

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = (): SupabaseClient => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

async function cmdList() {
  let q = sb().from("work_items").select("id,title,area,stage,owner,priority,switch_name,next_step,updated_at").order("priority", { ascending: true, nullsFirst: false }).limit(2000);
  if (arg("stage")) q = q.eq("stage", arg("stage"));
  if (arg("area")) q = q.eq("area", arg("area"));
  if (arg("owner")) q = q.eq("owner", arg("owner"));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.stage, (by.get(r.stage) ?? 0) + 1);
  console.log(`仕事の台帳 ${rows.length}行: ${STAGES.filter((s) => by.get(s)).map((s) => `${STAGE_JA[s]} ${by.get(s)}`).join("・")}`);
  const left = rows.filter((r) => !["done", "dropped"].includes(r.stage));
  console.log(`残り ${left.length}（done・dropped を除く）`);
  for (const r of left.slice(0, Number(arg("top", "30")) || 30)) console.log(`- #${r.id} [${STAGE_JA[r.stage as Stage] ?? r.stage}] p${r.priority ?? "-"} ${r.area ?? ""} ${r.owner ?? ""}: ${String(r.title).slice(0, 80)}${r.next_step ? ` → ${String(r.next_step).slice(0, 60)}` : ""}`);
}

async function cmdAdd() {
  const title = arg("title");
  if (!title) throw new Error("--title= が要る");
  const stage = arg("stage", "todo");
  if (!isStage(stage)) throw new Error(`段が違う: ${stage}`);
  const row = {
    title, area: arg("area") || null, origin: arg("origin") || null, stage, owner: arg("owner") || null, switch_name: arg("switch") || null, switch_default: arg("switch-default") || null,
    priority: arg("priority") ? Number(arg("priority")) : null, requested_quote: arg("quote") || null, requested_at: arg("requested-at") || new Date().toISOString(),
    next_step: arg("next") || null, work_log_task: arg("work-log-task") || null, kb_ids: list(arg("kb")), quality_target: arg("quality") || null,
  };
  if (flag("dry")) { console.log(JSON.stringify(row)); return; }
  const { data, error } = await sb().from("work_items").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  await sb().from("work_item_events").insert({ item_id: data.id, from_stage: null, to_stage: stage, actor: arg("actor", "session"), note: arg("note") || "足した" });
  console.log(`足した #${data.id}`);
}

async function cmdStage() {
  const id = Number(arg("stage"));
  const to = argv.find((a) => !a.startsWith("--")) ?? "";
  if (!id || !isStage(to)) throw new Error("--stage=<id> <新しい段>（段: " + STAGES.join("/") + "）");
  const db = sb();
  const { data: cur, error } = await db.from("work_items").select("id,stage,commits,exam_labels").eq("id", id).single();
  if (error || !cur) throw new Error(error?.message ?? "無い");
  const note = arg("note");
  if (stageMoveNeedsNote(cur.stage, to) && !note) throw new Error(`段が戻る・飛ぶ・止まる時は --note= に理由を書く（${cur.stage} → ${to}）`);
  const patch: Record<string, unknown> = { stage: to, updated_at: new Date().toISOString() };
  if (to === "done") patch.done_at = new Date().toISOString();
  if (arg("exam")) patch.exam_labels = [...new Set([...(cur.exam_labels ?? []), arg("exam")])];
  if (arg("result")) patch.exam_result = arg("result");
  if (arg("commit")) patch.commits = [...new Set([...(cur.commits ?? []), arg("commit")])];
  if (arg("next")) patch.next_step = arg("next");
  if (arg("blocker")) patch.blocker = arg("blocker");
  if (flag("dry")) { console.log(JSON.stringify({ id, from: cur.stage, ...patch, note })); return; }
  const { error: e2 } = await db.from("work_items").update(patch).eq("id", id);
  if (e2) throw new Error(e2.message);
  await db.from("work_item_events").insert({ item_id: id, from_stage: cur.stage, to_stage: to, actor: arg("actor", "session"), note: note || null });
  console.log(`#${id}: ${cur.stage} → ${to}`);
}

async function cmdDoneCheck() {
  const { data, error } = await sb().from("work_items").select("id,title,stage,updated_at,commits,next_step").not("stage", "in", "(done,dropped)").limit(3000);
  if (error) throw new Error(error.message);
  let n = 0;
  for (const r of data ?? []) { const w = doneCheckOf(r); if (w) { n++; console.log(`- #${r.id} [${r.stage}] ${String(r.title).slice(0, 70)}: ${w}`); } }
  console.log(`見張り: ${n}件`);
}

async function cmdImport() {
  const rows = JSON.parse(readFileSync(arg("import"), "utf8")) as Array<Record<string, unknown>>;
  const dry = flag("dry");
  const db = dry ? (null as unknown as SupabaseClient) : sb();
  const keyOf = (r: Record<string, unknown>) => (r.switch_name ? `sw:${r.switch_name}` : r.work_log_task ? `wl:${r.work_log_task}` : `t:${r.title}`);
  // 今ある行（同じ鍵は更新）
  const have = new Map<string, { id: number; stage: string }>();
  if (!dry) {
    const { data, error } = await db.from("work_items").select("id,stage,switch_name,work_log_task,title").limit(5000);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) have.set(keyOf(r as Record<string, unknown>), { id: r.id, stage: r.stage });
  }
  let ins = 0, upd = 0;
  const byStage = new Map<string, number>();
  for (const r of rows) {
    if (!isStage(String(r.stage))) throw new Error(`段が違う: ${r.stage}（${r.title}）`);
    byStage.set(String(r.stage), (byStage.get(String(r.stage)) ?? 0) + 1);
    if (dry) continue;
    const h = have.get(keyOf(r));
    if (h) {
      // 段は人が進めた物を上書きしない（台帳の段が棚卸しより進んでいる時は残す）
      const { stage: _s, ...rest } = r;
      void _s;
      const { error } = await db.from("work_items").update({ ...rest, updated_at: new Date().toISOString() }).eq("id", h.id);
      if (error) throw new Error(error.message);
      upd++;
    } else {
      const { data, error } = await db.from("work_items").insert(r).select("id").single();
      if (error) throw new Error(`${error.message}（${r.title}）`);
      await db.from("work_item_events").insert({ item_id: data.id, from_stage: null, to_stage: r.stage, actor: arg("actor", "作業員M"), note: "棚卸し 11/18 から入れた" });
      ins++;
    }
  }
  console.log(`${dry ? "（見るだけ）" : ""}${rows.length}行: ${[...byStage].map(([s, n]) => `${STAGE_JA[s as Stage] ?? s} ${n}`).join("・")}${dry ? "" : `・足した ${ins}・更新 ${upd}`}`);
  if (dry) for (const r of rows.slice(0, Number(arg("top", "10")) || 10)) console.log(`  p${r.priority} [${r.stage}] ${r.area} ${r.owner ?? ""}: ${String(r.title).slice(0, 80)}`);
}

async function main() {
  if (flag("list")) return cmdList();
  if (flag("add")) return cmdAdd();
  if (arg("stage") && /^\d+$/.test(arg("stage"))) return cmdStage();
  if (flag("done-check")) return cmdDoneCheck();
  if (arg("import")) return cmdImport();
  console.log("使い方: --list ／ --add --title=... ／ --stage=<id> <新しい段> --note=... ／ --done-check ／ --import=<json> [--dry]");
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
