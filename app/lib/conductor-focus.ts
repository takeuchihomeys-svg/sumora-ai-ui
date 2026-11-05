// app/lib/conductor-focus.ts — 統括の「この番の重点」（純関数・既定 off・作業員5・11/05）
//
// 竹内さんの決定（KB P0 575a7cd5・11/05）: 統括の芯は数の重みではなく、その状況で何を一番大切にするか（重点）を先に決め、
//   それに沿って必要なブレインだけを動かし文を組む事。ベクトルは「竹内さんの近い過去の番で何が重点だったか」を引くために使う（④）。
//   当たりは「統括の重点が竹内さんの実際の番の重点と合うか」で数える（⑤）。重点・理由・引いた近い番を digest に残す（⑥）。
// 関係: 977cbded（ベクトルの重みの強化・①埋め込む形を揃える）・04ca13be（文の解剖の一番の要点・なぜ）・396d3b7f（作業員4の試し）・
//   優先順位の段（10/23 正直→確認の約束→一つ一つに答える→即答→気持ち→次の一手→形）。
//
// ここにある物:
//   (a) 竹内さんの番の重点を、送った文（compose-blueprint の purposeOfText＝決まった札）と押した AIX から決める（正解の作り方）
//   (b) 埋め込む状況の文の2つ目の形（v2）: その番の時点で分かる物だけ（段階・直前のこちらの要点・開いている約束・送った物・お客様）
//       過去の番も今の番も同じ関数で作る＝形が揃う（v1 は場面の札と直前の種類しか無く、近さが場面の札とほぼ同じになっていた）
//   (c) 近い番の重点の多数決（狭い束だけ・束の外は場面の多い重点に寄せる）と digest の1語
import { purposeOfText } from "./compose-blueprint";

type Env = Record<string, string | undefined>;
/**
 * 重点を入口の統括の材料にする（記録だけ・判断は変えない）。2026-11-06 統括役: 既定を shadow に（作業員9の文の統括が meta.conductor_focus を読む・
 *   試験 focus-shadow2 で悪化0・入口の出力 300→450 tokens の増えは本番 約100回/日で 約 $0.2/日）。CONDUCTOR_FOCUS=off で止める
 */
export const conductorFocusMode = (env: Env = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" =>
  (env.CONDUCTOR_FOCUS ?? "").trim().toLowerCase() === "off" ? "off" : "shadow";

/** 重点の種類（優先順位の段の順に並べる＝同点はこの順で上を採る） */
export const FOCUS_KINDS = ["answer", "promise_make", "promise_keep", "ease", "close", "propose", "relation"] as const;
export type Focus = typeof FOCUS_KINDS[number];
export const FOCUS_LABEL: Record<Focus, string> = {
  answer: "聞かれた事に正直に答える",
  promise_make: "確かめる約束をする",
  promise_keep: "約束を果たす",
  ease: "不安を消す",
  close: "決めに行く",
  propose: "次の一手を出す（物件・条件）",
  relation: "関係を続ける",
};

// ── (a) 竹内さんの番の重点（正解） ─────────────────────────────────────────
/** AIX の種類 → 重点。物件を送る AIX は、開いている約束がある時は「約束を果たす」、無ければ「次の一手を出す」 */
export function focusOfAix(aixType: string | null | undefined, o: { openPromise?: boolean } = {}): Focus | null {
  switch (aixType) {
    case "property_check_result": case "estimate_sheet": return "promise_keep";
    case "property_send": case "property_recommendation": return o.openPromise ? "promise_keep" : "propose";
    case "viewing_invite": case "meeting_place": case "application_push": case "greeting_viewing": return "close";
    case "condition_hearing": return "propose";
    case "cost_explain": case "cost_breakdown": case "guarantor_info": return "answer";
    case "acknowledge_check": return "promise_make";
    case "phone_call": return "ease";
    case "zenryoku_support": case "followup_revive": return "relation";
    default: return null;
  }
}
/** 返信の文 → 重点（purposeOfText の趣旨・誘いの札から）。決まった札だけ＝LLM なし */
export function focusOfReplyText(text: string): Focus {
  const p = purposeOfText(text);
  const cta = p.seq.includes("cta_viewing") || p.seq.includes("cta_apply");
  switch (p.purpose) {
    case "inform": case "decline": return "answer";
    case "promise": return "promise_make";
    case "support": return "ease";
    case "appeal": return cta ? "close" : "propose";
    case "ask": return cta ? "close" : "propose";
    case "material": return "promise_keep";
    case "ack": default: return cta ? "close" : "relation";
  }
}
export function focusOfTakeuchiTurn(o: { route: "aix" | "reply"; aixType: string | null; text: string; openPromise?: boolean }): Focus | null {
  return o.route === "aix" ? focusOfAix(o.aixType, { openPromise: o.openPromise }) : focusOfReplyText(o.text);
}

// ── (b) 状況の文 v2（その番の時点で分かる物だけ） ─────────────────────────────
export type HistMsg = { sender: string; text: string | null; created_at: string; aixType?: string | null };
const SEND_AIX = new Set(["property_send", "property_recommendation"]);
/** その時点の進み（AIX の歴から・今の会話の段階は使わない＝未来の値が入らない） */
export function stageAt(hist: ReadonlyArray<HistMsg>): string {
  const t = new Set(hist.map((m) => m.aixType).filter(Boolean) as string[]);
  if (t.has("application_push")) return "申込の後押しの後";
  if (t.has("meeting_place")) return "内覧の確定の後";
  if (t.has("viewing_invite") || t.has("greeting_viewing")) return "内覧の案内の後";
  if (t.has("estimate_sheet")) return "見積書の後";
  if ([...t].some((x) => SEND_AIX.has(x) || x === "property_check_result")) return "物件を送った後";
  return hist.some((m) => m.sender !== "customer") ? "やり取りの始め" : "初回";
}
const PROMISE_RE = /(?:確認|お送り|ピックアップ|ご連絡|交渉|調整|作成|手配|お調べ|探させ).{0,20}(?:させて頂きます|致します|いたします)|次第/;
/** 開いている約束: こちらの最後の約束の文の後に、果たす AIX（物件・確認の結果・見積書）がまだ無い（決まった計算・候補） */
export function openPromiseAt(hist: ReadonlyArray<HistMsg>): string | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.sender === "customer") continue;
    if (m.aixType && (SEND_AIX.has(m.aixType) || m.aixType === "property_check_result" || m.aixType === "estimate_sheet")) return null;
    const s = (m.text ?? "").split(/\n+|(?<=[！!。])/u).find((x) => PROMISE_RE.test(x));
    if (s && !m.aixType) return s.replace(/\s+/g, " ").trim().slice(0, 60);
  }
  return null;
}
export function sentAt(hist: ReadonlyArray<HistMsg>, nowMs: number): string {
  const sends = hist.filter((m) => m.aixType && SEND_AIX.has(m.aixType));
  const parts: string[] = [];
  if (sends.length) parts.push(`物件 ${sends.length}回（最後 ${Math.max(0, Math.round((nowMs - Date.parse(sends[sends.length - 1].created_at)) / 86_400_000))}日前）`);
  if (hist.some((m) => m.aixType === "property_check_result")) parts.push("確認の結果");
  if (hist.some((m) => m.aixType === "estimate_sheet")) parts.push("見積書");
  return parts.join("・") || "なし";
}
/** 直前のこちらの要点（AIX なら種類・返信ならメインの1文）。伏せた文を渡す */
export function lastStaffGist(m: HistMsg | null | undefined): string {
  if (!m) return "なし";
  if (m.aixType) return `AIX:${m.aixType}`;
  const p = purposeOfText(m.text ?? "");
  return `返信（${p.purpose}）${p.main ? `: ${p.main.replace(/\s+/g, " ").slice(0, 60)}` : ""}`;
}
export const SITUATION_V2_CUSTOMER_MAX = 120;
/** 状況の文 v2。hist は今の番より前（古い順・伏せた文）。customerMasked は今の番のお客様の発言（伏せた文） */
export function turnSituationTextV2(o: { scene: string | null; hist: ReadonlyArray<HistMsg>; customerMasked: string; nowMs: number }): string {
  const lastStaff = [...o.hist].reverse().find((m) => m.sender !== "customer" && ((m.text ?? "").trim() || m.aixType));
  const promise = openPromiseAt(o.hist);
  return [
    `場面: ${o.scene || "不明"}`,
    `進み: ${stageAt(o.hist)}`,
    `直前のこちら: ${lastStaffGist(lastStaff)}`,
    `開いている約束: ${promise ?? "なし"}`,
    `送った物: ${sentAt(o.hist, o.nowMs)}`,
    `お客様: ${o.customerMasked.replace(/\s+/g, " ").trim().slice(0, SITUATION_V2_CUSTOMER_MAX)}`,
  ].join("\n");
}

// ── (c) 近い番の重点 ─────────────────────────────────────────────────
export type FocusNeighbor = { id: string; focus: Focus; dist: number };
export type NearFocus = { focus: Focus; share: number; n: number; ids: string[]; inBand: boolean };
/**
 * 近い番（距離 dist の小さい順・時間順で前の番だけ・同じ会話とお客様は呼ぶ側で外す）から重点を1つ。
 *   狭い束（dist<=band の番が minN 件以上）の時だけ束の多数決（近さで重み 1-dist）。束の外は場面の多い重点（sceneFocus）に寄せる（保守的・977cbded ②）
 */
export function nearestFocus(neigh: ReadonlyArray<FocusNeighbor>, o: { band: number; minN: number; sceneFocus: Focus | null }): NearFocus | null {
  const inside = neigh.filter((x) => x.dist <= o.band);
  if (inside.length < o.minN) return o.sceneFocus ? { focus: o.sceneFocus, share: 0, n: inside.length, ids: [], inBand: false } : null;
  const w = new Map<Focus, number>();
  for (const x of inside) w.set(x.focus, (w.get(x.focus) ?? 0) + (1 - x.dist));
  const tot = [...w.values()].reduce((a, b) => a + b, 0);
  const best = [...w.entries()].sort((a, b) => b[1] - a[1] || FOCUS_KINDS.indexOf(a[0]) - FOCUS_KINDS.indexOf(b[0]))[0];
  return { focus: best[0], share: Math.round((best[1] / tot) * 100) / 100, n: inside.length, ids: inside.slice(0, 5).map((x) => x.id), inBand: true };
}
/** 場面の中で一番多い重点（時間順で前の番だけを渡す） */
export function sceneMajorityFocus(prev: ReadonlyArray<Focus>): Focus | null {
  if (!prev.length) return null;
  const c = new Map<Focus, number>();
  for (const f of prev) c.set(f, (c.get(f) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || FOCUS_KINDS.indexOf(a[0]) - FOCUS_KINDS.indexOf(b[0]))[0][0];
}
/** digest の1語: 重点|理由の印|近い番（束なら b:n:share） 例 "promise_keep|open|b:6:0.83" */
export function focusDigest(o: { focus: Focus; why: string; near: NearFocus | null }): string {
  const nb = o.near ? (o.near.inBand ? `b:${o.near.n}:${o.near.share}:${o.near.focus}` : `s:${o.near.focus}`) : "-";
  return `${o.focus}|${o.why.slice(0, 12)}|${nb}`;
}

// ── (d) 入口の統括の読み: 表 → 背景 → 重点（KB P0 575a7cd5 の追記「言葉の背景を読み取る」「その連携も含めて理解」） ─────────
//   前半（読む→重点→渡す）はここ。後半（確かめる→決め直す→まとめる）は、meta.conductor_focus を作業員4の深く読み直す包みと BRAIN_RECHECK が拾う。
/** 入口の統括の先頭（作り置き）に足す固定の文。版を変える時だけ変える（日時・名前・件数を入れない） */
export const FOCUS_INTAKE_RULES = [
  `【この番の重点（3段で読む）】①表 surface＝お客様が何を聞いたか・頼んだか（お客様の言葉に近く）②背景 background＝なぜ今それを言ったか・言っていない心配や本音・段階と気持ち・前の約束や送った物との関係（会話と材料から読める物だけ・創作しない）③重点 focus＝この番で一番大切な事を次から1つ: ${FOCUS_KINDS.map((k) => `${k}=${FOCUS_LABEL[k]}`).join("／")}。`,
  `重点は優先順位の段（正直→確認の約束→一つ一つに答える→即答→気持ち→次の一手→形）の上で決める。迷ったら段の上を採る。スタッフしか知らない結果（確認の結果・見積・日程の確定）が要る番は、手元に結果があれば promise_keep（AIX で果たす）、無ければ promise_make（確かめる約束）。`,
  // 2026-11-06 作業員5（統括役・KB 竹内さんの型「正直に答える／不安を消すは最初の文で見分ける」）: 竹内さんの実送信（解剖の answer 10通・ease 10通）が一番に書いた事から見分けを足す。
  //   同じ46番×3回の多数（DeepSeek・温度は本番の入口と同じ既定）: 近い番あり 22→26（悪化0・良化4）・近い番なし 18→23（悪化2・良化7）
  `answer と ease の見分け（竹内さんの実際の送信から）: answer＝最初の文が聞かれた事実そのもの（床の色・玄関の広さ・分割の可否・代理契約・取扱いの可否・日時と待ち合わせ場所）。会社の決まりや資料で言える事（分割はクレジットカード払いのみ・入居までの目安・系列の取扱い）は確かめる約束にせず answer。ease＝最初の文が、お客様が言っていない心配（審査に通るか・費用・入居の時期・候補日を断った気まずさ・条件を忘れられた不安）を受け止めて安心させる言葉（「大丈夫です」「最大限割引させて頂き費用抑えさせて頂きます」「審査に通りやすい保証会社を意識」「重点的にお調べ」）。物件を送る約束が添えてあっても、心配を受け止める言葉が先なら ease。`,
  `【竹内さんの近い過去の番の重点】があれば参考にする（同じとは限らない・背景が違えば変える）。重点に関係の無い担当は roles に入れない。`,
].join("\n");
export const FOCUS_INTAKE_FIELD = `"focus_read": {"surface": "表（30字以内）", "background": "背景（40字以内）", "focus": "${FOCUS_KINDS.join("|")}", "why": "理由（30字以内）"}`;

export type FocusRead = { surface: string; background: string; focus: Focus; why: string; near: string | null; keepPromise?: boolean };
/** 入口の統括の答えから focus_read を読む（一覧に無い重点は捨てる） */
export function parseFocusRead(raw: unknown, near: NearFocus | null = null): FocusRead | null {
  const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).focus_read ?? raw : null) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const focus = String(o.focus ?? "").trim() as Focus;
  if (!(FOCUS_KINDS as readonly string[]).includes(focus)) return null;
  const s = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return { surface: s(o.surface, 30), background: s(o.background, 40), focus, why: s(o.why, 30), near: near ? `${near.inBand ? "束" : "場面"}:${near.focus}${near.inBand ? `(${near.n}件・${Math.round(near.share * 100)}%)` : ""}` : null };
}
/** 入口の統括の後ろ（毎回変わる部分）に入れる、近い番の重点の1行（束の時だけ・外は場面の多い重点だけ） */
export function nearFocusLine(near: NearFocus | null): string {
  if (!near) return "";
  if (!near.inBand) return `【竹内さんの近い過去の番の重点】近い番は少ない。同じ場面で多いのは ${near.focus}（${FOCUS_LABEL[near.focus]}）`;
  return `【竹内さんの近い過去の番の重点】よく似た状況の ${near.n}番のうち ${Math.round(near.share * 100)}% が ${near.focus}（${FOCUS_LABEL[near.focus]}）`;
}
// ── 順番の表（KB P1 0dbfbc97「統括は場面×重点ごとにブレインを使う順番を決める」・P0 575a7cd5 の子）─────────────
//   1番目＝大まかな判断（返信か AIX か・どの系統か）→ 2番目＝細部（どの AIX・ピッカー・約束の種類・物件の選び）→ 3番目＝文の組み立て → 4番目＝確かめ。
//   後の役は前の役が決めた事を決め直さない。食い違ったら黙って上書きせず、統括に差し戻す（focusConflict → 読み直し）。表はここ1か所・digest に使った順番（orderDigest）。
//   役の名前は conductor-roles.ts の ROSTER と判断のブレイン judge。combine＝何通・どの順・各通の受け持ち（作業員7 two-message-plan.planForConductor・KB 3701b532・11/05 竹内さん「組み合わせは統括が決める」）。重点に関係の無い役は表に無い＝呼ばない。
export type OrderStage = "rough" | "detail" | "compose" | "verify";
export type OrderStep = { stage: OrderStage; role: string; takes: string; decides: string };
const S = (stage: OrderStage, role: string, takes: string, decides: string): OrderStep => ({ stage, role, takes, decides });
export const FOCUS_ORDER: Record<Focus, OrderStep[]> = {
  answer: [S("rough", "judge", "重点・表と背景", "返信か AIX か（答えにスタッフだけが知る事が要るか）"), S("detail", "fetch", "判断・need", "答えの材料（資料・会社の事実）"), S("compose", "combine", "判断の turn_contract＋重点", "何通・どの順・各通の受け持ち（答える／信頼／訴求）"), S("compose", "compose", "判断・材料", "答えを先に置く構成"), S("compose", "writer", "設計図", "文"), S("verify", "check_ground", "下書き＋材料", "根拠の無い事実が無いか")],
  promise_make: [S("rough", "judge", "重点・開いている約束", "確かめる約束の返信（AIX ではない）"), S("detail", "judge", "約束の種類", "何を・いつまでに確かめるか"), S("compose", "compose", "約束", "受け→約束→締め"), S("compose", "writer", "設計図", "文")],
  promise_keep: [S("rough", "judge", "重点・開いている約束・送った物", "AIX で果たす番か"), S("detail", "aix_desk", "判断（AIX の系統）", "どの AIX・ピッカー"), S("detail", "property_search", "AIX の種類（物件を送る時）", "送る物件"), S("detail", "estimate", "物件（見積の時）", "見積の下書き"), S("compose", "combine", "判断の turn_contract＋重点", "何通・どの順・各通の受け持ち（答える／信頼／訴求）"), S("compose", "second", "決まった AIX", "2通目（要る時）")],
  ease: [S("rough", "judge", "重点・背景（言っていない心配）", "返信か AIX か（電話が要るか）"), S("detail", "deep", "背景・全履歴", "安心する物（relief）"), S("compose", "combine", "判断の turn_contract＋重点", "何通・どの順・各通の受け持ち（答える／信頼／訴求）"), S("compose", "compose", "relief", "受け→サポート→締め"), S("compose", "writer", "設計図", "文"), S("verify", "check_worry", "下書き＋3段", "奥の心配に応えたか")],
  close: [S("rough", "judge", "重点・進み", "内覧・申込に進める番か"), S("detail", "viewing_calendar", "物件・期限", "空いている枠"), S("detail", "aix_desk", "判断＋枠", "内覧調整・待ち合わせ・申込のどれか"), S("compose", "combine", "判断の turn_contract＋重点", "何通・どの順・各通の受け持ち（答える／信頼／訴求）"), S("compose", "compose", "決まった AIX か誘い", "誘いの締め")],
  propose: [S("rough", "judge", "重点・送った物・条件", "物件を出すか条件を聞くか"), S("detail", "property_search", "条件＋plan_ahead", "出す物件（🌟の選び）"), S("detail", "aix_desk", "物件", "ピックアップかオススメか"), S("compose", "combine", "判断の turn_contract＋重点", "何通・どの順・各通の受け持ち（答える／信頼／訴求）"), S("compose", "compose", "選んだ物件", "訴求の構成")],
  relation: [S("rough", "judge", "重点", "受けの返信で足りるか"), S("compose", "writer", "受け", "受け→締め（中身を足さない）")],
};
/** 場面ごとの上書き（場面×重点で順番が変わる所だけ）。例: 費用の質問に答える番は見積書の材料を2番目に取る */
const SCENE_ORDER: Partial<Record<string, Partial<Record<Focus, OrderStep[]>>>> = {
  cost: { answer: [S("rough", "judge", "重点・表と背景", "返信か AIX（初期費用について・説明）か"), S("detail", "estimate", "物件（あれば）", "費用の中身・割引"), S("compose", "combine", "判断の turn_contract＋重点", "何通・どの順・各通の受け持ち（答える／信頼／訴求）"), S("compose", "writer", "判断＋費用の材料", "文"), S("verify", "check_ground", "下書き＋材料", "金額を材料の外で言っていないか")] },
};
/** relation の「継続の約束を添える」1段（案A・11/05 統括役決定・作業員9の数え: 条件 59%／了承 9%／検討 12%・言葉では見分けられない）。KB 1d07b3df: 新着で出次第か全力サポートのどちらか1つ・同じ日に1回まで */
const KEEP_STEP = S("compose", "compose", "受け＋前の流れ（送った物・報告・開いている約束）", "継続の約束を1つ添える（新着で出次第／全力サポート・同じ日に1回まで）");
/**
 * relation の番に継続の約束を添えるか（決めるのは統括・ここは線）。条件の番は既定で添える（竹内さん 59%）。同じ日に既に添えていたら添えない（KB 1d07b3df）。
 *   了承・検討の番で添えるのは (b) お客様が新着を頼んだ か (c) 近い竹内さんの番の過半数（anatomy.keep・nearKeepShareFor）が添えている 時だけ。
 *   2026-11-06 統括役の決め（作業員9 試験 q164 の外れ・了承の番で竹内さんが添えるのは 9%）: (a)「直前に物件を送った・募集終了の報告で約束が開いていない」は
 *   単独では添えない（候補だけ）＝ relationKeepCandidate で見て、統括の材料にするだけ
 */
export function relationKeep(o: { scene: string | null | undefined; lastStaffSentOrEnded?: boolean; openPromise?: boolean; customerAskedNew?: boolean; nearKeepShare?: number | null; keptToday?: boolean }): boolean {
  if (o.keptToday) return false;
  if (o.scene === "conditions") return true;
  if (o.scene !== "ack" && o.scene !== "considering") return false;
  return !!o.customerAskedNew || (o.nearKeepShare ?? 0) > 0.5;
}
/** (a) の候補（添えない・統括に見せるだけ）: 了承・検討の番で、直前が物件の送付か募集終了の報告で、開いている約束が無い */
export function relationKeepCandidate(o: { scene: string | null | undefined; lastStaffSentOrEnded?: boolean; openPromise?: boolean }): boolean {
  return (o.scene === "ack" || o.scene === "considering") && !!o.lastStaffSentOrEnded && !o.openPromise;
}
/** 近い番の「継続の約束を添えたか」（anatomy.keep）の割合。分かる番が minN 未満なら null（添える根拠にしない） */
export function keepShareOf(keeps: ReadonlyArray<boolean | null | undefined>, minN = 3): number | null {
  const known = keeps.filter((k): k is boolean => typeof k === "boolean");
  if (known.length < minN) return null;
  return Math.round((known.filter(Boolean).length / known.length) * 100) / 100;
}
export function focusOrder(scene: string | null | undefined, focus: Focus, o: { keep?: boolean } = {}): OrderStep[] {
  const base = (scene && SCENE_ORDER[scene]?.[focus]) || FOCUS_ORDER[focus];
  if (focus === "relation" && o.keep) return [base[0], KEEP_STEP, ...base.slice(1).map((x) => (x.role === "writer" ? { ...x, decides: "受け→継続の約束→締め" } : x))];
  return base;
}
/** digest の「使った順番」（例 "judge>aix_desk>property_search>second"） */
export const orderDigest = (steps: ReadonlyArray<OrderStep>) => steps.map((s) => s.role).filter((r, i, a) => a[i - 1] !== r).join(">");
/** 後の役が前の役の決めた事を変えたか（決め直しは差し戻しにする）。前の段の役が決めた値と後の役の値を比べるだけ */
export function laterOverrode(steps: ReadonlyArray<OrderStep>, decided: ReadonlyArray<{ role: string; value: string | null }>): string | null {
  const stageOf = (role: string) => steps.findIndex((s) => s.role === role);
  for (let i = 1; i < decided.length; i++) {
    const prev = decided[i - 1], cur = decided[i];
    if (prev.value && cur.value && prev.value !== cur.value && stageOf(cur.role) > stageOf(prev.role)) return `${cur.role} が ${prev.role} の決めた「${prev.value}」を「${cur.value}」に変えた`;
  }
  return null;
}
/** meta.conductor_focus（作業員4の受け口）に入れる形 */
export const conductorFocusMeta = (r: FocusRead | null) => (r ? { focus: r.focus, why: r.why || null, surface: r.surface || null, background: r.background || null, near: r.near, ...(r.keepPromise !== undefined ? { keepPromise: r.keepPromise } : {}) } : null);
/** digest.cf の1語（表・背景は入れない＝短く） */
export const focusReadDigest = (r: FocusRead | null | undefined) => (r ? `${r.focus}${r.near ? `|${r.near}` : ""}` : null);

// ── (e) 後半への受け渡し: 最初の判断が重点と食い違う時だけ、読み直しの材料にする（決めるのはブレイン・ここは候補） ──────
/** 食い違いの理由（無ければ null）。はっきりした物だけ: 果たす番なのに返信・答える番なのに物件を送る・不安の番に申込の後押し */
export function focusConflict(focus: Focus, first: { aix: string | null }): string | null {
  if (focus === "promise_keep" && !first.aix) return "重点は約束を果たす番なのに、最初の判断は返信";
  if (focus === "answer" && first.aix && SEND_AIX.has(first.aix)) return "重点は聞かれた事に答える番なのに、最初の判断は物件を送る";
  if (focus === "ease" && first.aix === "application_push") return "重点は不安を消す番なのに、最初の判断は申込の後押し";
  return null;
}
