// scripts/compose-elements-read.ts — 文の要素4つ（つなぎ・押さえ方・信頼の作り方・潜在の不安）の型を竹内さんの実送信から数える（LLM なし・DB なし・費用0）
//   2026-11-12 作業員23（KB 2301dbf1）。純関数は app/lib/compose-elements.ts。
//   材料（倉庫の外・exam-cache/anatomy-seven）: exemplar-bank.json（181通・1文ずつの役目・申込の門を通した物）・seven-all198.json（7つの欄の読み）・seven-latent4*.json（潜在の4つ）。
//   伏せ方は手本の表・文型カタログと同じ（名前・物件名・号室・金額 等は差し込み欄）。文に申込の書類・個人の値の印がある番は外す。
//   出力: exam-cache/anatomy-seven/compose-elements.json（generate-reply は COMPOSE_ELEMENTS=on と COMPOSE_ELEMENTS_FILE で読む）・compose-elements.md（人が読む表）
// 実行: npx tsx scripts/compose-elements-read.ts [--dir=<anatomy-seven>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildComposeElements, BRIDGE_JA, PRESS_JA, TRIGGER_JA, CUSTOMER_KIND_JA, type ElemTurn, type ComposeElements } from "../app/lib/compose-elements";
import { buildPatternCatalog } from "../app/lib/sentence-pattern-catalog";
import { propertyNamesForBank } from "./takeuchi-exemplars-load";
import { staffTextBlocked } from "./sentence-pattern-catalog";
import type { BankEntry } from "../app/lib/takeuchi-exemplar-row";
import type { TrustMethod } from "../app/lib/takeuchi-seven-read";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function elementsMarkdown(ce: ComposeElements): string {
  const L = [`# 竹内さんの文の要素の型（つなぎ・押さえ方・信頼の作り方・潜在の不安）`, "", `作った時刻 ${ce.builtAt}・材料 ${ce.n}通（竹内さん本人・申込の手前）・型にする線＝過半数（>50%）かつ5通以上`, ""];
  const head = (title: string) => L.push(`## ${title}`, "| 型 | 件数 | 型にするか | 多い形（割合） | 他の欄 | なぜ（竹内さんの読み） | 実物1通（骨） |", "|---|---|---|---|---|---|---|");
  const row = (name: string, t: ComposeElements["types"][number]) => L.push(`| ${name} | ${t.n} | ${t.fixed ? "型にする" : "型にしない"} | ${t.forms.slice(0, 3).map((f) => `${f.form} ${pct(f.share)}`).join("・")} | ${Object.entries(t.detail).map(([k, v]) => `${k}: ${v.slice(0, 3).map((f) => `${f.form} ${pct(f.share)}`).join("・")}`).join("／")} | ${(t.why ?? "").replace(/\|/g, "/")} | ${(t.example ?? "").replace(/\|/g, "/")} |`);
  head("1 つなぎ（前の文→次の文・次の文の頭の言い方）");
  for (const t of ce.types.filter((x) => x.element === "bridge").sort((a, b) => b.n - a.n)) row(BRIDGE_JA[t.key as keyof typeof BRIDGE_JA] ?? t.key, t);
  L.push(""); head("2 押さえ方（要点ごと・添える事実＝最初の事実／置き場所／強さ）");
  for (const t of ce.types.filter((x) => x.element === "press")) { const [k0, ck] = t.key.split("@"); row(`${PRESS_JA[k0 as keyof typeof PRESS_JA] ?? k0}${ck ? `＠${CUSTOMER_KIND_JA[ck as keyof typeof CUSTOMER_KIND_JA]}` : ""}`, t); }
  L.push(""); head("3 信頼の作り方（手がかりごと・信頼の文の骨の幅）");
  for (const t of ce.types.filter((x) => x.element === "trust").sort((a, b) => b.n - a.n)) row(t.key, t);
  L.push(""); head("3’ 押す強さの上限（場面×お客様の文の種類・代表＝中央・上限＝8割がこれ以下）");
  for (const t of ce.types.filter((x) => x.element === "push").sort((a, b) => b.n - a.n)) row(t.key, t);
  L.push("", `同じ言い回しを続けない決まりの案: ${ce.trustRepeat.rule}`, `数え方: ${ce.trustRepeat.measured}`, "");
  head("4 潜在の不安（言う型: 手がかり／添える事実／置き場所）");
  for (const t of ce.types.filter((x) => x.element === "latent")) row(t.key, t);
  L.push("", "### 言わない型（数で）", "| 潜在の型 | 通 | 潜在の一文を書いた | 理由 |", "|---|---|---|---|");
  for (const x of ce.latentNo) L.push(`| ${x.latent} | ${x.n} | ${x.wrote}（${pct(x.rate)}） | ${x.why} |`);
  L.push("", `手がかりの名前: ${Object.entries(TRIGGER_JA).map(([k, v]) => `${k}=${v}`).join("・")}`);
  return L.join("\n");
}

function main() {
  const dir = resolve(arg("dir", join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven")));
  const bankPath = join(dir, "exemplar-bank.json");
  if (!existsSync(bankPath)) { console.log(`束が無い: ${bankPath}`); process.exitCode = 1; return; }
  const bank = JSON.parse(readFileSync(bankPath, "utf8")) as BankEntry[];
  type Seven = { id: string; reads: Array<{ trust_how?: string[]; push?: { push: boolean; strength: "strong" | "mid" | "weak" | null }; latent?: { fact?: string } | null } | null> };
  const seven = new Map((existsSync(join(dir, "seven-all198.json")) ? JSON.parse(readFileSync(join(dir, "seven-all198.json"), "utf8")) as Seven[] : []).map((o) => [o.id, o.reads[0]]));
  type L4 = { id: string; reads: Array<{ trigger?: { kind?: string } } | null> };
  const l4 = new Map(["seven-latent4.json", "seven-latent4b.json"].flatMap((f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) as L4[] : [])).map((o) => [o.id, o.reads[0]]));
  const turns: ElemTurn[] = [];
  let blocked = 0;
  for (const e of bank) {
    if (staffTextBlocked(e.sentences.map((s) => s.text).join("\n"))) { blocked++; continue; }
    const s7 = seven.get(e.id);
    turns.push({
      id: e.id, scene: e.scene, lead: e.lead, latent: e.latent, customer: e.customer,
      sentences: e.sentences.map((s) => ({ text: s.text, role: s.role, why: s.why })),
      trustHow: (s7?.trust_how ?? []) as TrustMethod[], push: s7?.push ?? null,
      trigger: l4.get(e.id)?.trigger?.kind ?? null, latentFact: s7?.latent?.fact ?? null,
    });
  }
  const names = propertyNamesForBank(bankPath, bank);
  // 言う／言わないは文型カタログと同じ計算（単一の出所）
  const cat = buildPatternCatalog(turns.map((t) => ({ id: t.id, scene: t.scene, latent: t.latent, lead: t.lead, customer: "", sentences: t.sentences, fact: t.latentFact })), [], { propertyNames: names });
  const ce = buildComposeElements(turns, { propertyNames: names, latentSay: cat.latentSay.filter((x) => x.say).map((x) => x.latent) });
  writeFileSync(join(dir, "compose-elements.json"), JSON.stringify(ce, null, 1));
  writeFileSync(join(dir, "compose-elements.md"), elementsMarkdown(ce));
  const fx = (el: string) => ce.types.filter((t) => t.element === el);
  console.log(`材料 ${turns.length}通（外した ${blocked}）・物件名の言い方 ${names.length}個`);
  for (const el of ["bridge", "press", "trust", "latent"]) console.log(`${el}: 型にする ${fx(el).filter((t) => t.fixed).map((t) => `${t.key}(${t.n})`).join("・") || "なし"}／型にしない ${fx(el).filter((t) => !t.fixed).map((t) => `${t.key}(${t.n})`).join("・") || "なし"}`);
}

if (process.argv[1] && /compose-elements-read\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) main();
