// scripts/lib/exam-focus.ts — 試験の依頼の「重点」（壊れうる場面と段）を差分から決める（純関数・LLM も DB も git も使わない）
//   2026-11-10 作業員8b（統括役・試験の統括ブレインの②・KB 7b5ef932 の子・親 P0 9eb6aa9c「重点を先に決める」）:
//   依頼の作業ツリーの差分（origin/main との違い）の足した行から、足したスイッチ（process.env.X・"X"）と足した・変えた関数の名を拾い、
//   場面の地図（scene-map.json: スイッチ → 回す型・名指しの問題）と spec の問題の文（why・source・tags）に当てて、壊れうる場面（spec の type）と問題を出す。
//   使い道: 守り2問を「狙いの近さ」でなく「重点の場面の中」から選ぶ／狙いの無い依頼を RAG の前に重点の場面から選ぶ。決められない時だけ DeepSeek で1回読む（係の側）

export type FocusSpec = { id: string; type: string; why?: string; source?: string; tags?: string[] };
export type FocusSceneMap = Record<string, { types?: string[]; only?: string[] } | string>;
export type Focus = { switches: string[]; funcs: string[]; types: string[]; ids: string[]; stage: "brain" | "draft" | null; why: string };

const ENV_RE = /process\.env\.([A-Z][A-Z0-9]*_[A-Z0-9_]+)|["'`]([A-Z][A-Z0-9]*_[A-Z0-9_]{3,})["'`]/g;
const FN_RE = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]{3,})|(?:export\s+)?const\s+([A-Za-z_$][\w$]{3,})\s*=\s*(?:async\s*)?\(/g;
/** よくある名（重点の手がかりにならない） */
const NOISE = new Set(["NODE_ENV", "LLM_TEST_MODE", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "CRON_SECRET", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY"]);

/** 足した行（+ で始まり +++ でない）から、スイッチと関数の名 */
export function diffSignals(diffText: string): { switches: string[]; funcs: string[] } {
  const sw = new Set<string>(), fn = new Set<string>();
  for (const l of diffText.split("\n")) {
    if (!l.startsWith("+") || l.startsWith("+++")) continue;
    for (const m of l.matchAll(ENV_RE)) { const n = m[1] ?? m[2]; if (n && !NOISE.has(n) && !/^(GET|POST|PUT|DELETE|JST|UTC|ISO|URL|API)_/.test(n)) sw.add(n); }
    for (const m of l.matchAll(FN_RE)) { const n = m[1] ?? m[2]; if (n) fn.add(n); }
  }
  return { switches: [...sw].sort(), funcs: [...fn].sort() };
}

/** 重点（純関数）: スイッチ → 場面の地図の型と名指しの問題・スイッチ／関数の名が書いてある問題の型。stage は差分の段（exam-scope）をそのまま */
export function focusOf(i: { diffText: string; sceneMap: FocusSceneMap; spec: ReadonlyArray<FocusSpec>; stage?: "brain" | "draft" | null; switchName?: string }): Focus {
  const s = diffSignals(i.diffText);
  const switches = [...new Set([...s.switches, ...String(i.switchName ?? "").split(",").map((x) => x.trim()).filter(Boolean)])].sort();
  const types = new Set<string>(), ids = new Set<string>(), whys: string[] = [];
  const specIds = new Set(i.spec.map((p) => p.id));
  for (const sw of switches) {
    const e = i.sceneMap[sw];
    if (!e || typeof e === "string") continue;
    for (const t of e.types ?? []) types.add(t);
    for (const id of e.only ?? []) if (specIds.has(id)) ids.add(id);
    whys.push(`${sw}→地図`);
  }
  const names = [...switches, ...s.funcs];
  if (names.length) {
    for (const p of i.spec) {
      const text = `${p.why ?? ""} ${p.source ?? ""} ${(p.tags ?? []).join(" ")}`;
      const hit = names.find((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(text));
      if (hit) { ids.add(p.id); types.add(p.type); if (!whys.includes(`${hit}→問題`)) whys.push(`${hit}→問題`); }
    }
  }
  return { switches, funcs: s.funcs, types: [...types].sort(), ids: [...ids].sort(), stage: i.stage ?? null, why: whys.slice(0, 6).join("・") || "差分から場面を決められない" };
}

/** 重点の場面の中の問題（名指し＋型が重点の物）。狙い（targets）は除く */
export function focusPool(f: Focus, spec: ReadonlyArray<FocusSpec>, targets: ReadonlyArray<string> = []): string[] {
  const t = new Set(targets), ty = new Set(f.types);
  return [...new Set([...f.ids, ...spec.filter((p) => ty.has(p.type)).map((p) => p.id)])].filter((id) => !t.has(id));
}

/** 狙いの無い依頼の問題を重点から選ぶ（使い回せる＞安定＞名指し の順・n 問）。重点が無ければ空（＝今まで通り RAG） */
export function pickByFocus(f: Focus, spec: ReadonlyArray<FocusSpec>, o: { n: number; nightlyIds: ReadonlySet<string>; stableIds: ReadonlySet<string> }): string[] {
  const named = new Set(f.ids);
  const pool = focusPool(f, spec);
  const score = (id: string) => (named.has(id) ? 4 : 0) + (o.nightlyIds.has(id) ? 2 : 0) + (o.stableIds.has(id) ? 1 : 0);
  return pool.map((id, k) => ({ id, k, s: score(id) })).sort((a, b) => b.s - a.s || a.k - b.k).slice(0, o.n).map((x) => x.id);
}

/** 計画の1行 */
export function focusLine(f: Focus, pool: number): string {
  if (!f.types.length && !f.ids.length) return `重点: 決められない（${f.why}）`;
  return `重点: 場面 ${f.types.slice(0, 5).join("・")}${f.types.length > 5 ? ` 他${f.types.length - 5}` : ""}${f.ids.length ? `・名指し ${f.ids.slice(0, 6).join(",")}` : ""}${f.stage ? `・段 ${f.stage}` : ""}（${f.why}・候補 ${pool}問）`;
}

/** DeepSeek の答え（{"types":[...]}）から、spec にある型だけ */
export function parseFocusTypes(text: string | null, known: ReadonlySet<string>): string[] {
  if (!text) return [];
  const m = text.match(/\{[\s\S]*\}/); if (!m) return [];
  try { const j = JSON.parse(m[0]) as { types?: unknown }; return Array.isArray(j.types) ? [...new Set(j.types.map(String).filter((t) => known.has(t)))].slice(0, 3) : []; } catch { return []; }
}
