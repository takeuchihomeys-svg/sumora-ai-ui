// scripts/compose-trust-repeat-night.ts — 信頼の言い回しのくり返しを数える（同じ会話で、竹内さんの信頼の文の骨が直前3通のこちらの文にもあったか）（LLM なし・DB は読むだけ・夜だけ）
//   2026-11-12 作業員23（統括役: 「信頼の言い回しのくり返しの数え（conversation_id を軽く読む）は今夜 22時以降に費用0で」）。
//   束（exemplar-bank 181通・申込の門を通した番）の信頼の文（trust・barrier）の骨を、同じ会話のその番より前のこちらの送信3通（AIX を含む）の文の骨と比べる。
//   軽く: 番の id → messages（100件ずつ）・会話ごとに1回（その番の時刻より前・こちらの送信・新しい順 3通）。間を 150ms 空ける。JST 9〜22時は止まる。
//   出力は数だけ（文は出さない）: くり返した番の割合と、くり返した骨の上位（骨＝名前・物件名は差し込み欄）
// 実行: npx tsx --env-file=.env.local scripts/compose-trust-repeat-night.ts [--dir=<anatomy-seven>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { skeletonize, skeletonKey } from "../app/lib/sentence-pattern-catalog";
import { splitSentences } from "../app/lib/takeuchi-anatomy-roles";
import { nightOnly, propertyNamesForBank } from "./takeuchi-exemplars-load";
import type { BankEntry } from "../app/lib/takeuchi-exemplar-row";

const PROJECT_REF = "wfwsmwxakhyxobytszoq";
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

/** 信頼の文の骨が、前のこちらの文（骨の集まり）にあるか（純関数） */
export function repeatedTrust(trustKeys: ReadonlyArray<string>, prevKeys: ReadonlySet<string>): string[] {
  return trustKeys.filter((k) => k.length >= 8 && prevKeys.has(k));
}

async function main() {
  const t = nightOnly();
  if (!t.ok) { console.log(`止めた: ${t.reason}`); return; }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(PROJECT_REF) || !key) { console.log("sumora-ai-ui の URL とサーバーの鍵が要る"); process.exitCode = 1; return; }
  const dir = resolve(arg("dir", join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven")));
  const bankPath = join(dir, "exemplar-bank.json");
  if (!existsSync(bankPath)) { console.log(`束が無い: ${bankPath}`); process.exitCode = 1; return; }
  const bank = JSON.parse(readFileSync(bankPath, "utf8")) as BankEntry[];
  const pn = propertyNamesForBank(bankPath, bank);
  const sk = (s: string) => skeletonKey(skeletonize(s, pn).skeleton);
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const withTrust = bank.filter((e) => e.sentences.some((s) => s.role === "trust" || s.role === "barrier"));
  const msg = new Map<string, { conv: string; at: string }>();
  const ids = withTrust.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at").in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>) msg.set(String(m.id), { conv: m.conversation_id, at: m.created_at });
    await sleep(150);
  }
  let n = 0, rep = 0;
  const topRep = new Map<string, number>();
  for (const e of withTrust) {
    if (!nightOnly().ok) { console.log("途中で営業時間に入った＝止める"); break; }
    const m = msg.get(e.id);
    if (!m) continue;
    const { data, error } = await sb.from("messages").select("text").eq("conversation_id", m.conv).neq("sender", "customer").lt("created_at", m.at).order("created_at", { ascending: false }).limit(3);
    await sleep(150);
    if (error) continue;
    n++;
    const prev = new Set(((data ?? []) as Array<{ text: string | null }>).flatMap((x) => splitSentences(x.text ?? "")).map(sk));
    const hits = repeatedTrust(e.sentences.filter((s) => s.role === "trust" || s.role === "barrier").map((s) => sk(s.text)), prev);
    if (hits.length) { rep++; for (const h of hits) topRep.set(h, (topRep.get(h) ?? 0) + 1); }
  }
  const out = { at: new Date().toISOString(), turns: n, repeated: rep, rate: n ? Math.round((rep / n) * 100) / 100 : 0, top: [...topRep.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([skeleton, c]) => ({ skeleton, n: c })) };
  writeFileSync(join(dir, "compose-trust-repeat.json"), JSON.stringify(out, null, 1));
  console.log(`信頼の文のある番 ${n}通のうち、直前3通のこちらの文と同じ骨を使った番 ${rep}通（${Math.round(out.rate * 100)}%）`);
  for (const x of out.top) console.log(`  ${x.n}通: ${x.skeleton}`);
}

if (process.argv[1] && /compose-trust-repeat-night\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
