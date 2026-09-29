// app/lib/condition-scope-override.ts — 「今回だけ」の言い直しを、その回だけの上書き（search_override）にする（純関数・サーバー用＝駅の表を読む）
//
// 2026-09-27 竹内「一時調整か、そもそもの条件の切り替えかの判断をブレインが行う」: ブレイン（か文の「今回だけ」の語）が temporary と決めた時、
//   登録の条件は直さず、この発言の条件をスタッフのメモの検索の指示と同じ形（SearchOverride）にして AIX の検索（source=aix）に載せる。
//   読み方はメモの決定論（search-override-read.ts parseDeterministic → validateOverride＝**文に書いてある物だけ**）をそのまま使う。
//   決定論の関所（rent-raise.ts）も同じ計算で入れる: 「家賃を上げて」（金額なし）＝帯の決まり・「7畳以上」＝1R/1K の時だけ ㎡ の下限。
//   LLM は呼ばない（ブレインの判断の後に積むまでの時間を延ばさない・文に無い条件を作らない）。
import type { RegisteredConditions, SearchOverride } from "./search-override";
import { isEmptyOverride } from "./search-override";
import { parseDeterministic, validateOverride } from "./search-override-read";
import { detectRentRaiseRequest, computeRaisedRentMax, floorAreaMinFromJo } from "./rent-raise";

export type TemporaryOverrideResult = { override: SearchOverride | null; notes: string[] };

/**
 * お客様が送った物件そのもの（URL・物件の紹介の貼り付け・画像）か。こういう文から上書きを作ると、その物件の駅・間取り・築年だけの検索になる
 * （2026-09-27 監査: 「天神ノ森 3SLDK 1-2階 / https://suumo…」→ 天神ノ森駅だけ・3SLDK の上書きになっていた）→ 上書きを作らない
 */
export function looksLikePropertyShare(text: string): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (/https?:\/\/|www\.|by SUUMO|\[画像\]|アプリ上でご覧/i.test(t)) return true;
  if (/(?:管理費|共益費)(?:等)?\s*[:：]?\s*[\d,]+\s*円/.test(t)) return true;
  if (/\d{2,4}\s*号室|\d+\s*階\s*\/\s*\d+\s*階建|[1-9]\s*(?:R|K|DK|LDK)\s*\/\s*\d+(?:\.\d+)?\s*(?:㎡|m²|m2)/i.test(t)) return true;
  return false;
}

/** お客様の文（今回だけ）→ その回だけの上書き。上書きが1つも無ければ null（＝登録の条件で検索） */
export function buildTemporaryOverride(text: string, reg: RegisteredConditions | null | undefined): TemporaryOverrideResult {
  const notes: string[] = [];
  if (looksLikePropertyShare(text)) return { override: null, notes: ["お客様が送った物件の文なので上書きを作らない（登録の条件で検索）"] };
  // お客様の文は「検索の指示」の命令形でないことが多い（「〜の物件も見たいです」）→ ブレインが条件の話と決めた後なので検索の指示として読む
  const raw = { ...parseDeterministic(text, reg), is_search: true, scope: null, site: null };
  const v = validateOverride(raw, text, reg);
  const ov: SearchOverride = v.override ?? { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };
  // サイト・広げて/ピンポイントは AIX の検索の側（コマンド）で決める＝お客様の文からは入れない
  ov.site = null; ov.is_wide = null;
  const raise = detectRentRaiseRequest(text);
  if (raise) {
    const next = computeRaisedRentMax(reg?.rent_max ?? null, raise);
    if (next != null) { ov.rent_max = next; notes.push(`家賃の上限 ${reg?.rent_max ?? "なし"} → ${next}（今回だけ・${raise.kind}）`); }
  }
  // 下限はお客様が言った時だけ（validateOverride は「以上」「〜」の時だけ入れる）
  const fa = floorAreaMinFromJo(text, ov.floor_plan ?? reg?.floor_plan ?? null);
  if (fa) { ov.area_min = fa.sqm; notes.push(`面積の下限 ${fa.sqm}㎡（洋室${fa.jo}帖・今回だけ）`); }
  if (v.dropped.length) notes.push(...v.dropped.map((d) => `落とした: ${d}`));
  return { override: isEmptyOverride(ov) ? null : ov, notes };
}
