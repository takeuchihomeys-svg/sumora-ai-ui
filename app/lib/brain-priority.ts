// app/lib/brain-priority.ts — ブレインの「優先順位を決めて考える」段（純関数・DB/LLM なし）
//
// 2026-10-23 竹内さん（設計知見 e6822636・P0 87456221・P1 64572c06）:
//   「優先順位決めれて考えれているか 何のことを伝えるか 何のことについてきかれているか そこに対する判断するとき状況に応じて優先順位きめてかんがえることできてるのかな」
//   「ここも原則と応用をつかって人間のように考えるように、状況に応じたそのためのデータも引っ張ってこれるようにしたら、更に強くなる」
// 形:
//   ① 原則の層（2層＝原則→応用・原則の優先 正直→確認の約束→一つ一つに答える→即答→気持ち→次の一手→形）を本番のブレインの静的な system に入れる（キャッシュの前置き）
//   ② 出力に priorities（聞かれた事・伝える事を順位つきで・扱い・状況に根ざした短い理由）
//   ③ 書く役は順位どおりに書く（turn-contract の本質の帯に並べる）・AIX の扱いの項目は最終の AIX とそろえる
//   ④ お客様の依頼（turn_contract.asks・customer_questions）が priorities から抜けていないかを確かめ、抜けは足して記録する
//   ⑤ 状況の材料の取り寄せ（BRAIN_PRIORITY_RETRIEVAL）: 場面 → 竹内さんの決定（設計知見・P0 は必ず先頭）を上位 k で引き、引いた物を記録する（brain-priority-server.ts）
// スイッチ: BRAIN_PRIORITY_STEP=on（既定 off＝今と1文字も変わらない）。取り寄せは BRAIN_PRIORITY_RETRIEVAL（既定は STEP に従う・off で止める）

export type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => { const s = (v ?? "").trim().toLowerCase(); return s === "on" || s === "1" || s === "true"; };

/** BRAIN_PRIORITY_STEP（2026-10-27 竹内さん「オススメで」から既定 on・off で止める。DeepSeek 34問×3 合格 17→20・道 60→66%・依頼 60→65%・悪化0／Claude 悪化0） */
export function priorityStepOn(env: Env = envOf()): boolean { return (env.BRAIN_PRIORITY_STEP ?? "").trim().toLowerCase() !== "off"; }
/** BRAIN_PRIORITY_RETRIEVAL（STEP が on の時だけ・既定 on・off で止める） */
export function priorityRetrievalOn(env: Env = envOf()): boolean {
  if (!priorityStepOn(env)) return false;
  return (env.BRAIN_PRIORITY_RETRIEVAL ?? "").trim().toLowerCase() !== "off";
}
/**
 * 2026-10-23 試験 q047・q106 の悪化の根（brain-priority-server の取り寄せ）: 場面の語だけで引いた P1 の決定は「同じ場面の別の状況」の決まりだった
 *   （q047 送った見積の金額の確かめ＝返信 に「初期費用→AIX 見積書」の決定群・q106 申込の流れの質問＝返信 に「審査の相談→AIX 管理会社に確認した」）。
 *   それを「竹内さんの決定（応用の根拠）」として見せると、ブレインが状況の違う決まりを当てて約束・AIX に倒れる。手元の語の点では状況の一致を見分けられない
 *   （34問で測った: 関係する行もしない行も同じ点）。→ P1 の決定は既定で引かない（原則＝P0 の題と状況の材料の目次だけ）。試す時だけ BRAIN_PRIORITY_KB_P1=on
 */
export function priorityKbP1On(env: Env = envOf()): boolean { return on(env.BRAIN_PRIORITY_KB_P1); }

// ── ① 原則の層（静的・キャッシュの前置きに入る） ───────────────────────────────
export const BRAIN_PRIORITY_RULES = `【基本の考え方（原則）と応用 — 優先順位を決めて考える（priorities の決め方）】
人の営業と同じに、まず原則（土台）で考え、場面の決まり（応用）はそこから導く。決まりに無い場面・決まりがぶつかる場面も原則に戻って決める。
原則の優先順位（オススメの順。状況で入れ替えてよいが、入れ替えた時は理由に書く）:
  1 正直（嘘・推測で書かない。分からない事は分からない）→ 2 確認の約束（物件ごとに違う事・スタッフ／管理会社しか知らない事は確かめると約束するか AIX。約束はまだしていない事だけ＝もう約束した事を重ねて約束しない）→ 3 一つ一つに答える（依頼を落とさない）→ 4 即答（答えられる事はこの返信で答える）→ 5 気持ち（不安・焦り・恐縮を受ける）→ 6 次の一手（内覧・申込・ピックアップ等、申込までの地図の次の駅）→ 7 形（言い方・長さ）。
「スタッフしか知らない・確かめる事」かは話題の語（費用・審査・空き・内覧）ではなく、答えが今ある材料（会話・こちらが送った物・資料・会社の事実・業界の知識）に有るかで決める。
  有る＝即答（例: こちらが送った見積の金額の確かめ・申込から入居までの流れ・審査の一般の流れと期間）／無い＝確認の約束か AIX（例: その部屋の空き・管理会社の判断・この方の審査の見込み・まだ作っていない見積・内覧の候補日）。
  こちらが確かめる・交渉すると約束した後の番（お客様はお礼・了承・「よろしく」だけ）は、その依頼をもう一度「聞かれた事」にして約束し直さない。約束の続き＝確かめた結果を返す事を ② 伝える事に入れ、結果はスタッフしか知らない中身なので aix。
考える順（この順で priorities を作る）:
  ① 何を聞かれているか: 今回の連投の依頼・質問・懸念・報告・意思（「契約したい」「ここに決めたい」「実際に見て決めたい」等＝次の一手につながる）を全部（turn_contract.asks と同じ物は必ず全部入れる・1つも落とさない）。
     意思は気持ち（5）ではなく次の一手（6）として扱う。前向きな言葉に包まれていても「見たい・決めたい・申し込みたい」は受け止めだけで終わらせず、次の一手の中身（内覧の候補日・申込の段取り等）がスタッフしか知らない時は aix。
     1つの文に意思と質問が両方あれば別の項目に分ける（例「契約したいのですが審査など詳細を聞きたい」→ 意思＝aix（申込へ）／審査の流れの質問＝answer_now）。AIX の番でも、答えが材料に有る質問は AIX に含めず本文で答える。
  ② 何を伝えるか: こちらから伝えるべき事（まだ果たしていない約束の続き・期限・送った物への続き・次の一手・気持ちの受け）。無ければ入れない。
     伝える事は、今の発言（①）に答えた上で添える物。今の発言が別の物件・別の話の時、前の番からの約束の続きで今の発言の答えを置き換えない（出力の aix は今の発言への一手。約束の結果を送る AIX はその後の番）。
     伝える事にも同じ物差しを当てる: 次の一手が内覧のご案内の時、その部屋をいつから見られるか（空室か退去予定か）が材料に無ければ、推測で「内覧できます」と書かず aix（内覧調整＝スタッフが確かめた中身を送る）。
  ③ 状況で順位を決める: お客様の熱（新規・内覧歴・申込歴・反応の速さ）／申込までの地図のどの駅か／期限まで何日か（今日から数えた日数で考える）／気持ち／スタッフしか知らない事か。【この番に引いた判断の材料】があれば竹内さんの決定を応用の根拠にする。
  ④ それぞれの扱いを1つ: answer_now（この返信で答える）／confirm（確かめる・作る・探すと約束する）／aix（AIX で送る＝スタッフだけが知る事・AIX の番。ボタンのキーも書く）／later（今は触れず後の番で）／skip（触れない＝もう答えた・触れない方がよい）。
  扱いは turn_contract.asks の route（reply→answer_now・promise→confirm・aix→aix・none→skip）と、出力の aix とそろえる（aix の項目のキーは出力の aix と同じ）。
  理由（reason）は状況の事実で短く（例「申込の前の駅・入居まで12日」「審査の不安が2回目」「空きはスタッフしか知らない」）。一般論・原則の名前だけの理由は書かない。`;

// ── ② 出力の形（JSON の欄） ────────────────────────────────────────────────
export const BRAIN_PRIORITIES_FIELD = `"priorities": [{"rank": "1から順の番号（1が一番先に扱う）", "kind": "asked（お客様に聞かれた・頼まれた事）|convey（こちらから伝える事）", "item": "何の事かを30字以内で", "quote": "kind=asked の時はお客様の言葉そのまま（40字以内）。convey は null", "handling": "answer_now|confirm|aix|later|skip", "aix": "handling=aix の時だけ AIX のキー（能力マップ）。他は null", "reason": "なぜこの順位・この扱いか（状況の事実で・40字以内）"}]`;

// ── 型 ──────────────────────────────────────────────────────────────────
export const HANDLINGS = ["answer_now", "confirm", "aix", "later", "skip"] as const;
export type Handling = typeof HANDLINGS[number];
export type PriorityItem = {
  rank: number;
  kind: "asked" | "convey";
  item: string;
  quote: string | null;
  handling: Handling;
  aix: string | null;
  reason: string;
  /** 抜けを足した項目（ブレインが書かなかった依頼） */
  added?: boolean;
};
export const HANDLING_JA: Record<Handling, string> = {
  answer_now: "この返信で答える", confirm: "確かめる・作る・探すと約束する", aix: "AIX で送る（本文では答えない）", later: "今は触れない（後の番で）", skip: "触れない",
};

const clip = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const nullish = (v: unknown) => v == null || String(v).trim() === "" || String(v).trim() === "null";

/** ブレインの priorities を整える（型の外れた値は落とす・順位で並べ直す・最大8件）。無ければ [] */
export function normalizePriorities(raw: unknown, normAix: (k: string | null) => string | null = (k) => k): PriorityItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PriorityItem[] = [];
  raw.forEach((x, i) => {
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    const item = clip(o.item, 40);
    const quote = nullish(o.quote) ? null : clip(o.quote, 40);
    if (!item && !quote) return;
    const handling = (HANDLINGS as readonly string[]).includes(String(o.handling)) ? (String(o.handling) as Handling) : "answer_now";
    const rankN = Number(o.rank);
    const kind = String(o.kind) === "convey" ? "convey" : (String(o.kind) === "asked" || quote ? "asked" : "convey");
    out.push({
      rank: Number.isFinite(rankN) && rankN > 0 ? rankN : i + 1,
      kind, item: item || (quote ?? ""), quote: kind === "asked" ? quote : null, handling,
      aix: handling === "aix" && !nullish(o.aix) ? normAix(clip(o.aix, 60)) : null,
      reason: clip(o.reason, 50),
    });
  });
  return out.sort((a, b) => a.rank - b.rank).slice(0, 8).map((p, i) => ({ ...p, rank: i + 1 }));
}

// ── ④ 抜けの確かめ ─────────────────────────────────────────────────────────
/** 比べるための形（記号・空白・絵文字を落とす） */
function key(s: string): string { return s.replace(/[\s「」『』（）()！!？?、。・…ー〜~😊😌🙇‍♀️🙇💦✨]/gu, "").toLowerCase(); }
function grams(s: string): Set<string> { const k = key(s); const g = new Set<string>(); for (let i = 0; i < k.length - 1; i++) g.add(k.slice(i, i + 2)); return g; }
/** 依頼1件が項目のどれかに入っているか（同じ文を含む・2字の重なりが半分以上） */
export function askCovered(ask: string, items: ReadonlyArray<PriorityItem>): boolean {
  const ka = key(ask);
  if (!ka) return true;
  const ga = grams(ask);
  return items.some((p) => {
    const t = `${p.quote ?? ""}${p.item}`;
    const kt = key(t);
    if (!kt) return false;
    const kq = key(p.quote ?? "");
    if (kt.includes(ka) || (kq.length >= 4 && ka.includes(kq))) return true;
    if (!ga.size) return false;
    const gt = grams(t);
    let hit = 0;
    for (const g of ga) if (gt.has(g)) hit++;
    return hit / ga.size >= 0.5;
  });
}

const ROUTE_TO_HANDLING: Record<string, Handling> = { reply: "answer_now", promise: "confirm", aix: "aix", none: "skip" };
export type CoverageAsk = { quote: string; route?: string | null; aix?: string | null };
/**
 * お客様の依頼（turn_contract.asks → 無ければ customer_questions）が priorities に全部あるか。抜けは「聞かれた事」として後ろに足す（順位は最後）。
 *   戻り値の dropped は足した依頼の数（記録用）
 */
export function ensureAsksCovered(items: PriorityItem[], asks: ReadonlyArray<CoverageAsk>): { items: PriorityItem[]; dropped: number; total: number } {
  const out = [...items];
  let dropped = 0;
  for (const a of asks) {
    const q = clip(a.quote, 40);
    if (!q || askCovered(q, out)) continue;
    dropped++;
    const handling = ROUTE_TO_HANDLING[String(a.route ?? "reply")] ?? "answer_now";
    out.push({ rank: out.length + 1, kind: "asked", item: q.slice(0, 30), quote: q, handling, aix: handling === "aix" ? (a.aix ?? null) : null, reason: "（ブレインの順位から抜けていた依頼を足した）", added: true });
  }
  return { items: out.slice(0, 10).map((p, i) => ({ ...p, rank: i + 1 })), dropped, total: asks.length };
}

// ── ③ AIX とそろえる ───────────────────────────────────────────────────────
/**
 * 最終の AIX（決まりで直された後）とそろえる: AIX が無くなった番の aix 項目は「確かめる約束」に・違うキーは記録だけ（2つの AIX の番もあるので書き換えない）。
 *   AIX がある番で aix の項目が1つも無い時は印（noItem）だけ
 */
export function reconcilePrioritiesWithAix(items: PriorityItem[], finalAix: string | null, opts: { ackOnly?: boolean } = {}): { items: PriorityItem[]; toConfirm: number; mismatch: number; noItem: boolean; toLater?: number } {
  let toConfirm = 0, mismatch = 0, toLater = 0;
  const out = items.map((p) => {
    if (p.handling !== "aix") return p;
    // 2026-10-23 お客様の依頼が無い番（お礼・了承だけ）の「伝える事」の AIX が最終で外れた時は約束にしない＝後の番（竹内さんの決定 10/14: お礼に短く返す・約束を果たす AIX はその後）。
    //   聞かれた事は今まで通り約束（turn-contract.reconcileTurnContractWithAix と同じ＝AIX は約束の後で立つ）
    if (!finalAix && opts.ackOnly && p.kind === "convey") { toLater++; return { ...p, handling: "later" as Handling, aix: null }; }
    if (!finalAix) { toConfirm++; return { ...p, handling: "confirm" as Handling, aix: null }; }
    if (p.aix && p.aix !== finalAix && !finalAix.startsWith(`${p.aix}/`) && !p.aix.startsWith(`${finalAix}/`)) mismatch++;
    return { ...p, aix: p.aix ?? finalAix };
  });
  return { items: out, toConfirm, mismatch, noItem: !!finalAix && !out.some((p) => p.handling === "aix"), ...(toLater ? { toLater } : {}) };
}

// ── 書く役への材料（並べた一覧） ──────────────────────────────────────────────
/** 本質の帯に入れる「この番の優先順位」の行（空なら ""） */
export function renderPrioritiesNote(items: ReadonlyArray<PriorityItem> | null | undefined): string {
  if (!items || !items.length) return "";
  const L = ["- この番の優先順位（ブレインが原則と状況から決めた順・この順で書く。「この返信で答える」「約束する」項目は全部入れる・AIX の項目は本文で中身を答えない・「今は触れない」「触れない」項目は書かない）:"];
  for (const p of items) {
    const what = p.kind === "asked" && p.quote ? `「${p.quote}」` : p.item;
    L.push(`  ${p.rank}. ${p.kind === "asked" ? "聞かれた事" : "伝える事"}: ${what} → ${HANDLING_JA[p.handling]}${p.handling === "aix" && p.aix ? `（AIX ${p.aix}）` : ""}${p.reason ? ` ／ 理由: ${p.reason}` : ""}`);
  }
  return L.join("\n");
}

// ── ⑤ 取り寄せた材料のブロック（user 側・会話のキャッシュの後ろ） ────────────────────
export type PulledKbRow = { id: string; title: string; insight: string; priority: number | null };
export type PulledSituation = { promise: boolean; sentProps: number; customerMemory: boolean; examples: number; judgeExamples: number; timing: boolean; applyRoute: boolean };
export function renderPulledBlock(scene: string | null, rows: ReadonlyArray<PulledKbRow>, sit: PulledSituation | null): string {
  if (!rows.length && !sit) return "";
  const L: string[] = [`【この番に引いた判断の材料（優先順位を決める根拠・場面: ${scene ?? "不明"}）】`];
  // 2026-10-23 原則（P0）は題だけ（本文の頭160字で切ると「AIX で送る物」の一覧だけ残り「返信は AI が知り得る材料で書ける番」の後半が落ちていた＝q047）。
  //   P1（BRAIN_PRIORITY_KB_P1=on の時だけ）は似た場面の参考＝状況が同じ時だけ当てる
  const p0 = rows.filter((r) => r.priority === 0), p1 = rows.filter((r) => r.priority !== 0);
  if (p0.length) {
    L.push("竹内さんの原則（★絶対・最優先）:");
    for (const r of p0) L.push(`- ★${r.title.slice(0, 150)}`);
  }
  if (p1.length) {
    L.push("似た場面の竹内さんの過去の決定（参考。今の番と状況が同じ時だけ当てる・違えば使わず原則で決める）:");
    for (const r of p1) L.push(`- ${r.title.split(/s+—s+/)[0].slice(0, 110)}`);
  }
  if (sit) {
    const has = (b: boolean) => (b ? "あり" : "なし");
    L.push(`状況の材料（この上の入力にある・順位の理由はここから）: まだ果たしていない約束=${has(sit.promise)}／送った物件=${sit.sentProps}件／お客様の記憶・状態=${has(sit.customerMemory)}／竹内さんの手本=${sit.examples}件・判断の手本=${sit.judgeExamples}件／時刻・間隔（期限は今日から何日か）=${has(sit.timing)}／申込までの地図=${has(sit.applyRoute)}`);
  }
  return L.join("\n");
}

/** 記録（meta.priority_step → digest.pr） */
export type PriorityStepRecord = {
  n: number; asked: number; convey: number; h: Partial<Record<Handling, number>>;
  dropped: number; asks: number; toConfirm: number; mismatch: number; noItem: boolean;
  pulled?: { kb: string[]; scene: string | null; sit: PulledSituation | null; chars: number; ms: number; err?: string };
};
export function priorityRecord(items: ReadonlyArray<PriorityItem>, cov: { dropped: number; total: number }, rec: { toConfirm: number; mismatch: number; noItem: boolean }, pulled?: PriorityStepRecord["pulled"]): PriorityStepRecord {
  const h: Partial<Record<Handling, number>> = {};
  for (const p of items) h[p.handling] = (h[p.handling] ?? 0) + 1;
  return { n: items.length, asked: items.filter((p) => p.kind === "asked").length, convey: items.filter((p) => p.kind === "convey").length, h, dropped: cov.dropped, asks: cov.total, toConfirm: rec.toConfirm, mismatch: rec.mismatch, noItem: rec.noItem, ...(pulled ? { pulled } : {}) };
}
