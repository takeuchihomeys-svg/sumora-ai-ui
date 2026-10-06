// app/lib/line-watch-judge.ts
// LINE の見張り 2段目: お客様の番ごとに「AI の案」と「スタッフの実際」を決まった規則で比べる（純関数・DB も fetch も LLM も持たない）。
// 設計 line-watch-design.md §3.2。2026-10-01 竹内「見張りの2段目おこなう」。
//
//   staffWindowOf … 番の窓（番の最後のお客様の発言の後〜次のお客様の発言・最大24時間）と、その中の「最初の返事のまとまり」
//   cleanDraft    … 下書きの欄の印・壊れた形（__SHOWN__・[AIX誘導中]・生成の失敗の文・<<<FINAL_CHECK の尾・「」の囲み）を外す
//   judgeTurn     … 判定 same／same_meaning／partial／different／na（と理由・差の中身）。文の判定 text_verdict と AIX の判定 aix_verdict も別に残す
//
// 判定の規則（物差しは既存の部品をそのまま使う＝二重に作らない）:
//   返事のまとまり … 窓の最初のスタッフの文から、間が10分以内で続く文（最初から30分まで）。それより後の文（確認の結果の報告・翌朝の挨拶）は
//                    同じ番の「返事」ではなく後の連絡なので比べない（監査 v1: 窓の全部を比べると、後の報告が混ざって「一部違う」「事実を片側だけ」が水増しされた）
//   道（AIX か返信か）… ブレインの判断（line_watch_turns.brain_*）と、スタッフが押した AIX（aix_usage_logs）。種類は normalizeAixForMatch でそろえる
//     ・AI が AIX: 窓の中で同じ種類を押した → same／別の種類 → different（AIX 違い）
//                  押していない: 下書きがあれば文の判定（AI は AIX と一緒に返事の下書きも出す＝2択・スタッフが下書きの文を送り AIX は後で押す事が多い・監査 v1）
//                  下書きも無い: 確認の AIX（acknowledge_check・property_check_result）で手打ちが確認の宣言なら same_meaning（手打ちで同じ行為）・他は different
//     ・AI が返信: 返事のまとまりの中で AIX を押した → different（返信の案だがスタッフは AIX）
//   文 … ①中身が同じ（絵文字・空白・！の数・句点だけの違い＝edit-diff の core）→ same
//        ②事実（edit-diff の金額・日時・物件・呼びかけの名前）が両側にあって食い違う → different（事実違いは別の印 fact_diff で数える）
//        ③こちらの行為（customer-sim-shadow の staffActsOf）が両側で食い違う（AI だけの行為とスタッフだけの行為が両方）→ different
//        ④行為が片側だけ欠ける／足される・事実を片側だけが言う・聞き返しの有無が違う → partial
//        ⑤行為が同じ・言い回しが近い（似ている度 0.5 以上か、下書きの文の6割以上が残った）→ same_meaning ／ 遠い → partial（uncertain＝LLM を足すならここ）
//   比べられない（na）… スタッフが何も送っていない・下書きが無い（手打ち）・印だけ・申込以降・ブレインの判断も下書きも無い
// 線は scripts/audit-line-watch-verdict.ts（過去60日の実送信）で目で読んで決めた。変える時は監査を回し直し、JUDGE_VERSION を上げる。
// テスト: app/lib/__tests__/line-watch-judge.test.ts（本番の実物の対）
import { classifyEdit, editCore, factTokensOf, type FactKind } from "./edit-diff";
import { staffActsOf, type StaffAct } from "./customer-sim-shadow";
import { normalizeAixForMatch } from "./brain-aix-feedback";
import { sceneKeyOf } from "./line-watch-turn";

/** 判定の規則の版（規則を変えたら上げる。再判定の対象を見分ける） */
//   v3-2026-10-07: スタッフが返さなかった番で、AI の下書きがお礼・了承の番の読むべき範囲の外の行為（お部屋を探す宣言 等）を書いた → different（no_staff_out_of_topic）
//     （uran. 10/05: 「よろしくお願いいたします」に43日前の物件探しの宣言・スタッフは返さず＝旧は na で数えず見えていなかった。範囲は ack-topic-scope.ts）
//   v4-2026-10-07: 下書きの欄が __SHOWN__（画面が表示した印）の番は draft_first で比べる（pickJudgeDraft・draft_src）。旧は返信の番の 39% を na にしていた
export const JUDGE_VERSION = "v4-2026-10-07";

export type Verdict = "same" | "same_meaning" | "partial" | "different" | "na";
export const VERDICTS: readonly Verdict[] = ["same", "same_meaning", "partial", "different", "na"];
export const VERDICT_JA: Record<Verdict, string> = {
  same: "そのまま", same_meaning: "同じ事（言い方違い）", partial: "一部違う", different: "別の事", na: "比べられない",
};

export type WindowMsg = { sender: string; created_at: string; text: string | null; is_aix_generated?: boolean | null };
export type WindowPress = { aix_type: string | null; check_pattern?: string | null; created_at: string };
export type StaffText = { at: string; text: string; burst: boolean };
export type StaffPress = { aix_type: string; check_pattern: string | null; at: string; burst: boolean };
export type StaffWindow = {
  /** 窓の終わり（次のお客様の発言・無ければ最後のお客様の発言＋24時間） */
  endAt: string;
  /** 窓が閉じたか（次のお客様の発言が来た／24時間たった）。閉じていない番で何も送られていなければ判定しない */
  closed: boolean;
  /** 番の最後のお客様の発言（連投の終わり） */
  customerLastAt: string;
  /** スタッフの最初の行動（文か AIX） */
  staffFirstAt: string | null;
  /** AIX の文でないスタッフの文（順番どおり・burst＝最初の返事のまとまり） */
  texts: StaffText[];
  /** AIX の文（is_aix_generated）の数（窓の中・まとまりの中） */
  aixMessages: number;
  aixMessagesBurst: number;
  presses: StaffPress[];
};

const MIN = 60_000;
const DAY = 86_400_000;
/** 返事のまとまり: 前の文から10分以内・最初の行動から30分まで */
export const BURST_GAP_MIN = 10;
export const BURST_SPAN_MIN = 30;

/**
 * 番の窓。msgs は会話のメッセージ（番より前が入っていてもよい）。
 *   番 = customerTurnAt から始まるお客様の連投（最初のスタッフの発言の前まで）。窓 = 番の最後のお客様の発言の後〜次のお客様の発言（最大24時間）
 */
export function staffWindowOf(o: { customerTurnAt: string; msgs: ReadonlyArray<WindowMsg>; presses?: ReadonlyArray<WindowPress>; nowMs?: number }): StaffWindow {
  const nowMs = o.nowMs ?? Date.now();
  // 時刻は全部 ms で比べる（DB の "+00:00" の形と toISOString の "Z" の形・小数の桁が混ざると文字の比べが狂う）
  const ms = (s: string) => Date.parse(s);
  const turnMs = ms(o.customerTurnAt);
  const after = o.msgs.filter((m) => ms(m.created_at) >= turnMs).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  let lastCust = o.customerTurnAt;
  let i = 0;
  for (; i < after.length; i++) {
    if (after[i].sender === "customer") lastCust = after[i].created_at;
    else break;
  }
  const lastMs = ms(lastCust);
  const capMs = lastMs + DAY;
  const nextCust = after.slice(i).find((m) => m.sender === "customer")?.created_at ?? null;
  const endMs = nextCust && ms(nextCust) < capMs ? ms(nextCust) : capMs;
  const endAt = new Date(endMs).toISOString();
  const closed = !!nextCust || nowMs >= capMs;
  const staff = after.slice(i).filter((m) => m.sender !== "customer" && ms(m.created_at) > lastMs && ms(m.created_at) < endMs);
  const pressesRaw = (o.presses ?? [])
    .filter((p) => p.aix_type && ms(p.created_at) > lastMs && ms(p.created_at) < endMs)
    .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const firsts = [staff[0]?.created_at, pressesRaw[0]?.created_at].filter(Boolean) as string[];
  const staffFirstAt = firsts.length ? firsts.sort((a, b) => ms(a) - ms(b))[0] : null;
  // 返事のまとまり（文も AIX も同じ線）
  const spanEnd = staffFirstAt ? ms(staffFirstAt) + BURST_SPAN_MIN * MIN : 0;
  const events = [...staff.map((m) => ms(m.created_at)), ...pressesRaw.map((p) => ms(p.created_at))].sort((a, b) => a - b);
  let burstEnd = staffFirstAt ? ms(staffFirstAt) : 0;
  for (const t of events) {
    if (t > spanEnd) break;
    if (t - burstEnd <= BURST_GAP_MIN * MIN) burstEnd = Math.max(burstEnd, t);
    else break;
  }
  const inBurst = (at: string) => !!staffFirstAt && ms(at) <= burstEnd;
  const texts = staff.filter((m) => !m.is_aix_generated && (m.text ?? "").trim()).map((m) => ({ at: m.created_at, text: String(m.text), burst: inBurst(m.created_at) }));
  const presses = pressesRaw.map((p) => ({ aix_type: String(p.aix_type), check_pattern: p.check_pattern ?? null, at: p.created_at, burst: inBurst(p.created_at) }));
  const aix = staff.filter((m) => m.is_aix_generated);
  return { endAt, closed, customerLastAt: lastCust, staffFirstAt, texts, aixMessages: aix.length, aixMessagesBurst: aix.filter((m) => inBurst(m.created_at)).length, presses };
}

// ─── 下書きの掃除 ───

/** 下書きの欄にある「文でない物」（本番 10/01: __SHOWN__ 22会話・[AIX誘導中] 50会話・生成の失敗の文）。文が無ければ null */
export function cleanDraft(raw: string | null | undefined): { text: string | null; sentinel: string | null } {
  let t = String(raw ?? "");
  const fc = t.indexOf("<<<FINAL_CHECK");
  if (fc >= 0) t = t.slice(0, fc);
  t = t.trim();
  if (!t) return { text: null, sentinel: null };
  if (/^\[[^\]]{1,30}\]$/.test(t)) return { text: null, sentinel: t };
  if (/^__[A-Z_]{2,30}__$/.test(t)) return { text: null, sentinel: t };
  if (/^（AI返信の生成に失敗しました/.test(t)) return { text: null, sentinel: "[生成の失敗]" };
  // 全体を「」で囲んだ下書き（旧の生成の癖）は中身だけ
  const q = t.match(/^「([\s\S]+)」$/);
  if (q && !q[1].includes("「")) t = q[1].trim();
  return { text: t, sentinel: null };
}

/**
 * 判定に使う下書きの欄を選ぶ（2026-10-07）。
 *   画面が下書きを表示すると ai_draft が __SHOWN__ になり、トリガーがそれを draft_last に書いていた（印の形 [..] だけを分けていたため）。
 *   その番は本当の下書きが draft_first にしか残らず、judgeTurn が「印だけ」(sentinel_only・na) と数えていた
 *   （本番 9/23〜10/07 の返信の番 118 のうち 46＝39%・AIX の番も含めて 90 行）。
 *   draft_first を使ってよいのは「表示された文が draft_first だと言える」時だけ:
 *     ①作り直しが無い（文の版が1つ）②draft_first が連投の最後のお客様の発言より後に作られた（途中の発言だけに答えた下書きでない）
 *   それ以外（stale）は比べない＝今まで通り na。読み直した14日で stale の下書きは「ありがとう」だけに答えて後の質問を落とした形が多く、比べると AI の外れを水増しした
 */
export type JudgeDraftSrc = "last" | "first" | "stale" | "none";
export function pickJudgeDraft(row: {
  draft_last: string | null | undefined; draft_first: string | null | undefined; draft_versions?: number | null;
  draft_first_at?: string | null; customer_last_at?: string | null;
}): { draft: string | null; src: JudgeDraftSrc } {
  if (cleanDraft(row.draft_last).text) return { draft: row.draft_last ?? null, src: "last" };
  if (cleanDraft(row.draft_first).text) {
    const shownMark = /^s*__[A-Z_]{2,30}__s*$/.test(String(row.draft_last ?? "")) ? 1 : 0;
    const textVersions = (row.draft_versions ?? 1) - shownMark;
    const fa = row.draft_first_at ? Date.parse(row.draft_first_at) : NaN;
    const la = row.customer_last_at ? Date.parse(row.customer_last_at) : NaN;
    const afterLast = Number.isFinite(fa) && Number.isFinite(la) ? fa >= la : false;
    if (textVersions <= 1 && afterLast) return { draft: row.draft_first ?? null, src: "first" };
    return { draft: row.draft_last ?? null, src: "stale" };
  }
  return { draft: row.draft_last ?? row.draft_first ?? null, src: "none" };
}

// ─── 文の小さな物差し ───

/** 聞き返し（お客様に何かを尋ねている）か */
//   「ご要望お聞かせ頂きありがとうございます」「ご検討頂けますと幸いです」は尋ねていない（監査 v2 の誤り）ので、お聞かせ・教えては「頂け」の形だけ
const QUESTION_RE = /[?？]|でしょうか|ますか[。！!😊😌]*$|(?:お聞かせ|教えて)(?:頂|いただ)け/m;
export function asksCustomer(text: string): boolean {
  return QUESTION_RE.test(String(text ?? "").normalize("NFKC"));
}

export type FactDiff = { conflict: FactKind[]; draftOnly: FactKind[]; staffOnly: FactKind[] };
const FACT_KINDS: FactKind[] = ["money", "datetime", "property", "name"];
export function factDiffOf(draft: string, staff: string): FactDiff {
  const a = factTokensOf(draft), b = factTokensOf(staff);
  const out: FactDiff = { conflict: [], draftOnly: [], staffOnly: [] };
  for (const k of FACT_KINDS) {
    const A = a[k], B = b[k];
    if (A.size && B.size) { if ([...A].some((x) => !B.has(x))) out.conflict.push(k); }
    else if (A.size) out.draftOnly.push(k);
    else if (B.size) out.staffOnly.push(k);
  }
  return out;
}

export type JudgeInput = {
  /** 比べる下書き（line_watch_turns.draft_last。cleanDraft を通す前の生のままでよい） */
  draft: string | null | undefined;
  sentinel?: string | null;
  brainAction?: string | null;
  brainReplyMode?: string | null;
  convStatus?: string | null;
  /** その番でブレインの判断を控えたか（false で下書きも無ければ na） */
  hasBrain?: boolean;
  window: Pick<StaffWindow, "closed" | "texts" | "presses" | "aixMessages" | "aixMessagesBurst">;
  /** 下書きの行為のうち、お礼・了承の番の読むべき範囲の外の物（ack-topic-scope.outOfTopicActs・呼び出し側が会話から決める） */
  outOfTopicActs?: StaffAct[];
};
export type VerdictDetail = {
  v: string;
  path: "AIX" | "返信" | "対象外";
  reason: string;
  final: boolean;
  brain_aix?: string | null;
  staff_aix?: string[];
  aix_verdict?: "same" | "other" | "not_pressed" | "unexpected" | null;
  text_verdict?: Verdict | null;
  text_reason?: string;
  sim?: number;
  draft_acts?: StaffAct[];
  staff_acts?: StaffAct[];
  missing_acts?: StaffAct[];
  extra_acts?: StaffAct[];
  facts?: FactDiff;
  fact_diff?: boolean;
  ask?: [boolean, boolean];
  kept?: number;
  uncertain?: boolean;
  later_texts?: number;
  /** お礼・了承の番で、下書きが読むべき範囲の外に足した行為（ack-topic-scope.ts） */
  out_of_topic_acts?: StaffAct[];
  /** 比べた下書きの欄（pickJudgeDraft）。stale＝表示された文が分からない（比べない） */
  draft_src?: JudgeDraftSrc;
};
export type Judgement = { verdict: Verdict | null; detail: VerdictDetail };

export const VERDICT_REASON_JA: Record<string, string> = {
  pending: "窓が閉じていない（まだ判定しない）",
  out_of_scope: "申込以降（数えない）",
  no_staff: "スタッフが送っていない",
  no_staff_out_of_topic: "スタッフは返さず・AI は話題の外の行為を書いた",
  no_brain: "ブレインの判断も下書きも無い",
  no_reply_needed_same: "返信不要で一致（スタッフも送らなかった）",
  no_reply_needed_but_sent: "AI は返信不要・スタッフは送った",
  aix_same: "AIX の種類が同じ",
  aix_other: "別の AIX を押した",
  aix_unknown: "AIX の文はあるが押した記録が無い",
  aix_but_text: "AI は AIX・スタッフは手打ちの文だけ",
  aix_ack_by_text: "確認の AIX を手打ちの確認の宣言で",
  text_but_aix: "AI は返信・スタッフは AIX",
  text_plus_aix: "文は同じ・スタッフは AIX も足した",
  no_draft: "下書きが無い（手打ち）",
  sentinel_only: "印だけで下書きの文が無い",
  exact: "中身が同じ",
  fact_conflict: "事実（金額・日時・物件・名前）が食い違う",
  acts_conflict: "こちらの行為が食い違う",
  acts_equal_close: "行為が同じ・言い回しが近い",
  acts_missing: "スタッフだけがした行為がある",
  acts_extra: "AI だけがした行為がある",
  fact_one_side: "事実を片側だけが言っている",
  ask_diff: "聞き返しの有無が違う",
  wording_far: "行為は同じだが言い回しが遠い",
};

/** 似ている度の線（行為が同じ時に same_meaning と見る下限）。監査 audit-line-watch-verdict.ts で決めた */
export const SAME_MEANING_SIM = 0.5;
/** 下書きの行がどれだけ残っていれば（言い換えを含まず）同じ事と見るか */
export const SAME_MEANING_KEPT = 0.6;
/** 確認の AIX（手打ちの確認の宣言と同じ行為） */
const CHECK_AIX = new Set(["acknowledge_check", "property_check_result"]);

/** 判定。窓が閉じていない番で何も送られていなければ verdict=null（翌晩にもう一度） */
export function judgeTurn(i: JudgeInput): Judgement {
  const scene = sceneKeyOf({ brainAction: i.brainAction, brainReplyMode: i.brainReplyMode, convStatus: i.convStatus });
  const final = i.window.closed;
  const base = { v: JUDGE_VERSION, path: scene.path, final } as const;
  const brainAix = scene.path === "AIX" ? (scene.key === "AIX:種類なし" ? "" : scene.key.slice(4)) : null;
  const burstTexts = i.window.texts.filter((t) => t.burst);
  const staffText = burstTexts.map((t) => t.text).join("\n").trim();
  const later = i.window.texts.length - burstTexts.length;
  const allPress = i.window.presses.map((p) => normalizeAixForMatch(p.aix_type));
  const burstPress = i.window.presses.filter((p) => p.burst).map((p) => normalizeAixForMatch(p.aix_type));
  const sentAnything = i.window.texts.length > 0 || allPress.length > 0 || i.window.aixMessages > 0;
  const cd = cleanDraft(i.draft);
  const sentinel = (i.sentinel ?? cd.sentinel ?? "").trim() || null;
  const draft = cd.text;

  if (scene.path === "対象外") return { verdict: "na", detail: { ...base, reason: "out_of_scope" } };
  if (!sentAnything) {
    if (!final) return { verdict: null, detail: { ...base, reason: "pending" } };
    if (sentinel === "[返信不要]") return { verdict: "same", detail: { ...base, reason: "no_reply_needed_same" } };
    if (i.outOfTopicActs?.length) return { verdict: "different", detail: { ...base, reason: "no_staff_out_of_topic", brain_aix: brainAix, out_of_topic_acts: i.outOfTopicActs } };
    return { verdict: "na", detail: { ...base, reason: "no_staff", brain_aix: brainAix } };
  }
  // 文の判定（下書きと返事のまとまりの両方がある時だけ）
  const text = draft && staffText ? judgeText(draft, staffText) : null;
  const withText = (d: VerdictDetail): VerdictDetail => (text ? { ...d, ...text.extra, text_verdict: text.verdict, text_reason: text.reason, later_texts: later } : { ...d, later_texts: later });

  // ── AI は AIX ──
  //   返事のまとまりで AIX を押した → その種類で決める。
  //   まとまりでは押さず文を送った → 下書きがあれば文の判定（後で押した AIX は aix_verdict に残すだけ＝監査 v2: 確認の宣言を下書きどおり送って
  //   数時間後に見積書送るを押す・物件を探す宣言を送って後で物件ピックアップを押す、が多く、これを「別の事」にすると自動送信の候補の文の一致が見えない）
  if (scene.path === "AIX") {
    const aixOf = (list: string[]): VerdictDetail["aix_verdict"] => (list.length ? (!!brainAix && list.includes(brainAix) ? "same" : "other") : "not_pressed");
    if (burstPress.length) {
      const hit = aixOf(burstPress) === "same";
      return { verdict: hit ? "same" : "different", detail: withText({ ...base, reason: hit ? "aix_same" : "aix_other", brain_aix: brainAix, staff_aix: allPress, aix_verdict: hit ? "same" : "other" }) };
    }
    if (text) return { verdict: text.verdict, detail: withText({ ...base, reason: text.reason, brain_aix: brainAix, staff_aix: allPress, aix_verdict: aixOf(allPress) }) };
    if (allPress.length) {
      const hit = aixOf(allPress) === "same";
      return { verdict: hit ? "same" : "different", detail: withText({ ...base, reason: hit ? "aix_same" : "aix_other", brain_aix: brainAix, staff_aix: allPress, aix_verdict: hit ? "same" : "other" }) };
    }
    if (i.window.aixMessages > 0) return { verdict: "na", detail: withText({ ...base, reason: "aix_unknown", brain_aix: brainAix, staff_aix: [], aix_verdict: null }) };
    const acts = staffActsOf(staffText || i.window.texts.map((t) => t.text).join("\n"));
    const rawAction = (i.brainAction ?? "").trim();
    if (CHECK_AIX.has(rawAction) && acts.has("check_promise")) {
      return { verdict: "same_meaning", detail: withText({ ...base, reason: "aix_ack_by_text", brain_aix: brainAix, staff_aix: [], aix_verdict: "not_pressed", staff_acts: [...acts] }) };
    }
    return { verdict: "different", detail: withText({ ...base, reason: "aix_but_text", brain_aix: brainAix, staff_aix: [], aix_verdict: "not_pressed", staff_acts: [...acts] }) };
  }

  // ── AI は返信 ──
  if (burstPress.length || i.window.aixMessagesBurst > 0) {
    // 文は下書きどおり・スタッフは AIX も足した → 一部違う（AI が AIX を出さなかった）。文も違う・文が無い → 別の事
    const textAgree = !!text && isAgree(text.verdict);
    return { verdict: textAgree ? "partial" : "different", detail: withText({ ...base, reason: textAgree ? "text_plus_aix" : "text_but_aix", brain_aix: null, staff_aix: burstPress, aix_verdict: "unexpected" }) };
  }
  if (sentinel === "[返信不要]") return { verdict: "different", detail: withText({ ...base, reason: "no_reply_needed_but_sent" }) };
  if (!draft) {
    if (i.hasBrain === false) return { verdict: "na", detail: withText({ ...base, reason: "no_brain" }) };
    return { verdict: "na", detail: withText({ ...base, reason: sentinel ? "sentinel_only" : "no_draft" }) };
  }
  if (!staffText) {
    // 返事のまとまりが AIX だけ・文は後から（まとまりの外）→ 後の文と比べない。スタッフは返事をしていない扱い
    return { verdict: "na", detail: withText({ ...base, reason: "no_staff" }) };
  }
  return { verdict: text!.verdict, detail: withText({ ...base, reason: text!.reason }) };
}

type TextJudgement = { verdict: Verdict; reason: string; extra: Partial<VerdictDetail> };
function judgeText(draft: string, staff: string): TextJudgement {
  if (editCore(draft) === editCore(staff)) return { verdict: "same", reason: "exact", extra: { sim: 1, fact_diff: false } };
  const diff = classifyEdit(draft, staff);
  const sim = Math.round(diff.sim * 100) / 100;
  const A = staffActsOf(draft), B = staffActsOf(staff);
  const missing = [...B].filter((x) => !A.has(x));
  const extra = [...A].filter((x) => !B.has(x));
  const facts = factDiffOf(draft, staff);
  const ask: [boolean, boolean] = [asksCustomer(draft), asksCustomer(staff)];
  const units = draftUnitCount(draft);
  const kept = Math.round((Math.max(0, units - diff.deleted - diff.rephrased) / Math.max(1, units)) * 100) / 100;
  // 事実違い（解禁の線で0を求める）は金額・日時・物件だけ。呼びかけの名前の違いは数えない
  //   （監査 v2: 「大村和音さん／和音さん」「itさん／it_0さん」「五嶋由紀さん／五嶋さん」＝表示名と呼び方の差が大半で、事実違いの半分を占めた。差は facts.conflict に残す）
  const factHard = facts.conflict.some((k) => k !== "name");
  // 言い回しがとても遠い（似ている度 0.25 未満・下書きの文の残り 1/3 以下）は決まった規則で割り切れない物の印（LLM を足すかの物差し）
  const far = sim < 0.25 && kept <= 0.34;
  const x: Partial<VerdictDetail> = { sim, draft_acts: [...A], staff_acts: [...B], missing_acts: missing, extra_acts: extra, facts, fact_diff: factHard, ask, kept };
  const partial = (reason: string): TextJudgement => ({ verdict: "partial", reason, extra: far ? { ...x, uncertain: true } : x });
  if (factHard) return { verdict: "different", reason: "fact_conflict", extra: x };
  if (missing.length && extra.length) return { verdict: "different", reason: "acts_conflict", extra: x };
  if (missing.length) return partial("acts_missing");
  if (extra.length) return partial("acts_extra");
  if (facts.draftOnly.some((k) => k !== "name") || facts.staffOnly.some((k) => k !== "name")) return partial("fact_one_side");
  if (ask[0] !== ask[1]) return partial("ask_diff");
  if (sim >= SAME_MEANING_SIM || kept >= SAME_MEANING_KEPT) return { verdict: "same_meaning", reason: "acts_equal_close", extra: x };
  return { verdict: "partial", reason: "wording_far", extra: { ...x, uncertain: true } };
}

/** 下書きの文の数（edit-diff の units と同じ切り方） */
function draftUnitCount(draft: string): number {
  return draft.split(/\n+/).flatMap((l) => l.split(/(?<=[!！]{2}|。)(?=[^!！。\s])/u)).filter((p) => editCore(p).length >= 2).length;
}

/** 一致（解禁の線で数える）= same + same_meaning */
export function isAgree(v: Verdict | null | undefined): boolean {
  return v === "same" || v === "same_meaning";
}

/** 画面の短い1行（「一部違う ・ スタッフだけがした行為がある ・ ＋確認の宣言」） */
export function verdictLine(v: Verdict | null | undefined, d: VerdictDetail | null | undefined, actJa?: Record<string, string>): string {
  if (!v) return d?.reason === "pending" ? "判定待ち" : "";
  const r = d?.reason ? VERDICT_REASON_JA[d.reason] ?? d.reason : "";
  const acts = [...(d?.missing_acts ?? []).map((a) => `＋${actJa?.[a] ?? a}`), ...(d?.extra_acts ?? []).map((a) => `－${actJa?.[a] ?? a}`)];
  const facts = d?.facts?.conflict?.length ? `事実違い: ${d.facts.conflict.map((k) => FACT_JA[k]).join("・")}` : "";
  const topic = d?.out_of_topic_acts?.length ? `話題の外: ${d.out_of_topic_acts.map((a) => actJa?.[a] ?? a).join("・")}` : "";
  return [VERDICT_JA[v], r, acts.join(" "), facts, topic].filter(Boolean).join(" ・ ");
}
export const FACT_JA: Record<FactKind, string> = { money: "金額", datetime: "日時", property: "物件", name: "名前" };
