// app/lib/reply-subscene.ts — 返信の「小場面」（reply-scene の9場面をさらに細かく・純関数・LLM なし）
//
// なぜ（2026-10-08 竹内「こだわりぬけば、そこの部分はAIに完全に任せる事が出来る…🌟どれだけ細かく細分化出来るかが重要」・設計知見 P1）:
//   9場面の一致率は「だいたい合う」で止まる。小場面ごとに 100% に届いたかを見れば、届いた所は AI に任せる候補・届かない所は残りの原因として分けられる。
//   使う所: 監査（scripts/audit-r7-text-diff.ts）・再生の採点（scripts/audit-r7-replay-score.ts）。生成の入口にはまだ使わない（材料の取捨は reply-scene のまま）。
//   入力はお客様の今の番の文と、その前のこちらの最後の文（何への返事か）だけ。
import { resolveReplyScene, type ReplyScene } from "./reply-scene";
import { customerAsksRentLevel } from "./rent-question";

export type SubScene = `${ReplyScene}:${string}`;
const has = (re: RegExp, t: string) => re.test(t);

/** 前のこちらの文の種類（ack・considering の「何への返事か」） */
export function prevStaffKind(prev: string | null | undefined): string {
  const p = String(prev ?? "").normalize("NFKC");
  if (!p.trim()) return "なし";
  if (/見積|初期費用[：:]|割引させて(?:頂|いただ)き/.test(p)) return "見積の後";
  if (/待ち合わせ|現地エントランス|ご案内させて(?:頂|いただ)きます|ご案内可能|お部屋ご案内/.test(p)) return "内覧の段取りの後";
  if (/本日(?:は)?(?:お時間|ご内覧お越し)/.test(p)) return "内覧の後";
  if (/如何でしょうか|オススメ出?来る|おすすめ出?来る|ピックアップさせて(?:頂|いただ)きました|募集に出ました|ご査収/.test(p)) return "物件を送った後";
  if (/募集中|募集終了|確認させて(?:頂|いただ)きました|ましたところ/.test(p)) return "確認の結果の後";
  if (/(?:確認|ピックアップ|お送り|作成|交渉)[^\n]{0,20}(?:させて(?:頂|いただ)きます|出来次第|でき次第)/.test(p)) return "約束の後";
  if (/[？?]|でしょうか|ください/.test(p)) return "こちらの問いの後";
  return "その他";
}

/**
 * 物件（URL・ポータルの画像）を送ってきただけで、問い・依頼の言葉が無い番か。
 * 2026-10-07 7巡目: この番でスタッフ（人の手打ち 90日・報告と下書きそのままを除く）が「かしこまりました」で始めたのは 37番中2番（5%）。
 *   「お部屋お送り頂きありがとうございます」26〜56%・本題（お送り頂きました〇〇の募集状況確認させて頂きます）が残り。AI の下書きは かしこまりました 38〜52%
 */
export function isPropertyShareNoAsk(customerText: string): boolean {
  const t = String(customerText ?? "").normalize("NFKC");
  if (resolveReplyScene({ customerText }).scene !== "property_share") return false;
  if (/[？?]|ますか|でしょうか|教えて|知りたい|お願い|頼|見積|費用|いくら|空いて|空き|詳細|どう(?:です|でしょう)|ほしい|欲しい|下さい|ください/.test(t)) return false;
  // 物件の行（URL・by SUUMO・ポータルの名前・画像の書き起こし）を除いて、お客様の言葉が残れば「送っただけ」ではない
  //   （最後の Claude の確かめ b3bae304「カードブラックなので…厳しいかと💦＋URL3本」に当たり、懸念への返事を落とした・10/08）
  const words = t.split("\n").filter((l) => !/https?:\/\/|^\s*by\s|^\s*【|^\s*\[画像\]|LIFULL|SUUMO|HOME'?S|階\s*$|^\s*$/.test(l)).join("").replace(/[\p{Extended_Pictographic}\u{FE0F}\s!！。、]/gu, "");
  if (words.replace(/こちら|これ|ここ|も|です|ます|よろしく|宜しく|すみません|すいません/g, "").length > 6) return false;
  return true;
}

/**
 * 内覧当日の連絡（遅れる・向かっている・もうすぐ着く・付き添い）だけで、問いの無い番か。
 * 2026-10-07 7巡目（見張りの外れ W34・W45）: 人の手打ち（365日・内覧の前に返した 17通）は「かしこまりました！！⏎お気をつけてお越しください😌！！」が 12通。
 *   残り5通は鍵・回る順番などスタッフだけが知る段取り・「30分遅れますがいけますか」の問い（＝ここでは当てない）。
 *   台帳の「内覧が本日」に頼ると、台帳が内覧を読めない時（AIX の記録が無い・再生）に注記が出なかったので、お客様の文だけで決める
 */
export function isViewingDayNotice(customerText: string): boolean {
  const t = String(customerText ?? "").normalize("NFKC");
  if (!/遅れ(?:る|ます|そう|て)|遅刻|ギリギリ(?:に|で)?(?:着|到着)|向かって(?:い|ま)|向かいます|着きます|もうすぐ着|今から(?:出|向)|付き添い|同伴/.test(t)) return false;
  if (/[？?]|ますか|でしょうか|ですか|いけますか|大丈夫ですか|可能/.test(t)) return false;
  if (/キャンセル|変更|延期|別日|無理|行けな/.test(t)) return false;
  // 「返信遅れてすいません」「ご連絡遅れて」は返事の遅れのお詫び（365日の線で2番が誤当たり）
  if (/(?:返信|返事|ご?連絡)(?:が|の)?遅|遅くなって|契約|申込|申し込/.test(t) && !/(?:着|到着|向か)/.test(t)) return false;
  return true;
}
export const VIEWING_DAY_NOTICE_REPLY = "かしこまりました！！\nお気をつけてお越しください😌！！";

export function subSceneOf(i: { customerText: string; prevStaffText?: string | null; scene?: ReplyScene }): SubScene {
  const t = String(i.customerText ?? "").normalize("NFKC");
  const scene = i.scene ?? resolveReplyScene({ customerText: i.customerText }).scene;
  const prev = prevStaffKind(i.prevStaffText);
  const multi = /(?:2|3|4|二|三|両方|それぞれ|ふた)(?:つ|件|部屋|物件)|ここと|こちらと|どちらも/.test(t);
  const hasProp = /https?:\/\/|\[画像\]|物件名|号室|ハイツ|マンション|レジデンス|コーポ|メゾン|荘/.test(t);
  switch (scene) {
    case "ack":
      return `ack:${/^\s*(?:\[スタンプ\]\s*)+$/.test(t) ? "スタンプ" : prev}`;
    case "considering":
      return `considering:${has(/連絡|返信|折り返|送ります|決めて/, t) ? "また連絡します" : "検討します"}・${prev}`;
    case "viewing":
      if (has(/着きました|着いた|到着|エントランス(?:の中)?に(?:い|居)/, t)) return "viewing:当日・着いた";
      if (has(/遅れ|遅刻|ギリギリ|向かって|向かいます|着きます|もうすぐ着|付き添い|同伴/, t)) return "viewing:当日・遅れ・向かう・付き添い";
      if (has(/キャンセル|中止|延期|変更|ずらし/, t)) return "viewing:日程の変更・取りやめ";
      if (has(/[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}|[月火水木金土日]曜|土日|週末|平日|明日|明後日|今日|本日|今週|来週|[0-9]{1,2}\s*時/, t)) return `viewing:内覧の希望・日時あり`;
      if (has(/内覧|内見|見学/, t)) return has(/[？?]|ますか|でしょうか/, t) ? "viewing:内覧の可否・中身の質問" : "viewing:内覧の希望・日時なし";
      return "viewing:その他";
    case "cost":
      if (has(/支払|分割|カード|振込|いつまでに/, t)) return "cost:支払い方";
      return `cost:${multi ? "複数の物件" : hasProp ? "物件を添えて" : prev === "物件を送った後" || prev === "確認の結果の後" ? "送った物件の費用" : prev === "見積の後" ? "見積の後の質問" : "物件の指定なし"}`;
    case "question":
      if (customerAsksRentLevel(t)) return "question:家賃の相場";
      if (has(/審査|保証(?:会社|人)|期間|流れ|書類|入居まで|名義/, t)) return "question:手続き・審査";
      if (has(/写真|室内|画像|動画/, t)) return "question:写真";
      if (has(/駐車|駐輪|ペット|エアコン|畳|設備|洗濯|ネット|宅配|オートロック|広さ|帖|階/, t)) return "question:物件の設備・中身";
      if (has(/空いて|空き|募集|まだ(?:あり|ある)|埋ま/, t)) return "question:空きの確認";
      if (has(/治安|エリア|駅|近く|周辺|どこ/, t)) return "question:エリア";
      if (has(/ってことですか|ということ|ですよね|ですかね/, t)) return "question:確かめ";
      return "question:その他";
    case "property_share": {
      const n = (t.match(/https?:\/\//g) ?? []).length + (t.match(/\[画像\]/g) ?? []).length;
      const ask = has(/[？?]|ますか|でしょうか|教えて|知りたい|お願い/, t);
      const cost = has(/初期費用|費用|見積|いくら/, t);
      return `property_share:${n >= 2 || multi ? "複数" : "1件"}・${cost ? "費用も" : ask ? "問いつき" : "送っただけ"}`;
    }
    case "conditions":
      if (has(/①|お部屋探しご条件|お部屋お探し中/, i.customerText) || /(?:^|\s)1\s*[.．、)）]/.test(t)) return `conditions:条件のフォーム・${prev === "なし" ? "初回" : "続き"}`;
      if (has(/広げ|上げ|下げ|変更|追加|変え|やっぱり|もう少し|他に|ほかに|もっと/, t)) return "conditions:条件の変更・追加";
      return "conditions:条件の言葉";
    case "apply":
      if (has(/書類|免許|マイナンバー|保険証|本人確認|源泉|給与/, t)) return "apply:書類";
      if (has(/保証(?:会社|人)|連帯|緊急連絡/, t)) return "apply:保証";
      if (has(/審査/, t)) return "apply:審査";
      if (has(/申込|申し込み|契約|押さえ|抑え/, t)) return "apply:申込の意思・手続き";
      return "apply:その他";
    default:
      if (has(/すみません|申し訳|ごめん/, t)) return "other:謝り・伝え";
      if (has(/紹介|友達|友人/, t)) return "other:紹介";
      if (has(/こんにちは|こんばんは|おはよう|追加させて|はじめまして/, t)) return "other:挨拶・友だち追加";
      return `other:その他・${prev}`;
  }
}
