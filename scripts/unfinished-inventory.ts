// scripts/unfinished-inventory.ts — 途中の物の棚卸し（作業員M・2026-11-18・竹内さん「作業の途中で終わっている物も全部やるように」）
//   読むだけ・LLM なし・費用 0。DB は work_log（小さい表）だけを1回読む。
//   ① work_log の task ごとの最新の1行（progress・started・blocked／waiting_owner は別の欄）
//   ② 作ったのに既定 off・shadow のスイッチ（app/ のコードの既定・連携の地図の行）＋作った日・作業員（git blame）・試験の有無と結果（試験の係の記録）
//   ③ A 試験して on で終わる／B 直しが途中／C 竹内さんの答え待ち／D もう要らない（案・消さない）に分け、質への効き（返信・AIX の外れ）で順位を付ける
//   実行: npx tsx --env-file=<鍵のある .env> scripts/unfinished-inventory.ts [--out=memory/unfinished_inventory_1118.md] [--exam-dir=<exam-queue>] [--top=30]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { LINKAGE_MAP } from "../app/lib/linkage-map";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = process.cwd();
const OUT = arg("out", "memory/unfinished_inventory_1118.md");
const EXAM = arg("exam-dir", join(ROOT, "..", "..", "exam-cache", "exam-queue"));
const TOP = Number(arg("top", "30")) || 30;

type Cat = "A" | "B" | "C" | "D";
const CAT_JA: Record<Cat, string> = { A: "試験して on で終わる", B: "直しが途中", C: "竹内さんの答え待ち", D: "もう要らない（案）" };

// ── 質への効き（返信・AIX の外れに効くか）: 語で点を付ける目安 ──
const HIT: Array<[RegExp, number, string]> = [
  [/返信か AIX|AIX か返信|道|2段|2択|route|two_stage|two-stage|AIX の番|取り違え/i, 5, "道（返信か AIX か）"],
  [/下書き|書き手|文の|compose|draft|generate-reply|言い回し|締め|つなぎ|訴求/i, 4, "文の質"],
  [/約束|promise|台帳|ledger|送った|前の通|時系列|現状把握/i, 4, "前の通・約束の把握"],
  [/組|2通|two_message|send_combo|AIX→|テンプレート/i, 4, "組と順番"],
  [/統括|conductor|指示書|brief|重点|優先/i, 3, "統括"],
  [/ブレイン|brain|読み|気持ち|latent|mindset|状況|situation/i, 3, "ブレインの読み"],
  [/材料|RAG|手本|knowledge|届/i, 3, "材料の届き"],
  [/最終チェック|final.?check/i, 2, "最終チェック"],
  [/物件|pickup|オススメ|見積|estimate/i, 2, "物件・見積"],
  [/試験|exam|物差し|数え|監査|audit/i, 1, "測り"],
  [/画面|UI|表示|帯/i, 1, "画面"],
  [/費用|cost|キャッシュ/i, 1, "費用"],
];
function qualityOf(text: string): { score: number; why: string[] } {
  let score = 0; const why: string[] = [];
  for (const [re, w, ja] of HIT) if (re.test(text)) { score += w; why.push(ja); }
  return { score, why: why.slice(0, 3) };
}

// ── ① work_log ──
type WL = { task: string; status: string; created_at: string; actor: string | null; summary: string | null; next_step: string | null; waiting_on: string | null; branch: string | null; commit_ref: string | null };
async function readWorkLog(): Promise<WL[]> {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const out: WL[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("work_log").select("task,status,created_at,actor,summary,next_step,waiting_on,branch,commit_ref").order("created_at", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as WL[]));
    if ((data ?? []).length < 1000) break;
  }
  const last = new Map<string, WL>();
  for (const r of out) last.set(r.task, r);
  return [...last.values()];
}
const D_RE = /置き換|退役|使わない|要らない|不要|旧の|廃止|取り下げ|凍結/;
/** 済みの疑い（本文に既定 on・READY・main 入りがあり、未 push の印が無い） */
const DONE_RE = /既定 on[^。\n]{0,40}(?:READY|main|済)|READY[^。\n]{0,30}既定 on/;
const STALE_DAYS = 10;
const C_RE = /竹内さん(?:待ち|の答え|に確認|への確認|が決め)|確認事項|答え待ち|竹内さんの了承待ち|waiting_owner/;
const A_RE = /既定 on|on にする|on の案|悪化0|on 予定|試験して on/;
function catOfWork(r: WL): Cat {
  const t = `${r.summary ?? ""} ${r.next_step ?? ""} ${r.waiting_on ?? ""}`;
  if (r.status === "waiting_owner" || C_RE.test(t)) return "C";
  if (D_RE.test(t)) return "D";
  if (DONE_RE.test(t) && !/未 ?push|手元/.test(t)) return "D";
  if (A_RE.test(t) && r.status !== "blocked") return "A";
  return "B";
}

// ── ② スイッチ（コードの既定が off／shadow） ──
type Sw = { name: string; def: "off" | "shadow"; file: string; line: number; date: string; who: string; subject: string; note: string };
function walk(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) { if (f !== "__tests__") walk(p, acc); }
    else if (/\.(ts|tsx)$/.test(f)) acc.push(p);
  }
  return acc;
}
// 既定 off: (env.X ?? "")...=== "on"・既定 shadow: X の値が off/on 以外は shadow を返す形
const OFF_RE = /env\.([A-Z][A-Z0-9_]{3,})\s*\?\?\s*""\)[^;\n]{0,60}===\s*"on"/g;
const SHADOW_RE = /env\.([A-Z][A-Z0-9_]{3,})\s*\?\?\s*""\)[^\n]{0,200}(?::\s*"shadow"\s*;|return\s+v\s*===\s*"shadow"[^\n]{0,40}"off")/g;
function scanSwitches(): Sw[] {
  const files = walk(join(ROOT, "app"));
  const seen = new Map<string, Sw>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lines = src.split(/\r?\n/);
    lines.forEach((ln, i) => {
      for (const [re, def] of [[OFF_RE, "off"], [SHADOW_RE, "shadow"]] as const) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(ln))) {
          const name = m[1];
          if (seen.has(name)) continue;
          // 説明: 直前の5行のコメント
          const note = lines.slice(Math.max(0, i - 6), i).filter((x) => /^\s*(\/\/|\*)/.test(x)).map((x) => x.replace(/^\s*(\/\/|\/\*\*|\*\/?|\*)\s?/, "")).join(" ").replace(/\s+/g, " ").slice(0, 220);
          seen.set(name, { name, def: def as "off" | "shadow", file: relative(ROOT, f).replace(/\\/g, "/"), line: i + 1, date: "", who: "", subject: "", note });
        }
      }
    });
  }
  // 地図の既定の表で shadow の物も足す（コードの形が上の網に当たらない物）
  for (const [k, v] of Object.entries(LINKAGE_SWITCH_DEFAULTS)) {
    if ((v === "off" || v === "shadow") && !seen.has(k)) seen.set(k, { name: k, def: v, file: "（連携の地図の既定の表）", line: 0, date: "", who: "", subject: "", note: "" });
  }
  for (const s of seen.values()) {
    if (!s.line) continue;
    try {
      const out = execFileSync("git", ["blame", "-L", `${s.line},${s.line}`, "--porcelain", "--", s.file], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const t = /author-time (\d+)/.exec(out)?.[1];
      s.date = t ? new Date(Number(t) * 1000).toISOString().slice(0, 10) : "";
      s.subject = (/summary (.*)/.exec(out)?.[1] ?? "").slice(0, 120);
      s.who = /作業員[A-Za-z0-9]+|統括役/.exec(s.subject)?.[0] ?? /作業員[A-Za-z0-9]+/.exec(s.note)?.[0] ?? "";
    } catch { /* blame できない物はそのまま */ }
  }
  return [...seen.values()];
}

// ── 試験の係の記録（スイッチごとの試験と結果） ──
type ExamRec = { label: string; verdict: string; worse: number; at: string };
function readExams(): Map<string, ExamRec[]> {
  const by = new Map<string, ExamRec[]>();
  const res = join(EXAM, "results");
  if (!existsSync(res)) return by;
  for (const f of readdirSync(res)) {
    if (!/\.json$/.test(f) || /\.(reps|cost|meta)\.json$/.test(f)) continue;
    try {
      const o = JSON.parse(readFileSync(join(res, f), "utf8")) as { label?: string; switch?: string; verdict?: string; worse?: number; at?: string; runner?: string };
      if (!o.switch || o.runner === "tsc-remote" || /tsc/.test(String(o.verdict ?? "")) && !/悪化/.test(String(o.verdict ?? ""))) continue;
      for (const sw of String(o.switch).split(/[,+\s]+/).filter(Boolean)) {
        const a = by.get(sw) ?? [];
        a.push({ label: o.label ?? f, verdict: String(o.verdict ?? "").slice(0, 90), worse: Number(o.worse ?? 0), at: String(o.at ?? "").slice(0, 10) });
        by.set(sw, a);
      }
    } catch { /* 壊れた記録は飛ばす */ }
  }
  for (const a of by.values()) a.sort((x, y) => y.at.localeCompare(x.at));
  return by;
}
function catOfSwitch(s: Sw, ex: ExamRec[] | undefined, mapRow: { layer?: string; next?: string } | undefined): { cat: Cat; why: string } {
  const t = `${s.note} ${s.subject} ${mapRow?.next ?? ""}`;
  if (D_RE.test(t)) return { cat: "D", why: /凍結/.test(t) ? "凍結（統括役の決めで既定 off のまま・消すのは後でまとめて）" : "説明に置き換え・旧の印" };
  if (C_RE.test(t)) return { cat: "C", why: "説明に竹内さんの確認の印" };
  const last = ex?.[0];
  if (last && /確かな悪化0/.test(last.verdict)) return { cat: "A", why: `試験 ${last.label}（${last.at}）で確かな悪化0＝on の判断だけ` };
  if (last && /悪化/.test(last.verdict)) return { cat: "B", why: `試験 ${last.label}（${last.at}）で悪化あり＝直しが途中` };
  if (last) return { cat: "A", why: `試験はある（${last.label}）が判断に使える結果が無い＝試験し直して on` };
  return { cat: "A", why: "試験の記録なし＝試験して on" };
}

// ── 仕事の台帳（work_items）の行にする ──
export type WorkItemRow = {
  title: string; area: string; origin: "meeting" | "owner_request" | "found_gap" | "built_off"; requested_at: string | null; requested_quote: string | null;
  stage: string; owner: string | null; switch_name: string | null; switch_default: string | null; exam_labels: string[]; exam_result: string | null;
  kb_ids: string[]; work_log_task: string | null; quality_target: string | null; priority: number; blocker: string | null; next_step: string | null; commits: string[];
};
const AREA: Array<[RegExp, string]> = [
  [/要件|asks|ask_ledger|割り振り/i, "要件"], [/状況|時系列|現状|situation|timeline/i, "状況"], [/2通|組み合わせ|返信と AIX の組|two_message|send_combo|SEQUENCE|テンプレート/i, "2通"], [/つなぎ|誘い|tsunagi/i, "つなぎ"],
  [/訴求|appeal|オススメポイント/i, "訴求"], [/画像|image/i, "画像"], [/RAG|手本|knowledge/i, "RAG"], [/臨機応変|型外/, "臨機応変"],
  [/信頼|trust/i, "信頼"], [/状況|時系列|現状|situation|timeline|約束|promise|台帳/i, "状況"], [/統括|conductor|指示書|brief|重点/i, "統括"],
  [/物件|pickup|ピックアップ|検索|search/i, "物件出し"], [/DB|表|列|migrate|trigger|トリガー/i, "DB"], [/試験|exam|物差し/i, "試験"],
  [/下書き|書き手|文|compose|draft|締め/i, "文"], [/道|2段|2択|two_stage|two_choice|AIX/i, "道"],
];
const areaOf = (t: string) => AREA.find(([re]) => re.test(t))?.[1] ?? "その他";
const QT: Array<[RegExp, string]> = [[/つなぎ|誘い/, "つなぎ"], [/2通|テンプレート|2通目/, "2通目"], [/締め|closing/i, "締め"], [/事実|fact|見積|金額|空き/i, "事実"], [/頭|開口|opener/i, "頭"], [/道|判断|2段|2択|AIX/i, "判断"]];
const qtOf = (t: string) => QT.filter(([re]) => re.test(t)).map(([, v]) => v).slice(0, 2).join("・") || null;
const STAGE_OF_CAT: Record<Cat, string> = { A: "built_off", B: "building", C: "waiting_owner", D: "built_off" };
function toWorkItem(i: { kind: string; key: string; cat: Cat; line: string; reason: string; who: string; date: string; src: WL | { sw: Sw; ex?: ExamRec[] } }, rank: number): WorkItemRow {
  const blocker = i.cat === "D" ? `D（もう要らない）の案: ${i.reason}`.slice(0, 300) : i.cat === "C" ? i.reason.slice(0, 300) : null;
  if ("task" in i.src) {
    const r = i.src;
    const t = `${r.task} ${r.summary ?? ""} ${r.next_step ?? ""}`;
    const kb = [...new Set((t.match(/\b[0-9a-f]{8}\b/g) ?? []).filter((x) => /[a-f]/.test(x) && /\d/.test(x)))].slice(0, 6);
    const quote = /竹内さん[^「]{0,12}「([^」]{4,120})」/.exec(t)?.[1] ?? null;
    const stage = r.status === "blocked" ? "blocked" : r.status === "waiting_owner" ? "waiting_owner" : i.cat === "A" ? "testing" : STAGE_OF_CAT[i.cat];
    return {
      title: r.task.slice(0, 200), area: areaOf(t), origin: /竹内さん/.test(t) ? "owner_request" : "found_gap", requested_at: r.created_at, requested_quote: quote,
      stage, owner: r.actor, switch_name: null, switch_default: null, exam_labels: [], exam_result: null, kb_ids: kb, work_log_task: r.task,
      quality_target: qtOf(t), priority: rank, blocker: r.status === "blocked" ? (r.waiting_on || blocker) : blocker, next_step: (r.next_step ?? "").slice(0, 400) || null,
      commits: r.commit_ref ? [r.commit_ref] : [],
    };
  }
  const { sw, ex } = i.src;
  const t = `${sw.name} ${sw.note} ${sw.subject}`;
  const last = ex?.[0];
  return {
    title: `${sw.name}（既定 ${sw.def}）: ${(sw.note || sw.subject).slice(0, 140)}`, area: areaOf(t), origin: "built_off", requested_at: sw.date ? `${sw.date}T00:00:00Z` : null, requested_quote: null,
    stage: i.cat === "D" ? "built_off" : last && /確かな悪化0/.test(last.verdict) ? "passed" : last && /悪化/.test(last.verdict) ? "building" : STAGE_OF_CAT[i.cat],
    owner: sw.who || null, switch_name: sw.name, switch_default: sw.def, exam_labels: (ex ?? []).slice(0, 6).map((e) => e.label), exam_result: last ? last.verdict.slice(0, 200) : null,
    kb_ids: [], work_log_task: null, quality_target: qtOf(t), priority: rank, blocker, next_step: i.cat === "A" ? (last && /確かな悪化0/.test(last.verdict) ? "既定 on のコミット（悪化0 済み）" : "試験を積んで悪化0なら既定 on") : null,
    commits: [],
  };
}

async function main() {
  const wl = await readWorkLog();
  const open = wl.filter((r) => ["progress", "started", "blocked"].includes(r.status));
  const owner = wl.filter((r) => r.status === "waiting_owner");
  const sws = scanSwitches();
  const ex = readExams();
  const rowOf = new Map<string, (typeof LINKAGE_MAP)[number]>();
  for (const r of LINKAGE_MAP) for (const s of [...r.switches, ...r.readerSwitches]) if (!rowOf.has(s)) rowOf.set(s, r);

  type Item = { kind: "作業" | "スイッチ"; key: string; cat: Cat; score: number; why: string[]; who: string; date: string; line: string; reason: string; src: WL | { sw: Sw; ex?: ExamRec[] } };
  const items: Item[] = [];
  for (const r of [...open, ...owner]) {
    const text = `${r.task} ${r.summary ?? ""} ${r.next_step ?? ""}`;
    const q = qualityOf(text);
    const cat = catOfWork(r);
    const ageDays = Math.floor((Date.now() - Date.parse(r.created_at)) / 86_400_000);
    const stale = ageDays >= STALE_DAYS && r.status !== "waiting_owner";
    const done = cat === "D" && DONE_RE.test(`${r.summary ?? ""} ${r.next_step ?? ""}`);
    const extra = done ? "・済みの疑い（本文に既定 on・READY）＝確かめて done に" : stale ? `・${ageDays}日動いていない（持ち主が居るか確かめる）` : "";
    items.push({ kind: "作業", src: r, key: r.task.slice(0, 70), cat, score: q.score + (r.status === "blocked" ? 1 : 0) - (stale ? 3 : 0), why: q.why, who: (r.actor ?? "").slice(0, 16), date: r.created_at.slice(0, 10), line: `${(r.summary ?? "").replace(/\s+/g, " ").slice(0, 110)} → ${(r.next_step ?? "").replace(/\s+/g, " ").slice(0, 80)}`, reason: `${r.status}${r.waiting_on ? `・待ち: ${r.waiting_on.slice(0, 40)}` : ""}${extra}` });
  }
  for (const s of sws) {
    const mr = rowOf.get(s.name);
    const c = catOfSwitch(s, ex.get(s.name), mr);
    const q = qualityOf(`${s.name} ${s.note} ${s.subject} ${mr?.name ?? ""} ${mr?.stage ?? ""}`);
    items.push({ kind: "スイッチ", src: { sw: s, ex: ex.get(s.name) }, key: s.name, cat: c.cat, score: q.score + (mr ? 2 : 0) + (c.cat === "A" && /悪化0/.test(c.why) ? 3 : 0), why: q.why, who: s.who, date: s.date, line: `既定 ${s.def}・${s.file}${s.line ? `:${s.line}` : ""}${mr ? `・地図 ${mr.id}（${mr.layer}）` : ""}・${(s.note || s.subject).slice(0, 110)}`, reason: c.why });
  }
  items.sort((a, b) => b.score - a.score || (a.cat === "A" ? -1 : 0) - (b.cat === "A" ? -1 : 0) || b.date.localeCompare(a.date));

  const L: string[] = [];
  const count = (k: Item["kind"], c: Cat) => items.filter((i) => i.kind === k && i.cat === c).length;
  L.push(`# 途中の物の棚卸し（${new Date().toISOString().slice(0, 10)}・scripts/unfinished-inventory.ts が作った物・作業員M）`);
  L.push("");
  L.push(`竹内さん 11/18「作業の途中で終わっている物も全部やるように」。読むだけ・LLM なし・費用 0（DB は work_log だけ）。分け方と順位は語の目安で、上から読んで直す前の振り分け。D は消さずに案として出す。`);
  L.push("");
  L.push(`- 作業（work_log の task ごとの最新）: 途中 ${open.length}（progress ${open.filter((r) => r.status === "progress").length}・started ${open.filter((r) => r.status === "started").length}・blocked ${open.filter((r) => r.status === "blocked").length}）・竹内さん待ち ${owner.length}`);
  L.push(`- 既定 off／shadow のスイッチ: ${sws.length}（off ${sws.filter((s) => s.def === "off").length}・shadow ${sws.filter((s) => s.def === "shadow").length}）・そのうち連携の地図の行に載る物 ${sws.filter((s) => rowOf.has(s.name)).length}`);
  L.push(`- 分け: 作業 A ${count("作業", "A")}・B ${count("作業", "B")}・C ${count("作業", "C")}・D ${count("作業", "D")} ／ スイッチ A ${count("スイッチ", "A")}・B ${count("スイッチ", "B")}・C ${count("スイッチ", "C")}・D ${count("スイッチ", "D")}`);
  L.push("");
  L.push(`## 上位 ${TOP}（質への効きの順）`);
  L.push("| # | 種類 | 名前 | 分け | 効き | 作業員 | 日 | 中身 | なぜこの分け |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  items.slice(0, TOP).forEach((i, k) => L.push(`| ${k + 1} | ${i.kind} | ${i.key.replace(/\|/g, "／")} | ${i.cat} ${CAT_JA[i.cat]} | ${i.score}（${i.why.join("・")}） | ${i.who} | ${i.date} | ${i.line.replace(/\|/g, "／")} | ${i.reason.replace(/\|/g, "／")} |`));
  for (const c of ["A", "B", "C", "D"] as Cat[]) {
    L.push("", `## ${c}: ${CAT_JA[c]}（全部・効きの順）`);
    for (const i of items.filter((x) => x.cat === c)) L.push(`- [${i.kind}] **${i.key}**（効き ${i.score}・${i.who || "?"}・${i.date}）${i.line}／${i.reason}`);
  }
  writeFileSync(join(ROOT, OUT), L.join("\n") + "\n");
  console.log(`書いた ${OUT}: 作業 ${open.length + owner.length}・スイッチ ${sws.length}`);
  // 2026-11-18 統括役の頼み: 仕事の台帳（work_items）に入れる形も出す（scripts/work-items.ts --import=<json> が読む）
  if (arg("json-out")) {
    const rows = items.map((i, k) => toWorkItem(i, k + 1));
    writeFileSync(arg("json-out"), JSON.stringify(rows, null, 1));
    console.log(`書いた ${arg("json-out")}: work_items ${rows.length}行`);
  }
  console.log(JSON.stringify({ top: items.slice(0, TOP).map((i) => [i.kind, i.key, i.cat, i.score, i.who]) }));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
