// scripts/lib/exam-flake.ts — ブレインの試験の「揺れ」の記録と、揺れる問題だけ繰り返す決め方（--repeat-flaky）
//
// 2026-10-15 竹内「試験の API を節約（質は落とさない）」④: --repeat=3（--majority）は全部の問題を3回回していた。
//   同じ問題・同じモデル・同じコードで答え（道・合格・下書きの道）が割れた事がある問題だけ3回回し、ずっと同じ答えの問題は1回で済ませる。
//   設計知見 b1a3ac8f「試験は直した所を重点的に・まず1回・揺れが判断を左右する時だけ回数を足す」・acb3548d「3回だと揺れを効果と取り違える」。
//
// 記録: <倉庫の根>/.claude/exam-cache/brain-exam-flake/<問題 id>/<label>-<pid>.jsonl（実行ごとに別のファイル＝同時に書いても混ざらない・鍵不要）
//   1行＝1回の答え: 問題の hash・モデル・コードの鍵（HEAD＋作業中の差の hash）・答えの印（道|合格|下書き）・independent（その回に本当に呼んだか）
//   ※ 録音の再生だけで出た回（independent=false）は前の答えの写し＝「揺れない証拠」に数えない（数えると録音を何度読んでも安定に見える）
// 決め方（問題ごと）:
//   flaky   … 同じ問題・同じモデル・同じコードの鍵の中で答えの印が2つ以上（30日以内）→ repeat 回全部
//   stable  … flaky でなく、独立に回した直近の答え 3回以上が全部同じ → 1回。1回目がいつもと違えば repeat 回まで足す（直った・壊れたを揺れと分ける）
//   unknown … それ以外 → 2回。2回が割れたら repeat 回まで足す
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { examCacheRoot } from "./llm-cassette";
import { atomicWriteText } from "./exam-shared-file";

export const FLAKE_DIR = join(examCacheRoot(), "brain-exam-flake");
export const FLAKE_WINDOW_DAYS = 30;
export const STABLE_MIN = 3;

export type FlakeObs = { id: string; problemHash: string; model: string; codeKey: string; label: string; rep: number; at: string; sig: string; pathSig: string; independent: boolean; legacy?: boolean };
export type FlakeVerdict = { verdict: "flaky" | "stable" | "unknown"; modal: string | null; why: string; n: number; /** 安定の決め手が旧の結果（道だけ）＝1回目の道だけを比べる */ pathOnly?: boolean };

type RowLike = { path?: { code?: string }; score?: { pass?: boolean }; draft?: { code?: string; pass?: boolean } | null; error?: string };
/** 答えの印（道｜合格｜下書きの道・合格）。合格は判定（依頼・言ってはいけない事）の揺れも入る */
export function sigOfRow(r: RowLike): string { return `${pathSigOfRow(r)}|${r.score?.pass ? "○" : "✕"}${r.draft ? `|下書き=${r.draft.code ?? ""}${r.draft.pass ? "○" : "✕"}` : ""}`; }
/** 道だけの印（正解の書き方に依らない＝正解を直した前後でも比べられる） */
export function pathSigOfRow(r: RowLike): string { return String(r.path?.code ?? ""); }

export function flakeEnabled(env: Record<string, string | undefined> = process.env): boolean { return String(env.EXAM_FLAKE_RECORD ?? "").trim().toLowerCase() !== "off"; }

/** コードの鍵: HEAD＋作業中の差（git diff HEAD と新しいファイルの名前）の hash。git が読めなければ null（＝実行ごとに別） */
export function currentCodeKey(cwd?: string): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const diff = execFileSync("git", ["diff", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const h = createHash("sha256").update(diff).update("\n--\n").update(untracked).digest("hex").slice(0, 10);
    return `${head.slice(0, 10)}+${h}`;
  } catch { return null; }
}

export function recordObs(o: FlakeObs, dir = FLAKE_DIR): void {
  if (!/^[\w-]+$/.test(o.id)) return;
  const d = join(dir, o.id);
  mkdirSync(d, { recursive: true });
  appendFileSync(join(d, `${o.label.replace(/[^\w.-]/g, "_")}-${process.pid}.jsonl`), JSON.stringify(o) + "\n");
}
export function readObs(id: string, dir = FLAKE_DIR, now = Date.now(), windowDays = FLAKE_WINDOW_DAYS): FlakeObs[] {
  const d = join(dir, id);
  if (!/^[\w-]+$/.test(id) || !existsSync(d)) return [];
  const out: FlakeObs[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".jsonl"))) {
    let txt = ""; try { txt = readFileSync(join(d, f), "utf8"); } catch { continue; }
    for (const l of txt.split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l) as FlakeObs); } catch { /* 書きかけの最後の行 */ } }
  }
  const since = now - windowDays * 86_400_000;
  return out.filter((o) => Date.parse(o.at) >= since);
}

/** 揺れの判定（同じ問題 hash・同じモデル）。旧の結果から取り込んだ物（legacy）は道だけで「揺れた」の証拠にだけ使う */
export function flakeVerdict(obs: FlakeObs[], want: { problemHash: string; model: string }): FlakeVerdict {
  const legacy = obs.filter((o) => o.legacy && o.model === want.model);
  const cur = obs.filter((o) => !o.legacy && o.problemHash === want.problemHash && o.model === want.model);
  const groups = new Map<string, Set<string>>();
  for (const o of cur) { const k = `c:${o.codeKey}`; groups.set(k, (groups.get(k) ?? new Set()).add(o.sig)); }
  for (const o of legacy) { const k = `l:${o.codeKey}`; groups.set(k, (groups.get(k) ?? new Set()).add(o.pathSig)); }
  const split = [...groups].find(([, s]) => s.size > 1);
  if (split) return { verdict: "flaky", modal: null, why: `同じコードで答えが割れた（${[...split[1]].slice(0, 3).join(" / ")}）`, n: cur.length + legacy.length };
  const ind = cur.filter((o) => o.independent).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (ind.length >= STABLE_MIN) {
    const recent = ind.slice(0, 5);
    if (recent.every((o) => o.sig === recent[0].sig)) return { verdict: "stable", modal: recent[0].sig, why: `独立に回した直近 ${recent.length}回が同じ答え`, n: cur.length };
    // コードの鍵が違う回どうしの違いは直した効果かもしれない＝揺れとは言えない → 2回から
    return { verdict: "unknown", modal: null, why: "直近の答えがコードの違う回で違う（直した効果か揺れか分からない）", n: cur.length };
  }
  // 旧の結果（録音の再生でない回）で、別々の実行 3つ以上・5回以上ずっと同じ道 → 道だけで安定（1回目の道がいつもと違えば足す）。
  //   合格（判定の揺れ）は見ていない＝今の記録で同じコードの合格が割れたら、上の「揺れる」に変わる
  const lind = legacy.filter((o) => o.independent);
  const runs = new Set(lind.map((o) => o.codeKey));
  if (lind.length >= LEGACY_STABLE_MIN && runs.size >= 3 && lind.every((o) => o.pathSig === lind[0].pathSig) && cur.every((o) => o.pathSig === lind[0].pathSig))
    return { verdict: "stable", modal: lind[0].pathSig, pathOnly: true, why: `旧の結果の別々の実行 ${runs.size}つ・${lind.length}回が同じ道`, n: cur.length + legacy.length };
  return { verdict: "unknown", modal: null, why: `独立に回した答えが ${ind.length}回（${STABLE_MIN}回で安定と見る）`, n: cur.length };
}
export const LEGACY_STABLE_MIN = 5;
/** 答えの印の道の所（sigOfRow の先頭） */
export function pathOfSig(sig: string): string { const i = sig.indexOf("|"); return i < 0 ? sig : sig.slice(0, i); }

/** rep 回目を回すか（1回目は必ず回す）。doneSigs はこの実行で済んだ回の答えの印（回の順） */
export function shouldRunRep(rep: number, v: FlakeVerdict, doneSigs: string[], repeat: number): boolean {
  if (rep > repeat) return false;
  if (rep <= 1) return true;
  if (v.verdict === "flaky") return true;
  if (v.verdict === "stable") return doneSigs.some((s) => (v.pathOnly ? pathOfSig(s) : s) !== v.modal);
  // unknown: 2回目までは回す・2回が割れたら残りも
  if (rep === 2) return true;
  return new Set(doneSigs).size > 1;
}

/**
 * 旧の結果（results/<label>.jsonl）から揺れを取り込む（道だけ・同じ実行（label）の中で割れたか）。
 * <id>/legacy-<label>.jsonl を丸ごと書き直す＝何度取り込んでも増えない。返り値は取り込んだ行の数
 */
export function importLegacyRows(rows: Array<RowLike & { id: string; rep: number; at?: string; model?: string }>, label: string, dir = FLAKE_DIR, o2: { independent?: boolean } = {}): number {
  const byId = new Map<string, FlakeObs[]>();
  for (const r of rows) {
    if (r.error || !r.path?.code || !r.id || !/^[\w-]+$/.test(r.id)) continue;
    const o: FlakeObs = { id: r.id, problemHash: "*", model: r.model ?? "", codeKey: `label:${label}`, label: `legacy-${label}`, rep: r.rep, at: r.at ?? new Date().toISOString(), sig: sigOfRow(r), pathSig: pathSigOfRow(r), independent: !!o2.independent, legacy: true };
    byId.set(r.id, [...(byId.get(r.id) ?? []), o]);
  }
  let n = 0;
  for (const [id, os] of byId) {
    atomicWriteText(join(dir, id, `legacy-${label.replace(/[^\w.-]/g, "_")}.jsonl`), os.map((o) => JSON.stringify(o)).join("\n") + "\n");
    n += os.length;
  }
  return n;
}
