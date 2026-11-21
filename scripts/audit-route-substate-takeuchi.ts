// scripts/audit-route-substate-takeuchi.ts — 駅の中の細かい状態の網（turn-aims-after.matchSubstateOf）が、竹内さんの実際の番と当たるかを状態ごとに数える
//   （読むだけ・LLM なし・DB なし・費用 0・作業員M・2026-11-21・台帳 #467 の (2)）
//   竹内さん「ここの部分ちゃんと使えるように・質もかなり上げられるように・徹底的に細部まで」（統括役の頼み）。
//   APPLY_ROUTE_SUBSTATE の凍結（#6・11/12）の理由は「外れ」ではなく「ブレインの材料に置くと道が寄った」（KB c5fd146d）。
//   → 道の後に指示書へ渡す（ROUTE_TO_BRIEF）前に、状態ごとに「網が当たった番で、竹内さんの誘導先と仕込みが状態の表と合うか」を測り、合わない状態を外す線（ROUTE_SUBSTATE_DENY）を決める。
//   材料: exam-cache/anatomy-roles/roles-r1.json（竹内さん本人の198通・伏せ済み・customer＝お客様の文・sentences＝竹内さんの文・lead_to＝誘導先）。
//     ⚠ 198通は状態の表を作った元の番（同じ番で測る＝甘く出る）。本当の当たりは --turns=<別の番の json>（11/04 以降の番）か夜の DB の数えで見る。
//   出す物: 状態ごとの 網の当たり数・誘導先の一致（表の lead に挙がった先に入る割合／一番多い先と同じ割合）・仕込みの一致（表の仕込みの語が竹内さんの文にある割合）・使う/外すの案
//   本文は出さない（数と id の頭8字だけ）。
// 実行: npx tsx scripts/audit-route-substate-takeuchi.ts [--labels=<majority json> --gists=<gists json>] [--in=<roles json>] [--min-n=4] [--min-lead=0.5] [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchSubstateOf } from "../app/lib/turn-aims-after";
import { SUBSTATES, type Plant } from "../app/lib/apply-route-substate";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(__dirname, "..", "..", "..", "exam-cache");
type Row = { id: string; scene?: string; customer?: string; sentences?: string[]; lead_to?: string | null; main_role?: string | null };

/** 表の lead（説明の文）→ 誘導先の語（roles-r1 の lead_to と同じ名前） */
export function leadSetOf(lead: string): { set: string[]; top: string | null } {
  const pairs: Array<[RegExp, string]> = [[/関係をつなぐ/, "keep"], [/内覧/, "viewing"], [/申込/, "apply"], [/見積/, "estimate"], [/答えだけ/, "answer_only"], [/送ってもらう|ask_send/, "ask_send"]];
  const parts = lead.split("・").map((p) => p.trim()).filter(Boolean);
  const set: string[] = []; let top: string | null = null;
  for (const p of parts) { const hit = pairs.find(([re]) => re.test(p)); if (hit && !set.includes(hit[1])) { set.push(hit[1]); if (!top) top = hit[1]; } }
  return { set, top };
}
/** 仕込みの型 → 竹内さんの文に出る語（網・言い回しの写しではなく語の手がかり） */
export const PLANT_CUE: Readonly<Record<Plant, RegExp>> = {
  scarcity: /1部屋|一部屋|お問い?合わせ(?:が|も)多|先に(?:お申込|申込)が入/, hold_before_viewing: /抑え/, support: /全力|サポート|ご満足/,
  cost: /割引|初期費用|お安く|抑えられ/, screening: /審査|保証会社/, timing: /入居日|30日|ご入居(?:の)?時期|入居可能/, ask_send: /お送り(?:頂|いただ)|送って(?:頂|いただ)/,
};

/** 作る半分と測る半分（id の頭の16進の偶奇・決まった分け方）。網の直しは tune の番だけ見て作り、measure の番で当たりを出す */
export const halfOf = (id: string): "tune" | "measure" => (parseInt(id.replace(/[^0-9a-f]/gi, "").slice(-2) || "0", 16) % 2 === 0 ? "tune" : "measure");

/** --labels=<majority json>（route-substate-label.ts）がある時: 網の当たり（状態ごとの 網が言った数・そのうち正しい・正解の数・網が拾えた）を半分ごとに */
function netVsLabels(labelsPath: string, turnsPath: string) {
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string>;
  const gists = JSON.parse(readFileSync(turnsPath, "utf8")) as Record<string, string>; // {id: お客様の今の連投（伏せ済み）}（夜に label の台本と同じ材料から作る）
  for (const half of ["tune", "measure"] as const) {
    const st = new Map<string, { said: number; right: number; truth: number; got: number }>();
    const g = (k: string) => st.get(k) ?? st.set(k, { said: 0, right: 0, truth: 0, got: 0 }).get(k)!;
    let n = 0;
    for (const [id, truth] of Object.entries(labels)) {
      if (halfOf(id) !== half || gists[id] === undefined) continue;
      n++;
      const net = matchSubstateOf(gists[id])?.id ?? "none";
      if (net !== "none") { g(net).said++; if (net === truth) g(net).right++; }
      if (truth !== "none") { g(truth).truth++; if (net === truth) g(truth).got++; }
    }
    console.log(`\n# ${half} の半分 ${n}番: 状態\t網が言った\tそのうち正しい\t正解の数\t網が拾えた`);
    for (const s of SUBSTATES) { const x = st.get(s.id); if (x) console.log(`${s.id}\t${x.said}\t${x.right}（${x.said ? Math.round((x.right / x.said) * 100) : 0}%）\t${x.truth}\t${x.got}（${x.truth ? Math.round((x.got / x.truth) * 100) : 0}%）`); }
  }
}

function main() {
  if (arg("labels")) { netVsLabels(arg("labels"), arg("gists")); return; }
  const inPath = arg("in", join(CACHE, "anatomy-roles", "roles-r1.json"));
  const rows = JSON.parse(readFileSync(inPath, "utf8")) as Row[];
  const minN = Number(arg("min-n", "4")) || 4;
  const minLead = Number(arg("min-lead", "0.5")) || 0.5;
  const by = new Map<string, { n: number; leadIn: number; leadTop: number; plantAny: number; plantAll: number; ids: string[]; leads: Record<string, number> }>();
  let none = 0;
  for (const r of rows) {
    const s = matchSubstateOf(r.customer ?? "");
    if (!s) { none++; continue; }
    const st = by.get(s.id) ?? { n: 0, leadIn: 0, leadTop: 0, plantAny: 0, plantAll: 0, ids: [], leads: {} };
    st.n++; st.ids.push(r.id.slice(0, 8));
    const lt = String(r.lead_to ?? "null"); st.leads[lt] = (st.leads[lt] ?? 0) + 1;
    const { set, top } = leadSetOf(s.lead);
    if (set.includes(lt)) st.leadIn++;
    if (top === lt) st.leadTop++;
    const text = (r.sentences ?? []).join("\n");
    if (s.plants.length) {
      const hits = s.plants.filter((p) => PLANT_CUE[p].test(text));
      if (hits.length) st.plantAny++;
      if (hits.length === s.plants.length) st.plantAll++;
    }
    by.set(s.id, st);
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  const out: Array<Record<string, unknown>> = [];
  console.log(`材料 ${rows.length} 通（${inPath.split(/[\\/]/).slice(-2).join("/")}）・網に当たらない ${none}`);
  console.log("状態\t表のn\t網n\t誘導先が表の先に入る\t一番多い先と同じ\t仕込み1つ以上\t仕込み全部\t竹内さんの誘導先\t案");
  for (const s of SUBSTATES) {
    const st = by.get(s.id);
    const n = st?.n ?? 0;
    const leadRate = st && n ? st.leadIn / n : 0;
    const plantRate = st && n && s.plants.length ? st.plantAny / n : null;
    const use = n >= minN && leadRate >= minLead && (plantRate === null || plantRate >= 0.3);
    const why = n < minN ? `網の当たりが ${n}（${minN} 未満＝測れない）` : leadRate < minLead ? `誘導先の一致 ${pct(st!.leadIn, n)}` : plantRate !== null && plantRate < 0.3 ? `仕込みの一致 ${pct(st!.plantAny, n)}` : "当たる";
    console.log([s.id, s.n, n, st ? pct(st.leadIn, n) : "-", st ? pct(st.leadTop, n) : "-", st && s.plants.length ? pct(st.plantAny, n) : "-", st && s.plants.length ? pct(st.plantAll, n) : "-", st ? JSON.stringify(st.leads) : "-", use ? "使う" : `外す（${why}）`].join("\t"));
    out.push({ id: s.id, table_n: s.n, few: !!s.few, net_n: n, lead_in: st?.leadIn ?? 0, lead_top: st?.leadTop ?? 0, plant_any: st?.plantAny ?? 0, plant_all: st?.plantAll ?? 0, leads: st?.leads ?? {}, use, why, ids: st?.ids.slice(0, 6) ?? [] });
  }
  const deny = out.filter((x) => !x.use).map((x) => x.id);
  console.log(`\nROUTE_SUBSTATE_DENY の案（${deny.length}）: ${deny.join(",")}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ at: new Date().toISOString(), in: inPath, total: rows.length, none, minN, minLead, rows: out, deny }, null, 2));
}
main();
