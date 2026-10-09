// scripts/kb.ts — 設計知見を引く（MCP が落ちている時の経路・読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/kb.ts --q="自然文の問い" [--tags=RAG,場面] [--limit=8] [--full]   （使い方の手順は --help）
//   2026-10-06（⑯・RAG）--q は埋め込みの近さ＋語＋札＋新しさで並べる（design-knowledge-rag.ts hybridRank・退役した行は出さない）。
//   2026-10-07（3巡目）--scene=<場面>（ack|considering|question|conditions|property_share|cost|viewing|apply か 短いお礼・検討中…）で
//   返信の場面の札「場面:〇〇」・題の型の行に点を足す（問い45で recall@5 0.78→0.96・scripts/kb-scene-rag-eval.ts）。例: --scene=検討中 --q="締めの一文"
//   2026-10-07 段（優先順位）: 並びに段の点（P0/P1 +0.05）。P0（絶対・最優先）は問いに関係する時、--scene でも上位 k の外の別枠「★」で先頭に出す。
//   --max-p=1 で P0〜P1（今の決まり）だけ。--no-pin で別枠を出さない（前と同じ形の出力）。段は app/lib/design-knowledge-priority.ts
//   旧の部分一致は --substring（問い24で recall@5 0.04 → 合わせ技 0.88・scripts/kb-rag-eval.ts）
//   2026-10-08 竹内「細かい部分も完全に理解できるまで落とし込む」「ちゃんと RAG で正確に確かめられるようにする」:
//     並べ方を当て直した（scripts/kb-eval.ts・新しい物差し 194問 recall@5 0.90→0.95・MRR 0.79→0.86）。出力に
//     ①行ごとの段・日付・置き換え（この行が退役させた古い行＝superseded_by）・要確認の上書きの候補（memory/rules_digest_review.md）
//     ②「本文の一節で当たった行」（上位に出ていない行の本文に問いの句がそのまま入っている物・長い決定の行の奥の一節）
//     ③ --id=<id の先頭8字> で1行を本文・根拠まで全部読む
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReplacedRows, searchKb, searchKbPinned } from "../app/lib/design-knowledge-rag-server";
import { effectivePriority, PRIORITY_LABEL } from "../app/lib/design-knowledge-priority";
import { formatHit, KB_SCENES, phraseSupplement, reviewSupersedePairs, type KbScene, type Scored } from "../app/lib/design-knowledge-rag";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const HELP = `設計知見を引く（読むだけ）
  npx tsx --env-file=.env.local scripts/kb.ts --q="自然文の問い" [--scene=<場面>] [--max-p=1] [--limit=8] [--full]
  npx tsx --env-file=.env.local scripts/kb.ts --id=<id の先頭8字>        … 1行を本文・根拠・状況まで全部読む
  npx tsx --env-file=.env.local scripts/kb.ts --tags=AIX [--limit=20]      … 札で新しい順（問いなし）
  --scene  ${Object.entries(KB_SCENES).filter(([k]) => k !== "other").map(([k, v]) => `${k}=${v.tag.replace("場面:", "")}`).join("・")}
  --max-p=1  P0〜P1（今の決まり）だけ ／ --no-pin  P0 の別枠を出さない ／ --substring  旧の部分一致

細部を確かめる時の引き方（2026-10-08 竹内「ちゃんと RAG で正確に確かめられるようにする」）
  1. 言い方を変えて 2〜3 回引く（症状で・決まりの言葉で・コード名やボタン名で）。1回目の上位だけで決めない
  2. 返信・AIX の作業なら --scene を付ける。決まりだけ見たい時は --max-p=1
  3. 当たった行は題だけで判断せず --id=<id8> か --full で本文まで読む（長い決定の行は細部が本文の奥にある）
     「本文の一節で当たった行」も読む（上位に出ない長い行の奥の一節）
  4. 食い違う行があれば: ★（P0）→ P1 の新しい決定 → 古い行 の順に従う。⚠ 要確認の上書きの候補が出た行は新しい方を正とし、報告に書く
  5. 3回引いても当たらない・行どうしが食い違って決まらない時は「設計知見に無い／決まっていない」と報告し、推測で埋めずに竹内さんに聞く
  6. 決まりを変えたら kb-insert で記録し、古い行は kb-retire（--by=新しい行）で退役する
  正確さの物差し: scripts/kb-eval.ts（問い → 当たるべき行・recall・MRR。新しい決定を入れたら scripts/kb-eval-set.ts に問いを足す）`;

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length <= 2) { console.log(HELP); process.exit(0); }
const tags = arg("tags").split(",").map((s) => s.trim()).filter(Boolean);
const q = arg("q");
const limit = Number(arg("limit", "10"));
const full = process.argv.includes("--full");
const sceneArg = arg("scene");
const scene = (Object.keys(KB_SCENES) as KbScene[]).find((k) => k === sceneArg || KB_SCENES[k].tag === sceneArg || KB_SCENES[k].tag === `場面:${sceneArg}`) ?? null;
if (sceneArg && !scene) { console.error(`場面が分かりません: ${sceneArg}（${Object.entries(KB_SCENES).map(([k, v]) => `${k}=${v.tag}`).join(" ")}）`); process.exit(1); }

/** 週の整理の要確認の「上書き」の組（古い id → 新しい id・新しい id → 古い id） */
function reviewPairs(): { newerOf: Map<string, string[]>; olderOf: Map<string, string[]> } {
  const f = join(process.cwd(), "memory", "rules_digest_review.md");
  const newerOf = new Map<string, string[]>(), olderOf = new Map<string, string[]>();
  if (!existsSync(f)) return { newerOf, olderOf };
  for (const p of reviewSupersedePairs(readFileSync(f, "utf8"))) {
    newerOf.set(p.oldId, [...(newerOf.get(p.oldId) ?? []), p.newId]);
    olderOf.set(p.newId, [...(olderOf.get(p.newId) ?? []), p.oldId]);
  }
  return { newerOf, olderOf };
}

async function printHits(list: Scored[], replaced: Awaited<ReturnType<typeof loadReplacedRows>>, rv: ReturnType<typeof reviewPairs>, titleOf: Map<string, string>) {
  for (const h of list) {
    console.log("\n" + formatHit(h));
    for (const o of replaced.get(h.row.id) ?? []) console.log(`  ↳ 置き換えた古い行: ${o.id.slice(0, 8)}「${o.title.slice(0, 50)}」（退役 ${String(o.retired_at ?? "").slice(0, 10)}${o.retired_reason ? `・${o.retired_reason.slice(0, 40)}` : ""}）`);
    for (const n of rv.newerOf.get(h.row.id) ?? []) console.log(`  ⚠ 要確認: 新しい行 ${n.slice(0, 8)}「${(titleOf.get(n) ?? "").slice(0, 40)}」がこの行を上書きした候補（週の整理の要確認・竹内さん未確認。食い違えば新しい方を優先して読む）`);
    for (const o of rv.olderOf.get(h.row.id) ?? []) console.log(`  ⚠ 要確認: この行が古い行 ${o.slice(0, 8)}「${(titleOf.get(o) ?? "").slice(0, 40)}」を上書きした候補（週の整理の要確認・竹内さん未確認。食い違えばこちらを優先して読む）`);
    if (full) { console.log(`  ${String(h.row.insight).slice(0, 4000)}`); if (h.row.rationale) console.log(`  --根拠-- ${String(h.row.rationale).slice(0, 2500)}`); }
  }
}

async function main() {
  const id8 = arg("id");
  if (id8) {
    // uuid に LIKE は使えない → 先頭8字の範囲で引く（全部の id でもよい）
    const h = id8.toLowerCase().replace(/[^0-9a-f-]/g, "");
    if (h.length < 8) { console.error("--id は id の先頭8字以上"); process.exit(1); }
    const lo = h.length >= 36 ? h : `${h.slice(0, 8)}-0000-0000-0000-000000000000`, hi = h.length >= 36 ? h : `${h.slice(0, 8)}-ffff-ffff-ffff-ffffffffffff`;
    const { data, error } = await sb.from("system_design_thinking").select("*").gte("id", lo).lte("id", hi).limit(3);
    if (error) { console.error(error.message); process.exit(1); }
    for (const d of (data ?? []) as Array<Record<string, unknown>>) {
      const p = effectivePriority(d as { title: string; insight: string; tags: string[] | null; priority?: number | null });
      console.log(`■ ${d.title}\n  ［${PRIORITY_LABEL[p]}・${String(d.created_at).slice(0, 10)}・${d.id}・${d.is_current ? "現行" : `退役（${String(d.retired_at ?? "").slice(0, 10)}・置き換え ${String(d.superseded_by ?? "なし").slice(0, 8)}・${d.retired_reason ?? ""}）`}］`);
      console.log(`  [札] ${((d.tags as string[]) ?? []).join(" / ")}`);
      console.log(`\n${d.insight}`);
      if (d.rationale) console.log(`\n--根拠-- ${d.rationale}`);
      if (d.context) console.log(`\n--状況-- ${d.context}`);
      if (d.applied_to) console.log(`\n--適用-- ${d.applied_to}`);
      const rep = await loadReplacedRows(sb, [String(d.id)]);
      for (const o of rep.get(String(d.id)) ?? []) console.log(`\n↳ 置き換えた古い行: ${o.id.slice(0, 8)}「${o.title}」（退役 ${String(o.retired_at ?? "").slice(0, 10)}）`);
    }
    if (!(data ?? []).length) console.log(`見つかりません: ${id8}`);
    return;
  }
  if (q && !process.argv.includes("--substring")) {
    const k = Number(arg("limit", "8"));
    const maxP = arg("max-p") === "" ? 3 : Number(arg("max-p"));
    const noPin = process.argv.includes("--no-pin");
    let pinned: Scored[] = [], hits: Scored[], all: Scored[] = [];
    if (noPin && maxP >= 3) { all = await searchKb(sb, q, { k: 10_000, tags, scene }); hits = all.slice(0, k); }
    else {
      const r = await searchKbPinned(sb, q, { k: maxP >= 3 ? k : 10_000, tags, scene });
      all = r.all;
      pinned = noPin ? [] : r.pinned;
      const rest = noPin ? [...r.pinned.map((s) => ({ ...s, pinned: false })), ...r.hits] : r.hits;
      hits = rest.filter((h) => (h.priority ?? 2) <= maxP).slice(0, k);
    }
    const shown = new Set([...pinned, ...hits].map((h) => h.row.id));
    const extra = phraseSupplement(all.filter((s) => (s.priority ?? 2) <= maxP), shown, q);
    const ids = [...pinned, ...hits, ...extra].map((h) => h.row.id);
    const replaced = await loadReplacedRows(sb, ids);
    const rv = reviewPairs();
    const titleOf = new Map(all.map((s) => [s.row.id, s.row.title]));
    if (pinned.length) console.log(`=== ★ 絶対・最優先（P0・どの場面でも先に守る）${pinned.length}件 ===`);
    await printHits(pinned, replaced, rv, titleOf);
    console.log(`${pinned.length ? "\n" : ""}=== 設計知見 ${hits.length}件（自然文: ${q}${tags.length ? "・札 " + tags.join("/") : ""}${scene ? "・" + KB_SCENES[scene].tag : ""}${maxP < 3 ? `・P${maxP} まで` : ""}）===`);
    await printHits(hits, replaced, rv, titleOf);
    if (extra.length) {
      console.log(`\n=== 本文の一節で当たった行 ${extra.length}件（上位に出ていないが、問いの句が本文にそのまま入っている・本文まで読む）===`);
      for (const h of extra) console.log(`\n${formatHit(h)}\n  一節: ${h.phrases.join("・")}`);
    }
    console.log(`\n（細部は --id=<id8> で本文まで読む。言い方を変えて2〜3回引く。見つからなければ「無い」と報告して竹内さんに聞く — --help）`);
    return;
  }
  let query = sb.from("system_design_thinking")
    .select("id, title, insight, rationale, tags, created_at, priority")
    .eq("is_current", true).order("created_at", { ascending: false }).limit(limit);
  if (tags.length) query = query.overlaps("tags", tags);
  if (q) query = query.or(`title.ilike.%${q}%,insight.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`=== 設計知見 ${data?.length ?? 0}件 (tags=${tags.join("/") || "なし"} q=${q || "なし"}) ===`);
  for (const d of data ?? []) {
    console.log(`\n■ ${d.title}  ［P${effectivePriority(d as { title: string; insight: string; tags: string[] | null; priority?: number | null })}・${String(d.created_at).slice(0, 10)}・${String(d.id).slice(0, 8)}］`);
    console.log(`  [tags] ${(d.tags as string[] ?? []).join(" / ")}`);
    console.log(`  ${String(d.insight).slice(0, full ? 4000 : 700)}`);
    if (full && d.rationale) console.log(`  --根拠-- ${String(d.rationale).slice(0, 2500)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
