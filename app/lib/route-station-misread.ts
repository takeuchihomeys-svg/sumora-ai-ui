// app/lib/route-station-misread.ts — 申込までの地図の「今どこ」の読み違いを、決まった線で番ごとに見つける（純関数・DB/LLM なし）
//
// 2026-11-23 作業員A（竹内さん 11/23・P0・台帳 #657「地図の部分もちゃんとするのといまどこなのか現状把握して申込までの地図進めれるように」）:
//   地図が読んだ駅（R の audit-route-progress-takeuchi の node）を、竹内さん本人がそれまでに送った物（AIX の種類）と内覧の日で確かめる。
//   読み違いが多い駅ほどブレインの長期の思考（道筋・KB 2d1c4c74）が外れる。型ごとに毎朝数える（route:station_misread:<型>）。
// 型（決まった線・作らない側に倒す）:
//   after_estimate … 竹内さんが前の番で御見積書を送った（aix:estimate_sheet）のに、駅が見積より前（ピックアップ・提案・気に入った）
//   after_meeting_place … 待ち合わせ場所を送った（aix:meeting_place）のに、駅が内覧予定より前
//   after_viewing_invite … 内覧調整を送った（aix:viewing_invite）のに、駅が内覧調整より前（条件ヒアリング・ピックアップ・提案）
//   viewing_passed … 駅が内覧予定のまま、内覧の日（detail の M/D）が番の日より前
//   ・分かれ道が開いている番・お客様が条件を言い直した番（rt=condition_feedback・other_property）は戻りが正しいので数えない
//   ・前の番から30日より後の送付は数えない（話が切れて探し直しの事がある）
export type MisreadRow = { conv: string; at: string; node: string | null; branch: string | null; act: string; rt?: string | null; detail?: string | null };
export type MisreadKind = "after_estimate" | "after_meeting_place" | "after_viewing_invite" | "viewing_passed";
export const MISREAD_JA: Record<MisreadKind, string> = {
  after_estimate: "御見積書を送った後なのに見積より前の駅",
  after_meeting_place: "待ち合わせ場所を送った後なのに内覧予定より前の駅",
  after_viewing_invite: "内覧調整を送った後なのに内覧調整より前の駅",
  viewing_passed: "内覧の日が過ぎたのに内覧予定のまま",
};
const ORDER = ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying"];
const idx = (n: string | null | undefined) => (n ? ORDER.indexOf(n) : -1);
const SENT_FLOOR: Record<string, { kind: MisreadKind; floor: string }> = {
  estimate_sheet: { kind: "after_estimate", floor: "estimate" },
  meeting_place: { kind: "after_meeting_place", floor: "viewing_scheduled" },
  viewing_invite: { kind: "after_viewing_invite", floor: "viewing_arrange" },
};
const BACK_OK_RT = new Set(["condition_feedback", "other_property"]);
const WINDOW_MS = 30 * 864e5;

function viewingPassed(r: MisreadRow): boolean {
  const m = String(r.detail ?? "").match(/(\d{1,2})\/(\d{1,2})/);
  const t = Date.parse(r.at);
  if (!m || !Number.isFinite(t)) return false;
  const j = new Date(t + 9 * 3600e3);
  const y = j.getUTCFullYear(), mo = Number(m[1]), d = Number(m[2]);
  const yy = mo > j.getUTCMonth() + 1 + 6 ? y - 1 : y; // 1月の番で12月の内覧
  return Date.UTC(yy, mo - 1, d) < Date.UTC(y, j.getUTCMonth(), j.getUTCDate());
}

/** 番ごとの読み違い（会話ごとに時刻の順で前の番の送付を覚える） */
export function stationMisreadsOf(rows: ReadonlyArray<MisreadRow>): Array<{ conv: string; at: string; node: string | null; kind: MisreadKind }> {
  const out: Array<{ conv: string; at: string; node: string | null; kind: MisreadKind }> = [];
  const byConv = new Map<string, MisreadRow[]>();
  for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
  for (const rs of byConv.values()) {
    const sorted = [...rs].sort((a, b) => a.at.localeCompare(b.at));
    const sent = new Map<MisreadKind, { floor: string; at: number }>();
    for (const r of sorted) {
      const t = Date.parse(r.at);
      if (r.node === "viewing_scheduled" && !r.branch && viewingPassed(r)) out.push({ conv: r.conv, at: r.at, node: r.node, kind: "viewing_passed" });
      else if (!r.branch && !BACK_OK_RT.has(String(r.rt ?? ""))) {
        // 一番強い（駅の順が先の）送付から見る・当たった型を1つだけ
        const hit = [...sent.entries()].filter(([, v]) => t - v.at <= WINDOW_MS && idx(r.node) >= 0 && idx(r.node) < idx(v.floor)).sort((a, b) => idx(b[1].floor) - idx(a[1].floor))[0];
        if (hit) out.push({ conv: r.conv, at: r.at, node: r.node, kind: hit[0] });
      }
      const k = String(r.act).startsWith("aix:") ? String(r.act).slice(4).split("/")[0] : "";
      const f = SENT_FLOOR[k];
      if (f) sent.set(f.kind, { floor: f.floor, at: t });
      if (BACK_OK_RT.has(String(r.rt ?? ""))) sent.clear(); // 条件の言い直しの後は探し直し＝前の送付は覚えない
    }
  }
  return out;
}

/** 毎朝の1枚の行（route:station_misread:<型> は件数・route:station_misread は全部の番に対する割合） */
export function misreadMetricRowsOf(rows: ReadonlyArray<MisreadRow>): Array<{ metric: string; value: number | null; n: number }> {
  const ms = stationMisreadsOf(rows);
  const n = rows.length;
  const out = [{ metric: "route:station_misread", value: n ? Math.round((ms.length / n) * 1000) / 10 : null, n }];
  for (const k of Object.keys(MISREAD_JA) as MisreadKind[]) out.push({ metric: `route:station_misread:${k}`, value: ms.filter((m) => m.kind === k).length, n });
  return out;
}
