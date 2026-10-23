// scripts/exam-savings.ts — 試験の節約できる案の台帳（exam_savings）を見る・見つける・状態を変える
//   2026-10-23 竹内さん「無駄な部分優先して改善する」「テスト回すブレインに節約できる案のデータベース作って」「テスト回しながら節約できるにＭつかれば自己改善できるように」
//
//   npx tsx --env-file=.env.local scripts/exam-savings.ts --open                     … 開いている案（未着手・竹内さんの判断待ち）を $ の大きい順に
//   npx tsx --env-file=.env.local scripts/exam-savings.ts --list                     … 全部（状態ごと）
//   npx tsx --env-file=.env.local scripts/exam-savings.ts --detect [--days=1] [--write] … 無駄を見つける（既定は下見＝書かない・--write で今日の分を数え直して書く）
//   npx tsx --env-file=.env.local scripts/exam-savings.ts --seed [--dry]             … 10/23 に分かっていた6つを入れる（ある鍵は触らない・質に関わる案は竹内さんへの質問も）
//   npx tsx --env-file=.env.local scripts/exam-savings.ts --set-status <key> <open|auto_applied|needs_owner|fixed|wont_fix> [--ref=<commit・スイッチ>] [--dry]
//   npx tsx --env-file=.env.local scripts/exam-savings.ts --auto                     … 自動で戻すスイッチの一覧（.claude/exam-cache/exam-brain/savings-auto.json）
//   試験の終わり（scripts/exam-brain.ts）と --spend-today でも自動で見つけて書く。止める: EXAM_SAVINGS_LEDGER=off（書かない）・EXAM_SAVINGS_AUTO=off（スイッチを自動で戻さない）
//   LLM は呼ばない・$0。書くのはサーバーの鍵（RLS 有効・ポリシーなし）。お客様の文は入れない。LINE には何も送らない。
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { SAVING_STATUSES, SAVING_STATUS_JA, SAVING_KIND_JA, SEED_SAVINGS, type SavingRow, type SavingStatus } from "../app/lib/exam-savings";
import { addOwnerQuestions, SAVING_COLS } from "../app/lib/exam-savings-server";
import { detectAndRecord, readAutoFile, SAVINGS_AUTO_FILE } from "./lib/exam-savings-io";
import { jstDayStart } from "./lib/exam-brain";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) { console.error("SUPABASE_SERVICE_ROLE_KEY が要ります（表は RLS 有効・公開キーでは読めない）"); process.exit(1); }
const sb = createClient(url, key);
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const arg = (f: string, d = "") => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3) ?? d;
const after = (f: string) => { const i = argv.indexOf(`--${f}`); return i < 0 ? [] : argv.slice(i + 1).filter((a) => !a.startsWith("--")); };
const DRY = has("dry");

async function all(): Promise<SavingRow[]> {
  const { data, error } = await sb.from("exam_savings").select(SAVING_COLS).order("est_usd_per_day", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as SavingRow[];
}
function line(r: SavingRow): string {
  const ev = r.evidence ?? {};
  const evs = [ev.run_labels?.length ? `回 ${ev.run_labels.slice(0, 4).join(",")}` : "", ev.actions?.length ? `action ${ev.actions.slice(0, 3).join(",")}` : "", ev.versions?.length ? `版 ${ev.versions.slice(0, 3).join(",")}` : "",
    ev.ids?.length ? `問題 ${ev.ids.slice(0, 6).join(",")}` : "", ev.switches?.length ? `スイッチ ${ev.switches.join(",")}` : "", ev.days ? `日 ${Object.entries(ev.days).map(([d, u]) => `${d.slice(5)} $${u}`).join(" ")}` : ""].filter(Boolean).join("・");
  return `- [${SAVING_STATUS_JA[r.status] ?? r.status}${r.safe ? "" : "・質に関わる"}] 約 $${Number(r.est_usd_per_day).toFixed(2)}/日 ${r.title}（${r.key}・${SAVING_KIND_JA[r.kind] ?? r.kind}）${r.occurrences}回${r.fix_ref ? ` → ${r.fix_ref}` : ""}${r.detail ? `\n    ${r.detail}` : ""}${evs ? `\n    印: ${evs}` : ""}`;
}

async function main() {
  if (has("open") || has("list")) {
    const rows = (await all()).filter((r) => has("list") || r.status === "open" || r.status === "needs_owner");
    const order: SavingStatus[] = has("list") ? [...SAVING_STATUSES] : ["open", "needs_owner"];
    console.log(`試験の節約できる案（${has("list") ? "全部" : "開いている物"} ${rows.length}件・合わせて約 $${rows.reduce((s, r) => s + Number(r.est_usd_per_day), 0).toFixed(2)}/日）`);
    for (const st of order) { const g = rows.filter((r) => r.status === st); if (!g.length) continue; console.log(`\n■ ${SAVING_STATUS_JA[st]}（${g.length}）`); g.forEach((r) => console.log(line(r))); }
    return;
  }
  if (has("detect")) {
    const days = Math.max(1, Number(arg("days", "1")) || 1);
    const since = new Date(jstDayStart(new Date()).getTime() - (days - 1) * 86_400_000);
    if (has("write") && days > 1) throw new Error("--write は今日（--days=1）だけ（日ごとの $ を上書きするため）");
    const r = await detectAndRecord(sb, { since, write: has("write"), mode: "set" });
    console.log(`見る範囲: ${since.toISOString()} 〜（${days}日）`);
    console.log(r.text);
    return;
  }
  if (has("seed")) {
    const { data, error } = await sb.from("exam_savings").select("key");
    if (error) throw new Error(error.message);
    const have = new Set(((data ?? []) as Array<{ key: string }>).map((r) => r.key));
    const day = "2026-10-23", at = "2026-10-23T00:00:00+09:00", now = new Date().toISOString();
    const rows = SEED_SAVINGS.filter((s) => !have.has(s.key)).map((s) => ({ ...s, evidence: s.est_usd_per_day > 0 ? { days: { [day]: s.est_usd_per_day } } : {}, occurrences: 1, first_seen: at, last_seen: at, updated_at: now }));
    console.log(`種 ${SEED_SAVINGS.length}個のうち入れる ${rows.length}個（ある ${SEED_SAVINGS.length - rows.length}）`);
    for (const r of rows) console.log(`  + [${SAVING_STATUS_JA[r.status]}] 約 $${r.est_usd_per_day}/日 ${r.key} ${r.title}`);
    if (DRY || !rows.length) return;
    const { error: e2 } = await sb.from("exam_savings").insert(rows);
    if (e2) throw new Error(e2.message);
    const owner = rows.filter((r) => r.status === "needs_owner");
    const q = await addOwnerQuestions(sb, owner);
    console.log(`入れました（竹内さんへの質問 ${q}件を足した）`);
    return;
  }
  if (has("set-status")) {
    const [k, st] = after("set-status");
    if (!k || !SAVING_STATUSES.includes(st as SavingStatus)) throw new Error(`使い方: --set-status <key> <${SAVING_STATUSES.join("|")}> [--ref=…]`);
    const { data, error } = await sb.from("exam_savings").select("key, title, status").eq("key", k).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`鍵が無い: ${k}`);
    const patch: Record<string, unknown> = { status: st, updated_at: new Date().toISOString() };
    if (arg("ref")) patch.fix_ref = arg("ref");
    if (DRY) { console.log(`更新（dry）: ${k} ${(data as { status: string }).status}→${st}`, JSON.stringify(patch)); return; }
    const { error: e2 } = await sb.from("exam_savings").update(patch).eq("key", k);
    if (e2) throw new Error(e2.message);
    console.log(`状態を変えました: ${(data as { title: string }).title}（${k}）${SAVING_STATUS_JA[(data as { status: SavingStatus }).status]}→${SAVING_STATUS_JA[st as SavingStatus]}`);
    return;
  }
  if (has("auto")) {
    const f = readAutoFile();
    console.log(`自動で戻すスイッチ（${SAVINGS_AUTO_FILE}・止める EXAM_SAVINGS_AUTO=off）: ${f.applied.length}件`);
    for (const a of f.applied) console.log(`  ${a.at.slice(0, 16)} ${a.from} → ${a.value ?? "既定"}（${a.key}・${a.why}）`);
    return;
  }
  console.log(readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
