// scripts/work-log.ts — 作業の途中経過の台帳（work_log）を見る・足す
//   2026-10-24 竹内さん「会話大切な部分データベースにいれているのか」→「それでおねがい」。
//   決定は設計知見・質問は owner_questions・弱い所は brain_weaknesses に入っていたが、途中経過（どの作業がどこまで・次にやる事）は
//   手元の記憶ファイルにしか無く、別のフォルダで開いた時・PC が落ちた時に続きが分からなくなった。始めた時・区切り・止まる前に1行ずつ足す。
//
//   npx tsx --env-file=.env.local scripts/work-log.ts --latest [--days=14]        … 作業ごとの最新の状態（終わった物は除く）＋直近の10行
//   npx tsx --env-file=.env.local scripts/work-log.ts --task "<作業名>"            … その作業の履歴（古い順）
//   npx tsx --env-file=.env.local scripts/work-log.ts --add "<作業名>" --status=progress --summary="…" [--next="…"] [--waiting="…"] [--branch=…] [--commit=…] [--actor=session|worker:<名前>] [--dry]
//   status: started（始めた）・progress（区切り）・blocked（詰まった）・waiting_owner（竹内さんの答え待ち）・done（終わった）・stopped（やめた）
//   書くのはサーバーの鍵（RLS 有効・ポリシーなし）。お客様の文・名前は入れない。LINE には何も送らない。
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) { console.error("SUPABASE_SERVICE_ROLE_KEY が要ります（表は RLS 有効・公開キーでは読めない）"); process.exit(1); }
const sb = createClient(url, key);
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const arg = (f: string, d = "") => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3) ?? d;
const after = (f: string) => { const i = argv.indexOf(`--${f}`); return i < 0 ? [] : argv.slice(i + 1).filter((a) => !a.startsWith("--")); };
const DRY = has("dry");

const STATUSES = ["started", "progress", "blocked", "waiting_owner", "done", "stopped"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_JA: Record<Status, string> = { started: "始めた", progress: "途中", blocked: "詰まった", waiting_owner: "答え待ち", done: "終わった", stopped: "やめた" };
type Row = { id: number; created_at: string; task: string; status: Status; summary: string | null; next_step: string | null; waiting_on: string | null; branch: string | null; commit_ref: string | null; actor: string };

const jst = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function line(r: Row): string {
  const ref = [r.branch, r.commit_ref].filter(Boolean).join(" ");
  return `- ${jst(r.created_at)} [${STATUS_JA[r.status] ?? r.status}] ${r.task}${ref ? `（${ref}）` : ""}${r.actor !== "session" ? ` ・${r.actor}` : ""}`
    + (r.summary ? `\n    ${r.summary}` : "") + (r.next_step ? `\n    次: ${r.next_step}` : "") + (r.waiting_on ? `\n    待ち: ${r.waiting_on}` : "");
}

async function main() {
  if (has("latest")) {
    const days = Number(arg("days", "14")) || 14;
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { data, error } = await sb.from("work_log").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    const latest = new Map<string, Row>();
    for (const r of rows) if (!latest.has(r.task)) latest.set(r.task, r);
    const open = [...latest.values()].filter((r) => r.status !== "done" && r.status !== "stopped");
    console.log(`作業の途中経過（${days}日・続きのある作業 ${open.length}件）`);
    open.forEach((r) => console.log(line(r)));
    console.log(`\n直近の10行`);
    rows.slice(0, 10).forEach((r) => console.log(line(r)));
    return;
  }
  if (has("task")) {
    const t = after("task").join(" ").trim();
    if (!t) throw new Error('使い方: --task "<作業名>"');
    const { data, error } = await sb.from("work_log").select("*").eq("task", t).order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    console.log(`「${t}」の履歴 ${rows.length}行`);
    rows.forEach((r) => console.log(line(r)));
    return;
  }
  if (has("add")) {
    const task = after("add").join(" ").trim();
    const status = arg("status", "progress") as Status;
    if (!task) throw new Error('使い方: --add "<作業名>" --status=progress --summary="…"');
    if (!STATUSES.includes(status)) throw new Error(`status は ${STATUSES.join("/")}`);
    const row = {
      task, status,
      summary: arg("summary") || null, next_step: arg("next") || null, waiting_on: arg("waiting") || null,
      branch: arg("branch") || null, commit_ref: arg("commit") || null, actor: arg("actor", "session"),
      session_id: process.env.CLAUDE_SESSION_ID || null,
    };
    if (DRY) { console.log("入る行（dry）:", JSON.stringify(row)); return; }
    const { error } = await sb.from("work_log").insert([row]);
    if (error) throw new Error(error.message);
    console.log(`足しました: [${STATUS_JA[status]}] ${task}`);
    return;
  }
  console.log(readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
