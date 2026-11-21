// scripts/route-substate-phrasing.ts — 駅の中の状態ごとに、竹内さんの言い回しの型（文は写さない・型と語の短い一覧）と潜在の4つ（KB d72ad06b）を集める
//   （読むだけ・LLM なし・DB なし・費用 0・作業員M・2026-11-21・台帳 #467 の (3)）
//   材料（どれも伏せ済みの写し）: exam-cache/anatomy-roles/roles-r1.json（竹内さんの文の役目の並び）・anatomy-seven/seven-all198.json（答え方 point_how・信頼の出し方 trust_how）・
//     anatomy-seven/seven-latent4.json＋seven-latent4b.json（潜在の4つ: 何で＝trigger・何の部分を＝part・どんな気持ちで＝feeling・本当はどうしたいのか＝want／先回りの事実 fact／誘導先 lead）
//   状態の割り当て: --labels=<json {id: substate}>（夜の DeepSeek の読み）が無ければ網（turn-aims-after.matchSubstateOf）。網は 62/198 しか当たらない（#467 の (2)）
//   出す物: 状態ごとに 通数・役目の並びの上位・答え方・信頼の出し方・語の一覧（決まった語の表に当たった語の数だけ・文は出さない）・潜在の4つの上位・先回りの事実・誘導先
// 実行: npx tsx scripts/route-substate-phrasing.ts [--labels=<json>] [--out=<json>] [--top=3]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { matchSubstateOf } from "../app/lib/turn-aims-after";
import { SUBSTATES } from "../app/lib/apply-route-substate";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(__dirname, "..", "..", "..", "exam-cache");
const TOP = Number(arg("top", "3")) || 3;
type Role = { id: string; customer?: string; sentences?: string[]; roles?: Array<{ role: string | null }> };
type Seven = { id: string; reads?: Array<{ point_how?: string[]; trust_how?: string[] }> };
type L4 = { id: string; reads?: Array<{ none?: boolean; trigger?: { kind?: string } | null; part?: { point?: string } | null; feeling?: { what?: string; strength?: string } | null; want?: string | null; fact?: string | null; lead?: string | null }> };

/** 語の表（竹内さんの言い回しの手がかりの語・文は写さない）。役目ごとに数える */
export const WORDS: ReadonlyArray<[string, RegExp]> = [
  ["かしこまりました", /かしこまりました/], ["承知", /承知/], ["ありがとうございます", /ありがとうございま/], ["頂き", /頂き|頂け/], ["致します", /致しま/],
  ["如何でしょうか", /如何でしょうか|いかがでしょうか/], ["是非", /是非|ぜひ/], ["全力", /全力/], ["ご安心", /ご安心/], ["お気軽に", /お気軽に/],
  ["恐れ入りますが", /恐れ入/], ["申し訳", /申し訳/], ["！！", /！！|!!/], ["🌟", /🌟/], ["確認出来次第", /確認出来次第|確認でき次第/],
  ["本日中に", /本日中/], ["抑え", /抑え/], ["1部屋のみ", /1部屋のみ|一部屋のみ/], ["最大限割引", /最大限/], ["ご満足", /ご満足/],
];
const FEEL: ReadonlyArray<[string, RegExp]> = [["焦り", /急|早く|間に合|焦/], ["遠慮", /申し訳|すみません|遠慮|何度も/], ["不信", /おとり|本当に|信じ|怪し/], ["念押し", /念のため|念の為|改めて/], ["迷い", /迷|悩|決め(?:られ|かね)|比べ/], ["期待", /期待|楽しみ|したい|進めたい|前向き/], ["不満", /不満|残念|高い|狭い|遠い/], ["不安", /不安|心配|気に(?:し|な)|払える|足り/]];
const WANT: ReadonlyArray<[string, RegExp]> = [["決めたい", /決め|申込|申し込/], ["抑えたい", /抑え|確保|取られ/], ["安くしたい", /安く|費用|抑えたい|予算/], ["比べたい", /比べ|他の|検討/], ["待ちたい", /待|後で|ゆっくり|まだ/], ["見たい", /内覧|内見|見て/], ["知りたい", /知りたい|確認|教えて|分かり/]];
const kindOf = (t: string, table: ReadonlyArray<[string, RegExp]>) => table.find(([, re]) => re.test(t))?.[0] ?? "その他";
const inc = (m: Record<string, number>, k: string | null | undefined) => { const key = String(k ?? "").trim() || "-"; m[key] = (m[key] ?? 0) + 1; };
const top = (m: Record<string, number>, n = TOP) => Object.entries(m).filter(([k]) => k !== "-").sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k.slice(0, 20)} ${v}`);

function main() {
  const roles = JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as Role[];
  const seven = new Map((JSON.parse(readFileSync(join(CACHE, "anatomy-seven", "seven-all198.json"), "utf8")) as Seven[]).map((x) => [x.id, x]));
  const l4 = new Map<string, NonNullable<L4["reads"]>[number]>();
  for (const f of ["seven-latent4.json", "seven-latent4b.json"]) {
    const p = join(CACHE, "anatomy-seven", f);
    if (!existsSync(p)) continue;
    for (const x of JSON.parse(readFileSync(p, "utf8")) as L4[]) { const r = x.reads?.find((y) => !y.none); if (r) l4.set(x.id, r); }
  }
  const labels = arg("labels") ? (JSON.parse(readFileSync(arg("labels"), "utf8")) as Record<string, string>) : null;
  type Agg = { n: number; pattern: Record<string, number>; pointHow: Record<string, number>; trustHow: Record<string, number>; words: Record<string, number>; trigger: Record<string, number>; part: Record<string, number>; feeling: Record<string, number>; want: Record<string, number>; fact: Record<string, number>; lead: Record<string, number>; latentN: number };
  const by = new Map<string, Agg>();
  let unlabeled = 0;
  for (const r of roles) {
    const sid = labels ? labels[r.id] ?? null : matchSubstateOf(r.customer ?? "")?.id ?? null;
    if (!sid || !SUBSTATES.some((s) => s.id === sid)) { unlabeled++; continue; }
    const a = by.get(sid) ?? { n: 0, pattern: {}, pointHow: {}, trustHow: {}, words: {}, trigger: {}, part: {}, feeling: {}, want: {}, fact: {}, lead: {}, latentN: 0 };
    a.n++;
    inc(a.pattern, (r.roles ?? []).map((x) => x.role ?? "?").filter((x) => x !== "greet").slice(0, 4).join(">"));
    const sv = seven.get(r.id)?.reads?.[0];
    for (const h of sv?.point_how ?? []) inc(a.pointHow, h);
    for (const h of sv?.trust_how ?? []) inc(a.trustHow, h);
    const text = (r.sentences ?? []).join("\n");
    for (const [w, re] of WORDS) if (re.test(text)) inc(a.words, w);
    const lt = l4.get(r.id);
    if (lt) {
      a.latentN++;
      inc(a.trigger, lt.trigger?.kind); inc(a.part, lt.part?.point);
      inc(a.feeling, lt.feeling?.what ? `${kindOf(lt.feeling.what, FEEL)}${lt.feeling.strength ? `・${lt.feeling.strength}` : ""}` : null);
      inc(a.want, lt.want ? kindOf(lt.want, WANT) : null); inc(a.fact, lt.fact ? lt.fact.slice(0, 16) : null); inc(a.lead, lt.lead);
    }
    by.set(sid, a);
  }
  const out: Record<string, unknown> = {};
  console.log(`198通・割り当て ${labels ? "DeepSeek の読み" : "網"}・状態の無い番 ${unlabeled}`);
  for (const s of SUBSTATES) {
    const a = by.get(s.id);
    if (!a) { console.log(`\n■ ${s.id}（${s.label}）: 0通`); out[s.id] = { n: 0 }; continue; }
    const row = {
      n: a.n, latent_n: a.latentN,
      phrasing: { pattern: top(a.pattern), point_how: top(a.pointHow), trust_how: top(a.trustHow), words: top(a.words, 6) },
      latent4: { trigger: top(a.trigger), part: top(a.part), feeling: top(a.feeling), want: top(a.want) },
      fact: top(a.fact), lead: top(a.lead),
    };
    out[s.id] = row;
    console.log(`\n■ ${s.id}（${s.label}）: ${a.n}通（潜在の読み ${a.latentN}）`);
    console.log(`  型: 役目 ${row.phrasing.pattern.join("／")}｜答え方 ${row.phrasing.point_how.join("／")}｜信頼 ${row.phrasing.trust_how.join("／")}`);
    console.log(`  語: ${row.phrasing.words.join("／")}`);
    console.log(`  潜在: 何で ${row.latent4.trigger.join("／")}｜何の部分 ${row.latent4.part.join("／")}｜気持ち ${row.latent4.feeling.join("／")}｜したい ${row.latent4.want.join("／")}`);
    console.log(`  先回り ${row.fact.join("／")}｜誘導 ${row.lead.join("／")}`);
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ at: new Date().toISOString(), by: labels ? "labels" : "net", unlabeled, states: out }, null, 2));
}
main();
