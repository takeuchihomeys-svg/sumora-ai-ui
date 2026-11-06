// scripts/exam-near-resolve.ts — 試験が残した「鍵が要る読み」（近い竹内さんの番）を、鍵のある env で読み、決めた欄だけに絞って試験の写しに控える
//
// 2026-11-07 統括役の決め B（作業員9: 近い番の ids・keep の真偽の数／作業員4: 近い番ごとの竹内さんの一手）:
//   試験は公開キーで動き、match_conductor_focus・match_conductor_turns・takeuchi_compose_examples・conductor_turn_vectors は 42501／空になる。
//   DDL も anon への許可も足さない。試験の中では頼みを <置き場>/db-snapshot/<日>/pending/ に残すだけ（scripts/lib/exam-frozen-input.ts ③）。
//   この台本が頼みを鍵で読み、reduceKeyedBody で欄を絞って同じ鍵の控え（k-<鍵>.json）に書く＝次の試験（同じ写しの日）は控えを返す。
//   残す欄: 近い番の id・場面・重点・距離・時刻・竹内さんの一手（AIX の種類・道・型・ピッカーの名前）・keep の真偽。本文は残さない。
//   要約は一番近い番（頼みの in の最初）だけ、お客様の行60字・PII の伏せ・申込の書類以降の番は入れない（11/07 統括役の決め・作業員4）。
//   写しは exam-cache（この PC の中だけ・git にも tsc-remote の上げにも入らない）。
//
// 実行（鍵のある env を読む・鍵は写さない・値は出さない・夜に）:
//   npx tsx --env-file="<鍵のある env のパス>" scripts/exam-near-resolve.ts [--day=YYYY-MM-DD] [--dry]
//   --day を省くと pending のある日を全部。LLM は呼ばない（DB を読むだけ・頼み1つにつき1回）
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { reduceKeyedBody, nearestSummaryOf, afterCutoff } from "./lib/exam-frozen-input";
import { createClient } from "@supabase/supabase-js";
import { loadDeepseekCutoff } from "../app/lib/post-apply";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DRY = argv.includes("--dry");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が要る（--env-file で鍵のある env を読む）"); process.exit(1); }

(async () => {
  const root = join(examCacheRoot(), "db-snapshot");
  const days = arg("day") ? [arg("day")] : (existsSync(root) ? readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(root, d, "pending"))) : []);
  let ok = 0, fail = 0, rows = 0;
  for (const day of days) {
    const pdir = join(root, day, "pending");
    if (!existsSync(pdir)) continue;
    for (const f of readdirSync(pdir).filter((x) => x.endsWith(".json"))) {
      const req = JSON.parse(readFileSync(join(pdir, f), "utf8")) as { name: string; url: string; method: string; body: string };
      // 頼みの URL は試験の env の DB（同じ DB）。鍵だけ差し替える（公開キーの印は送らない）
      const target = new URL(req.url); const base = new URL(url);
      if (target.host !== base.host) { console.warn(`  別の DB の頼みは読まない: ${f}`); fail++; continue; }
      if (DRY) { console.log(`  （dry）${day} ${req.name} ${f}`); continue; }
      try {
        const res = await fetch(req.url, { method: req.method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, ...(req.method.toUpperCase() === "POST" ? { body: req.body } : {}) });
        if (!res.ok) { console.warn(`  読めない ${req.name}: ${res.status}`); fail++; continue; }
        const raw = await res.text();
        let situations: Record<string, string> = {};
        if (req.name === "conductor_turn_vectors") {
          const first = decodeURIComponent(req.url).match(/source_key=in\.\(([^,)]+)/)?.[1]?.replace(/^"|"$/g, "") ?? null;
          if (first) {
            const sb = createClient(url, key);
            const { data } = await sb.from("conductor_turn_vectors").select("source_key, turn_at, situation, conversation_id").eq("source_key", first).maybeSingle();
            const row = data as { source_key: string; turn_at: string; situation: string | null; conversation_id: string | null } | null;
            if (row && !afterCutoff(row.turn_at, await loadDeepseekCutoff(sb as never, row.conversation_id))) { const sum = nearestSummaryOf(row.situation); if (sum) situations = { [row.source_key]: sum }; }
          }
        }
        const reduced = reduceKeyedBody(req.name, raw, situations);
        const out = join(root, day, f);
        mkdirSync(join(root, day), { recursive: true });
        const tmp = `${out}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ status: 200, contentType: "application/json", contentRange: null, body: reduced, at: new Date().toISOString(), table: req.name }));
        renameSync(tmp, out);
        unlinkSync(join(pdir, f));
        ok++; rows += (JSON.parse(reduced) as unknown[]).length;
      } catch (e) { console.warn(`  失敗 ${req.name}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); fail++; }
    }
  }
  console.log(`鍵が要る読みの控え: 書いた ${ok}・行 ${rows}・読めない ${fail}（日 ${days.join(",") || "なし"}）${DRY ? "（dry）" : ""}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
