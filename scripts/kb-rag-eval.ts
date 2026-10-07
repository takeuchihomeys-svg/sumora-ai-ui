// scripts/kb-rag-eval.ts — 設計知見の引き方の当たり方を比べる（旧の部分一致・語と札だけ・近さだけ・合わせ技）
// 2026-10-06 竹内「設計知見ひっぱるときRAG検索いれたらどうか」（⑯）。問いは最近の作業から・正解は人が選ぶ行（id の先頭8字か題の先頭）。
// 実行: npx tsx --env-file=.env.local scripts/kb-rag-eval.ts [--k=5] [--weights=vector:1,keyword:0.35,tag:0.1,recency:0.05]
//   OpenAI の埋め込みを問いの数だけ呼ぶ（1回 約0.0000004ドル）。DB は読むだけ
import { createClient } from "@supabase/supabase-js";
import { searchKb } from "../app/lib/design-knowledge-rag-server";
import { hybridRank, type RagRow } from "../app/lib/design-knowledge-rag";
import { readFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const K = Number((process.argv.find((a) => a.startsWith("--k=")) ?? "--k=5").split("=")[1]);
const wArg = (process.argv.find((a) => a.startsWith("--weights=")) ?? "").split("=")[1];
const weights = wArg ? Object.fromEntries(wArg.split(",").map((p) => { const [k, v] = p.split(":"); return [k, Number(v)]; })) : undefined;

export const EVAL: Array<{ q: string; gold: string[] }> = [
  { q: "待ち合わせ場所はどう決める", gold: ["1290264c"] },
  { q: "絵文字の決まり", gold: ["85b7130c"] },
  { q: "審査を先に出せるか", gold: ["fc5a9c1a"] },
  { q: "地域を駅と取り違えた", gold: ["title:希望エリアの「守口市」"] },
  { q: "プロンプトキャッシュの分け方", gold: ["9feccd98"] },
  { q: "電話は何時まで対応できる", gold: ["2866fc10"] },
  { q: "初期費用を分割で払えるか", gold: ["bd416419", "2ebe308c"] },
  { q: "部屋を仮押さえできるか", gold: ["cdd11c67"] },
  { q: "相手をお客様と呼んでいいか", gold: ["89115f27"] },
  { q: "挨拶はいつ入れるか", gold: ["8d67a054"] },
  { q: "拡張ツールが重い原因", gold: ["1c37df5f"] },
  { q: "自動検索をやめて光らせるだけにする", gold: ["7cddbfef"] },
  { q: "申込に必要な書類は何か", gold: ["f7ddd71b"] },
  { q: "AIXの確認しますは使うのか", gold: ["e506807a"] },
  { q: "内覧の候補日の出し方", gold: ["5290cb77"] },
  { q: "待ち合わせの住所が丁目で終わっている", gold: ["0de29196"] },
  { q: "pgvectorの索引の注意点", gold: ["99e242e4"] },
  { q: "設計知見の古い行を整理する", gold: ["5aced6ad"] },
  { q: "送れる物件がまだ無い時のブレインの判断", gold: ["d43db7aa"] },
  { q: "なんば・梅田に出やすいエリア", gold: ["2cb3be5a"] },
  { q: "見積書の後に申込を勧めるか", gold: ["19935ac1"] },
  { q: "家賃の相場をお客様にどう伝える", gold: ["d71fcffe"] },
  { q: "室内写真を頼まれた時", gold: ["c53dd9fc"] },
  { q: "内覧の段階の進め方", gold: ["ee24fa7c"] },
];

// 重みを決めるのに使っていない問い（当て直しの過学習を見る）
export const HOLDOUT: Array<{ q: string; gold: string[] }> = [
  { q: "見積書の総額を聞かれた時", gold: ["b748b152"] },
  { q: "初期費用が安すぎて不審がられた", gold: ["96f485fc"] },
  { q: "AIの作業メモが下書きに入っていた", gold: ["67c20ade"] },
  { q: "会話に無い相場の金額を言い切った", gold: ["97d5308c"] },
  { q: "乗り換えなしで通える駅", gold: ["fbedd55b"] },
  { q: "スタッフはどの物件に星を付けるか", gold: ["05221cc1"] },
  { q: "同じ絵文字が何度も入る", gold: ["f8d47775"] },
  { q: "YUMAで本番の会話を再生すると日付がずれる", gold: ["15fdaf95"] },
  { q: "AIXの文のズレをどう測る", gold: ["1a35e6d6"] },
  { q: "最終チェックの書き直しで挨拶が消える", gold: ["d4bac591"] },
  { q: "安いモデルを使う時の歯止め", gold: ["35e1e992"] },
  { q: "お客様の状況があちこちに別々に保存されている", gold: ["508b1d45"] },
];
const SETS = process.argv.includes("--holdout") ? HOLDOUT : EVAL;

const isGold = (r: RagRow, g: string) => g.startsWith("title:") ? r.title.startsWith(g.slice(6)) : r.id.startsWith(g);

(async () => {
  const rows: RagRow[] = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, rationale, context, tags, is_current, created_at").eq("is_current", true).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as RagRow[]));
    if ((data ?? []).length < 1000) break;
  }
  // 2026-10-07 段: --priority-plan=<scripts/kb-priority.ts の計画> で列の代わりに段を載せて測る
  const planArg = process.argv.find((a) => a.startsWith("--priority-plan="))?.slice(16);
  if (planArg) { const pl = JSON.parse(readFileSync(planArg, "utf8")) as { decisions: Array<{ id: string; priority: number }> }; const m = new Map(pl.decisions.map((d) => [d.id, d.priority])); for (const r of rows) r.priority = m.get(r.id) ?? r.priority; }
  const missing = SETS.flatMap((e) => e.gold.filter((g) => !rows.some((r) => isGold(r, g))));
  if (missing.length) console.log("⚠ 正解の行が現行に無い:", missing.join(", "));
  const vecCache = new Map<string, Map<string, number>>();
  const modes = ["substring", "keyword", "vector", "hybrid"] as const;
  const hit: Record<string, number> = {}, mrr: Record<string, number> = {};
  for (const m of modes) { hit[m] = 0; mrr[m] = 0; }
  const misses: string[] = [];
  for (const e of SETS) {
    // 旧の kb.ts --q（題・本文の部分一致・新しい順）
    const sub = rows.filter((r) => r.title.includes(e.q) || r.insight.includes(e.q)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, K);
    const lists: Record<string, RagRow[]> = { substring: sub };
    await searchKb(sb, e.q, { k: K, rows, vecCache, mode: "vector" }); // 埋め込みを1回だけ取って覚える
    const vec = vecCache.get(e.q) ?? new Map();
    for (const m of ["keyword", "vector", "hybrid"] as const) lists[m] = hybridRank(rows, vec, e.q, { nowIso: new Date().toISOString(), mode: m, weights }).slice(0, K).map((s) => s.row);
    for (const m of modes) {
      const idx = lists[m].findIndex((r) => e.gold.some((g) => isGold(r, g)));
      if (idx >= 0) { hit[m]++; mrr[m] += 1 / (idx + 1); }
      else if (m === "hybrid") misses.push(`${e.q} → 1位: ${lists[m][0]?.title.slice(0, 50) ?? "なし"}`);
    }
  }
  if (process.argv.includes("--grid")) {
    // 重みの当て直し（埋め込みは上で取った物を使い回す＝追加の費用なし）
    const res: Array<{ w: string; hit: number; mrr: number }> = [];
    for (const kw of [0, 0.15, 0.25, 0.35, 0.5, 0.8]) for (const tg of [0, 0.1, 0.3]) for (const rc of [0, 0.05, 0.15, 0.3]) {
      let h = 0, m = 0;
      for (const e of SETS) {
        const l = hybridRank(rows, vecCache.get(e.q) ?? new Map(), e.q, { nowIso: new Date().toISOString(), mode: "hybrid", weights: { vector: 1, keyword: kw, tag: tg, recency: rc } }).slice(0, K).map((s) => s.row);
        const idx = l.findIndex((r) => e.gold.some((g) => isGold(r, g)));
        if (idx >= 0) { h++; m += 1 / (idx + 1); }
      }
      res.push({ w: `keyword:${kw},tag:${tg},recency:${rc}`, hit: h, mrr: m / SETS.length });
    }
    res.sort((a, b) => b.hit - a.hit || b.mrr - a.mrr);
    for (const r of res.slice(0, 10)) console.log(`  grid ${r.w}  recall@${K} ${(r.hit / SETS.length).toFixed(2)}・MRR ${r.mrr.toFixed(2)}`);
  }
  console.log(`=== 設計知見の引き方（問い ${SETS.length}・上位${K}に正解が入った率・MRR）`);
  for (const m of modes) console.log(`  ${m.padEnd(9)} recall@${K} ${(hit[m] / SETS.length).toFixed(2)}（${hit[m]}/${SETS.length}）・MRR ${(mrr[m] / SETS.length).toFixed(2)}`);
  if (misses.length) { console.log("  合わせ技で外れた問い:"); for (const x of misses) console.log("   - " + x); }
})().catch((e) => { console.error(e); process.exit(1); });
