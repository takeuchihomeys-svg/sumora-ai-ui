// app/lib/conductor-ownership.ts — 統括の受け持ち表（台帳 #662・竹内さん「統括をちゃんとできなければいけない」の続き・純関数・DB/LLM なし・記録だけ）
// 2026-11-26 作業員A（統括役の頼み）: 作った部品ごとに3段を毎朝数える
//   ① 持つ … その番の材料にあった（digest.mk＝material_marks のキーの並び）
//   ② 使う … MATERIAL_PRIORITY の先頭に来た（digest.mpr のキー）・判断がその材料の目印どおり（USED_MARKERS）
//   ③ 反映する … 判断の後に、目当ての AIX が実際に出た（aix_usage_logs の同じ会話・2時間の内）。返信が目当ての番は ③ を数えない（下書きの文に印が無い）
//   どの段にも印が無い部品は「欠け」として出す（台帳へ）。ブレインには効かない。
import { USED_MARKERS } from "./material-priority";

export type OwnRow = {
  key: string; name: string; owner: string;
  /** 材料のキー（material_marks・materialBlocks）。null＝ブレインの材料ではない（入口の読みへ渡す等）＝① の印が無い */
  mark: string | null;
  /** その番の目当ての AIX（null＝返信が目当て・undefined＝決められない） */
  want?: (d: Record<string, unknown>) => string | null | undefined;
};
const BPN_AIX: Record<string, string> = { estimate: "estimate_sheet", viewing_arrange: "viewing_invite", viewing_scheduled: "meeting_place", apply_prep: "application_push", proposing: "property_send" };
export const OWN_ROWS: readonly OwnRow[] = [
  { key: "intake_route", name: "入口の駅（CONDUCTOR_INTAKE_ROUTE）", owner: "作業員A", mark: null },
  { key: "next_stone", name: "次の石（ROUTE_NEXT_STONE_LINE・未配線）", owner: "作業員A", mark: "next_stone" },
  { key: "route_backplan", name: "逆算の計画（APPLY_ROUTE_BACKPLAN）", owner: "作業員A", mark: "route_backplan", want: (d) => BPN_AIX[String(d.bpn ?? "")] ?? undefined },
  { key: "station_state", name: "駅の今の状態（STATION_STATE_LINE）", owner: "作業員A", mark: "station_state" },
  { key: "check_promise_flow", name: "確認の約束の流れ（BRAIN_CHECK_PROMISE_FLOW）", owner: "作業員A", mark: "check_promise_flow", want: (d) => (d.cpf ? (d.cpf === "a" ? "property_check_result" : null) : undefined) },
  { key: "pickup_promise_flow", name: "探す約束の後のお礼（BRAIN_PICKUP_PROMISE_FLOW）", owner: "作業員A", mark: "pickup_promise_flow", want: (d) => (d.ppf ? (d.ppf === "r" ? "property_send" : null) : undefined) },
  { key: "aix_boundary", name: "AIX と返信の境目（AIX_BOUNDARY_LINE）", owner: "作業員A", mark: "aix_boundary", want: (d) => (d.abd ? (d.abd === "reply" ? null : String(d.abd)) : undefined) },
  { key: "aix_dictionary", name: "AIX の辞書（AIX_DICTIONARY_LINE）", owner: "作業員A", mark: "aix_dictionary", want: (d) => (d.dct && String(d.aix ?? "").trim() ? String(d.dct).split("+")[0] : undefined) },
  { key: "deal_flow_pre_apply", name: "成約データの1行（DEAL_FLOW_PRE_APPLY_LINE）", owner: "作業員L", mark: "deal_flow_pre_apply" },
  { key: "pickup_why", name: "物件を選んだ理由（PICKUP_WHY_TO_BRAIN）", owner: "作業員A", mark: "pickup_why" },
  { key: "now_fulfillable", name: "今果たせる約束（SITUATION_NOW_FULFILLABLE）", owner: "作業員1", mark: "now_fulfillable" },
];
export type OwnDecision = { digest: Record<string, unknown>; conv: string; at: string };
export type OwnAix = { conv: string; at: string; type: string };
export type OwnCount = { key: string; name: string; owner: string; hold: number | null; head: number | null; usedOk: number; usedOf: number; reflectOk: number; reflectOf: number; gaps: string[] };
const keysOf = (s: unknown) => (typeof s === "string" && s ? s.split(",") : []);
/** 部品ごとの3段（純関数） */
export function ownershipTable(ds: readonly OwnDecision[], aix: readonly OwnAix[], rows: readonly OwnRow[] = OWN_ROWS): OwnCount[] {
  const byConv = new Map<string, OwnAix[]>();
  for (const a of aix) byConv.set(a.conv, [...(byConv.get(a.conv) ?? []), a]);
  const markedRows = ds.filter((d) => typeof d.digest.mtk === "string");
  return rows.map((r) => {
    const has = r.mark ? markedRows.filter((d) => keysOf(d.digest.mtk).includes(r.mark!)) : [];
    const head = has.filter((d) => keysOf(String(d.digest.mpr ?? "").split("|")[3]).includes(r.key));
    const um = USED_MARKERS[r.key];
    let usedOk = 0, usedOf = 0, reflectOk = 0, reflectOf = 0;
    for (const d of has) {
      const u = um ? um(d.digest) : null; if (u != null) { usedOf++; if (u) usedOk++; }
      const w = r.want ? r.want(d.digest) : undefined;
      if (typeof w === "string") {
        reflectOf++;
        const t = Date.parse(d.at);
        if ((byConv.get(d.conv) ?? []).some((a) => a.type.startsWith(w) && Date.parse(a.at) >= t && Date.parse(a.at) - t <= 2 * 3_600_000)) reflectOk++;
      }
    }
    const gaps: string[] = [];
    if (!r.mark) gaps.push("① 持つの印が無い（ブレインの材料ではない・記録に欄が無い）");
    if (!um) gaps.push("② 使ったの目印が無い（USED_MARKERS に行が無い）");
    else if (r.key === "station_state") gaps.push("② 使ったの目印がいつも決められない（null）");
    if (!r.want) gaps.push("③ 反映の目当てが無い（目当ての AIX を決められない・返信の文の印が無い）");
    return { key: r.key, name: r.name, owner: r.owner, hold: r.mark ? has.length : null, head: r.mark ? head.length : null, usedOk, usedOf, reflectOk, reflectOf, gaps };
  });
}
/** 毎朝の1枚: 土台（CONDUCTOR_DUTY の行）の段の下に部品ごとの数を1行（受け持ち表は1つの題・2026-11-26 統括役の決め） */
export function dutyPartLine(partKeys: readonly string[] | undefined, cs: readonly OwnCount[]): string {
  const ps = (partKeys ?? []).map((k) => cs.find((c) => c.key === k)).filter((c): c is OwnCount => !!c);
  if (!ps.length) return "";
  return `    - 部品の数（番ごと）: ${ps.map((c) => `${c.name.replace(/（.*$/, "")} 持つ ${c.hold ?? "印なし"}・使った ${c.usedOf ? `${c.usedOk}/${c.usedOf}` : "—"}・反映 ${c.reflectOf ? `${c.reflectOk}/${c.reflectOf}` : "—"}`).join("｜")}`;
}
/** 毎朝の1枚の行（台本の出力用） */
export function ownershipLines(cs: readonly OwnCount[], decisions: number, marked: number): string[] {
  return [`### 統括の受け持ち・部品ごとの数（持つ／使う／反映する・判断の記録 ${decisions}番・材料の印のある番 ${marked}）`,
    ...cs.map((c) => `- ${c.name}: 持つ ${c.hold ?? "印なし"}・先頭 ${c.head ?? "—"}・使った ${c.usedOf ? `${c.usedOk}/${c.usedOf}` : "—"}・反映 ${c.reflectOf ? `${c.reflectOk}/${c.reflectOf}` : "—"}${c.gaps.length ? `｜欠け ${c.gaps.map((g) => g.slice(0, 2)).join("")}` : ""}`)];
}
