// scripts/lib/hazard-audit-core.ts — 危ない所の見張り（scripts/hazard-audit.ts）の見つけ方の純関数（ファイル・DB・網を触らない）
// テスト: scripts/lib/__tests__/hazard-audit-core.test.ts
export type SrcFile = { file: string; text: string };
export type OffSwitch = { name: string; where: string; decided: boolean; why: string };
export type UnpagedRead = { file: string; line: number; table: string; why: string; snippet: string };

const DECISION_RE = /KB\s*[0-9a-f]{8}|竹内さんの決定|竹内さん[^\n]{0,20}(?:承認|指示|了承)|竹内（[^）]{0,20}）/;
const ON_COMPARE_RE = /===\s*["'](?:on|1|true)["']/;

/** (a) env を読み、読めない時に off になる比べ（=== "on" 等）のスイッチ。前6行と同じ行に竹内さんの決定（KB id・決定の言葉）があれば decided */
export function findOffSwitches(files: ReadonlyArray<SrcFile>): OffSwitch[] {
  const by = new Map<string, OffSwitch>();
  for (const f of files) {
    if (/__tests__/.test(f.file)) continue;
    const lines = f.text.split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!ON_COMPARE_RE.test(l) || /!==\s*["']off["']/.test(l)) return;
      const names = [...l.matchAll(/env\??\.([A-Z][A-Z0-9_]{3,})/g)].map((m) => m[1]);
      if (!names.length) return;
      const ctx = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      const dm = ctx.match(DECISION_RE);
      for (const name of names) {
        const cur = by.get(name);
        const decided = !!dm || !!cur?.decided;
        by.set(name, { name, where: cur?.where ?? `${f.file}:${i + 1}`, decided, why: cur?.decided ? cur.why : dm ? dm[0].slice(0, 30) : "" });
      }
    });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** (b) 大きな表を頁なし・1000行を超える limit で読む所（PostgREST は1回 1000行で黙って切る） */
export const BIG_TABLES = ["messages", "ai_reply_examples", "aix_usage_logs", "llm_usage_logs", "conversations", "deal_outcomes", "property_customers", "system_design_thinking", "line_watch_turns", "brain_judgments"];
export function findUnpagedReads(files: ReadonlyArray<SrcFile>, tables: ReadonlyArray<string> = BIG_TABLES): UnpagedRead[] {
  const out: UnpagedRead[] = [];
  const re = new RegExp(`\\.from\\(\\s*["'\`](${tables.join("|")})["'\`]\\s*\\)`, "g");
  for (const f of files) {
    if (/__tests__/.test(f.file)) continue;
    for (const m of f.text.matchAll(re)) {
      const at = m.index ?? 0;
      const rest = f.text.slice(at, at + 700);
      const end = rest.search(/;\s*\n|\)\s*;\s*$/m);
      const chunk = end > 0 ? rest.slice(0, end + 1) : rest;
      if (!/\.select\(/.test(chunk) || /\.(?:insert|update|upsert|delete)\(/.test(chunk)) continue;
      const line = f.text.slice(0, at).split("\n").length;
      const snippet = chunk.replace(/\s+/g, " ").slice(0, 90);
      const lim = [...chunk.matchAll(/\.limit\(\s*([0-9_]+)\s*\)/g)].map((x) => Number(x[1].replace(/_/g, "")));
      if (lim.some((n) => n > 1000)) { out.push({ file: f.file, line, table: m[1], why: `limit ${Math.max(...lim)}（1回 1000行で切れる）`, snippet }); continue; }
      const bounded = /\.range\(|\.limit\(|\.single\(|\.maybeSingle\(|head:\s*true|\.eq\(\s*["'](?:id|message_id|conversation_id|src)["']|\.in\(\s*["'](?:id|message_id|conversation_id)["']/.test(chunk);
      if (!bounded) out.push({ file: f.file, line, table: m[1], why: "頁なし（range・limit 無し）", snippet });
    }
  }
  return out;
}

/** (e) LP の「◯月実績」: HTML の控えの月と、配っている lp-evidence.js が今描く月が今月か（日本時間） */
export function lpMonthOk(html: string, js: string, now: Date): { ok: boolean; why: string } {
  const month = new Date(now.getTime() + 9 * 3600_000).getUTCMonth() + 1;
  const stat = Number((html.match(/data-lp="month"[^>]*>\s*([0-9]{1,2})月実績/) ?? [])[1] ?? NaN);
  let drawn = NaN;
  try {
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function("module", "self", "document", js)(mod, undefined, undefined);
    const ev = (mod.exports as { evidenceFor?: (d: Date) => { month: number } }).evidenceFor;
    drawn = ev ? ev(now).month : NaN;
  } catch { drawn = NaN; }
  const callsRenderBare = /addEventListener\(\s*["']DOMContentLoaded["']\s*,\s*function\s*\(\)\s*\{\s*api\.render\(\)/.test(js) || !/addEventListener\(\s*["']DOMContentLoaded["']\s*,\s*api\.render\s*\)/.test(js);
  const ok = drawn === month && callsRenderBare;
  return { ok, why: `今月 ${month}・JS が描く ${Number.isNaN(drawn) ? "?" : drawn}・HTML の控え ${Number.isNaN(stat) ? "?" : stat}${callsRenderBare ? "" : "・render を Event で呼ぶ形（落ちる）"}${stat !== month ? "（控えは JS が落ちた時に出る）" : ""}` };
}

/** (f) .ts を変えたコミットの前6時間に tsc-remote 0 が無い物（tscAt は results.md の UTC "YYYY-MM-DDTHH:MM"） */
export function commitsWithoutTsc<T extends { at: string; subject: string }>(commits: ReadonlyArray<T>, tscAt: ReadonlyArray<string>): T[] {
  const ts = tscAt.map((s) => Date.parse(`${s.trim()}:00Z`)).filter(Number.isFinite);
  return commits.filter((c) => {
    if (/^Merge /.test(c.subject)) return false;
    const t = Date.parse(c.at);
    return !ts.some((x) => x <= t + 60_000 && x >= t - 6 * 3600_000);
  });
}

/** (d) publication の行の条件（rowfilter）の列のうち、replica identity に無い列（f＝全部の列なら無し）。UPDATE・DELETE で条件の列が identity に無いと本番が断る */
export function rowFilterMissingCols(rowfilter: string, replident: string, idcols: ReadonlyArray<string>): string[] {
  if (replident === "f") return [];
  const kw = new Set(["and", "or", "not", "all", "any", "array", "in", "is", "null", "true", "false", "text", "uuid", "integer", "bigint", "boolean", "timestamptz", "like", "ilike", "between"]);
  const cols = new Set<string>();
  const s = String(rowfilter ?? "").replace(/'(?:[^']|'')*'/g, "''");   // 文字の値は外す
  for (const m of s.matchAll(/(?<![:.\w])([a-z_][a-z0-9_]*)(?=\s*(?:<>|!=|=|<|>|\s+(?:IN|NOT|IS|LIKE|ILIKE|BETWEEN)\b))/gi)) {
    const c = m[1].toLowerCase();
    if (!kw.has(c)) cols.add(c);
  }
  const have = new Set(idcols.map((c) => c.toLowerCase()));
  return [...cols].filter((c) => !have.has(c));
}

/** (g) 2026-11-04 作業員1（つなぎの芯・統括役の頼み）: 試験の結果が「悪化0」なのに、前（main）と両方で解いた問題が予定より少ない（0 を含む）物。
 *  時間の上限で止まり基準の回が書かれない・node_modules が空で落ちた等で、比べていないのに悪化0と出ていた（cbp1・grp-reply-tag）。
 *  both は brain-exam の集計の「両方で解いた N 問」（読めなければ null＝比べた証拠が無いので拾う） */
export function hollowNoWorse<T extends { verdict: string; planned: number; both: number | null }>(rows: ReadonlyArray<T>): T[] {
  return rows.filter((r) => /悪化0/.test(r.verdict) && r.planned > 0 && (r.both == null || r.both < r.planned));
}

/** (h) 2026-11-05 作業員1（KB 3892c30c・統括役）: 分からない事の3つの表の開いている数と24時間で新しく増えた数（夜の cron link-brain-watch の結果から）。
 *  表は RLS で手元の公開キーでは読めない＝cron がサーバーの鍵で数えて cron_run_logs に残した物を読む。古い（36時間超）・無い時は null */
export type UnknownsOpen = { weak_open: number; weak_new24h: number; unknown_rows: number; unknown_new24h: number; owner_open: number };
export function unknownsOpenLine(o: UnknownsOpen | null | undefined, at: string | null, nowMs: number): { ok: boolean | null; line: string } {
  if (!o || !at) return { ok: null, line: "分からない事の3つの表: 不明（夜の link-brain-watch の数が無い）" };
  const ageH = (nowMs - Date.parse(at)) / 3_600_000;
  if (!(ageH <= 36)) return { ok: null, line: `分からない事の3つの表: 不明（数が ${Math.round(ageH)}時間前で古い）` };
  return { ok: true, line: `分からない事の3つの表: 弱い所 開いている ${o.weak_open}（新+${o.weak_new24h}）・分からない事 ${o.unknown_rows}行（新+${o.unknown_new24h}）・竹内さんへの確認 開いている ${o.owner_open}` };
}

/** (i) 2026-11-05 作業員1（点検表 10〜12）: 試験の係の記録（conductor.log）から、24時間の
 *   ①止める印から猶予の内に止まらず殺した回（前を取り置けない）②古い作業ツリーの印（止める印・レーンの直しが無い）を数える */
export function conductorLogHazards(logText: string, sinceIso: string): { stopKilled: string[]; oldWorktree: string[] } {
  const stopKilled: string[] = [], oldWorktree: string[] = [];
  for (const l of logText.split(/\r?\n/)) {
    const at = l.slice(0, 24);
    if (!/^\d{4}-\d\d-\d\dT/.test(at) || at < sinceIso) continue;
    const m1 = l.match(/止める印から \d+分で止まらない → 止める（([^）]+)）/); if (m1) stopKilled.push(m1[1]);
    const m2 = /⚠ 古い brain-exam/.test(l) ? l.match(/（([^（・）]+)・[^（）]*）s*$/) : null; if (m2) oldWorktree.push(m2[1]);
  }
  return { stopKilled: [...new Set(stopKilled)], oldWorktree: [...new Set(oldWorktree)] };
}
/** (j) 試験の出力の「レーン（EXAM_CONCURRENCY=N）: N本 YUMA2（…）・YUMA2（…）」で同じ会話を2本以上が取った行 */
export function laneDupConvs(line: string): string[] {
  if (!/レーン（EXAM_CONCURRENCY=/.test(line)) return [];
  const names = [...line.matchAll(/(YUMA\d+)（/g)].map((m) => m[1]);
  return [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
}

/** (k) 2026-11-05 作業員1（点検表 13）: 作業ツリーの手元の problems.json に同じ id が2つ以上ある（同じ問題を2回ずつ回し費用が倍になる） */
export function dupProblemIds(problems: ReadonlyArray<{ id?: unknown }>): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const p of problems) { const id = String(p.id ?? ""); if (!id) continue; if (seen.has(id)) dup.add(id); seen.add(id); }
  return [...dup];
}

/** (l) 2026-11-05 作業員1（作業員4の気付き）: 手元の problems.json の問題と、main の spec の同じ id の正解の中身（specHash）が違う物（id のぶつかり＝取り置き・揺れの記録の取り違えのおそれ） */
export function idContentClashes(local: ReadonlyArray<Record<string, unknown>>, mainSpec: ReadonlyArray<Record<string, unknown>>, hashOf: (o: Record<string, unknown>) => string): string[] {
  const main = new Map(mainSpec.map((s) => [String(s.id), hashOf(s)]));
  return local.filter((p) => main.has(String(p.id)) && main.get(String(p.id)) !== hashOf(p)).map((p) => String(p.id));
}

/**
 * (n) 2026-11-05 作業員1（DeepSeek の残高切れ・11/05 11:40〜 JST に 402 が105回・本番の資料の読み取りが失敗して送った物件の記録が抜けた）:
 *   24時間の llm_usage_logs の DeepSeek の失敗（402＝残高切れ／alt_failed＝別クラウドに回して失敗）を、本番と試験に分けて1行に。
 *   402 が1回でもあれば印（ok=false）。alt_failed だけは時間切れ等でも出るので、本番で10回以上の時だけ印。
 */
export type DsFailCounts = { prod402: number; prodAltFailed: number; test402: number; testAltFailed: number };
export function deepseekFailLine(c: DsFailCounts): { ok: boolean; line: string } {
  const ok = c.prod402 === 0 && c.test402 === 0 && c.prodAltFailed < 10;
  const line = `DeepSeek の失敗 24時間: 本番 402 ${c.prod402}・失敗 ${c.prodAltFailed}／試験 402 ${c.test402}・失敗 ${c.testAltFailed}${c.prod402 + c.test402 > 0 ? "（残高切れの疑い・入金と資料の読み直し待ちを確かめる）" : ""}`;
  return { ok, line };
}

/**
 * (o) 2026-11-05 作業員1（読み直しの dry-read の台本が申込の線を見ずに約50枚を DeepSeek に送った・竹内さんの決まり 9/26「申込の間の部分は DeepSeek に渡さず」）:
 *   scripts/ の台本で DeepSeek を直接呼ぶ口（画像の読み・DeepSeek の endpoint）を使うのに、申込の線（loadDeepseekCutoff・isAfterCutoff・
 *   deepseekSafeCutoff・cutBeforeApplicationMaterial・LLM_TEST の写し）を通していないファイル。注記の行は見ない。
 */
const DS_CALL_RE = /\b(?:sharedPropertyImageRead|readPropertyImage(?:Detail)?|callDeepSeekRead|readPropertyImageDetailByTranscript)\s*\(|api\.deepseek\.com/;
const DS_GUARD_RE = /\b(?:loadDeepseekCutoff|isAfterCutoff|deepseekSafeCutoff|cutBeforeApplicationMaterial|findRereadTargets|runSentImageReread|setupLlmTest)\b/;
export function deepseekWithoutCutoff(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  return DS_CALL_RE.test(code) && !DS_GUARD_RE.test(code);
}

/**
 * (p) 2026-11-05 作業員1（案A・相場の観測に試験の会話を入れない歯止め）: DB の is_exam_conversation（YUMA＋印 test_no_line／TEST-NOLINE-）が
 *   app/lib/test-conversations.ts の一覧（YUMA＋NO_LINE_TEST_CONVERSATIONS）と同じ会話を指すか。食い違えば試験の行が相場に入る・本番の行が落ちる。
 */
export function examConvMismatch(tsIds: ReadonlyArray<string>, dbIds: ReadonlyArray<string>): { missingInDb: string[]; extraInDb: string[] } {
  const t = new Set(tsIds), d = new Set(dbIds);
  return { missingInDb: [...t].filter((x) => !d.has(x)), extraInDb: [...d].filter((x) => !t.has(x)) };
}

/**
 * (q) 2026-11-05 作業員4（点検表 19）: 試験の係の cmd の依頼で、引数が空白のあるパスを割られて落ちる形（ci-v1L・ci-v3L が ENOENT・LLM 0回で「失敗あり」）。
 *   係は cmd を /"[^"]*"|\S+/g で割る＝ `--qfile="C:/Users/竹内 悠馬/…"` のように = の後ろの引用符は1つの引数にならない。割った後に引用符が片方だけ残る引数がある cmd を返す。
 */
export function cmdSplitHazards(cmds: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const c of cmds) {
    const parts = c.match(/"[^"]*"|\S+/g) ?? [];
    if (parts.some((p) => ((p.match(/"/g) ?? []).length % 2 === 1))) out.push(c);
  }
  return out;
}

// ─── (r) 2026-11-10 作業員8（強化の一覧 D4）: 弱い所の表の「回数×新しさ」の上位で、持ち主の無い行を毎朝知らせる ─────────────
//   表に持ち主の列は無い。持ち主あり＝in_progress で直近 OWNED_FRESH_DAYS 日に更新がある行（11/04 から in_progress のまま動かない行は持ち主なしに数える）。
//   点＝回数 ×（最後に見た日からの日数で半分になる重み・半減 7日）。上位 TOP_N のうち持ち主なしを並べる
export type WeaknessLite = { key: string; title?: string | null; area?: string | null; status: string; occurrences?: number | null; last_seen?: string | null; updated_at?: string | null };
export const WEAK_TOP_N = 5, OWNED_FRESH_DAYS = 3, WEAK_HALF_LIFE_DAYS = 7;
export function weaknessScore(w: WeaknessLite, nowMs: number): number {
  const last = Date.parse(String(w.last_seen ?? w.updated_at ?? ""));
  const days = Number.isFinite(last) ? Math.max(0, (nowMs - last) / 86_400_000) : 60;
  return Math.max(1, Number(w.occurrences ?? 1) || 1) * Math.pow(0.5, days / WEAK_HALF_LIFE_DAYS);
}
export function weaknessOwned(w: WeaknessLite, nowMs: number): boolean {
  const u = Date.parse(String(w.updated_at ?? ""));
  return w.status === "in_progress" && Number.isFinite(u) && nowMs - u <= OWNED_FRESH_DAYS * 86_400_000;
}
export function unownedTopWeaknesses(rows: readonly WeaknessLite[], nowMs: number, n = WEAK_TOP_N): { top: Array<WeaknessLite & { score: number; owned: boolean }>; unowned: Array<WeaknessLite & { score: number }> } {
  const top = rows.filter((w) => w.status === "open" || w.status === "in_progress")
    .map((w) => ({ ...w, score: weaknessScore(w, nowMs), owned: weaknessOwned(w, nowMs) }))
    .sort((a, b) => b.score - a.score).slice(0, n);
  return { top, unowned: top.filter((w) => !w.owned) };
}
