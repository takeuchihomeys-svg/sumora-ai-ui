// scripts/lib/exam-conductor.ts — 試験のブレインの司令塔（pro）と読み手（flash）の決め方（純関数・LLM も DB もファイルも触らない）
//
// 2026-10-20 竹内さん「テストのブレインはテスト始まる前に優先して作る」。設計知見:
//   ea215526「試験にも LINE のブレインと同じ構造の『試験のブレイン（指揮官）』を置く」（P1）
//   487b8921「試験のブレインは pro（司令塔）と flash（読み手・判定の下ごしらえ）を組み合わせる」（P1）
//   98bca000「つなぎを太くする — 試験はつなぎごとに問題を持つ」（P1）
//   5be49dda「弱い所を型で数えて根本から直す」（P0）・c0884407「安いモデルは研究者の発想で組む（パーツに分けて読み・つなぎを決まった形で結ぶ）」（P0）
//   LINE のブレインと同じ組み方: 読み手（flash・短い仕事）→ 決まった形の表（外れの型・つなぎの線・申込までの地図）→ 司令塔（pro・短い JSON）→ 決まった計算で上限に収める。
//   今の試験のブレイン（scripts/lib/exam-brain.ts の RAG の選び・小さな確かめ・使い回し・上限）はそのまま使い、司令塔はその上で「重点」を決める。
//   読み書き・LLM は scripts/lib/exam-conductor-io.ts、入口は scripts/exam-brain.ts の --conduct／--run-plan／--miss-map／--coverage。
//   単体テスト scripts/lib/__tests__/exam-conductor.test.ts
import { pathKind, brainFunctionOf, type HabitKind, type BrainFunction, type Stage as PartStage } from "./parts-eval";
import { UNIT_USD } from "./exam-brain";
import { altPriceOf } from "../../app/lib/llm-price";

// ─── 1. 決まった形の表（外れの型・つなぎの線・申込までの地図・ピッカー） ─────────────────────
/** 外れの型（parts-eval の癖の種類）＋ 機械では中身まで分からない外れ（判定を呼ばなかった・回が割れた） */
export type MissKind = HabitKind | "合否の外れ（中身は不明）";
export const MISS_KINDS: MissKind[] = [
  "道の取り違え", "AIXの判断の外れ", "AIXの種類の取り違え", "ピッカーの選び違い", "自信が低いのに言い切った",
  "質問の答えの抜け", "約束の抜け", "受け止めの抜け", "物件ごとの答えの抜け", "主語・指す物の取り違え",
  "言ってはいけない事", "先に答える外れ", "決まりが本質を上書き", "触れない所に触れた", "合否の外れ（中身は不明）",
];

/** つなぎの線（docs/link-brain-design.md の L1〜L6。L7＝試験そのもの）。試験の問題がその線を渡るかの見分け（決まった計算） */
export type LinkId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
export type ProblemLike = { id: string; type: string; tags?: string[]; accept?: string[]; mustNot?: string[]; asks?: Array<{ q?: string; route?: string; point?: string; routes?: string[] }>; ng?: string[]; acceptWhen?: { searchExhausted?: string[] } };
const textOf = (p: ProblemLike) => [p.type, ...(p.tags ?? []), ...(p.asks ?? []).map((a) => `${a.q ?? ""} ${a.point ?? ""}`)].join(" ");
const acc = (p: ProblemLike) => [...(p.accept ?? []), ...(p.acceptWhen?.searchExhausted ?? [])];
export const LINKS: Record<LinkId, { label: string; from: string; to: string; match: (p: ProblemLike) => boolean }> = {
  L1: { label: "ブレイン→AIX のボタン・ピッカー", from: "LINE ブレイン", to: "画面のボタン（check_pattern）", match: (p) => acc(p).some((a) => /property_check_result|acknowledge_check|AIX:物件確認/.test(a)) },
  // L2 は約束を台帳に書く番（確認の約束＝2段:check）と、約束の続きの番（札: 受けだけ（約束の後）・約束・まとめた約束・順に約束）。型の名前（約束の返信を先に）だけでは数えない
  L2: { label: "約束の台帳→結果を返すピッカー", from: "約束の台帳（confirmation_promised）", to: "約束の続き（promise-queue）", match: (p) => acc(p).includes("2段:check") || (p.tags ?? []).some((t) => /^(?:受けだけ（約束の後）|約束|まとめた約束|順に約束)$/.test(t)) },
  L3: { label: "AIX ツールの確認済み→ブレイン（結果が揃った）", from: "AIX ツール（property_pickups の確認済み・新着カード）", to: "LINE ブレイン", match: (p) => /受けだけ（約束の後）|約束の後|結果/.test(textOf(p)) && acc(p).some((a) => /property_check_result|property_send|物件/.test(a)) },
  L4: { label: "会話の反応・メモ→物件の条件と点", from: "LINE の会話（反応・メモ・地域の意見）", to: "AIX ツールの条件（profile_snapshot）", match: (p) => /送った物件への反応|条件をゆるめる|条件は変えない|条件の言い直し|外す|除いて|エリア/.test(textOf(p)) },
  L5: { label: "ブレイン→AIX の2通目", from: "LINE ブレイン（判断・台帳）", to: "AIX の2通目（aix-template-generate）", match: (p) => /2通目/.test(textOf(p)) },
  L6: { label: "新着とピックアップの区別", from: "約束の種類（pickup／new_arrival_watch）", to: "AIX【物件ピックアップ】／【物件オススメ】", match: (p) => acc(p).includes("2段:pickup") || acc(p).some((a) => /property_pickup|property_recommendation/.test(a)) || /新着|出し切り/.test(textOf(p)) },
};
export const LINK_IDS = Object.keys(LINKS) as LinkId[];
export function linksOf(p: ProblemLike): LinkId[] { return LINK_IDS.filter((l) => LINKS[l].match(p)); }

/** 申込までの地図（本線の段）。問題の型・札・正解の道から決まった計算で置く（どこにも当たらない＝"other"） */
export type MapStage = "first" | "hearing" | "proposing" | "viewing" | "cost" | "applying" | "closing" | "other";
export const MAP_STAGE_JA: Record<MapStage, string> = { first: "初回", hearing: "条件を聞く", proposing: "物件の提案", viewing: "内覧", cost: "初期費用・見積", applying: "申込・審査", closing: "待つ・閉じる", other: "どこにも当たらない" };
export const MAP_STAGES = Object.keys(MAP_STAGE_JA) as MapStage[];
/** 表に並べる時の短い名前（全角2〜3字） */
export const MAP_STAGE_SHORT: Record<MapStage, string> = { first: "初回", hearing: "条件", proposing: "提案", viewing: "内覧", cost: "費用", applying: "申込", closing: "閉じ", other: "他" };
export function mapStageOf(p: ProblemLike): MapStage {
  const t = textOf(p), a = acc(p).join(" ");
  if (/申込|審査|代理契約|application_push/.test(t + a)) return "applying";
  if (/見積|初期費用|estimate|cost_/.test(t + a)) return "cost";
  if (/内覧|viewing_invite|meeting_place/.test(t + a)) return "viewing";
  if (/^初回|初回/.test(t)) return "first";
  if (/条件|condition_hearing/.test(t + a)) return "hearing";
  if (/待って・閉じる|閉じる|締め|短いお礼/.test(t)) return "closing";
  if (/物件|ピックアップ|出し切り|pickup|property_|AIX:物件|AIX:左右/.test(t + a)) return "proposing";
  return "other";
}

/** ピッカー（AIX【物件確認した】の細目＋新設の候補）。試験の正解に「ボタン/ピッカー」まで書いた問題があるかで覆いを見る */
export const PICKERS: Array<{ key: string; label: string; planned?: boolean }> = [
  { key: "property_check_result/募集状況", label: "物件あった・なかった・募集状況" },
  { key: "property_check_result/入居日", label: "入居日・退去予定日" },
  { key: "property_check_result/interior_photo", label: "室内写真" },
  { key: "property_check_result/other_room_check", label: "別の部屋" },
  { key: "property_check_result/条件:mgmt_initial_cost", label: "初期費用（交渉）" },
  { key: "property_check_result/条件:mgmt_proxy", label: "代理契約" },
  { key: "property_check_result/条件:mgmt_lifeline", label: "ライフライン" },
  { key: "property_check_result/条件:mgmt_two_person", label: "二人入居" },
  { key: "property_check_result/条件:mgmt_guarantor", label: "保証会社（審査面）" },
  { key: "property_check_result/条件:mgmt_company", label: "管理会社" },
  { key: "property_check_result/条件:mgmt_parking", label: "駐車場" },
  { key: "property_check_result/条件:mgmt_pet", label: "ペット飼育" },
  { key: "property_check_result/条件:mgmt_equipment", label: "設備" },
  { key: "property_check_result/条件:nearby_parking", label: "近隣の月極駐車場" },
  { key: "property_check_result/条件:mgmt_bike", label: "バイク置き場（新設の候補）", planned: true },
  { key: "property_check_result/条件:mgmt_apply_status", label: "申込状況（何人待ち・新設の候補）", planned: true },
];

// ─── 2. 結果の外れを機械で型に分ける（判定を呼んだ結果をそのまま読む・LLM なし） ─────────────────
export type RowLike = {
  id: string; rep?: number;
  path?: { code?: string; ok?: boolean; mustNotHit?: string | null } | null;
  score?: { pass?: boolean } | null;
  asks?: Array<{ q?: string; covered?: boolean; route?: boolean }> | null;
  ng?: Array<{ text?: string; violated?: boolean }> | null;
  draft?: { code?: string; ok?: boolean; pass?: boolean; asks?: boolean[] | null; ng?: boolean[] | null } | null;
  error?: string;
};
export type Miss = { kind: MissKind; fn: BrainFunction | "どれにも当たらない"; part: "brain" | "draft"; note: string };
const fnOf = (stage: PartStage, k: MissKind): Miss["fn"] => k === "合否の外れ（中身は不明）" ? "どれにも当たらない" : brainFunctionOf(stage, k);
/**
 * 1つの答案の外れ: 道（決まり）→ 依頼ごとの判定（covered・route）→ 言ってはいけない事 → 下書き。
 *   道が外れ＝pathKind（AIX の判断・種類・ピッカー・言い切り・道）。依頼: route も外れ＝答え方の取り違え（道の取り違え）／route は合う＝中身の抜け（約束 or 質問）。
 *   合格✕なのに依頼・言ってはいけない事の判定が無い（--judge=lazy で呼ばなかった等）＝中身は不明（flash の読み手に回す候補）
 */
export function classifyRow(p: ProblemLike, r: RowLike): Miss[] {
  if (r.error) return [];
  const out: Miss[] = [];
  const g = { accept: acc(p), asks: (p.asks ?? []).map((a) => ({ route: a.route, sure: undefined })) } as never;
  if (r.path && r.path.ok === false) { const k = pathKind(g, String(r.path.code ?? "")); out.push({ kind: k, fn: fnOf("priority", k), part: "brain", note: `道 ${r.path.code ?? "?"}（正解 ${acc(p).join("|")}）` }); }
  (r.asks ?? []).forEach((a, i) => {
    if (a.covered !== false) return;
    const sp = p.asks?.[i];
    const k: MissKind = a.route === false ? "道の取り違え" : sp?.route === "promise" ? "約束の抜け" : "質問の答えの抜け";
    out.push({ kind: k, fn: fnOf("link", k), part: "brain", note: `依頼${i + 1}「${String(a.q ?? sp?.q ?? "").slice(0, 30)}」${a.route === false ? "の答え方" : "の中身"}` });
  });
  (r.ng ?? []).forEach((x, i) => { if (x.violated) out.push({ kind: "言ってはいけない事", fn: fnOf("priority", "言ってはいけない事"), part: "brain", note: `言ってはいけない事${i + 1}「${String(x.text ?? p.ng?.[i] ?? "").slice(0, 30)}」` }); });
  if (r.draft) {
    if (r.draft.ok === false) { const k = pathKind(g, String(r.draft.code ?? "")); out.push({ kind: k, fn: fnOf("writer", k), part: "draft", note: `下書きの道 ${r.draft.code ?? "?"}` }); }
    (r.draft.asks ?? []).forEach((c, i) => { if (c === false) { const k: MissKind = p.asks?.[i]?.route === "promise" ? "約束の抜け" : "質問の答えの抜け"; out.push({ kind: k, fn: fnOf("writer", k), part: "draft", note: `下書きの依頼${i + 1}` }); } });
    (r.draft.ng ?? []).forEach((v, i) => { if (v) out.push({ kind: "言ってはいけない事", fn: fnOf("writer", "言ってはいけない事"), part: "draft", note: `下書きの言ってはいけない事${i + 1}` }); });
  }
  if (!out.length && r.score && r.score.pass === false) out.push({ kind: "合否の外れ（中身は不明）", fn: "どれにも当たらない", part: "brain", note: "合格✕・判定の中身なし" });
  return out;
}
/** 回を束ねた問題ごとの外れ: 過半数の回に出た型だけ（揺れで1回だけ出た型は "揺れ" として別に数える） */
export function problemMisses(p: ProblemLike, rows: RowLike[]): { ok: boolean; kinds: MissKind[]; flakyKinds: MissKind[]; misses: Miss[]; reps: number } {
  const rs = rows.filter((r) => !r.error);
  if (!rs.length) return { ok: true, kinds: [], flakyKinds: [], misses: [], reps: 0 };
  const per = rs.map((r) => classifyRow(p, r));
  const cnt = new Map<MissKind, number>();
  for (const ms of per) for (const k of new Set(ms.map((m) => m.kind))) cnt.set(k, (cnt.get(k) ?? 0) + 1);
  const kinds = [...cnt].filter(([, n]) => n * 2 > rs.length).map(([k]) => k);
  const flakyKinds = [...cnt].filter(([, n]) => n * 2 <= rs.length).map(([k]) => k);
  const passN = rs.filter((r) => r.score?.pass !== false && !classifyRow(p, r).length).length;
  return { ok: passN * 2 > rs.length && !kinds.length, kinds, flakyKinds, misses: per.flat(), reps: rs.length };
}

// ─── 3. 外れの型の地図（型×脳の働き×つなぎの線×申込までの地図） ───────────────────────────
export type MissMapEntry = { id: string; type: string; stage: MapStage; links: LinkId[]; ok: boolean; kinds: MissKind[]; flakyKinds: MissKind[]; fns: string[]; at?: string; source?: string };
export type MissMap = {
  at: string; n: number; ok: number; noData: string[];
  byKind: Record<string, number>; byFn: Record<string, number>; byPart: { brain: Record<string, number>; draft: Record<string, number> }; byLink: Record<string, { n: number; miss: number }>; byStage: Record<string, { n: number; miss: number }>;
  entries: MissMapEntry[];
};
const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
export function buildMissMap(problems: ProblemLike[], rowsOf: (id: string) => { rows: RowLike[]; at?: string; source?: string } | null, at = new Date().toISOString()): MissMap {
  const m: MissMap = { at, n: 0, ok: 0, noData: [], byKind: {}, byFn: {}, byPart: { brain: {}, draft: {} }, byLink: {}, byStage: {}, entries: [] };
  for (const l of LINK_IDS) m.byLink[l] = { n: 0, miss: 0 };
  for (const s of MAP_STAGES) m.byStage[s] = { n: 0, miss: 0 };
  for (const p of problems) {
    const got = rowsOf(p.id);
    const links = linksOf(p), stage = mapStageOf(p);
    if (!got || !got.rows.length) { m.noData.push(p.id); continue; }
    const pm = problemMisses(p, got.rows);
    const fns = [...new Set(pm.misses.filter((x) => pm.kinds.includes(x.kind)).map((x) => x.fn))];
    m.n++; if (pm.ok) m.ok++;
    for (const k of pm.kinds) inc(m.byKind, k);
    for (const f of fns) inc(m.byFn, f);
    for (const part of ["brain", "draft"] as const) for (const k of new Set(pm.misses.filter((x) => x.part === part && pm.kinds.includes(x.kind)).map((x) => x.kind))) inc(m.byPart[part], k);
    for (const l of links) { m.byLink[l].n++; if (!pm.ok) m.byLink[l].miss++; }
    m.byStage[stage].n++; if (!pm.ok) m.byStage[stage].miss++;
    m.entries.push({ id: p.id, type: p.type, stage, links, ok: pm.ok, kinds: pm.kinds, flakyKinds: pm.flakyKinds, fns, at: got.at, source: got.source });
  }
  return m;
}
/** 前の地図と今の地図を並べる（型ごとの数・問題ごとの直った／壊れた） */
export function compareMissMaps(prev: MissMap | null, cur: MissMap): { kinds: Array<{ kind: string; before: number; after: number }>; fixed: string[]; broke: string[]; same: number } {
  const kinds = [...new Set([...Object.keys(prev?.byKind ?? {}), ...Object.keys(cur.byKind)])].map((k) => ({ kind: k, before: prev?.byKind[k] ?? 0, after: cur.byKind[k] ?? 0 })).sort((a, b) => b.after - a.after || b.before - a.before);
  const pe = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
  const fixed: string[] = [], broke: string[] = []; let same = 0;
  for (const e of cur.entries) { const b = pe.get(e.id); if (!b) continue; if (!b.ok && e.ok) fixed.push(e.id); else if (b.ok && !e.ok) broke.push(e.id); else same++; }
  return { kinds, fixed, broke, same };
}
/** 次の重点の候補（司令塔の次の材料）: 一番多い型の問題（根っこを直す・P0 5be49dda）・今回壊れた問題・同じ線の上の外れ */
export function nextFocus(cur: MissMap, cmp: ReturnType<typeof compareMissMaps> | null, max = 12): Array<{ id: string; why: string }> {
  const out = new Map<string, string>();
  for (const id of cmp?.broke ?? []) out.set(id, "今回壊れた（退行）");
  const top = Object.entries(cur.byKind).filter(([k]) => k !== "合否の外れ（中身は不明）").sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) for (const e of cur.entries) if (e.kinds.includes(top as MissKind) && !out.has(e.id)) out.set(e.id, `一番多い型「${top}」`);
  const worstLink = Object.entries(cur.byLink).filter(([, v]) => v.n).sort((a, b) => b[1].miss / b[1].n - a[1].miss / a[1].n)[0]?.[0];
  if (worstLink) for (const e of cur.entries) if (!e.ok && e.links.includes(worstLink as LinkId) && !out.has(e.id)) out.set(e.id, `外れの多い線 ${worstLink}（${LINKS[worstLink as LinkId].label}）`);
  return [...out].slice(0, max).map(([id, why]) => ({ id, why }));
}

// ─── 4. 試験の地図（覆いの地図）: どこを問題が覆っていて、どこが空いているか ───────────────────
export type GoldLite = { id: string; asks?: Array<{ pickers?: string[]; referent?: unknown; receive?: unknown; sure?: string }> };
export type Coverage = {
  stage: Array<{ stage: MapStage; n: number }>;
  link: Array<{ link: LinkId; n: number; ids: string[] }>;
  kind: Array<{ kind: MissKind; measurable: number; how: string }>;
  picker: Array<{ key: string; label: string; n: number; planned?: boolean }>;
  stageXlink: Array<{ stage: MapStage; link: LinkId; n: number }>;
  /** 試験が測っている道具（ブレイン・下書き・2通目・物件の判断・約束の台帳の記録） */
  tools: Array<{ tool: string; n: number; how: string }>;
  holes: Array<{ where: string; why: string; add: string }>;
};
/** 型ごとに「その型を測れる問題」の数（正解の形から決まった計算） */
function measurable(k: MissKind, ps: ProblemLike[], golds: GoldLite[]): { n: number; how: string } {
  const g = (f: (a: NonNullable<GoldLite["asks"]>[number]) => boolean) => golds.filter((x) => (x.asks ?? []).some(f)).length;
  switch (k) {
    case "道の取り違え": return { n: ps.length, how: "全部の問題の道（決まり）" };
    case "AIXの判断の外れ": return { n: ps.filter((p) => acc(p).some((a) => a.startsWith("AIX")) || (p.mustNot ?? []).some((a) => a.startsWith("AIX"))).length, how: "正解か言ってはいけない道に AIX がある問題" };
    case "AIXの種類の取り違え": return { n: ps.filter((p) => acc(p).some((a) => a.startsWith("AIX:"))).length, how: "正解に AIX の種類がある問題" };
    case "ピッカーの選び違い": return { n: ps.filter((p) => acc(p).some((a) => /^AIX:[\w]+\/.+/.test(a))).length + g((a) => (a.pickers ?? []).some((x) => x.includes("/"))), how: "正解に AIX の細目（ボタン/ピッカー）がある問題（spec＋パーツの正解）" };
    case "自信が低いのに言い切った": return { n: g((a) => a.sure === "low"), how: "パーツの正解の sure=low" };
    case "質問の答えの抜け": return { n: ps.filter((p) => (p.asks ?? []).some((a) => a.route === "reply")).length, how: "依頼に返信で答える物がある" };
    case "約束の抜け": return { n: ps.filter((p) => (p.asks ?? []).some((a) => a.route === "promise")).length, how: "依頼に約束で答える物がある" };
    case "受け止めの抜け": return { n: g((a) => !!a.receive), how: "パーツの正解の receive（気持ちの受け止め）" };
    case "物件ごとの答えの抜け": return { n: ps.filter((p) => /複数物件|物件ごと/.test(textOf(p))).length, how: "複数の物件の依頼（札・型）" };
    case "主語・指す物の取り違え": return { n: ps.filter((p) => /主語|前の物を指す|引用の物件/.test(textOf(p))).length + g((a) => !!a.referent), how: "型・札＋パーツの正解の referent" };
    case "言ってはいけない事": return { n: ps.filter((p) => (p.ng ?? []).length).length, how: "言ってはいけない事がある" };
    case "先に答える外れ": return { n: ps.filter((p) => p.type === "約束の返信を先に").length, how: "型 約束の返信を先に" };
    case "決まりが本質を上書き": return { n: ps.filter((p) => (p.mustNot ?? []).length).length, how: "本質の道（raw_path）を見る問題の目安＝言ってはいけない道がある" };
    case "触れない所に触れた": return { n: ps.filter((p) => /頼まれていない|受けだけ/.test(textOf(p))).length, how: "型・札（頼まれていない約束・受けだけ）" };
    default: return { n: 0, how: "-" };
  }
}
export function buildCoverage(ps: ProblemLike[], golds: GoldLite[] = []): Coverage {
  const stage = MAP_STAGES.map((s) => ({ stage: s, n: ps.filter((p) => mapStageOf(p) === s).length }));
  const link = LINK_IDS.map((l) => { const ids = ps.filter((p) => LINKS[l].match(p)).map((p) => p.id); return { link: l, n: ids.length, ids }; });
  const kind = MISS_KINDS.filter((k) => k !== "合否の外れ（中身は不明）").map((k) => ({ kind: k, ...(({ n, how }) => ({ measurable: n, how }))(measurable(k, ps, golds)) }));
  const goldPickers = golds.flatMap((g) => (g.asks ?? []).flatMap((a) => a.pickers ?? []));
  const specPickers = ps.flatMap((p) => acc(p).filter((a) => a.startsWith("AIX:")).map((a) => a.replace(/^AIX:/, "")));
  const picker = PICKERS.map((pk) => ({ ...pk, n: [...goldPickers, ...specPickers].filter((x) => x === pk.key).length }));
  const stageXlink: Coverage["stageXlink"] = [];
  for (const s of MAP_STAGES) for (const l of LINK_IDS) stageXlink.push({ stage: s, link: l, n: ps.filter((p) => mapStageOf(p) === s && LINKS[l].match(p)).length });
  const draftN = ps.filter((p) => acc(p).some((a) => !a.startsWith("AIX"))).length;
  const tools: Coverage["tools"] = [
    { tool: "LINE ブレインの判断（道・AIX の種類・依頼の答え方）", n: ps.length, how: "brain-exam の stage=brain" },
    { tool: "返信の下書き", n: draftN, how: "正解に返信・約束の道がある問題（stage=draft）" },
    { tool: "AIX の2通目（テンプレート生成・見積書送るの2通目）", n: link.find((l) => l.link === "L5")!.n, how: "2通目を作って採点する道具が無い" },
    { tool: "AIX ツールの物件の判断（property_brain_judgments の点付け・条件）", n: 0, how: "物件の判断を正解つきで測る問題が無い（audit-property-brain の点検だけ）" },
    { tool: "約束の台帳の記録（種類・対象・ピッカーの鍵・新着/ピックアップ）", n: 0, how: "試験は台帳を写すだけで、書いた中身を採点しない" },
  ];
  const holes: Coverage["holes"] = [];
  for (const t of tools) if (!t.n) holes.push({ where: `道具「${t.tool}」`, why: `問題 0問（${t.how}）`, add: toolIdea(t.tool) });
  for (const l of link) if (l.n < 3) holes.push({ where: `つなぎ ${l.link}（${LINKS[l.link].label}）`, why: `問題 ${l.n}問`, add: addIdea(l.link) });
  for (const k of kind) if (k.measurable < 3) holes.push({ where: `外れの型「${k.kind}」`, why: `測れる問題 ${k.measurable}問（${k.how}）`, add: kindIdea(k.kind) });
  const pk0 = picker.filter((p) => !p.n);
  if (pk0.length) holes.push({ where: `ピッカー ${pk0.length}/${picker.length} 個`, why: `正解にピッカーまで書いた問題が無い: ${pk0.map((p) => p.label).join("・")}`, add: "spec の accept に AIX:property_check_result/<細目>（topicKey の形）を書ける形にし、確認の結果を送った竹内さんの実送信（line_watch_turns の property_check_result 171番）から1ピッカー2問ずつ足す。採点は parts-eval の pickerVerdict（ok／picker／button）" });
  for (const s of stage) if (s.n < 4 && s.stage !== "other") holes.push({ where: `申込までの地図「${MAP_STAGE_JA[s.stage]}」`, why: `問題 ${s.n}問`, add: `edited-turn-miner の候補のうち段が「${MAP_STAGE_JA[s.stage]}」の番を読み、正解の道を直して足す` });
  return { stage, link, kind, picker, stageXlink, tools, holes };
}
function toolIdea(t: string): string {
  if (/2通目/.test(t)) return "brain-exam に --stage=second を足し、AIX の1通目の後の番で /api/aix-template-generate と同じ材料で2通目を作って採点（正解＝竹内さんが送った2通目・約束の文・名前・反応が入っているか）。問題は line_watch_turns の2通目のある番から";
  if (/物件の判断/.test(t)) return "property_brain_judgments の profile_snapshot と、竹内さんが実際に送った物件（sent_facts.properties_sent）を正解にした問題（送る／送らないの判断・外す地域・広さ）。読むだけの採点（決まった計算）で始め、迷う所だけ flash";
  if (/約束の台帳/.test(t)) return "試験の後に台帳の写し（sent_facts の confirmation_promised・pickup_declared）を読み、正解の種類・対象・ピッカーの鍵（checkPattern）・新着/ピックアップと照らす（決まった計算・0円）";
  return "問題を足す";
}
function addIdea(l: LinkId): string {
  return ({
    L1: "確認の結果の番（スタッフが property_check_result を送った番）で、正解をボタン＋ピッカーまで書く（例: 駐車場の確認の後→駐車場について）",
    L2: "約束の台帳に確認の約束がある会話の次の番（お客様の『どうでした？』等）で、正解を約束の続きのピッカーにする",
    L3: "同じ建物の確認済み・新着カードが揃った番で、受けだけで閉じず AIX【物件確認した】が正解の問題（12階の例）",
    L4: "お客様の反応（外す地域・広さ）を物件の条件に戻す番。正解は次のピックアップの条件（肥後橋を外す・リビング10帖以上）。採点は条件の差分を機械で照らす新しい物差しが要る",
    L5: "AIX の2通目（テンプレート生成・見積書送るの2通目）の問題。正解は2通目に入るべき約束の文・名前・反応。今の試験は1通目までしか生成しない＝2通目を作る道具が要る",
    L6: "出し切りの後の『新着が出たら送る』と、新しい条件の『ピックアップ』の取り違えの番。正解は 2段:pickup か AIX【物件オススメ】の新着",
  } as Record<LinkId, string>)[l];
}
function kindIdea(k: MissKind): string {
  if (k === "ピッカーの選び違い") return "ピッカーまで書いた正解を足す（上のピッカーの穴と同じ）";
  if (k === "自信が低いのに言い切った") return "資料に無い事を聞かれた番（パーツの正解で sure=low）を gold-20 の形で足す";
  if (k === "受け止めの抜け") return "お礼・謝り・不安の番の receive を gold の形で足す（parts-eval の deriveGold で下書き→竹内さんの確認）";
  if (k === "主語・指す物の取り違え") return "主語の抜けた物件の話・前の物を指す番に referent を付ける";
  if (k === "物件ごとの答えの抜け") return "複数の物件を同時に聞かれた番（物件ごとに答えが違う）を足す";
  if (k === "触れない所に触れた") return "受けだけが正解の番（約束の後のお礼）を足す";
  return "この型が出た本番の外れ（edited-turn-miner）から問題を足す";
}

// ─── 5. 司令塔（pro）: 材料 → 短い JSON → 決まった計算で上限に収める ───────────────────────
export type Candidate = {
  id: string; type: string; stage: MapStage; links: LinkId[]; why: string[]; flaky: boolean; reuse: boolean; draftEligible: boolean;
  lastOk: boolean | null; lastKinds: MissKind[]; protectedPick: boolean; words?: string;
};
export type ConductorInput = {
  change: { cls: string; files: Array<{ file: string; cls: string }>; kbIds: string[]; commits: string[]; reading: DiffReading | null };
  missTop: Array<{ kind: string; n: number }>; linkMiss: Array<{ link: LinkId; label: string; n: number; miss: number }>;
  candidates: Candidate[]; capUsd: number; unit: typeof UNIT_USD; flashOkTypes: string[]; prevFocus: Array<{ id: string; why: string }>;
};
export type FocusItem = { id: string; role: "fix" | "guard"; stage: "brain" | "draft"; reps: number; model: "pro" | "flash"; why: string };
export type ConductorPlan = { focus: FocusItem[]; judge: "tier" | "pro"; judgeAdvice: "tier" | "pro"; claudeFinal: boolean; claudeWhy: string; note: string; source: "pro" | "fallback"; estUsd: number; dropped: Array<{ id: string; why: string }> };

export const CONDUCTOR_SYSTEM = [
  "あなたは賃貸仲介の LINE 接客 AI の『試験の司令塔』です。直した中身と今までの外れの型を見て、少ない費用で直した所と周りの退行を確かめる問題を選びます。",
  "決まり:",
  "- 重点(role=fix): 直した所に効く問題（読み手が言う外れの型・つなぎの線に当たる・RAG の近さが高い・前に落ちた）。",
  "- 見張り(role=guard): 直した所の周り（同じ線・同じ段）で今は合っている問題を少しだけ（退行を見る）。",
  "- 竹内さんのお手本・名指し・前に落ちた（protected=true）は外さない。",
  "- stage: 下書きの文に効く直し（draft の変更）で、下書きの意味がある問題（draftEligible=true）だけ draft。他は brain。",
  "- reps: 1 が基本。揺れる問題（flaky=true）で直した所の重点だけ 2〜3。",
  "- model: 既定 pro。flash は flashOkTypes に入っている型だけ。",
  "- 上限 capUsd に収める（1問1回 brain ≈ unit.brain・draft は +unit.draftExtra・flash は ×unit.flashRatio）。",
  "- judge: 'tier'（機械→flash→割れた時だけ pro）が既定。判定の揺れが直しの的なら 'pro'。",
  "- claude_final: 本番に入れる前の最後の確かめに Claude が要るか（Claude にしか無い部分＝最終チェック・個人情報の番・書く役の Claude を直した時だけ true）。",
  '出力は JSON だけ（説明の文を付けない）: {"focus":[{"id":"q001","role":"fix","stage":"brain","reps":1,"model":"pro","why":"20字"}],"judge":"tier","claude_final":false,"claude_why":"20字","note":"30字"}',
].join("\n");
export function buildConductorUser(i: ConductorInput): string {
  const c = i.change;
  const lines = [
    `【直した中身】段の分類=${c.cls}／ファイル ${c.files.length}: ${c.files.slice(0, 15).map((f) => `${f.file}(${f.cls})`).join("・")}`,
    c.kbIds.length ? `設計知見 id: ${c.kbIds.slice(0, 10).join("・")}` : "",
    c.commits.length ? `コミットの文: ${c.commits.slice(0, 5).map((s) => s.slice(0, 120)).join(" ／ ")}` : "",
    c.reading ? `読み手の読み: 効く所=${c.reading.effects.slice(0, 5).map((e) => e.what).join("・")}／外れの型=${c.reading.kinds.join("・") || "なし"}／線=${c.reading.links.join("・") || "なし"}／段=${c.reading.stages.join("・") || "なし"}` : "読み手の読み: なし",
    `【今までの外れの型（多い順）】${i.missTop.slice(0, 8).map((x) => `${x.kind} ${x.n}`).join("・") || "なし"}`,
    `【つなぎの線の外れ】${i.linkMiss.map((x) => `${x.link}(${x.label}) ${x.miss}/${x.n}`).join("・")}`,
    i.prevFocus.length ? `【前の結果からの次の重点の候補】${i.prevFocus.slice(0, 10).map((x) => `${x.id}:${x.why}`).join("・")}` : "",
    `【上限】capUsd=${i.capUsd.toFixed(2)}・unit=${JSON.stringify({ brain: i.unit.brain, draftExtra: i.unit.draftExtra, flashRatio: i.unit.flashRatio })}・flashOkTypes=${i.flashOkTypes.join("・") || "なし"}`,
    "【候補】（id|型|地図の段|線|前の結果|前の外れの型|揺れ|下書き可|守る|選ばれた理由）",
    ...i.candidates.map((x) => `${x.id}|${x.type}|${MAP_STAGE_JA[x.stage]}|${x.links.join(",") || "-"}|${x.lastOk === null ? "?" : x.lastOk ? "○" : "✕"}|${x.lastKinds.join(",") || "-"}|${x.flaky ? "揺" : "-"}|${x.draftEligible ? "可" : "-"}|${x.protectedPick ? "守" : "-"}|${x.why.slice(0, 2).join("／").slice(0, 80)}`),
  ];
  return lines.filter(Boolean).join("\n");
}
/** JSON を寛容に読む（前後の文・```・末尾のカンマ） */
export function looseJson(text: string): Record<string, unknown> | null {
  const s = String(text ?? "").replace(/```(?:json)?/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  const body = s.slice(a, b + 1).replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}
export function unitCost(it: Pick<FocusItem, "stage" | "reps" | "model">, unit = UNIT_USD): number {
  return (unit.brain + (it.stage === "draft" ? unit.draftExtra : 0)) * (it.model === "flash" ? unit.flashRatio : 1) * it.reps;
}
/**
 * 司令塔の答えを決まった計算で整える: 候補に無い id は捨てる・reps は 1〜3・draft は下書き可の問題だけ・flash は確かめた型だけ（質を落とさない）・
 *   守る問題（protected）が抜けていたら足す・上限に収める（まず見張りの reps を1に → 重点の reps を1に → 見張りを削る → 重点の守らない物を削る）。
 */
export function normalizePlan(raw: Record<string, unknown> | null, i: Pick<ConductorInput, "candidates" | "capUsd" | "flashOkTypes" | "unit">, o: { draftChange: boolean; allowTier?: boolean }): ConductorPlan {
  const byId = new Map(i.candidates.map((c) => [c.id, c]));
  const okFlash = new Set(i.flashOkTypes);
  const dropped: ConductorPlan["dropped"] = [];
  const seen = new Set<string>();
  const focus: FocusItem[] = [];
  for (const f of (Array.isArray(raw?.focus) ? raw!.focus : []) as Array<Record<string, unknown>>) {
    const id = String(f?.id ?? "").trim();
    const c = byId.get(id);
    if (!c) { if (id) dropped.push({ id, why: "候補に無い" }); continue; }
    if (seen.has(id)) continue; seen.add(id);
    const reps = Math.min(3, Math.max(1, Math.round(Number(f.reps) || 1)));
    let stage: FocusItem["stage"] = f.stage === "draft" ? "draft" : "brain";
    if (stage === "draft" && !c.draftEligible) stage = "brain";
    let model: FocusItem["model"] = f.model === "flash" ? "flash" : "pro";
    if (model === "flash" && !okFlash.has(c.type)) model = "pro";
    focus.push({ id, role: f.role === "guard" ? "guard" : "fix", stage, reps, model, why: String(f.why ?? "").slice(0, 60) || c.why[0] || "" });
  }
  for (const c of i.candidates) if (c.protectedPick && !seen.has(c.id)) { focus.push({ id: c.id, role: "fix", stage: o.draftChange && c.draftEligible ? "draft" : "brain", reps: 1, model: "pro", why: `守る線（${c.why.find((w) => /名指し|前に落ちた|お手本|竹内さん/.test(w)) ?? "必ず"}）` }); seen.add(c.id); }
  const fitted = fitToCap(focus, i.capUsd, i.unit, byId);
  dropped.push(...fitted.dropped);
  // 判定の段（tier）は構成の鍵を変える＝前（main）の取り置きも段の判定で作り直しになる。使うのは allowTier（--judge-tier か EXAM_JUDGE_TIER=on）の時だけ・司令塔の勧めは judgeAdvice に残す
  const judgeAdvice = raw?.judge === "pro" ? "pro" : "tier";
  const judge = o.allowTier && judgeAdvice === "tier" ? "tier" : "pro";
  const claudeFinal = raw?.claude_final === true || raw?.claude_final === "true";
  return { focus: fitted.focus, judge, judgeAdvice, claudeFinal, claudeWhy: String(raw?.claude_why ?? "").slice(0, 60), note: String(raw?.note ?? "").slice(0, 80), source: raw ? "pro" : "fallback", estUsd: fitted.est, dropped };
}
export function fitToCap(focus: FocusItem[], cap: number, unit = UNIT_USD, byId?: Map<string, Candidate>): { focus: FocusItem[]; est: number; dropped: Array<{ id: string; why: string }> } {
  const f = focus.map((x) => ({ ...x }));
  const reuse = (id: string) => !!byId?.get(id)?.reuse;
  const est = () => f.reduce((s, x) => s + (reuse(x.id) && x.reps <= 1 ? 0 : unitCost(x, unit)), 0);
  const dropped: Array<{ id: string; why: string }> = [];
  const prot = (id: string) => !!byId?.get(id)?.protectedPick;
  if (est() <= cap) return { focus: f, est: est(), dropped };
  for (const x of f) if (x.role === "guard" && x.reps > 1) x.reps = 1;
  for (const x of f) if (est() > cap && x.role === "fix" && x.reps > 1 && !prot(x.id)) x.reps = 1;
  for (const x of f) if (est() > cap && x.stage === "draft" && x.role === "guard") x.stage = "brain";
  const dropBy = (pred: (x: FocusItem) => boolean, why: string) => { for (let k = f.length - 1; k >= 0 && est() > cap; k--) if (pred(f[k])) { dropped.push({ id: f[k].id, why }); f.splice(k, 1); } };
  dropBy((x) => x.role === "guard" && !prot(x.id), "上限: 見張りを削った");
  dropBy((x) => x.role === "fix" && !prot(x.id), "上限: 重点（守らない物）を削った");
  return { focus: f, est: est(), dropped };
}
/** 司令塔が答えない時の代わり（今の試験のブレインの小さな確かめと同じ順の候補・1回・pro） */
export function fallbackRaw(cands: Candidate[], max = 8): Record<string, unknown> {
  return { focus: cands.slice(0, max).map((c) => ({ id: c.id, role: c.lastOk === false || c.protectedPick ? "fix" : "guard", stage: "brain", reps: 1, model: "pro", why: c.why[0] ?? "" })), judge: "tier", claude_final: false, note: "司令塔なし（決まった順）" };
}

// ─── 6. 読み手（flash）: 差分の読み・結果の振り分け ─────────────────────────────────────
export type DiffReading = { effects: Array<{ what: string; files: string[] }>; kinds: MissKind[]; links: LinkId[]; stages: MapStage[]; query: string };
export const DIFF_READER_SYSTEM = [
  "あなたは賃貸仲介の LINE 接客 AI のコードの差分を読む係です。差分が『お客様への返信・AIX（スタッフが送る定型の操作）の判断』のどこに効く直しかを短く読みます。",
  `外れの型（この中から）: ${MISS_KINDS.filter((k) => k !== "合否の外れ（中身は不明）").join("・")}`,
  `つなぎの線: ${LINK_IDS.map((l) => `${l}=${LINKS[l].label}`).join("・")}`,
  `申込までの地図の段: ${MAP_STAGES.filter((s) => s !== "other").map((s) => `${s}=${MAP_STAGE_JA[s]}`).join("・")}`,
  "推測で広げない。差分に書かれていない事は入れない。",
  '出力は JSON だけ: {"effects":[{"what":"30字","files":["a.ts"]}],"kinds":["ピッカーの選び違い"],"links":["L1"],"stages":["proposing"],"query":"問題を探す言葉 60字"}',
].join("\n");
export function parseDiffReading(text: string): DiffReading | null {
  const j = looseJson(text);
  if (!j) return null;
  const kinds = (Array.isArray(j.kinds) ? j.kinds : []).map(String).filter((k): k is MissKind => (MISS_KINDS as string[]).includes(k));
  const links = (Array.isArray(j.links) ? j.links : []).map(String).filter((l): l is LinkId => (LINK_IDS as string[]).includes(l));
  const stages = (Array.isArray(j.stages) ? j.stages : []).map(String).filter((s): s is MapStage => (MAP_STAGES as string[]).includes(s));
  const effects = (Array.isArray(j.effects) ? j.effects : []).map((e) => ({ what: String((e as Record<string, unknown>)?.what ?? "").slice(0, 60), files: ((e as Record<string, unknown>)?.files as unknown[] ?? []).map(String).slice(0, 5) })).filter((e) => e.what).slice(0, 6);
  return { effects, kinds, links, stages, query: String(j.query ?? "").slice(0, 120) };
}
/** 結果の振り分け（flash）: 機械で中身が分からない外れ（合否の外れ（中身は不明））を型・働き・線に分け、正解との差（抜けた要点）を拾う */
export const TRIAGE_SYSTEM = [
  "あなたは賃貸仲介の LINE 接客 AI の試験の外れを型に振り分ける係です。問題ごとに、正解とブレインの答案の差を短く読みます。",
  `kind はこの中から1つ: ${MISS_KINDS.join("・")}`,
  `link は ${LINK_IDS.join("/")} か null（${LINK_IDS.map((l) => `${l}=${LINKS[l].label}`).join("・")}）`,
  "missing: 正解の要点のうち答案に無い物（各20字まで・最大3つ）。答案に書かれていない事は『無い』。推測で甘くしない。",
  '出力は JSON だけ: {"items":[{"id":"q001","kind":"質問の答えの抜け","link":null,"missing":["駐車場の有無"]}]}',
].join("\n");
export type TriageItem = { id: string; kind: MissKind; link: LinkId | null; missing: string[] };
export function parseTriage(text: string, ids: string[]): TriageItem[] {
  const j = looseJson(text);
  const set = new Set(ids);
  return ((Array.isArray(j?.items) ? j!.items : []) as Array<Record<string, unknown>>)
    .map((x) => ({ id: String(x?.id ?? ""), kind: String(x?.kind ?? ""), link: x?.link == null ? null : String(x.link), missing: (Array.isArray(x?.missing) ? x.missing : []).map(String).map((s) => s.slice(0, 30)).slice(0, 3) }))
    .filter((x) => set.has(x.id) && (MISS_KINDS as string[]).includes(x.kind))
    .map((x) => ({ id: x.id, kind: x.kind as MissKind, link: x.link && (LINK_IDS as string[]).includes(x.link) ? (x.link as LinkId) : null, missing: x.missing }));
}

// ─── 7. 判定の段（機械 → flash → 割れた時だけ pro）の決め方 ───────────────────────────────
export type JudgeVec = { asks: boolean[]; route: boolean[]; ng: boolean[]; rawPath: string | null };
/**
 * 機械の照らし（決まった計算・0円）: 確実に決まる項目だけ埋める（残りは null＝LLM に回す）。
 *   ① 答え方が AIX だけの依頼で、答案に AIX が1つも無い（action・alt_actions が空・reply_mode≠aix）→ covered=false・route=false
 *   ② 依頼も言ってはいけない事も無く本質の道も要らない → 何も呼ばない（今まで通り）
 */
export function machineJudge(asks: Array<{ route?: string; routes?: string[] }>, plan: Record<string, unknown> | null): { asks: Array<boolean | null>; route: Array<boolean | null> } {
  const p = plan ?? {};
  const hasAix = !!String(p.action ?? "").trim() || (Array.isArray(p.alt_actions) && p.alt_actions.length > 0) || p.reply_mode === "aix";
  const a = asks.map((x) => { const rs = [x.route, ...(x.routes ?? [])].filter(Boolean); return rs.length && rs.every((r) => r === "aix") && !hasAix ? false : null; });
  return { asks: a, route: a.map((v) => v) };
}
/** flash 2回の比べ: 項目ごとに同じなら確定・違えば割れ（split の位置）。本質の道は同じなら確定 */
export function mergeFlash(x: JudgeVec, y: JudgeVec): { merged: JudgeVec; splitAsks: number[]; splitNg: number[]; splitRaw: boolean } {
  const splitAsks: number[] = [], splitNg: number[] = [];
  x.asks.forEach((v, i) => { if (v !== y.asks[i] || x.route[i] !== y.route[i]) splitAsks.push(i); });
  x.ng.forEach((v, i) => { if (v !== y.ng[i]) splitNg.push(i); });
  return { merged: x, splitAsks, splitNg, splitRaw: x.rawPath !== y.rawPath };
}
/** 段を重ねた最後の答え: 機械で決まった項目 → flash で揃った項目 → 割れた項目は pro（pro が無ければ flash の1回目＝安全側ではなく「判定の失敗」に近いので印を付ける） */
export function tierFinal(machine: ReturnType<typeof machineJudge>, flash: ReturnType<typeof mergeFlash>, pro: JudgeVec | null): JudgeVec & { by: { machine: number; flash: number; pro: number; unresolved: number } } {
  const by = { machine: 0, flash: 0, pro: 0, unresolved: 0 };
  const asks = flash.merged.asks.map((v, i) => { if (machine.asks[i] !== null && machine.asks[i] !== undefined) { by.machine++; return machine.asks[i]!; } if (!flash.splitAsks.includes(i)) { by.flash++; return v; } if (pro) { by.pro++; return pro.asks[i]; } by.unresolved++; return v; });
  const route = flash.merged.route.map((v, i) => machine.route[i] !== null && machine.route[i] !== undefined ? machine.route[i]! : flash.splitAsks.includes(i) && pro ? pro.route[i] : v);
  const ng = flash.merged.ng.map((v, i) => { if (!flash.splitNg.includes(i)) { by.flash++; return v; } if (pro) { by.pro++; return pro.ng[i]; } by.unresolved++; return v; });
  const rawPath = flash.splitRaw && pro ? pro.rawPath : flash.merged.rawPath;
  return { asks, route, ng, rawPath, by };
}
/** 割れて pro を呼ぶか（機械で決まらず flash が割れた項目が1つでもある・本質の道が割れた） */
export function needPro(machine: ReturnType<typeof machineJudge>, f: ReturnType<typeof mergeFlash>): boolean {
  return f.splitAsks.some((i) => machine.asks[i] === null || machine.asks[i] === undefined) || f.splitNg.length > 0 || f.splitRaw;
}

// ─── 8. 費用 ─────────────────────────────────────────────────────────────
/** DeepSeek の1回の $（usage は DeepSeek の形）。peak＝2倍の時間 */
export function deepseekUsd(model: string, u: { cacheHit: number; cacheMiss: number; output: number }, peak: boolean): number {
  const p = altPriceOf(model) ?? { in: 0.66, read: 0.022, out: 1.98, peakDouble: true };
  return ((u.cacheMiss * p.in + u.cacheHit * p.read + u.output * p.out) / 1e6) * (peak && p.peakDouble ? 2 : 1);
}
