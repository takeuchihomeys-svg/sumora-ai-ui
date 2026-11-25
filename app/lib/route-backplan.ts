// app/lib/route-backplan.ts — 申込から逆算した計画（台帳 #745・決まった計算・LLM なし・材料の1行）
// 2026-11-25 作業員A（竹内さん 11/25 夜「地図は次の一手分かるけど2手先やこのままの最善の方法もちゃんと把握できるようになっているのか？
//   実際の営業マンの思考のように逆算してイメージできているのか」・統括役の設計）:
//   今ブレインに渡るのは本線の駅の並び・今どこ・次の一手の候補1つだけ。申込から逆算した「申込までに要る物（済み／まだ／分からない）・このお客様に合う道（内覧あり／なし）・
//   2手先3手先の駅・そこへ行くために今の番で仕込む一言・入居の時期からの申込の目安」を決まった計算で1行にする。
//   q406・q065・q425 の前例（ブレインの出力に欄を足すと道がずれた）を踏まえ、ブレインには書かせず材料として渡すだけ（道を決めるのはブレイン）。
//   道の選び方の元: 作業員L の #728 成約データ（申込の約65%は内覧の記録なし＝推定の申込27件を外して 77/119・内覧に入った件の申込到達は約2倍・申込→成約の中央 21.8日）
//   スイッチ APPLY_ROUTE_BACKPLAN: 既定 off（材料に入れない）／on
import { MAIN_ROUTE, ROUTE_NODES, type RouteNodeId } from "./apply-route-map";

export function applyRouteBackplanOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.APPLY_ROUTE_BACKPLAN ?? "").trim().toLowerCase() === "on";
}
export type BackplanFacts = {
  node: RouteNodeId | null;
  /** 主のお部屋が決まっている（customer-state.focusKey） */ focus: boolean;
  /** 送った物件の数（行動台帳） */ propertiesSent: number;
  /** 主のお部屋か、どれかに御見積書を送った */ estimateSent: boolean;
  /** 内覧の日時が決まっている／内覧が済んだ */ viewingScheduled: boolean; viewingDone: boolean;
  /** お客様が内覧を望んだ（今の通か前の通） */ viewingWish: boolean;
  /** お客様が申込の意思を示した（今の通の型 apply_intent） */ applyIntent: boolean;
  /** 審査の不安が開いている（審査の語・答えの後の受けが無い） */ screeningConcern: boolean;
  /** 入居の時期（YYYY-MM-DD・条件の入居時期の先頭）と今日（JST の YYYY-MM-DD） */ moveInYmd: string | null; todayYmd: string;
};
export type Backplan = { path: "内覧あり" | "内覧なし"; why: string; needs: Array<{ label: string; state: "済み" | "まだ" | "分からない" }>; ahead: RouteNodeId[]; plant: string | null; applyBy: string | null;
  /** 2026-11-26 #745 の直し②: ゴール側の仕込みの一言（竹内さん本人の60日の文の型） */ goalPlant: string | null;
  /** 2026-11-26 #745 の直し③: 日付の目安（幅・言い切らない）と、分からないので聞く事 */ dates: string[]; asks: string[] };

const VIEW_NODES: ReadonlySet<RouteNodeId> = new Set(["viewing_arrange", "viewing_scheduled", "viewed"]);
/** 2手先・3手先の駅に向けて、今の番で仕込む一言の例（竹内さんの実送信の言い回しの型・押し付けない一文） */
const PLANT: Partial<Record<RouteNodeId, string>> = {
  pickup: "ご条件に合ったお部屋をピックアップしてお送りすると添える",
  proposing: "気になるお部屋があればお気軽にお知らせくださいと添える",
  interested: "気になるお部屋は募集状況の確認と最大限割引の御見積書をお送りできると添える",
  estimate: "最大限割引した御見積書をお作りできると添える",
  viewing_arrange: "ご都合のよろしい日にご内覧頂けると添える",
  viewing_scheduled: "当日は待ち合わせ場所でお待ちしていると添える",
  viewed: "お気に召されましたらお申込でお部屋を抑えられると添える",
  apply_prep: "お申込はフォーマットと本人確認書類で進められると添える",
};
/**
 * 2026-11-26 #745 の直し①（竹内さん「２番手先のあたり弱い原因は？」・audit-route-backplan-miss）: この先は成約データの太い道で出す。
 *   本線の次の2駅で固定だと、1手先の外れ 50 のうち 19 が「駅を飛ばした」（提案中→見積・ヒアリング→提案中 等）。作業員L の #728 の申込に届いた型:
 *   物件送り→見積→申込／見積→申込（内覧なし）／物件送り→申込・内覧に入った件は 物件送り→見積→内覧の日時→内覧した→申込。
 *   ＝気に入った（interested）は飛ばされやすい・見積の先は内覧か申込
 */
export const THICK_PATH: Partial<Record<RouteNodeId, { viewing: RouteNodeId[]; noViewing: RouteNodeId[] }>> = {
  inquiry: { viewing: ["hearing", "pickup", "proposing"], noViewing: ["hearing", "pickup", "proposing"] },
  hearing: { viewing: ["pickup", "proposing", "estimate"], noViewing: ["pickup", "proposing", "estimate"] },
  pickup: { viewing: ["proposing", "estimate", "viewing_arrange"], noViewing: ["proposing", "estimate", "apply_prep"] },
  proposing: { viewing: ["estimate", "viewing_arrange", "viewing_scheduled"], noViewing: ["estimate", "apply_prep"] },
  interested: { viewing: ["estimate", "viewing_arrange", "viewing_scheduled"], noViewing: ["estimate", "apply_prep"] },
  estimate: { viewing: ["viewing_arrange", "viewing_scheduled", "viewed"], noViewing: ["apply_prep"] },
  viewing_arrange: { viewing: ["viewing_scheduled", "viewed", "apply_prep"], noViewing: ["viewing_scheduled", "viewed", "apply_prep"] },
  viewing_scheduled: { viewing: ["viewed", "apply_prep"], noViewing: ["viewed", "apply_prep"] },
  viewed: { viewing: ["apply_prep"], noViewing: ["apply_prep"] },
};
export function aheadOf(node: RouteNodeId, path: "内覧あり" | "内覧なし"): RouteNodeId[] {
  const t = THICK_PATH[node];
  if (t) return (path === "内覧なし" ? t.noViewing : t.viewing).slice(0, 3);
  const i = MAIN_ROUTE.indexOf(node);
  return (i >= 0 ? MAIN_ROUTE.slice(i + 1) : []).filter((n) => path === "内覧あり" || !VIEW_NODES.has(n)).slice(0, 3);
}
/**
 * 2026-11-26 #745 の直し②: ゴール側の仕込みの一言（竹内さん本人の60日の文から抜いた型・audit で多い順）。竹内さんは2手より先（見積・申込）を早くから仕込む
 *   （仕込みの言葉がある番 38 のうち、地図の この先 に竹内さんの狙いが入っていたのは 17）。
 *   申込: 「お気に召されましたらお申込しお部屋抑えさせて頂きます」（60日で最も多い・12回＋言い換え）
 *   見積: 「確認出来次第、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます」（9回）
 */
export const GOAL_PLANT: Partial<Record<RouteNodeId, string>> = {
  estimate: "「確認出来次第、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます」の型（竹内さん本人の60日の文で多い）",
  apply_prep: "「お気に召されましたらお申込しお部屋抑えさせて頂きます」の型（竹内さん本人の60日の文で一番多い）",
};
const ymdAdd = (ymd: string, days: number) => { const t = Date.parse(`${ymd}T00:00:00+09:00`) + days * 86_400_000; return new Date(t + 9 * 3_600_000).toISOString().slice(0, 10); };

/** 計画（純関数）。駅が分からない・申込以降は null */
export function backplanOf(f: BackplanFacts): Backplan | null {
  if (!f.node || f.node === "applying" || f.node === "won" || f.node === "apply_prep") return null;
  const viewingPath = f.viewingScheduled || f.viewingDone || f.viewingWish || VIEW_NODES.has(f.node);
  const path: Backplan["path"] = !viewingPath && f.applyIntent ? "内覧なし" : "内覧あり";
  const why = path === "内覧なし" ? "申込の意思が出ていて内覧の希望が無い（成約データ: 申込の約65%は内覧の記録なし＝推定の申込を外して 77/119）"
    : viewingPath ? "内覧の希望・予定・実施がある" : "まだ決め手が無い＝内覧を勧める本線（内覧に入った件の申込到達は約2倍）";
  const needs: Backplan["needs"] = [
    { label: "物件が決まる", state: f.focus ? "済み" : f.propertiesSent > 0 ? "まだ" : "まだ" },
    { label: "見積の了承", state: f.estimateSent ? "分からない" : "まだ" },
    ...(path === "内覧あり" ? [{ label: "内覧", state: (f.viewingDone ? "済み" : f.viewingScheduled ? "分からない" : "まだ") as "済み" | "まだ" | "分からない" }] : []),
    { label: "審査の不安の解消", state: f.screeningConcern ? "まだ" : "分からない" },
  ];
  const ahead = aheadOf(f.node, path);
  const plant = ahead[1] ? PLANT[ahead[1]] ?? null : ahead[0] ? PLANT[ahead[0]] ?? null : null;
  // 申込の目安（11/26 統括役の注意）: 申込→成約の 21.8日は「成約の印まで」で入居日とは限らない＝入居希望日から幅で出す（申込から入居まで普通は3〜4週間・目安）
  const applyBy = f.moveInYmd && f.moveInYmd > f.todayYmd ? `${ymdAdd(f.moveInYmd, -28)}〜${ymdAdd(f.moveInYmd, -21)}` : null;
  // ゴール側: この先の中で一番先の 見積か申込準備（無ければ申込準備）
  const goalNode = [...ahead].reverse().find((n) => GOAL_PLANT[n]) ?? (MAIN_ROUTE.indexOf(f.node) < MAIN_ROUTE.indexOf("apply_prep") ? "apply_prep" : null);
  const goalPlant = goalNode ? GOAL_PLANT[goalNode] ?? null : null;
  // 日付の目安（決まった計算・幅・言い切らない）と聞く事（分からない欄）
  const dates: string[] = [], asks: string[] = [];
  if (f.moveInYmd && f.moveInYmd > f.todayYmd) {
    if (applyBy) dates.push(`申込の目安 ${applyBy} 頃`);
    if (path === "内覧あり" && !f.viewingDone && !f.viewingScheduled) dates.push(`内覧の目安 ${ymdAdd(f.moveInYmd, -35)}〜${ymdAdd(f.moveInYmd, -24)} 頃（申込の目安の少し前）`);
    if (!f.focus && f.propertiesSent === 0) dates.push("物件出しは今週");
    asks.push("今のお住まいの解約の予告の時期（1か月前の所が多い・目安）");
  } else asks.push("ご入居の時期（いつ頃までに住み始めたいか）");
  if (path === "内覧あり" && !f.viewingDone && !f.viewingScheduled && f.node && VIEW_NODES.has(f.node)) asks.push("ご内覧のご都合のよろしい日");
  return { path, why, needs, ahead, plant, applyBy, goalPlant, dates, asks };
}
/**
 * 2026-11-26 作業員A（#745・竹内さん「返信の内容も実際の竹内の言い回しに逆算のところちゃんと行えばよりよくなる」）: 書き手への1行。
 *   逆算の期日（幅・言い切らない）と、竹内さん本人の仕込みの言い回しの型を、書き手の材料に1行で渡す。お客様が聞いていない内覧・申込を押し付けない・1文だけ。
 *   スイッチ BACKPLAN_TO_WRITER: 既定 off（書き手に渡さない）／on
 */
export function backplanToWriterOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BACKPLAN_TO_WRITER ?? "").trim().toLowerCase() === "on";
}
export type BackplanRec = { path: string; ahead: string[]; goalPlant: string | null; plant: string | null; dates: string[] };
export function backplanRecOf(p: Backplan | null): BackplanRec | null {
  return p ? { path: p.path, ahead: p.ahead, goalPlant: p.goalPlant, plant: p.plant, dates: p.dates } : null;
}
export function backplanWriterNote(rec: unknown): string {
  const r = rec as BackplanRec | null | undefined;
  if (!r || (!r.goalPlant && !r.dates?.length)) return "";
  return `\n【申込から逆算した仕込み（決まった計算・期日は目安）】${r.goalPlant ? `言い回しの型: ${r.goalPlant}` : ""}${r.dates?.length ? `${r.goalPlant ? "／" : ""}期日の目安: ${r.dates.join("・")}` : ""}`
    + "。入れる時は文の終わりの方に自然に1文だけ（言い切らない・お客様が聞いていない内覧や申込を押し付けない・期日は「頃」「目安」）。合わない番は入れない";
}
/** 材料の1行（当たらない時は ""）。道はブレインが決める＝「例」「目安」と書く */
export function backplanLine(p: Backplan | null): string {
  if (!p) return "";
  const ahead = p.ahead.map((n) => ROUTE_NODES[n].name).join("→");
  return `【申込から逆算した計画（決まった計算・材料・道はあなたが決める）】道: ${p.path}（${p.why}）／申込までに要る物: ${p.needs.map((n) => `${n.label} ${n.state}`).join("・")}`
    + `${ahead ? `／この先（成約データの太い道）: ${ahead}` : ""}${p.plant ? `／2手先へ向けて今の番で仕込む一言の例: ${p.plant}` : ""}${p.goalPlant ? `／ゴール側の一言の例: ${p.goalPlant}` : ""}${p.dates.length ? `／日付の目安（幅・言い切らない）: ${p.dates.join("・")}` : ""}${p.asks.length ? `／分からないので聞く事: ${p.asks.join("・")}` : ""}${p.applyBy ? `／申込の目安: ${p.applyBy} 頃（目安・申込から入居まで普通は3〜4週間・言い切らない）` : ""}`;
}
