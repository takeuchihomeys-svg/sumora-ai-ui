// app/lib/reply-style-r11.ts — 11巡目（2026-10-08 竹内「返信の文を細かく詰めて完全な文に」・書き方の基準は竹内さん＝書き手A）
//   竹内さんの手打ちの返信（messages.staff_writer='takeuchi'・120日 653通・scripts/audit-r11-takeuchi-style.ts）で形が決まっている所を入口（場面の注記）で揃える。
//
//   質問への答えの書き出し: 竹内さん 質問の番 95通 = 答えから 57%・かしこまりました 21%（依頼を引き受ける・確認の約束の時）・はい 20%（はい/いいえの問い）。
//     本番の下書き（直した物）は かしこまりました 56〜71%（question:その他 71%）→ 入口の注記で「答えから書く」。出口では消さない（竹内さんも 2割は書く）
//   入れなかった出口（scripts/audit-r11-style-exits.ts で測って止めた・10/08）:
//     ①開口語の後の空行を詰める（竹内さん 短いお礼 6%・質問 3%・内覧 5%）・②行末の絵文字の後に「！！」（竹内さん 99%）は、
//     竹内さんの手打ち 787通で変わるのは 0.9%・1.0% だが、本番の下書き 275組で変わる 13組の差の型は 減る2・増える4・完全一致 0→0＝今の下書きはすでに揃っていて効き目が無い
// 戻す: REPLY_STYLE_R11=off。YUMA の再生の版（R11_ENV_LIST）で同じ名前
import type { ReplyScene } from "./reply-scene";

export function replyStyleR11Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REPLY_STYLE_R11 ?? "").toLowerCase() !== "off";
}

// ─── 繰り返さない（r12 の調査④・設計知見 c4b4faf2 を広げる）────────────────
//   直前2通のこちらの文（AIX を含む）にある約束・誘い・予定・条件の言い直しを下書きに書かない。旧は直前の1通の「待ちの形」だけ見ていた。
//   お客様が受けだけ（短いお礼・了承）の時は 2〜3行（竹内さん お礼・了承への返し 中央値3文・2〜3行）。戻す REPLY_NO_REPEAT_R11=off
const REPEAT_SENT_RE = /させて(?:頂|いただ)きます|(?:出|で)次第|次第ご連絡|如何でしょうか|いかがでしょうか|ご案内|お待ち合わせ|ご内覧|周辺全域から|ピックアップ|お申込み?で|お部屋(?:を)?抑え|お待ちしております/;
export function noRepeatEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REPLY_NO_REPEAT_R11 ?? "").toLowerCase() !== "off";
}
/** 直前2通のこちらの文から、約束・誘い・予定・条件の文を取り出す（最大4つ・各60字まで・物件カード🌟・URL・金額の行は除く） */
export function repeatCandidates(lastStaffTexts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of lastStaffTexts.slice(-2)) {
    for (const line of String(t ?? "").split("\n")) {
      for (const s of line.split(/(?<=[！!。])(?=[^！!])/)) {
        const x = s.trim();
        // 定型の締め（全力でサポート・何卒・お気軽に・ご査収・お手隙・扉の1文「お気に召されましたら」）は繰り返す方が普通（previous-send-note の実測・r11b で扉の1文を落とした fecda03f）＝候補にしない
        //   扉の1文「お気に召されましたら…」・「お手隙の際に」も同じ（YUMA の再生 r11b で扉の1文を落とした fecda03f・ご確認ください を落とした d46290ff）
        if (x.length < 8 || /https?:\/\/|🌟|【|^住所|全力でサポート|何卒|お気軽に|ご査収|お手隙|お気に召されましたら/.test(x) || !REPEAT_SENT_RE.test(x)) continue;
        const short = x.length > 60 ? `${x.slice(0, 58)}…` : x;
        if (!out.includes(short)) out.push(short);
      }
    }
  }
  return out.slice(-4);
}
export function noRepeatNote(lastStaffTexts: readonly string[], scene: ReplyScene | null | undefined, enabled = noRepeatEnabled()): string {
  // 受けだけ・検討中の番だけ（YUMA の再生 r11b: 費用の誤解への答えの番に出すと「はい😊！！」だけになった f193d13d）
  if (!enabled || (scene !== "ack" && scene !== "considering")) return "";
  const c = repeatCandidates(lastStaffTexts);
  if (!c.length) return "";
  const ack = scene === "ack";
  return `- 🔁 直前2通でお伝え済み（同じ約束・誘い・予定・条件を書き直さない＝竹内さんは言い直さない）: ${c.map((x) => `「${x}」`).join(" ")}`
    + (ack ? "\n  → お客様は受けだけ。返信は2〜3行（開口語＋受けの1文＋必要なら締め）。まだ果たしていない約束の「〜出来次第お送りさせて頂きます」1文だけは書いてよい" : "");
}

// ─── 在庫の状態（r12 の調査⑥）: 物件を1度も送っていない番では「新着で〜出次第お送り」を書かない（竹内さん 90日で 43番中1）。戻す REPLY_NO_NEWARRIVAL_R11=off
export function noNewArrivalNote(propertiesSentCount: number | null | undefined, env: Record<string, string | undefined> = process.env): string {
  if ((env.REPLY_NO_NEWARRIVAL_R11 ?? "").toLowerCase() === "off") return "";
  if (propertiesSentCount == null || propertiesSentCount > 0) return "";
  return "- 📦 この会話ではまだ物件を1件もお送りしていない＝「新着で〜出次第お送り」「引き続き新着で」は書かない（竹内さん 90日で 43番中1）。これから探す番は「〇〇周辺全域から…ピックアップしお送りさせて頂きます」";
}

/** 場面の書き方の注記（入口）。質問の番だけ */
export function sceneStyleNote(scene: ReplyScene | null | undefined, enabled = true): string {
  if (!enabled || scene !== "question") return "";
  return `\n【✍️ 質問への答えの書き出し（竹内さんの手打ち 95通）】答えられる質問は答えそのものから書く（57%）。はい/いいえで答えられる問いは「はい！！」から（20%）。「かしこまりました」で始めるのは、お客様の依頼を引き受ける時・確認の約束をする時だけ（21%）。開口語の後に空行は入れない。\n`;
}
