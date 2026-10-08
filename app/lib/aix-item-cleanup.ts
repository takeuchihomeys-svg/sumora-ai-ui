// app/lib/aix-item-cleanup.ts
// AIX要対応（aix_action_items の pending）の片付けの判定（純関数・DB 依存なし）
//
// 2026-09-27 竹内さん「その方向でおねがい」（[[feedback-aix-item-cleanup]]）:
//   1. 返信の本文で AIX の仕事を済ませた時は自動で「済み」
//      （実例: 申込へ「お申込完了させて頂きます」／物件確認した「既にご契約が決まって」／待ち合わせ「17:30からお電話お待ちしております」
//       ／内覧日調整 日程を本文で返した／見積書 手送りした）
//   2. お客様が止まった・断った時はブレインが取り下げる
//      （実例: 「一旦考えます」「確認してまたご連絡」「他社で見つかった」「インフルで内覧厳しい」）
//   どちらも「誤って済み・取り下げにしない（押すべき AIX を消さない）」を優先して線を引いた。
//   監査: scripts/audit-aix-item-cleanup.ts（押した番＝NEG に当てて誤り 0 の線だけ）
//
// ⚠ 判定の置き場所は2つ（呼び出し側）:
//   1 は送信の直後（send-line-message → completeAixActionItemByStaffText）と、ブレインが登録する直前
//     （syncAixActionItem: スタッフが判断より先に返していた番）。
//   2 は syncAixActionItem（ブレインの新しい判断を読んで取り下げる）。語の一覧でなくブレインの出力（判断の出どころ・保留の型・意図）で決める。
import { classifyStaffTextFacts, findConfirmReportSentence } from "@/app/lib/action-ledger";

export type AixItemRef = { action: string; check_pattern?: string | null };
export type StaffTextFulfillment = { done: true; basis: string; evidence: string } | { done: false };

const sentencesOf = (t: string) => t.split(/\n|(?<=[。！!？?])(?![。！!？?])/).map((s) => s.trim()).filter(Boolean);
const clip = (s: string) => s.replace(/\s+/g, " ").slice(0, 60);
/**
 * 内覧当日の挨拶・送り出しを送った（AIX要対応「内覧挨拶→内覧前」の済み・2026-10-08）。
 * viewing-day-greeting の VIEWING_DAY_GREETED_RE より狭い（「ご連絡お待ちしております」だけでは済みにしない＝出口は誤り0の側）
 */
export const VIEWING_DAY_GREETING_DONE_RE = /お気をつけて|(?:本日|今日)[^\n]{0,30}(?:よろしくお願い|宜しくお願い|ご案内させて|ご案内いたし|ご案内致し|何卒|お待ちしております)|(?:ご内覧|内覧|現地|ご来場)[^\n]{0,15}お待ちしております/;

/** 時刻（17:30・11:00.・18時）。「13日」「7/31」は時刻ではない */
const CLOCK_RE = /[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時(?![間期点])/;
/** 日（18日・9/28・明日・本日・月曜） */
const DAY_RE = /[0-9０-９]{1,2}\s*日|[0-9０-９]{1,2}\s*[\/／]\s*[0-9０-９]{1,2}|本日|明日|明後日|今日|[月火水木金土日]曜/;
/** 問い・打診の形（まだ決まっていない） */
const ASKING_RE = /[？?]|でしょうか|いかが|如何|ご都合|ご教授|ございますか|御座いますか|ご希望のお(?:時間|日)/;
/** 先送り・できない（「改めて別日に」「ご案内出来ない」「追ってご連絡」） */
const DEFER_OR_NO_RE = /改めて|別日|後日|追って|出来ない|できない|出来かね|できかね|不可|お休み|ご連絡(?:させて|いたし|致し|します)/;
/** 受けた・決めた形（「かしこまりました」「〜からお電話お待ちしております」「〜よりご案内させて頂きます」「〜からはよろしくお願いいたします」） */
const ACCEPT_RE = /お待ちして(?:おり|い)ます|よろしくお願い|宜しくお願い|ご案内させて(?:頂|いただ)きます|お伺い(?:させて(?:頂|いただ)き|いたし|致し)ます/;
/** 待ち合わせの場所の印（AIX【待ち合わせ場所】が送る物） */
const PLACE_MARK_RE = /現地|エントランス|待ち合わせ|お待ち合わせ|住所|改札|集合/;
/** 空いている・募集中の報告（この時 AIX【物件確認した】は資料・御見積書を送る仕事が残る） */
const AVAILABLE_RE = /募集中(?!では)|空いて(?:おり|い)ます|空室(?:です|となります|でした)/;
/** 申込を入れ終えた（「お申込完了させて頂きます」「無事お申込み完了しております」）。reply-context の STAFF_APPLY_DONE_RE の「N番手で申込」は宣言にも当たるので使わない */
const APPLY_COMPLETED_RE = /(?:お|ご)?申込(?:み)?[^\n。！!]{0,12}完了(?:し|いたし|させて|して)/;
/** 条件付きの申込の案内（「お気に召されましたらお申込しお部屋抑えさせて頂きます」「お送り頂けましたらお申込み完了」） */
const CONDITIONAL_RE = /お気に召され|ましたら|ませたら|でしたら|次第|頂けますと|いただけますと|(?:頂|いただ)ければ/;

/** 物件確認した: 確認の結果の報告（募集終了・契約済み・専任・条件の回答）が本文にある。空いている報告は資料を送る仕事が残るので済みにしない */
function checkResultReported(text: string): string | null {
  const r = findConfirmReportSentence(text);
  if (r && !AVAILABLE_RE.test(r)) return r;
  // 入居可能日の回答（未桜「最短で11月中旬から下旬でのご入居可能となります」）: 報告の語が無い答えの形。日付の語がある文だけ
  for (const s of sentencesOf(text)) {
    if (/(?:ご)?入居(?:が)?可能(?:となります|です|とのこと)/.test(s) && /[0-9０-９]{1,2}\s*月|旬|以降|日から|日より/.test(s) && !ASKING_RE.test(s) && !AVAILABLE_RE.test(s)) return s;
  }
  return null;
}

/** 時刻を決めた・受けた文（待ち合わせ・内覧の時刻） */
function timeSettledSentence(text: string): string | null {
  for (const s of sentencesOf(text)) {
    if (CLOCK_RE.test(s) && ACCEPT_RE.test(s) && !ASKING_RE.test(s) && !DEFER_OR_NO_RE.test(s)) return s;
  }
  return null;
}

/**
 * 通常の返信（手打ち・AI 下書き）の本文が、pending の AIX要対応の仕事を済ませたか。
 * 済ませたと言える形は AIX の種類ごとに決める（本番の実送信で「押した番＝済みと判定したら誤り」が 0 の線だけ）:
 *   物件確認した   … 確認の結果の報告（行動台帳と同じ findConfirmReportSentence）。空いている報告・資料送付の前段は除く
 *   確認します     … 上の報告、または「確認させて頂きます」の約束（＝確認しますの AIX が送る文そのもの）
 *   見積書送る     … 御見積書を送った（行動台帳 estimate_sent: 本文の成果物・過去形）
 *   待ち合わせ場所 … 場所つきの待ち合わせの案内（台帳 meeting_place_sent＋場所の印・追ってご連絡でない）、当日の時刻の確認・電話の時刻を受けた文
 *   内覧日調整     … 候補の日時を本文で出した（時刻＋ご案内の文）・お客様の日にちを受けた（日＋ご案内させて頂きます）、または上の待ち合わせ
 *   申込へ         … 申込の完了の報告・「並行して審査かけさせて頂きます」（条件付きの案内・「2番手でお申込みさせて頂きます」の宣言は除く）
 *   物件ピックアップ・物件オススメ・その他 … 本文では済みにしない（手打ちの物件の説明の後に AIX を押す番が多い: 本文の「送りました」288通中65通が誤り）
 */
export function staffTextFulfillsAixItem(item: AixItemRef, text: string | null | undefined): StaffTextFulfillment {
  const t = (text ?? "").trim();
  if (!t || /^\[(?:画像|スタンプ|動画|ファイル|位置情報)\]$/.test(t)) return { done: false };
  const facts = () => classifyStaffTextFacts(t, null);
  switch (item.action) {
    case "property_check":
    case "property_check_result": {
      const r = checkResultReported(t);
      return r ? { done: true, basis: "check_reported", evidence: clip(r) } : { done: false };
    }
    case "acknowledge_check": {
      const r = checkResultReported(t);
      if (r) return { done: true, basis: "check_reported", evidence: clip(r) };
      const p = facts().find((e) => e.kind === "confirmation_promised");
      return p ? { done: true, basis: "check_promised", evidence: clip(p.detail.sentence ?? p.evidence) } : { done: false };
    }
    case "estimate_sheet": {
      const e = facts().find((x) => x.kind === "estimate_sent" && x.status === "done");
      return e ? { done: true, basis: "estimate_sent", evidence: clip(e.evidence) } : { done: false };
    }
    case "meeting_place":
    case "viewing_invite": {
      const m = facts().find((x) => x.kind === "meeting_place_sent");
      if (m && PLACE_MARK_RE.test(t) && !/追って|改めて(?:ご)?連絡|場所[^\n。！!]{0,10}ご連絡/.test(t)) return { done: true, basis: "meeting_place_sent", evidence: clip(m.evidence) };
      const s = timeSettledSentence(t);
      // 待ち合わせ場所: 時刻を受けただけでは済みにしない（🧸🤎 7/23「明日15:00よりご案内させて頂きます」→ 1分後に AIX【待ち合わせ場所】で場所を送った）。
      //   済みにするのは当日の時刻の確認（「本日11:00よりお部屋ご案内させて頂きます」＝場所は前に送ってある）と、電話の時刻を受けた文
      //   （yasuki「17:30からお電話お待ちしております」＝待ち合わせではなく電話の約束。ブレインが S5 の信号で待ち合わせにしていた）だけ。
      //   「場所は追ってご連絡」の通は場所を送る仕事が残る（𝒻ₗₒ𝓌ₑᵣ 9/18）
      const placeOwed = /追って|場所[^\n。！!]{0,10}(?:ご連絡|お送り|お伝え)/.test(t);
      const meetingSettled = !!s && !placeOwed && (/本日|今日|この後|これから/.test(s) || /お電話/.test(s));
      if (s && (item.action === "viewing_invite" || meetingSettled)) return { done: true, basis: "time_settled", evidence: clip(s) };
      if (item.action === "meeting_place") return { done: false };
      // 内覧日調整: 候補の日時を出した（「9/28日（月曜）、9/29日（火曜）どちらも18:00からご案内可能ですがご都合いかがでしょうか」）
      for (const x of sentencesOf(t)) {
        if (CONDITIONAL_RE.test(x)) continue; // 「内覧開始しましたらご案内させて頂きます」（𝚂𝚊𝚗𝚊 8/11: この後に内覧日調整を押した）
        if (CLOCK_RE.test(x) && /ご案内|ご内覧|内覧|内見/.test(x) && /可能|出来ます|できます/.test(x) && !DEFER_OR_NO_RE.test(x)) return { done: true, basis: "viewing_slots", evidence: clip(x) };
        // お客様の日にちを受けた（「18日こちらのお部屋もご案内させて頂きます」）
        if (DAY_RE.test(x) && /ご案内させて(?:頂|いただ)きます/.test(x) && !ASKING_RE.test(x) && !DEFER_OR_NO_RE.test(x)) return { done: true, basis: "viewing_day_accepted", evidence: clip(x) };
      }
      return { done: false };
    }
    case "application_push": {
      for (const x of sentencesOf(t)) {
        if (CONDITIONAL_RE.test(x)) continue;
        // 「審査かけさせて頂きます」だけ・「2番手でお申込みさせて頂きます」は申込の書式を送る前にも言う
        //   （♥︎ 9/4・西岡 7/13: この後に申込へを押した）→ 完了の報告と「並行して」（既に申込の情報がある）の時だけ
        if (APPLY_COMPLETED_RE.test(x) || /並行(?:して|で)[^\n。！!]{0,8}審査(?:を)?(?:かけ|掛け)させて(?:頂|いただ)きます/.test(x)) return { done: true, basis: "application_done", evidence: clip(x) };
      }
      return { done: false };
    }
    case "greeting_viewing": {
      // 2026-10-08 内覧当日の朝の挨拶（内覧前）: 内覧挨拶はピッカーが文を入力欄に入れ普通の送信で送る（押下の記録が残らない日があった）→
      //   当日の挨拶・送り出しの文で済み。内覧後（after:*）の要対応はこの線では済みにしない
      if (item.check_pattern && item.check_pattern !== "before") return { done: false };
      const m = t.normalize("NFKC").match(VIEWING_DAY_GREETING_DONE_RE);
      return m ? { done: true, basis: "viewing_day_greeted", evidence: clip(m[0]) } : { done: false };
    }
    default:
      return { done: false };
  }
}

/** ブレインの判断のうち、取り下げの判定に読む項目（suggested_aix_meta の一部） */
export type BrainPauseMeta = {
  action?: string | null;
  decision_source?: string | null;
  hesitancy_pattern?: string | null;
  customer_intent?: string | null;
  first_contact_pickup?: string | null;
  source?: string | null;
};
export type BrainPause = { paused: true; reason: string } | { paused: false };

/** ブレインが「決断を保留している」と読んだ型（検討します・また連絡します・少し待ってほしい） */
const PAUSE_HESITANCY = new Set(["thinking", "callback", "waiting"]);

/**
 * お客様が止まった・断った時に AIX要対応を取り下げるか（ブレインの新しい判断から決める・語の一覧は使わない）。
 * 取り下げる = ブレインの分析自身は AIX を選ばず、決定論の補い（decision_source=signal:*）が AIX を入れた判断で、
 *   かつブレインがお客様を「保留（hesitancy_pattern=thinking/callback/waiting）」または「否定（customer_intent=negative）」と読んだ時。
 * 根拠（9/12〜の本番・ブレインが AIX を出した番 822・scripts/audit-aix-item-cleanup.ts ②）:
 *   この型の番 8（みく・あや「検討してみます」、m◡̈⃝e「確認してまたご連絡」、🐥「インフルで内覧厳しい」、𝑛𝑎「来週に変更可能でしょうか」、
 *   あっぴ「パスでお願いします」、名無し「諦めて他社で探します」、yasuki「17時半頃にまた電話」）で、次のお客様の発言までに同じ AIX を押した 0。
 *   LLM 自身が AIX を選んだ保留の番（慶次「他にあれば送っておいて」→物件ピックアップを押した 等）は取り下げない＝ブレインが次の一手ありと判断している。
 * 除外:
 *   signal:pending_pickup … 未履行のピックアップ宣言（ボールはこちら側・2026-09-23 あっぴ事例の決まり）
 *   rule:*（closed_ack_wait 等） … 締めの後のお礼で「次の物件を送る」を竹内さんが明示した決まり（2026-09-15 朱莉事例）。触らない
 *   初回の条件受領（first_contact_pickup）
 */
export function brainPausedCustomer(meta: BrainPauseMeta | null | undefined): BrainPause {
  if (!meta || meta.source === "cached" || meta.first_contact_pickup) return { paused: false };
  const src = meta.decision_source ?? "";
  if (!src.startsWith("signal:") || src === "signal:pending_pickup") return { paused: false };
  const hes = meta.hesitancy_pattern ?? null;
  if (hes && PAUSE_HESITANCY.has(hes)) return { paused: true, reason: `hesitancy=${hes}・${src}` };
  if (meta.customer_intent === "negative") return { paused: true, reason: `intent=negative・${src}` };
  return { paused: false };
}
