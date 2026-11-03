// scripts/lib/exam-conductor-core.ts — 試験の統括の純関数（関所の時間・早めの打ち切り・揺れの回数・問題の選び・入れる順番の表への書き戻し）
//   scripts/exam-conductor.ts が使う。DB・ファイル・子の実行は持たない（テストは scripts/__tests__/exam-conductor.test.ts）
import type { FlakeObs } from "./exam-flake";
import { flakeVerdict } from "./exam-flake";

// ─── 関所の時間 ───────────────────────────────────────────────────────────
const jstHM = (d: Date) => { const j = new Date(d.getTime() + 9 * 3600_000); return { h: j.getUTCHours(), dow: j.getUTCDay() }; };
/** DeepSeek の安い時間（平日 JST 10〜13・15〜19 は2倍＝流さない） */
export function cheapNow(d = new Date()): boolean { const { h, dow } = jstHM(d); if (dow === 0 || dow === 6) return true; return !((h >= 10 && h < 13) || (h >= 15 && h < 19)); }
/** 本数の上限（JST 9〜22 は1本・それ以外は2本） */
export function maxExamsNow(d = new Date()): number { const { h } = jstHM(d); return h >= 9 && h < 22 ? 1 : 2; }

// ─── ① 早めの打ち切り ─────────────────────────────────────────────────────
//   brain-exam の合格は「その問題の回の過半数が合格」（passN*2 > n）。予定の回数 n のうち落ちた回 f が f*2 >= n になった時点で、その問題はもう合格できない。
//   前（main）で合格していた問題がそうなったら「悪化が確定」＝残りを回しても判断（悪化0か）は変わらない → 止める。
//   どの問題も合否が決まった（残りの回で変わらない）時も止める（残りは答えを変えない回＝無駄）。
//   ※ 行の score.pass は試験の中の採点。最後の集計（rescore）で変わる事がまれにある＝打ち切った後に --report で集計し直した数を正とする
export type RowLite = { id: string; rep: number; error?: string; score?: { pass?: boolean } };
export type EarlyVerdict = { stop: "worse" | "settled" | null; why: string; worse: string[] };
export function earlyVerdict(cur: RowLite[], base: RowLite[], planned: Record<string, number>): EarlyVerdict {
  const tally = (rows: RowLite[]) => { const m = new Map<string, { p: number; f: number }>(); for (const r of rows) { if (r.error) continue; const x = m.get(r.id) ?? { p: 0, f: 0 }; if (r.score?.pass) x.p++; else x.f++; m.set(r.id, x); } return m; };
  const c = tally(cur), b = tally(base);
  const basePass = (id: string) => { const x = b.get(id); return !!x && x.p * 2 > x.p + x.f; };
  const worse: string[] = [];
  let unsettled = 0;
  for (const [id, n] of Object.entries(planned)) {
    const x = c.get(id) ?? { p: 0, f: 0 };
    const failLocked = x.f * 2 >= n, passLocked = x.p * 2 > n;
    if (failLocked && basePass(id)) worse.push(id);
    if (!failLocked && !passLocked) unsettled++;
  }
  if (worse.length) return { stop: "worse", why: `前に合格していた ${worse.join(",")} が残りの回でも合格に届かない（悪化の確定）`, worse };
  if (Object.keys(planned).length && unsettled === 0) return { stop: "settled", why: "全部の問題の合否が決まった（残りの回は答えを変えない）", worse };
  return { stop: null, why: `決まっていない問題 ${unsettled}`, worse };
}

// ─── ③ 問題ごとの揺れで回数を決める ─────────────────────────────────────────
//   試験の揺れの記録（scripts/lib/exam-flake の観測・30日）から、同じ問題・同じモデルで答えが割れた問題を「揺れる」とみて回数を増やす。
//   揺れる問題は flakyReps（3〜6・既定 4）、それ以外は normal（既定 2）。依頼で名指しした揺れる問題（--flaky）も揺れる扱い。
export function repsPlan(ids: string[], obsOf: (id: string) => FlakeObs[], o: { normal: number; flakyReps: number; forced?: string[]; model?: string }): { reps: Record<string, number>; flaky: Array<{ id: string; why: string }> } {
  const fr = Math.min(6, Math.max(3, o.flakyReps));
  const reps: Record<string, number> = {}, flaky: Array<{ id: string; why: string }> = [];
  for (const id of ids) {
    if (o.forced?.includes(id)) { reps[id] = fr; flaky.push({ id, why: "依頼で名指し" }); continue; }
    const obs = obsOf(id);
    // 一番新しい観測の問題の版・モデルで見る（問題を直した前の観測は数えない）
    const last = [...obs].filter((x) => !x.legacy && (!o.model || x.model.includes(o.model))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const v = last ? flakeVerdict(obs, { problemHash: last.problemHash, model: last.model }) : null;
    if (v?.verdict === "flaky") { reps[id] = fr; flaky.push({ id, why: v.why }); } else reps[id] = o.normal;
  }
  return { reps, flaky };
}

// ─── ④ 問題の選び（正解の組・場面の地図） ─────────────────────────────────────
//   --pick=types:型A,型B[@N] … spec の型（場面）ごとに N 問（既定 3・問題の番号の幅に散らして選ぶ）
//   --pick=gold           … 正解の組（scripts/parts-eval/gold-20.json の問題）
//   --pick=map            … 場面の地図（exam-queue/scene-map.json の {スイッチ: {types?, only?, perType?, repeat?}}）から
//   --pick=rag            … brain-exam の --select=rag に任せる（直した差分から関係する問題）
//   どれも --only と足し合わせる（重なりは1つ）
export type SpecLite = { id: string; type: string };
export type SceneMap = Record<string, { types?: string[]; only?: string[]; perType?: number; repeat?: number }>;
export function spreadPick<T>(xs: T[], n: number): T[] { if (xs.length <= n) return xs; const out: T[] = []; for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]); return out; }
export function pickProblems(pick: string, spec: SpecLite[], o: { golds?: string[]; map?: SceneMap; switchName?: string; only?: string[] }): { ids: string[]; selectRag: boolean; repeat?: number; why: string } {
  const only = o.only ?? [];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const byTypes = (types: string[], per: number) => types.flatMap((t) => spreadPick(spec.filter((p) => p.type === t).map((p) => p.id), per));
  if (!pick) return { ids: only, selectRag: false, why: "--only のまま" };
  if (pick === "rag") return { ids: only, selectRag: true, why: "brain-exam --select=rag" };
  if (pick === "gold") return { ids: uniq([...only, ...(o.golds ?? [])]), selectRag: false, why: `正解の組 ${o.golds?.length ?? 0}問` };
  if (pick.startsWith("types:")) {
    const [ts, per] = pick.slice(6).split("@");
    const types = ts.split(",").filter(Boolean);
    const unknown = types.filter((t) => !spec.some((p) => p.type === t));
    if (unknown.length) throw new Error(`spec に無い型: ${unknown.join(",")}（有る型: ${uniq(spec.map((p) => p.type)).join(",")}）`);
    return { ids: uniq([...only, ...byTypes(types, Number(per || 3))]), selectRag: false, why: `型 ${types.join(",")} を ${Number(per || 3)}問ずつ` };
  }
  if (pick === "map") {
    const e = o.switchName ? o.map?.[o.switchName] : undefined;
    if (!e) throw new Error(`場面の地図にスイッチ ${o.switchName} が無い（exam-queue/scene-map.json に {"${o.switchName}": {"types": [...], "only": [...]}} を足す）`);
    return { ids: uniq([...only, ...(e.only ?? []), ...byTypes(e.types ?? [], e.perType ?? 3)]), selectRag: false, repeat: e.repeat, why: `場面の地図（${(e.types ?? []).join(",") || "-"}・${(e.only ?? []).length}問）` };
  }
  throw new Error(`--pick=${pick} は無い（types:型@N ／ gold ／ map ／ rag）`);
}

// ─── ② 入れる順番の表（release-order.md）への書き戻し ───────────────────────────
//   スイッチの列にそのスイッチ名がある行の「状態」（最後の列）を結果に置き換える。行が無ければ表はそのまま（changed=false）
export function updateReleaseOrder(md: string, switchName: string, status: string): { md: string; changed: boolean } {
  if (!switchName) return { md, changed: false };
  const lines = md.split(/\r?\n/);
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  let changed = false;
  const hdr = lines.findIndex((l) => /^\|.*スイッチ.*\|.*状態.*\|\s*$/.test(l));
  if (hdr < 0) return { md, changed: false };
  const cols = lines[hdr].split("|").map((s) => s.trim());
  const swCol = cols.indexOf("スイッチ"), stCol = cols.indexOf("状態");
  const safe = status.replace(/\|/g, "／").replace(/\r?\n/g, " ");
  for (let i = hdr + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const cells = lines[i].split("|");
    if (cells.length <= Math.max(swCol, stCol)) continue;
    if (!cells[swCol].includes(switchName)) continue;
    cells[stCol] = ` ${safe} `;
    lines[i] = cells.join("|");
    changed = true;
  }
  return { md: lines.join(eol), changed };
}
