import { ownersOfMarker } from "../../app/lib/conductor-linkage";
import type { WeaknessHit } from "../../app/lib/brain-weaknesses";
import { essenceOverride } from "./exam-essence";
// scripts/lib/exam-miss-stage.ts — 試験の外れ・悪化の問題で「どの段で道が変わったか」を答案の記録だけで出す（純関数・LLM なし）
//
// 2026-11-06 作業員8（竹内さんの決定 KB P1「試験から改善の仕方も強化・統括同士連携」・統括役の頼み「外れの自動の切り分け」）:
//   11/05〜06 の外れの原因の多くは、ブレインの後の決まった計算の書き換え（two-stage の check_question・guard・場面の網と信号・最終チェックの消し）で、
//   作業員が記録を手で読んで見つけていた。段の順に、答案の行の印を見て最初に道が変わった段を出す:
//     ブレインの生の答え（essence＝LLM が最初に出した道）→ 2段（trace.two_stage）→ 場面の網と信号（trace.scene_evidence）
//     → 決まった書き換え（trace.decision_source_no_aix / decision_source の rule:・guard:）→ 書き手（draft.code）→ 最終チェック
//   原因の3つ（材料が届いていない／場面・決まりの読み違い／AIX の番を返信にした）への振り分けは下書き（人が確かめる）。
//   持ち主の統括は、連携の表（作業員5・writes の印の名前・前方一致）で引く。表が来るまでは下の仮の表。

export type MissRowLite = {
  id: string;
  rep?: number;
  essence?: { code?: string | null; ok?: boolean | null } | null;
  path?: { code?: string | null; ok?: boolean | null } | null;
  draft?: { code?: string | null; ok?: boolean | null; pass?: boolean | null; asks?: boolean[] | null } | null;
  trace?: Record<string, unknown> | null;
  brain?: { demoted_overrides?: unknown; reply_direction?: string | null; turn_contract?: unknown } | null;
  raw?: { reply_direction?: string | null; customer_questions?: unknown; proposals?: unknown; aix?: unknown; turn_contract?: unknown } | null;
  asks?: Array<{ covered?: boolean; route?: boolean }> | null;
  score?: { pass?: boolean; path?: boolean } | null;
  /** その回の記録の印（brain-exam の出力の {"tag":"brain:…"}・[mgmt-*] の行・parseLogTags で付ける） */
  logTags?: string[] | null;
};
export type MissStage = "brain" | "two_stage" | "scene_net" | "rewrite" | "writer" | "text" | "final_check" | "asks" | "none";
export type MissCause = "材料が届いていない" | "場面・決まりの読み違い" | "AIX の番を返信にした" | "要確認";
export type StageHit = { stage: MissStage; marker: string; note: string };
export type MissVerdict = { id: string; stage: MissStage; stages: StageHit[]; markers: string[]; from: string | null; to: string | null; cause: MissCause; line: string };

const isReplyLike = (c: string | null | undefined) => !!c && (c === "返信" || c.startsWith("2段") || c.startsWith("2択"));
const isAix = (c: string | null | undefined) => !!c && c.startsWith("AIX:");
/** two-stage の方向の文の決まった型（ピックアップ・確認の約束の返信にする） */
export const TWO_STAGE_DIRECTION_TAIL = /(?:ピックアップ|確認)[^。]{0,40}(?:お送り|ご連絡)[^。]{0,30}約束する返信にする/;
const flat = (v: unknown): string => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") : typeof v === "string" ? v : v ? JSON.stringify(v) : "");

/** 答案の行の印（連携の表の writes と同じ名前・前方一致で引く） */
export function markersOf(r: MissRowLite): string[] {
  const t = (r.trace ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["decision_source_no_aix", "decision_source"]) {
    const v = typeof t[k] === "string" ? String(t[k]) : "";
    if (v) out.push(`decision:${v.replace(/^rule:/, "")}`);
  }
  if (typeof t.two_stage === "string" && t.two_stage) out.push(`two_stage:${t.two_stage}`);
  const se = t.scene_evidence as { scene?: string } | null | undefined;
  if (se && se.scene) out.push(`scene_net:${se.scene}`);
  const dem = (r.brain?.demoted_overrides ?? []) as unknown;
  if (Array.isArray(dem)) for (const d of dem) { const n = typeof d === "string" ? d : (d as { kind?: string; name?: string })?.kind ?? (d as { name?: string })?.name; if (n) out.push(`demoted:${n}`); }
  for (const lt of r.logTags ?? []) out.push(lt);
  return out;
}

/**
 * brain-exam の出力（係の out.log）から、回ごとの記録の印を拾う（純関数）。{"tag":"brain:xxx","conversationId":…} と [mgmt-xxx] の行を、
 *   同じ会話（レーン＝テスト用の会話）の次の結果の行「[YUMAn] ○|✕ qNNN#k」に付ける。印の名前は log:<tag の brain: の後ろ>（answerable-direct は core と to も付ける）。
 *   拾う tag は道や文を変えうる物だけ（rag・kn-used 等の記録だけの物は拾わない）
 */
export const DECIDING_TAGS = /^(?:answerable-direct|two-stage|guard|screening|sent-reaction|resay|mgmt|night|turn-route|demote|override|rewrite|direct-aix|closing)/;
export function parseLogTags(text: string, convName: (id: string) => string | null): Map<string, string[]> {
  const pending = new Map<string, string[]>();
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    // 実行の始まり（下見の回・前を作る子の回の印を次の本物の回に持ち越さない）
    if (line.includes("=== テスト「")) { pending.clear(); continue; }
    const res = line.match(/^\[(YUMA\d?)\]\s+[○✕]\s+(q\d+)#(\d+)/);
    if (res) { const k = `${res[2]}#${res[3]}`; const got = pending.get(res[1]) ?? []; if (got.length) out.set(k, [...(out.get(k) ?? []), ...got]); pending.set(res[1], []); continue; }
    if (line.startsWith('{"tag":"brain:')) {
      try {
        const j = JSON.parse(line) as { tag: string; conversationId?: string; core?: string; to?: string };
        const t = j.tag.replace(/^brain:/, "");
        if (!DECIDING_TAGS.test(t)) continue;
        const name = j.conversationId ? convName(j.conversationId) : null;
        if (!name) continue;
        const mk = `log:${t}${j.core ? `(${String(j.core).replace(/^rule:/, "")}→${j.to ?? "?"})` : ""}`;
        pending.set(name, [...(pending.get(name) ?? []), mk]);
      } catch { /* 途中で切れた行 */ }
      continue;
    }
    const mg = line.match(/\[(mgmt-[\w-]+)\]/);
    if (mg) {
      const cid = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      const name = cid ? convName(cid) : null;
      if (name) pending.set(name, [...(pending.get(name) ?? []), `log:${mg[1]}`]);
    }
  }
  return out;
}

/** 1つの外れの回の切り分け: 段を順に全部並べる（ブレインの生の答え→2段→場面の網→決まった書き換え→書き手→文の中身→最終チェック） */
export function classifyMiss(r: MissRowLite): MissVerdict {
  // 2026-11-06 統括役: 本質の道は試験の採点と同じ数え方（物件の AIX＋該当の route が promise＋候補0件＝2段:pickup・scripts/lib/exam-essence.ts）
  const ess0 = r.essence?.code ?? null;
  const ess = (ess0 && ess0.startsWith("AIX:") ? essenceOverride(r.raw as Record<string, unknown> | null, (r.trace?.pickup_ready as boolean | null | undefined) ?? null) : null) ?? ess0, fin = r.path?.code ?? null, dr = r.draft?.code ?? null;
  const m = markersOf(r);
  const st: StageHit[] = [];
  // 2026-11-07 統括役（作業員7の確かめ・弱い所 394）: 最終の道が正解の回は、道を変えた段（2段・決まった書き換え・ブレイン）を外れの段にしない。
  //   2段が道を正解の向きに変えた回（q081・q174・q011）は、外れが依頼／下書きの側＝書き手（持ち主 作業員9）
  const pathOk = r.path?.ok === true;
  // ブレインの生の答えが外れ（読みの材料: customer_questions・proposals の頭）
  if (!pathOk && r.essence && r.essence.ok === false) {
    const dirHead = (r.brain?.reply_direction ?? r.raw?.reply_direction ?? "").trim();
    const read = [flat(r.raw?.customer_questions), flat(r.raw?.proposals), TWO_STAGE_DIRECTION_TAIL.test(dirHead) ? "" : dirHead.slice(0, 40)].filter(Boolean).join(" / ").replace(/\s+/g, " ").slice(0, 100);
    st.push({ stage: "brain", marker: "brain:essence", note: `生の答え ${ess}${read ? `（読み: ${read}）` : ""}` });
  }
  // 道を変えた段（印の順。decision:llm は2層目のブレイン）
  for (const x of pathOk ? [] : m.filter((y) => y !== "decision:llm")) {
    if (/^(?:decision:two_stage|two_stage:)/.test(x)) { if (!st.some((s) => s.stage === "two_stage")) st.push({ stage: "two_stage", marker: x, note: `2段の決まった書き換え ${x}` }); }
    else if (/^log:answerable-direct/.test(x) || /^decision:(?:guard|answerable|direct)/.test(x)) st.push({ stage: "rewrite", marker: x, note: `決まった書き換え ${x}` });
    else if (/^log:/.test(x)) st.push({ stage: "rewrite", marker: x, note: `記録の印 ${x}` });
    else if (/^decision:/.test(x) && ess !== fin) st.push({ stage: "rewrite", marker: x, note: `決まった書き換え ${x}` });
  }
  if (ess && fin && ess !== fin && m.includes("decision:llm") && !st.some((s) => s.stage === "rewrite" || s.stage === "two_stage")) st.push({ stage: "brain", marker: "decision:llm", note: "2層目（今回の発言）のブレインが変えた" });
  const sc = m.find((x) => x.startsWith("scene_net:"));
  if (sc && ess !== fin && !st.some((s) => s.marker !== "brain:essence")) st.push({ stage: "scene_net", marker: sc, note: `場面の網と信号 ${sc}` });
  // 書き手: 下書きの道が最終の道と違う
  if (dr && fin && dr !== fin) st.push({ stage: "writer", marker: "writer", note: `下書きの道 ${fin} → ${dr}` });
  // 2段の方向の文の決まった尾（two-stage が方向の文を決まった型に置き換えた・生の方向が無くても型で見分ける）
  const finDir0 = (r.brain?.reply_direction ?? "").trim();
  if (TWO_STAGE_DIRECTION_TAIL.test(finDir0) && !st.some((s) => s.marker === "text:direction_tail")) st.push({ stage: "text", marker: "text:direction_tail", note: "2段の方向の文の決まった尾（約束の型の文に置き換わった）" });
  // 文の中身: 道（か下書きの道）は正しいのに下書きの要点が抜けた＝方向の文の決まった尾・本質の帯を見る
  if ((r.path?.ok || r.draft?.ok) && r.draft && r.draft.pass === false) {
    const rawDir = (r.raw?.reply_direction ?? "").trim(), finDir = (r.brain?.reply_direction ?? "").trim();
    if (rawDir && finDir && rawDir !== finDir && !st.some((s) => s.marker === "text:direction_tail")) st.push({ stage: "text", marker: "text:direction_tail", note: `方向の文が決まった計算で変わった（生 ${rawDir.length}字 → 最終 ${finDir.length}字${finDir.startsWith(rawDir) ? "・尾を足した" : ""}）` });
    if (r.brain?.turn_contract) st.push({ stage: "text", marker: "text:turn_contract", note: "本質の帯（turn_contract）に沿った文の要点が抜けた" });
    if (!st.some((s) => s.stage === "text")) st.push({ stage: "final_check", marker: "final_check", note: "道は同じで下書きの要点が抜けた（最終チェックの消しか書き手）" });
  }
  // 道が正解の回は、外れの段の頭を書き手（依頼／下書きの側）にする（文の中身・最終チェックの段は細目として後ろに残す）
  // 2026-11-12 作業員10（統括役の頼み・持ち主の付け違い）: 答案に下書きが無い回（--stage=brain）の依頼の外れは、ブレインの答え（turn_contract の答え・道）の外れ＝持ち主はブレイン。
  //   今まで書き手（writer:asks）に数え、通算76のうち 23問・63回がブレインの段の答案だった（11/12 の読み）。試験の数えだけの変更（本番の動きは変わらない）
  const noDraft = !r.draft || (r.draft.code == null && r.draft.pass == null && !(r.draft.asks ?? []).length);
  if (pathOk && noDraft && !st.some((x) => x.stage === "writer" || x.stage === "final_check")) st.unshift({ stage: "brain", marker: "brain:asks", note: (r.asks ?? []).some((a) => a.covered === false) ? "道は正解でブレインの答えの依頼の答え方が外れた（下書きなし）" : "道は正解でブレインの答えの側で外れた（下書きなし）" });
  else if (pathOk && !st.some((x) => x.stage === "writer" || x.stage === "final_check")) st.unshift({ stage: "writer", marker: "writer:asks", note: (r.asks ?? []).some((a) => a.covered === false) ? "道は正解で依頼の答え方が抜けた（依頼／下書きの側）" : "道は正解で依頼／下書きの側で外れた" });
  if (!st.length) st.push({ stage: "none", marker: "none", note: "段が決められない" });
  const cause: MissCause = r.essence?.ok && !r.path?.ok ? (isAix(ess) && isReplyLike(fin) ? "AIX の番を返信にした" : "場面・決まりの読み違い") : "要確認";
  // 下書きの無い回のブレインの答えの外れ（brain:asks）は、他の段（方向の文の尾 等）があってもブレインを頭にする
  const primary = st.find((s) => s.marker === "brain:asks") ?? st.find((s) => s.stage !== "brain") ?? st[0];
  const markers = [...new Set([...st.map((s) => s.marker).filter((x) => !/^(?:brain:essence|none|asks)$/.test(x)), ...m])];
  const line = `${r.id}${r.rep ? `#${r.rep}` : ""}: ${st.map((s) => `${STAGE_JA[s.stage]}（${s.note}）`).join(" → ")}・道 ${ess ?? "?"} → ${fin ?? "?"}${dr && dr !== fin ? ` → 下書き ${dr}` : ""}・原因の下書き: ${cause}`;
  return { id: r.id, stage: primary.stage, stages: st, markers, from: ess, to: fin, cause, line };
}

export const STAGE_JA: Record<MissStage, string> = { brain: "ブレイン", two_stage: "2段", scene_net: "場面の網と信号", rewrite: "決まった書き換え", writer: "書き手", text: "文の中身", final_check: "最終チェック", asks: "依頼の答え方", none: "（不明）" };

/** 同じ問題の外れの回をまとめる（回ごとの段の並びを数え、一番多い並び＋ほかの並び・回ごとの行も返す） */
export function summarizeMisses(rows: MissRowLite[]): { id: string; n: number; stage: MissStage; markers: string[]; line: string; perRep: string[]; reps: number[]; essence: string | null } | null {
  const bad = rows.filter((r) => r.score && r.score.pass === false);
  if (!bad.length) return null;
  const vs = bad.map(classifyMiss);
  const key = (v: MissVerdict) => v.stages.map((s) => s.stage).join(">");
  const cnt = new Map<string, number>(); for (const v of vs) cnt.set(key(v), (cnt.get(key(v)) ?? 0) + 1);
  const topKey = [...cnt].sort((a, b) => b[1] - a[1])[0][0];
  const pick = vs.find((v) => key(v) === topKey)!;
  const others = [...cnt].filter(([k]) => k !== topKey).map(([k, n]) => `${k.split(">").map((x) => STAGE_JA[x as MissStage]).join("→")} ${n}回`);
  return { id: pick.id, n: bad.length, stage: pick.stage, markers: [...new Set(vs.flatMap((v) => v.markers))], perRep: vs.map((v) => v.line), reps: bad.map((r) => r.rep ?? 0), essence: pick.from,
    line: `${pick.line}・外れ ${cnt.get(topKey)}/${bad.length}回${others.length ? `（ほかの並び: ${others.join("・")}）` : ""}` };
}

/** 連携の表の1行（作業員5の形・writes の印の名前で引く） */
export type LinkRow = { id: string; owner: string; files?: string[]; writes: string[] };
/** 仮の表（テスト用。本物は作業員5の連携の表 app/lib/conductor-linkage.ts） */
export const PROVISIONAL_LINKS: LinkRow[] = [
  { id: "two_stage", owner: "（仮）", files: ["app/lib/two-stage-*.ts"], writes: ["decision:two_stage", "two_stage:"] },
  { id: "scene_net", owner: "（仮）", files: ["app/lib/scene-*.ts"], writes: ["scene_net:"] },
];
/** 印 → 持ち主。既定は作業員5の連携の表（ownersOfMarker・一番長い一致）。table を渡した時はその表（前方一致・最初に当たった行） */
export function ownerOf(markers: string[], table?: LinkRow[]): LinkRow | null {
  if (table) { for (const mk of markers) for (const row of table) if (row.writes.some((w) => mk.startsWith(w))) return row; return null; }
  for (const mk of markers) { const hit = ownersOfMarker(mk)[0]; if (hit) return { id: hit.id, owner: hit.owner, files: hit.files, writes: hit.writes }; }
  return null;
}

/** brain_weaknesses に入れる1行の案（key は段＋印の頭＝同じ型の外れは同じ key で重なりを見る） */
export function weaknessDraft(s: { id: string; stage: MissStage; markers: string[]; line: string }, owner: LinkRow | null, ess?: { essence?: string | null; accept?: string | null }): { key: string; title: string; area: "exam" | "brain" | "writer"; root_cause: string; evidence: Record<string, unknown> } {
  const head = (s.markers[0] ?? "none").replace(/\(.*$/, "");
  return {
    key: weaknessKeyOf(s.stage, s.markers, ess) ?? `exam-stage:${s.stage}:none`,
    title: s.stage === "brain" && ess?.essence ? `試験の外れ: ブレインの本質の道が ${ess.essence}（正解 ${ess.accept ?? "?"}）` : `試験の外れ: ${STAGE_JA[s.stage]}で道が変わる（${head}）`,
    area: s.stage === "writer" || s.stage === "final_check" ? "writer" : s.stage === "brain" ? "brain" : "exam",
    root_cause: `${s.line}${owner ? `・持ち主 ${owner.id}（${owner.owner}）` : "・持ち主は連携の表に無い"}`,
    evidence: { problem: s.id, markers: s.markers, owner: owner?.owner ?? null },
  };
}

/** 印の頭を台帳の key に使える形へ（小文字・英数と : _ - だけ・80字まで）。使えなければ null */
export function weaknessKeyOf(stage: MissStage, markers: string[], ess?: { essence?: string | null; accept?: string | null }): string | null {
  // ブレインの段は、印の代わりに「本質の道→正解の道」の組を頭にする（11/06 統括役「exam-stage:brain:none は粗い」＝条件の番で本質が物件送付、のような型が同じ key にまとまる）
  const head = stage === "brain" && ess?.essence ? `ess:${pathSlug(ess.essence)}-to-${pathSlug(ess.accept)}` : (markers[0] ?? "none").replace(/\(.*$/, "");
  const k = `exam-stage:${stage}:${head}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, "_").replace(/_+$/, "").slice(0, 80);
  return /^[a-z0-9][a-z0-9:_-]{1,79}$/.test(k) ? k : null;
}

/**
 * 外れの切り分けから brain_weaknesses に足す物（WeaknessHit の形・純関数）。統括役 11/06「同じ key（段＋印の頭）の open の行があれば新しい行は作らず evidence に足す・持ち主・試験の名前・問題・回・1回の試験で5行まで・既定 on」。
 *   同じ key は upsertWeaknessHits が既存の行にまとめる（key は一意。直した行に再び当たった時は既存の表示どおり「直したのに再び」に出る）。
 *   段が決められない（none）・依頼の答え方だけ（asks）は入れない。6つ目以降の key は捨てる（外れの多い順に5つ）
 */
export function weaknessHitsFromMisses(label: string, misses: ReadonlyArray<{ id: string; n: number; stage: MissStage; markers: string[]; line: string; reps?: number[]; essence?: string | null }>, opts: { max?: number; owner?: (markers: string[]) => LinkRow | null; acceptOf?: (id: string) => string | null } = {}): WeaknessHit[] {
  const max = opts.max ?? 5, own = opts.owner ?? ((mk: string[]) => ownerOf(mk));
  const byKey = new Map<string, WeaknessHit>();
  const sorted = [...misses].sort((a, b) => b.n - a.n);
  for (const m of sorted) {
    if (m.stage === "none" || m.stage === "asks") continue;
    const ess = { essence: m.essence ?? null, accept: opts.acceptOf?.(m.id) ?? null };
    const key = weaknessKeyOf(m.stage, m.markers, ess); if (!key) continue;
    const o = own(m.markers);
    const reps = (m.reps?.length ? m.reps : [0]).map((r) => `${label} ${m.id}#${r}`);
    const owners = o ? [`${o.id}（${o.owner}）`] : [];
    const cur = byKey.get(key);
    if (cur) {
      cur.n = (cur.n ?? 0) + m.n;
      cur.evidence = { ...cur.evidence, exam_qids: [...new Set([...(cur.evidence.exam_qids ?? []), m.id])], exam_reps: [...(cur.evidence.exam_reps ?? []), ...reps], owners: [...new Set([...(cur.evidence.owners ?? []), ...owners])] };
      continue;
    }
    if (byKey.size >= max) continue;
    const d = weaknessDraft(m, o, ess);
    byKey.set(key, { key, title: d.title, area: d.area, symptom: d.root_cause.slice(0, 500), n: m.n, evidence: { exam_qids: [m.id], exam_labels: [label], exam_reps: reps, owners } });
  }
  return [...byKey.values()];
}

/** 道の分類（返信・2段:pickup・AIX:property_send（左だけ）等）を key に使える英字へ（括弧の注は落とす）。11/06 統括役 */
export function pathSlug(code: string | null | undefined): string {
  const c = String(code ?? "").replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (!c) return "unknown";
  if (c === "返信") return "reply";
  if (c === "なし") return "none";
  const m = c.match(/^(2段|2択|AIX):?(.*)$/);
  const pre = m ? ({ "2段": "two_stage", "2択": "choice", AIX: "aix" } as Record<string, string>)[m[1]] : "";
  const rest = (m ? m[2] : c).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [pre, rest].filter(Boolean).join("_") || "other";
}
