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
//   npx tsx --env-file="<鍵のある env のパス>" scripts/exam-near-resolve.ts [--day=YYYY-MM-DD] [--dry] [--backfill（もう控えた RPC の答えからも後ろの読みを作る）]
//   --day を省くと pending のある日を全部。LLM は呼ばない（DB を読むだけ・頼み1つにつき1回）
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { reduceKeyedBody, nearestSummaryOf, afterCutoff, keyedKey } from "./lib/exam-frozen-input";
import { followupUrls } from "./lib/exam-near-followups";
import { loadCards, CARDS_FILE, RAG_DIR } from "./lib/exam-rag-store";
import { nearLeak, LEAK_STOP_FILE, isUnsafeNearRequest } from "./lib/exam-near-hook";
import { YUMA_CONVERSATION_ID, NO_LINE_TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
const TEST_CONV_IDS = [YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS];
const stalePendingAllowed = () => (process.env.EXAM_NEAR_STALE_PENDING ?? "").trim().toLowerCase() === "allow";
import { createClient } from "@supabase/supabase-js";
import { loadDeepseekCutoff } from "../app/lib/post-apply";
import { pickOriginRow, originBody, originEligible, originScope, originInScope } from "./lib/exam-near-origin";
import { readGateExcluded } from "./lib/exam-application-gate";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DRY = argv.includes("--dry");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が要る（--env-file で鍵のある env を読む）"); process.exit(1); }

const HEADERS = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };

/** 1つの読みを鍵で読み、欄を絞って控える。書いた行の配列（絞った後）を返す。読めなければ null */
async function resolveOne(day: string, fileName: string, req: { name: string; url: string; method: string; body: string }, root: string): Promise<Array<Record<string, unknown>> | null> {
  const res = await fetch(req.url, { method: req.method, headers: HEADERS, ...(req.method.toUpperCase() === "POST" ? { body: req.body } : {}) });
  if (!res.ok) { console.warn(`  読めない ${req.name}: ${res.status}`); return null; }
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
  // 2026-11-10 作業員8（D3 漏れの番人）: 近い番の答えに元の番そのもの（距離 0.01 未満）か元の番より後の番があれば、控えを書かずに係を止める印を置く
  //   （11/10 17:26Z に古い作業ツリーの試験の頼みから q367 の答えの番そのもの〔距離 8e-7〕が控えに入った）。止める: EXAM_NEAR_LEAK_GUARD=off
  if ((process.env.EXAM_NEAR_LEAK_GUARD ?? "").trim().toLowerCase() !== "off") {
    let rowsOut: Array<Record<string, unknown>> = []; try { rowsOut = JSON.parse(reduced) as Array<Record<string, unknown>>; } catch { /* */ }
    const lk = nearLeak(req.name, req.body, rowsOut);
    if (lk.leak) {
      const stop = join(examCacheRoot(), "exam-queue", LEAK_STOP_FILE);
      let cur: { at?: string; hits?: unknown[] } = {}; try { cur = JSON.parse(readFileSync(stop, "utf8")); } catch { /* 初めて */ }
      const hits = [...(Array.isArray(cur.hits) ? cur.hits : []), { at: new Date().toISOString(), day, file: fileName, table: req.name, close: lk.close, after: lk.after }].slice(-50);
      writeFileSync(stop, JSON.stringify({ at: cur.at ?? new Date().toISOString(), why: "近い番の答えに元の番（距離 0.01 未満）か元の番より後の番があった＝答えの漏れ。頼みを作った作業ツリーが 8c1b057c より古くないか確かめ、直したらこのファイルを消す", hits }, null, 1));
      const leakDir = join(root, day, "pending-leaked");
      mkdirSync(leakDir, { recursive: true });
      try { renameSync(join(root, day, "pending", fileName), join(leakDir, fileName)); } catch { /* 後ろの読みは頼みのファイルが無い */ }
      console.warn(`  漏れ: ${req.name} ${fileName}（距離 0.01 未満 ${lk.close}・元の番より後 ${lk.after}）→ 控えを書かず係を止める印（${LEAK_STOP_FILE}）`);
      return null;
    }
  }
  const out = join(root, day, fileName);
  mkdirSync(join(root, day), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ status: 200, contentType: "application/json", contentRange: null, body: reduced, at: new Date().toISOString(), table: req.name }));
  renameSync(tmp, out);
  return JSON.parse(reduced) as Array<Record<string, unknown>>;
}

(async () => {
  const root = join(examCacheRoot(), "db-snapshot");
  const days = arg("day") ? [arg("day")] : (existsSync(root) ? readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(root, d, "pending"))) : []);
  let ok = 0, fail = 0, rows = 0, follow = 0, stale = 0, originUsed = 0, originMissing = 0;
  const gateExcluded = (() => { try { return readGateExcluded(); } catch { return new Map<string, string>(); } })();
  const oScope = originScope(process.env, (() => { try { return (JSON.parse(readFileSync(join(examCacheRoot(), "exam-queue", "config.json"), "utf8")) as { nearOriginPids?: string[] }).nearOriginPids ?? []; } catch { return []; } })());
  for (const day of days) {
    const pdir = join(root, day, "pending");
    if (!existsSync(pdir)) continue;
    for (const f of readdirSync(pdir).filter((x) => x.endsWith(".json"))) {
      const req = JSON.parse(readFileSync(join(pdir, f), "utf8")) as { name: string; url: string; method: string; body: string; ls?: number; pid?: string | null; oconv?: string | null; oat?: string | null };
      // 2026-11-10 作業員8（漏れの番人の後）: 近い番の読みで答えの番を外した印（ls: 1）の無い頼みは解かずに pending-stale へ（11/09 の k-a9e10def は 8c1b057c より 23個古い作業ツリー tc-narrow の試験が 19:44 JST に作った・p_exclude_conv が YUMA2・p_before が本当の今）
      if (!stalePendingAllowed() && isUnsafeNearRequest(req, TEST_CONV_IDS)) { if (!DRY) { mkdirSync(join(root, day, "pending-stale"), { recursive: true }); renameSync(join(pdir, f), join(root, day, "pending-stale", f)); } console.warn(`  解かない（答えの番を外した印が無い＝古い作業ツリーの頼み）: ${day} ${f}`); stale++; continue; }
      // 頼みの URL は試験の env の DB（同じ DB）。鍵だけ差し替える（公開キーの印は送らない）
      const target = new URL(req.url); const base = new URL(url);
      if (target.host !== base.host) { console.warn(`  別の DB の頼みは読まない: ${f}`); fail++; continue; }
      if (DRY) { console.log(`  （dry）${day} ${req.name} ${f}`); continue; }
      try {
        // 2026-11-13 作業員8b（弱い所 517・EXAM_NEAR_ORIGIN_VECTOR=on・既定 off）: 近い番の読みは元の番の状況の文の埋め込み（本番の conductor_turn_vectors.embedding_v2）で引き直す。
        //   控えのファイル名（試験の鍵）はそのまま＝次の試験はこの答えを返す。元の番の鍵は near-origin/<問題>.json に残す（本文・実名は残さない）
        if (originInScope(req.pid, oScope) && originEligible(req, gateExcluded)) {
          const sbo = createClient(url, key);
          const lo = new Date(Date.parse(req.oat!) - 15 * 60_000).toISOString(), hi = new Date(Date.parse(req.oat!) + 15 * 60_000).toISOString();
          const { data: vrows } = await sbo.from("conductor_turn_vectors").select("source_key, turn_at, embedding_v2").eq("conversation_id", req.oconv!).eq("writer", "takeuchi").gte("turn_at", lo).lte("turn_at", hi).limit(20);
          const rows = ((vrows ?? []) as Array<{ source_key: string; turn_at: string; embedding_v2: unknown }>).map((r) => ({ ...r, has_emb: r.embedding_v2 != null }));
          const o = pickOriginRow(rows, req.oat!);
          if (o) {
            req.body = originBody(req.body, typeof o.embedding_v2 === "string" ? o.embedding_v2 : JSON.stringify(o.embedding_v2), { conv: req.oconv!, at: req.oat! });
            originUsed++;
            try { const od = join(examCacheRoot(), "near-origin"); mkdirSync(od, { recursive: true }); writeFileSync(join(od, `${req.pid}.json`), JSON.stringify({ pid: req.pid, source_key: o.source_key, turn_at: o.turn_at, at: new Date().toISOString() })); } catch { /* 控えは無くてよい */ }
          } else originMissing++;
        }
        const got = await resolveOne(day, f, req, root);
        if (!got) { fail++; continue; }
        unlinkSync(join(pdir, f));
        ok++; rows += got.length;
        // 2026-11-07 統括役: 後ろの読み（keep の表・番のベクトルの表）も、試験の道と同じ関数で URL を作って先に控える（on → resolve → on の2巡をなくす）
        for (const fu of await followupUrls(`${target.protocol}//${target.host}`, req.name, got, Date.now())) {
          const fname = `k-${keyedKey(fu.url, "GET", "", [])}.json`;
          if (existsSync(join(root, day, fname))) continue;
          const g2 = await resolveOne(day, fname, { name: fu.name, url: fu.url, method: "GET", body: "" }, root);
          if (g2) { follow++; rows += g2.length; try { unlinkSync(join(pdir, fname)); } catch { /* 頼みが無ければよい */ } } else fail++;
        }
      } catch (e) { console.warn(`  失敗 ${req.name}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); fail++; }
    }
    // --backfill: もう控えてある RPC の答えからも、後ろの読みの控えを作る（新しい台本の前に控えた分・作業員4 11/07）
    if (argv.includes("--backfill") && !DRY) {
      const base = new URL(url);
      for (const f of readdirSync(join(root, day)).filter((x) => /^k-.*\.json$/.test(x))) {
        try {
          const s = JSON.parse(readFileSync(join(root, day, f), "utf8")) as { table?: string; body?: string };
          if (s.table !== "match_conductor_focus" || !s.body) continue;
          for (const fu of await followupUrls(`${base.protocol}//${base.host}`, s.table, JSON.parse(s.body) as Array<Record<string, unknown>>, Date.now())) {
            const fname = `k-${keyedKey(fu.url, "GET", "", [])}.json`;
            if (existsSync(join(root, day, fname))) continue;
            const g2 = await resolveOne(day, fname, { name: fu.name, url: fu.url, method: "GET", body: "" }, root);
            if (g2) { follow++; rows += g2.length; } else fail++;
          }
        } catch (e) { console.warn(`  後ろの読みを作れない ${f}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); fail++; }
      }
    }
  }
  // 2026-11-07 統括役（守りの問題の自動の足し・弱い所 418）: 試験の問題の札（exam_problem_index・RLS）を鍵で読み、手元の置き場（brain-exam-rag/cards.json）に写す＝係が公開キーのまま守りを選べる
  if (!DRY && !argv.includes("--no-cards")) {
    try {
      const cards = await loadCards(createClient(url, key) as never);
      const n = Object.keys(cards).length;
      if (n) { mkdirSync(RAG_DIR, { recursive: true }); const tmp = `${CARDS_FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), cards })); renameSync(tmp, CARDS_FILE); console.log(`問題の札を写した: ${n}問（${CARDS_FILE}）`); }
    } catch (e) { console.warn(`問題の札を写せない: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); }
  }
  console.log(`${oScope.all || oScope.pids.size ? `元の番の状況で引き直した ${originUsed}・元の番が無い ${originMissing}／` : ""}鍵が要る読みの控え: 書いた ${ok}・後ろの読みを先に ${follow}・行 ${rows}・読めない ${fail}・古い頼み ${stale}（日 ${days.join(",") || "なし"}）${DRY ? "（dry）" : ""}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
