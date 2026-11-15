// scripts/lib/rag-precision.ts — RAG ごとの精度の物差し（純関数・LLM なし・費用 0）
//
// 2026-11-15 作業員H（統括役の頼み 土台②・竹内さん 11/15「精度の高い RAG か」・KB P0 3041baaa）:
//   竹内さん本人の番（見張りの番・最初の一手の書き手が takeuchi）を1つずつ取り出し、その番の問い（その番の ai_reply_examples の埋め込み＝文書と同じ形・9/13 の監査）で
//   各 RAG を今の形のまま引き直し、引いた手本が竹内さんの実際の一手と
//     ① 道（返信か AIX か・AIX の系統 aixFamily）
//     ② 言い方の骨（compose-prod-elements の要素: 頭・押さえ・信頼・潜在・つなぎ・締め・事実）
//   でどれだけ合うかを、RAG ごと・場面ごとに数える。同じ会話・その番より後の手本は外す（本番では見えない物・答えの写し）。
//   決める物（どの RAG を何件・並べ替えの加点）は、この数えの前後比べで決める（推測で埋めない・統括役の頼み 3・4）。
import { compareProdTurn, type ProdElResult } from "./compose-prod-elements";
import { aixFamily } from "./prod-yardstick-db";

/** ai_reply_examples の行の道（line_reply＝返信・aix_* は AIX の系統） */
export function familyOfExample(entrySource: string | null | undefined, aixAction: string | null | undefined): string {
  const src = String(entrySource ?? "");
  if (src === "line_reply" || !aixAction) return "返信";
  return aixFamily(aixAction);
}

export type Neighbor = { id: string; family: string; reply: string | null; sim: number; conversationId: string | null; at: string | null };
export type HeldOut = { key: string; scene: string; conversationId: string; at: string; truthFamily: string; takeuchiTexts: string[] };
export type RagScore = {
  rag: string; scene: string; got: number;
  top1Route: boolean | null;     // 一番近い手本の道が竹内さんと同じか（手本が無ければ null）
  majRoute: boolean | null;      // 上位5件の多数の道が同じか
  skeleton: ProdElResult[] | null; // 一番近い「文のある」手本の骨（返信の番だけ・竹内さんの文が無い番は null）
  topSim: number | null;
};

/** 同じ会話・その番より後の手本を外して上位 k */
export function usableNeighbors(h: Pick<HeldOut, "conversationId" | "at">, ns: ReadonlyArray<Neighbor>, k = 5): Neighbor[] {
  const t = Date.parse(h.at);
  return ns.filter((n) => n.conversationId !== h.conversationId && (!n.at || Date.parse(n.at) < t)).sort((a, b) => b.sim - a.sim).slice(0, k);
}

export function majorityFamily(ns: ReadonlyArray<Pick<Neighbor, "family">>): string | null {
  if (!ns.length) return null;
  const c = new Map<string, number>();
  for (const n of ns) c.set(n.family, (c.get(n.family) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** 1つの番 × 1つの RAG の数え（ns は引き直した手本・外す前） */
export function scoreHeldOut(rag: string, h: HeldOut, ns: ReadonlyArray<Neighbor>, opts: { routeAware?: boolean } = {}): RagScore {
  const u = usableNeighbors(h, ns);
  const routeAware = opts.routeAware ?? true;
  const top = u[0] ?? null;
  const withText = u.find((n) => (n.reply ?? "").trim().length > 0) ?? null;
  const skeleton = h.truthFamily === "返信" && h.takeuchiTexts.length && withText ? compareProdTurn(h.takeuchiTexts, withText.reply ?? "").filter((r) => r.el !== "2通目") : null;
  return {
    rag, scene: h.scene, got: u.length,
    top1Route: routeAware && top ? top.family === h.truthFamily : null,
    majRoute: routeAware && u.length ? majorityFamily(u) === h.truthFamily : null,
    skeleton, topSim: top ? Math.round(top.sim * 1000) / 1000 : null,
  };
}

export type RagTally = { rag: string; scene: string; n: number; empty: number; route1: [number, number]; routeMaj: [number, number]; skel: [number, number]; simSum: number; simN: number };
/** RAG × 場面で足す（場面 "全体" も作る） */
export function tallyRag(scores: ReadonlyArray<RagScore>): RagTally[] {
  const m = new Map<string, RagTally>();
  const get = (rag: string, scene: string) => {
    const k = `${rag}\u0000${scene}`;
    let t = m.get(k);
    if (!t) { t = { rag, scene, n: 0, empty: 0, route1: [0, 0], routeMaj: [0, 0], skel: [0, 0], simSum: 0, simN: 0 }; m.set(k, t); }
    return t;
  };
  for (const s of scores) for (const t of [get(s.rag, s.scene), get(s.rag, "全体")]) {
    t.n++;
    if (!s.got) t.empty++;
    if (s.top1Route !== null) { t.route1[1]++; if (s.top1Route) t.route1[0]++; }
    if (s.majRoute !== null) { t.routeMaj[1]++; if (s.majRoute) t.routeMaj[0]++; }
    for (const r of s.skeleton ?? []) if (r.has) { t.skel[1]++; if (r.hit) t.skel[0]++; }
    if (s.topSim !== null) { t.simSum += s.topSim; t.simN++; }
  }
  return [...m.values()].sort((a, b) => a.rag.localeCompare(b.rag) || (a.scene === "全体" ? -1 : b.scene === "全体" ? 1 : b.n - a.n));
}

const pct = ([a, b]: [number, number]) => (b ? `${Math.round((a / b) * 100)}%（${a}/${b}）` : "-");
export function formatTally(ts: ReadonlyArray<RagTally>, minN = 3): string[] {
  return ts.filter((t) => t.scene === "全体" || t.n >= minN).map((t) =>
    `${t.rag}\t${t.scene}\tn=${t.n}\t空 ${t.empty}\t道(1件目) ${pct(t.route1)}\t道(上位5の多数) ${pct(t.routeMaj)}\t骨 ${pct(t.skel)}\t近さ ${t.simN ? (t.simSum / t.simN).toFixed(3) : "-"}`);
}
