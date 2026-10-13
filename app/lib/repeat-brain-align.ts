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
import { splitSentencesJa, sentenceSimilarity, normalizeSentence, repeatTypeOf, isCourtesyOnly, promiseTopics, type PromiseTopic } from "./draft-repeat";

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
  opts: { customerAddsContent?: boolean; env?: Env } = {},
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
    if (restateOk && WAIT_RE.test(s)) continue;
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
