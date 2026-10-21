// app/lib/parallel-second.ts
// 「2番手で申込中（並行で探す）」の状態を決める純関数（DB・LLM なし）。読み手は parallel-second-server.ts と post-apply.loadPostApplyFacts。
//
// 2026-10-21 竹内さんの決定（ec4d5990）「2番手で申込しながら並行して物件探す形でいく…フォーマットの情報をマスキングするようにして
//   そのまま別物件並行して探せる形とする そのため2番手で申込中とわかりやすいようにすれば良い」。
//   ②番手（1番手が通過して戻った＝申込歴あり）とは別の状態。今も申込中（1番手が審査中）で、並行して別の物件を探している。
//
// 【何が変わるか】（この状態だと明示的に決まった会話だけ。申込中の他の会話は今まで通り止める）
//   ・下書き・AIX・ブレインを止めない（post-apply.postApplyDraftSkip・post-apply-brain-gate-server・generate-reply / bg-async / brain-core の status）
//   ・DeepSeek には全部渡すが、出口で申込フォームの値（氏名・生年月日・勤務先・年収・保証人・書類の読み取り）を伏せる（印 masked・alt-pii-gate.maskApplicationValuesForAlt）
//   ・審査の事情（screening-sensitive）が出た会話は今まで通り Claude
// 【決め方】①スタッフが画面（メモの帯）で選んだ物（customer_memos の1行 id=PARALLEL_MEMO_ID・on/off）が最優先
//   ②スタッフの文で「2番手で受理／受け付け／お申込み完了／お申込みさせて頂きます／同時並行」（案内だけの「2番手でのお申込みが可能」・問いの形は数えない）
//   ③申込状況のピッカー（ほかの方の申込あり）＋2番手の案内の後に申込の記録（申込へ押下・書類・フォーム）
//   その後に「繰り上がり」「審査通過」「1番手の方が通過（お部屋が取れなかった）」があれば終わり（並行ではない）。
//   今も申込中（resolvePostApply）で、申込以降の先（契約・成約）ではない時だけ。
// 戻す: REAPPLY_PARALLEL_2ND=off（全部今まで通り＝申込中は止める・Claude）

export const PARALLEL_2ND_LABEL = "2番手で申込中（並行で探す）";
/** スタッフが選んだ物を置くメモの行の id（customer_memos.items・手で付けた行＝locked） */
export const PARALLEL_MEMO_ID = "parallel-2nd";
export const PARALLEL_MEMO_ON = `${PARALLEL_2ND_LABEL}：はい`;
export const PARALLEL_MEMO_OFF = `${PARALLEL_2ND_LABEL}：いいえ`;

/** この状態で「申込中」に数える status（契約・成約以降は並行の探しではない） */
export const PARALLEL_STATUSES: ReadonlySet<string> = new Set(["applying", "application", "screening"]);

export function parallelSecondEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REAPPLY_PARALLEL_2ND ?? "").trim().toLowerCase() !== "off";
}

export type ParallelMsg = { sender: string; text: string | null | undefined; createdAt: string };
export type ParallelPicker = { checkPattern: string | null; choices?: unknown; createdAt: string };
export type ParallelInput = {
  msgs: ReadonlyArray<ParallelMsg>;
  pickers?: ReadonlyArray<ParallelPicker>;
  /** 最後の申込の記録（押下・書類・フォームの新しい方・ISO）。無ければ null */
  lastApplyAt?: string | null;
  /** 最後に申込前へ戻した時刻（これより前の文は数えない＝前回の申込の話） */
  lastBackAt?: string | null;
  /** スタッフの選択（メモの行）: true / false / null（選んでいない） */
  staffChoice?: boolean | null;
  nowMs?: number;
};
export type ParallelState = { parallel: boolean; source: "staff" | "auto" | null; via: "message" | "picker" | null; at: string | null };
const NOT: ParallelState = { parallel: false, source: null, via: null, at: null };

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
function sentencesOf(text: string): string[] {
  return text.split(/[\n。！!？?]+/).map((s) => s.trim()).filter(Boolean);
}

const BANTE_2 = /[2２二]番手/;
/** 2番手で申込んだ（受理・受け付け・完了・させて頂く・手続き・同時並行・管理会社からの連絡） */
// 動詞は「2番手」の後ろ25字以内だけ数える（同じ文の「確認させて頂きました」等に当てない・実データ 0adcc5f1 の外れ）
const APPLIED_2ND_VERB = /受理|受け?付け?(?:て|ま|致|いた|中|し)|完了|させて(?:頂|いただ)|させ頂|手続き|とのご連絡|とのこと|同時並行|並行して(?:お部屋|物件)?(?:を)?(?:お)?探|並行で/;
/** 案内・問い・できない形（申込んだ事にしない） */
const NOT_APPLIED = /[2２二]番手以降|可能|でき(?:ます|る|ない|ません)|出来|受け?付け?(?:てい)?(?:ない|ません)|受付(?:不可|していない)|不可|如何|いかが|でしょうか|ますか|場合|もし|たら[、,\s]|なら[、,\s]|おすすめ|オススメ|お勧め|ご提案/;
/** 終わり（繰り上がった・自分の審査が通った・1番手が通って取れなかった） */
const END_RE = /繰り上が(?:り(?:まし|ます|となり)|った|れ(?:まし|ます))|[1１一]番手(?:に|と)(?:なり|繰り)|審査(?:が|に|は)?.{0,4}(?:通過(?:しま|いた|とな|の(?:ご)?連絡)|通りまし|承認(?:され|とな)|OK(?:でし|とな))|[1１一]番手.{0,20}(?:審査(?:が|に)?.{0,4}(?:通|通過|承認)|決ま|契約|成約)|(?:お部屋|物件|そちら|こちら)(?:が|は).{0,8}(?:埋まって|決まって|成約)|繰り上が(?:りませ|らな|りが無|り無|りなし|れませ)/;
const END_NOT = /場合|もし|たら[、,\s]|なら[、,\s]|かもしれ|可能性|でしょうか|ますか|如何|いかが/;

/** 2番手で申込んだ文か（スタッフの1通） */
export function isApplied2ndText(text: string | null | undefined): boolean {
  return sentencesOf(String(text ?? "")).some((s) => {
    if (NOT_APPLIED.test(s)) return false;
    const i = s.search(BANTE_2);
    return i >= 0 && APPLIED_2ND_VERB.test(s.slice(i, i + 30));
  });
}
/** 2番手の案内（「2番手でのお申込みが可能」「2番手でお申込を行い…並行して…如何でしょうか」）。申込んだ文でなくてよい・できない形は除く */
export function isOffer2ndText(text: string | null | undefined): boolean {
  return sentencesOf(String(text ?? "")).some((s) => BANTE_2.test(s) && /申(?:し)?込/.test(s) && !/(?:受け?付け?(?:てい)?(?:ない|ません)|出来ない|できない|不可)/.test(s));
}
/** 並行の終わりの文か */
export function isParallelEndText(text: string | null | undefined): boolean {
  return sentencesOf(String(text ?? "")).some((s) => END_RE.test(s) && !END_NOT.test(s));
}
function pickerSaysOther(p: ParallelPicker): boolean {
  if (p.checkPattern !== "mgmt_application_status") return false;
  const s = JSON.stringify(p.choices ?? null);
  return !(/なし/.test(s) && !/あり/.test(s));
}

/** 2番手の文・ピッカーを数える窓（最後の申込の記録の前後） */
export const PARALLEL_WINDOW_BEFORE_MS = 14 * 86_400_000;
/** 記録が無い（status だけ）時に見る過去の長さ */
export const PARALLEL_LOOKBACK_MS = 60 * 86_400_000;

/**
 * 2番手で申込中（並行で探す）か（純関数）。呼び出し側が「今も申込中」（resolvePostApply・PARALLEL_STATUSES）を確かめてから呼ぶ。
 */
export function resolveParallelSecond(i: ParallelInput): ParallelState {
  if (i.staffChoice === false) return NOT;
  if (i.staffChoice === true) return { parallel: true, source: "staff", via: null, at: null };
  const now = i.nowMs ?? Date.now();
  const last = ms(i.lastApplyAt ?? null), back = ms(i.lastBackAt ?? null);
  const from = Math.max(last !== null ? last - PARALLEL_WINDOW_BEFORE_MS : now - PARALLEL_LOOKBACK_MS, back ?? -Infinity);
  const inWin = i.msgs.filter((m) => { const t = ms(m.createdAt); return t !== null && t > from && t <= now; })
    .slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let ev: { at: number; via: "message" | "picker" } | null = null;
  for (const m of inWin) {
    if (m.sender === "customer") continue;
    if (isApplied2ndText(m.text)) ev = { at: Date.parse(m.createdAt), via: "message" };
  }
  if (!ev && last !== null) {
    // ③ ピッカー（ほかの方の申込あり）＋2番手の案内 → その後に申込の記録
    const pk = (i.pickers ?? []).filter((p) => { const t = ms(p.createdAt); return t !== null && t > from && t <= last && pickerSaysOther(p); });
    const offer = inWin.filter((m) => m.sender !== "customer" && Date.parse(m.createdAt) <= last && isOffer2ndText(m.text));
    if (pk.length && offer.length) {
      const at = Math.max(...pk.map((p) => Date.parse(p.createdAt)), ...offer.map((m) => Date.parse(m.createdAt)));
      ev = { at, via: "picker" };
    }
  }
  if (!ev) return NOT;
  const evAt = ev.at;
  if (inWin.some((m) => Date.parse(m.createdAt) > evAt && isParallelEndText(m.text))) return NOT;
  return { parallel: true, source: "auto", via: ev.via, at: new Date(evAt).toISOString() };
}

/** メモの行からスタッフの選択を読む（無い・外した行は null） */
export function staffParallelChoiceOf(items: ReadonlyArray<{ id?: string; text?: string; retiredAt?: string | null }> | null | undefined): boolean | null {
  const it = (items ?? []).find((x) => x.id === PARALLEL_MEMO_ID && !x.retiredAt);
  if (!it?.text) return null;
  if (it.text === PARALLEL_MEMO_ON) return true;
  if (it.text === PARALLEL_MEMO_OFF) return false;
  return null;
}

/**
 * 下書き・ブレインに渡す status（2番手で並行して探している間は「物件提案中」として扱う＝申込中の止め・申込中の材料の切り替えを外す）。
 *   DB の status は書き換えない（読み手が渡す値だけ）。
 */
export function effectiveStatusForParallel(status: string | null | undefined, parallel: boolean | null | undefined): string | null {
  const s = (status ?? "").trim();
  if (parallel === true && PARALLEL_STATUSES.has(s)) return "proposing";
  return status ?? null;
}

/** ブレインの材料（並行で探している事・申込の中身には触れない） */
export function buildParallelBrainNote(): string {
  return [
    `【${PARALLEL_2ND_LABEL}】このお客様は1番手の方が審査中のお部屋に2番手で申込んでいて、繰り上がりを待ちながら並行して別の物件を探している`,
    "・申込の手続きは止めずに、条件に合う別の物件を出す（取れなかった時にすぐ動けるように）。申込中のお部屋の結果は分かり次第お伝えする形でよい",
    "・申込の中身（氏名・生年月日・勤務先・年収・保証人・書類・審査の事情）には触れない",
  ].join("\n");
}
