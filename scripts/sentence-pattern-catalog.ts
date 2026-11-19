// scripts/sentence-pattern-catalog.ts — 竹内さんの実送信から文型カタログ（役目×場面×状況の骨＋差し込み欄＋多数派と2番手の割合）を作る（LLM なし・費用0）
//   2026-11-12 作業員23（作業員24 の洗い出しの根B）。純関数は app/lib/sentence-pattern-catalog.ts。
//   材料（倉庫の外・exam-cache/anatomy-seven）: exemplar-bank.json（返信 181通・役目つき）・aix-texts.json（AIX 1通目）・aix-second-pairs.json（AIX 2通目の竹内さんの文）。
//     どれも集めた時に申込の門（turn-application-gate）を通してある。ここでも文に申込の書類・個人の値の印がある番は外す。
//     --gate を付けると、番の id（messages.id）で申込の門を DB から引き直して外す（夜 JST 22〜9時だけ・サーバーの鍵・sumora-ai-ui の ref を確かめる）
//   伏せ方は手本の表（takeuchi-exemplar-row）と同じ: 名前・物件名（seven-latent4 の part.property と文の「〇〇 703号室」）・号室・金額 等は差し込み欄 {…}。
//   2通以上で同じ骨だけ載せる（1通だけの言い方＝その人の文は載せない）。
//   出力: exam-cache/anatomy-seven/pattern-catalog.json（generate-reply は SENTENCE_PATTERN_CATALOG=on と SENTENCE_PATTERN_CATALOG_FILE で読む）・pattern-catalog.md（人が読む表）
// 実行: npx tsx scripts/sentence-pattern-catalog.ts [--dir=<anatomy-seven>] [--min=2] [--gate]（--gate は --env-file=.env.local と一緒に）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPatternCatalog, KIND_JA, OPENER_WORD_JA, type CatalogTurn, type CatalogAix, type PatternCatalog } from "../app/lib/sentence-pattern-catalog";
import { propertyNamesForBank, nightOnly } from "./takeuchi-exemplars-load";
import { propertyNameVariants, propertyNamesFromText, type BankEntry } from "../app/lib/takeuchi-exemplar-row";
import { applicationMaterialReason } from "../app/lib/test-pii-guard";
import { examplePiiReason } from "../app/lib/example-pii-guard";
import { KEEP_PROMISE_JA, REASON_JA } from "../app/lib/turn-anatomy-fields";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PROJECT_REF = "wfwsmwxakhyxobytszoq";

/** 文に申込の書類・個人の値の印がある（＝その番は載せない） */
export function staffTextBlocked(text: string): string | null {
  return applicationMaterialReason(text) ?? examplePiiReason(text)?.reason ?? null;
}

/** カタログの表（人が読む・骨と割合だけ） */
export function catalogMarkdown(cat: PatternCatalog): string {
  const L = [`# 竹内さんの文型カタログ（骨＝言い方の型・{…}＝材料の値の差し込み欄・2通以上の骨だけ）`, "", `作った時刻 ${cat.builtAt}・材料 ${JSON.stringify(cat.sources)}・載せる線 ${cat.minCount}通以上`, ""];
  L.push("## 受けの開口語（3分岐）", "| 分岐 | 通 | 竹内さんの開口語（多い順） | 決まりの語の割合 |", "|---|---|---|---|");
  for (const o of cat.opener) L.push(`| ${o.branch} | ${o.n} | ${o.words.map((w) => `${OPENER_WORD_JA[w.word]} ${Math.round(w.share * 100)}%`).join("・")} | ${OPENER_WORD_JA[o.expected]} ${Math.round(o.expectedShare * 100)}% |`);
  L.push("", "## 潜在の一文を言うか（9種）", "| 潜在の型 | 通 | 潜在の一文を書いた割合 | 事実を添えた割合 | 言う |", "|---|---|---|---|---|");
  for (const s of cat.latentSay) L.push(`| ${s.latent} | ${s.n} | ${Math.round(s.worryRate * 100)}% | ${Math.round(s.factRate * 100)}% | ${s.say ? "言う" : s.few ? "言わない（通が少ない）" : "言わない"} |`);
  L.push("", "## 継続の約束 {種類, 理由の事実}", "| 種類 | 通 | 理由の事実（「〜ので」の前） |", "|---|---|---|");
  for (const k of cat.keepPromise ?? []) L.push(`| ${KEEP_PROMISE_JA[k.kind]} | ${k.n} | ${k.reasons.map((r) => `${r.reason === "none" ? "理由なし" : REASON_JA[r.reason]} ${Math.round(r.share * 100)}%`).join("・")} |`);
  L.push("");
  for (const g of cat.groups) {
    L.push(`## ${KIND_JA[g.kind]}｜場面 ${g.scene}｜状況 ${g.situation}（${g.n}通・多数 ${Math.round(g.top * 100)}%・2番手 ${Math.round(g.second * 100)}%・載らない ${Math.round(g.other * 100)}%）`);
    for (const p of g.patterns) L.push(`- ${p.n}通（${Math.round(p.share * 100)}%）: ${p.skeleton}${p.slots.length ? `　欄 ${p.slots.join(" ")}` : ""}`);
    L.push("");
  }
  return L.join("\n");
}

async function gateExcluded(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const t = nightOnly();
  if (!t.ok) throw new Error(`--gate は夜だけ: ${t.reason}`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(PROJECT_REF) || !key) throw new Error("sumora-ai-ui の URL とサーバーの鍵が要る");
  const { createClient } = await import("@supabase/supabase-js");
  const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
  const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const msg = new Map<string, { conv: string; at: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at").in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>) msg.set(String(m.id), { conv: m.conversation_id, at: m.created_at });
  }
  const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
  for (const c of [...new Set([...msg.values()].map((m) => m.conv))]) { recs.set(c, await loadTurnApplicationRecords(sb, c)); await new Promise((r) => setTimeout(r, 120)); }
  for (const id of ids) { const m = msg.get(id); const r = m ? turnApplicationReason(recs.get(m.conv), m.at) : "通が見つからない"; if (r) out.set(id, r); }
  return out;
}

async function main() {
  const dir = resolve(arg("dir", join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven")));
  const bankPath = join(dir, "exemplar-bank.json");
  if (!existsSync(bankPath)) { console.log(`束が無い: ${bankPath}`); process.exitCode = 1; return; }
  const bank = JSON.parse(readFileSync(bankPath, "utf8")) as BankEntry[];
  const aixTexts = existsSync(join(dir, "aix-texts.json")) ? JSON.parse(readFileSync(join(dir, "aix-texts.json"), "utf8")) as Array<{ id: string; type: string; text: string }> : [];
  const pairs = existsSync(join(dir, "aix-second-pairs.json")) ? JSON.parse(readFileSync(join(dir, "aix-second-pairs.json"), "utf8")) as Array<{ scene: string; at: string; takeuchi: string; first?: string }> : [];
  // 物件名: 手本の表と同じ一覧＋AIX の本文の「🌟〇〇 203号室」
  const names = [...new Set([...propertyNamesForBank(bankPath, bank), ...propertyNameVariants(propertyNamesFromText([...aixTexts.map((a) => a.text), ...pairs.flatMap((p) => [p.takeuchi, p.first ?? ""])]))])].sort((a, b) => b.length - a.length);
  const gate = process.argv.includes("--gate") ? await gateExcluded([...bank.map((e) => e.id), ...aixTexts.map((a) => a.id)]) : new Map<string, string>();
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const turns: CatalogTurn[] = [];
  for (const e of bank) {
    if (gate.has(e.id)) { drop("申込の門"); continue; }
    const body = e.sentences.map((s) => s.text).join("\n");
    if (staffTextBlocked(body)) { drop("申込の書類・個人の値の印"); continue; }
    turns.push({ id: e.id, scene: e.scene, latent: e.latent, lead: e.lead, customer: e.customer, sentences: e.sentences.map((s) => ({ text: s.text, role: s.role })), fact: e.fact ?? null });
  }
  const aix: CatalogAix[] = [];
  for (const a of aixTexts) {
    if (gate.has(a.id)) { drop("申込の門"); continue; }
    if (!a.text || staffTextBlocked(a.text)) { drop("AIX: 空・申込の書類・個人の値の印"); continue; }
    aix.push({ id: a.id, button: a.type, part: "first", text: a.text });
  }
  pairs.forEach((p, i) => { if (!p.takeuchi || staffTextBlocked(p.takeuchi)) { drop("AIX 2通目: 空・申込の書類・個人の値の印"); return; } aix.push({ id: `pair-${i}-${p.at}`, button: p.scene, part: "second", text: p.takeuchi }); });
  const cat = buildPatternCatalog(turns, aix, { propertyNames: names, minCount: Number(arg("min", "2")) || 2 });
  writeFileSync(join(dir, "pattern-catalog.json"), JSON.stringify(cat, null, 1));
  writeFileSync(join(dir, "pattern-catalog.md"), catalogMarkdown(cat));
  console.log(`返信 ${turns.length}通・AIX ${aix.length}通（外した ${JSON.stringify(dropped)}${process.argv.includes("--gate") ? "" : "・申込の門は集めた時の物（--gate で引き直す）"}）→ 組 ${cat.groups.length}・物件名の言い方 ${names.length}個`);
  console.log(`受けの開口語: ${cat.opener.map((o) => `${o.branch} ${o.n}通→${OPENER_WORD_JA[o.expected]} ${Math.round(o.expectedShare * 100)}%`).join("・")}`);
  console.log(`潜在の一文を言う型: ${cat.latentSay.filter((s) => s.say).map((s) => s.latent).join("・")}／言わない: ${cat.latentSay.filter((s) => !s.say).map((s) => s.latent).join("・")}`);
}

if (process.argv[1] && /sentence-pattern-catalog\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
