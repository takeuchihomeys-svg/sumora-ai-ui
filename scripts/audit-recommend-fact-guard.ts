// scripts/audit-recommend-fact-guard.ts — AIX【物件オススメ】1通目の事実の確かめ（recommend-fact-guard）を、竹内さん・スタッフの実送信と比べる（影の運用の物差し）
// 実行: LLM_TEST_HARNESS_GUARD=off npx tsx --env-file=.env.local scripts/audit-recommend-fact-guard.ts [--days=21] [--limit=40] [--cache=<json>] [--no-read]
//
// 2026-10-17 竹内さん「順に改善おねがい」①: 「書かないと判断した数・誤って落とす数」を測ってから既定を決める。
//   ・対象: aix_generate_log の property_recommendation（🌟で始まる1通目）× 同じ会話で直後に送った 🌟 の実送信 × 送った資料の画像（sent_image_properties.source=aix:property_recommendation）
//   ・資料の画像を台帳（image-read-ledger・DeepSeek 書き写し1回＋文字2回・1枚 約$0.003）で読み、生成文に確かめを掛ける
//   ・判定ごとに実送信と比べる: 実送信に同じ主張が残った＝スタッフは直さなかった（落とす・直すなら「誤り候補」）／消えた・直った＝スタッフも直した
//   ・読んだ台帳は --cache の JSON に残し、2回目は読まない（個人情報なし・物件の資料の写しだけ。倉庫には上げない＝scratchpad に置く）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadOrReadLedger, ledgerFromStored, type ImageLedger } from "../app/lib/image-read-ledger";
import { checkFirstMessageFacts, applyFactDecisions, claimsInFirstMessage, parseLedgerFacts } from "../app/lib/recommend-fact-guard";
import { loadStationGeo, addressWardOf } from "../app/lib/recommend-fact-guard-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "21"));
const limit = Number(arg("limit", "40"));
const cachePath = arg("cache", "");
const noRead = process.argv.includes("--no-read");
const cache: Record<string, unknown> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

type Row = { created_at: string; conversation_id: string; generated_text: string };
(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: logs } = await sb.from("aix_generate_log").select("created_at, conversation_id, generated_text")
    .eq("action_type", "property_recommendation").gte("created_at", since).order("created_at", { ascending: false }).limit(400);
  const cand = ((logs ?? []) as Row[]).filter((l) => l.conversation_id && (l.generated_text ?? "").trim().startsWith("🌟"));
  const tally: Record<string, Record<string, number>> = {};
  const add = (k: string, v: string) => { tally[k] = tally[k] ?? {}; tally[k][v] = (tally[k][v] ?? 0) + 1; };
  const examples: string[] = [];
  let used = 0, noImage = 0, noSent = 0, readFail = 0;
  const seen = new Set<string>();
  for (const l of cand) {
    if (used >= limit) break;
    const t = Date.parse(l.created_at);
    const { data: sent } = await sb.from("messages").select("text, created_at").eq("conversation_id", l.conversation_id).eq("sender", "staff")
      .gte("created_at", new Date(t - 5 * 60_000).toISOString()).lte("created_at", new Date(t + 60 * 60_000).toISOString()).order("created_at").limit(30);
    const sentText = ((sent ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").find((x) => x.trim().startsWith("🌟"));
    if (!sentText) { noSent++; continue; }
    const { data: sip } = await sb.from("sent_image_properties").select("image_url, created_at").eq("conversation_id", l.conversation_id).eq("source", "aix:property_recommendation")
      .gte("created_at", new Date(t - 5 * 60_000).toISOString()).lte("created_at", new Date(t + 60 * 60_000).toISOString()).order("created_at").limit(1);
    const url = (sip?.[0] as { image_url?: string } | undefined)?.image_url;
    if (!url) { noImage++; continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    let ledger: ImageLedger | null = cache[url] ? ledgerFromStored(cache[url]) : null;
    if (ledger) ledger = { ...ledger, facts: parseLedgerFacts(ledger.transcript) };
    if (!ledger && !noRead) {
      ledger = await loadOrReadLedger(url, {});
      if (ledger && cachePath) { cache[url] = ledger; writeFileSync(cachePath, JSON.stringify(cache)); }
    }
    if (!ledger) { readFail++; continue; }
    used++;
    const { data: pk } = await sb.from("property_pickups").select("property_name, pdf_text").eq("conversation_id", l.conversation_id)
      .gte("created_at", new Date(t - 3 * 86400_000).toISOString()).lte("created_at", new Date(t).toISOString()).limit(50);
    const geo = await loadStationGeo(sb as never, l.generated_text);
    const material = ((pk ?? []) as Array<{ property_name: string | null; pdf_text: string | null }>)
      .filter((r) => r.property_name && l.generated_text.includes(r.property_name.slice(0, 4))).map((r) => `${r.property_name}\n${r.pdf_text ?? ""}`).join("\n");
    const ds = checkFirstMessageFacts({ message: l.generated_text, ledger: ledger.facts, materialText: material || null, geo, addressWard: addressWardOf(ledger.facts, material) });
    const sentClaims = claimsInFirstMessage(sentText);
    for (const d of ds) {
      const kept = sentText.includes(d.claim);
      const staffFixedTo = d.to ? sentText.includes(d.to) : false;
      // 実送信に同じ種類の主張が何か残っているか（言い換えて残した）
      const sameKind = sentClaims.some((c) => c.kind === d.kind);
      const outcome = kept ? "スタッフはそのまま送った" : staffFixedTo ? "スタッフも同じに直した" : sameKind ? "スタッフは別の形で書いた" : "スタッフは消した";
      add(`${d.kind}:${d.verdict}`, outcome);
      if (d.verdict !== "ok" && examples.length < 40) examples.push(`${l.created_at.slice(0, 10)} ${l.conversation_id.slice(0, 8)} ${d.kind}:${d.verdict} 「${d.claim}」→${d.to ?? "落とす"}｜${d.why}｜${outcome}`);
    }
    const onText = applyFactDecisions(l.generated_text, ds, { exit: true, mode: "on" }).text;
    add("全体", onText === l.generated_text ? "変更なし" : "変更あり");
  }
  console.log(JSON.stringify({ candidates: cand.length, used, noSent, noImage, readFail }, null, 1));
  for (const [k, v] of Object.entries(tally).sort()) console.log(k.padEnd(24), JSON.stringify(v));
  console.log("\n--- 例（ok 以外）");
  for (const e of examples) console.log(e);
})();
