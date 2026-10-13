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

export function aixBrainContractOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_BRAIN_CONTRACT ?? "on").trim().toLowerCase() !== "off";
}

export type AixContractMeta = {
  turn_contract?: unknown;
  analyzed_msg_ts?: string | null;
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
  return last === null || at >= last - 1000;
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
  const mine = asks.filter((a) => a.route === "aix" && askIsThisAix(String(a.aix ?? ""), o.action, o.checkPattern));
  const other = asks.filter((a) => a.route === "aix" && !askIsThisAix(String(a.aix ?? ""), o.action, o.checkPattern));
  const rest = asks.filter((a) => a.route !== "aix");
  const q = (a: { quote?: unknown }) => `「${String(a.quote ?? "")}」`;
  if (mine.length) L.push(`- この AIX で受ける依頼: ${mine.map((a) => `${q(a)}${a.answer ? `→ ${String(a.answer)}` : ""}`).join(" ／ ")}（→ の後はブレインの方向。日時・金額・空き等の値はスタッフの入力・資料の値だけを書く）`);
  // 10/13 の試し（link1）: 返信・約束の依頼を「この通で触れるなら」と渡すと、御見積書の約束・審査の励ましを AIX の文に足した（竹内さんは書かない＝別の通で受ける）。
  //   ブレインの答え方（返信／約束／別の AIX）は「この AIX の文の外」で受ける＝この文には書かない、と渡す（P0 ca55d42b の分け方そのもの）
  const elsewhere = [...other.map((a) => `${q(a)}（別の AIX ${String(a.aix ?? "")}）`), ...rest.filter((a) => a.route !== "none").map((a) => `${q(a)}（${ROUTE_JA[String(a.route)] ?? ""}）`)];
  if (elsewhere.length) L.push(`- この文では触れない依頼（返信・約束・別の AIX の通で受ける＝答えも「別途お送りします」等の約束もこの文に書かない）: ${elsewhere.join(" ／ ")}`);
  const untouched = rest.filter((a) => a.route === "none");
  if (untouched.length) L.push(`- 触れない: ${untouched.map(q).join(" ／ ")}`);
  if (c && asks.length) L.push("- この一覧に無い**新しい**確認・交渉・作成の約束は足さない（スタッフが入れた欄・会話の糸口の候補にある物は使ってよい）。");
  // 言わない: ブレインの must_not は返信の線（スタッフだけが知る値を返信の本文で言い切らない）を含む。AIX はスタッフが入れた値を届ける道具なので、
  //   値の言い切りの線（日時・金額・空き・確定・本文で〜）は AIX には渡さない（渡すとスタッフが入れた内覧の候補日まで消した＝10/13 の試し viewing_invite:02c26493）
  const mustNot = ((c?.must_not as string[] | undefined) ?? []).filter((s) => !STAFF_VALUE_LINE_RE.test(s));
  if (mustNot.length) L.push(`- 言わない: ${mustNot.join(" ／ ")}`);
  // proposals（抑える・オンライン内見 等）は返信の材料（すぐ来られない事情への申し出）。AIX の文に足すと竹内さんが書かない文になる（試し 02c26493）＝渡さない
  const fk = c?.feeling && (c.feeling as { kind?: unknown }).kind ? String((c.feeling as { kind?: unknown }).kind) : "";
  if (fk && (c?.feeling as { acknowledge?: unknown } | null)?.acknowledge) L.push(`- お客様の気持ち（${FEELING_JA[fk] ?? fk}）は本題の前に一言で受ける（お客様が書いた言葉に触れる・新しい言い回しを作らない）`);
  if (mindBits.length) L.push(`- お客様の今（ブレイン）: ${mindBits.join("・")}（言葉選びの判断にだけ使う・分析の言葉を本文に書かない）`);
  return L.length > 1 ? L.join("\n") : "";
}
/** 返信側の「値を言い切らない」線（AIX ではスタッフの入力として書いてよい物） */
export const STAFF_VALUE_LINE_RE = /日時|日程|時間|時刻|確定|金額|見積|費用|空き|空室|募集|断言|断定|本文/;
const FEELING_JA: Record<string, string> = { anxious: "不安", apologetic: "恐縮・謝罪", hurried: "急ぎ", disappointed: "落胆", positive: "前向き" };

/**
 * 旧の「【⚠️ 顧客の質問（全て回答すること）】」を出すか。
 *   ブレインの本質がこの番に届いている時は、依頼ごとの答え方が上の材料にある＝全部を AIX の文で答えさせる強制は出さない（ぶつかる規則を材料に下げる）。
 */
export function keepAllQuestionsRule(contractNote: string): boolean {
  return !contractNote;
}
