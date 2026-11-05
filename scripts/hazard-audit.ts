// scripts/hazard-audit.ts — 危ない所・抜けの同じ型を毎日見つける見張り（読むだけ・LLM なし・DB は軽く1本だけ・本番の DB に書かない）
//
// 2026-11-04 作業員6（竹内さんの決定 KB P1 a504029a「危ない所・抜けは同じ型を毎日自動で見つける見張りに足す」・dev_team_playbook の「事故を防ぐ決まり」と揃える）。
//   11/04 の8件の型ごとに、台本で見つけられる物をここに置く（台本で見つからない型は memory/hazard_checklist.md に1行）:
//   (a) 既定 off で竹内さんの決定があるスイッチ（取り残し）の前日との差分 … ④（作業員1の off-switch-inventory と同じ見つけ方）
//   (b) app/ と scripts/ の Supabase の頁なしの1回読み（大きな表・.limit(1000 超)）… ③（1000行で黙って切れる）
//   (c) 作業ツリーの node_modules がリンク（ジャンクション）か・本体の node_modules の件数 … ①（写しを消すと本体の中身が消える）
//   (d) publication の行の条件の列が replica identity に入っているか … ⑤（入っていないと本番の UPDATE が断られる）
//   (e) 本番の LP の「◯月実績」が今月か … ⑦（表示が止まったまま）
//   (f) main の最近のコミットの前に tsc-remote 0 があるか … ⑥（型の確認の前にコミット）
//   (i) 試験の係の記録の24時間: 止める印から猶予の内に止まらず殺した回・古い作業ツリーの依頼（点検表 10・12）
//   (l) 手元の problems.json の問題と main の spec の同じ id の正解の中身が違う（id のぶつかり・作業員4の気付き）
//   (k) 作業ツリーの手元の problems.json に同じ id が2つ以上ある（同じ問題を2回ずつ回す・点検表 13）
//   (j) 24時間の試験の出力で、レーンが同じ会話を2本以上取った行（点検表 11）
//   (h) 分からない事の3つの表（brain_weaknesses・brain_unknowns・owner_questions）の開いている数と新しく増えた数（夜の cron の数・KB 3892c30c）
//   (m) 試験の写しの property_pickups を相場の観測（rent_observations）に通さない前提が trigger の定義のままか（弱い所 303）
//   (n) 24時間の DeepSeek の失敗（402＝残高切れ・alt_failed）を本番と試験に分けて（11/05 残高切れで資料の読み取りが失敗）
//   (o) scripts/ で DeepSeek を直接呼ぶのに申込の線（loadDeepseekCutoff 等）を通していない台本（11/05 の読み直しの dry-read・点検表 17）
//   (p) DB の is_exam_conversation（相場の観測の歯止め・11/05 案A）が TS の試験の会話の一覧と同じか
//   (g) 48時間の試験の結果で「悪化0」なのに前（main）と両方で解いた問題が予定より少ない（0 含む）物 … ⑨（比べていないのに悪化0）
// 出力: 1行のまとめ（毎朝の見張りに貼る）＋詳しい所。前日との差分の為の控えは .claude/exam-cache/hazard-audit/（git に入らない）。
// 実行: npx tsx --env-file=.env.local scripts/hazard-audit.ts [--json] [--no-db] [--no-net] [--save]
//   --save … 今日の控えを書く（(a)(b) の差分の元）。毎朝の見張りは --save 付きで1回
// テスト: scripts/lib/__tests__/hazard-audit-core.test.ts（見つけ方の純関数）
import { readdirSync, readFileSync, lstatSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { pickupTriggerStillSkips } from "./lib/exam-pickup-copy";
import { findOffSwitches, findUnpagedReads, lpMonthOk, commitsWithoutTsc, rowFilterMissingCols, hollowNoWorse, unknownsOpenLine, conductorLogHazards, laneDupConvs, dupProblemIds, idContentClashes, deepseekFailLine, deepseekWithoutCutoff, examConvMismatch, type OffSwitch, type UnpagedRead } from "./lib/hazard-audit-core";

const flag = (k: string) => process.argv.includes(`--${k}`);
const git = (args: string[], cwd = process.cwd()) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const repoRoot = (() => { try { return join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), ".."); } catch { return process.cwd(); } })();
const here = process.cwd();
const SNAP_DIR = join(repoRoot, ".claude", "exam-cache", "hazard-audit");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "__tests__") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const readFiles = (dirs: string[]) => dirs.flatMap((d) => walk(join(here, d))).map((f) => ({ file: relative(here, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));

type Check = { key: string; ok: boolean | null; line: string; detail: string[] };

async function main() {
  const checks: Check[] = [];
  const files = readFiles(["app"]);
  const scriptFiles = readFiles(["scripts"]);
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
  const prevFile = join(SNAP_DIR, "last.json");
  const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, "utf8")) as { off?: OffSwitch[]; unpaged?: UnpagedRead[] } : {};

  // (a) 既定 off で竹内さんの決定があるスイッチ
  const off = findOffSwitches(files).filter((s) => s.decided);
  const prevOff = new Set((prev.off ?? []).map((s) => s.name));
  const newOff = off.filter((s) => !prevOff.has(s.name));
  const goneOff = (prev.off ?? []).filter((s) => !off.some((x) => x.name === s.name));
  checks.push({ key: "a", ok: newOff.length === 0, line: `既定offの決定スイッチ ${off.length}本（新+${newOff.length}・on/消-${goneOff.length}）`,
    detail: [...newOff.map((s) => `新: ${s.name}（${s.where}・${s.why}）`), ...goneOff.map((s) => `済: ${s.name}`)] });

  // (b) 頁なしの1回読み
  const unpaged = [...findUnpagedReads(files), ...findUnpagedReads(scriptFiles)];
  const prevUn = new Set((prev.unpaged ?? []).map((u) => `${u.file}|${u.table}|${u.snippet}`));
  const newUn = unpaged.filter((u) => !prevUn.has(`${u.file}|${u.table}|${u.snippet}`));
  checks.push({ key: "b", ok: newUn.length === 0, line: `頁なしの1回読み ${unpaged.length}か所（新+${newUn.length}）`,
    detail: newUn.slice(0, 30).map((u) => `${u.file}:${u.line} ${u.table} ${u.why}`) });

  // (c) 作業ツリーの node_modules
  const wtDir = join(repoRoot, ".claude", "worktrees");
  const links: string[] = [];
  if (existsSync(wtDir)) for (const d of readdirSync(wtDir)) {
    const nm = join(wtDir, d, "node_modules");
    try { if (lstatSync(nm).isSymbolicLink()) links.push(d); } catch { /* 無い */ }
  }
  let mainCount = -1;
  try { mainCount = readdirSync(join(repoRoot, "node_modules")).length; } catch { mainCount = 0; }
  const mainOk = mainCount > 100;
  checks.push({ key: "c", ok: mainOk, line: `本体 node_modules ${mainCount}件${mainOk ? "" : "（空・少ない）"}・リンクの作業ツリー ${links.length}（消す前にリンクを外す）`, detail: links.map((d) => `リンク: ${d}`) });

  // (d) publication の行の条件の列 × replica identity（DB を1本だけ・exec_sql は使わず読み専用の関数が無ければ「不明」）
  if (flag("no-db")) checks.push({ key: "d", ok: null, line: "publication の条件の列: 見ない（--no-db）", detail: [] });
  else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) checks.push({ key: "d", ok: null, line: "publication の条件の列: 不明（サーバーの鍵が無い）", detail: [] });
    else {
      const sb = createClient(url, key);
      // replica identity の列: d＝主キー・i＝指定の索引・f＝全部・n＝無し
      const sql = `select pt.tablename, pt.rowfilter, c.relreplident,
        coalesce((select array_agg(a.attname::text) from pg_index ix join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
          where ix.indrelid = c.oid and ((c.relreplident = 'd' and ix.indisprimary) or (c.relreplident = 'i' and ix.indisreplident))), '{}') as idcols
        from pg_publication_tables pt join pg_class c on c.relname = pt.tablename join pg_namespace n on n.oid = c.relnamespace and n.nspname = pt.schemaname
        where pt.rowfilter is not null`;
      const { data, error } = await sb.rpc("exec_sql", { sql });
      if (error) checks.push({ key: "d", ok: null, line: `publication の条件の列: 不明（${error.message.slice(0, 60)}）`, detail: [] });
      else {
        const rows = (Array.isArray(data) ? data : []) as Array<{ tablename: string; rowfilter: string; relreplident: string; idcols: string[] }>;
        const bad = rows.map((r) => ({ r, miss: rowFilterMissingCols(r.rowfilter, r.relreplident, r.idcols) })).filter((x) => x.miss.length);
        checks.push({ key: "d", ok: bad.length === 0, line: `publication の行の条件 ${rows.length}表（条件の列が replica identity に無い ${bad.length}）`,
          detail: bad.map((x) => `${x.r.tablename}: 無い列 ${x.miss.join(",")}（identity=${x.r.relreplident}）`) });
      }
    }
  }

  // (m) 2026-11-05 弱い所 303: 試験の写しの property_pickups が相場の観測に入らない前提（brain-exam の名前を後で入れる形・exam-pickup-copy.ts）が、trigger の定義のままか
  //   見る所: trigger の UPDATE OF の列に property_name が無い・関数の先頭の「名前が空なら RETURN」。崩れたら試験の行が rent_observations に入る（静かに壊れる）
  if (flag("no-db")) checks.push({ key: "m", ok: null, line: "相場の観測の trigger: 見ない（--no-db）", detail: [] });
  else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) checks.push({ key: "m", ok: null, line: "相場の観測の trigger: 不明（サーバーの鍵が無い）", detail: [] });
    else {
      const sql = `select (select pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'property_pickups' and t.tgname = 'rent_observe_pickup_trg') as trg,
        (select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'rent_observe_pickup_apply' limit 1) as fn`;
      const { data, error } = await createClient(url, key).rpc("exec_sql", { sql });
      const row = (Array.isArray(data) ? data[0] : null) as { trg: string | null; fn: string | null } | null;
      if (error || !row) checks.push({ key: "m", ok: null, line: `相場の観測の trigger: 不明（${(error?.message ?? "行なし").slice(0, 60)}）`, detail: [] });
      else {
        const v = pickupTriggerStillSkips(row.trg ?? "", row.fn ?? "");
        checks.push({ key: "m", ok: v.ok, line: `相場の観測の trigger（試験の写しを通さない前提）${v.ok ? "そのまま" : `崩れた ${v.why.length}`}`, detail: v.why });
      }
    }
  }

  // (n) 2026-11-05 DeepSeek の失敗（402＝残高切れ）の24時間の数（llm_usage_logs・数えるだけ）
  if (flag("no-db")) checks.push({ key: "n", ok: null, line: "DeepSeek の失敗: 見ない（--no-db）", detail: [] });
  else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) checks.push({ key: "n", ok: null, line: "DeepSeek の失敗: 不明（鍵が無い）", detail: [] });
    else {
      const db = createClient(url, key);
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const cnt = async (prod: boolean, f: "402" | "alt") => {
        let q = db.from("llm_usage_logs").select("id", { count: "exact", head: true }).gte("created_at", since).like("model", "deepseek%");
        q = prod ? q.eq("env", "production") : q.neq("env", "production");
        q = f === "402" ? q.eq("status", 402) : q.eq("error_type", "alt_failed");
        const { count, error } = await q;
        if (error) throw new Error(error.message);
        return count ?? 0;
      };
      try {
        const [prod402, prodAltFailed, test402, testAltFailed] = await Promise.all([cnt(true, "402"), cnt(true, "alt"), cnt(false, "402"), cnt(false, "alt")]);
        const v = deepseekFailLine({ prod402, prodAltFailed, test402, testAltFailed });
        checks.push({ key: "n", ok: v.ok, line: v.line, detail: v.ok ? [] : [v.line] });
      } catch (e) { checks.push({ key: "n", ok: null, line: `DeepSeek の失敗: 不明（${String(e).slice(0, 60)}）`, detail: [] }); }
    }
  }

  // (o) 2026-11-05 scripts/ で DeepSeek を直接呼ぶのに申込の線（loadDeepseekCutoff 等）を通していない台本（点検表 17）
  {
    const bad = readFiles(["scripts"]).filter((f) => deepseekWithoutCutoff(f.text)).map((f) => f.file);
    checks.push({ key: "o", ok: bad.length === 0, line: `DeepSeek を呼ぶのに申込の線を通さない台本 ${bad.length}`, detail: bad });
  }

  // (p) 2026-11-05 DB の is_exam_conversation（相場の観測の歯止め）が TS の試験の会話の一覧と同じか
  if (flag("no-db")) checks.push({ key: "p", ok: null, line: "試験の会話の決まり（DB）: 見ない（--no-db）", detail: [] });
  else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) checks.push({ key: "p", ok: null, line: "試験の会話の決まり（DB）: 不明（サーバーの鍵が無い）", detail: [] });
    else {
      const { data, error } = await createClient(url, key).rpc("exec_sql", { sql: "select id from conversations where is_exam_conversation(id)" });
      if (error) checks.push({ key: "p", ok: null, line: `試験の会話の決まり（DB）: 不明（${error.message.slice(0, 60)}）`, detail: [] });
      else {
        const { YUMA_CONVERSATION_ID, NO_LINE_TEST_CONVERSATION_IDS } = await import("../app/lib/test-conversations");
        const m = examConvMismatch([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS], ((Array.isArray(data) ? data : []) as Array<{ id: string }>).map((r) => r.id));
        const n = m.missingInDb.length + m.extraInDb.length;
        checks.push({ key: "p", ok: n === 0, line: `試験の会話の決まり（DB と TS）${n ? `食い違い ${n}` : "一致"}`, detail: [...m.missingInDb.map((x) => `DB で試験と見ない: ${x}`), ...m.extraInDb.map((x) => `TS に無いのに試験と見る: ${x}`)] });
      }
    }
  }

  // (e) 本番の LP の「◯月実績」
  if (flag("no-net")) checks.push({ key: "e", ok: null, line: "LP の月: 見ない（--no-net）", detail: [] });
  else {
    const det: string[] = []; let okAll = true;
    for (const page of ["iyeyasu.html", "giga-chintai.html"]) {
      try {
        const html = await (await fetch(`https://sumora-ai-ui.vercel.app/${page}`)).text();
        const js = await (await fetch(`https://sumora-ai-ui.vercel.app/lp-evidence.js`)).text();
        const r = lpMonthOk(html, js, new Date());
        if (!r.ok) okAll = false;
        det.push(`${page}: ${r.why}`);
      } catch (e) { okAll = false; det.push(`${page}: 読めない（${String(e).slice(0, 60)}）`); }
    }
    checks.push({ key: "e", ok: okAll, line: `LP の「◯月実績」${okAll ? "今月" : "ずれ・読めない"}`, detail: det });
  }

  // (f) main の最近のコミットの前に tsc-remote 0 があるか（24時間・.ts を変えたコミットだけ）
  const resultsMd = join(repoRoot, ".claude", "exam-cache", "exam-queue", "results", "results.md");
  const tscOk = existsSync(resultsMd) ? readFileSync(resultsMd, "utf8").split("\n").filter((l) => /\| tsc-remote \|/.test(l) && /tsc 0/.test(l)).map((l) => l.split("|")[1].trim()) : [];
  let commits: Array<{ sha: string; at: string; subject: string; ts: boolean }> = [];
  try {
    const log = git(["log", "origin/main", "--since=24 hours ago", "--format=%H%x09%cI%x09%s", "--name-only"], repoRoot);
    let cur: { sha: string; at: string; subject: string; ts: boolean } | null = null;
    for (const l of log.split("\n")) {
      const m = l.split("\t");
      if (m.length === 3 && /^[0-9a-f]{40}$/.test(m[0])) { if (cur) commits.push(cur); cur = { sha: m[0], at: m[1], subject: m[2], ts: false }; }
      else if (cur && /\.(ts|tsx)$/.test(l.trim())) cur.ts = true;
    }
    if (cur) commits.push(cur);
  } catch { commits = []; }
  const noTsc = commitsWithoutTsc(commits.filter((c) => c.ts), tscOk);
  checks.push({ key: "f", ok: noTsc.length === 0, line: `24時間の .ts のコミット ${commits.filter((c) => c.ts).length}（前6時間に tsc-remote 0 が無い ${noTsc.length}）`,
    detail: noTsc.map((c) => `${c.sha.slice(0, 8)} ${c.at} ${c.subject.slice(0, 60)}`) });

  // (g) 試験の結果の「悪化0」が本当に比べた物か（results/*.json の最新・48時間・brain-exam の依頼だけ。両方で解いた数は out.log の集計の最後）
  {
    const rdir = join(repoRoot, ".claude", "exam-cache", "exam-queue", "results");
    const since = new Date(Date.now() - 48 * 3600_000).toISOString();
    const rows: Array<{ label: string; at: string; verdict: string; planned: number; both: number | null }> = [];
    if (existsSync(rdir)) for (const f of readdirSync(rdir).filter((x) => x.endsWith(".json") && !x.endsWith(".reps.json"))) {
      try {
        const j = JSON.parse(readFileSync(join(rdir, f), "utf8")) as { label?: string; at?: string; verdict?: string; only?: string; runner?: string };
        if (!j.label || !j.at || j.at < since || (j.runner && j.runner !== "brain-exam")) continue;
        const lf = join(rdir, `${j.label}.out.log`);
        const ms = existsSync(lf) ? [...readFileSync(lf, "utf8").matchAll(/両方で解いた (\d+) 問/g)] : [];
        rows.push({ label: j.label, at: j.at, verdict: j.verdict ?? "", planned: String(j.only ?? "").split(",").filter(Boolean).length, both: ms.length ? Number(ms[ms.length - 1][1]) : null });
      } catch { /* 読めない結果は飛ばす */ }
    }
    const hollow = hollowNoWorse(rows);
    checks.push({ key: "g", ok: hollow.length === 0, line: `48時間の試験の「悪化0」${rows.filter((r) => /悪化0/.test(r.verdict)).length}本（両方で解いた問題が予定より少ない ${hollow.length}）`,
      detail: hollow.map((r) => `${r.at.slice(0, 16)} ${r.label} 両方で解いた ${r.both ?? "?"}/${r.planned}問＝既定 on の判断に使わない`) });
  }

  // (i)(j) 試験の係の記録と出力（手元の exam-cache だけを読む）
  {
    const q = join(repoRoot, ".claude", "exam-cache", "exam-queue");
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const logF = join(q, "conductor.log");
    const hz = existsSync(logF) ? conductorLogHazards(readFileSync(logF, "utf8").split(/\r?\n/).slice(-20000).join("\n"), since) : { stopKilled: [], oldWorktree: [] };
    checks.push({ key: "i", ok: hz.stopKilled.length === 0, line: `24時間の試験: 止める印で止まらず殺した ${hz.stopKilled.length}本・古い作業ツリーの依頼 ${hz.oldWorktree.length}本`,
      detail: [...hz.stopKilled.map((x) => `殺した（前を取り置けない）: ${x}`), ...hz.oldWorktree.map((x) => `古い作業ツリー（origin/main を取り込む）: ${x}`)] });
    const rdir = join(q, "results"); const dups: string[] = [];
    if (existsSync(rdir)) for (const f of readdirSync(rdir).filter((x) => x.endsWith(".out.log"))) {
      try { if (Date.now() - statSync(join(rdir, f)).mtimeMs > 24 * 3600_000) continue; for (const l of readFileSync(join(rdir, f), "utf8").split(/\r?\n/)) { const d = laneDupConvs(l); if (d.length) { dups.push(`${f.replace(/\.out\.log$/, "")}: ${d.join(",")}`); break; } } } catch { /* 読めない出力は飛ばす */ }
    }
    // (k)
    const wroot = join(repoRoot, ".claude", "worktrees"); const dupW: string[] = [];
    if (existsSync(wroot)) for (const w of readdirSync(wroot)) { const f = join(wroot, w, "scripts", "brain-exam", "problems.json"); if (!existsSync(f)) continue; try { const d = dupProblemIds(JSON.parse(readFileSync(f, "utf8"))); if (d.length) dupW.push(`${w}: ${d.length}問（${d.slice(0, 6).join(",")}）`); } catch { /* 読めない物は飛ばす */ } }
    // (l)
    const clashes: string[] = [];
    try {
      const mainSpec = JSON.parse(git(["show", "origin/main:scripts/brain-exam/spec.json"], repoRoot)) as Array<Record<string, unknown>>;
      if (existsSync(wroot)) for (const w of readdirSync(wroot)) { const f = join(wroot, w, "scripts", "brain-exam", "problems.json"); if (!existsSync(f)) continue; try { const c = idContentClashes(JSON.parse(readFileSync(f, "utf8")), mainSpec, (o) => `${String(o.conv ?? "")}|${String(o.at ?? "")}`);/* 正解の直し（spec の書き換え）は数えず、別の番（会話・時刻が違う）だけ */ if (c.length) clashes.push(`${w}: ${c.length}問（${c.slice(0, 6).join(",")}）`); } catch { /* 読めない物は飛ばす */ } }
    } catch { /* main の spec が読めない */ }
    checks.push({ key: "l", ok: clashes.length === 0, line: `手元の問題と main の spec で同じ id・違う番 ${clashes.length}作業ツリー`, detail: clashes });
    checks.push({ key: "k", ok: dupW.length === 0, line: `手元の problems.json の同じ id ${dupW.length}作業ツリー`, detail: dupW });
    checks.push({ key: "j", ok: dups.length === 0, line: `24時間の試験の出力でレーンが同じ会話 ${dups.length}本`, detail: dups });
  }

  // (h) 分からない事の3つの表（cron link-brain-watch がサーバーの鍵で数えた数を cron_run_logs から読む）
  if (flag("no-db")) checks.push({ key: "h", ok: null, line: "分からない事の3つの表: 見ない（--no-db）", detail: [] });
  else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
      const sbh = createClient(url, k);
      const { data } = await sbh.from("cron_run_logs").select("started_at, result_json").eq("cron_name", "link-brain-watch").eq("ok", true).order("started_at", { ascending: false }).limit(3);
      const row = ((data ?? []) as Array<{ started_at: string; result_json: { unknowns_open?: unknown } | null }>).find((r) => r.result_json?.unknowns_open);
      const r = unknownsOpenLine((row?.result_json?.unknowns_open ?? null) as never, row?.started_at ?? null, Date.now());
      checks.push({ key: "h", ok: r.ok, line: r.line, detail: [] });
    } catch (e) { checks.push({ key: "h", ok: null, line: `分からない事の3つの表: 不明（${String(e).slice(0, 60)}）`, detail: [] }); }
  }

  const mark = (c: Check) => c.ok === null ? "?" : c.ok ? "○" : "×";
  const summary = `危ない所の見張り ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")}: ` + checks.map((c) => `(${c.key})${mark(c)} ${c.line}`).join("／");
  if (flag("json")) console.log(JSON.stringify({ summary, checks }, null, 1));
  else { console.log(summary); for (const c of checks) if (c.detail.length) { console.log(`\n(${c.key}) ${c.line}`); for (const d of c.detail.slice(0, 20)) console.log(`  - ${d}`); } }
  if (flag("save")) writeFileSync(prevFile, JSON.stringify({ at: new Date().toISOString(), off, unpaged }, null, 1));
  void statSync;
}
main().catch((e) => { console.error(e); process.exit(1); });
