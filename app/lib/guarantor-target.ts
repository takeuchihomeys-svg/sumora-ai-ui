// app/lib/guarantor-target.ts
// AIX【保証会社について】を開いた時、お客様の保証会社の質問が「どのお部屋（1件／送った束の複数）」の話かを会話から決める（純関数・DB/LLM なし）。
//
// 2026-10-06 竹内（松浦 麻夜 事例）「なぜ物件きかれてるのに反映されていないのか　これは会話の流れからして送っている物件のことだと認識できるはずなのに」:
//   10/4 15:51 こちら「🌟H-maison大正VII 106 … 御見積書同封」（新着1件）→ 15:52「こちらのお部屋如何でしょうか」→ 17:46 お客様「ここは保証会社どこでしょうか？💦」
//   旧: 物件①の先入れは propertyNamePrefill（売上サポから来た時・お客様が名前を出した時）だけ。「ここ」は数えず、
//       しかも見出し「🌟H-maison大正VII 106」（号室の字なし）を送った物件として拾っていなかった → 物件①②とも空。
//   → 決め方（上から・決まった所で止める）:
//     ① 質問が引用返信で、引用先のこちらの1通に物件がある → その物件（1件でも複数でも）
//     ② confirm-target-property（確認した の物件特定と同じ1本）: 名前を出した・共有した・直後の送付・「ここ／この物件」＋直前の1通に1件
//     ③ 「ここ・この物件」等の指す語が無い質問（「保証会社はどこになりますか？」）で、質問の前のこちらの最後の送付に物件が並んでいる → その送付の全部
//   決まらない（「ここ」で直前の送付が複数・質問の後にお客様が別の物件を持ち込んだ・名前の無い持ち込み）時は空＋理由（推測で入れない）。
// 監査: scripts/audit-guarantor-prefill.ts
import { resolveConfirmTargetProperty, staffLabelsOf, propertyKeyOf, type TargetMsg } from "./confirm-target-property";
import { confirmObjectFromCustomerTurn } from "./action-ledger";

export type GuarantorTargetMsg = TargetMsg & { id?: string | null; quotedId?: string | null };
export type GuarantorTargetSource = "quoted" | "customer_named" | "customer_shared" | "answered_after_question" | "single_before_question" | "last_send";
export type GuarantorTargets = {
  names: string[];
  source: GuarantorTargetSource | null;
  /** 起点にしたお客様の質問（無ければ null） */
  question: string | null;
  /** 画面に出す一言（決めた理由／決めなかった理由） */
  reason: string;
};

const GUARANTOR_TOPICS = new Set(["保証会社", "審査"]);
const DEMONSTRATIVE_RE = /この(?:物件|お?部屋|マンション)|こちらの(?:物件|お?部屋)|こちら|ここ|その(?:物件|お?部屋)|そちら|上記|今の(?:物件|お?部屋)/;
const CUSTOMER_BROUGHT_RE = /https?:\/\/|^\s*\[画像\]/;
/** 送った束を全部入れる上限（AIX の物件カードは追加できるが、多すぎる束は初回ピックアップ＝どれの話か分からない側に倒す） */
export const GUARANTOR_BATCH_MAX = 10;

/** 手打ちの本文から拾った物件名の崩れ（「408号室号室」「Renatus新大阪 205 205号室」）を整える（監査 2026-10-06） */
export function cleanPropertyLabel(l: string): string {
  return l.trim().replace(/(?:号室|号)+号室$/, "号室").replace(/^(.*?)\s+([0-9０-９]{2,4})\s+\2号室$/, "$1 $2号室");
}

function uniqByKey(labelsIn: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labelsIn.map(cleanPropertyLabel)) {
    const k = propertyKeyOf(l).key;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/** 1回の送付の束とみなす、こちらの続いた通の間隔（これより空いたら別の送付） */
export const SEND_BLOCK_GAP_MS = 30 * 60_000;
const atMs = (m: GuarantorTargetMsg) => { const v = Date.parse(String(m.createdAt ?? m.rawCreatedAt ?? "")); return Number.isFinite(v) ? v : null; };
/** idx を含む、こちらの続いた通（お客様の発言・30分より空いた所で切る）の [始め, 終わり]。終わりは end の手前まで */
export function staffBlockAround(msgs: ReadonlyArray<GuarantorTargetMsg>, idx: number, end: number): [number, number] {
  let bs = idx, be = idx;
  const near = (a: GuarantorTargetMsg, b: GuarantorTargetMsg) => { const x = atMs(a), y = atMs(b); return x === null || y === null || Math.abs(x - y) <= SEND_BLOCK_GAP_MS; };
  while (bs - 1 >= 0 && msgs[bs - 1].sender !== "customer" && near(msgs[bs - 1], msgs[bs])) bs--;
  while (be + 1 < end && msgs[be + 1].sender !== "customer" && near(msgs[be], msgs[be + 1])) be++;
  return [bs, be];
}

/** 保証会社（または審査）を聞いた、お客様の最後の発言の位置。無ければ -1 */
export function guarantorQuestionIndex(msgs: ReadonlyArray<GuarantorTargetMsg>): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].sender !== "customer") continue;
    const hit = confirmObjectFromCustomerTurn(msgs[i].text);
    if (hit && GUARANTOR_TOPICS.has(hit.object)) return i;
  }
  return -1;
}

/** msgs は古い順（こちら＝staff・お客様＝customer）。こちらの画像は「[画像: 〇〇 101号室の資料・御見積書]」に置き換えて渡すと物件に数える */
export function resolveGuarantorTargets(msgsIn: ReadonlyArray<GuarantorTargetMsg>): GuarantorTargets {
  const msgs = msgsIn.slice(-60);
  const qi = guarantorQuestionIndex(msgs);
  if (qi < 0) return { names: [], source: null, question: null, reason: "保証会社・審査を聞いたお客様の発言が見当たらないので、物件は入れていません" };
  const qHit = confirmObjectFromCustomerTurn(msgs[qi].text);
  const topic = qHit?.object ?? "保証会社";
  const question = (qHit?.question ?? String(msgs[qi].text ?? "")).slice(0, 80);
  // 質問を含むお客様の連投
  let ts = qi, te = qi;
  while (ts - 1 >= 0 && msgs[ts - 1].sender === "customer") ts--;
  while (te + 1 < msgs.length && msgs[te + 1].sender === "customer") te++;
  const turn = msgs.slice(ts, te + 1);

  // ① 引用返信（連投のどれかがこちらの1通を引用）
  for (const m of turn) {
    if (!m.quotedId) continue;
    const q = msgs.find((x) => x.id && x.id === m.quotedId);
    if (!q || q.sender === "customer") continue;
    const ls = uniqByKey(staffLabelsOf(q.text));
    if (ls.length) return { names: ls.slice(0, GUARANTOR_BATCH_MAX), source: "quoted", question, reason: ls.length === 1 ? "お客様が引用した送付の物件" : `お客様が引用した送付の ${ls.length}件` };
    // 引用先（物件の画像等）がどの物件か分からない → 他の決め方で別の物件を入れない（2026-10-06 監査 9b9b81ba）
    return { names: [], source: null, question, reason: "お客様が引用した送付がどの物件か分からないので、物件は入れていません" };
  }

  // ② 確認した の物件特定と同じ1本（要件＝保証会社／審査）
  let one = resolveConfirmTargetProperty(msgs, { topic });
  // 「ここ」で直前の1通に1件でも、その前に続くこちらの通（同じ送付の束）に別の物件があれば、どれの話か分からない
  //   （AIX は1件ずつ「【〇〇 305号室】御見積書同封」を続けて送る＝1通1件でも束は複数）
  if (one?.source === "single_before_question") {
    const name = one.name;
    const at = (() => { for (let i = ts - 1; i >= 0; i--) if (msgs[i].sender !== "customer" && staffLabelsOf(msgs[i].text).some((l) => propertyKeyOf(l).key === propertyKeyOf(name).key)) return i; return -1; })();
    if (at >= 0) {
      const [bs, be] = staffBlockAround(msgs, at, ts);
      if (uniqByKey(msgs.slice(bs, be + 1).flatMap((m) => staffLabelsOf(m.text))).length > 1) one = null;
    }
  }
  // お客様の共有文から取った名前が文（「バルコニーを必要としていないので、丁度いいかも…」）なら物件名ではない（監査 e68fd1e2）
  if (one && one.source === "customer_shared" && (/[。、！？!?]/.test(one.name) || one.name.length > 40)) {
    return { names: [], source: null, question, reason: "お客様が送ってきた物件の名前が読めないので、物件は入れていません" };
  }
  if (one) {
    const why: Record<string, string> = {
      customer_named: "お客様が名前を出した、送った物件",
      customer_shared: "お客様が送ってきた物件",
      answered_after_question: "質問の直後にこちらが送った物件",
      single_before_question: "「ここ・この物件」の直前にこちらが送った物件",
    };
    return { names: [one.name], source: one.source, question, reason: why[one.source] ?? "会話から決めた物件" };
  }

  // ③ 指す語の無い質問 → 質問の前のこちらの最後の送付の全部
  const turnText = turn.map((m) => String(m.text ?? "")).join("\n");
  if (turn.some((m) => CUSTOMER_BROUGHT_RE.test(String(m.text ?? "")))) {
    return { names: [], source: null, question, reason: "お客様が送ってきた物件（名前が分からない）の話なので、物件は入れていません" };
  }
  if (msgs.slice(te + 1).some((m) => m.sender === "customer" && CUSTOMER_BROUGHT_RE.test(String(m.text ?? "")))) {
    return { names: [], source: null, question, reason: "質問の後にお客様が別の物件を送ってきたので、どの物件か決めていません" };
  }
  // 質問の前のこちらの最後の送付（物件のある1通を見つけ、その前後に続くこちらの通もまとめる）
  let last = -1;
  for (let i = ts - 1; i >= 0; i--) {
    if (msgs[i].sender === "customer") {
      if (CUSTOMER_BROUGHT_RE.test(String(msgs[i].text ?? ""))) break;
      continue;
    }
    if (staffLabelsOf(msgs[i].text).length) { last = i; break; }
  }
  if (last < 0) return { names: [], source: null, question, reason: "質問の前にこちらが送った物件が見当たらないので、物件は入れていません" };
  const [bs, be] = staffBlockAround(msgs, last, ts);
  const batch = uniqByKey(msgs.slice(bs, be + 1).flatMap((m) => staffLabelsOf(m.text)));
  if (DEMONSTRATIVE_RE.test(turnText)) {
    return { names: [], source: null, question, reason: batch.length > 1 ? `「ここ・この物件」が、送った ${batch.length}件のどれか分からないので、物件は入れていません` : "どの物件の話か決められなかったので、物件は入れていません" };
  }
  if (batch.length > GUARANTOR_BATCH_MAX) {
    return { names: [], source: null, question, reason: `送った ${batch.length}件のどれの話か分からないので、物件は入れていません` };
  }
  return { names: batch, source: "last_send", question, reason: batch.length === 1 ? "質問の前にこちらが送った物件" : `質問の前にこちらが送った ${batch.length}件` };
}
