/**
 * 弱い強化の対象を「台帳の正名だけ」に落とす土台（2026-11-17）
 *
 *   竹内さん「抜け・弱い部分を最善で根本改善／必要な土台があれば付ける」
 *
 * ⚠ 実測: weak-strengthen が「1DK」「大阪市北区」「御堂筋線」など
 *   台帳外の値を photo_learn 対象にして学習が薄まった。
 *   → 値っぽい物は欄に写し、台帳に無い物は落とす。
 */
import { ITANDI_BUTTONS, resolveItandiButtonId } from "./itandi-buttons";
import { REALPRO_BUTTONS, resolveRealproButtonId } from "./realpro-buttons";

export type ButtonCatalogSite = "realpro" | "itandi";

function uniq(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const s = String(x || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 値・画面ラベルっぽい物を台帳の欄 id に写す（写せなければそのまま） */
export function mapRawToCatalogHint(raw: string, site: ButtonCatalogSite): string {
  let s = String(raw || "").trim();
  if (!s) return s;
  // 自動ステップの接頭「選ぶ:layout:room_layout_id[]」「選ぶ済:room_layout_id[]」を外して欄名に戻す
  const mPick = /^選ぶ(?:済)?(?::[a-z0-9_]+)?[:：](.+)$/i.exec(s);
  if (mPick) s = mPick[1].trim();
  if (s === "間取り場面") return site === "itandi" ? "room_layout:in" : "room_layout_id[]";
  // 間取りの値（1DK / 2LDK / 1R …）
  if (/^(?:[1-9][SLDK]{0,3}|[1-9]R|ワンルーム|メゾネット)$/i.test(s) || /^[1-9](?:K|DK|LDK|SDK|SLDK)$/i.test(s)) {
    return site === "itandi" ? "room_layout:in" : "room_layout_id[]";
  }
  // 路線名（「大阪市高速軌道…線」は区より先に判定）
  if (/線$|メトロ|阪急|阪神|近鉄|京阪|南海|JR|モノレール|北大阪急行|泉北|高速軌道/.test(s)) {
    return site === "itandi" ? "line_checkbox" : "route_id[]";
  }
  // 区・市名（末尾が市区町村／短い地名）
  if (/[市区町村郡]$/.test(s) || /^(?:大阪市|堺市|東大阪|豊中|吹田|高槻|枚方)/.test(s)) {
    return site === "itandi" ? "city_radio" : "city_code[]";
  }
  // 駅っぽい単独名は駅欄へ（短すぎる物は避ける）
  if (s.length >= 2 && s.length <= 12 && /駅$/.test(s)) {
    return site === "itandi" ? "station_checkbox" : "station_id[]";
  }
  return s;
}

function inRealproCatalog(id: string): boolean {
  return REALPRO_BUTTONS.some((b) => b.id === id);
}

function inItandiCatalog(id: string): boolean {
  return ITANDI_BUTTONS.some((b) => b.id === id);
}

/**
 * 生の課題名配列 → 台帳に載っている正名だけ（順序は入力順のまま・重複除去）。
 *   台帳外は落とす（1DK・区名単体などがここに落ちる）。
 */
export function catalogTargetsOnly(
  names: readonly string[],
  site: ButtonCatalogSite = "realpro",
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const hint = mapRawToCatalogHint(raw, site);
    const id =
      site === "itandi"
        ? resolveItandiButtonId(hint) || resolveItandiButtonId(String(raw || ""))
        : resolveRealproButtonId(hint) || resolveRealproButtonId(String(raw || ""));
    if (!id) continue;
    const ok = site === "itandi" ? inItandiCatalog(id) : inRealproCatalog(id);
    if (!ok) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** DB実測で弱いことが分かっている欄を先頭に足す（台帳内のみ） */
export function preferKnownWeakTargets(
  targets: readonly string[],
  site: ButtonCatalogSite = "realpro",
): string[] {
  const prefer =
    site === "itandi"
      ? [
          "station_checkbox",
          "line_checkbox",
          "room_layout:in",
          "filter_wards_open",
          "filter_stations_open",
          "offer_conditions_updated_at:gteq",
          "city_radio",
          "search",
          "modal_confirm",
        ]
      : [
          "station_id[]",
          "room_layout_id[]",
          "間取り絞り込み＋",
          "city_code[]",
          "town_code[]",
          "駅の設定へ進む",
          "沿線の設定へ戻る",
          "確定してリストへ",
          "所在地絞り込み＋",
          "route_id[]",
          "eq_rm[]",
          "検索",
        ];
  return uniq([...prefer.filter((id) => (site === "itandi" ? inItandiCatalog(id) : inRealproCatalog(id))), ...targets]);
}
