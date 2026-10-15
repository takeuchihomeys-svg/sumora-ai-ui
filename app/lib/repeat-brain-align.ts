// app/lib/repeat-brain-align.ts — 「もう言った事」の繰り返しをブレイン基準にそろえる（純関数・DB/LLM なし・2026-10-13）
//
// 竹内さん 2026-10-13「同じ事を何度も繰り返してしまう所。ブレイン基準に考えたらその文がおかしいと気づくのではないか」
//   質の物差し＝竹内さんの実送信（staff_writer=takeuchi の手打ち）。scripts/audit-draft-repeat.ts（--takeuchi-baseline）の数:
//   お客様が受けだけ（お礼・了承）の番で直前1通にこちらの約束がある時の竹内さんの返事 78番（60日・届け物の送付は除く）:
//     待ちの形で言い直す 27（「ピックアップ出来次第お送りさせて頂きますので、何卒…」）・受けだけ 17・新しい中身 17・同じ約束を言い直す 10（ほぼ内覧の日時の確かめ）・日付の締め 7
//     前が言い切りのピックアップの約束（「〜ピックアップさせて頂きます」）→ 待ちの形で言い直す 8/10
//     前が待ちの形の確認・募集状況の約束（「確認出来次第ご連絡」）→ 受けだけが多い（設計知見 c9368e68: 90日で手打ちの 82%）
//   下書き（30日 line_reply 368番）で前のこちらの文と同じ文（近さ 0.72 以上）を書いた文: 実送信も言った 64・削った 21。
//     削った物の型: 受けだけの番の確認・連絡の約束の言い直し（4f9d58e8・f71dfdea・8cad64b0）・審査のサポートの言い直し（e8b790af）・内覧の誘いの言い直し（04941ddc）
//   正しい言い直し（竹内さんも書いた）: 条件を変えた後のピックアップの約束（条件を足して言い直す 87〜91%）・待ちの形の約束・日付の締め・内覧当日の「本日〇時ご案内」
//
// ここは2つ:
//   ① alreadySaidAllowance … 生成の本質の「もう言った事」に添える1行（竹内さんが言い直す形だけ許す）
//   ② contractAlreadySaidRepeat … 最終チェックの決定論の段（ブレインの「もう言った事」を言い直した文を書き直しに渡す。言い直してよい形は外す）
// 戻す: REPEAT_BRAIN_ALIGN=off（①②とも出さない＝旧の「繰り返さない」の1行だけ・最終チェックは今まで通り LLM の DOUBLE_DECLARATION だけ）
// テスト: app/lib/__tests__/repeat-brain-align.test.ts
import { splitSentencesJa, sentenceSimilarity, normalizeSentence, repeatTypeOf, isCourtesyOnly, promiseTopics, isAckOnlyTurn, type PromiseTopic } from "./draft-repeat";

type Env = Record<string, string | undefined>;
export function repeatBrainAlignEnabled(env: Env = process.env): boolean {
  return (env.REPEAT_BRAIN_ALIGN ?? "").trim().toLowerCase() !== "off";
}

/** 生成の本質の「もう言った事」に添える1行（竹内さんの実送信で線） */
export function alreadySaidAllowance(env: Env = process.env): string {
  if (!repeatBrainAlignEnabled(env)) return "";
  return "  （竹内さんの形: まだ果たしていないピックアップ・撮影の約束を受けだけの番で「〜出来次第お送りさせて頂きますので、何卒…」の待ちの形の1文にするのは言い直しに当たらない＝竹内さん 8/10。お客様が条件を変えた・足した時に新しい条件で約束し直すのも可。それ以外＝確認・連絡・見積・審査・サポートの約束、内覧の誘い、同じ説明は書き直さない）";
}

/**
 * 生成の決定論の「最優先」ノート（約束の言い直しの禁止・復唱の指示: pickupPromiseAckNote・estimatePromiseAckNote・promiseEchoNote・
 * waitFormAckNote・aixDoneAckNote）を、ブレインの本質がある番は材料に下げる（見出しの「最優先・〜より上位」と「絶対」を外す）。
 *   棚卸しの表6（10/13）: 中身を正規表現で決めて最優先で指示＝ブレインの「もう言った事」より強い。P1 0593a0aa「ブレインとぶつかる独立の判断を直す」。
 *   中身（何を言い直さない・何を1文にする）はそのまま。本質が無い番（夜の見送り・古い判断）は今まで通り。
 */
export function demoteRepeatNote(note: string, brainContract: boolean, env: Env = process.env): string {
  if (!note || !brainContract || !repeatBrainAlignEnabled(env)) return note;
  return note
    // 見出しは1行。括弧の中に入れ子の【】がある（estimatePromiseAckNote「（最優先・【💰 見積書カバー文】ゲートより上位）」）ので、行の最後の「）】」まで取る
    .replace(/【([^【】（\n]*?)（[^\n]*最優先[^\n]*）】/, "【📎 材料: $1（中身は【🧭 この番の本質】の「もう言った事」が上）】")
    .replace(/絶対に/g, "").replace(/絶対禁止/g, "書かない");
}

/**
 * 本質がブレインの番で、受けだけの番の直前の約束を復唱させず受けだけにするか（2026-10-13 レビュー・設計知見 c9368e68 の型）。
 *   確認・連絡・見積・審査の約束＝受けだけ（竹内さんの手打ち60日の受けだけの番: mgmt 0/9・vacancy 0/10・estimate 0/4・screening 0/5）。
 *   ピックアップ・撮影は竹内さんの形（待ちの形の1文）のまま＝false
 */
export function ackEchoToWait(promiseLabel: string, brainContract: boolean, env: Env = process.env): boolean {
  if (!brainContract || !repeatBrainAlignEnabled(env)) return false;
  return !/ピックアップ|撮影|内覧/.test(promiseLabel ?? "");
}

/**
 * 2026-10-13（作る人・確認の約束への了承の1文）: 確認・連絡・見積・審査の約束への了承だけの番でも、待ちの形の1文
 *   「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」は竹内さんの形（言い直しに当たらない）。
 *   数え（scripts/audit-draft-repeat.ts --takeuchi-baseline・60日・竹内さんの手打ち・直前1通が確認・連絡・見積・審査の約束の受けだけの番 16）:
 *     待ちの形（同じ確認・連絡の中身）3・受けだけ 4・日付の締め 1・新しい中身 5（申込のフォーム・結果の報告）・待ちの形（別の中身＝探す）3
 *     ＝受けへの返事（新しい中身を除く 8）のうち待ちの形の1文 3・受けだけ 4＝どちらも竹内さんの形（前の約束が待ちの形でも 2/5 は待ちの形をもう一度）。
 *   → 最終チェックの決定論（contractAlreadySaidRepeat）は、竹内さんの短い待ちの形の1文を「言い直し」と指摘しない（既定 on・60日の下書き・実送信で指摘の数は変わらない＝誤り 0 のまま）。
 *   ⚠ 生成の材料（confirmAckMaterial で「受けだけ／待ちの形の1文のどちらも可」と書く）は試しで悪くなった番があったので既定 off:
 *     再生（scripts/yuma-repeat-replay.ts・竹内さんの番 6・2回ずつ・DeepSeek）: 竹内さんが待ちの形の番 fb8ab8d5 は待ちの形の1文が入った（ただし言い切りの約束も残る）／
 *     竹内さんが受けだけの番 d3a56a97 は「9月30日に…ご連絡させて頂きますので」と日付の約束を言い直した（前 1/2 → 後 0/2）。ACK_CONFIRM_WAIT_LINE=on で試せる
 *   戻す: ACK_CONFIRM_WAIT_DETECTOR=off（決定論も旧の指摘）
 */
export function confirmAckWaitLineEnabled(env: Env = process.env): boolean {
  return repeatBrainAlignEnabled(env) && (env.ACK_CONFIRM_WAIT_LINE ?? "").trim().toLowerCase() === "on";
}
export function confirmAckWaitDetectorEnabled(env: Env = process.env): boolean {
  return repeatBrainAlignEnabled(env) && (env.ACK_CONFIRM_WAIT_DETECTOR ?? "").trim().toLowerCase() !== "off";
}
/** 確認・連絡・見積・審査の約束への了承だけの番の材料の1行（generate-reply の echoToWaitNote） */
export function confirmAckMaterial(promiseLabel: string, env: Env = process.env): string {
  const head = `\n【🔁 直前の約束はお伝え済み（材料・中身は【🧭 この番の本質】の「もう言った事」が上）】直前にこちらが「${promiseLabel}」を約束済みで、お客様は了承しただけ。`;
  return confirmAckWaitLineEnabled(env)
    ? `${head}同じ約束を言い切りで書き直さない（「〜確認させて頂きます」をもう一度書かない・何を・いつ・誰からを並べ直さない・結果を先取りしない）。竹内さんの形はどちらか: 受けだけ（「はい😊！！」＋「気になる点出てきましたら何時でもお気軽にご連絡ください！！」か「何卒よろしくお願い致します！！」）／待ちの形の1文（「はい！！」＋「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」・竹内さん 3/7）。`
    : `${head}竹内さんは受けへの返事で確認・連絡・見積・審査の約束を言い直さない＝同じ約束を書き直さず、受けだけ（「はい😊！！」＋「気になる点出てきましたら何時でもお気軽にご連絡ください！！」か「何卒よろしくお願い致します！！」）。`;
}

/**
 * ピックアップの約束の後の受けだけの番の材料（pickupPromiseAckNote の中身・ブレインの本質がある番）。
 *   旧「ピックアップ宣言を絶対にもう一度生成しない・2行以内・例: はい😊！！何卒よろしくお願い致します😌！！」は竹内さんの実送信と逆:
 *   前が言い切りのピックアップの約束→受けだけの番の竹内さんの返事は 待ちの形の1文 8/10（「ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」）。
 *   言い切りの宣言・条件の並べ直し・初期費用の文の言い直しは書かない（それは今まで通り）。
 */
export function pickupAckMaterial(env: Env = process.env): string | null {
  if (!repeatBrainAlignEnabled(env)) return null;
  return `\n【📎 材料: ピックアップの約束はお伝え済み（中身は【🧭 この番の本質】が上）】
直前にこちらが物件のピックアップを約束済みで、お客様はその了承・お礼だけ。
→ 条件の並べ直し・「〜ピックアップしてお送りさせて頂きます」の言い切りの宣言・初期費用の文はもう一度書かない（二重の宣言）
→ 竹内さんの形: 前の約束が言い切りなら待ちの形の1文「ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」（8/10）。前の約束がもう待ちの形（〜出来次第）なら受けだけ（「はい😊！！」＋何卒）でよい（待ちの形の1文を添えても可）
→ 実際の物件の送付はこの後 AIX「物件ピックアップした」で行う（返信で物件・条件の話を広げない）`;
}

/**
 * まだ果たしていないピックアップの約束がある番（推奨アクション property_send・pending_pickup）の1行。
 *   旧「再宣言は書かず、受けだけの2行以内」（9/23・全スタッフの実送信＝返信なし・物件カードを含む率）は、竹内さんが打った返事の形と逆。
 *   竹内さんの決定 3696fe20（10/08）「了承だけは『はい😊！！』＋（約束 or お気軽に）＋何卒」の3行と、前の約束が言い切りなら待ちの形の1文（8/10）に合わせる。
 *   9/23 竹内さん「同じようなことなんかいも入れない」＝もう待ちの形で伝えた約束を3回目に言わない、は残す。
 */
export function pendingPickupAckLine(env: Env = process.env): string | null {
  if (!repeatBrainAlignEnabled(env)) return null;
  return "- ⚠ 直前のピックアップの約束がまだ果たされていない（物件は AIX で送る）。お客様が受けだけなら竹内さんの形の3行: 「はい😊！！」＋（前の約束が言い切り「〜ピックアップさせて頂きます」なら待ちの形の1文「ピックアップ出来次第お送りさせて頂きますので」／もう待ちの形で伝えていれば「気になる点出てきましたら何時でもお気軽にご連絡ください！！」）＋「何卒よろしくお願い致します😌！！」。条件の並べ直し・言い切りの再宣言・待ちの形の3回目は書かない";
}

const WAIT_RE = /次第/;const DATE_CLOSE_RE = /(?:明日|本日|当日|明後日|[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{1,2}\/[0-9０-９]{1,2}).{0,8}(?:何卒|よろしく|宜しく|ご案内させて)/;
/** 言い直してよい（待ちの形にしてよい）約束の中身＝探す・撮影（竹内さんは受けだけの番でも待ちの形で1文言う） */
const RESTATE_OK_TOPICS: ReadonlySet<PromiseTopic> = new Set(["pickup"]);
/** 竹内さんの確認の約束への了承の待ちの形の短い1文（中身を並べ直さない・「ので、何卒」で結ぶ）。normalizeSentence の後の形に当てる */
const CONFIRM_WAIT_LINE_RE = /^(?:明日|本日|明後日)?(?:すぐに?)?(?:確認|ご返事|ご返答|進捗|結果)[^ぁ-んァ-ヶ一-龥]{0,2}(?:出来|でき|あり|が出)?次第(?:すぐに?)?ご連絡させて(?:頂|いただ)きますので何卒/;
const PHOTO_RE = /撮影/;

export type AlreadySaidHit = { sentence: string; ref: string; sim: number; suggestion: string };

/**
 * 下書きの文がブレインの「もう言った事」を言い直しているか（言い直してよい形は外す）。
 * - 近さ 0.72 以上（2文字の組の Dice・絵文字・名前・開口語を除いた形）
 * - 外す: 挨拶・定型の締め・礼だけの文／日付の締め（「明日何卒よろしく」）・内覧当日の「本日〇時ご案内」／
 *         ピックアップ・撮影の約束の待ちの形（〜出来次第）／お客様が条件を変えた番（customerAddsContent）のピックアップの約束（新しい条件で約束し直す）
 */
export function contractAlreadySaidRepeat(
  draft: string,
  alreadySaid: ReadonlyArray<string>,
  opts: { customerAddsContent?: boolean; env?: Env; ackForm?: AckForm | null } = {},
): AlreadySaidHit | null {
  if (!repeatBrainAlignEnabled(opts.env) || !alreadySaid.length) return null;
  const refs = alreadySaid.map((s) => s.replace(/…$/, "")).filter((s) => normalizeSentence(s).length >= 8);
  for (const s of splitSentencesJa(draft)) {
    if (/https?:\/\/|🌟|^住所|^【/.test(s) || normalizeSentence(s).length < 8) continue;
    const ty = repeatTypeOf(s);
    if (ty === "定型の締め" || ty === "挨拶" || isCourtesyOnly(s)) continue;
    if (DATE_CLOSE_RE.test(s)) continue;
    let best: { ref: string; sim: number } | null = null;
    for (const r of refs) {
      // alreadySaid は60字で切ってある（…）＝切った長さにそろえて比べる
      const sim = Math.max(sentenceSimilarity(s, r), r.length >= 50 ? sentenceSimilarity(s.slice(0, r.length + 4), r) : 0);
      if (sim >= 0.72 && (!best || sim > best.sim)) best = { ref: r, sim };
    }
    if (!best) continue;
    const topics = promiseTopics(s);
    const restateOk = topics.some((t) => RESTATE_OK_TOPICS.has(t)) || PHOTO_RE.test(s);
    // 待ちの形の1文は竹内さんの形（外す）。
    //   ⚠ 10/13 試して止めた: 「もう言った約束が既に待ちの形なら3回目として見る」（YUMA4 の試し 9f6b948a）は竹内さんの実送信にも当たる（39c5b353・4a387eac＝竹内さんも待ちの形を重ねる）＝誤り 0 にならない
    if (restateOk && WAIT_RE.test(s) && opts.ackForm !== "receive_only") continue;
    // 10/13: 確認・連絡・見積・審査の約束の待ちの形の短い1文（「確認出来次第ご連絡させて頂きますので、何卒…」）は竹内さんの形（受けだけの番 3/7・前が待ちの形でも 2/5）。
    //   中身（何を・誰から・いつ）を並べ直した文（4f9d58e8「火曜日に無事1番手で…確認させて頂き、確認出来次第」・8cad64b0「管理会社担当者よりご返事あり次第」）は竹内さんも消した＝今まで通り指摘
    // 10/13（ブレインに任せる）: ブレインが ack_form を決めた番はそれに従う（receive_only＝待ちの形の1文も言い直し・wait_line＝短い待ちの形の1文は可）
    const compactWait = CONFIRM_WAIT_LINE_RE.test(normalizeSentence(s).replace(/^はい/, ""));
    if (compactWait && (opts.ackForm === "wait_line" || (opts.ackForm == null && confirmAckWaitDetectorEnabled(opts.env)))) continue;
    // お客様が中身（新しい物件・条件・質問）を送った番の約束は、新しい対象への約束（竹内さんも同じ文で約束し直す: 募集状況の確認 5/5・条件を足したピックアップ 87〜91%）＝約束でない文（サポートの宣言・説明）だけ見る
    //   サポートの宣言（審査面も無事通過出来ますよう…）も中身のある番は竹内さんも言い直す事がある（7f36cba8 書いた・e8b790af 書かない＝線が引けない）＝見ない
    //   ⚠ 10/13 試して止めた: 「前の文をほぼそのまま（近さ 0.9 以上）写した約束は見る」（YUMA4 の試し 5ed01085）は竹内さんの実送信にも当たる（cc1a78bd・44e89917・3cbfb5f2）
    if (opts.customerAddsContent && (topics.length || /確認|ご連絡|お送り|お届け|サポート/.test(s))) continue;
    return {
      sentence: s.slice(0, 80), ref: best.ref, sim: best.sim,
      suggestion: restateOk
        ? "ブレインの「もう言った事」と同じ約束の言い直し。まだ果たしていなければ「〜出来次第お送りさせて頂きます」の待ちの形の1文にするか、この文を消す"
        : "ブレインの「もう言った事」と同じ文（竹内さんは書き直さない）。この文を消し、お客様の今の発言への受け・答えだけにする",
    };
  }
  return null;
}

// ─── 2026-10-13 竹内さんの決定「確認の約束への了承の返事（受けだけか、待ちの形の1文を足すか）はブレインに任せる」───
//   答えは書かず、竹内さんの使い分けの材料をブレインに渡し、ブレインの本質（turn_contract.ack_form）に決めさせる。
//   生成（本質の行・確認の受けの注記・往復のセル CP_ACK_WAIT・橋渡しの3注記）と最終チェック（contractAlreadySaidRepeat）はこの1つの値に従う
//   （「書け」と「書くな」を並べない・設計知見 c9368e68）。日付・言い切りの約束の言い直しはブレインが決めた時以外は出さない。
//   竹内さんの手打ち（75日・届け物を除く・了承だけの番）:
//     探す（ピックアップ）の約束が言い切り → 待ちの形の1文 7・受けだけ 0・言い切りの言い直し 1／探すが待ちの形 → 待ちの形 2・受けだけ 2
//     確認・連絡・見積・審査の約束 → 受けだけ 5・待ちの形 3（言い切り 受け 2・待ち 1／待ちの形 受け 3・待ち 2）
//     前の約束に日付が入っている（「9月30日に改めてご連絡」d3a56a97）→ 受けだけ／お客様が急ぎ・日付・質問を足した → 待ちの形が増える
//   2026-10-15 竹内さんの決定で既定 on（ACK_FORM_BRAIN=off で旧＝ブレインに決めさせない）。on で材料・ack_form・生成と最終チェックの従い方が全部入る
export type AckForm = "receive_only" | "wait_line";
/** 竹内さんの短い待ちの形の1文か（確認の「確認出来次第ご連絡させて頂きますので、何卒」・探すの「ピックアップ出来次第お送りさせて頂きますので」） */
export function isCompactWaitLine(s: string): boolean {
  const n = normalizeSentence(s).replace(/^はい/, "");
  return CONFIRM_WAIT_LINE_RE.test(n) || /^(?:ピックアップ|お部屋|物件)?(?:出来|でき)次第お送りさせて頂きますので何卒/.test(n);
}
export function ackFormBrainEnabled(env: Env = process.env): boolean {
  return repeatBrainAlignEnabled(env) && (env.ACK_FORM_BRAIN ?? "").trim().toLowerCase() !== "off";
}
export function normalizeAckForm(v: unknown): AckForm | null {
  return v === "receive_only" || v === "wait_line" ? v : null;
}
const ACK_DATE_RE = /(?:明日|本日|明後日|週明け|月末|[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{1,2}\/[0-9０-９]{1,2}|[月火水木金土日]曜)/;
const CONFIRM_FAMILY_T: ReadonlySet<PromiseTopic> = new Set(["vacancy", "mgmt", "estimate", "screening", "contact"]);
export type AckFormFacts = {
  family: "探す" | "確認・連絡・見積・審査";
  form: "言い切り" | "待ちの形" | "日付つき";
  promise: string;
  customer: "了承だけ" | "質問あり" | "急ぎ・日付あり" | "その他の中身";
  minutes: number | null;
};
/** 前のこちらの約束と今のお客様の発言から材料を読む（無い時 null）。messages は古い順 */
export function ackFormFacts(messagesOldestFirst: ReadonlyArray<{ sender: string; text: string | null; created_at?: string | null }>): AckFormFacts | null {
  const arr = messagesOldestFirst;
  let i = arr.length - 1;
  const cust: string[] = [];
  while (i >= 0 && arr[i].sender === "customer") { cust.unshift(String(arr[i].text ?? "")); i--; }
  if (!cust.length || i < 0) return null;
  const prev = arr[i];
  const ss = splitSentencesJa(String(prev.text ?? ""));
  let promise: string | null = null; let topic: PromiseTopic | null = null;
  for (let k = ss.length - 1; k >= 0 && !promise; k--) { const t = promiseTopics(ss[k]); if (t.length) { promise = ss[k]; topic = t.find((x) => x !== "contact") ?? t[0]; } }
  if (!promise || !topic) return null;
  const family = topic === "pickup" ? "探す" : CONFIRM_FAMILY_T.has(topic) ? "確認・連絡・見積・審査" : null;
  if (!family) return null;
  const form = ACK_DATE_RE.test(promise) ? "日付つき" : /次第/.test(promise) ? "待ちの形" : "言い切り";
  const joined = cust.join("\n");
  const customer = isAckOnlyTurn(cust) ? "了承だけ" : /[?？]|ですか|ますか|でしょうか/.test(joined) ? "質問あり" : /急|早め|今日中|明日|[0-9０-９]+[\/月日時]/.test(joined) ? "急ぎ・日付あり" : "その他の中身";
  const firstCust = arr[i + 1];
  const minutes = prev.created_at && firstCust?.created_at ? Math.max(0, Math.round((Date.parse(firstCust.created_at) - Date.parse(prev.created_at)) / 60000)) : null;
  return { family, form, promise: promise.slice(0, 60), customer, minutes };
}
/** ブレインのプロンプトに入れる材料の1行（答えは書かない）。お客様の発言に中身が多い番は出さない */
export function ackFormMaterialLine(f: AckFormFacts | null, env: Env = process.env): string {
  if (!f || !ackFormBrainEnabled(env) || f.customer === "その他の中身") return "";
  const ago = f.minutes == null ? "" : f.minutes < 60 ? `・${f.minutes}分前` : `・約${Math.round(f.minutes / 60)}時間前`;
  return `【前の約束への了承（材料・turn_contract の ack_form を決める）】前のこちらの約束「${f.promise}」（${f.family}・${f.form}${ago}）／お客様の今の発言: ${f.customer}。
竹内さんの実送信（75日・了承だけの番）: 探すの約束が言い切り→待ちの形の1文 7・受けだけ 0／探すが待ちの形→待ちの形 2・受けだけ 2／確認・連絡・見積・審査→受けだけ 5・待ちの形 3（割れる）／前の約束に日付が入っている→受けだけ（日付を言い直さない）／お客様が急ぎ・日付・質問を足した→待ちの形が増える。
→ ack_form に "receive_only"（受けだけ＝約束・日付を言い直さない）か "wait_line"（「〜出来次第ご連絡（お送り）させて頂きますので、何卒…」の短い1文だけ・何を・いつ・日付を並べ直さない・言い切りの約束を書かない）を入れる。`;
}
/** 生成の本質の行（ブレインが ack_form を決めた番） */
export function ackFormContractLine(f: AckForm | null | undefined): string {
  if (f === "receive_only") return "- 前の約束への了承の返事（ブレインの判断）: 受けだけ（約束・日付・確認の中身を言い直さない・待ちの形の1文も書かない）。";
  if (f === "wait_line") return "- 前の約束への了承の返事（ブレインの判断）: 待ちの形の短い1文だけ（「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」／探す約束なら「ピックアップ出来次第お送りさせて頂きますので、何卒…」）。何を・いつ・誰から・日付を並べ直さない・言い切りの約束（「〜確認させて頂きます」）を書かない。";
  return "";
}
/** 確認の約束への了承の材料（generate-reply の echoToWaitNote）をブレインの ack_form に合わせる */
export function confirmAckMaterialFor(promiseLabel: string, f: AckForm | null | undefined, env: Env = process.env): string {
  if (!f) return confirmAckMaterial(promiseLabel, env);
  const head = `\n【🔁 直前の約束はお伝え済み（材料・中身は【🧭 この番の本質】が上）】直前にこちらが「${promiseLabel}」を約束済みで、お客様は了承しただけ。`;
  return f === "wait_line"
    ? `${head}ブレインの判断は待ちの形の短い1文（「はい！！」＋「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」）。言い切りの約束・何を・いつ・日付を並べ直さない。`
    : `${head}ブレインの判断は受けだけ（「はい😊！！」＋「気になる点出てきましたら何時でもお気軽にご連絡ください！！」か「何卒よろしくお願い致します！！」）。約束・日付を言い直さない。`;
}
/** ピックアップの約束の後の受けの材料（pickupAckMaterial）をブレインの ack_form に合わせる */
export function pickupAckMaterialFor(f: AckForm): string {
  return `\n【📎 材料: ピックアップの約束はお伝え済み（中身は【🧭 この番の本質】が上）】
直前にこちらが物件のピックアップを約束済みで、お客様はその了承・お礼だけ。
→ 条件の並べ直し・「〜ピックアップしてお送りさせて頂きます」の言い切りの宣言・初期費用の文はもう一度書かない（二重の宣言）
→ ブレインの判断: ${f === "wait_line" ? "待ちの形の1文「ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」" : "受けだけ（「はい😊！！」＋何卒・待ちの形の1文も書かない）"}
→ 実際の物件の送付はこの後 AIX「物件ピックアップした」で行う（返信で物件・条件の話を広げない）`;
}
// ─── 2026-10-15 作る人（zenryoku-ack-1015）: ブレインが決めた ack_form を出口（生成の指示）まで届ける ───
//   試し（scripts/yuma-ack-form-follow-test.ts・竹内さんの了承の番 23・DeepSeek）: ブレインが ack_form を決めても、生成の指示の別の場所が
//   「次のアクション文を1つ添える（場面の型）」「必ず含める内容（約束の進行）」「最後は行動宣言で終える（往復文脈・姿勢）」「WE DO 宣言（必須）」を
//   そのまま渡していた＝書けと書くなが並び、受けだけの判断の番で待ちの形・約束の言い直しが出た。
//   了承だけの番でブレインが ack_form を決めた時は、これらの場所を同じ1つの値（ackFormShapeLine）にそろえる。戻す ACK_FORM_FOLLOW=off
export function ackFormFollowEnabled(env: Env = process.env): boolean {
  return (env.ACK_FORM_FOLLOW ?? "").trim().toLowerCase() !== "off";
}
/** 了承の返事の形の1行（場面の型・往復文脈の役割・avoid の「代わりに」に同じ値を渡す） */
export function ackFormShapeLine(f: AckForm): string {
  return f === "wait_line"
    ? "前の約束への了承の返事（ブレインの判断＝待ちの形の短い1文）: 開口語「はい！！」→「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」（探す約束なら「ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」）だけ。何を・いつ・日付・条件を並べ直さない・言い切りの約束（〜させて頂きます！！）を書かない。20〜70字"
    : "前の約束への了承の返事（ブレインの判断＝受けだけ）: 開口語「はい😊！！」→締め「何卒よろしくお願い致します！！」（または「気になる点出てきましたら何時でもお気軽にご連絡ください！！」）だけ。約束・確認・ピックアップ・日付・待ちの形（〜次第・〜出来ましたら）の文は書かない。10〜60字";
}
/** 姿勢の締めの行（了承の返事の番） */
export function ackFormCloserLine(f: AckForm): string {
  return f === "wait_line"
    ? "- 🔚 締め（了承の返事・ブレインの判断）: 待ちの形の1文の「…ので、何卒よろしくお願い致します😌！！」で終える（行動宣言・サポート継続宣言を足さない）"
    : "- 🔚 締め（了承の返事・ブレインの判断）: 「何卒よろしくお願い致します！！」で終える（行動宣言・待ちの形・サポート継続宣言を足さない）";
}
const ACK_DROP_TOPIC_RE = /確認|見積|ピックアップ|探|ご連絡|お送り|送付|進捗|募集状況|作成|進め|約束|割引|新着/;
/** 了承の返事の番で「必ず含める内容」から外す項目（前の約束の中身の言い直しになる物） */
export function ackFormDropTopic(topic: string): boolean {
  return ACK_DROP_TOPIC_RE.test(topic ?? "");
}

/** 往復のセル CP_ACK_WAIT（受けだけ）を、ブレインが wait_line と決めた番だけ待ちの形の1文のセルにする（同じ場面に「書け」と「書くな」を並べない） */
export function ackFormCell<T extends { id: string; direction: string; mustNot: string[]; example?: string }>(rule: T | null, f: AckForm | null | undefined): T | null {
  if (!rule || rule.id !== "CP_ACK_WAIT" || f !== "wait_line") return rule;
  return {
    ...rule,
    direction: "直前にこちらが確認・連絡を約束していて、お客様はそれに了承しただけ。ブレインの判断で待ちの形の短い1文を返す: 開口語「はい！！」→「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」。何を・いつ・誰から・日付を並べ直さない・言い切りの約束（「〜確認させて頂きます」）を書かない・まだ送っていない物に「ご査収」を書かない。20〜60字",
    mustNot: ["言い切りの約束（〜確認させて頂きます）の言い直し", "何を・いつ・日付の並べ直し", "ご査収（まだ送っていない物）", "約束に無い業務語彙（撮影・内覧日程）"],
    example: "はい！！\n確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！",
  };
}
