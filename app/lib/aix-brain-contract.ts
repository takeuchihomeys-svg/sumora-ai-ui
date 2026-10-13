// app/lib/aix-brain-contract.ts — ブレインがこの番に決めた「本質」（turn_contract）とお客様の状態を、AIX の文の生成に材料として届ける（純関数・DB/LLM なし）
//
// 2026-10-13 竹内「せっかくブレインがあるのに有効に活用できていない部分を改善する。主に AIX テンプレートの部分は、ちゃんとブレインに連動できていない
//   可能性が高い。ちゃんと連携したら文が生成されるのでそのように行う」＋ P0 9eb6aa9c「判断はすべてブレイン基準（規則は候補の網と安全の線だけ）」・P1 0593a0aa。
//
// 調べ（scripts/audit-aix-text-vs-takeuchi.ts・棚卸しは memory/dept_line_reply.md 10/13「AIX の文をブレインに連動」）:
//   ブレインは毎回の判断で、お客様の今の依頼ごとの答え方（返信／約束／AIX＋どのボタン／触れない）・言ってはいけない事・添える提案・気持ちを
//   turn_contract に書いている（10/08〜）。返信の生成（generate-reply）はこれを最上位にしているのに、**AIX の文の生成（aix/action・aix-template-generate）には
//   一度も届いていなかった**。代わりに AIX は ①customer_questions を「全て回答すること」と強制（＝別の AIX・返信・約束で受ける依頼まで AIX の文で答えさせる）
//   ②テンプレ（✨）は勝ちパターン×成約戦略を「〜させて頂きます」の宣言1文で必ず入れる、の規則で中身を決めていた。
//   実物（竹内さんの実送信との差）: 内覧日調整で「管理会社に確認させて頂きます」を作った（ブレインは候補日時を送る番＝竹内さんは時間を書いた 10/12）／
//   物件ピックアップに頼まれていない確認の約束を足す（竹内さんが消した 60日 9組）／内覧日調整でブレインの「言わない（申込誘導）」が届かない。
// 形: 答えは書かない（どの依頼をこの AIX で受けるか・言わない事・添えてよい提案の「材料」だけ）。値・結果はスタッフの入力と資料だけ（安全の線は上）。
//   古い判断（最後のお客様の発言より前の分析）は渡さない（返信生成の鮮度の線と同じ）。
// 戻す: AIX_BRAIN_CONTRACT=off（呼ぶ時に読む＝同じプロセスで前後を作り直せる）
// テスト: app/lib/__tests__/aix-brain-contract.test.ts
import { normalizeBrainTurnContract, type BrainTurnContractRaw } from "./turn-contract";
import { BRAIN_FRESHNESS_TOLERANCE_MS } from "./brain-meta-restore";

export function aixBrainContractOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_BRAIN_CONTRACT ?? "on").trim().toLowerCase() !== "off";
}

export type AixContractMeta = {
  turn_contract?: unknown;
  analyzed_msg_ts?: string | null;
  /** ブレインが選んだ AIX（一手） */
  action?: string | null;
  customer_mindset?: { state?: string | null; anxiety?: unknown; hesitation?: string | null } | null;
} | null | undefined;

type Msg = { sender?: string | null; createdAt?: string | null; created_at?: string | null; rawCreatedAt?: string | null };

/** 最後のお客様の発言の時刻（分からなければ null） */
export function lastCustomerAt(messages: ReadonlyArray<Msg> | null | undefined): number | null {
  let best: number | null = null;
  for (const m of messages ?? []) {
    if (m?.sender !== "customer") continue;
    const t = Date.parse(String(m.createdAt ?? m.created_at ?? m.rawCreatedAt ?? ""));
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * ブレインの判断が今のお客様の発言を見た物か。
 *   analyzed_msg_ts が無い判断は古い形（10/08 より前）＝使わない。最後のお客様の発言の時刻が分からない時は判断の時刻を信じる。
 */
export function contractFreshForAix(meta: AixContractMeta, messages: ReadonlyArray<Msg> | null | undefined): boolean {
  const at = Date.parse(String(meta?.analyzed_msg_ts ?? ""));
  if (!Number.isFinite(at)) return false;
  const last = lastCustomerAt(messages);
  return last === null || at >= last - BRAIN_FRESHNESS_TOLERANCE_MS; // 10/13 確かめる人: 他の鮮度の線（aix-button-view 等）と同じ 5秒
}

const ROUTE_JA: Record<string, string> = { reply: "返信で答える", promise: "約束で受ける", aix: "AIX", none: "触れない" };

/** ask の AIX の鍵（"ボタン" か "ボタン/ピッカー"）がこの AIX か */
export function askIsThisAix(aixKey: string | null | undefined, action: string, checkPattern?: string | null): boolean {
  const k = String(aixKey ?? "").trim();
  if (!k) return false;
  const [btn, picker] = k.split("/");
  if (btn !== action) return false;
  return !picker || !checkPattern || picker === checkPattern;
}

/**
 * AIX の生成に渡す「ブレインが読んだこの番」の材料。無い・古い時は ""。
 *   ・この AIX で受ける依頼（ブレインの答えの要点は方向だけ・値はスタッフの入力と資料）
 *   ・別の AIX の番の依頼（この文で答えない・新しい約束にしない）
 *   ・返信／約束で受ける依頼（この通で触れるなら、返信は会話・資料の事実で・約束はこの中身だけ）
 *   ・言わない・添えてよい提案・気持ち・お客様の状態
 */
export function buildAixContractNote(o: { meta: AixContractMeta; action: string; checkPattern?: string | null; messages?: ReadonlyArray<Msg> | null; env?: Record<string, string | undefined> }): string {
  if (!aixBrainContractOn(o.env)) return "";
  if (!o.meta || !contractFreshForAix(o.meta, o.messages)) return "";
  const c: BrainTurnContractRaw | null = normalizeBrainTurnContract(o.meta.turn_contract);
  const mind = o.meta.customer_mindset ?? null;
  const ax = mind?.anxiety as unknown;
  const anxietyText = ax && typeof ax === "object"
    ? [(ax as { target?: unknown }).target, (ax as { direction?: unknown }).direction].filter((x) => typeof x === "string" && x).join("・")
    : typeof ax === "string" ? ax : "";
  const mindBits = [mind?.state ? `状態: ${String(mind.state).slice(0, 30)}` : "", anxietyText ? `気にしている事: ${anxietyText.slice(0, 40)}` : "", typeof mind?.hesitation === "string" && mind.hesitation ? `迷い: ${mind.hesitation.slice(0, 40)}` : ""].filter(Boolean);
  if (!c && !mindBits.length) return "";
  const L: string[] = [];
  L.push("【🧭 ブレインが読んだこの番（材料: どの依頼にこの文で答えるか・何を書かないかはここで決める。スタッフが入れた値・確認の結果はそのまま全部使う）】");
  const asks = (c?.asks ?? []) as Array<{ quote?: unknown; route?: unknown; answer?: unknown; aix?: unknown }>;
  // 10/13 確かめる人 重要2: 約束の依頼は、その約束を果たす種類の AIX（確認→確認した・見積→見積書送る 等）を押した時はこの AIX で受ける依頼
  const isMine = (a: { route?: unknown; aix?: unknown; quote?: unknown; answer?: unknown }) =>
    (a.route === "aix" && askIsThisAix(String(a.aix ?? ""), o.action, o.checkPattern)) || (a.route === "promise" && promiseFulfilledBy(`${a.quote ?? ""} ${a.answer ?? ""}`, o.action));
  const mine = asks.filter(isMine);
  // 依頼の振り分けを渡すのは、押された AIX がブレインの読みと同じ番だけ（ブレインの一手＝この AIX・またはこの AIX で受ける依頼がある）。
  //   違う AIX を押した番（スタッフが別の判断で送る通）に振り分けを渡すと全部が「触れない」になり、文が中身を失った（試し 88d3839f 0.52→0.34）＝言わない事・気持ちだけ渡す
  const routed = (!!o.meta.action && askIsThisAix(String(o.meta.action), o.action, null)) || mine.length > 0;
  const q = (a: { quote?: unknown }) => `「${String(a.quote ?? "")}」`;
  if (routed) {
    const other = asks.filter((a) => !isMine(a) && a.route === "aix");
    const rest = asks.filter((a) => !isMine(a) && a.route !== "aix");
    if (mine.length) L.push(`- この AIX で受ける依頼: ${mine.map((a) => `${q(a)}${a.answer ? `→ ${String(a.answer)}` : ""}`).join(" ／ ")}（→ の後はブレインの方向。日時・金額・空き等の値はスタッフの入力・資料の値だけを書く）`);
    // 10/13 の試し（link1）: 返信・約束の依頼を「この通で触れるなら」と渡すと、御見積書の約束・審査の励ましを AIX の文に足した（竹内さんは書かない＝別の通で受ける）。
    //   竹内さんの実際（scripts/audit-aix-reply-asks-split.ts・60日）: 質問のある番の AIX 202番のうち 163番は別の手打ちの通でも送り（87番は AIX の後だけ）、
    //   AIX だけの 39番は質問そのものがその AIX の依頼（「内覧可能ですか」→内覧日調整）だった＝返信の依頼は AIX の文の外で答える形
    const elsewhere = [...other.map((a) => `${q(a)}（別の AIX ${String(a.aix ?? "")}）`), ...rest.filter((a) => a.route !== "none").map((a) => `${q(a)}（${ROUTE_JA[String(a.route)] ?? ""}）`)];
    if (elsewhere.length) L.push(`- この文では触れない依頼（返信・約束・別の AIX の通で受ける＝答えも「別途お送りします」等の約束もこの文に書かない）: ${elsewhere.join(" ／ ")}`);
    const untouched = rest.filter((a) => a.route === "none");
    if (untouched.length) L.push(`- 触れない: ${untouched.map(q).join(" ／ ")}`);
    if (c && asks.length) L.push("- この一覧に無い**新しい**確認・交渉・作成の約束は足さない（スタッフが入れた欄・会話の糸口の候補にある物は使ってよい）。");
  }
  // 言わない: ブレインの must_not は返信の線（スタッフだけが知る値を返信の本文で言い切らない）を含む。AIX はスタッフが入れた値を届ける道具なので、
  //   値の言い切りの線（日時・金額・空き・確定・本文で〜）は AIX には渡さない（渡すとスタッフが入れた内覧の候補日まで消した＝10/13 の試し viewing_invite:02c26493）
  //   10/13 確かめる人 重要1: 線は「値を本文で書く」形だけに絞り（STAFF_VALUE_LINE_RE）、その AIX 自身の話題の行（内覧日調整の「内覧の日程」等）も渡さない
  const mustNot = mustNotForAix((c?.must_not as string[] | undefined) ?? [], o.action);
  if (mustNot.length) L.push(`- 言わない: ${mustNot.join(" ／ ")}`);
  // proposals（抑える・オンライン内見 等）は返信の材料（すぐ来られない事情への申し出）。AIX の文に足すと竹内さんが書かない文になる（試し 02c26493）＝渡さない
  const fk = c?.feeling && (c.feeling as { kind?: unknown }).kind ? String((c.feeling as { kind?: unknown }).kind) : "";
  if (fk && (c?.feeling as { acknowledge?: unknown } | null)?.acknowledge) L.push(`- お客様の気持ち（${FEELING_JA[fk] ?? fk}）は本題の前に一言で受ける（お客様が書いた言葉に触れる・新しい言い回しを作らない）`);
  if (mindBits.length) L.push(`- お客様の今（ブレイン）: ${mindBits.join("・")}（言葉選びの判断にだけ使う・分析の言葉を本文に書かない）`);
  return L.length > 1 ? L.join("\n") : "";
}
/**
 * 返信側の「スタッフだけが知る値を本文で書かない」線（AIX ではスタッフの入力として書く物＝AIX には渡さない）。
 *   10/13 確かめる人 重要1: 旧の語だけの線（日時|見積|空き|断言…）は本番 must_not 151件中 64件を落とし、「見積書」「初期費用」「日程の催促」等の
 *   その話題に触れない線や、審査・空室の断言（安全の線）まで消した（88d3839f で「初期費用をかなり抑えて」を書いた）。
 *   → 「値を本文で書く・確定する」形だけに絞る。話題の語だけの行・審査や空室の断言の線は渡す。
 */
export const STAFF_VALUE_LINE_RE = /(?:日時|日程|内覧日|内見日|候補日|時間帯?)(?:や[^\s]{0,6})?(?:を|の)?(?:本文で)?(?:確定|作る|書く|創作|提示|断言)|(?:金額|見積額|見積金額|割引額|初期費用の金額)(?:を|の)?(?:本文で?)?(?:書く|言う|記載|示す|提示)|本文で[^\s]{0,8}(?:確定|提示|示す|記載|断言)|本文記載|(?:内覧|内見)(?:の)?(?:可否|可能)を?断言|(?:金額|日付|日時)の?(?:断言|断定)/;

/**
 * その AIX 自身が送る事柄の話題（must_not の話題の行がこれに当たる時は AIX には渡さない＝内覧日調整に「言わない: 内覧の日程」を渡さない）。
 *   ブレインの must_not は返信のための線（返信では内覧の日程・見積・物件の提案を言わず AIX に任せる）。
 */
const OWN_TOPIC_RE: Record<string, RegExp> = {
  viewing_invite: /内覧|内見|日程|日時|案内/, meeting_place: /内覧|内見|日程|日時|案内|待ち合わせ/,
  estimate_sheet: /見積|初期費用|金額|割引/, cost_explain: /見積|初期費用|金額|割引|費用/, cost_breakdown: /見積|初期費用|金額|割引|費用/,
  property_send: /物件|ピックアップ|提案|お部屋/, property_recommendation: /物件|ピックアップ|提案|お部屋/, zenryoku_support: /物件|ピックアップ|提案|新着/,
  property_check_result: /空室|空き|募集|確認の?結果/, application_push: /申込|お申込/,
};
export function mustNotForAix(lines: ReadonlyArray<string>, action: string): string[] {
  const own = OWN_TOPIC_RE[action];
  return lines.filter((s) => !STAFF_VALUE_LINE_RE.test(s) && !(own && own.test(s)));
}

/** 約束（確認・見積・探す・内覧の調整）の中身が、押された AIX で果たされる約束か（約束の依頼をこの AIX で受ける依頼に入れる） */
export function promiseFulfilledBy(text: string, action: string): boolean {
  const t = String(text ?? "");
  if (/見積|初期費用|割引/.test(t)) return /^(?:estimate_sheet|cost_explain|cost_breakdown|acknowledge_check)$/.test(action) || (action === "property_check_result" && /募集|空き|空室/.test(t));
  if (/募集|空き|空室|確認|管理会社|入居日|退去|設備|保証会社/.test(t)) return /^(?:property_check_result|acknowledge_check|guarantor_info)$/.test(action);
  if (/ピックアップ|探|新着|お部屋.*お送り/.test(t)) return /^(?:property_send|property_recommendation|zenryoku_support)$/.test(action);
  if (/内覧|内見|日程|案内/.test(t)) return /^(?:viewing_invite|meeting_place)$/.test(action);
  return false;
}
const FEELING_JA: Record<string, string> = { anxious: "不安", apologetic: "恐縮・謝罪", hurried: "急ぎ", disappointed: "落胆", positive: "前向き" };

/**
 * 旧の「【⚠️ 顧客の質問（全て回答すること）】」を出すか。
 *   ブレインの本質がこの番に届いている時は、依頼ごとの答え方が上の材料にある＝全部を AIX の文で答えさせる強制は出さない（ぶつかる規則を材料に下げる）。
 */
export function keepAllQuestionsRule(contractNote: string): boolean {
  return !contractNote;
}
