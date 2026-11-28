// scripts/lib/ledger-stale.ts — 「作ってあるのに台帳は todo のまま」を見つける（純関数・LLM なし・統括役の頼み 11/28）
// 2026-11-28 作業員L: 11/28 だけで #664・#684・#728・#747・#749（L）・#813・#814・#817・#829・#830（A）が、コードもコミットもあるのに todo のままだった。
//   台帳の行（件名・next_step・switch_name）から スイッチ名・ファイル名・コミットを取り出し、git log（件名に #id のあるコミット）・コードの中の名前・ファイルの有る無しで引き当てる。
//   出すのは候補だけ（書き換えは統括役が一覧を見てから）。
export type LedgerItem = { id: number; title: string | null; next_step: string | null; switch_name: string | null; owner: string | null; stage: string; commits?: string[] | null; updated_at?: string | null };
export type GitCommit = { hash: string; date: string; subject: string };
export type StaleVerdict = "done_candidate" | "built_off_candidate" | "partly" | "not_built";
export type StaleRow = {
  id: number; owner: string; stage: string; title: string;
  refCommits: GitCommit[];          // 件名に #id があるコミット
  switches: Array<{ name: string; inCode: boolean; def: string | null }>;
  files: Array<{ path: string; exists: boolean }>;
  hashes: Array<{ hash: string; known: boolean }>;
  verdict: StaleVerdict; why: string;
};

const SWITCH_RE = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/g;
// 名前の形だけ似た一般語（スイッチではない）
const NOT_SWITCH = new Set(["JSON_OUT", "LLM_TEST_MODE", "LLM_TEST_FINAL_CLAUDE", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]);
const FILE_RE = /\b(?:(?:app|scripts|chrome-extension)\/)?[A-Za-z0-9_\-./]*[a-z0-9][a-z0-9-]*\.(?:ts|tsx|cjs|mjs|js|json)\b/g;
const HASH_RE = /(?<![0-9a-zA-Z])[0-9a-f]{8,10}(?![0-9a-zA-Z])/g;

export function switchesOf(it: Pick<LedgerItem, "title" | "next_step" | "switch_name">): string[] {
  const s = new Set<string>();
  if (it.switch_name) s.add(it.switch_name.trim());
  for (const t of [it.title, it.next_step]) for (const m of String(t ?? "").matchAll(SWITCH_RE)) if (!NOT_SWITCH.has(m[0])) s.add(m[0]);
  return [...s];
}
export function filesOf(it: Pick<LedgerItem, "title" | "next_step">): string[] {
  const s = new Set<string>();
  for (const t of [it.title, it.next_step]) for (const m of String(t ?? "").matchAll(FILE_RE)) { const p = m[0].replace(/^\.\//, ""); if (/\//.test(p) || /^[a-z0-9-]+\.(?:ts|tsx)$/.test(p)) s.add(p); }
  return [...s];
}
export function hashesOf(it: Pick<LedgerItem, "next_step" | "commits">): string[] {
  const s = new Set<string>((it.commits ?? []).map((x) => x.slice(0, 9)));
  for (const m of String(it.next_step ?? "").matchAll(HASH_RE)) if (/[a-f]/.test(m[0]) && /\d/.test(m[0])) s.add(m[0].slice(0, 9));
  return [...s];
}
/** コミットの件名に #id（数字の続きでない）があるか */
export function refsOf(id: number, commits: readonly GitCommit[]): GitCommit[] {
  const re = new RegExp(`#${id}(?![0-9])`);
  return commits.filter((c) => re.test(c.subject));
}

export function staleRowOf(
  it: LedgerItem,
  o: { commits: readonly GitCommit[]; codeNames: ReadonlySet<string>; defaults: Readonly<Record<string, string>>; fileExists: (p: string) => boolean; knownHash: (h: string) => boolean },
): StaleRow {
  const refCommits = refsOf(it.id, o.commits);
  const switches = switchesOf(it).map((name) => ({ name, inCode: o.codeNames.has(name), def: o.defaults[name] ?? null }));
  const files = filesOf(it).map((path) => ({ path, exists: o.fileExists(path) }));
  const hashes = hashesOf(it).map((hash) => ({ hash, known: o.knownHash(hash) }));
  const swIn = switches.filter((s) => s.inCode), fileIn = files.filter((f) => f.exists), hashIn = hashes.filter((h) => h.known);
  const evidence = refCommits.length + swIn.length + fileIn.length + hashIn.length;
  let verdict: StaleVerdict, why: string;
  const offSw = swIn.filter((s) => s.def == null || /^(?:off|shadow|log|warn|\?)$/i.test(s.def));
  if (refCommits.length && swIn.length && !offSw.length) { verdict = "done_candidate"; why = `件名に #${it.id} のコミット ${refCommits.length}・スイッチは既定 on（${swIn.map((s) => `${s.name}=${s.def}`).join("・")}）`; }
  else if (refCommits.length && offSw.length) { verdict = "built_off_candidate"; why = `件名に #${it.id} のコミット ${refCommits.length}・既定 off か既定の読めないスイッチ ${offSw.map((s) => `${s.name}=${s.def ?? "表に無い"}`).join("・")}`; }
  else if (refCommits.length && !switches.length) { verdict = "done_candidate"; why = `件名に #${it.id} のコミット ${refCommits.length}（スイッチの名前は台帳に無い＝記録・台本の件なら済みの候補）`; }
  else if (evidence) { verdict = "partly"; why = [refCommits.length ? `#${it.id} のコミット ${refCommits.length}` : "", swIn.length ? `コードにあるスイッチ ${swIn.map((s) => s.name).join("・")}` : "", fileIn.length ? `あるファイル ${fileIn.map((f) => f.path).join("・")}` : "", hashIn.length ? `あるコミット ${hashIn.map((h) => h.hash).join("・")}` : ""].filter(Boolean).join("・"); }
  else { verdict = "not_built"; why = "台帳の名前がコードにもコミットにも見当たらない"; }
  return { id: it.id, owner: String(it.owner ?? "-"), stage: it.stage, title: String(it.title ?? "").replace(/\s+/g, " ").slice(0, 70), refCommits, switches, files, hashes, verdict, why };
}

export const VERDICT_JA: Record<StaleVerdict, string> = { done_candidate: "done の候補", built_off_candidate: "built_off の候補", partly: "一部ありそう", not_built: "作っていなさそう" };
