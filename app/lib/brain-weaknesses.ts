// app/lib/brain-weaknesses.ts — ブレインの弱い所の台帳（brain_weaknesses）の純関数（DB も LLM も持たない）
//
// 2026-10-23 竹内さん「ブレイン弱い部分見つかったらメモ入れていく形で 試験のところにそれのめもいれるデータベース作っておく
//   それを根本から改善繰り返していけば精度完全に強くなっていく 足りていない部分があればそこも強化していく形で」
//   弱い所1つ＝1行（key で一意）。見つかる度に occurrences を足し、evidence に印（試験の問題 id・見張りの番 id・分からない事の id）だけを足す。
//   お客様の文・名前・下書きの文は入れない（型の名前・理由の札だけ）。
//   自動で入る道: ① 試験（scripts/exam-brain.ts の外れの理由・scripts/exam-aix-text.ts の抜け/作り事/スタッフだけ）
//                 ② 毎晩の link-brain-watch（brain_unknowns に足したのと同じまとめを、型ごとに弱い所へ寄せる・決まった計算・LLM なし）
//   切替: BRAIN_WEAKNESS_LEDGER（既定 on・off で書かない）

export type WeaknessStatus = "open" | "in_progress" | "fixed" | "wont_fix";
export type WeaknessArea = "brain" | "writer" | "aix" | "exam" | "conductor" | "memory";
export const WEAKNESS_STATUSES: readonly WeaknessStatus[] = ["open", "in_progress", "fixed", "wont_fix"];
export const WEAKNESS_AREAS: readonly WeaknessArea[] = ["brain", "writer", "aix", "exam", "conductor", "memory"];
export const STATUS_JA: Record<WeaknessStatus, string> = { open: "未着手", in_progress: "作業中", fixed: "直した", wont_fix: "やらない" };
export const AREA_JA: Record<WeaknessArea, string> = { brain: "道を選ぶ力", writer: "文を作る力", aix: "AIX", exam: "試験・物差し", conductor: "つなぎ", memory: "記憶・つなぎ" };

/** 印だけ（文は入れない） */
export type WeaknessEvidence = { exam_qids?: string[]; exam_labels?: string[]; watch_turn_ids?: number[]; unknown_ids?: number[] };
export type WeaknessRow = {
  id?: number; key: string; title: string; area: WeaknessArea; symptom: string | null; root_cause: string | null;
  status: WeaknessStatus; fix_ref: string | null; evidence: WeaknessEvidence; occurrences: number;
  first_seen: string | null; last_seen: string | null; created_at?: string; updated_at?: string;
};
/** 見つかった1件（まとめる前） */
export type WeaknessHit = { key: string; title: string; area: WeaknessArea; symptom?: string; n?: number; evidence: WeaknessEvidence; at?: string };

/** 切替（既定 on・止める BRAIN_WEAKNESS_LEDGER=off） */
export function brainWeaknessLedgerEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_WEAKNESS_LEDGER ?? "").trim().toLowerCase() !== "off";
}

const KEY_RE = /^[a-z0-9][a-z0-9:_-]{1,79}$/;
export function isWeaknessKey(k: string): boolean { return KEY_RE.test(k); }

// ─── 種（10/23 の一覧 project_brain_weaknesses_20261023.md の21個） ─────────────
type Seed = Omit<WeaknessRow, "evidence" | "occurrences" | "first_seen" | "last_seen">;
const S = (key: string, area: WeaknessArea, status: WeaknessStatus, title: string, symptom: string, root_cause: string, fix_ref: string | null = null): Seed => ({ key, area, status, title, symptom, root_cause, fix_ref });
export const SEED_WEAKNESSES: readonly Seed[] = [
  S("w01-owner-decisions-not-in-prod", "brain", "in_progress", "竹内さんの決定が本番のブレインに届いていない", "different の88%は道の取り違え", "KB 約100件の会話の型が本番の材料に無い", "feat/brain-priority-step"),
  S("w02-principle-priority-missing", "brain", "in_progress", "原則の優先順位と P0 の2層が本番に無い", "正直→確認の約束→一つ一つに答える→即答→気持ち→次の一手→形 の順で考えない", "D案の中だけにあって本番に無い", "feat/brain-priority-step"),
  S("w03-multi-request-ordering", "brain", "in_progress", "複数の依頼を状況で順番づけする段が無い", "依頼の取りこぼし（D案で 46→38 回）", "並べるだけで順番を決めない", "feat/brain-priority-step"),
  S("w04-conductor-not-wired", "conductor", "open", "つなぎの芯（ハブ・司令塔）が LINE のブレインに未接続", "つなぎの判断が LINE の下書きに効かない", "試験して on にする段が未着手"),
  S("w05-promise-staleness", "memory", "open", "約束・送った物件の古さの決まりが無い", "「〇日前・期限まであと／過ぎ」を言えない", "日時はあるが古さの決まりが無い"),
  S("w06-aix-button-picker-meaning", "aix", "in_progress", "AIX のボタン×ピッカーの意味が浅い", "スタッフの押し間違いを学ぶ恐れ", "場面が弱い時の見せ方・手打ちの当てはめが途中", "竹内基準で学ぶ（済）・場面が弱い時は全部見せる（on）"),
  S("w07-post-apply-facts-guessed", "brain", "in_progress", "申込以降の事実が管理ツールから来ず推測", "番手・審査結果・否決理由を推測で書く", "管理ツールとの連携が合言葉待ち", "連携の段1〜3 作成済み"),
  S("w08-second-place-parallel", "brain", "fixed", "2番手並行の判定が2か所でずれていた", "終わりの読み違い・3番手を数えない", "判定が2か所に分かれていた", "本番"),
  S("w09-writer-not-following-brain", "writer", "open", "書く役がブレインの順番で組み立てていない", "お手本を取ってこない・書いた後の確かめが弱い", "文の根本改善が優先順位の段の後", null),
  S("w10-recommend-second-msg", "writer", "fixed", "物件オススメの2通目の質", "古い希望で「ずれ」と判定し家賃を書かない・理由1〜2つ・締めがご査収だけ", "古い希望を今の希望として読んでいた", "本番（3/15→9/15）"),
  S("w11-aix-text-key-line-missing", "aix", "in_progress", "AIX の文で大事な一言・号室/物件名が抜ける", "「102号室のみ募集中」の抜け・根拠なしの募集終了・内覧日調整が内覧に答えない", "AIX のブレインが内覧日調整にしか入っていない", "AIX のブレイン（内覧日調整だけ on・71→90点）"),
  S("w12-writer-form-rules", "writer", "in_progress", "文の型の決まりが未実装だった", "続きの番の挨拶・条件をそのまま・ご査収は送った時だけ・本日を返さない 等", "文の設計図に無かった", "文の設計図に入れた（試験中）"),
  S("w13-c6-own-apply-viewing", "writer", "fixed", "C6「弊社でもお申込み・ご内覧」が決定と逆", "毎回逆の案内を書く", "状況判断が無かった", "本番"),
  S("w14-promise-list-overwrite", "memory", "fixed", "同じ種類の新しい約束が消える", "約束の並びで新しい物が落ちる", "同じ種類で上書きしていた", "本番"),
  S("w15-estimate-only-promise", "memory", "fixed", "希望だけの持ち込みでも見積だけの約束にしていた", "約束の種類を取り違える", "持ち込みの読み方", "本番"),
  S("w16-first-msg-judgement-lost", "memory", "fixed", "1通目の送信で判断が消え2通目に届かない", "2通目が別の判断で書く", "判断の束を渡していなかった", "本番（判断の束を2通目へ）"),
  S("w17-exam-tomorrow-by-run-date", "exam", "fixed", "試験が回した日で「明日」を読む", "日付の答えがずれる", "試験の時計", "本番"),
  S("w18-exam-main-rerun-all", "exam", "fixed", "main の答えを全問作り直していた", "11時間・$5 かかる", "変わった問題だけにしていなかった", "本番"),
  S("w19-aix-text-not-measured", "exam", "fixed", "AIX の文を測る段が無かった", "押した後の文の質が分からない", "試験がボタンまで", "scripts/exam-aix-text.ts（main 16/30）"),
  S("w20-exam-handtyped-scoring", "exam", "in_progress", "採点が手打ち・押し間違いの番を「違う」と数える", "点が実際より低く出る", "手打ちの当てはめが無い", "feat/handtyped-aix-mapping"),
  S("w21-single-run-noise", "exam", "fixed", "1回だけの試験は揺れで良く見える", "D案 37→42 を良くなったと誤る", "揺れを見ない", "3回ずつで決める決まり"),
];

// ─── 試験の外れの理由 → 弱い所 ─────────────────────────────────────────────
/** scripts/lib/exam-failure-reader.ts の REASON_KINDS（読み手が付けた型）→ 弱い所の鍵 */
export const EXAM_REASON_TO_WEAKNESS: Readonly<Record<string, { key: string; title: string; area: WeaknessArea }>> = {
  "道の取り違え": { key: "w01-owner-decisions-not-in-prod", title: "竹内さんの決定が本番のブレインに届いていない", area: "brain" },
  "依頼の抜け": { key: "w03-multi-request-ordering", title: "複数の依頼を状況で順番づけする段が無い", area: "brain" },
  "注記・材料に引っ張られた": { key: "exam-miss:material-pull", title: "注記・材料に引っ張られて道を外す", area: "brain" },
  "言ってはいけない事": { key: "exam-miss:forbidden", title: "言ってはいけない事を書く", area: "writer" },
  "正解が揺れている": { key: "exam-miss:gold-unstable", title: "試験の正解が似た場面で揺れている", area: "exam" },
  "判定の誤り": { key: "exam-miss:judge-error", title: "試験の判定が誤る", area: "exam" },
};

/** exam-brain の外れの理由（{id, kind} だけ使う・evidence の文は使わない） */
export function weaknessHitsFromExamReasons(label: string, reasons: ReadonlyArray<{ id: string; kind: string }>, at?: string): WeaknessHit[] {
  return reasons.map((r) => {
    const m = EXAM_REASON_TO_WEAKNESS[r.kind] ?? { key: "exam-miss:other", title: "試験の外れ（型が分からない）", area: "exam" as const };
    return { key: m.key, title: m.title, area: m.area, n: 1, evidence: { exam_qids: [r.id], exam_labels: [label] }, at };
  });
}

/** exam-aix-text の落ちた問題（点の中身の「種類」だけ使う・値は使わない） */
export function weaknessHitsFromAixRows(label: string, rows: ReadonlyArray<{ id: string; score: { pass: boolean; missing: string[]; fabricated: string[]; staffOnly: string[] } | null; err?: string | null }>, at?: string): WeaknessHit[] {
  const out: WeaknessHit[] = [];
  for (const r of rows) {
    if (!r.score || r.err || r.score.pass) continue;
    const ev = { exam_qids: [r.id], exam_labels: [label] };
    let any = false;
    if (r.score.missing.length) { any = true; out.push({ key: "w11-aix-text-key-line-missing", title: "AIX の文で大事な一言・号室/物件名が抜ける", area: "aix", n: 1, evidence: ev, at }); }
    if (r.score.fabricated.length) { any = true; out.push({ key: "aix-text:fabricated", title: "AIX の文が入力に無い事実を書く", area: "aix", n: 1, evidence: ev, at }); }
    if (r.score.staffOnly.length) { any = true; out.push({ key: "aix-text:staff-only", title: "AIX の文がスタッフしか知らない事を根拠なしに書く・抜かす", area: "aix", n: 1, evidence: ev, at }); }
    if (!any) out.push({ key: "aix-text:low-score", title: "AIX の文の形・近さが足りない", area: "aix", n: 1, evidence: ev, at });
  }
  return out;
}

// ─── 毎晩の分からない事（brain_unknowns のまとめ）→ 弱い所 ───────────────────
/** brain_unknowns の型×鍵 → 弱い所（決まった計算）。exam_miss_type は試験の道で入れるので寄せない */
export function weaknessKeyForUnknown(kind: string, key: string): { key: string; title: string; area: WeaknessArea } | null {
  const safe = String(key).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40) || "x";
  switch (kind) {
    case "company_rule_missing": return { key: "unknown:company-rules-missing", title: "会社の決まり・金額がブレインの材料に無い（作って書く）", area: "brain" };
    case "staff_only_fact": return { key: "unknown:staff-only-in-draft", title: "下書きがスタッフしか知らない事を言い切る", area: "writer" };
    case "low_confidence_reason": return { key: `unknown:low-confidence:${safe}`, title: `下書きの自信が低い（理由 ${safe}）`, area: "brain" };
    case "watch_break": { // 鍵は「つなぎ:切れの型」→ つなぎごとに寄せる
      const link = String(key).split(":")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40) || "x";
      return { key: `watch-break:${link}`, title: `つなぎの切れ（${link}）`, area: "conductor" };
    }
    default: return null;
  }
}

/** まとめた分からない事（kind・key・数・例の番 id・行の id）から弱い所の印を作る */
export function weaknessHitsFromUnknownAggs(aggs: ReadonlyArray<{ kind: string; key: string; label?: string; n: number; refs?: ReadonlyArray<{ turn_id?: number }>; lastAt?: string | null }>, unknownIdOf: (kind: string, key: string) => number | undefined = () => undefined): WeaknessHit[] {
  const out: WeaknessHit[] = [];
  for (const a of aggs) {
    const w = weaknessKeyForUnknown(a.kind, a.key);
    if (!w || !(a.n > 0)) continue;
    const turnIds = (a.refs ?? []).map((r) => r.turn_id).filter((x): x is number => typeof x === "number");
    const uid = unknownIdOf(a.kind, a.key);
    // 題は型の名前（決まった札）だけ: 自信の理由の日本語・つなぎの名前（切れの型より前）
    const lbl = String(a.label ?? "").slice(0, 40);
    const title = a.kind === "low_confidence_reason" && lbl ? `下書きの自信が低い（${lbl}）` : a.kind === "watch_break" && lbl ? `つなぎの切れ（${lbl.split("：")[0]}）` : w.title;
    out.push({ ...w, title, n: a.n, evidence: { ...(turnIds.length ? { watch_turn_ids: turnIds } : {}), ...(typeof uid === "number" ? { unknown_ids: [uid] } : {}) }, at: a.lastAt ?? undefined });
  }
  return out;
}

// ─── まとめ・足し合わせ ──────────────────────────────────────────────────
const MAX_EV = 20;
function uniqCap<T>(xs: ReadonlyArray<T>, cap = MAX_EV): T[] { const out: T[] = []; for (const x of xs) { if (!out.includes(x)) out.push(x); if (out.length >= cap) break; } return out; }
/** 新しい印を前に、種類ごと20まで */
export function mergeEvidence(oldEv: WeaknessEvidence | null | undefined, add: WeaknessEvidence): WeaknessEvidence {
  const o = oldEv ?? {};
  const out: WeaknessEvidence = {};
  const qids = uniqCap([...(add.exam_qids ?? []), ...(o.exam_qids ?? [])]); if (qids.length) out.exam_qids = qids;
  const labels = uniqCap([...(add.exam_labels ?? []), ...(o.exam_labels ?? [])]); if (labels.length) out.exam_labels = labels;
  const turns = uniqCap([...(add.watch_turn_ids ?? []), ...(o.watch_turn_ids ?? [])]); if (turns.length) out.watch_turn_ids = turns;
  const uids = uniqCap([...(add.unknown_ids ?? []), ...(o.unknown_ids ?? [])]); if (uids.length) out.unknown_ids = uids;
  return out;
}

/** 同じ鍵をまとめる（数は足す・印は合わせる） */
export function aggregateWeaknessHits(hits: ReadonlyArray<WeaknessHit>): WeaknessHit[] {
  const m = new Map<string, WeaknessHit>();
  for (const h of hits) {
    if (!isWeaknessKey(h.key)) continue;
    const a = m.get(h.key);
    if (!a) { m.set(h.key, { ...h, n: h.n ?? 1, evidence: mergeEvidence(null, h.evidence) }); continue; }
    a.n = (a.n ?? 1) + (h.n ?? 1);
    a.evidence = mergeEvidence(h.evidence, a.evidence); // 回の中は出た順
    if (h.at && (!a.at || h.at > a.at)) a.at = h.at;
  }
  return [...m.values()].sort((a, b) => (b.n ?? 1) - (a.n ?? 1));
}

/** 既存の行と足し合わせる（新しい鍵は open で作る・状態・題・原因は人が付けた物を残す） */
export function mergeWeaknessRow(existing: WeaknessRow | null, h: WeaknessHit, nowIso: string): WeaknessRow {
  const at = h.at ?? nowIso;
  if (!existing) {
    return { key: h.key, title: h.title, area: h.area, symptom: h.symptom ?? null, root_cause: null, status: "open", fix_ref: null,
      evidence: mergeEvidence(null, h.evidence), occurrences: h.n ?? 1, first_seen: at, last_seen: at };
  }
  return { ...existing, evidence: mergeEvidence(existing.evidence, h.evidence), occurrences: (existing.occurrences ?? 0) + (h.n ?? 1),
    first_seen: existing.first_seen ?? at, last_seen: existing.last_seen && existing.last_seen > at ? existing.last_seen : at };
}

/** 試験のまとめの表示: この回で触った弱い所（未着手・作業中＝まだ開いている物と、直したのに再び出た物） */
export function renderTouchedWeaknesses(rows: ReadonlyArray<Pick<WeaknessRow, "key" | "title" | "status" | "occurrences" | "fix_ref">>, nThisRun: Readonly<Record<string, number>>): string {
  const touched = rows.filter((r) => nThisRun[r.key]);
  if (!touched.length) return "弱い所の台帳: この回で触った物なし";
  const open = touched.filter((r) => r.status === "open" || r.status === "in_progress").sort((a, b) => (nThisRun[b.key] ?? 0) - (nThisRun[a.key] ?? 0));
  const back = touched.filter((r) => r.status === "fixed");
  const lines = [`弱い所の台帳: この回で触った物 ${touched.length}（開いている ${open.length}${back.length ? `・直したのに再び ${back.length}` : ""}）`];
  for (const r of open) lines.push(`  [${STATUS_JA[r.status]}] ${r.title}: この回 ${nThisRun[r.key]}・通算 ${r.occurrences}（${r.key}）${r.fix_ref ? ` → ${r.fix_ref}` : ""}`);
  for (const r of back) lines.push(`  ⚠ [直した] ${r.title}: この回 ${nThisRun[r.key]}（${r.key}）${r.fix_ref ? ` 直し: ${r.fix_ref}` : ""}`);
  return lines.join("\n");
}
