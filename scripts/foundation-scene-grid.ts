// scripts/foundation-scene-grid.ts — 土台8つ × 返信の場面ごとに「決まりがあるか」「物差しがあるか」の表（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳 #464）
//
// 竹内さん「土台の部分もちゃんと具体的にするように細かく・徹底的に」（台帳 #464）。統括役の頼み: 8つの土台ごとに、場面ごとの決まりの有無と物差しの有無を表にし、無い所を持ち主つきで台帳へ。
//   決まり: 設計知見の現行の P0〜P2 で、場面の札（場面:〇〇・design-knowledge-rag の KB_SCENES）か題の場面の語が当たり、かつ土台の語が題・本文の頭に当たる行の数（0＝無い）
//   物差し: 土台の表（scripts/lib/foundation-table.ts）の台本のうち、場面で分けて数える物（SCENE_SPLIT）があれば「場面ごと」、台本はあるが場面で分けない物は「全体だけ」、無ければ「無い」
//   --write の時だけ、無い所を台帳に足す（origin=found_gap・持ち主は土台の表の持ち主・題で重ねない）
// 実行: npx tsx --env-file=.env.local scripts/foundation-scene-grid.ts [--write] [--json]
import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { KB_SCENES } from "../app/lib/design-knowledge-rag";
import { FOUNDATION_N } from "./lib/foundation-table";
import { inOriginMain } from "./check-foundation";

const SCENES = (Object.keys(KB_SCENES) as Array<keyof typeof KB_SCENES>).filter((k) => k !== "other");
/** 土台の語（題・本文の頭に当たれば、その土台の決まりと数える） */
export const FOUNDATION_TERMS: Record<string, RegExp> = {
  "n.flex": /臨機応変|型外|いつもと違う|決まりに当てない|聞き返/,
  "n.trust": /信頼|正直|伏せ|一つ一つに答え|言い切/,
  "n.feeling": /気持ち|潜在|不安|気がかり|迷い/,
  "n.appeal": /訴求|推す点|刺さ|オススメポイント|一押し/,
  "n.chrono": /時系列|いつ言った|日付|日をまたい|先ほど|鮮度/,
  "n.promise": /約束|期限|出来次第|果たし/,
  // 2026-11-21 作業員M: 要件は「確認事項・依頼ごと・約束が複数・要件ごと・turn_contract・asks」の語でも書かれている（網が狭かった）
  "n.asks": /要件|依頼ごと|一つ一つ|答え漏れ|複数の依頼|確認事項|約束が複数|要件ごと|turn_contract|asks/,
  "n.link": /つなぎ|誘導|次への|締め|誘い/,
};
/** 場面で分けて数える物差しの台本（それ以外は全体だけ） */
export const SCENE_SPLIT = new Set(["scripts/audit-off-pattern.ts", "scripts/tsunagi-census.ts", "scripts/audit-guide.ts", "scripts/audit-ask-route-takeuchi.ts"]); // audit-ask-route-takeuchi は 11/18 から場面ごと（作業員M）

/** 1つの土台×場面の決まりの数（純関数） */
export function rulesFor(rows: ReadonlyArray<{ title: string; insight: string | null; tags: string[] | null }>, term: RegExp, scene: { tag: string; titleRe: RegExp | null }): number {
  return rows.filter((r) => ((r.tags ?? []).includes(scene.tag) || (scene.titleRe ? scene.titleRe.test(r.title) : false)) && term.test(`${r.title} ${(r.insight ?? "").slice(0, 200)}`)).length;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const { data, error } = await sb.from("system_design_thinking").select("id,title,insight,tags,priority").eq("is_current", true).lte("priority", 2).limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; title: string; insight: string | null; tags: string[] | null; priority: number | null }>;
  // 2026-11-21 統括役の決め: 場面の札が無い P0/P1 の決まり（全部の場面に効く）は別の列「全場面」に数える（場面の札を後から付けると KB の札が増えて崩れるため）
  const sceneMatch = (r: { title: string; tags: string[] | null }) => SCENES.some((sk) => (r.tags ?? []).includes(KB_SCENES[sk].tag) || ((KB_SCENES[sk] as { titleRe: RegExp | null }).titleRe?.test(r.title) ?? false));
  const allSceneRows = rows.filter((r) => (r.priority ?? 9) <= 1 && !sceneMatch(r));
  const grid: Array<{ id: string; name: string; owner: string; measure: "場面ごと" | "全体だけ" | "無い"; cells: Record<string, number>; all: number }> = [];
  for (const f of FOUNDATION_N) {
    const term = FOUNDATION_TERMS[f.id];
    const ms = f.measures.filter((m) => existsSync(m) || inOriginMain(m));
    const measure = ms.some((m) => SCENE_SPLIT.has(m)) ? "場面ごと" : ms.length ? "全体だけ" : "無い";
    const cells: Record<string, number> = {};
    for (const s of SCENES) cells[s] = term ? rulesFor(rows, term, KB_SCENES[s] as { tag: string; titleRe: RegExp | null }) : 0;
    const all = term ? allSceneRows.filter((r) => term.test(`${r.title} ${(r.insight ?? "").slice(0, 200)}`)).length : 0;
    grid.push({ id: f.id, name: f.name, owner: f.owner, measure, cells, all });
  }
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ scenes: SCENES, grid })); return; }
  console.log(`| 土台 | 物差し | 全場面（P0/P1） | ${SCENES.map((s) => KB_SCENES[s].tag.replace("場面:", "")).join(" | ")} | 決まりの無い場面 |`);
  console.log(`|---|---|---|${SCENES.map(() => "---").join("|")}|---|`);
  for (const g of grid) {
    const none = SCENES.filter((s) => !g.cells[s]);
    console.log(`| ${g.name}（${g.owner}） | ${g.measure} | ${g.all || "—"} | ${SCENES.map((s) => String(g.cells[s] || (g.all ? "全" : "—"))).join(" | ")} | ${none.length}${none.length && g.all ? "（全場面の決まりあり）" : ""} |`);
  }
  if (process.argv.includes("--write")) {
    const { data: open } = await sb.from("work_items").select("title").eq("origin", "found_gap").not("stage", "in", "(done,dropped)").limit(3000);
    const have = new Set(((open ?? []) as Array<{ title: string }>).map((r) => r.title));
    let added = 0;
    for (const g of grid) {
      const none = SCENES.filter((s) => !g.cells[s]).map((s) => KB_SCENES[s].tag.replace("場面:", ""));
      const items: string[] = [];
      if (none.length) items.push(`土台「${g.name}」の場面ごとの決まりが無い（${none.join("・")}）${g.all ? "・全場面の決まりはある" : ""}`);
      if (g.measure !== "場面ごと") items.push(`土台「${g.name}」の物差しが${g.measure === "無い" ? "無い" : "場面で分かれていない（全体だけ）"}`);
      for (const title of items) {
        if (have.has(title)) continue;
        const owner = g.owner.split("・")[0] || "統括役";
        const { data: ins } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: "土台", owner, priority: 10, next_step: "台帳 #464（土台を場面ごとの決まり＋物差しまで細分化）の子・foundation-scene-grid で見つけた。決まりが無い場面は竹内さんの実送信で過半数の形を数えてから KB へ（割れたら推奨つきで竹内さんに）" }).select("id").single();
        if (ins) { added++; await sb.from("work_item_events").insert({ item_id: (ins as { id: number }).id, to_stage: "todo", actor: "foundation-scene-grid", kind: "assign", note: `持ち主 ${owner}・#464 の子` }); }
      }
    }
    console.log(`台帳に足した ${added}行`);
  }
}

if (process.argv[1]?.endsWith("foundation-scene-grid.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
