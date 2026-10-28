// scripts/score-second-appeal.ts — 2通目の訴求の物差し3つ（竹内さんの文が正解・LLM なし）
//   ①一番に言う訴求が竹内さんと同じか ②訴求の数（竹内さんとの差）③締めが合っているか（内覧／申込／ご査収）
//   入力: exam-aix-text の結果の json（--qfile の問題の組）。--vs で前の結果と並べる。
// 実行: npx tsx scripts/score-second-appeal.ts --qfile=second-appeal.json --res=<結果の json> [--vs=<前の結果の json>] [--show=3]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPEAL_ELEMENTS } from "../app/lib/second-appeal-points";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DIR = join(process.cwd(), "..", "..", "exam-cache", "aix-text-exam");
const qs = new Map(((JSON.parse(readFileSync(join(DIR, arg("qfile", "second-appeal.json")), "utf8")) as { questions: Array<{ id: string; gold: string }> }).questions).map((q) => [q.id, q.gold]));
const CLOSE: Array<[string, RegExp]> = [["apply", /お申込|お部屋(?:を)?抑え|押さえ|並行して審査/], ["viewing", /ご案内させて|ご内覧|内覧/]];
// 2通目の訴求は駅・築年など一般の要素も含む。挨拶・締めの文は数えない
function appeal(t: string): { first: string | null; n: number; close: string } {
  const body = t.split(/\n/).filter((l) => !/お手隙|ご査収|お気に召され|お気軽|お世話になって/.test(l)).join("\n");
  const hits = APPEAL_ELEMENTS.map((e) => ({ k: e.key, at: body.search(e.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  return { first: hits[0]?.k ?? null, n: hits.length, close: CLOSE.find(([, re]) => re.test(t))?.[0] ?? "receipt" };
}
type Row = { id: string; text: string; err?: string | null; score?: { total?: number; pass?: boolean } };
function score(file: string) {
  const rows = (JSON.parse(readFileSync(file, "utf8")) as { rows?: Row[] } & Row[]);
  const list: Row[] = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const per = new Map<string, { first: boolean; dn: number; close: boolean; gClose: string; text: string; gold: string }>();
  for (const r of list) {
    const gold = qs.get(r.id); if (!gold || r.err || !r.text) continue;
    const g = appeal(gold), a = appeal(r.text);
    per.set(r.id, { first: !!g.first && g.first === a.first, dn: a.n - g.n, close: g.close === a.close, gClose: g.close, text: r.text, gold });
  }
  const v = [...per.values()];
  return { per, n: v.length, first: v.filter((x) => x.first).length, absDn: v.reduce((s, x) => s + Math.abs(x.dn), 0) / Math.max(1, v.length), over: v.filter((x) => x.dn > 0).length, close: v.filter((x) => x.close).length, byClose: ["viewing", "apply", "receipt"].map((k) => `${({ viewing: "内覧", apply: "申込", receipt: "ご査収" } as Record<string, string>)[k]} ${v.filter((x) => x.gClose === k && x.close).length}/${v.filter((x) => x.gClose === k).length}`).join("・") };
}
const cur = score(arg("res"));
const fmt = (s: ReturnType<typeof score>) => `①一番の訴求が同じ ${s.first}/${s.n}・②数の差（平均の絶対値）${s.absDn.toFixed(2)}・竹内さんより多い ${s.over}/${s.n}・③締めが同じ ${s.close}/${s.n}（竹内さんの締めごと: ${s.byClose}）`;
console.log(`今: ${fmt(cur)}`);
if (arg("vs")) {
  const prev = score(arg("vs"));
  console.log(`前: ${fmt(prev)}`);
  let better = 0, worse = 0;
  for (const [id, c] of cur.per) { const p = prev.per.get(id); if (!p) continue; const sc = (x: typeof c) => (x.first ? 1 : 0) + (x.close ? 1 : 0) - Math.abs(x.dn) * 0.3; if (sc(c) > sc(p) + 0.01) better++; else if (sc(c) < sc(p) - 0.01) worse++; }
  console.log(`番ごと（①＋③−0.3×|②|）: 良くなった ${better}・悪くなった ${worse}`);
  const show = Number(arg("show", "3"));
  const ids = [...cur.per.keys()].filter((id) => prev.per.has(id)).slice(0, show);
  for (const id of ids) {
    const c = cur.per.get(id)!, p = prev.per.get(id)!;
    console.log(`\n### ${id}\n竹内さん: ${c.gold.replace(/\s+/g, " ").slice(0, 260)}\n前: ${p.text.replace(/\s+/g, " ").slice(0, 260)}\n後: ${c.text.replace(/\s+/g, " ").slice(0, 260)}`);
  }
}
