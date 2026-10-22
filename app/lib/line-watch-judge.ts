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
import { classifyAixContent } from "./aix-content-gate";
import { shouldBeAixOf, shouldBeButtons, type ShouldBeAix } from "./aix-should-be";

/** 判定の規則の版（規則を変えたら上げる。再判定の対象を見分ける） */
//   v3-2026-10-07: スタッフが返さなかった番で、AI の下書きがお礼・了承の番の読むべき範囲の外の行為（お部屋を探す宣言 等）を書いた → different（no_staff_out_of_topic）
//     （uran. 10/05: 「よろしくお願いいたします」に43日前の物件探しの宣言・スタッフは返さず＝旧は na で数えず見えていなかった。範囲は ack-topic-scope.ts）
//   v4-2026-10-07: 下書きの欄が __SHOWN__（画面が表示した印）の番は draft_first で比べる（pickJudgeDraft・draft_src）。旧は返信の番の 39% を na にしていた
//   v7-2026-10-13（竹内さん 10/09「手打ちでも AIX の番として考える」・10/13 承認）: スタッフが AIX で送るべき中身（スタッフだけが知る事＝
//     aix-content-gate.classifyAixContent・引用でない物）を手打ちで送った番は AIX の番として数える。
//     ①AI は AIX（同じ系統）・スタッフは手打ちでその中身 → same_meaning（aix_by_text_staff_fact）
//     ②AI は返信・スタッフは手打ちでその中身 → 下書きがその約束（確認・見積・ピックアップ）なら same_meaning（two_stage_fulfilled_by_text）・他は different（text_but_staff_fact）
//     下書きも同じ系統の中身を言っている番は今まで通り文で比べる。戻す: LINE_WATCH_STAFF_FACT=off（呼び出し側が根拠の文を渡さない＝v6 と同じ判定）
//   v8-2026-10-23（竹内さん 10/22 d04ed51b・76c249e0・aad87f41「スタッフは押し間違いが多い」「竹内も AIX で送る所を手打ち」「押すのは竹内基準」）:
//     AI は AIX の番でスタッフが手打ち・別の AIX を押した時、送った文を本来の AIX（aix-should-be.ts）に当てはめ、ブレインの AIX と同じなら一致（same・same_via_mapping）。
//     元の判定は raw_verdict・raw_reason に残す。aix_verdict（関所）は変えない。戻す: LINE_WATCH_AIX_MAPPING=off（呼び出し側が渡さない＝v7 と同じ判定）
export const JUDGE_VERSION = "v8-2026-10-23";

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
  /** 2026-10-23 v8: AIX の文（is_aix_generated）の本文（押し間違いの当てはめに使う・無い時は空） */
  aixTexts?: StaffText[];
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
  const aixTexts = aix.filter((m) => (m.text ?? "").trim()).map((m) => ({ at: m.created_at, text: String(m.text), burst: inBurst(m.created_at) }));
  return { endAt, closed, customerLastAt: lastCust, staffFirstAt, texts, aixMessages: aix.length, aixMessagesBurst: aix.filter((m) => inBurst(m.created_at)).length, presses, aixTexts };
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
    const shownMark = /^\s*__[A-Z_]{2,30}__\s*$/.test(String(row.draft_last ?? "")) ? 1 : 0;
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
  window: Pick<StaffWindow, "closed" | "texts" | "presses" | "aixMessages" | "aixMessagesBurst" | "aixTexts">;
  /** 下書きの行為のうち、お礼・了承の番の読むべき範囲の外の物（ack-topic-scope.outOfTopicActs・呼び出し側が会話から決める） */
  outOfTopicActs?: StaffAct[];
  /**
   * 2026-10-08 返事を書いた人（app/lib/staff-writer）。従業員の文は書き方の差（言い回しが遠いだけ）を外れに数えない＝中身（行為・事実・聞き返し）だけで見る。
   *   返信の書き方の基準は竹内さん（設計知見 22802738）。戻す: STAFF_WRITER_SPLIT=off（呼び出し側が渡さない）
   */
  staffWriter?: { writer: "takeuchi" | "employee" | null; confidence: "sure" | "likely" | "unknown"; source: string } | null;
  /**
   * 2026-10-13 v7: 番の最後のお客様の発言までの会話の文（引用の照合に使う・aix-content-gate の groundText）。
   *   渡した時だけ「手打ちでも AIX の番」を見る（null／未指定は v6 と同じ）。戻す: LINE_WATCH_STAFF_FACT=off（呼び出し側が渡さない）
   */
  staffFactGround?: string | null;
  /** 2026-10-20: 番の時点の記録で申込以降（line-watch-scope.postApplyAtTurn）。true なら対象外（sceneKeyOf.postApply） */
  postApply?: boolean | null;
  /**
   * 2026-10-23 v8: 手打ち・押し間違いの文を「本来の AIX」に当てはめて採点するか（aix-should-be.ts）。
   *   true の時だけ、ブレインの AIX が本来の AIX と同じなら一致（same・reason=same_via_mapping・元の判定は raw_verdict）。戻す: LINE_WATCH_AIX_MAPPING=off（呼び出し側が渡さない）
   */
  aixMapping?: boolean;
};
export type VerdictDetail = {
  v: string;
  path: "AIX" | "返信" | "対象外";
  reason: string;
  final: boolean;
  brain_aix?: string | null;
  staff_aix?: string[];
  aix_verdict?: "same" | "other" | "not_pressed" | "unexpected" | "by_text" | null;
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
  /** 返事を書いた人（takeuchi｜employee）と根拠（device｜group_speaker｜style_edit｜style）。一致率を竹内さんの番だけで見るため */
  staff_writer?: string | null;
  staff_writer_src?: string | null;
  /** v7: 返事のまとまりの手打ちにあった AIX の中身（型・aix-catalog の鍵・系統） */
  staff_fact?: Array<{ kind: string; key: string; family: string }>;
  /** 2026-10-20: 対象外にした根拠が status 以外（application_push｜id_document）の時の根拠（line-watch-scope.postApplyAtTurn） */
  post_apply_reason?: string | null;
  /** 2026-10-20: 番の鍵の発言が消えた重複行 → 本物の行の id（数えない・line-watch-scope.findDuplicateTurns） */
  duplicate_of?: number | null;
  /** 2026-10-20: 重複行の控えで埋めた欄（本物の行の判定の材料） */
  merged_from?: { id: number; cols: string[] } | null;
  /** 2026-10-20: 自動返信化の関所用の今までの aix_verdict（①④で aix_verdict が変わった番だけ・無い時 "none"）。watch-aix-match が先に読む */
  guard_aix_verdict?: string | null;
  /** 2026-10-23 v8: スタッフの手打ち・押した AIX の文を当てはめた「本来の AIX」（aix-should-be）。via＝hand（手打ち）｜mis_press（別の AIX を押した） */
  should_be?: { key: string; also: string[]; strength: "strong" | "weak"; via: "hand" | "mis_press"; match: boolean } | null;
  /** 2026-10-23 v8: 本来の AIX で一致に直した時の元の判定と理由 */
  raw_verdict?: Verdict | null;
  raw_reason?: string;
};
export type Judgement = { verdict: Verdict | null; detail: VerdictDetail };

export const VERDICT_REASON_JA: Record<string, string> = {
  pending: "窓が閉じていない（まだ判定しない）",
  duplicate_turn: "番の鍵の発言が消えた重複行（本物の行で数える）",
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
  two_stage_fulfilled: "AI は約束の返信・スタッフはその約束の AIX を直接（決まりどおり）",
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
  acts_equal_employee_wording: "行為は同じ・言い回しの差は従業員の書き方（数えない）",
  aix_by_text_staff_fact: "AI は AIX・スタッフは AIX の中身（スタッフだけが知る事）を手打ちで（AIX の番）",
  two_stage_fulfilled_by_text: "AI は約束の返信・スタッフはその約束の中身を手打ちで直接（決まりどおり）",
  text_but_staff_fact: "AI は返信・スタッフは AIX の中身（スタッフだけが知る事）を手打ちで（AIX の番）",
  same_via_mapping: "スタッフは手打ち・別の AIX だが、本来の AIX（中身の意味）がブレインの AIX と同じ",
};

/**
 * AIX の系統（2026-10-13 v7）。手打ちの文から読める中身は「どのボタンか」まで細かく決まらないので、系統で AI の AIX と照らす。
 *   物件（送る・オススメ・探す・ピックアップ・全力サポート）／確認（物件確認した・確認した・保証会社）／費用（見積書・費用の説明）／内覧（内覧調整・待ち合わせ）／電話
 */
export function aixContentFamily(keyOrAix: string | null | undefined): string {
  const a = String(keyOrAix ?? "").split("/")[0].trim();
  if (/^property_(?:send|recommendation|search|pickup)$/.test(a) || a === "zenryoku_support") return "物件";
  if (a === "property_check_result" || a === "acknowledge_check" || a === "guarantor_info") return "確認";
  if (a === "estimate_sheet" || a === "cost_breakdown" || a === "cost_explain") return "費用";
  if (a === "meeting_place" || a === "viewing_invite") return "内覧";
  if (a === "phone_call") return "電話";
  return a;
}
/** その系統の約束（下書きの行為）。手打ちで約束の中身を直接送った＝2段の決まりどおり */
const FAMILY_PROMISE: Record<string, StaffAct> = { 確認: "check_promise", 費用: "estimate_promise", 物件: "pickup_promise" };

/**
 * 見張りだけで足す「手打ちの AIX の中身」の型（aix-content-gate は自動送信の関所なので止めすぎない線＝手打ちの報告の言い方の多くを拾わない）。
 *   線は scripts/line-watch-rejudge.ts --reason=aix_but_text（直近30日の「AI は AIX・スタッフは手打ち」の番を全部読んだ・2026-10-13）:
 *   ①確認の結果の報告（「確認させて頂きましたところ」「〜とのご返事でした」「ご返事あり」）②申込の状況（「1番手の方が審査中」「2番手で受け付け」）
 *   ③内覧の枠（「19:00からのご内覧ですと1件でしたらご案内可能」「9/21日 12:00〜16:00にてご案内可能」）④待ち合わせの時刻（「明日16:00に〇〇現地エントランスお待ち合わせ」）
 *   これからの約束（「確認させて頂きます」）・聞き返し（「ご都合よろしいお時間」）は当てない。時刻・日付が番までの会話に全部あれば引用（当てない）
 */
const WATCH_EXTRA_FACTS: ReadonlyArray<{ kind: string; key: string; re: RegExp; exclude?: RegExp }> = [
  { kind: "check_reported", key: "property_check_result/mgmt_availability", re: /確認(?:させて(?:頂|いただ)き|し|致し|いたし)ました(?:ところ|が|結果)|(?:との|という)(?:ご)?(?:返事|返答|回答|ご連絡)(?:でした|となりました|がございました)|ご(?:返事|返答)(?:あり|がございました)/, exclude: /(?:返事|返答|回答)(?:が)?(?:あり|有り)次第|確認(?:して|中)/ },
  { kind: "screening_status", key: "property_check_result/unavailable", re: /[0-9０-９]番手(?:の方|で|にて|と)|審査中(?:と(?:なり|なって)|とのこと|の(?:お客様|方))/ },
  { kind: "viewing_slot", key: "viewing_invite", re: /[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}[^。\n！!]{0,30}(?:ご案内|ご内覧|内見)(?:が)?(?:可能|出来|でき|かのう)|(?:ご案内|ご内覧)(?:が)?(?:可能|出来|でき)[^。\n]{0,6}(?:時間|お時間)?[^。\n]{0,6}[0-9０-９]{1,2}[:：時]/, exclude: /ご都合|お時間ございますか|でしょうか[^。\n]*$/ },
  { kind: "meeting_time", key: "meeting_place", re: /[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}[^。\n]{0,40}(?:お?待ち合わせ|現地エントランス)/ },
];
function timeDateTokens(s: string): string[] {
  return [...s.normalize("NFKC").matchAll(/[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}日?|[0-9]{1,2}[:時][0-9]{0,2}/g)].map((m) => m[0].replace(/\s/g, "").replace(/日$/, ""));
}

/** 返事のまとまりの手打ちにある AIX の中身（引用でない物だけ）。ground が null なら見ない */
export function staffFactsOf(staffText: string, ground: string | null | undefined): Array<{ kind: string; key: string; family: string }> {
  if (ground == null || !staffText.trim()) return [];
  const out: Array<{ kind: string; key: string; family: string }> = classifyAixContent(staffText, ground).filter((h) => !h.grounded).map((h) => ({ kind: String(h.kind), key: h.catalogKey, family: aixContentFamily(h.catalogKey) }));
  const g = ground.normalize("NFKC").replace(/\s/g, "");
  for (const s of staffText.split(/(?<=[。！!？?])|\n/).map((x) => x.trim()).filter(Boolean)) {
    for (const e of WATCH_EXTRA_FACTS) {
      if (!e.re.test(s) || (e.exclude && e.exclude.test(s))) continue;
      const vals = timeDateTokens(s);
      if (vals.length && vals.every((v) => g.includes(v))) continue; // 決まった日時の引用
      if (!out.some((o) => o.kind === e.kind)) out.push({ kind: e.kind, key: e.key, family: aixContentFamily(e.key) });
    }
  }
  return out;
}

/** 似ている度の線（行為が同じ時に same_meaning と見る下限）。監査 audit-line-watch-verdict.ts で決めた */
export const SAME_MEANING_SIM = 0.5;
/** 下書きの行がどれだけ残っていれば（言い換えを含まず）同じ事と見るか */
export const SAME_MEANING_KEPT = 0.6;
/** 確認の AIX（手打ちの確認の宣言と同じ行為） */
const CHECK_AIX = new Set(["acknowledge_check", "property_check_result"]);

/** 判定。窓が閉じていない番で何も送られていなければ verdict=null（翌晩にもう一度） */
export function judgeTurn(i: JudgeInput): Judgement {
  const j = judgeTurnRaw(i);
  return i.aixMapping ? applyAixMapping(i, j) : j;
}

/**
 * v8（2026-10-23 竹内さん 10/22「スタッフは押し間違いが多い」「竹内も手打ちで送る」「押すのは竹内基準」）:
 *   AI は AIX の番で、スタッフが手打ちで送った・別の AIX を押した（判定が一部違う／別の事）時、送った文を「本来の AIX」に当てはめる。
 *   ブレインの AIX のボタンが本来の AIX の主のボタンと同じなら一致（same・same_via_mapping）。元の判定は raw_verdict に残す。
 *   押し間違いは、押した AIX の文が押したボタンを裏付けない時だけ（裏付ける＝押し間違いではない・手打ちの文は根拠にしない）。
 *   aix_verdict（自動返信化の関所が読む押した AIX の一致）は変えない＝関所は緩まない。
 */
export function applyAixMapping(i: JudgeInput, j: Judgement): Judgement {
  const d = j.detail;
  const brain = d.brain_aix;
  if (d.path !== "AIX" || !brain || (j.verdict !== "partial" && j.verdict !== "different")) return j;
  const burst = i.window.texts.filter((t) => t.burst).map((t) => t.text).join("\n").trim();
  const misPress = d.reason === "aix_other";
  let sb: ShouldBeAix | null = null;
  if (misPress) {
    // 返事のまとまりの AIX の文（まとまりの外で押した番＝まとまりに AIX の文が無い時は窓の全部）
    const all = i.window.aixTexts ?? [];
    const aixBurst = (all.some((t) => t.burst) ? all.filter((t) => t.burst) : all).map((t) => t.text);
    const cands = aixBurst.map((t) => shouldBeAixOf(t, { mode: "aix" })).filter((x): x is ShouldBeAix => !!x);
    // 2026-10-23 レビュー: 押した AIX を自分の文が裏付けている＝押し間違いではない（例: 物件の束の中の（室内イメージ）・費用の説明＋手打ちの内覧の誘い）→ 直さない。
    //   手打ちの文は押し間違いの根拠にしない（押した AIX と手打ちの両方をした番＝ブレインは片方しか選んでいない）
    const pressed = new Set((d.staff_aix ?? []).map(String));
    if (!cands.length || cands.some((c) => shouldBeButtons(c).some((b) => pressed.has(b)))) return j;
    sb = cands.find((c) => c.button === brain) ?? cands[0];
  } else if (burst) {
    sb = shouldBeAixOf(burst, { mode: "hand" });
  }
  if (!sb) return j;
  // 一致は主のボタンだけ（同じ文に添えた弱い中身＝also で一致にしない・膨らませない）。ピッカーは時期で変わる物があるのでボタンで比べる
  const match = sb.button === brain;
  const should_be = { key: sb.key, also: sb.also, strength: sb.strength, via: misPress ? "mis_press" as const : "hand" as const, match };
  if (!match) return { verdict: j.verdict, detail: { ...d, should_be } };
  return { verdict: "same", detail: { ...d, should_be, raw_verdict: j.verdict, raw_reason: d.reason, reason: "same_via_mapping" } };
}

function judgeTurnRaw(i: JudgeInput): Judgement {
  const scene = sceneKeyOf({ brainAction: i.brainAction, brainReplyMode: i.brainReplyMode, convStatus: i.convStatus, postApply: i.postApply });
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
  // v7: 返事のまとまりの手打ちにある AIX の中身（スタッフだけが知る事・引用でない）
  const sfacts = staffFactsOf(staffText, i.staffFactGround);

  if (scene.path === "対象外") return { verdict: "na", detail: { ...base, reason: "out_of_scope" } };
  if (!sentAnything) {
    if (!final) return { verdict: null, detail: { ...base, reason: "pending" } };
    if (sentinel === "[返信不要]") return { verdict: "same", detail: { ...base, reason: "no_reply_needed_same" } };
    if (i.outOfTopicActs?.length) return { verdict: "different", detail: { ...base, reason: "no_staff_out_of_topic", brain_aix: brainAix, out_of_topic_acts: i.outOfTopicActs } };
    return { verdict: "na", detail: { ...base, reason: "no_staff", brain_aix: brainAix } };
  }
  // 文の判定（下書きと返事のまとまりの両方がある時だけ）
  let text = draft && staffText ? judgeText(draft, staffText) : null;
  // 従業員の文: 言い回しが遠いだけ（行為・事実・聞き返しは同じ）は一致に数える（書き方の基準は竹内さん）
  const sw = i.staffWriter;
  if (text && text.reason === "wording_far" && sw?.writer === "employee" && sw.confidence !== "unknown") {
    text = { verdict: "same_meaning", reason: "acts_equal_employee_wording", extra: { ...text.extra, uncertain: false } };
  }
  const writerX: Partial<VerdictDetail> = sw?.writer ? { staff_writer: sw.writer, staff_writer_src: sw.source } : {};
  const withText = (d: VerdictDetail): VerdictDetail => (text ? { ...d, ...writerX, ...text.extra, text_verdict: text.verdict, text_reason: text.reason, later_texts: later } : { ...d, ...writerX, later_texts: later });

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
    // v7: 手打ちでも AIX の番（AI の AIX と同じ系統の中身・AIX の種類なしは系統を問わない）
    if (sfacts.length && (!brainAix || sfacts.some((f) => f.family === aixContentFamily(brainAix)))) {
      return { verdict: "same_meaning", detail: withText({ ...base, reason: "aix_by_text_staff_fact", brain_aix: brainAix, staff_aix: allPress, aix_verdict: "by_text", staff_fact: sfacts }) };
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
    // v5（2026-10-07 竹内さん「１それで大丈夫」・AIX の判断のずれ R1）: AI は2段の約束の返信（ピックアップ・確認・見積書）、スタッフは同じまとまりで
    //   その約束を果たす AIX を直接押した（その場で確認・作成を済ませた）＝決まりどおりの流れ → 一致（two_stage_fulfilled）。2段の後の外れ 19 のうち 13
    if (draft && burstPress.length) {
      const dActs = staffActsOf(draft);
      const fulfils = (a: string) => (dActs.has("pickup_promise") && /^property_(send|recommendation|search)$/.test(a))
        || (dActs.has("check_promise") && (a === "property_check_result" || a === "acknowledge_check"))
        || (dActs.has("estimate_promise") && a === "estimate_sheet");
      if (burstPress.some(fulfils)) return { verdict: "same_meaning", detail: withText({ ...base, reason: "two_stage_fulfilled", brain_aix: null, staff_aix: burstPress, aix_verdict: "same" }) };
    }
    // 文は下書きどおり・スタッフは AIX も足した → 一部違う（AI が AIX を出さなかった）。文も違う・文が無い → 別の事
    const textAgree = !!text && isAgree(text.verdict);
    return { verdict: textAgree ? "partial" : "different", detail: withText({ ...base, reason: textAgree ? "text_plus_aix" : "text_but_aix", brain_aix: null, staff_aix: burstPress, aix_verdict: "unexpected" }) };
  }
  if (sentinel === "[返信不要]") return { verdict: "different", detail: withText({ ...base, reason: "no_reply_needed_but_sent" }) };
  if (!draft) {
    if (i.hasBrain === false) return { verdict: "na", detail: withText({ ...base, reason: "no_brain" }) };
    return { verdict: "na", detail: withText({ ...base, reason: sentinel ? "sentinel_only" : "no_draft" }) };
  }
  // v7: AI は返信・スタッフは AIX の中身を手打ちで（下書きも同じ系統の中身を言っている番は文で比べる）
  if (sfacts.length && staffText) {
    const draftFam = new Set(classifyAixContent(draft, "").map((h) => aixContentFamily(h.catalogKey)));
    const fresh = sfacts.filter((f) => !draftFam.has(f.family));
    if (fresh.length) {
      const dActs = staffActsOf(draft);
      const fulfilled = fresh.some((f) => FAMILY_PROMISE[f.family] && dActs.has(FAMILY_PROMISE[f.family]));
      return { verdict: fulfilled ? "same_meaning" : "different", detail: withText({ ...base, reason: fulfilled ? "two_stage_fulfilled_by_text" : "text_but_staff_fact", brain_aix: null, staff_aix: allPress, aix_verdict: "by_text", staff_fact: sfacts }) };
    }
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
