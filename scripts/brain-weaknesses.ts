// scripts/brain-weaknesses.ts — ブレインの弱い所の台帳（brain_weaknesses）を見る・足す・状態を変える
//   2026-10-23 竹内さん「ブレイン弱い部分見つかったらメモ入れていく…根本から改善繰り返していけば精度完全に強くなっていく」
//
//   npx tsx --env-file=.env.local scripts/brain-weaknesses.ts --open                       … 開いている物（未着手・作業中）を数の多い順に
//   npx tsx --env-file=.env.local scripts/brain-weaknesses.ts --list                       … 全部（状態ごと）
//   npx tsx --env-file=.env.local scripts/brain-weaknesses.ts --seed [--dry]               … 10/23 の一覧の21個を入れる（ある鍵は触らない）
//   npx tsx --env-file=.env.local scripts/brain-weaknesses.ts --add <key> "<題>" --area=brain [--symptom=…] [--root=…] [--status=open] [--ref=…] [--dry]
//   npx tsx --env-file=.env.local scripts/brain-weaknesses.ts --set-status <key> <open|in_progress|fixed|wont_fix> [--ref=<commit・スイッチ>] [--root=…] [--dry]
//   npx tsx --env-file=.env.local scripts/brain-weaknesses.ts --collect-exam [--dry]       … 手元の試験の外れの理由（reasons-latest.json）を足す（同じ回は二重に足さない）
//   書くのはサーバーの鍵（RLS 有効・ポリシーなし）。お客様の文・名前は入れない（印＝問題 id・番 id だけ）。LINE には何も送らない。
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEED_WEAKNESSES, STATUS_JA, AREA_JA, WEAKNESS_STATUSES, WEAKNESS_AREAS, isWeaknessKey, weaknessHitsFromExamReasons, type WeaknessArea, type WeaknessRow, type WeaknessStatus } from "../app/lib/brain-weaknesses";
import { recordExamWeaknesses } from "../app/lib/brain-weaknesses-server";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) { console.error("SUPABASE_SERVICE_ROLE_KEY が要ります（表は RLS 有効・公開キーでは読めない）"); process.exit(1); }
const sb = createClient(url, key);
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const arg = (f: string, d = "") => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3) ?? d;
const after = (f: string) => { const i = argv.indexOf(`--${f}`); return i < 0 ? [] : argv.slice(i + 1).filter((a) => !a.startsWith("--")); };
const DRY = has("dry");

async function all(): Promise<WeaknessRow[]> {
  const { data, error } = await sb.from("brain_weaknesses").select("*").order("occurrences", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as WeaknessRow[];
}
function line(r: WeaknessRow): string {
  const ev = r.evidence ?? {};
  const evs = [ev.exam_qids?.length ? `試験 ${ev.exam_qids.slice(0, 5).join(",")}` : "", ev.watch_turn_ids?.length ? `番 ${ev.watch_turn_ids.slice(0, 5).join(",")}` : "", ev.unknown_ids?.length ? `分からない事 ${ev.unknown_ids.slice(0, 5).join(",")}` : ""].filter(Boolean).join("・");
  return `- [${STATUS_JA[r.status] ?? r.status}・${AREA_JA[r.area] ?? r.area}] ${r.title}（${r.key}）通算 ${r.occurrences}${r.last_seen ? `・最後 ${r.last_seen.slice(0, 10)}` : ""}${r.fix_ref ? ` → ${r.fix_ref}` : ""}${evs ? `\n    印: ${evs}` : ""}`;
}

async function main() {
  if (has("open") || has("list")) {
    const rows = (await all()).filter((r) => has("list") || r.status === "open" || r.status === "in_progress");
    const order: WeaknessStatus[] = has("list") ? [...WEAKNESS_STATUSES] : ["in_progress", "open"];
    console.log(`ブレインの弱い所（${has("list") ? "全部" : "開いている物"} ${rows.length}件）`);
    for (const st of order) { const g = rows.filter((r) => r.status === st); if (!g.length) continue; console.log(`\n■ ${STATUS_JA[st]}（${g.length}）`); g.forEach((r) => console.log(line(r))); }
    return;
  }
  if (has("seed")) {
    const { data, error } = await sb.from("brain_weaknesses").select("key");
    if (error) throw new Error(error.message);
    const have = new Set(((data ?? []) as Array<{ key: string }>).map((r) => r.key));
    const now = new Date().toISOString();
    const rows = SEED_WEAKNESSES.filter((s) => !have.has(s.key)).map((s) => ({ ...s, evidence: {}, occurrences: 1, first_seen: "2026-10-23T00:00:00+09:00", last_seen: "2026-10-23T00:00:00+09:00", updated_at: now }));
    console.log(`種 ${SEED_WEAKNESSES.length}個のうち入れる ${rows.length}個（ある ${SEED_WEAKNESSES.length - rows.length}）`);
    for (const r of rows) console.log(`  + [${STATUS_JA[r.status]}] ${r.key} ${r.title}`);
    if (DRY || !rows.length) return;
    const { error: e2 } = await sb.from("brain_weaknesses").insert(rows);
    if (e2) throw new Error(e2.message);
    console.log("入れました");
    return;
  }
  if (has("add")) {
    const [k, ...rest] = after("add");
    const title = rest.join(" ").trim();
    const area = arg("area", "brain") as WeaknessArea;
    const status = arg("status", "open") as WeaknessStatus;
    if (!k || !title) throw new Error('使い方: --add <key> "<題>" --area=brain');
    if (!isWeaknessKey(k)) throw new Error(`鍵の形が違う（英小文字・数字・: _ - で2〜80字）: ${k}`);
    if (!WEAKNESS_AREAS.includes(area)) throw new Error(`area は ${WEAKNESS_AREAS.join("/")}`);
    if (!WEAKNESS_STATUSES.includes(status)) throw new Error(`status は ${WEAKNESS_STATUSES.join("/")}`);
    const now = new Date().toISOString();
    const row = { key: k, title, area, status, symptom: arg("symptom") || null, root_cause: arg("root") || null, fix_ref: arg("ref") || null, evidence: {}, occurrences: 1, first_seen: now, last_seen: now, updated_at: now };
    if (DRY) { console.log("入る行（dry）:", JSON.stringify(row)); return; }
    const { error } = await sb.from("brain_weaknesses").insert([row]);
    if (error) throw new Error(error.message);
    console.log(`足しました: ${k} ${title}`);
    return;
  }
  if (has("set-status")) {
    const [k, st] = after("set-status");
    if (!k || !WEAKNESS_STATUSES.includes(st as WeaknessStatus)) throw new Error(`使い方: --set-status <key> <${WEAKNESS_STATUSES.join("|")}> [--ref=…]`);
    const { data, error } = await sb.from("brain_weaknesses").select("key, title, status").eq("key", k).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`鍵が無い: ${k}`);
    const patch: Record<string, unknown> = { status: st, updated_at: new Date().toISOString() };
    if (arg("ref")) patch.fix_ref = arg("ref");
    if (arg("root")) patch.root_cause = arg("root");
    if (DRY) { console.log(`更新（dry）: ${k} ${(data as { status: string }).status}→${st}`, JSON.stringify(patch)); return; }
    const { error: e2 } = await sb.from("brain_weaknesses").update(patch).eq("key", k);
    if (e2) throw new Error(e2.message);
    console.log(`状態を変えました: ${(data as { title: string }).title}（${k}）${STATUS_JA[(data as { status: WeaknessStatus }).status]}→${STATUS_JA[st as WeaknessStatus]}`);
    return;
  }
  if (has("collect-exam")) {
    const rel = join(".claude", "exam-cache", "exam-brain", "conductor", "reasons-latest.json");
    const file = [join(process.cwd(), rel), join(process.cwd(), "..", "..", "..", rel)].find((p) => existsSync(p));
    if (!file) { console.log("試験の外れの理由のファイルが無い（reasons-latest.json）"); return; }
    const rec = JSON.parse(readFileSync(file, "utf8")) as { label?: string; at?: string; reasons?: Array<{ id: string; kind: string }> };
    const label = rec.label ?? "unknown";
    console.log(await recordExamWeaknesses(sb, label, weaknessHitsFromExamReasons(label, rec.reasons ?? [], rec.at), { dry: DRY }));
    return;
  }
  console.log(readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
