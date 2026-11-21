// scripts/owner-feedback-check.ts — 竹内さんの指摘の型ごとの点検の入口（LLM なし・作業員N・2026-11-21・台帳 #472）
//
// 竹内さん 11/21「この俺の指摘のようなのをちゃんと理解して自己改善していく仕組みを作って」「設計知見と協力して」「試験の部分とも連携する」。
//   型ごとに「全分野で同じ穴が無いか」を見る。今ある物を使い回し、無かった4つの型（読めていない・物差し・細分化・把握）だけ新しく数える:
//     unread         … scripts/check-unread.ts（お客様が反応したこちらの画像・お客様の画像・物件確認した の物件名）
//     no_measure     … 連携の地図と台帳のスイッチのうち、scripts/ の台本に名前が1つも出ない物（ファイルと台帳だけ）
//     not_subdivided … 連携の地図の行のうち、埋め方（fill.src）が none の物＝どこから値が来るかが決まっていない（ファイルだけ）
//     left_off       … 台帳の built_off のまま7日以上（work-items の done-check と同じ線）
//     その他の型     … 今ある点検の名前を出すだけ（材料: delivery-check・find-brain-gaps／連携: linkage-watch／決まり: brain-unknowns／故障: ops-anomaly）
//   --write の時だけ書く: 見つけた穴を台帳へ（origin=found_gap・題で重ねない）・owner_pointers のその型の行に点検の日時と穴の数・events
//   --from=<指摘の id> … その指摘の型だけ回し、設計知見を引いて（kb.ts --q=引用 --max-p=1）行に id を残す。決まりが無ければ下書きを残す
//   実行: npx tsx --env-file=.env.local scripts/owner-feedback-check.ts [--all | --types=unread,no_measure] [--from=<id>] [--days=3] [--write]
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync } from "node:fs";
import { runTsx } from "./lib/self-improve-growth";
import { LINKAGE_MAP } from "../app/lib/linkage-map";
import { POINTER_KIND_JA, POINTER_KINDS, type PointerKind } from "../app/lib/owner-pointers";
import { checkUnread } from "./check-unread";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

export type Gap = { kind: PointerKind; title: string; detail: string };
type CheckOut = { kind: PointerKind; ran: string; gaps: Gap[]; note?: string };

const EXISTING: Partial<Record<PointerKind, string>> = {
  not_delivered: "app/lib/delivery-check.ts・scripts/find-brain-gaps.ts（G1）・app/lib/material-gap-weekly.ts",
  link_broken: "scripts/linkage-watch.ts（連携の地図）・audit-link-brain.ts・統括→書き手の欄ごとの届き（作業員L #466）",
  no_rule: "app/lib/brain-unknowns.ts・scripts/knowledge-gap-weekly.ts・owner_questions",
  no_grasp: "customer-fact-ledger（欄ごとの埋まり方の点検は次の段で作る）",
  exam: "試験の係（hazard-audit・exam-base-pin）",
  process: "毎朝の拾い上げ（#41）・毎週の見回り（30755ce9）",
  outage: "app/lib/ops-anomaly.ts（5分ごと）",
};

function scriptsText(): string {
  return readdirSync("scripts").filter((f) => f.endsWith(".ts")).map((f) => { try { return readFileSync(`scripts/${f}`, "utf8"); } catch { return ""; } }).join("\n");
}

async function checkUnmeasured(): Promise<CheckOut> {
  const txt = scriptsText();
  const { data } = await sb().from("work_items").select("switch_name").not("switch_name", "is", null).not("stage", "in", "(done,dropped)").limit(3000);
  const names = new Set<string>([...LINKAGE_MAP.flatMap((r) => r.switches ?? []), ...((data ?? []) as Array<{ switch_name: string }>).map((r) => r.switch_name)]);
  const un = [...names].filter((n) => /^[A-Z0-9_]{4,}$/.test(n) && !txt.includes(n)).sort();
  return { kind: "no_measure", ran: "scripts/ の台本の中のスイッチの名前", gaps: un.length ? [{ kind: "no_measure", title: `物差しが無いスイッチ ${un.length}個（scripts/ の台本に名前が出ない）`, detail: un.slice(0, 40).join(",") }] : [] };
}

/** 細分化が足りない（純関数の部分）: 1つの欄に複数の意味（同じ key を複数の行が使う・読む側が4つ以上）*/
export function multiMeaningKeys(rows: ReadonlyArray<{ id: string; key: string; readers: readonly string[] }>, minReaders = 4): Array<{ key: string; ids: string[]; readers: number }> {
  const byKey = new Map<string, { ids: string[]; readers: Set<string> }>();
  for (const r of rows) {
    const k = String(r.key ?? "").trim(); if (!k) continue;
    const v = byKey.get(k) ?? { ids: [], readers: new Set<string>() };
    v.ids.push(r.id); for (const x of r.readers ?? []) v.readers.add(x); byKey.set(k, v);
  }
  return [...byKey].filter(([, v]) => v.ids.length > 1 || v.readers.size >= minReaders).map(([key, v]) => ({ key, ids: v.ids, readers: v.readers.size })).sort((a, b) => b.ids.length - a.ids.length || b.readers - a.readers);
}

/**
 * 2026-11-21 芯② 細分化が足りない（統括役の頼み）: 今ある分（連携の地図の fill.src=none）に3つを足す
 *   a 場面や状態で分かれていない決まり … 設計知見の P0/P1 の現行の行で、札に「場面:」が1つも無い物
 *   b 1つの欄に複数の意味 … 連携の地図で同じ key を複数の行が使う・読む側が4つ以上の欄
 *   c 網に当たらない番が多い分け方 … 作業員M の申込までの地図の外れ（62/198 等）は M の台本の出力を読む（まだ置き場が無い＝note で出す）
 */
async function checkSubdivide(): Promise<CheckOut> {
  const rows = LINKAGE_MAP.filter((r) => r.fill?.src === "none");
  const byStage: Record<string, string[]> = {};
  for (const r of rows) (byStage[r.stage] = byStage[r.stage] ?? []).push(r.id);
  const gaps: Gap[] = Object.entries(byStage).map(([st, ids]) => ({ kind: "not_subdivided" as const, title: `連携の地図の段 ${st}: 値の来る所が決まっていない行 ${ids.length}`, detail: ids.join(",") }));
  const { data: kb } = await sb().from("system_design_thinking").select("id,title,tags,priority").eq("is_current", true).lte("priority", 1).limit(3000);
  const noScene = ((kb ?? []) as Array<{ id: string; title: string; tags: string[] | null; priority: number | null }>).filter((r) => !(r.tags ?? []).some((t) => t.startsWith("場面:")) && !(r.tags ?? []).includes("Chrome拡張")
    // 返信・AIX の決まりだけ（場面で分かれるべき物）。考え方・回し方の原則は場面に分けない
    && ((r.tags ?? []).some((t) => /^(?:AIX|line-reply|generate-reply|返信|内覧|見積書|申込|TPO)$/.test(t)) || /返信|AIX|内覧|見積|申込/.test(r.title)));
  if (noScene.length) gaps.push({ kind: "not_subdivided", title: `場面で分かれていない返信・AIX の決まり（P0/P1・札「場面:」なし）${noScene.length}行`, detail: noScene.slice(0, 20).map((r) => r.id.slice(0, 8)).join(",") });
  const mm = multiMeaningKeys(LINKAGE_MAP.map((r) => ({ id: r.id, key: String(r.key ?? ""), readers: r.readers ?? [] })));
  if (mm.length) gaps.push({ kind: "not_subdivided", title: `1つの欄に複数の意味の候補（同じ欄を複数の行が使う・読む側4つ以上）${mm.length}欄`, detail: mm.slice(0, 12).map((m) => `${m.key}（行 ${m.ids.length}・読む側 ${m.readers}）`).join("／") });
  return { kind: "not_subdivided", ran: "連携の地図（fill.src=none・同じ欄の複数の意味）・設計知見 P0/P1 の場面の札", gaps, note: "網に当たらない番の多い分け方（作業員M の地図の外れ）は M の台本の出力の置き場ができたら読む" };
}

async function checkLeftOff(): Promise<CheckOut> {
  const { data } = await sb().from("work_items").select("id,switch_name,updated_at").eq("stage", "built_off").limit(3000);
  const old = ((data ?? []) as Array<{ id: number; switch_name: string | null; updated_at: string }>).filter((r) => Date.now() - Date.parse(r.updated_at) >= 7 * 86_400_000);
  return { kind: "left_off", ran: "台帳の built_off のまま7日以上", gaps: old.length ? [{ kind: "left_off", title: `作った（off）のまま7日以上 ${old.length}行`, detail: old.slice(0, 40).map((r) => `#${r.id}${r.switch_name ? ":" + r.switch_name : ""}`).join(",") }] : [] };
}

async function checkUnreadOut(days: number): Promise<CheckOut> {
  const rows = await checkUnread(days);
  const gaps: Gap[] = rows.filter((r) => r.total > 0 && r.read < r.total).map((r) => ({ kind: "unread", title: `読めていない（${r.field}）${days}日: ${r.total - r.read}/${r.total}`, detail: `例 ${r.examples.join(",")}` }));
  return { kind: "unread", ran: `scripts/check-unread.ts（${days}日）`, gaps };
}

export async function runChecks(kinds: PointerKind[], days: number): Promise<CheckOut[]> {
  const out: CheckOut[] = [];
  for (const k of kinds) {
    if (k === "unread") out.push(await checkUnreadOut(days));
    else if (k === "no_measure") out.push(await checkUnmeasured());
    else if (k === "not_subdivided") out.push(await checkSubdivide());
    else if (k === "left_off") out.push(await checkLeftOff());
    else out.push({ kind: k, ran: "今ある点検", gaps: [], note: EXISTING[k] ?? "点検なし（other）" });
  }
  return out;
}

/** 設計知見を引く（kb.ts・LLM なし）。P0/P1 の行の id8 を返す */
function kbIdsFor(q: string): string[] {
  try {
    const outp = runTsx(["scripts/kb.ts", `--q=${q.slice(0, 120)}`, "--max-p=1", "--limit=3"], 90_000);
    return [...new Set([...outp.matchAll(/・([0-9a-f]{8})］/g)].map((m) => m[1]))].slice(0, 5);
  } catch { return []; }
}

/** 連携の地図の段・指摘の型 → 持ち主（統括役の割り振り 11/21）。決まらない物は統括役 */
export const STAGE_OWNER: Record<string, string> = {
  in: "作業員L", read: "作業員L", sent: "作業員L", next: "作業員L", bridge: "作業員L",
  writer: "作業員M", conductor: "作業員M", staff: "作業員M", check: "作業員H", tool_cond: "作業員K2", tool_rank: "作業員K2", tool_api: "作業員K2", tool_react: "作業員K2",
};
export const KIND_OWNER: Partial<Record<PointerKind, string>> = { unread: "作業員G", left_off: "統括役", no_measure: "統括役", exam: "作業員H", link_broken: "作業員L" };
export function gapOwnerOf(g: { kind: PointerKind; title: string }): string {
  const st = g.title.match(/連携の地図の段 ([a-z_]+):/)?.[1];
  if (st) return STAGE_OWNER[st] ?? "統括役";
  return KIND_OWNER[g.kind] ?? "統括役";
}

async function writeResults(outs: CheckOut[], fromId: number | null) {
  const db = sb();
  const now = new Date().toISOString();
  // 見つけた穴を台帳へ（題で重ねない・origin=found_gap）
  const { data: open } = await db.from("work_items").select("id,title").eq("origin", "found_gap").not("stage", "in", "(done,dropped)").limit(3000);
  const have = new Set(((open ?? []) as Array<{ title: string }>).map((r) => r.title.replace(/[0-9]+/g, "#")));
  const added: Record<string, number[]> = {};
  for (const o of outs) for (const g of o.gaps) {
    if (have.has(g.title.replace(/[0-9]+/g, "#"))) continue;
    // 2026-11-21 統括役: 持ち主・priority の空いた行を出さない（段・型から持ち主を決める・決まらない物は統括役へ）
    const owner = gapOwnerOf(g);
    const { data: ins } = await db.from("work_items").insert({ title: g.title, origin: "found_gap", stage: "todo", area: "指摘の点検", owner, priority: 10, next_step: `指摘の型「${POINTER_KIND_JA[g.kind]}」の点検で見つけた${fromId ? `（指摘 P${fromId}）` : ""}: ${g.detail.slice(0, 300)}` }).select("id").single();
    if (ins) { (added[o.kind] = added[o.kind] ?? []).push(ins.id); await db.from("work_item_events").insert({ item_id: ins.id, to_stage: "todo", actor: "owner-feedback-check", kind: "assign", note: `指摘の型 ${o.kind} の点検で足した・持ち主 ${owner}${fromId ? `（指摘 P${fromId}）` : ""}` }); }
  }
  // その型の指摘の行に点検の記録
  for (const o of outs) {
    let q = db.from("owner_pointers").select("id,state,work_item_ids").contains("kinds", [o.kind]).neq("state", "closed");
    if (fromId) q = q.eq("id", fromId);
    const { data: ps } = await q.limit(500);
    for (const p of (ps ?? []) as Array<{ id: number; state: string; work_item_ids: number[] }>) {
      const ids = [...new Set([...(p.work_item_ids ?? []), ...(added[o.kind] ?? [])])];
      await db.from("owner_pointers").update({ checked_at: now, checked_gaps: o.gaps.length, check_detail: { ran: o.ran, gaps: o.gaps.map((g) => g.title), note: o.note ?? null }, work_item_ids: ids, state: p.state === "received" ? "checked" : p.state, updated_at: now }).eq("id", p.id);
      await db.from("owner_pointer_events").insert({ pointer_id: p.id, kind: "check", from_state: p.state, to_state: p.state === "received" ? "checked" : null, actor: "owner-feedback-check", detail: { ran: o.ran, gaps: o.gaps.length, added: added[o.kind] ?? [] } });
    }
  }
  return added;
}

async function main() {
  const days = Number(arg("days", "3")) || 3;
  const fromId = arg("from") ? Number(arg("from")) : null;
  let kinds: PointerKind[] = flag("all") ? POINTER_KINDS.filter((k) => k !== "other") : (arg("types").split(",").filter((k) => (POINTER_KINDS as readonly string[]).includes(k)) as PointerKind[]);
  let pointer: { id: number; quote: string; kinds: PointerKind[] } | null = null;
  if (fromId) {
    const { data, error } = await sb().from("owner_pointers").select("id,quote,kinds").eq("id", fromId).single();
    if (error || !data) throw new Error(`指摘 P${fromId} が無い`);
    pointer = data as unknown as { id: number; quote: string; kinds: PointerKind[] };
    if (!kinds.length) kinds = pointer!.kinds.filter((k) => k !== "other");
  }
  if (!kinds.length) { console.log("使い方: --all ／ --types=unread,no_measure ／ --from=<指摘の id> [--days=3] [--write]"); return; }
  const outs = await runChecks(kinds, days);
  console.log(`指摘の型の点検（${kinds.length}型・${days}日${pointer ? `・指摘 P${pointer.id}` : ""}）`);
  for (const o of outs) {
    console.log(`- ${POINTER_KIND_JA[o.kind]}（${o.kind}）: ${o.ran}｜穴 ${o.gaps.length}${o.note ? `｜${o.note}` : ""}`);
    for (const g of o.gaps) console.log(`    ・${g.title}｜${g.detail.slice(0, 160)}`);
  }
  if (pointer) {
    const ids = kbIdsFor(pointer.quote);
    console.log(`設計知見（${pointer.quote.slice(0, 40)}）: ${ids.join(",") || "なし→下書きを残す"}`);
    if (flag("write")) await sb().from("owner_pointers").update(ids.length ? { kb_ids: ids } : { kb_draft: `竹内さんの決定（${new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 10).replace("-", "/")}）: ${pointer.quote.slice(0, 200)} — 型 ${pointer.kinds.map((k) => POINTER_KIND_JA[k]).join("・")}（P1 の下書き・統括役が読んで kb-insert）` }).eq("id", pointer.id);
  }
  if (flag("write")) { const added = await writeResults(outs, fromId); console.log(`書いた: 台帳に足した ${Object.values(added).flat().length}行 ${JSON.stringify(added)}`); }
}

if (process.argv[1]?.endsWith("owner-feedback-check.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
