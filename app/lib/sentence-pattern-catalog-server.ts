// app/lib/sentence-pattern-catalog-server.ts — 文型カタログ（scripts/sentence-pattern-catalog.ts が作る JSON）を読み、その番の注記を作る（サーバーだけ・既定 off）
//
// 2026-11-12 作業員23（作業員24 の洗い出しの根B）。置き場所は今は SENTENCE_PATTERN_CATALOG_FILE（試験・exam-cache の pattern-catalog.json・倉庫の外）。
//   SENTENCE_PATTERN_CATALOG=on かつファイルがある時だけ注記を出す。無い・読めない・off は null（今と同じ）。
//   本番に置く時は手本の表（takeuchi_exemplars）と同じく DB の表にして migrate-schema も同時に直す（今は作らない）
import { readFileSync, existsSync } from "node:fs";
import { patternCatalogOn, patternCatalogNote, catalogKeyOf, type PatternCatalog } from "./sentence-pattern-catalog";
import type { KeepPromiseKind } from "./turn-anatomy-fields";

let cache: { path: string; cat: PatternCatalog | null } | null = null;
export function loadPatternCatalog(env: Record<string, string | undefined> = process.env): PatternCatalog | null {
  const p = (env.SENTENCE_PATTERN_CATALOG_FILE ?? "").trim();
  if (!p || !existsSync(p)) return null;
  if (cache?.path === p) return cache.cat;
  let cat: PatternCatalog | null = null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as PatternCatalog;
    cat = raw && Array.isArray(raw.groups) && Array.isArray(raw.opener) && Array.isArray(raw.latentSay) ? raw : null;
  } catch { cat = null; }
  cache = { path: p, cat };
  return cat;
}

/** 設計図に添える文型の注記（off・カタログ無し・引けない時は null）。keepKind＝継続の約束を添える番の種類（分かる時だけ） */
export function patternCatalogNoteFor(o: { scene: string | null; customerText: string; meta: unknown; keepKind?: KeepPromiseKind | null }, env: Record<string, string | undefined> = process.env): { note: string; key: string } | null {
  if (!patternCatalogOn(env)) return null;
  const cat = loadPatternCatalog(env);
  if (!cat) return null;
  const k = catalogKeyOf(o);
  const note = patternCatalogNote(cat, { ...k, keepKind: o.keepKind ?? null }, env);
  return note ? { note, key: `${k.scene}|${k.branch}|${k.latent}|${k.lead}${o.keepKind ? `|${o.keepKind}` : ""}` } : null;
}
