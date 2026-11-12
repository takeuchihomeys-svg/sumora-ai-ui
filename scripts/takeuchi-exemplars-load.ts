// scripts/takeuchi-exemplars-load.ts — 竹内さんの手本の束（作業員5 の解剖・exemplar-bank.json）を表 takeuchi_exemplars に入れる夜の読み（LLM なし）
//   2026-11-12 作業員23。表は scripts/takeuchi-exemplars-migration.sql（migrate-schema にも同じ文）。形は app/lib/takeuchi-exemplar-row.ts。
//   ① 申込の門（app/lib/turn-application-gate.ts）を番の時刻で引き直し、外れる番・通が見つからない番は入れない（もう表にあれば消す）
//   ② 文の本文 text・お客様の発言は入れない。why・fact・潜在の4つは名前・住所などの値と物件名を伏せてから入れる（物件名の一覧は propertyNamesForBank）
//   ③ JST 9〜22時は自分で止まる（営業時間に DB を読まない・--dry でも同じ）。1会話ずつ間を空けて引く
//   ④ Supabase は sumora-ai-ui のプロジェクトだけ（URL の ref を確かめる）・サーバーの鍵だけで書く（公開キーには戻さない）
// 実行: npx tsx --env-file=.env.local scripts/takeuchi-exemplars-load.ts [--bank=<exemplar-bank.json>] [--dry]
//   --dry … 件数（入れる・外す理由ごと）だけ出す。表には書かない
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { buildExemplarRows, propertyNameVariants, propertyNamesFromText, type BankEntry } from "../app/lib/takeuchi-exemplar-row";
import { turnApplicationReason, type TurnApplicationRecords } from "../app/lib/turn-application-gate";
import { jstHourNow } from "../app/lib/batch-daytime-guard";

const PROJECT_REF = "wfwsmwxakhyxobytszoq";
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DRY = process.argv.includes("--dry");
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

/** 動いてよい時間か（JST 22時〜翌9時だけ）。純関数・テストあり */
export function nightOnly(now = new Date()): { ok: boolean; reason: string } {
  const h = jstHourNow(now);
  return h >= 9 && h < 22 ? { ok: false, reason: `JST ${h}時＝営業時間（9〜22時）は DB を読まないので止める。夜（22時〜翌9時）に回す` } : { ok: true, reason: `JST ${h}時` };
}

/** 物件名の一覧（束の隣の潜在の4つの読み seven-latent4*.json の part.property ＋ 竹内さんの文の「〇〇 703号室」）→ 言い方を広げる。
 *  文の本文は手元で名前を拾うためだけに読む（表には入れない） */
export function propertyNamesForBank(bankPath: string, bank: ReadonlyArray<BankEntry>): string[] {
  const names: string[] = [];
  for (const f of ["seven-latent4.json", "seven-latent4b.json"]) {
    const p = join(dirname(bankPath), f);
    if (!existsSync(p)) continue;
    try {
      for (const o of JSON.parse(readFileSync(p, "utf8")) as Array<{ reads?: Array<{ part?: { property?: string | null } } | null> }>) {
        const n = o.reads?.[0]?.part?.property;
        if (n) names.push(n);
      }
    } catch { /* 読めない読みは飛ばす（部屋番号の付いた物件名は一覧が無くても伏せる） */ }
  }
  names.push(...propertyNamesFromText(bank.flatMap((e) => (Array.isArray(e.sentences) ? e.sentences.map((x) => x.text) : []))));
  return propertyNameVariants(names);
}

async function main() {
  const t = nightOnly();
  if (!t.ok) { console.log(`止めた: ${t.reason}`); return; }
  const bankPath = resolve(arg("bank", join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven", "exemplar-bank.json")));
  if (!existsSync(bankPath)) { console.log(`束が無い: ${bankPath}`); process.exitCode = 1; return; }
  const bank = JSON.parse(readFileSync(bankPath, "utf8")) as BankEntry[];
  if (!Array.isArray(bank)) { console.log("束の形が配列でない"); process.exitCode = 1; return; }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(PROJECT_REF)) { console.log("Supabase の URL が sumora-ai-ui のプロジェクトでない＝止める"); process.exitCode = 1; return; }
  if (!key) { console.log("サーバーの鍵（SUPABASE_SERVICE_ROLE_KEY）が無い＝止める"); process.exitCode = 1; return; }
  const { createClient } = await import("@supabase/supabase-js");
  const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // 番 → 会話・時刻（100件ずつ）
  const ids = [...new Set(bank.map((e) => String(e?.id ?? "")).filter(Boolean))];
  const msg = new Map<string, { conv: string; at: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at").in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`messages: ${error.message}`);
    for (const m of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>) msg.set(String(m.id), { conv: m.conversation_id, at: m.created_at });
    await sleep(120);
  }
  // 申込の記録は1会話ずつ（読めない会話は unreadable＝門が外す）
  const recs = new Map<string, TurnApplicationRecords>();
  for (const c of [...new Set([...msg.values()].map((m) => m.conv))]) {
    if (!nightOnly().ok) { console.log("途中で営業時間に入った＝止める（何も書いていない）"); return; }
    recs.set(c, await loadTurnApplicationRecords(sb, c));
    await sleep(120);
  }
  const gateOf = (id: string): string | null | undefined => { const m = msg.get(id); return m ? turnApplicationReason(recs.get(m.conv), m.at) : undefined; };
  const propertyNames = propertyNamesForBank(bankPath, bank);
  const { rows, skipped } = buildExemplarRows(bank, gateOf, { propertyNames });
  console.log(`物件名の言い方 ${propertyNames.length}個を（物件）に伏せる`);
  const by: Record<string, number> = {};
  for (const s of skipped) { const k = s.reason.replace(/（.*）/, ""); by[k] = (by[k] ?? 0) + 1; }
  console.log(`束 ${bank.length}通 → 入れる ${rows.length}通・入れない ${skipped.length}通 ${JSON.stringify(by)}`);
  for (const s of skipped) console.log(`  外す ${s.id.slice(0, 8)}: ${s.reason}`);
  if (DRY) { console.log("--dry: 表には書かない"); return; }

  // 門で外れた番がもう表にあれば消す（前の夜に入れた番が、後から申込の記録が付いて外れる時）
  const drop = skipped.filter((s) => s.reason.startsWith("申込の門")).map((s) => s.id);
  for (let i = 0; i < drop.length; i += 100) {
    const { error } = await sb.from("takeuchi_exemplars").delete().in("id", drop.slice(i, i + 100));
    if (error) throw new Error(`delete: ${error.message}`);
  }
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 50) {
    if (!nightOnly().ok) { console.log(`途中で営業時間に入った＝止める（${i}通まで書いた）`); return; }
    const { error } = await sb.from("takeuchi_exemplars").upsert(rows.slice(i, i + 50).map((r) => ({ ...r, updated_at: now })), { onConflict: "id" });
    if (error) throw new Error(`upsert: ${error.message}`);
    await sleep(200);
  }
  console.log(`書いた: upsert ${rows.length}通・消した ${drop.length}通（門で外れた番）`);
}

if (process.argv[1] && /takeuchi-exemplars-load\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
