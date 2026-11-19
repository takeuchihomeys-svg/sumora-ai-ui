// app/lib/compose-elements-server.ts — 文の要素の型（scripts/compose-elements-read.ts が作る JSON）を読み、その番の注記を作る（サーバーだけ・既定 off）
//
// 2026-11-12 作業員23（KB 2301dbf1）。置き場所は今は COMPOSE_ELEMENTS_FILE（試験・exam-cache の compose-elements.json・倉庫の外）。
//   COMPOSE_ELEMENTS=on かつファイルがある時だけ注記を出す。無い・読めない・off は null（今と同じ）。
//   道（返信か AIX か・誘導先）はブレインが決めた後の meta から読むだけ（決め直さない）
import { readFileSync, existsSync } from "node:fs";
import { composeElementsOn, composeElementsNote, type ComposeElements } from "./compose-elements";
import { catalogKeyOf } from "./sentence-pattern-catalog";

let cache: { path: string; ce: ComposeElements | null } | null = null;
export function loadComposeElements(env: Record<string, string | undefined> = process.env): ComposeElements | null {
  const p = (env.COMPOSE_ELEMENTS_FILE ?? "").trim();
  if (!p || !existsSync(p)) return null;
  if (cache?.path === p) return cache.ce;
  let ce: ComposeElements | null = null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ComposeElements;
    ce = raw && Array.isArray(raw.types) && Array.isArray(raw.latentNo) ? raw : null;
  } catch { ce = null; }
  cache = { path: p, ce };
  return ce;
}

/** 設計図に添える文の要素の注記（off・ファイル無し・型が無い時は null）。信頼の手がかりは meta.takeuchi_fields.trust_how（あれば） */
export function composeElementsNoteFor(o: { scene: string | null; customerText: string; meta: unknown }, env: Record<string, string | undefined> = process.env): { note: string; key: string } | null {
  if (!composeElementsOn(env)) return null;
  const ce = loadComposeElements(env);
  if (!ce) return null;
  const k = catalogKeyOf(o);
  const m = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Record<string, unknown>;
  const tf = (m.takeuchi_fields ?? m.compose_fields) as Record<string, unknown> | undefined;
  const th = tf && Array.isArray(tf.trust_how ?? tf.trustHow) ? ((tf.trust_how ?? tf.trustHow) as unknown[]).filter((x): x is string => typeof x === "string") : null;
  const note = composeElementsNote(ce, { lead: k.lead, latent: k.latent, trust: th, scene: o.scene, customerText: o.customerText }, env);
  return note ? { note, key: `${k.lead}|${k.latent}` } : null;
}
