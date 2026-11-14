// app/lib/compose-phrase-catalog-tables.ts — 言い回しの表の版を選ぶ（純関数）
//   1版 compose-phrase-catalog-data.ts（竹内さんの返信 198番・DeepSeek の3回読みの役目）／2版 compose-phrase-catalog-data-v2.ts（竹内さん本人の LINE の送信・決まった語の役目）
//   2026-11-15 作業員I（竹内さん 11/15「ちゃんと竹内の LINE から学習する」）。COMPOSE_PHRASE_CATALOG_V2=on の時だけ2版（既定 off＝今まで通り1版）
import * as V1 from "./compose-phrase-catalog-data";
import * as V2 from "./compose-phrase-catalog-data-v2";

type Env = Record<string, string | undefined>;
export function composePhraseCatalogV2On(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_PHRASE_CATALOG_V2 ?? "").trim().toLowerCase() === "on";
}
/** 1版と2版で共通の表（同じ形）。2版だけの段（強さ・形・敬語・頭の言い方・場面×役目・AIX の定型）は phraseTablesV2Only で */
export type PhraseTables = Pick<typeof V1, "PHRASE_CATALOG_BUILT" | "PHRASE_TRUST_TABLE" | "PHRASE_ENDING_TABLE" | "PHRASE_LENGTH_TABLE" | "PHRASE_TRUST_SUB_TABLE" | "PHRASE_SUB_TABLE" | "PHRASE_ROWS_TABLE" | "PHRASE_EMOJI_TABLE">;
/** 2版に無い鍵（役目不明にした answer・worry・ask_send 等の主の役目）は1版の行を残す（2版の行が先） */
const merge = <T>(a: Record<string, T>, b: Record<string, T>): Record<string, T> => ({ ...a, ...b });
let merged: PhraseTables | null = null;
export function phraseTables(env?: Env): PhraseTables {
  if (!composePhraseCatalogV2On(env)) return V1;
  merged ??= {
    PHRASE_CATALOG_BUILT: V2.PHRASE_CATALOG_BUILT,
    PHRASE_TRUST_TABLE: merge(V1.PHRASE_TRUST_TABLE, V2.PHRASE_TRUST_TABLE),
    PHRASE_ENDING_TABLE: merge(V1.PHRASE_ENDING_TABLE, V2.PHRASE_ENDING_TABLE),
    PHRASE_LENGTH_TABLE: merge(V1.PHRASE_LENGTH_TABLE, V2.PHRASE_LENGTH_TABLE),
    PHRASE_TRUST_SUB_TABLE: merge(V1.PHRASE_TRUST_SUB_TABLE, V2.PHRASE_TRUST_SUB_TABLE),
    PHRASE_SUB_TABLE: merge(V1.PHRASE_SUB_TABLE, V2.PHRASE_SUB_TABLE),
    PHRASE_ROWS_TABLE: merge(V1.PHRASE_ROWS_TABLE, V2.PHRASE_ROWS_TABLE),
    PHRASE_EMOJI_TABLE: merge(V1.PHRASE_EMOJI_TABLE, V2.PHRASE_EMOJI_TABLE),
  } as unknown as PhraseTables;
  return merged;
}
export function phraseTablesVersion(env?: Env): string {
  return composePhraseCatalogV2On(env) ? `phrase-catalog-v2@${V2.PHRASE_CATALOG_BUILT}` : `phrase-catalog@${V1.PHRASE_CATALOG_BUILT}`;
}
export const phraseTablesV2Only = {
  meta: V2.PHRASE_V2_META, opener: V2.PHRASE_OPENER_TABLE, keigo: V2.PHRASE_KEIGO_TABLE, sceneRole: V2.PHRASE_SCENE_ROLE_TABLE,
  strength: V2.PHRASE_STRENGTH_TABLE, form: V2.PHRASE_FORM_TABLE, aixTemplate: V2.PHRASE_AIX_TEMPLATE_TABLE,
};
