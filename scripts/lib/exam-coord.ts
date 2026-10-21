// scripts/lib/exam-coord.ts — 試験を回す担当どうしの連携（同じ main の版を2人で作り直さない・前の main の答えを入力が同じなら使う・同じ比べを1日に2回流さない）
//
// 2026-10-21 竹内さん「ここちゃんと連携がされていたらもっと費用抑えられるのでは」:
//   今日の試験の費用 $10.6 のうち約 55% が main の答えの作り直し。main が1日に約15回進み、同じ版（例 4f2cd4d）を別々の担当が同時に4回作り直していた
//   （route main-4f2cd4d-…-rmvhcokim / rmvhcjpkc / rmvhdnhst / rmvhe2gkc）。残り約 45% が担当自身の回し直し。
//   ① 版ごとに1回: 共有の置き場（exam-cache/brain-exam-baseline/<版>/.claims/<問題>.claim）に「この問題は私が作っている」を置く（ファイルの wx 作成＝1人しか成功しない）。
//      他の担当は待って、出来た答えを使う（作り直さない）。持ち主の pid が止まっていれば古い印として外す。
//   ② 前の main の答えの持ち越し（入力の差）: 作り直す問題でも、前の main の版の行に残った呼び出しの控え（llmCalls）を入れて回す＝要求が同じ段は前の答え（呼ばない）。
//   ③ 1回ごとの見張り: 同じ比べ（コード＋スイッチの指紋＋問題と回数）を今日もう流していれば止める（--force で流す）。担当ごとの1日の上限（EXAM_RUN_CAP_USD・既定 $5）。
//   ④ --spend-today: 今日の試験の費用を種類（main の作り直し／担当の確かめ／夜）で分け、同じ版の作り直しの重なりと、避けた分を出す。
// 決め方は純関数（単体テスト scripts/lib/__tests__/exam-coord.test.ts）。読み書きは小さく、置き場は全部の作業ツリーで共有（examCacheRoot）。
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { examCacheRoot } from "./llm-cassette";

const HOST = hostname();

// ─── ① 問題ごとの印（claim） ─────────────────────────────────────────────
export type Claim = { pid: number; host: string; label: string; at: string };
export function claimDirOf(baselineDir: string): string { return join(baselineDir, ".claims"); }
export function claimFileOf(baselineDir: string, id: string): string { return join(claimDirOf(baselineDir), `${id.replace(/[^\w.-]/g, "_")}.claim`); }
/** pid が生きているか（同じ機械の時だけ分かる・他の機械の印は時間だけで見る） */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** 既定の古い印の時間（同じ機械では pid が止まった時点で古い。他の機械・pid が読めない時はこの時間） */
export const CLAIM_TTL_MS = 6 * 3600_000;
/** 印が古いか（持ち主が止まった・時間切れ） */
export function claimStale(c: Claim | null, o: { now?: number; ttlMs?: number; alive?: (pid: number) => boolean; host?: string } = {}): boolean {
  if (!c) return true;
  const now = o.now ?? Date.now(), ttl = o.ttlMs ?? CLAIM_TTL_MS;
  const t = Date.parse(c.at);
  if (!Number.isFinite(t) || now - t > ttl) return true;
  if ((c.host ?? "") === (o.host ?? HOST)) return !(o.alive ?? pidAlive)(c.pid);
  return false;
}
export function readClaim(f: string): Claim | null { try { return JSON.parse(readFileSync(f, "utf8")) as Claim; } catch { return null; } }
/**
 * 問題の印を取る。取れた＝私が作る。取れない＝他の担当が作っている（holder）。古い印は外して取り直す。
 *   force＝待ちきれない時に上書き（持ち主は自分の印でなくなったことを release で知る＝消さない）
 */
export function tryClaim(baselineDir: string, id: string, label: string, o: { force?: boolean; now?: number; ttlMs?: number; alive?: (pid: number) => boolean; pid?: number } = {}): { ok: true } | { ok: false; holder: Claim } {
  const f = claimFileOf(baselineDir, id);
  mkdirSync(claimDirOf(baselineDir), { recursive: true });
  const me: Claim = { pid: o.pid ?? process.pid, host: HOST, label, at: new Date(o.now ?? Date.now()).toISOString() };
  for (let k = 0; k < 3; k++) {
    try {
      const fd = openSync(f, o.force ? "w" : "wx");
      try { writeSync(fd, JSON.stringify(me)); } finally { closeSync(fd); }
      return { ok: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const busy: Claim = { pid: 0, host: "?", label: "(書きかけ)", at: me.at };
      // 2026-10-21 確かめる人: Windows は消している最中のファイルを開くと EPERM/EACCES/EBUSY＝他の担当が今触っている → 今回は取れない（落とさない）
      if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return { ok: false, holder: readClaim(f) ?? busy };
      if (code !== "EEXIST") throw e;
      const cur = readClaim(f);
      if (cur && cur.pid === me.pid && cur.host === me.host) return { ok: true }; // 自分の印
      // 2026-10-21 確かめる人: 読めない印は、作った人が wx の直後でまだ書いていない途中かもしれない → 30秒以内は古いとみない（外すと2人が作る）
      if (!cur) { let young = false; try { young = (o.now ?? Date.now()) - statSync(f).mtimeMs < 30_000; } catch { /* 消えた＝取り直す */ } if (young) return { ok: false, holder: busy }; }
      if (!claimStale(cur, o)) return { ok: false, holder: cur! };
      try { unlinkSync(f); } catch { /* 他の担当が先に外した */ }
    }
  }
  const cur = readClaim(f);
  return cur && cur.pid === me.pid ? { ok: true } : { ok: false, holder: cur ?? me };
}
/** 自分の印だけ外す（他の担当に上書きされた印は触らない） */
export function releaseClaims(baselineDir: string, ids: string[], pid = process.pid): void {
  for (const id of ids) {
    const f = claimFileOf(baselineDir, id);
    const c = readClaim(f);
    if (c && c.pid === pid && c.host === HOST) { try { unlinkSync(f); } catch { /* */ } }
  }
}
/**
 * 待っている問題の次の手（純関数）: 出来た（done）＝使う／印が取れた＝私が作る／他の担当が作っている＝待つ。待ちすぎ（waitedMs > maxWaitMs）は自分で作る
 */
export function coordStep(pending: string[], o: { done: (id: string) => boolean; claim: (id: string) => boolean; waitedMs: number; maxWaitMs: number }): { reuse: string[]; mine: string[]; wait: string[]; steal: string[] } {
  const reuse: string[] = [], mine: string[] = [], wait: string[] = [], steal: string[] = [];
  for (const id of pending) {
    if (o.done(id)) { reuse.push(id); continue; }
    if (o.claim(id)) { mine.push(id); continue; }
    if (o.waitedMs > o.maxWaitMs) steal.push(id); else wait.push(id);
  }
  return { reuse, mine, wait, steal };
}
/** 他の担当の main の答えを待つ時間の上限（分）。EXAM_BASELINE_WAIT_MIN（既定 90 分・0 で待たない＝旧） */
export function baselineWaitMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(String(env.EXAM_BASELINE_WAIT_MIN ?? "").trim() || "90");
  return (Number.isFinite(v) && v >= 0 ? v : 90) * 60_000;
}

// ─── ② 前の main の答え（入力の差の控え） ────────────────────────────────────
type RowLike = { id: string; rep: number; error?: string; llmCalls?: Array<{ src: string; sha?: string; key?: string }>; inputSame?: boolean };
type FileLike<R> = { problemHash: string; savedAt: string; answeredAt?: string; envFp?: string; rows: R[]; dir?: string };
/** 答えた時刻（入力が前と同じで持ち越した物は元の答えの時刻＝期限が延び続けない） */
export function answeredAtOf(b: { savedAt: string; answeredAt?: string }): string { return b.answeredAt ?? b.savedAt; }
/**
 * 前の main の版の行（呼び出しの控え付き）を探す: 同じ問題（hash）・既定のスイッチ・失敗の行が無い・控えのある行がある・期限の内。一番新しい物
 */
export function pickPrevMainRows<R extends RowLike>(cands: Array<FileLike<R>>, p: { hash: string; alt?: string[] }, o: { maxAgeMs?: number | null; now?: number } = {}): (FileLike<R> & { dir?: string }) | null {
  const now = o.now ?? Date.now();
  const ok = cands.filter((b) => {
    if (b.problemHash !== p.hash && !p.alt?.includes(b.problemHash)) return false;
    if ((b.envFp ?? "") !== "") return false;
    if (b.rows.some((r) => r.error)) return false;
    if (!b.rows.some((r) => r.llmCalls?.some((c) => c.sha && c.key))) return false;
    const t = Date.parse(answeredAtOf(b));
    if (o.maxAgeMs && o.maxAgeMs > 0 && (!Number.isFinite(t) || now - t > o.maxAgeMs)) return false;
    return true;
  });
  return ok.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0] ?? null;
}
/** 作り直した問題の答えた時刻: 全部の回が前の答えで済んだ（inputSame）なら前の答えた時刻・それ以外は今 */
export function carriedAnsweredAt(rows: RowLike[], src: { savedAt: string; answeredAt?: string } | null, nowIso: string): string {
  // 2026-10-21 確かめる人: 一部の段だけ前の答え（pin）を使った回も、その段の答えは前の時刻のまま。今の時刻にすると次の main がまた持ち越し
  //   期限が延び続ける → 前の答えを1つでも使ったら前の答えた時刻（古い方）にする（期限が来たら全部解き直す）
  return src && rows.length && (rows.every((r) => r.inputSame) || rows.some((r) => r.llmCalls?.some((c) => c.src === "pin"))) ? answeredAtOf(src) : nowIso;
}

// ─── ③ 1回ごとの見張り（同じ比べ・担当ごとの上限） ───────────────────────────────
export const RUNS_DIR = join(examCacheRoot(), "exam-runs");
export const COORD_LOG = join(examCacheRoot(), "exam-coord-log.jsonl");
export type RunRecord = { fp: string; label: string; ident: string; at: string; cwd: string; estUsd: number; ids: string[] };
export function jstDate(d: Date): string { return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10); }
/** 比べの指紋: コード（試験に効く所の鍵）＋スイッチの指紋＋比べる main の版＋問題と回数・モデル・段＋子に渡す引数 */
export function runFingerprint(o: { codeKey: string; envFp: string; mainKey: string | null; items: Array<{ id: string; reps: number; model: string; draft: boolean }>; extra?: string[] }): string {
  const items = [...o.items].sort((a, b) => a.id.localeCompare(b.id)).map((x) => `${x.id}:${x.reps}:${x.model}:${x.draft ? "d" : "b"}`);
  return createHash("sha256").update(JSON.stringify({ c: o.codeKey, e: o.envFp, m: o.mainKey ?? "", i: items, x: [...(o.extra ?? [])].sort() })).digest("hex").slice(0, 16);
}
/** 担当の名前（上限を数える単位）: --label の元（-n・-fl・-d・-fl-d を外す）。自動の label（eb-MMDD-xxxx）は作業ツリーの名前 */
export function labelIdentity(label: string, cwd: string): string {
  if (!label || /^eb-\d{4}-[a-z0-9]{4}(?:-|$)/.test(label)) { const b = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "?"; return `wt:${b}`; }
  return label.replace(/(?:-n)?(?:-fl)?(?:-d)?$/, "") || label;
}
export function readRunsToday(now = new Date(), dir = RUNS_DIR): RunRecord[] {
  const f = join(dir, `runs-${jstDate(now)}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as RunRecord]; } catch { return []; } });
}
export function appendRun(r: RunRecord, now = new Date(), dir = RUNS_DIR): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `runs-${jstDate(now)}.jsonl`), JSON.stringify(r) + "\n");
}
/** 同じ比べを今日もう流したか */
export function findDuplicateRun(today: RunRecord[], fp: string): RunRecord | null { return today.find((r) => r.fp === fp) ?? null; }
export const RUN_CAP_DEFAULT_USD = 5;
/** 担当ごとの1日の上限（EXAM_RUN_CAP_USD・既定 $5・off で無し）。10/21 竹内さん「5ドルに上げてよい」。2026-10-21 確かめる人: $1 だと担当の確かめ（1回 $0.2〜2）の2回目でほぼ夜に回る＝昼に直して確かめる流れが止まる → $2 */
export function runCapUsd(env: Record<string, string | undefined> = process.env): number | null {
  const raw = String(env.EXAM_RUN_CAP_USD ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "none") return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : RUN_CAP_DEFAULT_USD;
}
/** 上限の判定: 使った分＋見込みが上限を超えたら夜中に回す（force で今） */
export function runCapDecision(o: { spentUsd: number; estUsd: number; cap: number | null; force?: boolean; fromQueue?: boolean }): { ok: boolean; why: string } {
  if (o.cap === null) return { ok: true, why: "担当の上限なし（EXAM_RUN_CAP_USD=off）" };
  if (o.fromQueue) return { ok: true, why: "夜中の予約の実行＝担当の上限は数えない" };
  const tot = o.spentUsd + o.estUsd;
  if (tot <= o.cap) return { ok: true, why: `担当の今日 $${o.spentUsd.toFixed(2)}＋見込み $${o.estUsd.toFixed(2)} ≦ 上限 $${o.cap.toFixed(2)}` };
  if (o.force) return { ok: true, why: `担当の上限 $${o.cap.toFixed(2)} を超える（$${tot.toFixed(2)}）が --force／--over-cap で今流す` };
  return { ok: false, why: `担当の今日 $${o.spentUsd.toFixed(2)}＋見込み $${o.estUsd.toFixed(2)} ＞ 上限 $${o.cap.toFixed(2)}（EXAM_RUN_CAP_USD）→ 夜中に回す（今なら --over-cap）` };
}
/** route（script:brain-exam-<label>）の label が担当のものか: 記録の label と同じ／担当の名前で始まる（route は 60 字で切れる） */
export function routeBelongs(route: string, ident: string, labels: string[]): boolean {
  const l = route.replace(/^script:brain-exam-/, "");
  if (labels.some((x) => { const t = `brain-exam-${x}`.slice(0, 60).replace(/^brain-exam-/, ""); return l === t || l.startsWith(`${t}-`) || l === x; })) return true;
  return !ident.startsWith("wt:") && (l === ident || l.startsWith(`${ident}-`));
}

// ─── ④ 今日の費用の帳簿 ───────────────────────────────────────────────
export type CoordEvent = { at: string; kind: "wait-reuse" | "pin" | "dup-refused" | "cap-deferred"; label: string; ids: string[]; usd: number; note?: string };
export function appendCoordEvent(e: CoordEvent, file = COORD_LOG): void { try { mkdirSync(join(file, ".."), { recursive: true }); appendFileSync(file, JSON.stringify(e) + "\n"); } catch { /* 帳簿が書けなくても試験は止めない */ } }
export function readCoordEvents(since: Date, file = COORD_LOG): CoordEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { const e = JSON.parse(l) as CoordEvent; return Date.parse(e.at) >= since.getTime() ? [e] : []; } catch { return []; } });
}
export type RunKind = "main" | "worker" | "night";
const jstMinOf = (d: Date) => { const j = new Date(d.getTime() + 9 * 3600_000); return j.getUTCHours() * 60 + j.getUTCMinutes(); };
/** route の種類: main の作り直し（brain-exam-main-）／夜（warm・夜中の安い時間 JST 1:30〜9:30 の実行）／担当の確かめ */
export function classifyRoute(route: string, createdAt: string, cheap = { startMin: 90, endMin: 570 }): RunKind {
  const l = route.replace(/^script:brain-exam-/, "");
  if (/^main-/.test(l)) return "main";
  if (/^warm/.test(l)) return "night";
  const m = jstMinOf(new Date(createdAt));
  return m >= cheap.startMin && m < cheap.endMin ? "night" : "worker";
}
/** main の作り直しの route → 版（main-<commit7>-<構成>）。読めなければ null */
export function mainVersionOfRoute(route: string): string | null { const m = /^script:brain-exam-(main-[0-9a-f]{7}-[0-9a-f]{6,10})(?:-r[0-9a-z]+)?/.exec(route); return m ? m[1] : null; }
export type SpendRow = { route: string; created_at: string; usd: number };
export type SpendSummary = {
  total: number; byKind: Record<RunKind, { usd: number; routes: number }>;
  mainDup: Array<{ version: string; routes: number; usd: number; extraUsd: number }>;
  dupExtraUsd: number; byRoute: Array<{ route: string; kind: RunKind; usd: number }>;
};
/**
 * 今日の費用のまとめ（純関数）。同じ版の main の作り直しが2つ以上の route に分かれていたら「重なり」＝一番高い1本以外は無駄だった分（extraUsd）
 */
export function summarizeSpend(rows: SpendRow[], cheap?: { startMin: number; endMin: number }): SpendSummary {
  const byRouteM = new Map<string, { usd: number; first: string }>();
  for (const r of rows) { const e = byRouteM.get(r.route) ?? { usd: 0, first: r.created_at }; e.usd += r.usd; if (r.created_at < e.first) e.first = r.created_at; byRouteM.set(r.route, e); }
  const byKind: SpendSummary["byKind"] = { main: { usd: 0, routes: 0 }, worker: { usd: 0, routes: 0 }, night: { usd: 0, routes: 0 } };
  const byRoute: SpendSummary["byRoute"] = [];
  const ver = new Map<string, number[]>();
  for (const [route, e] of byRouteM) {
    const kind = classifyRoute(route, e.first, cheap);
    byKind[kind].usd += e.usd; byKind[kind].routes++;
    byRoute.push({ route, kind, usd: e.usd });
    const v = kind === "main" ? mainVersionOfRoute(route) : null;
    if (v) ver.set(v, [...(ver.get(v) ?? []), e.usd]);
  }
  const mainDup = [...ver.entries()].filter(([, us]) => us.length > 1).map(([version, us]) => { const tot = us.reduce((s, x) => s + x, 0); return { version, routes: us.length, usd: tot, extraUsd: tot - Math.max(...us) }; }).sort((a, b) => b.extraUsd - a.extraUsd);
  return { total: [...byRouteM.values()].reduce((s, e) => s + e.usd, 0), byKind, mainDup, dupExtraUsd: mainDup.reduce((s, x) => s + x.extraUsd, 0), byRoute: byRoute.sort((a, b) => b.usd - a.usd) };
}
/** 今日の試験の費用の行を読む（llm_usage_logs・route が script:brain-exam-） */
export async function readExamSpendRows(sb: { from: (t: string) => any }, since: Date): Promise<SpendRow[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { altUsageUsd, claudeUsageUsd } = await import("../../app/lib/llm-price");
  const out: SpendRow[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("route,model,env,input_uncached,cache_read,cache_write,cache_write_5m,cache_write_1h,output_tokens,created_at").gte("created_at", since.toISOString()).like("route", "script:brain-exam-%").order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`llm_usage_logs が読めない: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const m = String(r.model ?? "");
      const usd = /claude/.test(m) ? claudeUsageUsd(r as never) : /deepseek/.test(m) ? altUsageUsd(r as never) : 0;
      out.push({ route: String(r.route ?? ""), created_at: String(r.created_at ?? ""), usd });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}
/** 置き場の中の他の版（同じ構成）の問題ファイルを読む */
export function readSiblingFiles<T>(root: string, names: string[], id: string): Array<T & { dir: string }> {
  return names.flatMap((n) => { const f = join(root, n, `${id}.json`); if (!existsSync(f)) return []; try { return [{ ...(JSON.parse(readFileSync(f, "utf8")) as T), dir: n }]; } catch { return []; } });
}
export function listDirs(root: string): string[] { try { return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return []; } }
