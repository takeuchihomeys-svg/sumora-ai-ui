// app/lib/metric-map.ts — 数ごとの地図（木）と見込みの突き合わせ（純関数だけ・LLM なし・作業員P・2026-11-23・台帳 #610）
//
// 竹内さん 11/23「この予測と今の部分と次の部分を把握するように連携するように。ちゃんと細部までこだわって土台を作って、細部まで改善していく」
//   「このようにちゃんと地図は細分化して強化して導いていけるように」「テストの部分のブレインも理解した方が良いのではないか」。
//   1つの数（例: AIX の番の一致）を、外れの元が分かる所まで子に割った木にする（数 → AIX の種類 → 場面 → 外れの型 → 原因）。
//   葉ごとに 今の値・n・見込み・動かす作業（段・スイッチ）・次の一手・止まっている理由 を持たせ、伸びしろ（外れの番 × 直せる見込み）で順位を付けて「次の一手」を導く。
//   木の形は表（MAP_ROOTS）で持つ＝組の一致・返信の一致・申込までの道筋も同じ型で足せる（builder を足すだけ）。
//   書き手の選び方（writer_select）: style＝文の癖（verdict_detail.staff_writer）／device＝端末の記録（作業員N2 の core:conductor_aix_device）。
//     11/23 統括役: 文の癖で選ぶと AIX の番の約半分（60日 193中93）は端末では従業員の番＝数え方が変わり得る。見込みの突き合わせは同じ選び方どうしで比べる。
// 置き場: 木の1日分は metric_map_nodes（scripts/lib/metric-map-server.ts が書く）・見込みは work_items.forecast_*・要点は quality_daily の map:* / forecast:*。
// 葉の鍵: <根の数の名前>/<段>=<値>/… 例 core:conductor_aix_60d/kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=material

export type WriterSelect = "style" | "device" | "all";
export type MapDim = "kind" | "scene" | "miss" | "cause" | "station";
/** 原因の4つ（CLAUDE.md 絶対的な考え方の3つ＋数え方の誤り） */
export type MapCause = "material" | "misread" | "aix_turn_as_reply" | "counting";
export const MAP_CAUSE_JA: Record<MapCause, string> = {
  material: "材料が届いていない", misread: "場面や決まりの読み違い", aix_turn_as_reply: "返信か AIX かの判断の誤り（AIX の番を返信に）", counting: "数え方の誤り",
};
export const MAP_CAUSES = Object.keys(MAP_CAUSE_JA) as MapCause[];
// 2026-11-23 統括役（2回目）: 端末の版（作業員A の audit-aix-turn-judgment）の「先後」と、申込までの地図（作業員R の routeAgreement）の外れの型を足した
export type MapMiss = "ok" | "reply_not_aix" | "aix_kind" | "order" | "push_missed" | "other_aix" | "pushed_off_map";
export const MAP_MISS_JA: Record<MapMiss, string> = {
  ok: "一致", reply_not_aix: "AIX を返信にした", aix_kind: "AIX の種類違い", order: "先後（竹内さんは2段・ブレインは今 AIX）",
  push_missed: "地図は AIX で進める・竹内さんは返信", other_aix: "地図と違う AIX", pushed_off_map: "地図は返信・竹内さんは AIX で動かした",
};
export const DIM_JA: Record<MapDim, string> = { kind: "AIX の種類", scene: "場面", miss: "外れの型", cause: "原因", station: "駅" };

export type MapRootDef = {
  metric: string; label: string; writerSelect: WriterSelect; windowDays: number;
  dims: MapDim[];
  /** 子の割り方を作る道具（無い根は数だけ並べる＝割り方はまだ） */
  builder: "conductor_aix" | "aix_turn_device" | "route_next" | null;
  /** 主の根（同じ数の版が2つある時に先に出す・順位の元）。compare は並べて見る相手の根 */
  primary?: boolean; compare?: string;
  /** 作業の葉・試験の問題の葉が別の根の名前で書かれている時の、その根（端末の版は文の癖の版の葉の鍵で作業と試験の問題を受ける） */
  rebaseFrom?: string[];
  /** 数の出所（数え方を勝手に作らない） */
  source: string; owner: string;
  /** quality_daily の範囲（scope） */
  qdScope: "takeuchi" | "all" | "draft";
  /** metric を前方一致の名前の束として読む（欄ごとの数がまとめて増える根） */
  prefix?: boolean;
};
/** 根の表（数の名前と割り方）。数え方は出所のスクリプトと同じ物だけを置く */
export const MAP_ROOTS: MapRootDef[] = [
  // 2026-11-23 統括役（2回目）: 主は端末の版（下の aix_turn:match_60d_device）。文の癖の版は「並べて見る」用
  { metric: "core:conductor_aix_60d", label: "AIX の番の一致（文の癖で選んだ竹内さんの番・60日・送る直前の判断・並べて見る用）", writerSelect: "style", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "conductor_aix", compare: "aix_turn:match_60d_device",
    source: "scripts/check-conductor.ts --days=60 の aixScore（core:conductor_aix の 60日版・11/23 の 44.8%＝43/96）", owner: "作業員A", qdScope: "all" },
  { metric: "core:conductor_aix_device", label: "AIX の番の一致（端末の記録で選んだ竹内さんの番）", writerSelect: "device", windowDays: 60, dims: [], builder: null,
    source: "作業員N2 が書く予定（core:conductor_aix_device）", owner: "作業員N2", qdScope: "all" },
  { metric: "core:conductor_aix", label: "AIX の番の一致（7日・毎朝の芯）", writerSelect: "style", windowDays: 7, dims: [], builder: null,
    source: "scripts/check-conductor.ts（self-improve の芯 ④）", owner: "作業員N", qdScope: "all" },
  { metric: "growth:combo:組の一致", label: "返信と AIX の組の一致（竹内さん本人の番・14日）", writerSelect: "style", windowDays: 14, dims: [], builder: null,
    source: "scripts/lib/combo-daily.ts（self-improve の伸びしろ）", owner: "作業員A", qdScope: "takeuchi" },
  { metric: "reply_match", label: "返信の一致（竹内さんの番・1日）", writerSelect: "style", windowDays: 1, dims: [], builder: null,
    source: "self-improve measureDay（line_watch_turns の verdict）", owner: "作業員N", qdScope: "takeuchi" },
  // 2026-11-23 作業員R（台帳 #608）: 申込までの地図の候補と竹内さんの一手の一致（60日・申込以降を外した 84会話 262番で 151＝58%）。quality_daily にはまだ書かれていない（R が書く名前をここに合わせる）
  //   11/23（2回目）: 駅 → 外れの型 → 原因 に割った（R の json の agree・route_next）。R の台本が main に入るまでは json から作った木を読む
  { metric: "route:next_match_60d", label: "申込までの地図 › 候補と竹内さんの一手の一致（60日）", writerSelect: "all", windowDays: 60, dims: ["station", "miss", "cause"], builder: "route_next",
    source: "scripts/audit-route-progress-takeuchi.ts（作業員R・0c4f04c5d・messages.staff_writer=takeuchi）", owner: "作業員R", qdScope: "takeuchi" },
  // 2026-11-23 作業員A（a-aix-1123・9b02a11eb）: 端末の記録で選んだ竹内さん本人の AIX の番（60日・2段・手打ちも数える別の数え方）102番中 56＝54.9%。style の 44.8% と混ぜない
  //   11/23（2回目）: 主の根。種類 → 場面 → 外れの型 → 原因 に割った（aix_turn_device・A の json の行＋見張りの scene_key）
  { metric: "aix_turn:match_60d_device", label: "AIX の番の一致（端末の記録で選んだ竹内さんの番・2段と手打ちも数える・60日・主）", writerSelect: "device", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "aix_turn_device",
    primary: true, compare: "core:conductor_aix_60d", rebaseFrom: ["core:conductor_aix_60d"],
    source: "scripts/audit-aix-turn-judgment.ts（作業員A・枝 a-aix-1123）", owner: "作業員A", qdScope: "takeuchi" },
  // 2026-11-23 作業員N2: 作業員L の統括→書き手の欄ごとの届き方（#466・#7）。欄の名前は前方一致でまとめて並べる（scope=draft）
  { metric: "writer_link:", label: "統括 → 書き手の届き方（欄ごと・72時間）", writerSelect: "all", windowDays: 3, dims: [], builder: null, prefix: true,
    source: "self-improve（作業員N2・writer_link:field:<欄>:delivered／in_draft・writer_link:brief:<欄>:in_draft・writer_link:timeline:<欄>:to_brain／to_writer）", owner: "作業員L", qdScope: "draft" },
  // 2026-11-23 作業員M（#619・#620）: 申込までの地図の駅 › 駅の中の状態の食い違い（2版の網 34/102）・判断の記録の段（digest.sg）との一致（105/193＝54%）。毎日の数はまだ
  { metric: "route:substate_mismatch_v2", label: "申込までの地図 › 駅の中の状態と地図の駅の食い違い（2版の網・60日・0 に向かう）", writerSelect: "all", windowDays: 60, dims: [], builder: null,
    source: "scripts/audit-route-progress-takeuchi.ts の json に route-record.ts の表を当てた数（作業員M・#619）", owner: "作業員M", qdScope: "takeuchi" },
  { metric: "route:sg_match", label: "申込までの地図 › 地図の駅と判断の記録の段（digest.sg）の一致（sg の時代＝11/03 05:41Z 以降だけ）", writerSelect: "all", windowDays: 60, dims: [], builder: null,
    source: "作業員R・M の突き合わせ（sameStation で駅の id に寄せて比べる・#620）", owner: "作業員M", qdScope: "takeuchi" },
  // 2026-11-23 作業員K2（台帳 #442）: 返信の文 › 約束 › 言い直し › AI だけ（30日 338番中 12番・0〜2 に向かう・PROMISE_RESTATE_MARK）。毎日の数はまだ（K2 が夜に作る候補の名前）
  { metric: "growth:restate:AIだけ", label: "返信の文 › 約束 › 言い直し › AI だけがした番（30日・0 に向かう）", writerSelect: "all", windowDays: 30, dims: [], builder: null,
    source: "scripts/audit-promise-restate.ts の「AI だけ restate」（作業員K2）", owner: "作業員K2", qdScope: "all" },
  // 2026-11-23 作業員G の頼み（物件検索 › 統括Pro の質・台帳 #474）: quality_daily の metric 名そのまま・scope all・毎晩 supervisor-think が書く
  { metric: "search_found_ok:realpro", label: "物件検索 › 統括Pro の質 › 土台 F の ✓の割合（realpro・1.0 に近づく）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "cron/supervisor-think", owner: "作業員G", qdScope: "all" },
  { metric: "search_found_critical:realpro", label: "物件検索 › 統括Pro の質 › 重要欠の数（realpro・0 に向かう）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "cron/supervisor-think", owner: "作業員G", qdScope: "all" },
  { metric: "search_pro_completion:realpro", label: "物件検索 › 統括Pro の質 › 自動モード完成度（realpro・/100）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "cron/supervisor-think", owner: "作業員G", qdScope: "all" },
  { metric: "search_pro_misjudge", label: "物件検索 › 統括Pro の質 › 判定の外れ（段A 凍結10件・0 が良い）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "search-pro-exam", owner: "作業員G", qdScope: "all" },
];
export const rootOf = (metric: string) => MAP_ROOTS.find((r) => r.metric === metric) ?? null;

/** 1番（純）: 木に入れる単位 */
export type MapTurn = { id: number | string; kind: string; scene: string; miss: MapMiss; cause: MapCause | null; station?: string };

/** 見張りの scene_key（返信:条件提示・AIX:estimate_sheet など）を KB_SCENES の鍵に（純関数）。AIX: で始まる鍵はブレインの一手から来た物＝AIX の種類で場面に寄せる */
export function sceneOfWatchKey(sceneKey: string | null | undefined, aixKind?: string | null): string {
  const s = String(sceneKey ?? "");
  const byKind = (k: string): string => {
    if (/^property_check|^acknowledge_check/.test(k)) return "property_share";
    if (/^property(_send|_recommendation)?$|zenryoku|pickup/.test(k)) return "property_send";
    if (/estimate|cost/.test(k)) return "cost";
    if (/viewing|meeting_place/.test(k)) return "viewing";
    if (/application|guarantor|screening/.test(k)) return "apply";
    if (/condition/.test(k)) return "conditions";
    return "other";
  };
  if (s.startsWith("AIX:")) return byKind(s.slice(4));
  const r = s.replace(/^返信:/, "");
  if (/条件/.test(r)) return "conditions";
  if (/質問|意図:question|意図:consultation/.test(r)) return "question";
  if (/了承|お礼|意図:chat|意図:positive/.test(r)) return "ack";
  if (/検討|保留|意図:negative|断り|キャンセル/.test(r)) return "considering";
  if (/持ち込み|物件への反応|意図:desire/.test(r)) return "property_share";
  if (/内覧/.test(r)) return "viewing";
  if (/費用|見積/.test(r)) return "cost";
  if (/申込|審査/.test(r)) return "apply";
  if (!s && aixKind) return byKind(aixKind);
  return "other";
}

export type MapNode = {
  key: string; parent: string | null; depth: number; dim: MapDim | null; val: string | null; label: string;
  n: number; ok: number; misses: number; value: number | null;
};
const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const valJa = (dim: MapDim, v: string) => (dim === "miss" ? MAP_MISS_JA[v as MapMiss] ?? v : dim === "cause" ? MAP_CAUSE_JA[v as MapCause] ?? v : v);

/** 木を作る（純関数）。miss=ok の番には原因の子を作らない（一致の葉）。子の n・外れを足すと親に戻る形 */
export function buildTree(turns: readonly MapTurn[], def: Pick<MapRootDef, "metric" | "label" | "dims">): MapNode[] {
  const out: MapNode[] = [];
  const walk = (rows: readonly MapTurn[], key: string, parent: string | null, depth: number, dim: MapDim | null, val: string | null, label: string) => {
    const ok = rows.filter((r) => r.miss === "ok").length;
    out.push({ key, parent, depth, dim, val, label, n: rows.length, ok, misses: rows.length - ok, value: pct1(ok, rows.length) });
    const next = def.dims[depth];
    if (!next || !rows.length) return;
    if (next === "cause" && val === "ok") return;
    const groups = new Map<string, MapTurn[]>();
    for (const r of rows) { const v = next === "cause" ? String(r.cause ?? "misread") : String(r[next] ?? "other"); groups.set(v, [...(groups.get(v) ?? []), r]); }
    for (const [v, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) walk(rs, `${key}/${next}=${v}`, key, depth + 1, next, v, `${DIM_JA[next]}: ${valJa(next, v)}`);
  };
  walk(turns, def.metric, null, 0, null, null, def.label);
  return out;
}

/** 子を足すと親に戻るか（純関数）。合わない親を返す＝数え方の誤り */
export function sumMismatches(nodes: readonly MapNode[]): Array<{ key: string; n: number; childN: number; misses: number; childMisses: number }> {
  const kids = new Map<string, MapNode[]>();
  for (const x of nodes) if (x.parent) kids.set(x.parent, [...(kids.get(x.parent) ?? []), x]);
  const bad: Array<{ key: string; n: number; childN: number; misses: number; childMisses: number }> = [];
  for (const x of nodes) {
    const ks = kids.get(x.key);
    if (!ks?.length) continue;
    const childN = ks.reduce((s, k) => s + k.n, 0), childMisses = ks.reduce((s, k) => s + k.misses, 0);
    if (childN !== x.n || childMisses !== x.misses) bad.push({ key: x.key, n: x.n, childN, misses: x.misses, childMisses });
  }
  return bad;
}
export const leavesOf = (nodes: readonly MapNode[]) => { const ps = new Set(nodes.map((x) => x.parent).filter(Boolean)); return nodes.filter((x) => !ps.has(x.key)); };
/** a は b の祖先か本人か（葉の鍵の前方一致・段の区切りで） */
export const covers = (anc: string, key: string) => key === anc || key.startsWith(`${anc}/`);

/** 見込みの付いた作業（work_items の見込みの欄の抜き） */
export type ForecastItem = {
  id: number; title: string; stage: string; owner: string | null; priority: number | null; switch_name: string | null; switch_default: string | null;
  next_step: string | null; blocker: string | null;
  forecast_metric: string | null; forecast_leaf: string | null; forecast_writer_select: string | null;
  forecast_before: number | null; forecast_low: number | null; forecast_high: number | null;
  /** 部品（forecast_exam.parts）から作った作業: その葉で直る番の数（直る見込み＝fixes ÷ 部品の葉の外れ） */
  fixes?: number | null;
};
/** 作業1つが直せる見込み（外れの番のうち直る割合・純関数）。幅の真ん中で見る。幅が無い・前が無いは null */
export function fixShareOf(it: Pick<ForecastItem, "forecast_before" | "forecast_low" | "forecast_high">): number | null {
  const b = it.forecast_before, lo = it.forecast_low, hi = it.forecast_high;
  if (b == null || lo == null || hi == null || b >= 100) return null;
  return Math.max(0, Math.min(1, ((lo + hi) / 2 - b) / (100 - b)));
}

export const MIN_N = 5; // n がこれ未満の葉は判断保留（順位で過大に扱わない）
export const HOLE_MISSES = 3; // 作業の無い葉で外れがこれ以上なら穴
export type RankedLeaf = MapNode & {
  hold: boolean; hole: boolean; /** 穴を知らせる鍵（葉そのものか、外れを足すと線を越える場面・駅の段）*/ holeKey: string | null; items: number[]; fixShare: number; gain: number; cost: number; score: number; rank: number;
  nextStep: string; blocker: string | null; examProblems: number;
};
const DONE = new Set(["done", "dropped"]);
/** 葉の順位（純関数）: 伸びしろ＝外れ × 直せる見込み（作業の見込み・無ければ 0.5 の仮）・費用＝作る段の遠さ・止まっていれば半分・n が小さいと 0.3倍 */
export function rankLeaves(nodes: readonly MapNode[], items: readonly ForecastItem[], o: { examByLeaf?: Map<string, number>; writerSelect?: WriterSelect } = {}): RankedLeaf[] {
  const leaves = leavesOf(nodes).filter((l) => l.misses > 0);
  const live = items.filter((it) => !DONE.has(it.stage) && (!o.writerSelect || !it.forecast_writer_select || it.forecast_writer_select === o.writerSelect || it.forecast_writer_select === "all"));
  const costOf = (stage: string) => (stage === "passed" || stage === "on" ? 0.5 : stage === "testing" || stage === "built_off" ? 1 : stage === "building" ? 1.5 : 2);
  const ranked = leaves.map((l) => {
    const its = live.filter((it) => { const at = it.forecast_leaf ?? it.forecast_metric; return !!at && covers(at, l.key); })
      // 11/23（2回目）: 葉に近い（段の深い）作業を先に＝次の一手はその葉の持ち主の作業。同じ深さは直る見込みの大きい順
      .sort((a, b) => String(b.forecast_leaf ?? "").split("/").length - String(a.forecast_leaf ?? "").split("/").length || (fixShareOf(b) ?? 0) - (fixShareOf(a) ?? 0));
    const partShare = (it: ForecastItem) => { if (it.fixes == null) return null; const at = nodes.find((x) => x.key === it.forecast_leaf); return at && at.misses ? Math.min(1, it.fixes / at.misses) : null; };
    const shares = its.map((it) => partShare(it) ?? fixShareOf(it)).filter((x): x is number => x != null);
    const fixShare = shares.length ? Math.max(...shares) : 0.5;
    // 判断保留: 原因の葉の n は外れの数そのもの＝割合の重みは場面の段（種類×場面）の n で見る。外れが 2 以下か、場面の段の n が MIN_N 未満
    const sceneAnc = nodes.find((x) => (x.dim === "scene" || x.dim === "station") && covers(x.key, l.key)) ?? l;
    const hold = l.misses < HOLE_MISSES || sceneAnc.n < MIN_N;
    // 根だけに付いた見込み（数全体の見込み）は葉の担当にならない＝種類より下に付いた作業が無ければ穴（11/23 統括役「担当も見込みも無い大きな葉は穴」）
    const specific = its.filter((it) => String(it.forecast_leaf ?? "").includes("/"));
    // 11/23（2回目）: 葉が細かく割れて1葉の外れが線に届かない時は、場面（駅）の段の外れの合計で見る（穴は場面の鍵で知らせる＝同じ場面の葉を重ねて数えない）
    const kindAnc = nodes.find((x) => x.depth === 1 && covers(x.key, l.key)) ?? l;
    const holeAt = [l, sceneAnc, kindAnc].find((x) => x.misses >= HOLE_MISSES) ?? null;
    const hole = !specific.length && !!holeAt;
    const holeKey = hole && holeAt ? holeAt.key : null;
    const best = specific[0] ?? its[0] ?? null;
    const cost = best ? costOf(best.stage) : 2;
    const blocker = its.find((it) => it.blocker || it.stage === "blocked" || it.stage === "waiting_owner")?.blocker ?? (its.some((it) => it.stage === "waiting_owner") ? "竹内さん待ち" : its.some((it) => it.stage === "blocked") ? "止まっている" : null);
    const gain = Math.round(l.misses * fixShare * 10) / 10;
    const score = Math.round((gain / cost) * (hold ? 0.3 : 1) * (blocker ? 0.5 : 1) * 100) / 100;
    // 試験の問題: 葉か、葉の上の場面の段に当てた問題（種類までの問題は場面が分からない＝数えない）
    const examProblems = o.examByLeaf ? [...o.examByLeaf].filter(([k]) => k.includes("/scene=") && (covers(k, l.key) || covers(l.key, k))).reduce((s, [, n]) => s + n, 0) : 0;
    const nextStep = hole ? `穴: 作業も見込みも無い（外れ ${l.misses}）→ 統括役が持ち主を決め、外れの番を実物で読む`
      : best ? `#${best.id}${best.switch_name ? ` ${best.switch_name}` : ""}（${best.stage}）: ${String(best.next_step ?? "次の一手が書かれていない").slice(0, 70)}`
      : `外れ ${l.misses}（穴の線 ${HOLE_MISSES} 未満）→ 次の夜に増えるか見る`;
    return { ...l, hold, hole, holeKey, items: its.map((it) => it.id), fixShare: Math.round(fixShare * 100) / 100, gain, cost, score, rank: 0, nextStep, blocker, examProblems };
  });
  ranked.sort((a, b) => b.score - a.score || b.misses - a.misses);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

/** 見込みの突き合わせ（純関数）: 幅の中か外か */
export type ForecastVerdict = "in" | "below" | "above" | "pending";
export function forecastVerdictOf(low: number | null, high: number | null, measured: number | null, n: number | null, minN = MIN_N): ForecastVerdict {
  if (measured == null || low == null || high == null || (n ?? 0) < minN) return "pending";
  return measured < low ? "below" : measured > high ? "above" : "in";
}
/** 本番に入った時から 7日・14日の突き合わせの頃か（純関数）。済んだ日数は checkedDays に */
export function dueChecksOf(startAtMs: number | null, nowMs: number, checkedDays: readonly number[]): number[] {
  if (!startAtMs) return [];
  const d = (nowMs - startAtMs) / 86_400_000;
  return [7, 14].filter((k) => d >= k && !checkedDays.includes(k));
}
/** 外れの原因の候補（純関数）: 作業の葉の下で、後の木に残った外れの一番多い原因 */
export function gapCauseHintOf(afterNodes: readonly MapNode[], leafKey: string): MapCause | null {
  const c: Record<string, number> = {};
  for (const l of leavesOf(afterNodes)) if (covers(leafKey, l.key) || covers(l.key, leafKey)) if (l.dim === "cause" && l.val) c[l.val] = (c[l.val] ?? 0) + l.misses;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? (top[0] as MapCause) : null;
}

// ── 試験の問題と葉（11/23 統括役: 試験の側も同じ地図を読み書きする）──
/** 試験の問題1つ（spec.json の抜き） */
export type ExamProblemLite = { id: string; type?: string; accept?: string[]; mustNot?: string[]; conv?: string; at?: string };
/** 問題の正解の AIX の種類（純関数）。accept の「AIX:<種類>」から。返信・2段・左右だけの問題は null（AIX の番の木では当たらない） */
export function examAixKindOf(p: ExamProblemLite): string | null {
  for (const a of p.accept ?? []) {
    const m = /^AIX:([a-z_]+)/.exec(a);
    if (m && m[1] !== "左右") return m[1] === "property_send" || m[1] === "property_recommendation" ? "property" : m[1];
  }
  return null;
}
/** 問題を AIX の番の木の葉（種類／場面まで）に当てる（純関数）。場面は問題の番の見張りの scene_key から */
export function examLeafOf(p: ExamProblemLite, root: string, watchSceneKey: string | null): { leaf: string | null; how: string } {
  const kind = examAixKindOf(p);
  if (!kind) return { leaf: null, how: "正解に AIX の種類が無い（返信・2段・左右）" };
  if (!watchSceneKey) return { leaf: `${root}/kind=${kind}`, how: "種類まで（見張りの番が見つからない）" };
  return { leaf: `${root}/kind=${kind}/scene=${sceneOfWatchKey(watchSceneKey, kind)}`, how: "種類×場面（見張りの番の scene_key）" };
}
/** 試験の結果を葉に戻す（純関数）: 問題ごとの前後の○を葉ごとに足す */
export function examResultsByLeaf(links: ReadonlyArray<{ problem_id: string; leaf_key: string }>, before: Map<string, boolean>, after: Map<string, boolean>) {
  const by = new Map<string, { n: number; before_ok: number; after_ok: number; worse: string[]; better: string[] }>();
  for (const l of links) {
    if (!after.has(l.problem_id)) continue;
    const o = by.get(l.leaf_key) ?? { n: 0, before_ok: 0, after_ok: 0, worse: [], better: [] };
    const b = before.get(l.problem_id), a = after.get(l.problem_id)!;
    o.n++; if (b) o.before_ok++; if (a) o.after_ok++;
    if (b === true && !a) o.worse.push(l.problem_id); if (b === false && a) o.better.push(l.problem_id);
    by.set(l.leaf_key, o);
  }
  return by;
}
/** 試験の順番の案（純関数・既定 off の EXAM_ORDER_BY_MAP で使う）: 伸びしろの大きい葉の問題を先に */
export function examOrderByMap(problemIds: readonly string[], linkOf: Map<string, string>, ranked: readonly RankedLeaf[]): string[] {
  const scoreOf = (pid: string) => { const k = linkOf.get(pid); if (!k) return 0; return Math.max(0, ...ranked.filter((r) => covers(k, r.key) || covers(r.key, k)).map((r) => r.score)); };
  return [...problemIds].sort((a, b) => scoreOf(b) - scoreOf(a));
}
export const examOrderByMapOn = (env: Record<string, string | undefined> = process.env) => (env.EXAM_ORDER_BY_MAP ?? "off").toLowerCase() === "on";

/** 関わる土台の空き（作業員N の quality_daily found:<土台id>:<場面>:<欄>・value=0 が空き）を、同じ場面の葉に並べる（純関数） */
export function relatedFoundationOf(leafKey: string, rows: ReadonlyArray<{ metric: string; value: number | null; detail?: { cause?: string } | null }>): string[] {
  const scene = /\/scene=([^/]+)/.exec(leafKey)?.[1] ?? null;
  return rows.filter((r) => {
    const m = /^found:([^:]+):([^:]+):([^:]+)$/.exec(r.metric);
    if (!m || r.value !== 0) return false;
    if (r.detail?.cause && !["material", "misread"].includes(r.detail.cause)) return false;
    return m[2] === "all" || (scene != null && m[2] === scene);
  }).map((r) => r.metric);
}

// ── 2026-11-23 統括役（2回目）: 端末の版の木・申込までの地図の木・根の付け替え ──
/** 葉の鍵の根を付け替える（純関数）。from の根で書かれた葉を to の根の葉に */
export const rebaseKey = (key: string, from: string, to: string) => (key === from ? to : key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : key);

/** 根の作業の一覧（純関数）: 付け替え元の根の作業も、葉の鍵を付け替えて受ける。forecast_exam.parts は部品ごとの作業にする（fixes 付き） */
export function itemsForRoot<T extends ForecastItem>(items: readonly T[], def: Pick<MapRootDef, "metric" | "rebaseFrom">): T[] {
  const roots = [def.metric, ...(def.rebaseFrom ?? [])];
  const rootOfKey = (k: string | null | undefined) => roots.find((r) => k === r || String(k ?? "").startsWith(`${r}/`)) ?? null;
  const out: T[] = [];
  for (const it of items) {
    const leaf = it.forecast_leaf ?? it.forecast_metric;
    const r = rootOfKey(leaf) ?? (roots.includes(String(it.forecast_metric)) ? String(it.forecast_metric) : null);
    if (!r) continue;
    const parts = (((it as { forecast_exam?: unknown }).forecast_exam ?? null) as { parts?: Array<{ leaf: string; fixes: number }> } | null)?.parts ?? [];
    if (parts.length) {
      for (const p of parts) { const pr = rootOfKey(p.leaf); if (pr) out.push({ ...it, forecast_leaf: rebaseKey(p.leaf, pr, def.metric), fixes: p.fixes }); }
      continue;
    }
    const lr = rootOfKey(leaf);
    out.push({ ...it, forecast_leaf: lr ? rebaseKey(String(leaf), lr, def.metric) : def.metric });
  }
  return out;
}

/** 作業員A の audit-aix-turn-judgment.ts の json の1行（使う欄だけ） */
export type DeviceTurnRow = {
  id: number; cls: string; tk: string | null; v: string; bk?: string | null; prevFulfil?: boolean;
  mat?: { pend?: number; pp?: boolean; checked?: number; taskResult?: number; mk?: string[] | null; mks?: boolean } | null;
};
/**
 * 端末の版の外れの原因（純関数・仮の決め方＝外れの番を実物で読んで直す）:
 *   先後 → 読み違い（2段の決まり）。種類違い → 足りない材料の印（digest.mk / mks）があれば材料・無ければ読み違い。
 *   AIX の番を返信: 前の番の約束を果たす AIX（prevFulfil）＝この番の判断と数えてよいか揺れる → 数え方／
 *     その種類の手元の材料が判断の時点に無い（物件＝送れる候補 0 かつ pp なし・物件確認＝確認の結果 0・見積書＝mk に見積の額）か mk がある → 材料／ほかは返信か AIX かの判断の誤り
 */
export function deviceCauseOf(r: DeviceTurnRow): MapCause | null {
  if (r.v === "一致" || r.v === "返信一致") return null;
  const m = r.mat ?? {};
  const mk = (m.mk ?? []).length > 0 || m.mks === true;
  if (r.v === "先後") return "misread";
  if (r.v === "種類違い") return mk ? "material" : "misread";
  if (r.prevFulfil) return "counting";
  const k = r.tk ?? "";
  const noHand = k === "property" ? (m.pend ?? 0) === 0 && !m.pp : k === "property_check_result" ? (m.checked ?? 0) === 0 && (m.taskResult ?? 0) === 0 : k === "estimate_sheet" ? (m.mk ?? []).includes("estimate_amount") : false;
  return noHand || mk ? "material" : "aix_turn_as_reply";
}
const DEVICE_MISS: Record<string, MapMiss> = { 一致: "ok", AIXの番を返信: "reply_not_aix", 種類違い: "aix_kind", 先後: "order" };
/** A の json の行を木の番に（純関数）。AIX の番（cls が reply 以外）だけ・場面は見張りの scene_key（id で引いた物） */
export function deviceTurnsOf(rows: readonly DeviceTurnRow[], sceneKeyById: ReadonlyMap<number, string | null>): MapTurn[] {
  return rows.filter((r) => r.cls !== "reply").map((r) => {
    const kind = r.tk && r.tk !== "?" ? r.tk : "other";
    return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss: DEVICE_MISS[r.v] ?? "aix_kind", cause: deviceCauseOf(r) };
  });
}

/** 作業員R の audit-route-progress-takeuchi.ts の json の1行（使う欄だけ） */
export type RouteTurnRow = { conv: string; at: string; node: string | null; branch: string | null; agree: string; dir: string | null; subAt1?: boolean | null; nextAix?: string[] };
export const ROUTE_GOOD = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
/**
 * 申込までの地図の外れの原因（純関数・仮の決め方）:
 *   push_missed（地図は AIX・竹内さんは返信）: 竹内さんの一手が約束（dir=promise＝2段の先の返信）なら数え方・ほかは駅の読み違い
 *   other_aix: 駅の中の状態が地図の駅と食い違う（subAt1=false）なら材料・ほかは読み違い
 *   pushed_off_map（地図は返信・竹内さんは AIX）: 地図に AIX の候補が1つも無ければ材料・あれば返信か AIX かの判断の誤り
 */
export function routeCauseOf(r: RouteTurnRow): MapCause | null {
  if (ROUTE_GOOD.has(r.agree)) return null;
  if (r.agree === "push_missed") return r.dir === "promise" ? "counting" : "misread";
  if (r.agree === "other_aix") return r.subAt1 === false ? "material" : "misread";
  if (r.agree === "pushed_off_map") return (r.nextAix ?? []).length ? "aix_turn_as_reply" : "material";
  return "counting";
}
/** R の json の行を木の番に（純関数）。駅は分かれ道があれば「分:<分かれ道>」 */
export function routeTurnsOf(rows: readonly RouteTurnRow[]): MapTurn[] {
  return rows.filter((r) => r.agree !== "no_next").map((r, i) => ({
    id: `${r.conv}@${r.at}#${i}`, kind: "", scene: "", station: r.branch ? `分:${r.branch}` : String(r.node ?? "other"),
    miss: ROUTE_GOOD.has(r.agree) ? "ok" : r.agree in MAP_MISS_JA ? (r.agree as MapMiss) : "other_aix", cause: routeCauseOf(r),
  }));
}

/** 穴の一覧（純関数）: 穴の鍵（葉か場面・種類の段）ごとに1つ。外れは作業の無い葉の外れの合計（作業のある葉の外れは入れない）。段の n が MIN_N 未満の穴は判断保留の印 */
export function holesOf(ranked: readonly RankedLeaf[], nodes: readonly MapNode[]): Array<{ key: string; n: number; misses: number; hold: boolean; leaves: number }> {
  const by = new Map<string, { leaves: number; misses: number }>();
  for (const r of ranked) if (r.hole && r.holeKey) { const o = by.get(r.holeKey) ?? { leaves: 0, misses: 0 }; o.leaves++; o.misses += r.misses; by.set(r.holeKey, o); }
  return [...by].map(([key, o]) => { const x = nodes.find((y) => y.key === key); return { key, n: x?.n ?? 0, misses: o.misses, hold: (x?.n ?? 0) < MIN_N, leaves: o.leaves }; }).sort((a, b) => b.misses - a.misses);
}
