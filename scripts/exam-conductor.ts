// scripts/exam-conductor.ts — 試験の統括（試験の依頼を1つの順番待ちにし、安い時間・本数・本番の調子・空きメモリを見て順に流す）
//
// 2026-11-03 竹内さん「試験のブレインのところにも統括がいるのか」（KB P1「試験にも統括を置く」・P0 4c91ffd9）・作業員1:
//   今は作業員どうしが SendMessage で枠を譲り合い、安い時間や本番の時間切れを手で見ていた → この道具1つに寄せる。
//   ・順番待ち: <倉庫の根>/.claude/exam-cache/exam-queue/*.json（1つの依頼＝1ファイル・--add で足す・流した物は done/ へ）
//   ・関所（全部満たした時だけ1本始める）:
//       DeepSeek の安い時間（平日 JST 13〜15・19〜翌10・土日）／本数の上限（JST 9〜22 は PC 全体で1本・それ以外は2本）／
//       本番の調子（直近10分の llm_usage_logs の失敗・cron の失敗が多くない）／空きメモリ（既定 1000MB 以上）／tsc の鍵が無い
//   ・止める: 流している間も2分ごとに本番の調子を見て、悪ければ止めて片付け、依頼を順番待ちに戻す
//   ・結果: 試験の出力の最後（合格 前→今・悪くなった・良くなった・費用）を読み、results/ に JSON と1行を残す
// 2026-11-03 指揮役の順で足した4つ:
//   ① 早めの打ち切り: 30秒ごとに結果の行を前（main）と比べ、前に合格していた問題が残りの回でも合格に届かない（悪化の確定）か、
//      全部の問題の合否が決まったら止める → 片付け → --report で集計し直す（EXAM_STOP_EARLY=off で止める）
//   ② 入れる順番の表への書き戻し: --release-order=<md>（一度渡せば exam-queue/config.json に覚える）のスイッチの行の「状態」を結果に置き換える
//   ③ 問題ごとの揺れ: 揺れの記録（exam-flake）で答えが割れた問題は 4回（EXAM_FLAKY_REPS・3〜6）・それ以外は repeat（既定2）→ --reps-file で渡す
//   ④ 問題の選び: --pick=types:型@N ／ gold（正解の組）／ map（exam-queue/scene-map.json の場面の地図）／ rag（brain-exam --select=rag）
//   ＋ 終わったら依頼した人に知らせる: --notify=<エージェントの id>（無ければ exam-queue/config.json の notify[owner]）→ results/notify.jsonl と conductor.log の「📣 知らせる」の行。--run を見張る作業員がその行を SendMessage で届ける
//   ＋ tsc の依頼: --runner=tsc --cwd=<作業ツリー>（試験と同時に流さない・1本ずつ・空きメモリ 4500MB 以上（試験も裏の重い作業も動いていない時・空かなければ夜まで待つ）・%TEMP%/tsc.lock を取る・heap は EXAM_TSC_HEAP_MB 既定 8192（4096 では 134 で落ちる）・60分を超えて待つ tsc は指揮役に知らせる）→ 0 か落ちた理由を知らせる
//   ＋ --night: 夜だけ流す依頼（JST 22〜9・営業時間に大きな表を全部読まない決まり）
//   ＋ tsc-remote: --runner=tsc-remote --cwd=<作業ツリー>（Vercel のお試しの場所で next build＝型の確かめ・--prod は付けない・PC のメモリを使わない・11/03 竹内さん了承の案A）
//   ＋ brain-exam 以外の試験の口: --runner=cmd --cmd="scripts/x.ts --a=1" [--cmd=...]（順に流す・関所と本番の見張りは同じ・採点は依頼者）
//   ＋ 掘り（2026-11-06）: --dig を付けると回数は --repeat のまま（揺れる問題も増やさない）・外れた問題の確かめ直しもしない＝同じ問題を何本も流して原因を掘る時の安い口（既定 on の判断には使わない）
// 実行:
//   足す:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --add --label=ms-on1 --owner=作業員1 --switch=BRAIN_MATERIAL_SELF_REPORT --cwd=<作業ツリー> --only=q015,q042 --stage=brain [--repeat=2] [--env=K=V,K=V] [--flaky=q091] [--pick=...]
//          （brain-exam 以外）--add --label=sbp --owner=作業員6 --switch=AIX_SECOND_BLUEPRINT --cwd=<作業ツリー> --runner=cmd --cmd="scripts/exam-aix-text.ts --label=sbp-off --qfile=second-appeal.json --kinds=second" --cmd="..."
//   流す:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --run [--once] [--release-order=<md>]
//   見る:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --list
import { spawn, execFileSync } from "node:child_process";
import { rmdirSync, unlinkSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, openSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { examCacheRoot } from "./lib/llm-cassette";
import { readObs } from "./lib/exam-flake";
import { problemHash } from "./lib/brain-exam-baseline";
/** 2026-11-05 作業員1（作業員4の気付き・問題の id のぶつかり）: 依頼の作業ツリーの手元の problems.json の中身の hash の候補（揺れの記録を id だけで引かない） */
const hashCache = new Map<string, Map<string, string[]>>();
function problemHashesOf(cwd: string): (id: string) => string[] | null {
  const f = join(cwd, "scripts", "brain-exam", "problems.json");
  const key = `${cwd}|${existsSync(f) ? statSync(f).mtimeMs : 0}`; // 作り直したら読み直す
  let m = hashCache.get(key);
  if (!m) {
    m = new Map();
    try {
      for (const p of JSON.parse(readFileSync(join(cwd, "scripts", "brain-exam", "problems.json"), "utf8")) as Array<Record<string, unknown> & { id: string; acceptWhen?: { searchExhaustedAsks?: unknown[] } }>) {
        const hs = [problemHash(p)];
        if (p.acceptWhen?.searchExhaustedAsks?.length) hs.push(problemHash({ ...p, asks: p.acceptWhen.searchExhaustedAsks }));
        m.set(p.id, hs);
      }
    } catch { /* 読めなければ前の形 */ }
    hashCache.set(key, m);
  }
  const mm = m;
  return (id) => (mm.size ? mm.get(id) ?? [] : null);
}
import { pcState } from "./lib/exam-pc-state";
import { hazardAuditDue, splitWorse, cheapNow, maxExamsNow, earlyVerdict, repsPlan, pickProblems, updateReleaseOrder, compareJobs, splitIds, splitByTime, cleanupTargets, remoteDeployState, estimateJobMin, remainingIds, comparedIds, staleExamGuard, type RowLite, type SceneMap } from "./lib/exam-conductor-core";
import { nightBaseJobDue, nightBaseAlready, isExamJobShape, pinConfirmIds, mergePinnedBase } from "./lib/exam-base-pin";
import { planExam, kindSuggest, readExamResult, splitCmdArgs, needsBaseIds, type CmpLite } from "./lib/exam-plan";
import { fillProblemsFromShared, sharedProblemsEnabled } from "./lib/exam-problems-store";
import { summarizeMisses, ownerOf, parseLogTags, weaknessHitsFromMisses, type MissRowLite } from "./lib/exam-miss-stage";
import { recordExamWeaknesses } from "../app/lib/brain-weaknesses-server";
import { NO_LINE_TEST_CONVERSATIONS } from "../app/lib/test-conversations";
export { cheapNow, maxExamsNow } from "./lib/exam-conductor-core";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const argsOf = (k: string) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
const flag = (k: string) => args.includes(`--${k}`);
const ROOT = join(examCacheRoot(), "exam-queue");
const DONE = join(ROOT, "done"), RES = join(ROOT, "results");
// 2026-11-05 作業員8（21:49 に流す係が落ちた・点検表 18）: 係の印（夜の基準・見張りの「今日はもう回した」）は列のフォルダの外に置く。列の .json は依頼として読まれる
const MARKS = join(examCacheRoot(), "conductor-marks");
const CONFIG = join(ROOT, "config.json"), SCENE_MAP = join(ROOT, "scene-map.json");
const LOG = join(ROOT, "conductor.log");
const ensureDirs = () => { for (const d of [ROOT, DONE, RES]) mkdirSync(d, { recursive: true }); };
const log = (s: string) => { ensureDirs(); const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(LOG, line + "\n"); };
let _sb: ReturnType<typeof createClient> | null = null;
const db = () => (_sb ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""));
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };

export type ExamJob = {
  id: string; label: string; owner: string; switch: string; cwd: string; only: string; stage: string; repeat: number; env: Record<string, string>; createdAt: string; tries: number; /** 立ち上がりの失敗が続いた回数（2026-11-04） */ crashes?: number;
  /** 依頼で名指しした揺れる問題（③） */ flaky?: string[];
  /** 2026-11-06 統括役（依頼そのものを削る）: 掘りの依頼（--dig）。回数は --repeat のまま（揺れる問題も増やさない）・外れた問題の確かめ直しもしない＝既定 on の判断に使わない */ dig?: boolean;
  /** --pick=rag の時 brain-exam --select=rag に任せる（④） */ selectRag?: boolean;
  /** brain-exam 以外の試験（"cmd"）。cmds はそれぞれ npx tsx --env-file=.env.local の後ろに付ける */ runner?: "brain-exam" | "cmd" | "tsc" | "tsc-remote"; cmds?: string[];
  /** 2026-11-04 指揮役: AI を呼ばない読むだけの依頼（cmd だけ・--read-only）。2つ目の流す役（--remote）が試験と同時に流す */ readOnly?: boolean;
  /** 2026-11-04 (a)(b): 小さいほど先（既定 5）・1本の時間の上限（分・既定 EXAM_JOB_MAX_MIN=40） */ priority?: number; maxMin?: number;
  /** 夜だけ流す（JST 22〜9・重い全件の読み等・--night） */ nightOnly?: boolean;
  /** 保留の理由（あれば流さない・手で外す） */ hold?: string;
  /** この時刻（ISO）より前は流さない（--not-before=2026-11-10T22:00+09:00） */ notBefore?: string;
  /** 急ぎ（--urgent）: 混雑の時間（平日 JST 10〜13・15〜19）でも流す（2026-11-06） */ urgent?: boolean;
  /** 費用の上限（--cap-usd・2026-11-06）: 流す時に EXAM_MAX_USD として渡す＝届いたら次の問題の前で止まる */ capUsd?: number;
  /** 終わったら知らせる相手（エージェントの id・--notify=）。無ければ exam-queue/config.json の notify[owner] */ notify?: string;
};

// ─── 関所 ───────────────────────────────────────────────────────────────
/** 本番の調子: 直近10分の LLM の失敗（テストの行は除く）と cron の失敗。数えるだけ（行は読まない） */
async function prodHealthy(): Promise<{ ok: boolean; why: string }> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  try {
    const [llm, cron] = await Promise.all([
      db().from("llm_usage_logs").select("id", { count: "exact", head: true }).gte("created_at", since).not("env", "like", "%test%").not("route", "like", "script:%").or("status.gte.500,status.eq.0"),
      db().from("cron_run_logs").select("id", { count: "exact", head: true }).gte("started_at", since).eq("ok", false),
    ]);
    const nl = llm.count ?? 0, nc = cron.error ? 0 : cron.count ?? 0;
    const max = Number(process.env.EXAM_PROD_FAIL_MAX ?? "5");
    return nl + nc > max ? { ok: false, why: `本番の失敗 直近10分 LLM ${nl}・cron ${nc}（上限 ${max}）` } : { ok: true, why: `本番の失敗 LLM ${nl}・cron ${nc}` };
  } catch (e) { return { ok: false, why: `本番の調子を読めない: ${String(e).slice(0, 80)}` }; }
}
/** tsc の依頼の関所: 試験と同時に流さない・tsc は1本ずつ・空きメモリが十分（既定 4500MB・EXAM_TSC_MIN_FREE_MB・11/03 指揮役: heap 8192 で流すため）。安い時間・本番の調子は見ない（LLM を呼ばない） */
function gateTsc(): { ok: boolean; why: string } {
  const pc = pcState();
  if (pc.tsc) return { ok: false, why: "tsc が動いている（1本ずつ）" };
  if (pc.exams > 0) return { ok: false, why: `試験が ${pc.exams}本動いている（tsc と同時に流さない）` };
  const minFree = Number(process.env.EXAM_TSC_MIN_FREE_MB ?? "4500");
  if (pc.free < minFree) return { ok: false, why: `空きメモリ ${pc.free}MB（tsc は ${minFree} 以上）` };
  return { ok: true, why: `空き ${pc.free}MB` };
}
async function gate(j?: ExamJob): Promise<{ ok: boolean; why: string }> {
  if (j?.hold) return { ok: false, why: `保留（${j.hold}）` };
  if (j?.notBefore && Date.now() < Date.parse(j.notBefore)) return { ok: false, why: `${j.notBefore} から` };
  if (j?.runner === "tsc") return process.env.EXAM_TSC_LOCAL === "on" ? gateTsc() : { ok: true, why: "リモート（Vercel のお試しの場所）" };
  // tsc-remote: PC のメモリは使わない（Vercel のお試しの場所で next build）＝門は「流す役が1本ずつ」だけ
  if (j?.runner === "tsc-remote") return { ok: true, why: "リモート（Vercel のお試しの場所）" };
  // 2026-11-04 指揮役: AI を呼ばない読むだけの依頼は試験の本数の門に入れない（夜だけの印は守る・DB の窓と上限は依頼の引数のまま）
  if (j?.runner === "cmd" && j.readOnly) { if (j.nightOnly) { const h = new Date(Date.now() + 9 * 3600_000).getUTCHours(); if (h >= 9 && h < 22) return { ok: false, why: "夜だけの依頼（JST 22〜9）" }; } return { ok: true, why: "読むだけ（AI を呼ばない・試験の門の外）" }; }
  if (j?.nightOnly) { const h = new Date(Date.now() + 9 * 3600_000).getUTCHours(); if (h >= 9 && h < 22) return { ok: false, why: "夜だけの依頼（JST 22〜9）" }; }
  // 2026-11-06 作業員8（統括役の了承）: 急ぎの依頼（--urgent）だけ混雑の時間でも流す（倍の時間の費用は 11/05 に $23・試験の 30%）
  if (!cheapNow() && !(j as { urgent?: boolean } | null)?.urgent) return { ok: false, why: "DeepSeek の混雑の時間（平日 10〜13・15〜19・急ぎなら --urgent）" };
  const pc = pcState();
  if (pc.tsc) return { ok: false, why: "tsc が動いている" };
  if (pc.exams >= maxExamsNow()) return { ok: false, why: `試験が ${pc.exams}本（上限 ${maxExamsNow()}）` };
  const minFree = Number(process.env.EXAM_MIN_FREE_MB ?? "1000");
  if (pc.free < minFree) return { ok: false, why: `空きメモリ ${pc.free}MB（${minFree} 未満）` };
  const h = await prodHealthy();
  return h.ok ? { ok: true, why: `${h.why}・空き ${pc.free}MB` } : h;
}

// ─── 順番待ち ───────────────────────────────────────────────────────────
const skippedNonJobs = new Set<string>();
/** 営業時間（JST 9〜22時）は試験のレーンを1本に（止める EXAM_BIZ_ONE_LANE=off・弱い所 357） */
function businessHoursLane(now = new Date()): boolean { if ((process.env.EXAM_BIZ_ONE_LANE ?? "").trim().toLowerCase() === "off") return false; const h = new Date(now.getTime() + 9 * 3600_000).getUTCHours(); return h >= 9 && h < 22; }
function readJobs(): Array<ExamJob & { file: string }> {
  ensureDirs();
  // 2026-11-05 作業員8: 依頼の形でない .json（印・壊れたファイル）は拾わずに飛ばす（落ちない・1回だけ知らせる）
  const out: Array<ExamJob & { file: string }> = [];
  for (const f of readdirSync(ROOT).filter((x) => x.endsWith(".json") && x !== "config.json" && x !== "scene-map.json")) {
    let j: unknown = null; try { j = JSON.parse(readFileSync(join(ROOT, f), "utf8")); } catch { /* 壊れた・書きかけ */ }
    if (!isExamJobShape(j)) { if (!skippedNonJobs.has(f)) { skippedNonJobs.add(f); log(`  ⚠ 依頼の形でないファイルを飛ばす: ${f}（係の列のフォルダに印を置かない・点検表 18）`); } continue; }
    out.push({ ...(j as ExamJob), file: join(ROOT, f) });
  }
  return out.sort((a, b) => compareJobs(a, b));
}
/**
 * 回数の計画（実際に流す時と、積む時の見込みの1行で同じ物を使う）。2026-11-06 統括役（P0 8805bd74・作業員9 の EXAM_FLAKY_REPS=1 の依頼が見込み3回分 $0.18 のまま出た）:
 *   EXAM_FLAKY_REPS・EXAM_STABLE_REPS は依頼の --env を先に、無ければ係の env を読む。普通の問題は依頼の --repeat、揺れる問題は揺れの回数、安定は安定の回数
 */
export function jobRepsPlan(j: Pick<ExamJob, "cwd" | "repeat" | "flaky" | "env" | "dig">, ids: string[]): ReturnType<typeof repsPlan> {
  if (j.dig) return { reps: Object.fromEntries(ids.map((id) => [id, Math.max(1, j.repeat)])), flaky: [], stable: [] };
  const ev = (k: string) => (j.env?.[k] ?? process.env[k]);
  const sr = ev("EXAM_STABLE_REPS");
  return repsPlan(ids, (id) => readObs(id), { hashesOf: problemHashesOf(j.cwd), normal: j.repeat, flakyReps: Number(ev("EXAM_FLAKY_REPS") ?? "4"), forced: j.flaky, model: "deepseek", stableReps: sr === "off" ? undefined : Number(sr ?? "1") });
}

function addJob(): void {
  ensureDirs();
  const env = Object.fromEntries(arg("env").split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const cwd = arg("cwd", process.cwd());
  const label = arg("label") || `job-${Date.now()}`;
  // 2026-11-05 作業員8（統括役の了承「段を最小に: --stage=diff を既定にし、文の組だけ draft」）: 前の子の費用の約15%が下書きの段（final_check・aix_desk 等）。
  //   --stage を書かない依頼は diff（直したファイルが下書きに届かなければブレインだけ）・文の組（grp-reply・grp-aix）は draft。書いた時はそのまま
  const stageDefault = /^(?:grp-reply|grp-aix)/.test(label) ? "draft" : "diff";
  const base = { owner: arg("owner", "?"), switch: arg("switch", ""), cwd, stage: arg("stage") || stageDefault, env, createdAt: new Date().toISOString(), tries: 0, ...(arg("notify") ? { notify: arg("notify") } : {}), ...(flag("night") ? { nightOnly: true } : {}), ...(flag("urgent") ? { urgent: true } : {}), ...(Number(arg("cap-usd")) > 0 ? { capUsd: Number(arg("cap-usd")) } : {}), ...(arg("not-before") && Number.isFinite(Date.parse(arg("not-before"))) ? { notBefore: new Date(Date.parse(arg("not-before"))).toISOString() } : {}) };
  // 2026-11-04 (a)(b): --priority=<小さいほど先・既定 5>・--max-min=<1本の時間の上限（分）>
  if (arg("priority")) (base as Record<string, unknown>).priority = Number(arg("priority"));
  if (arg("max-min")) (base as Record<string, unknown>).maxMin = Number(arg("max-min"));
  let job: ExamJob;
  // 11/03 指揮役: 手元の tsc は使わない＝--runner=tsc も tsc-remote として足す（手元の tsc は --runner=tsc-local の時だけ）
  if (arg("runner") === "tsc-remote" || arg("runner") === "tsc") {
    job = { ...base, id: `${Date.now()}`, label, only: "", repeat: 1, runner: "tsc-remote" };
  } else if (arg("runner") === "tsc-local") {
    job = { ...base, id: `${Date.now()}`, label, only: "", repeat: 1, runner: "tsc" };
  } else if (arg("runner") === "cmd") {
    const cmds = argsOf("cmd").filter(Boolean);
    if (!cmds.length) throw new Error("--runner=cmd は --cmd=\"scripts/x.ts --a=1\" が要る（何度でも・順に流す）");
    if (cmds.some((c) => !/^scripts\/[\w./-]+\.ts(\s|$)/.test(c))) throw new Error("--cmd は scripts/ の .ts から始める（npx tsx --env-file=.env.local の後ろに付ける）");
    job = { ...base, id: `${Date.now()}`, label, only: "", repeat: 1, runner: "cmd", cmds, ...(flag("read-only") ? { readOnly: true } : {}) };
    // 2026-11-06 作業員8（作業員7の cmd の依頼が見積もり違いで $0.43）: cmd の依頼にも見込みの1行を出す。brain-exam は --only・--repeat・--stage から試験の統括の計画で、
    //   他の台本は LLM を呼ぶかを名前と --read-only で見て「見込みが出せない」と出す（--cap-usd を書けば上限として残す）
    for (const c of cmds) {
      const a = splitCmdArgs(c), get = (k: string) => a.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
      if (a[0] === "scripts/brain-exam.ts") {
        const specIds = readJson<Array<{ id: string }>>(join(cwd, "scripts/brain-exam/spec.json"), []).map((x) => x.id);
        const ids = get("only") ? get("only").split(",").filter(Boolean) : specIds;
        const st = get("stage");
        const pl = planExam({ label: get("label") || label, ids, diffStage: st === "brain" || st === "draft" ? st : null, capUsd: Number(arg("cap-usd", "2")) || 2 });
        const rep = Math.max(1, Number(get("repeat") || "1") || 1);
        const usd = pl.cost.usd * rep / 3; // planExam は分からない問題を3回で見積もる＝cmd の --repeat に合わせ直す
        log(`  見込み（cmd）: ${a.slice(0, 2).join(" ")}… ${ids.length}問×${rep}回・段 ${pl.stage}・約 $${usd.toFixed(2)}${get("baseline").startsWith("main") ? "（前を作る子が要れば同じくらい足す）" : ""}`);
      } else {
        log(`  見込み（cmd）: ${a[0]} は見込みを出せない${job.readOnly ? "（--read-only＝LLM を呼ばない）" : "（LLM を呼ぶなら依頼に --cap-usd を書く・終わったら係の費用の行で確かめる）"}`);
      }
    }
  } else {
    const spec = readJson<Array<{ id: string; type: string }>>(join(cwd, "scripts/brain-exam/spec.json"), []);
    const golds = readJson<{ golds?: Array<{ id: string }> }>(join(cwd, "scripts/parts-eval/gold-20.json"), {}).golds?.map((g) => g.id) ?? [];
    const p = pickProblems(arg("pick"), spec, { golds, map: { ...readJson<SceneMap>(join(cwd, "scripts/brain-exam/scene-map.json"), {}), ...readJson<SceneMap>(SCENE_MAP, {}) }, switchName: base.switch, only: arg("only").split(",").filter(Boolean) });
    const flaky = arg("flaky").split(",").filter(Boolean);
    const ids = [...new Set([...p.ids, ...flaky])];
    if (!ids.length && !p.selectRag) throw new Error("問題が無い（--only か --pick を付ける）");
    job = { ...base, id: `${Date.now()}`, label, only: ids.join(","), repeat: Number(arg("repeat", String(p.repeat ?? 2))), flaky, selectRag: p.selectRag, runner: "brain-exam", ...(flag("dig") ? { dig: true } : {}) };
    if (arg("pick")) log(`  選び: ${p.why} → ${ids.length}問`);
    // 2026-11-05 作業員8（KB P0 4c91ffd9「試験のブレインが何を・何回・どこまで・いつ」・統括役「1か所が順に決めて1行の計画を出す」）: 試験の統括の計画（scripts/lib/exam-plan.ts）
    //   --kind=record|prod（記録だけ・本番で動いている直し）は試験を積まず、毎晩の本番の物差し（cron prod-yardstick）で見る。計画は exam-cache/exam-plans.jsonl に残す
    // 2026-11-06 作業員8（弱い所 348・作業員9の気付き: spec.json の正解を変えても手元の problems.json が古いまま使われ、night-brain-on-p1 で q136・q099・q137 が古い正解で ○ に数えられた）:
    //   積む前に、依頼の作業ツリーの problems.json が今の spec と違う（共有の置き場にも新しい物が無い）問題を見つけたら積まずに返す（作り直すコマンド付き）。--allow-stale で今まで通り積む
    {
      const local = readJson<Array<Record<string, unknown>>>(join(cwd, "scripts/brain-exam/problems.json"), []);
      const fr = fillProblemsFromShared(spec as unknown as Array<Record<string, unknown>>, local, { addMissing: (id) => ids.includes(id) });
      const stale = fr.staleKept.filter((id) => ids.includes(id)), miss = fr.missing.filter((id) => ids.includes(id));
      if (sharedProblemsEnabled() && (stale.length || miss.length) && !flag("allow-stale")) {
        const need = [...stale, ...miss];
        throw new Error(`積まない: 問題 ${need.join(",")} は手元の problems.json が今の正解（spec.json）と違うか無い。作り直す: cd ${cwd} && npx tsx --env-file=.env.local scripts/brain-exam-add.ts --rebuild --only=${need.join(",")}（古いまま流す時だけ --allow-stale）`);
      }
    }
    const kind = (["record", "prod", "exam"].includes(arg("kind")) ? arg("kind") : undefined) as "record" | "prod" | "exam" | undefined;
    const group = /^grp-reply/.test(label) ? "reply" as const : /^grp-aix/.test(label) ? "aix" as const : /^grp-brain/.test(label) ? "brain" as const : null;
    // 2026-11-06 統括役（sce-on2 の見込み $0.24・実際 $0.35＝前を作った子 $0.17 が見込みに入っていなかった）: 今の main の版に前の答えが無い問題は「前を作る分」を見込む
    const needsBase = (() => { try {
      const B = join(examCacheRoot(), "brain-exam-baseline");
      const head = execFileSync("git", ["-C", cwd, "rev-parse", "origin/main"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      // 夜の基準（30時間以内）があれば、昼の依頼の前はそれを使う（外れた問題だけ確かめ直す）＝前を作るのは夜の基準に無い問題だけと見込む
      const nights = readdirSync(B).filter((f) => /^nightly-base-.*\.json$/.test(f)).map((f) => readJson<{ at?: string; problems?: string[] } | null>(join(B, f), null)).filter((x): x is { at: string; problems: string[] } => !!x?.at && Array.isArray(x.problems) && Date.now() - Date.parse(x.at) < 30 * 3_600_000);
      if (nights.length) { const have = new Set(nights.flatMap((x) => x.problems)); return ids.filter((id) => !have.has(id)); }
      return needsBaseIds(ids, { mainCommit: head || null, versionKeys: readJson<Record<string, string>>(join(B, "version-keys.json"), {}),
        dirsByKey: (key) => readdirSync(B).filter((d) => d.startsWith(`v-${key}-`)).map((d) => readdirSync(join(B, d)).filter((f) => f.endsWith(".json") && f !== "config.json").map((f) => f.replace(/\.json$/, ""))) });
    } catch { return [] as string[]; } })();
    const plan = planExam({ label, kind, switchName: base.switch, ids, group, needsBase, repsOverride: job.runner === "brain-exam" ? (() => { try { return jobRepsPlan(job, ids).reps; } catch { return undefined; } })() : undefined, diffStage: base.stage === "brain" || base.stage === "draft" ? base.stage : null, brainText: flag("brain-text"), defaultOn: flag("default-on"), capUsd: Number(arg("cap-usd", "2")) || 2 });
    log(`  ${plan.line}`);
    const sug = kindSuggest({ kind, switchName: base.switch, label }); if (sug) log(`  （${sug}）`);
    try { appendFileSync(join(examCacheRoot(), "exam-plans.jsonl"), JSON.stringify({ at: new Date().toISOString(), label, route: plan.route, ids: plan.ids, usd: Number(plan.cost.usd.toFixed(4)), stage: plan.stage, claude: plan.claude.ids, gate: plan.gate }) + "\n"); } catch { /* 記録できなくても積む */ }
    if (plan.route === "yardstick") {
      ensureDirs();
      writeFileSync(join(RES, `${label}.json`), JSON.stringify({ label, owner: base.owner, switch: base.switch, runner: "yardstick", verdict: plan.line, at: new Date().toISOString() }, null, 1));
      log(`積まない: ${label}（${plan.gate.go ? "" : plan.gate.why}）`);
      return;
    }
  }
  // 2026-11-04 (c): 12問を超える試験の依頼は、足す時に12問ずつに分ける（揺れる問題は入っている側に付ける）
  // 2026-11-05 作業員1（統括役の指示）: 12問に加えて、見積もりの時間（回数×前と今×レーン・古い作業ツリーは1レーン）が上限に収まらない依頼も分ける（EXAM_ADD_SPLIT_BY_TIME=off で12問だけ）
  const parts = (() => {
    if (job.runner !== "brain-exam" || !job.only) return [] as string[][];
    const ids0 = job.only.split(",").filter(Boolean);
    if (process.env.EXAM_ADD_SPLIT_BY_TIME === "off") return splitIds(ids0);
    const rp0 = jobRepsPlan(job, ids0);
    const src = (() => { try { return readFileSync(join(job.cwd, "scripts", "brain-exam.ts"), "utf8"); } catch { return ""; } })();
    const g = staleExamGuard(src, null, job.maxMin ?? Number(process.env.EXAM_JOB_MAX_MIN ?? "40"), Number(process.env.EXAM_JOB_OLD_MAX_MIN ?? "120"));
    const lanes = g.laneOld ? 1 : Math.max(1, Math.round(Number(process.env.EXAM_CONCURRENCY ?? "4") * 0.75));
    const est = estimateJobMin(ids0, rp0.reps, { lanes });
    const ps = splitByTime(ids0, rp0.reps, { lanes, maxMin: g.maxMin });
    log(`  見積もり: ${ids0.length}問・回 ${Object.values(rp0.reps).reduce((a, b) => a + b, 0)}×前と今・${lanes}レーン${g.laneOld ? "（古い作業ツリー）" : ""} → 約${est}分（上限 ${g.maxMin}分）${ps.length > 1 ? ` → ${ps.length}本に分ける（1本 約${ps.map((x) => estimateJobMin(x, rp0.reps, { lanes })).join("・")}分）` : ""}`);
    return ps;
  })();
  if (parts.length > 1) {
    parts.forEach((ids, k) => {
      const pj: ExamJob = { ...job, id: `${job.id}-${k + 1}`, label: `${job.label}-p${k + 1}`, only: ids.join(","), flaky: (job.flaky ?? []).filter((x) => ids.includes(x)), createdAt: new Date(Date.parse(job.createdAt) + k).toISOString() };
      writeFileSync(join(ROOT, `${pj.createdAt.replace(/[:.]/g, "-")}-${pj.label}.json`), JSON.stringify(pj, null, 1));
    });
    log(`足した: ${job.label} を ${parts.length}本に分けた（12問まで・時間の見積もりで: ${parts.map((x, k) => `${job.label}-p${k + 1}=${x.length}問`).join("・")}）`);
    return;
  }
  const f = join(ROOT, `${job.createdAt.replace(/[:.]/g, "-")}-${job.label}.json`);
  writeFileSync(f, JSON.stringify(job, null, 1));
  log(`足した: ${job.label}（${job.owner}・${job.switch}・${job.runner === "tsc" ? `tsc（${job.cwd}）` : job.runner === "cmd" ? `${job.cmds!.length}本の試験` : `${job.only || "rag"}・${job.repeat}回${job.flaky?.length ? `・揺れる ${job.flaky.join(",")}` : ""}`}）`);
}

// ─── 流す・結果を読む ─────────────────────────────────────────────────────
function summarize(out: string): { worse: number | null; better: number | null; pass: string | null; usd: string | null } {
  const last = (re: RegExp) => { const ms = [...out.matchAll(re)]; return ms.length ? ms[ms.length - 1] : null; };
  const w = last(/悪くなった (\d+)/g), b = last(/良くなった (\d+)/g), p = last(/合格 前 (\d+) → 今 (\d+)/g);
  const usd = [...out.matchAll(/DeepSeek・Jev 等 \d+回 \$([0-9.]+)/g)].map((m) => Number(m[1])).reduce((a, x) => a + x, 0);
  return { worse: w ? Number(w[1]) : null, better: b ? Number(b[1]) : null, pass: p ? `${p[1]}→${p[2]}` : null, usd: usd ? `$${usd.toFixed(3)}` : null };
}
const resultsDirOf = (cwd: string) => join(cwd, "scripts", "brain-exam", "results");
function readRows(f: string): RowLite[] {
  if (!existsSync(f)) return [];
  const out: RowLite[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l) as RowLite); } catch { /* 書きかけ */ } }
  return out;
}
/** 止めた試験の書きかけの最後の行を落とす（--report が読めるように） */
function dropPartialLines(f: string): void {
  if (!existsSync(f)) return;
  const ok = readFileSync(f, "utf8").split("\n").filter((l) => { if (!l.trim()) return false; try { JSON.parse(l); return true; } catch { return false; } });
  writeFileSync(f, ok.join("\n") + (ok.length ? "\n" : ""));
}
const baseLabelOf = (cwd: string, label: string): string | null => {
  const j = readJson<{ commit?: string; cfg?: string } | null>(join(resultsDirOf(cwd), `${label}.baseline.json`), null);
  return j?.commit && j.cfg ? `main-${j.commit.slice(0, 7)}-${j.cfg}` : null;
};
function killTree(pid?: number): void { try { if (pid) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 終わった */ } }
/** npx tsx を子で動かす（出力は outFile に足す）。終わりを待つ */
function runTsx(cwd: string, argv: string[], env: Record<string, string>, outFile: string): { child: ReturnType<typeof spawn>; done: Promise<number | null> } {
  return runNpx(cwd, ["tsx", "--env-file=.env.local", ...argv], { ...env, LLM_TEST_MODE: "deepseek-all", EXAM_DAILY_CAP_USD: process.env.EXAM_DAILY_CAP_USD ?? "30" }, outFile);
}
function runNpx(cwd: string, argv: string[], env: Record<string, string>, outFile: string): { child: ReturnType<typeof spawn>; done: Promise<number | null> } {
  const fd = openSync(outFile, "a");
  // Windows は shell 経由で動かす＝空白・日本語のあるパス（C:\Users\竹内 悠馬\…）は引用符で包む
  const q = (a: string) => (process.platform === "win32" && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", argv.map(q), { cwd, shell: process.platform === "win32", env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  const done = new Promise<number | null>((res) => child.on("close", (c) => { try { closeSync(fd); } catch { /* */ } res(c); }));
  return { child, done };
}
/** 止めた試験の片付け（テストの会話の行を id で消す・exam-brain.ts --cleanup の手順） */
async function cleanupRun(cwd: string, label: string, outFile: string, startSize = 0): Promise<void> {
  // 2026-11-05 作業員1（弱い所 id 293）: この回の出力（startSize から）のレーン・main の子の会話を全部、その label で片付ける
  const all = existsSync(outFile) ? readFileSync(outFile) : Buffer.alloc(0);
  const out = all.subarray(Math.min(startSize, all.length)).toString("utf8");
  const targets = cleanupTargets(out, label);
  if (!targets.length) { log(`  片付け: テストの会話が読めない → 手で exam-brain.ts --cleanup --conv=YUMA2〜7 --label=${label} --from=${cwd} --apply`); return; }
  const mainWt = join(cwd, "..", "brain-exam-main");
  for (const t of targets) {
    const from = t.child ? mainWt : cwd;
    const r = runTsx(cwd, ["scripts/exam-brain.ts", "--cleanup", `--conv=${t.conv}`, `--label=${t.label}`, `--from=${from}`, "--apply"], {}, outFile);
    const c = await r.done;
    log(`  片付け: ${t.conv}・label ${t.label}${t.child ? "（main の子）" : ""} → ${c === 0 ? "済み" : `失敗（終わりの番号 ${c}）→ 手で同じ片付けを`}`);
  }
}
function cfg(): { releaseOrder?: string; notify?: Record<string, string> } { const c = readJson<{ releaseOrder?: string; notify?: Record<string, string> }>(CONFIG, {}); const a = arg("release-order"); if (a && a !== c.releaseOrder) { c.releaseOrder = a; writeFileSync(CONFIG, JSON.stringify(c, null, 1)); } return c; }
function writeBack(j: ExamJob, status: string): void {
  const f = cfg().releaseOrder;
  if (!f || !j.switch) return;
  try {
    const r = updateReleaseOrder(readFileSync(f, "utf8"), j.switch, status);
    if (r.changed) { writeFileSync(f, r.md); log(`  入れる順番の表に書いた: ${j.switch} → ${status}`); } else log(`  入れる順番の表にスイッチ ${j.switch} の行が無い（書かない）`);
  } catch (e) { log(`  入れる順番の表に書けない: ${String(e).slice(0, 120)}`); }
}
/** 2026-11-04 依頼の取り合いを防ぐ（流す役が2つ＝試験の列と tsc-remote の列）: 依頼のファイルを .claimed に付け替えられた方だけが流す */
function claimJob(j: ExamJob & { file: string }): boolean {
  if (j.file.endsWith(".claimed")) return true;
  try { renameSync(j.file, j.file + ".claimed"); j.file = j.file + ".claimed"; return true; } catch { return false; }
}
/** 順番待ちに戻す（取った印を外して元の名前で書く） */
/** 2026-11-04 作業員6（統括役の指示）: 立ち上がりの失敗（モジュールが無い等＝試験が流れていない）を見分ける。11/04 00:30Z の grp-reply-tag は node_modules が空で落ちたのに「確かな悪化0」で済みになった */
export const START_CRASH_RE = /MODULE_NOT_FOUND|Cannot find (?:module|package) ['"@]|ERR_MODULE_NOT_FOUND|\.env\.local: not found/;   // 11/04 02:39Z: 作業ツリーに .env.local が無く全部の本が 9 で落ちた
export const CRASH_STOP_AFTER = 3;
/** 立ち上がりで落ちた時: 済みにせず待ちに戻す。同じ依頼が3回続けて落ちたら止めて知らせる（true＝片付けた） */
function handleStartCrash(j: ExamJob & { file: string }, text: string, outFile: string): boolean {
  const m = text.match(START_CRASH_RE);
  if (!m) return false;
  const n = (j.crashes ?? 0) + 1;
  if (n >= CRASH_STOP_AFTER) {
    const verdict = `立ち上がりで ${n}回続けて落ちた（${m[0]}）→ 止めた・手で直してから足し直す`;
    finish({ ...j, crashes: n }, { label: j.label, owner: j.owner, switch: j.switch, verdict, crashes: n, at: new Date().toISOString() },
      `| ${new Date().toISOString().slice(0, 16)} | ${j.switch} | ${j.owner} | ${j.label} | ${verdict} | - | - | ? |`, `試験 ${j.label}: ${verdict}`);
    log(`  ⛔ ${j.label}: ${verdict}（${outFile}）`);
    return true;
  }
  requeueJob({ ...j, crashes: n, notBefore: new Date(Date.now() + 10 * 60_000).toISOString() });
  log(`  立ち上がりで落ちた（${m[0]}・${n}回目）→ 済みにせず順番待ちに戻した（${j.label}・10分後から）`);
  return true;
}
function requeueJob(j: ExamJob & { file: string }): void {
  const orig = j.file.replace(/\.claimed$/, "");
  writeFileSync(orig, JSON.stringify({ ...j, tries: j.tries + 1, file: undefined }, null, 1));
  if (orig !== j.file) { try { unlinkSync(j.file); } catch { /* */ } }
}
function finish(j: ExamJob & { file: string }, result: Record<string, unknown>, line: string, status: string): void {
  writeFileSync(join(RES, `${j.label}.json`), JSON.stringify(result, null, 1));
  appendFileSync(join(RES, "results.md"), line + "\n");
  renameSync(j.file, join(DONE, j.file.split(/[\\/]/).pop()!.replace(/\.claimed$/, "")));
  writeBack(j, status);
  // 終わったら依頼した人に知らせる: 統括（--run）は SendMessage を持たない → 知らせの行を notify.jsonl と conductor.log に出し、--run を見張る作業員が SendMessage で届ける
  const to = j.notify ?? cfg().notify?.[j.owner] ?? "";
  const msg = `${j.label} 終わり・${status}・結果は exam-queue/results/${j.label}.out.log（${j.label}.json）`;
  appendFileSync(join(RES, "notify.jsonl"), JSON.stringify({ at: new Date().toISOString(), to, owner: j.owner, label: j.label, msg }) + "\n");
  log(`  📣 知らせる: to=${to || `(相手なし・owner ${j.owner})`} ${msg}`);
}

/** tsc の依頼: %TEMP%/tsc.lock を取り（手で回す tsc と同じ鍵）、npx tsc --noEmit を1本流す。結果（0 か落ちた理由）を知らせる */
/** 2026-11-03 案A（竹内さん了承・指揮役）: 型の確かめを Vercel のお試しの場所（preview・--prod は付けない＝本番には出ない）で行う。
 *  作業ツリーから `vercel deploy --yes` を流し、next build（tsconfig のとおり scripts も入る）が READY なら「tsc 0（リモート）」、ERROR なら
 *  ビルドのログから型エラーの先頭3つを知らせる。コミットは要らない（手元のファイルをそのまま送る）。
 *  送らない物: .vercelignore が無い作業ツリーには、流す間だけ置く（.env* と試験の控え・exam-cache・node_modules を送らない）。お試しの場所は消さない */
export const REMOTE_IGNORE = [".env*", "!.env.example", ".claude", "node_modules", ".next", ".git", "scratchpad", "**/exam-cache", "scripts/.replay-out", "scripts/brain-exam/results", "*.log", "tsconfig.tsbuildinfo"];
/** 上げてはいけない物（.env 系・.claude・scratchpad・exam-cache・node_modules） */
export const REMOTE_FORBIDDEN = (rel: string) => { const p = rel.replace(/\\/g, "/"); const base = p.split("/").pop() ?? ""; return (/^\.env/.test(base) && base !== ".env.example") || /(^|\/)(\.claude|scratchpad|exam-cache|node_modules|\.git)(\/|$)/.test(p); };
/** 上がるファイルの一覧（.vercelignore と CLI の既定の外し方を gitignore の決まりで当てる）を作り、上げてはいけない物が無いか確かめる */
export async function remoteUploadCheck(cwd: string): Promise<{ ok: boolean; files: number; bytes: number; bad: string[]; why: string }> {
  const ig = (await import("ignore")).default();
  const vi = join(cwd, ".vercelignore");
  if (!existsSync(vi)) return { ok: false, files: 0, bytes: 0, bad: [], why: ".vercelignore が無い" };
  const text = readFileSync(vi, "utf8");
  if (!/^\.env\*\s*$/m.test(text) || !/^\.claude\s*$/m.test(text)) return { ok: false, files: 0, bytes: 0, bad: [], why: ".vercelignore に .env* か .claude が無い" };
  ig.add(text).add([".git", ".vercel", "node_modules"]);
  const { readdirSync: rd, statSync: st } = await import("node:fs");
  const files: string[] = []; let bytes = 0;
  const walk = (dir: string) => {
    for (const e of rd(join(cwd, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (ig.ignores(e.isDirectory() ? `${rel}/` : rel)) continue;
      if (e.isDirectory()) walk(rel); else if (e.isFile()) { files.push(rel); try { bytes += st(join(cwd, rel)).size; } catch { /* */ } }
    }
  };
  walk("");
  const bad = files.filter(REMOTE_FORBIDDEN);
  const why = bad.length ? `上げてはいけない物が残る: ${bad.slice(0, 5).join("・")}` : files.length > 20000 || bytes > 300 * 1024 * 1024 ? `多すぎる（${files.length}件・${Math.round(bytes / 1048576)}MB）` : `上がる ${files.length}件・${Math.round(bytes / 1048576)}MB・.env 系 0`;
  return { ok: !bad.length && files.length <= 20000 && bytes <= 300 * 1024 * 1024, files: files.length, bytes, bad, why };
}
export function remoteTypeErrors(out: string): string[] {
  const lines = out.split(/\r?\n/);
  const errs: string[] = [];
  for (let i = 0; i < lines.length && errs.length < 3; i++) {
    const l = lines[i];
    if (/Type error:|error TS\d+/.test(l)) { const prev = /^\S.*\.(ts|tsx):\d+:\d+/.test(lines[i - 1] ?? "") ? `${lines[i - 1].trim()} ` : ""; errs.push((prev + l.trim()).replace(/\s+/g, " ").slice(0, 200)); }
  }
  return errs;
}
function finishStop(j: ExamJob & { file: string }, verdict: string): void {
  const at = new Date().toISOString();
  finish(j, { label: j.label, owner: j.owner, runner: j.runner, cwd: j.cwd, verdict, at }, `| ${at.slice(0, 16)} | ${j.runner} | ${j.owner} | ${j.label} | ${verdict.slice(0, 80)} | - | - | $0 |`, verdict);
}
async function runTscRemoteJob(j: ExamJob & { file: string }): Promise<void> {
  const outFile = join(RES, `${j.label}.out.log`);
  const at = () => new Date().toISOString();
  log(`流す: ${j.label}（${j.owner}・tsc-remote・${j.cwd}）`);
  writeFileSync(outFile, `=== ${at()} vercel deploy --yes（お試しの場所・本番ではない・${j.cwd}）===\n`);
  // プロジェクトの紐付け（.vercel/project.json の projectId・orgId は鍵ではない）が無ければ倉庫の根から写す
  const linkDir = join(j.cwd, ".vercel"), rootLink = join(examCacheRoot(), "..", "..", ".vercel", "project.json");
  if (!existsSync(join(linkDir, "project.json"))) {
    // 新しいプロジェクトを作らない: 倉庫の根（main の作業ツリー）の紐付け（sumora-ai-ui）だけを写す。無ければ上げずに止める
    const link = existsSync(rootLink) ? (JSON.parse(readFileSync(rootLink, "utf8")) as { projectName?: string; projectId?: string }) : null;
    if (!link?.projectId || link.projectName !== "sumora-ai-ui") { log(`  ⛔ 上げない: 紐付け（.vercel/project.json の sumora-ai-ui）が見つからない`); finishStop(j, "紐付けが無い・上げていない"); return; }
    mkdirSync(linkDir, { recursive: true }); writeFileSync(join(linkDir, "project.json"), readFileSync(rootLink));
  }
  const ignoreFile = join(j.cwd, ".vercelignore");
  const placedIgnore = !existsSync(ignoreFile);
  if (placedIgnore) writeFileSync(ignoreFile, REMOTE_IGNORE.join("\n") + "\n");
  // 上げる前の確かめ: 上がる一覧に .env 系・.claude・scratchpad・exam-cache が無いこと。確かめられない時は上げない
  let chk: Awaited<ReturnType<typeof remoteUploadCheck>>;
  try { chk = await remoteUploadCheck(j.cwd); } catch (e) { chk = { ok: false, files: 0, bytes: 0, bad: [], why: `確かめられない: ${String(e).slice(0, 100)}` }; }
  appendFileSync(outFile, `上げる前の確かめ: ${chk.why}\n`);
  if (!chk.ok) { if (placedIgnore) { try { unlinkSync(ignoreFile); } catch { /* */ } } log(`  ⛔ 上げない: ${chk.why}`); finishStop(j, `上げていない（${chk.why}）`); return; }
  log(`  上げる前の確かめ: ${chk.why}`);
  let code: number | null = null;
  try {
    const fd = openSync(outFile, "a");
    const child = spawn(process.platform === "win32" ? "vercel.cmd" : "vercel", ["deploy", "--yes"], { cwd: j.cwd, shell: process.platform === "win32", env: { ...process.env }, stdio: ["ignore", fd, fd] });
    code = await new Promise<number | null>((res) => child.on("close", (c) => { try { closeSync(fd); } catch { /* */ } res(c); }));
  } finally { if (placedIgnore) { try { unlinkSync(ignoreFile); } catch { /* */ } } }
  let out = readFileSync(outFile, "utf8");
  const url = [...out.matchAll(/https:\/\/[\w.-]+\.vercel\.app/g)].map((m) => m[0]).pop() ?? null;
  // ビルドのログが deploy の出力に無い時は inspect --logs で取る
  if (code !== 0 && url && !remoteTypeErrors(out).length) {
    appendFileSync(outFile, `\n=== ${at()} vercel inspect ${url} --logs ===\n`);
    const fd = openSync(outFile, "a");
    const child = spawn(process.platform === "win32" ? "vercel.cmd" : "vercel", ["inspect", url, "--logs"], { cwd: j.cwd, shell: process.platform === "win32", stdio: ["ignore", fd, fd] });
    await new Promise((res) => child.on("close", () => { try { closeSync(fd); } catch { /* */ } res(null); }));
    out = readFileSync(outFile, "utf8");
  }
  // 2026-11-05 作業員1（作業員3の気付き・op2-on-tsc）: vercel deploy が組み立ての途中で「Not authorized」等で終わっても、組み立ては続いて READY になる事がある。
  //   型の誤りが出ていないのに失敗で終わった時は、inspect で組み立ての状態を最大15分見て、READY なら tsc 0・ERROR なら失敗にする（EXAM_TSC_REMOTE_WAIT_MIN）
  let waitedState: string | null = null;
  if (code !== 0 && url && !remoteTypeErrors(out).length) {
    const until = Date.now() + Number(process.env.EXAM_TSC_REMOTE_WAIT_MIN ?? "15") * 60_000;
    while (Date.now() < until) {
      let txt = ""; try { txt = execFileSync(process.platform === "win32" ? "vercel.cmd" : "vercel", ["inspect", url], { cwd: j.cwd, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString(); } catch (e) { txt = String((e as { stdout?: Buffer; stderr?: Buffer }).stdout ?? "") + String((e as { stderr?: Buffer }).stderr ?? ""); }
      const st = remoteDeployState(txt);
      if (st === "READY" || st === "ERROR" || st === "CANCELED") { waitedState = st; break; }
      await new Promise((r) => setTimeout(r, 30_000));
    }
    appendFileSync(outFile, `
=== ${at()} 組み立ての状態（inspect）: ${waitedState ?? "分からない（待ちの上限）"} ===
`);
    if (waitedState === "READY") code = 0;
  }
  const errs = remoteTypeErrors(out);
  const verdict = code === 0 ? "tsc 0（リモート）" : errs.length ? `tsc 型エラー（リモート）: ${errs.join(" ／ ")}` : `ビルド失敗（リモート・型以外の可能性・終わりの番号 ${code}）`;
  finish(j, { label: j.label, owner: j.owner, runner: "tsc-remote", cwd: j.cwd, code, url, errors: errs, verdict, at: at() },
    `| ${at().slice(0, 16)} | tsc-remote | ${j.owner} | ${j.label} | ${verdict.slice(0, 80)} | - | - | $0 |`, `${verdict}${url ? `（${url}）` : ""}`);
  log(`  済み: ${j.label} → ${verdict}`);
}
async function runTscJob(j: ExamJob & { file: string }): Promise<void> {
  const outFile = join(RES, `${j.label}.out.log`);
  const at = () => new Date().toISOString();
  const lock = join(process.env.TEMP ?? process.env.TMP ?? ".", "tsc.lock");
  try { mkdirSync(lock); } catch { log(`  tsc の鍵が取れない（${lock} がある）→ 待つ`); return; }
  const heap = process.env.EXAM_TSC_HEAP_MB ?? "8192";
  log(`流す: ${j.label}（${j.owner}・tsc・heap ${heap}MB・${j.cwd}）`);
  writeFileSync(outFile, `=== ${at()} npx tsc --noEmit（${j.cwd}）===\n`);
  let code: number | null = null;
  try { code = await runNpx(j.cwd, ["tsc", "--noEmit"], { NODE_OPTIONS: `--max-old-space-size=${heap}` }, outFile).done; }
  finally { try { rmdirSync(lock); } catch { /* */ } }
  const out = readFileSync(outFile, "utf8");
  const errs = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  const verdict = code === 0 ? "tsc 0" : code === 134 || /heap out of memory|JavaScript heap/i.test(out) ? `tsc 落ちた（${code}・メモリ不足）` : errs.length ? `tsc 型エラー ${errs.length}件: ${errs.slice(0, 3).map((l) => l.trim().slice(0, 140)).join(" ／ ")}` : `tsc 落ちた（終わりの番号 ${code}）`;
  finish(j, { label: j.label, owner: j.owner, runner: "tsc", cwd: j.cwd, code, errors: errs.length, verdict, at: at() },
    `| ${at().slice(0, 16)} | tsc | ${j.owner} | ${j.label} | ${verdict.slice(0, 80)} | - | - | $0 |`, verdict);
  log(`  済み: ${j.label} → ${verdict}`);
}

async function runJob(j: ExamJob & { file: string }): Promise<void> {
  if (j.runner === "tsc" && process.env.EXAM_TSC_LOCAL !== "on") return runTscRemoteJob(j); // 古い依頼の tsc も手元でなく Vercel の上で（EXAM_TSC_LOCAL=on の時だけ手元）
  if (j.runner === "tsc") return runTscJob(j);
  if (j.runner === "tsc-remote") return runTscRemoteJob(j);
  const outFile = join(RES, `${j.label}.out.log`);
  const at = () => new Date().toISOString();
  // 本番の見張り（2分ごと）: 悪ければ止めて片付け・順番待ちに戻す
  let stopped: string | null = null;
  let cur: ReturnType<typeof spawn> | null = null;
  const watch = setInterval(async () => { const h = await prodHealthy(); if (!h.ok && !stopped) { stopped = h.why; log(`  ⏹ 本番の調子が悪い → 止める（${h.why}）`); killTree(cur?.pid); } }, 120_000);
  try {
    if (j.runner === "cmd") {
      log(`流す: ${j.label}（${j.owner}・${j.switch}・${j.cmds!.length}本・${j.cwd}）`);
      const codes: Array<number | null> = [];
      // 2026-11-04 作業員6: 組の中の1本でも空きメモリで断られたら（試験は流れていない）「済み」にせず待ちに戻す（11/03 22:27Z の grp-aix-first が断られたまま済みになった）
      let refused: string | null = null;
      let crashText: string | null = null;
      for (const c of j.cmds!) {
        if (stopped || refused) break;
        appendFileSync(outFile, `\n=== ${at()} npx tsx --env-file=.env.local ${c} ===\n`);
        const before = statSync(outFile).size;
        // 2026-11-05 作業員4の頼み: --qfile="C:/Users/竹内 悠馬/…" が空白で切れていた（ci-v1L・ci-v3L）＝引用符を含む塊は1つの引数に（exam-plan.splitCmdArgs）
        const r = runTsx(j.cwd, splitCmdArgs(c), { ...j.env, ...(j.capUsd ? { EXAM_MAX_USD: String(j.capUsd) } : {}), ...(businessHoursLane() ? { EXAM_CONCURRENCY: "1" } : {}) }, outFile); cur = r.child;
        codes.push(await r.done);
        const tail = readFileSync(outFile).subarray(before).toString("utf8");
        const m = tail.match(/空きメモリ\s*\d+MB\s*<\s*\d+MB（--force で流す）/);
        if (m) refused = m[0];
        if (!m && START_CRASH_RE.test(tail)) { crashText = tail; break; }
      }
      if (crashText && !stopped && handleStartCrash(j, crashText, outFile)) return;
      // 断られた時は10分後から（同じ空きメモリですぐ取り直して断られ続けないように）
      if (refused && !stopped) { requeueJob({ ...j, notBefore: new Date(Date.now() + 10 * 60_000).toISOString() }); log(`  断られた（${refused}）→ 済みにせず順番待ちに戻した（${j.label}・10分後から）`); return; }
      if (stopped) { requeueJob(j); log(`  順番待ちに戻した（${j.label}・片付けは依頼者の手順で）`); return; }
      const s = summarize(readFileSync(outFile, "utf8"));
      const verdict = codes.every((c) => c === 0) ? "流し終えた（採点は依頼者）" : `失敗あり（終わりの番号 ${codes.join(",")}）`;
      finish(j, { label: j.label, owner: j.owner, switch: j.switch, runner: "cmd", cmds: j.cmds, codes, usd: s.usd, verdict, at: at() },
        `| ${at().slice(0, 16)} | ${j.switch} | ${j.owner} | ${j.label} | ${verdict} | - | - | ${s.usd ?? "?"} |`, `試験 ${j.label}: ${verdict}（${at().slice(5, 16).replace("T", " ")}Z）`);
      log(`  済み: ${j.label} → ${verdict}`);
      return;
    }
    // brain-exam: ③ 問題ごとの回数（揺れる問題は増やす）
    const ids = j.only.split(",").filter(Boolean);
    const rp = jobRepsPlan(j, ids);
    const maxRep = Math.max(j.repeat, ...Object.values(rp.reps));
    const repsFile = join(RES, `${j.label}.reps.json`);
    writeFileSync(repsFile, JSON.stringify(rp.reps, null, 1));
    log(`流す: ${j.label}（${j.owner}・${j.switch}・${ids.length ? ids.length + "問" : "rag"}・${j.repeat}回${rp.flaky.length ? `・揺れる ${rp.flaky.map((x) => `${x.id}×${rp.reps[x.id]}`).join(",")}` : ""}・${j.cwd}）`);
    for (const f of rp.flaky) log(`  揺れる ${f.id}: ${f.why}`);
    if (rp.stable?.length) log(`  安定（揺れの記録で独立に3回以上同じ答え）→ 1回: ${rp.stable.join(",")}`);
    const argv = ["scripts/brain-exam.ts", `--label=${j.label}`, "--conv=auto", "--baseline=main", `--repeat=${maxRep}`, `--stage=${j.stage}`];
    if (ids.length) argv.push(`--only=${j.only}`, `--reps-file=${repsFile}`);
    if (j.selectRag) argv.push("--select=rag");
    // 2026-11-04 (b): 依頼の作業ツリーの brain-exam.ts が止める印を見ない（origin/main より古い）時は上限を延ばす（EXAM_JOB_OLD_MAX_MIN・既定 120分）。依頼の行と結果にも出す
    const behind = (() => { try { return Number(execFileSync("git", ["-C", j.cwd, "rev-list", "--count", "HEAD..origin/main"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()); } catch { return null; } })();
    const guard = staleExamGuard((() => { try { return readFileSync(join(j.cwd, "scripts", "brain-exam.ts"), "utf8"); } catch { return ""; } })(), Number.isFinite(behind as number) ? behind : null,
      j.maxMin ?? Number(process.env.EXAM_JOB_MAX_MIN ?? "40"), Number(process.env.EXAM_JOB_OLD_MAX_MIN ?? "120"));
    if (guard.note) log(`  ⚠ ${guard.note}（${j.label}・${j.cwd}）`);
    const startSize = existsSync(outFile) ? statSync(outFile).size : 0;
    // 2026-11-04 作業員1（統括役の了承 (c)）: 時間の上限では殺さず止める印を置く＝brain-exam が問題の区切りで止まり、
    //   取れた「今」の行と回の揃った「前」（main）を取り置いてから終わる（-r が前を作り直さない）。猶予（EXAM_JOB_STOP_GRACE_MIN・既定 15分）を過ぎたら殺す
    const stopFile = join(ROOT, `.stop-${j.label}`);
    try { unlinkSync(stopFile); } catch { /* 無ければよい */ }
    // 2026-11-06 作業員8（弱い所 357・11/05 の本番の時間切れ20回が昼の試験の呼び出しの山＝10分で 205〜220回・レーン3〜4本と重なった）: 営業時間（JST 9〜22時）はレーン1本（--urgent でも）
    const bizLane = businessHoursLane();
    if (bizLane) log(`  営業時間（JST 9〜22時）なのでレーン1本（弱い所 357・feedback_no_heavy_db_business_hours）`);
    if (j.capUsd) log(`  費用の上限 $${j.capUsd.toFixed(2)}（EXAM_MAX_USD・届いたら次の問題の前で止まる）`);
    const r = runTsx(j.cwd, argv, { ...j.env, EXAM_STOP_FILE: stopFile, ...(j.capUsd ? { EXAM_MAX_USD: String(j.capUsd) } : {}), ...(guard.laneOld || bizLane ? { EXAM_CONCURRENCY: "1" } : {}) }, outFile); cur = r.child;
    // ① 早めの打ち切り（30秒ごと）
    let early: { stop: string; why: string; base: string } | null = null;
    const rowsFile = join(resultsDirOf(j.cwd), `${j.label}.jsonl`);
    const earlyOn = process.env.EXAM_STOP_EARLY !== "off" && ids.length > 0;
    const ew = earlyOn ? setInterval(() => {
      if (early || stopped) return;
      const bl = baseLabelOf(j.cwd, j.label); if (!bl) return;
      const v = earlyVerdict(readRows(rowsFile), readRows(join(resultsDirOf(j.cwd), `${bl}.jsonl`)), rp.reps, new Set(rp.flaky.map((x) => x.id)));
      if (v.stop) { early = { stop: v.stop, why: v.why, base: bl }; log(`  ⏩ 早めの打ち切り: ${v.why}`); killTree(cur?.pid); }
    }, 30_000) : null;
    // 2026-11-04 (b): 1本の時間の上限（既定 40分・依頼の maxMin・EXAM_JOB_MAX_MIN）。超えたら止めて途中までを集計し、残りの問題を分けた依頼にして後ろへ
    let timedOut = false as boolean;
    const maxMin = guard.maxMin;
    const graceMin = Number(process.env.EXAM_JOB_STOP_GRACE_MIN ?? "15");
    let graceT: ReturnType<typeof setTimeout> | null = null;
    const tl = maxMin > 0 ? setTimeout(() => {
      if (early || stopped) return;
      timedOut = true;
      try { writeFileSync(stopFile, at()); } catch { /* 置けなければ下の猶予で殺す */ }
      log(`  ⏱ 1本の時間の上限 ${maxMin}分 → 止める印を置いた（問題の区切りで止まり、取れた行と前を取り置く・最大 ${graceMin}分待つ）（${j.label}）`);
      graceT = setTimeout(() => { log(`  ⏱ 止める印から ${graceMin}分で止まらない → 止める（${j.label}）`); killTree(cur?.pid); }, Math.max(0, graceMin) * 60_000);
    }, maxMin * 60_000) : null;
    const code = await r.done;
    if (tl) clearTimeout(tl);
    if (graceT) clearTimeout(graceT);
    try { unlinkSync(stopFile); } catch { /* */ }
    if (ew) clearInterval(ew);
    if (timedOut && !(early as unknown) && !stopped) {
      const bl = baseLabelOf(j.cwd, j.label);
      const tEarly = { stop: "time", why: `1本の時間の上限 ${maxMin}分`, base: bl ?? "" };
      early = tEarly;
      const rest = remainingIds(rp.reps, readRows(rowsFile));
      if (rest.length) {
        const nj: ExamJob = { ...j, id: `${j.id}-r`, label: `${j.label}-r`, only: rest.join(","), flaky: (j.flaky ?? []).filter((x) => rest.includes(x)), createdAt: new Date().toISOString(), tries: 0 };
        delete (nj as { file?: string }).file;
        writeFileSync(join(ROOT, `${nj.createdAt.replace(/[:.]/g, "-")}-${nj.label}.json`), JSON.stringify(nj, null, 1));
        log(`  残り ${rest.length}問を分けた依頼にした: ${nj.label}`);
        tEarly.why += `・残り ${rest.length}問は ${nj.label}`;
      }
    }
    if (stopped) { await cleanupRun(j.cwd, j.label, outFile, startSize); requeueJob(j); log(`  順番待ちに戻した（${j.label}）`); return; }
    if (!early) {
      const runText = existsSync(outFile) ? readFileSync(outFile).subarray(startSize).toString("utf8") : "";
      // 前（main）の実行だけが落ちて自分の回は流れた時は済みにしてよい＝合格の数が読めない時だけ落ちとみなす
      if (summarize(runText).pass == null && handleStartCrash(j, runText, outFile)) { await cleanupRun(j.cwd, j.label, outFile, startSize); return; }
    }
    if (early) {
      const e = early as { stop: string; why: string; base: string };
      await cleanupRun(j.cwd, j.label, outFile, startSize);
      dropPartialLines(rowsFile);
      appendFileSync(outFile, `\n=== ${at()} 早めの打ち切り（${e.why}）→ 集計し直す ===\n`);
      await runTsx(j.cwd, ["scripts/brain-exam.ts", `--report=${j.label}`, ...(e.base ? [`--baseline=${e.base}`] : [])], {}, outFile).done;
    }
    const s = summarize(existsSync(outFile) ? readFileSync(outFile, "utf8") : "");
    const tag = early ? ((early as { stop: string }).stop === "time" ? `（${(early as { why: string }).why}）` : "（早めの打ち切り）") : "";
    // 11/04 竹内さんの決定（使い回せる物は使い回す）: 録音（前の答え）と入力が main と同じだった回の数を結果に出す
    const reuse = (() => { try { const c = readJson<{ byTag?: Record<string, { real?: number; replayed?: number }> }>(join(resultsDirOf(j.cwd), `${j.label}.cost.json`), {}); const d = readJson<{ items?: Record<string, { same?: boolean }> }>(join(resultsDirOf(j.cwd), `${j.label}.inputdiff.json`), {}); let real = 0, rep = 0; for (const v of Object.values(c.byTag ?? {})) { real += v?.real ?? 0; rep += v?.replayed ?? 0; } const it = Object.values(d.items ?? {}); return `・使い回し: LLM ${rep}/${real + rep}回は録音・入力が main と同じ回 ${it.filter((x) => x.same).length}/${it.length}${rp.stable?.length ? `・安定で1回 ${rp.stable.length}問` : ""}`; } catch { return ""; } })();
    // 11/03 指揮役: 悪化を「確かな悪化」と「揺れの範囲の差」（揺れる問題・合格の差が main の割合で2回未満）に分けて書く
    // 2026-11-06 統括役（前を作る子が試験の費用の半分）: 前を夜の基準に固定した回（brain-exam が <label>.pin.json を書く）は、この回で外れた問題だけ今の main で前を作り直し、
    //   その問題は今の main の前と比べる（他は夜の基準のまま）。結果の行に「前は夜の基準（版 xxx）」と出す。止める: EXAM_BASELINE_PIN_CONFIRM=off（brain-exam が固定しない）
    const pin = readJson<{ pinned?: string; current?: string; confirm?: boolean; snapDay?: string | null } | null>(join(resultsDirOf(j.cwd), `${j.label}.pin.json`), null);
    let blMerged: string | null = null, pinNote = "";
    if (pin?.pinned) {
      pinNote = `・前は夜の基準（版 ${pin.pinned.slice(0, 7)}${pin.current && pin.current !== pin.pinned ? `・今の main ${pin.current.slice(0, 7)}` : ""}）`;
      const fails = pin.confirm && !j.dig ? pinConfirmIds(readRows(rowsFile) as unknown as Array<{ id: string; score?: { pass?: boolean } }>) : [];
      if (fails.length) {
        const cfl = `${j.label}-cf`, cfReps = join(RES, `${cfl}.reps.json`);
        writeFileSync(cfReps, JSON.stringify(Object.fromEntries(fails.map((id) => [id, rp.reps[id] ?? j.repeat])), null, 1));
        log(`  確かめ直し: 外れた ${fails.length}問（${fails.join(",")}）だけ今の main で前を作る（${cfl}）`);
        appendFileSync(outFile, `\n=== ${at()} 確かめ直し: 外れた問題だけ今の main で前を作る（${fails.join(",")}）===\n`);
        await runTsx(j.cwd, ["scripts/brain-exam.ts", `--label=${cfl}`, "--conv=auto", "--baseline=main", "--baseline-only", `--repeat=${maxRep}`, `--stage=${j.stage}`, `--only=${fails.join(",")}`, `--reps-file=${cfReps}`],
          { ...j.env, EXAM_BASELINE_NIGHTLY: "off", ...(pin.snapDay ? { EXAM_DB_SNAPSHOT_DAY: pin.snapDay } : {}), ...(guard.laneOld || bizLane ? { EXAM_CONCURRENCY: "1" } : {}) }, outFile).done;
        const blCf = baseLabelOf(j.cwd, cfl), blN = baseLabelOf(j.cwd, j.label);
        if (blCf && blN) {
          const merged = mergePinnedBase(readRows(join(resultsDirOf(j.cwd), `${blN}.jsonl`)) as unknown as Array<{ id: string }>, readRows(join(resultsDirOf(j.cwd), `${blCf}.jsonl`)) as unknown as Array<{ id: string }>, fails);
          blMerged = `${j.label}.base-merged`;
          writeFileSync(join(resultsDirOf(j.cwd), `${blMerged}.jsonl`), merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
          pinNote += `・外れた ${fails.length}問は今の main（${blCf.slice(5, 12)}）の前と比べた`;
        } else pinNote += "・今の main の前を作れなかった（外れた問題も夜の基準と比べた）";
      }
    }
    const blFinal = blMerged ?? baseLabelOf(j.cwd, j.label);
    const sw = blFinal ? splitWorse(readRows(rowsFile), readRows(join(resultsDirOf(j.cwd), `${blFinal}.jsonl`)), new Set(rp.flaky.map((x) => x.id))) : null;
    const flakeNote = sw?.flake.length ? `・揺れの範囲の差 ${sw.flake.length}（${sw.flake.map((x) => `${x.id} ${x.why}`).join("／")}）` : "";
    const sureN = sw ? sw.sure.length : s.worse;
    // 2026-11-04 つなぎの芯の頼み: 両方で解いた問題が0（基準の回が書かれていない・時間の上限で止まった等）は「確かな悪化0」と書かない
    const cmpN = blFinal ? comparedIds(readRows(rowsFile), readRows(join(resultsDirOf(j.cwd), `${blFinal}.jsonl`))).length : 0;
    const noCompare = ids.length > 0 && cmpN === 0;
    // 2026-11-04 作業員2（基準を merge-base にした時に読み違えない）: 比べた「前」の main の commit を結果の行に出す
    const baseCommit = readJson<{ commit?: string } | null>(join(resultsDirOf(j.cwd), `${j.label}.baseline.json`), null)?.commit;
    const baseNote = (baseCommit ? `・基準 ${baseCommit.slice(0, 7)}` : "") + (guard.note ? `・${guard.note}` : "");
    // 2026-11-05 作業員8（試験の統括の結果の読み方・KB P0 2e164f41「限りなく竹内さんに近づける」）: 悪化なら、その問題の竹内さんの送信と答案の差（前→今の道）を添える
    const digNote = (() => {
      if (!sw || (!sw.sure.length && !sw.flake.length)) return "";
      try {
        const probs = readJson<Array<{ id: string; staffText?: string | null; staffAix?: string | null }>>(join(j.cwd, "scripts", "brain-exam", "problems.json"), []);
        const cur = readRows(rowsFile), base = blFinal ? readRows(join(resultsDirOf(j.cwd), `${blFinal}.jsonl`)) : [];
        const pathOf = (rows: RowLite[], id: string) => (rows.find((r) => r.id === id) as { path?: { code?: string } } | undefined)?.path?.code ?? null;
        const cmps: CmpLite[] = [...sw.sure.map((x) => ({ id: x.id, cmp: "worse" as const, sure: true })), ...sw.flake.map((x) => ({ id: x.id, cmp: "worse" as const, sure: false }))];
        const mats = cmps.map((c) => { const pr = probs.find((x) => x.id === c.id); return { id: c.id, staffText: pr?.staffText ?? null, staffAix: pr?.staffAix ?? null, brainPath: pathOf(cur, c.id), basePath: pathOf(base, c.id) }; });
        const r = readExamResult(cmps, mats);
        const i = r.line.indexOf("・掘りの材料");
        return i >= 0 ? r.line.slice(i) : "";
      } catch { return ""; }
    })();
    const verdictBase = (noCompare ? `比べられない（基準の回が無い・両方で解いた 0/${ids.length}問・既定 on の判断に使わない${blFinal ? `・基準 ${blFinal}` : ""}）` : sureN == null ? "結果を読めない" : sureN === 0 ? (cmpN < ids.length ? `比べた問題が少ない（両方で解いた ${cmpN}/${ids.length}問・悪化0とは言わない・既定 on の判断に使わない）` : `確かな悪化0（比べた ${cmpN}/${ids.length}問）`) : `確かな悪化 ${sureN}${sw ? `（${sw.sure.map((x) => `${x.id} ${x.why}`).join("／")}）` : ""}`) + flakeNote + tag + reuse + baseNote + pinNote + (j.dig ? "・掘り（--dig: 回数は --repeat のまま・揺れの切り分けと確かめ直し無し＝既定 on の判断に使わない）" : "");
    // 2026-11-06 作業員8（竹内さんの決定「試験から改善の仕方も強化・統括同士連携」・外れの自動の切り分け）: 外れた問題ごとに、どの段で道が変わったか（ブレインの生の答え→2段→場面の網→決まった書き換え→書き手→最終チェック）を記録から出す。
    //   悪化の問題は verdict に、外れの問題は全部 result の missStages に残す（持ち主の統括は連携の表・仮の表で引く）。LLM なし。止める: EXAM_MISS_STAGE=off
    const missStages = (() => {
      if ((process.env.EXAM_MISS_STAGE ?? "").trim().toLowerCase() === "off") return [] as Array<ReturnType<typeof summarizeMisses> & { owner: string | null }>;
      try {
        // 回ごとの記録の印（係の出力の {"tag":"brain:answerable-direct"…}・[mgmt-*]）を、同じテスト用の会話の次の結果の行に付ける
        const names = new Map(NO_LINE_TEST_CONVERSATIONS.map((c) => [c.id, c.name]));
        const tags = parseLogTags(existsSync(outFile) ? readFileSync(outFile, "utf8") : "", (id) => names.get(id) ?? null);
        const cur = (readRows(rowsFile) as unknown as MissRowLite[]).map((r) => ({ ...r, logTags: tags.get(`${r.id}#${r.rep}`) ?? null }));
        return ids.map((id) => summarizeMisses(cur.filter((r) => r.id === id))).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ ...x, owner: ownerOf(x.markers)?.id ?? null }));
      } catch { return []; }
    })();
    const worseIds = new Set([...(sw?.sure ?? []), ...(sw?.flake ?? [])].map((x) => x.id));
    const stageNote = missStages.filter((m) => m && worseIds.has(m.id)).map((m) => `${m!.line}${m!.owner ? `・持ち主 ${m!.owner}` : ""}`).join("／");
    // 2026-11-06 作業員4の相談（tk1106: 最終の道 9/9・本質 3/9＝決まった計算が判断を肩代わりしても見えない）: 本質の道（決まった計算の前のブレインの最初の答え）の当たりを毎回出す。問題×回で数える（brain-exam の「3段: 本質の道」と同じ数え方）
    const essence = (() => { try { const want = new Set(ids); const cnt = (rows: RowLite[]) => { const e = (rows as unknown as Array<{ id: string; essence?: { ok?: boolean } | null }>).filter((r) => want.has(r.id) && r.essence); return { ok: e.filter((r) => r.essence!.ok).length, n: e.length }; }; return { base: blFinal ? cnt(readRows(join(resultsDirOf(j.cwd), `${blFinal}.jsonl`))) : null, cur: cnt(readRows(rowsFile)) }; } catch { return null; } })();
    const essNote = essence && essence.cur.n ? `・本質 ${essence.base?.n ? `前${essence.base.ok}/${essence.base.n} → ` : ""}今${essence.cur.ok}/${essence.cur.n}` : "";
    const verdict = verdictBase + essNote + digNote + (stageNote ? `・切り分け: ${stageNote}` : "");
    // 2026-11-06 統括役（作業員8）: 外れの切り分けを弱い所の台帳（brain_weaknesses）へ。key＝段＋印の頭・同じ key の行があれば evidence に足す（upsertWeaknessHits）・持ち主・試験の名前・問題・回を evidence に・1回の試験で5行まで。
    //   台帳は RLS（ポリシーなし）＝サーバーの鍵が無い手元では書けない → 足す物を results/weakness-pending.jsonl に残し、鍵のある所で brain-weaknesses.ts --collect-miss-stages が足す（同じ回は二重に足さない）。止める: EXAM_MISS_WEAKNESS=off
    if ((process.env.EXAM_MISS_WEAKNESS ?? "").trim().toLowerCase() !== "off" && missStages.length) {
      try {
        // ブレインの段の key は「本質の道→正解の道」（正解は問題の accept の1つ目）
        const probAccept = (() => { try { return new Map(readJson<Array<{ id: string; accept?: string[] }>>(join(j.cwd, "scripts", "brain-exam", "problems.json"), []).map((p) => [p.id, p.accept?.[0] ?? null])); } catch { return new Map<string, string | null>(); } })();
        const hits = weaknessHitsFromMisses(j.label, missStages, { max: 5, acceptOf: (id) => probAccept.get(id) ?? null });
        if (hits.length) {
          appendFileSync(join(RES, "weakness-pending.jsonl"), JSON.stringify({ label: j.label, at: at(), hits }) + "\n");
          log(`  弱い所: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? await recordExamWeaknesses(db() as never, j.label, hits) : `台帳の鍵が無い＝${hits.length}行を weakness-pending.jsonl に残した（${hits.map((h) => h.key).join("・")}）`}`);
        }
      } catch (e) { log(`  弱い所の台帳: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`); }
    }
    finish(j, { label: j.label, owner: j.owner, switch: j.switch, only: j.only, repeat: j.repeat, reps: rp.reps, code, early, ...s, worseSure: sw?.sure ?? null, worseFlake: sw?.flake ?? null, missStages, essence, verdict, at: at() },
      `| ${at().slice(0, 16)} | ${j.switch} | ${j.owner} | ${j.label} | ${verdict} | 合格 ${s.pass ?? "?"} | 良くなった ${s.better ?? "?"} | ${s.usd ?? "?"} |`,
      `試験 ${j.label}: ${verdict}・合格 ${s.pass ?? "?"}・良くなった ${s.better ?? "?"}・${s.usd ?? "?"}（${at().slice(5, 16).replace("T", " ")}Z）`);
    log(`  済み: ${j.label} → ${verdict}・合格 ${s.pass ?? "?"}・良くなった ${s.better ?? "?"}・費用 ${s.usd ?? "?"}`);
  } finally { clearInterval(watch); }
}

// 直に流された時だけ動く（テストが関所の関数だけ読む時は動かない）
if (/exam-conductor.ts$/.test(process.argv[1] ?? "")) (async () => {
  if (flag("add")) { addJob(); return; }
  // 11/03 指揮役: 知らせの未配達の見張り。流す役は notify.jsonl に書くだけ（SendMessage を持たない）＝届けた人が --delivered で印を付ける。
  //   未配達＝results/notify.jsonl の行のうち、id（`${at}|${label}`）が results/delivered.jsonl に無い物。作業員1の再開時と指揮役の見回りで全部届ける
  if (flag("undelivered") || arg("delivered")) {
    const nf = join(RES, "notify.jsonl"), df = join(RES, "delivered.jsonl");
    const done = new Set(existsSync(df) ? readFileSync(df, "utf8").split("\n").filter(Boolean).map((l) => { try { return String((JSON.parse(l) as { id: string }).id); } catch { return ""; } }) : []);
    if (arg("delivered")) { for (const id of arg("delivered").split(",").filter(Boolean)) appendFileSync(df, JSON.stringify({ id, by: arg("by", "?"), at: new Date().toISOString() }) + "\n"); console.log("印を付けた"); return; }
    const rows = existsSync(nf) ? readFileSync(nf, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as { at: string; to: string; owner: string; label: string; msg: string }; } catch { return null; } }).filter((x): x is { at: string; to: string; owner: string; label: string; msg: string } => !!x) : [];
    for (const r of rows.filter((x) => !done.has(`${x.at}|${x.label}`))) console.log(JSON.stringify({ id: `${r.at}|${r.label}`, to: r.to, owner: r.owner, msg: r.msg }));
    return;
  }
  if (flag("list")) { for (const j of readJobs()) console.log(`- ${j.createdAt.slice(0, 16)} ${j.label}（${j.owner}・${j.switch}・${j.runner === "tsc-remote" ? "tsc-remote" : j.runner === "tsc" ? "tsc" : j.runner === "cmd" ? `${j.cmds?.length}本` : `${j.only || "rag"}・${j.repeat}回`}・試み ${j.tries}）`); return; }
  if (flag("run")) {
    // 流す役は PC で1つだけ（夜の予定のタスクと手で起こした物が重ならない）: run.lock に pid・生きていれば何もしない
    //   2026-11-04: --remote は tsc-remote だけを流す2つ目の流す役（鍵は run-remote.lock・試験が長く流れている間も型の確かめを待たせない）
    const REMOTE_ONLY = flag("remote");
    const RUN_LOCK = join(ROOT, REMOTE_ONLY ? "run-remote.lock" : "run.lock");
    const held = readJson<{ pid?: number } | null>(RUN_LOCK, null);
    if (held?.pid && held.pid !== process.pid) { let alive = false; try { process.kill(held.pid, 0); alive = true; } catch { /* 止まっている */ } if (alive) { log(`別の流す役が動いている（pid ${held.pid}）→ 足した依頼はそちらが流す`); return; } }
    ensureDirs(); writeFileSync(RUN_LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    process.on("exit", () => { try { if (readJson<{ pid?: number } | null>(RUN_LOCK, null)?.pid === process.pid) unlinkSync(RUN_LOCK); } catch { /* */ } });
    cfg();
    const tscAlerted = new Set<string>();
    let emptyNoted = false;
    for (;;) {
      // 2026-11-05 作業員4（竹内さん KB 95f492fc ⑤）: 危ない所の見張りの手元の分を夜1回（2つ目の流す役だけ・止める EXAM_HAZARD_AUDIT=off）。本番の分は Vercel の cron hazard-audit-db
      if (REMOTE_ONLY && (process.env.EXAM_HAZARD_AUDIT ?? "").trim().toLowerCase() !== "off") {
        mkdirSync(MARKS, { recursive: true });
        const lastFile = join(MARKS, "hazard-audit-last.json");
        const ha = hazardAuditDue(readJson<{ day?: string } | null>(lastFile, null)?.day ?? null);
        if (ha.due) {
          writeFileSync(lastFile, JSON.stringify({ day: ha.day, at: new Date().toISOString() }));
          const out = join(RES, `hazard-audit-${ha.day}.log`);
          log(`危ない所の見張り（手元の分）を回す → ${out}`);
          const code = await runNpx(process.cwd(), ["tsx", "--env-file=.env.local", "scripts/hazard-audit.ts", "--save"], {}, out).done;
          const head = (() => { try { return readFileSync(out, "utf8").split(/\r?\n/).find((l) => l.startsWith("危ない所の見張り")) ?? ""; } catch { return ""; } })();
          log(`  見張り 終わり（${code}）: ${head.slice(0, 300)}`);
        }
      }
      // 2026-11-05 作業員8（統括役の了承の 1「前の答えを本番の commit ごとに1回だけ作って使い回す（夜に1回）」）: 夜の基準を作る依頼を、JST 21時以降に1日1つ積む
      //   （2つ目の流す役だけ・積むだけで流すのは試験の列＝夜だけ・止める EXAM_NIGHT_BASE=off）。終わると brain-exam が nightly-base-<構成>.json を書く
      if (REMOTE_ONLY && (process.env.EXAM_NIGHT_BASE ?? "").trim().toLowerCase() !== "off") {
        mkdirSync(MARKS, { recursive: true });
        const nbFile = join(MARKS, "night-base-last.json");
        const nb = nightBaseJobDue(readJson<{ day?: string } | null>(nbFile, null)?.day ?? null, new Date(), { cwd: process.cwd() });
        // 印が無くても、その日の依頼が列・済み・結果にあれば積まない（印を移した日の二重を防ぐ）
        const names = (d: string) => { try { return readdirSync(d); } catch { return [] as string[]; } };
        if (nb.due && nb.job && nightBaseAlready(nb.day, [...names(ROOT), ...names(DONE), ...names(RES), ...names(join(ROOT, "withdrawn"))])) {
          writeFileSync(nbFile, JSON.stringify({ day: nb.day, at: new Date().toISOString(), note: "already" }));
        } else if (nb.due && nb.job) {
          writeFileSync(nbFile, JSON.stringify({ day: nb.day, at: new Date().toISOString() }));
          writeFileSync(join(ROOT, `${String(nb.job.createdAt).replace(/[:.]/g, "-")}-${nb.job.label}.json`), JSON.stringify(nb.job, null, 1));
          log(`夜の基準の依頼を積んだ: ${nb.job.label}（夜だけ流す）`);
        }
      }
      const isRemoteJob = (x: ExamJob) => x.runner === "tsc-remote" || (x.runner === "tsc" && process.env.EXAM_TSC_LOCAL !== "on") || (x.runner === "cmd" && !!x.readOnly);
      // 読むだけの依頼は2つ目の流す役だけが流す（試験の列を止めない・試験の列の先頭の扱いにもしない）
      const jobs = readJobs().filter((x) => (REMOTE_ONLY ? isRemoteJob(x) : !(x.runner === "cmd" && x.readOnly)));
      // 2026-11-06 作業員8（P0 8805bd74・11/05 17:16Z に「順番待ちは空」で終わり、後から積まれた依頼が 02:55 JST まで流れなかった）:
      //   列が空でも終わらず待つ（--remote と同じ形）。空になった時に1回だけ知らせる。--once の時だけ今まで通り終わる
      if (!jobs.length) {
        if (flag("once")) { log("順番待ちは空（--once）"); return; }
        if (!emptyNoted) { log(`順番待ちは空 → 待ち続ける（${REMOTE_ONLY ? 60 : 120}秒ごとに見る）`); emptyNoted = true; }
        await new Promise((r) => setTimeout(r, (REMOTE_ONLY ? 60 : 120) * 1000)); continue;
      }
      if (emptyNoted) { log(`列に依頼が来た（${jobs.length}本）`); emptyNoted = false; }
      // 先頭から順に関所を見て、通った最初の依頼を流す（試験が安い時間を待つ間も tsc は先に流せる）
      let picked: (typeof jobs)[number] | null = null; const whys: string[] = [];
      let examBlocked = false;
      for (const j of jobs) { if (j.runner !== "tsc" && j.runner !== "tsc-remote" && examBlocked) continue; const g = await gate(j); if (g.ok) { picked = j; break; } whys.push(`${j.label}: ${g.why}`); if (j.runner !== "tsc" && j.runner !== "tsc-remote" && !j.nightOnly && !j.hold && !j.notBefore) examBlocked = true; }
      // tsc の順番待ちが長い（既定 60分・EXAM_TSC_WAIT_ALERT_MIN）時は指揮役に知らせる（依頼ごとに1回）
      for (const j of jobs.filter((x) => x.runner === "tsc" && !tscAlerted.has(x.id))) { const min = (Date.now() - Date.parse(j.createdAt)) / 60_000; if (min >= Number(process.env.EXAM_TSC_WAIT_ALERT_MIN ?? "60")) { tscAlerted.add(j.id); const why = whys.find((w) => w.startsWith(j.label + ":")) ?? ""; appendFileSync(join(RES, "notify.jsonl"), JSON.stringify({ at: new Date().toISOString(), to: "main", owner: j.owner, label: j.label, msg: `tsc の順番待ちが ${Math.round(min)}分（${why}）` }) + "\n"); log(`  📣 知らせる: to=main tsc の順番待ちが ${Math.round(min)}分（${j.label}・${j.owner}・${why}）`); } }
      if (!picked) { log(`待つ: ${whys.slice(0, 3).join("／")}（${jobs.length}本待ち）`); if (flag("once")) return; await new Promise((r) => setTimeout(r, (jobs.some((x) => x.runner === "tsc") ? 1 : 5) * 60_000)); continue; }
      if (!claimJob(picked)) continue; // もう一方の流す役が先に取った
      await runJob(picked);
      if (flag("once")) return;
    }
  }
  console.log("使い方: --add ... ／ --run [--once] [--release-order=<md>] ／ --list");
})();
