// app/lib/takeuchi-exemplar-server.ts — 竹内さんの手本の束（takeuchi-exemplar）を読み、その番の設計図に添える注記を作る（サーバーだけ）
//
// 2026-11-12 作業員10（統括役: 作業員5 の takeuchi-exemplar を文の統括の設計図に配線・TAKEUCHI_EXEMPLAR=on の時だけ）。
//   束の置き場所:
//     今（試験）: TAKEUCHI_EXEMPLAR_BANK＝束の JSON のパス（scripts/anatomy-exemplar-bank.ts が exam-cache/anatomy-seven/exemplar-bank.json に作る・倉庫の外）
//     本番（案）: Supabase の表 takeuchi_exemplars（id・scene・latent・lead・hand・sentences jsonb［役目・なぜ・ブレインの欄だけ。文の text は入れない］・latent_four jsonb・fact・updated_at）。
//       作業員5 の夜の読みが upsert し、generate-reply はこの3列（scene・latent・lead）の index で引く。注記に渡すのは役目の並び・なぜ・事実だけ（文は写させない）。
//       表を作る時は migrate-schema/route.ts も同時に直す（CLAUDE.md の決まり）。表ができるまでは本番では束が無い＝注記なし（今と同じ）
//   同じ番の手本は使わない: お客様の発言が今の番と同じ手本は外す（試験で正解の番を手本にしない）
import { readFileSync, existsSync } from "node:fs";
import { pickExemplar, exemplarNote, exemplarOn, latentKeyOf, leadKeyOf, type Exemplar } from "./takeuchi-exemplar";

type Bank = Array<Exemplar & { hand?: boolean }>;
let cache: { path: string; bank: Bank } | null = null;
function loadBank(env: Record<string, string | undefined>): Bank {
  const p = (env.TAKEUCHI_EXEMPLAR_BANK ?? "").trim();
  if (!p || !existsSync(p)) return [];
  if (cache?.path === p) return cache.bank;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const bank = (Array.isArray(raw) ? raw : []) as Bank;
    cache = { path: p, bank };
    return bank;
  } catch { return []; }
}

const nz = (t: string | null | undefined) => String(t ?? "").normalize("NFKC").replace(/\s+/g, "");
/** 設計図に添える手本の注記（off・束なし・引けない時は null）。鍵: 場面 × 潜在の型（発言＋concern）× 誘導先（ブレインの dir・action・mode） */
export function exemplarNoteFor(o: { scene: string | null; customerText: string; meta: unknown }, env: Record<string, string | undefined> = process.env): { note: string; key: string; level: number; id: string } | null {
  if (!exemplarOn(env) || !o.scene) return null;
  const bank = loadBank(env);
  if (!bank.length) return null;
  const m = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Record<string, unknown>;
  const cc = m.customer_concern && typeof m.customer_concern === "object" ? m.customer_concern as Record<string, unknown> : null;
  const concern = cc ? `${cc.topic ?? ""} ${cc.object ?? ""}` : null;
  const key = { scene: o.scene, latent: latentKeyOf(o.customerText, concern), lead: leadKeyOf({ dir: typeof m.reply_direction === "string" ? m.reply_direction : null, action: typeof m.action === "string" ? m.action : null, mode: typeof m.reply_mode === "string" ? m.reply_mode : null }) };
  const same = nz(o.customerText);
  const pool = same ? bank.filter((e) => nz(e.customer) !== same) : bank;
  const hit = pickExemplar(pool, key);
  const note = exemplarNote(hit, env);
  return hit && note ? { note, key: `${key.scene}|${key.latent}|${key.lead}`, level: hit.level, id: hit.ex.id } : null;
}
