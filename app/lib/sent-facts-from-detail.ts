/**
 * 送った画像の値（sent_image_properties.facts）の空の欄を、同じ画像のもう一つの読み（image_details.lines）から埋める
 *   （純関数・LLM なし・2026-11-22 作業員G・台帳 #509 ③・統括役の OK）
 *
 * なぜ: オススメで送った資料の画像の値で間取り・築年・現況が 43%（14日 35件中 15件）しか埋まっていなかった。
 *   目で見た1枚（リアルネットプロの1枚の資料）には家賃・間取り・築年・号室がはっきり書いてあるのに、物件の読み（property_image_read）は
 *   駅・面積・管理費しか返していなかった。同じ画像の書き写しの読み（image_details.lines）には「間取り:」「築年:」「現況:」「所在階:」が入っていた。
 *
 * 決まり: 空の欄だけを埋める（入っている値は上書きしない）。読めない形は埋めない（作らない）。埋めた欄は fill_from に記す。
 *   既定 off（SENT_FACTS_FROM_DETAIL=on）
 */
import { ageFromBuiltYm, parseBuilt } from "./candidate-facts";

export function sentFactsFromDetailOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_FACTS_FROM_DETAIL ?? "").trim().toLowerCase() === "on";
}

const lineValue = (lines: ReadonlyArray<string>, key: string): string | null => {
  const re = new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+)$`);
  for (const l of lines) { const m = re.exec(String(l)); if (m) return m[1].trim(); }
  return null;
};

/** 「1K[6×K]」「1LDK」「ワンルーム」→ 間取りの記号。読めなければ null */
export function floorPlanOf(v: string | null): string | null {
  if (!v) return null;
  const s = v.normalize("NFKC");
  if (/ワンルーム|^1R\b/i.test(s)) return "1R";
  const m = /([1-9])\s*(S?L?D?K)\b/i.exec(s);
  return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}

/** 現況の文字 → facts.status の語（open・move_out_planned・under_construction・occupied） */
export function statusOf(v: string | null): string | null {
  if (!v) return null;
  if (/退去予定|退去日/.test(v)) return "move_out_planned";
  if (/建築中|未完成|新築工事|完成予定/.test(v)) return "under_construction";
  if (/居住中|入居中/.test(v)) return "occupied";
  if (/空室|空家|空き/.test(v)) return "open";
  return null;
}

export function floorOf(v: string | null): number | null {
  const m = /(\d{1,2})\s*階/.exec(String(v ?? "").normalize("NFKC"));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 60 ? n : null;
}

/** 埋める差分（空の欄だけ）。何も無ければ空 */
export function factsPatchFromDetail(facts: Record<string, unknown> | null | undefined, lines: ReadonlyArray<string> | null | undefined, now: Date | string = new Date()): Record<string, unknown> {
  const f = facts ?? {};
  const ls = lines ?? [];
  const empty = (k: string) => f[k] == null || f[k] === "";
  const patch: Record<string, unknown> = {};
  const fp = floorPlanOf(lineValue(ls, "間取り"));
  if (empty("floor_plan") && fp) patch.floor_plan = fp;
  const builtRaw = lineValue(ls, "築年");
  if (builtRaw && (empty("built_ym") || empty("building_age"))) {
    const pb = parseBuilt(/築|新築/.test(builtRaw) ? builtRaw : `築年月 ${builtRaw}`);
    if (empty("built_ym") && pb.ym && /^\d{4}-\d{2}$/.test(pb.ym)) patch.built_ym = pb.ym;
    const age = pb.age ?? (pb.ym ? ageFromBuiltYm(pb.ym, now) : null);
    if (empty("building_age") && age != null) patch.building_age = age;
  }
  const st = statusOf(lineValue(ls, "現況"));
  if (empty("status") && st) patch.status = st;
  const fl = floorOf(lineValue(ls, "所在階"));
  if (empty("floor") && fl != null) patch.floor = fl;
  if (Object.keys(patch).length) patch.fill_from = "image_details";
  return patch;
}
