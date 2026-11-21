// scripts/check-linkage.ts — 自己改善の芯 ③「連携が弱い」の点検（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳 #473）
//
// 竹内さん 11/21「足りていない土台を見つける・細分化が必要な物を細分化する・連携の弱い所を連携させる・統括の判断を強化する、を自己改善の仕組で特に強化すれば更に質が上がる」。
//   入力（今ある物を使い回す）:
//     連携の地図の見張り（作業員L の linkage-watch-server.runLinkageWatch）… 地図の行ごとに つながっている／切れている／親が off／空が多い／測れない
//       → 「作ったが届いていない」= 切れている・親が off・空が多い の行（物件選び↔LINE の bridge・tool_* の行＝作業員K2 の地図も同じ表にある）
//     統括→書き手（作業員L の scripts/audit-writer-linkage.ts --json）… 決めた事の欄ごとに 値のある番 → ①書き手に届いた → ②下書きに入った
//       → 「届いたが使われていない」= ①は届いたのに②に入らない割合
//   数: core:linkage = 地図のつながっている行 ÷ 測れた行（%）。欄の届き・使われも quality_daily へ（self-improve が入れる）。低い順に並べ、持ち主（地図の owner）を付ける。
// 実行: npx tsx --env-file=.env.local scripts/check-linkage.ts [--json]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkageWatch } from "../app/lib/linkage-watch-server";
import { LINKAGE_MAP } from "../app/lib/linkage-map";
import { runTsx, appealViaToolNow } from "./lib/self-improve-growth";
import { existsSync } from "node:fs";
import { inOriginMain } from "./check-foundation";

export type LinkWeak = { kind: "not_delivered" | "delivered_unused"; id: string; label: string; rate: number | null; owner: string; why: string };

/** 地図の行の結果と書き手の欄から、弱い所を低い順に（純関数） */
export function weakLinksOf(
  rows: ReadonlyArray<{ id: string; status: string; why: string; fill: number | null }>,
  fields: ReadonlyArray<{ key: string; label?: string; val: number; writerOk: number; inDraft: number }>,
  ownerOf: (id: string) => string,
): { score: number | null; measured: number; connected: number; weak: LinkWeak[]; noDenominator: Array<{ id: string; owner: string; why: string }> } {
  const measured = rows.filter((r) => r.status !== "unknown");
  const connected = measured.filter((r) => r.status === "connected").length;
  const weak: LinkWeak[] = [];
  for (const r of measured) if (r.status !== "connected") weak.push({ kind: "not_delivered", id: r.id, label: r.id, rate: r.fill == null ? null : Math.round(r.fill * 1000) / 10, owner: ownerOf(r.id), why: r.why });
  for (const f of fields) {
    if (!f.val) continue;
    const delivered = f.writerOk / f.val, used = f.writerOk ? f.inDraft / f.writerOk : 0;
    if (delivered < 0.5) weak.push({ kind: "not_delivered", id: `writer.${f.key}`, label: f.label ?? f.key, rate: Math.round(delivered * 1000) / 10, owner: "作業員L", why: `書き手の注記に届いた ${f.writerOk}/${f.val}` });
    else if (used < 0.5) weak.push({ kind: "delivered_unused", id: `writer.${f.key}`, label: f.label ?? f.key, rate: Math.round(used * 1000) / 10, owner: "作業員L", why: `届いたのに下書きに入らない（入った ${f.inDraft}/${f.writerOk}）` });
  }
  weak.sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1));
  // 穴の型②「記録に残らない（分母が無い）」（統括役 11/21）: 地図の行のうち、値のある番の数（分母）が取れない行＝status unknown（記録の欄が無い・見張りにつないでいない・読めない）
  const noDenominator = rows.filter((r) => r.status === "unknown").map((r) => ({ id: r.id, owner: ownerOf(r.id), why: r.why }));
  return { score: measured.length ? Math.round((connected / measured.length) * 1000) / 10 : null, measured: measured.length, connected, weak, noDenominator };
}

export async function checkLinkage() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const rep = await runLinkageWatch(sb);
  let fields: Array<{ key: string; label?: string; val: number; writerOk: number; inDraft: number }> = [];
  const out = join(tmpdir(), `writer-linkage-cl-${process.pid}.json`);
  try { runTsx(["scripts/audit-writer-linkage.ts", "--hours=24", "--max=60", `--json=${out}`], 180_000); fields = (JSON.parse(readFileSync(out, "utf8")).fields ?? []); } catch { /* 読めなければ地図だけ */ } finally { try { rmSync(out); } catch { /* 無し */ } }
  const owners = new Map(LINKAGE_MAP.map((r) => [r.id, r.owner ?? "-"]));
  const r = weakLinksOf(rep.results, fields, (id) => owners.get(id) ?? "-");
  // 物件オススメ → 売上サポ（AIX ツール）の連携（作業員K2 の発見・台帳 #479・竹内さん 11/21）: 通っていない物件は AIX がその物件を理解できない。7日で 90% に届かなければ弱い所
  const av = appealViaToolNow(7, (x) => existsSync(x) || inOriginMain(x));
  if (av && av.rate != null && av.rate < 90) {
    r.weak.push({ kind: "not_delivered", id: "appeal.via_tool", label: "物件オススメ→売上サポ（AIX ツール）", rate: av.rate, owner: "作業員K2", why: `オススメの物件のうち売上サポに同じ建物の行がある ${av.matched}/${av.n}（7日）・台帳 #479` });
    r.weak.sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1));
  }
  return r;
}

if (process.argv[1]?.endsWith("check-linkage.ts")) checkLinkage().then((r) => {
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
  console.log(`連携が弱い（地図のつながり ${r.score ?? "—"}%＝${r.connected}/${r.measured}・弱い所 ${r.weak.length}・低い順）`);
  console.log(`分母が無い（穴の型②・地図の行 ${r.noDenominator.length}）: ${r.noDenominator.map((x) => `${x.id}（${x.owner}）`).join("・") || "なし"}`);
  if (process.argv.includes("--write")) void (async () => {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const { data: open } = await sb.from("work_items").select("title").eq("origin", "found_gap").not("stage", "in", "(done,dropped)").limit(3000);
    const have = new Set(((open ?? []) as Array<{ title: string }>).map((x) => x.title));
    let added = 0;
    for (const x of r.noDenominator) {
      const title = `記録に残らない（分母が無い）: 連携の地図 ${x.id}`;
      if (have.has(title)) continue;
      // 今動いている作業員（K2・N・M・G・L・H）を先に・作業員K は K2 に（統括役 11/21）・もういない作業員だけなら統括役が配り直す
      const live = ["作業員K2", "作業員N", "作業員M", "作業員G", "作業員L", "作業員H"];
      const owner = x.owner.split("・").map((o) => (o === "作業員K" ? "作業員K2" : o)).find((o) => live.includes(o)) ?? "統括役";
      const { data: ins } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: "土台", owner, priority: 20, next_step: `check-linkage（穴の型②）: ${x.why.slice(0, 160)}・値のある番の数を数えられるように記録の欄か見張りをつなぐ（台帳 #505）` }).select("id").single();
      if (ins) { added++; await sb.from("work_item_events").insert({ item_id: (ins as { id: number }).id, to_stage: "todo", actor: "check-linkage", kind: "assign", note: `持ち主 ${owner}・#505 の子` }); }
    }
    console.log(`台帳に足した ${added}行`);
  })();
  for (const w of r.weak.slice(0, 25)) console.log(`- ${w.kind === "not_delivered" ? "届いていない" : "使われていない"}｜${w.label}｜${w.rate ?? "—"}%｜${w.owner}｜${w.why.slice(0, 90)}`);
}).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
