// app/lib/property-send-match.ts
// AIX【物件ピックアップした】の「会話を合わせる」（純関数・DB 依存なし）。
// 2026-09-15 竹内（カイナ事例）「物件ピックアップに会話を合わせるボタンをつける。そこで生成される文は会話を合わせた状態で生成されるようにする」:
//   実データ（60日）: 物件ピックアップの AIX 送信 261通のうち 237通（91%）をスタッフが直していた。直し方は
//   ①希望条件の羅列を会話の言い方（「広めのお部屋」「大きめ」）に縮める ②この会話で約束したこと・経緯の1〜2文を足す
//   （「お気に召されたお部屋代理契約可能か全て交渉させて頂きます」「無事ご入居間に合いますようにサポートさせて頂きます」
//   「募集ございませんでしたので条件広げてお送りしております」「こちら2部屋となります」）。固定の型（AIX 生成）は残し、
//   「会話を合わせる」はこの2点を会話の直近の糸口から作る。糸口の候補は決定論で拾い、LLM には候補にある事柄だけを使わせる

/** スタッフが会話に合わせて送った実文（言い回しの手本。別のお客様の話なので中身は写さない） */
export const PROPERTY_SEND_MATCH_STAFF_EXAMPLES: readonly string[] = [
  "〇〇さんお世話になっております！！\n\n浪速区・中央区全域から広めのお部屋で〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお気に召されたお部屋代理契約可能か全て交渉させて頂きます！！\nお手隙の際にご査収ください😌！！",
  "〇〇さんお世話になっております！！\n無事ご入居間に合いますようにサポートさせて頂きます！！\n現在募集が出ているお部屋で〇〇さんのご条件に近いお部屋全てピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！",
  "〇〇さんお世話になっております！！\n\n桜川周辺から1LDK・家賃9万円以内のご条件で〇〇さんにオススメ出来るお部屋探させていただきましたが、募集ございませんでしたので条件広げてお部屋お送りさせていただきました！！\n\nお手隙の際にご査収ください😌！！",
  "〇〇さん\n\n家賃帯と敷金礼金のご条件広げさせていただき2件オススメできるお部屋ございましたのでお送りさせていただきました😊！！\n\nお手隙の際にご査収ください😌！！",
  "〇〇さんお世話になっております！！\n\n阪急梅田〜十三・南方のエリアから\n家賃管理費込6万円・バス・トイレ別・室内洗濯機置場ありのお部屋ピックアップさせて頂きました！！\nこちら2部屋となります！\nお手隙の際にご査収ください😌！！",
  "〇〇さんお世話になっております！！\n\n島之内・心斎橋・日本橋周辺のエリア全域から〇〇さんにオススメできる審査通過しやすい築浅の1LDKのお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！",
];

export type ThreadMessage = { sender: string; text?: string | null };
export type PropertySendThreads = {
  /** お客様が気にしていること・依頼（会話の言葉のまま） */
  customer: string[];
  /** そのうち「続いている事情」（代理契約・審査・ペット・駐車場 等＝今回送る物件にも関わる。該当すれば「この物件でどうするか」の一文を書く） */
  requirements: string[];
  /** こちらが約束したこと（交渉・確認・サポート・条件を広げる 等） */
  staff: string[];
};

/** 続いている事情（今回の物件にも関わる。スタッフの実送信: 代理契約→「お気に召されたお部屋代理契約可能か全て交渉させて頂きます」） */
const REQUIREMENT_RE = /代理契約|名義|保証人|保証会社|審査|ペット|猫|犬|駐車場|バイク|生活保護|外国|楽器|障害|高齢|同棲|2人|二人|お子|子供|子ども/;
/** こちらの前の発言にある挨拶・お礼（内覧のお礼は内覧後の挨拶で送信済み。ピックアップの文で繰り返さない） */
const REPEATED_THANKS_LINE_RE = /^(?:[^\n]{0,12}さん[、,]?\s*)?(?:本日|昨日|先日)(?:は)?(?:お時間|ご来店|ご内覧)(?:を)?(?:頂|いただ)き(?:まして)?(?:誠に)?ありがとうございました[！!。]*\s*$/;
export function stripRepeatedThanksLines(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split("\n").filter((l) => { if (REPEATED_THANKS_LINE_RE.test(l.trim())) { removed++; return false; } return true; });
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: removed ? out : text, removed };
}

/** 前回の物件送付（この送付より前）の文。ここより後の発言だけを糸口にする */
const PREVIOUS_PICKUP_SENT_RE = /ピックアップ(?:し|して)?(?:お送り)?させて(?:頂|いただ)きました|募集に(?:で|出)ました|お送りさせて(?:頂|いただ)きました|ご査収ください/;
/** お客様の気にしていること（この語がある発言を糸口にする） */
const CUSTOMER_TOPIC_RE = /代理契約|名義|保証人|保証会社|審査|入居(?:日|時期|まで|が)|急ぎ|早め|間に合|ペット|猫|犬|駐車場|バイク|駐輪|初期費用|家賃|広め|広い|大きめ|狭|静か|日当たり|楽器|在宅|テレワーク|2人|二人|同棲|お子|子供|子ども|赤ちゃん|出産|学生|外国|生活保護|障害|高齢|退去|引越|引っ越|階|エレベーター|オートロック|洗面|風呂|トイレ|収納|条件/;
/** こちらの約束・経緯（未来形。「ピックアップしてお送りします」の定型は糸口にしない） */
const STAFF_PROMISE_RE = /(?:交渉|確認|サポート|相談|お調べ|お探し|手配|お伝え|ご連絡)(?:させて(?:頂|いただ)き|いたし|致し)(?:ます|ますので)|広げ(?:て|させて(?:頂|いただ)き)|優先(?:して|的に)/;
const STAFF_PICKUP_PROMISE_RE = /ピックアップ(?:し|して)?(?:お送り)?させて(?:頂|いただ)きます/;
const MEDIA_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]/;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * 直近の会話から「会話を合わせる」の糸口を拾う（前回の物件送付より後・最大 maxEach 件ずつ・新しい順）。
 * 拾うだけで、使うかは生成側（候補に無い事柄は書かせない）
 */
export function extractPropertySendThreads(messages: readonly ThreadMessage[], opts: { maxEach?: number; lookback?: number } = {}): PropertySendThreads {
  const maxEach = opts.maxEach ?? 4;
  const lookback = opts.lookback ?? 16;
  const recent = messages.slice(-lookback);
  // 前回の物件送付より後だけ（無ければ全部）
  let start = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.sender === "staff" && PREVIOUS_PICKUP_SENT_RE.test(m.text ?? "")) { start = i + 1; break; }
  }
  const slice = recent.slice(start);
  const customer: string[] = [];
  const staff: string[] = [];
  for (const m of slice) {
    const t = (m.text ?? "").replace(/\r/g, "").trim();
    if (!t || MEDIA_RE.test(t)) continue;
    if (m.sender === "customer") {
      // 発言を文ごとに見て、気にしている語のある文だけ
      const sentences = t.split(/\n|(?<=[。！!？?])/).map((s) => s.trim()).filter(Boolean);
      for (const s of sentences) if (CUSTOMER_TOPIC_RE.test(s)) customer.push(clip(s, 80));
    } else if (m.sender === "staff") {
      const sentences = t.split(/\n|(?<=[。！!？?])/).map((s) => s.trim()).filter(Boolean);
      // 定型の「ピックアップしてお送りします」だけの文は糸口にしない（「エリア広げさせていただき、…ピックアップしお送りします」は経緯なので拾う）
      for (const s of sentences) if (STAFF_PROMISE_RE.test(s) && !(STAFF_PICKUP_PROMISE_RE.test(s) && !/広げ|優先|交渉|サポート/.test(s))) staff.push(clip(s, 80));
    }
  }
  const uniq = (a: string[]) => [...new Set(a)];
  const cust = uniq(customer).slice(-maxEach).reverse();
  // 続いている事情は前回の送付より前の発言からも拾う（代理契約は会話の最初から続く事情）
  const reqAll = uniq(recent.flatMap((m) => {
    if (m.sender !== "customer") return [];
    const t = (m.text ?? "").replace(/\r/g, "").trim();
    if (!t || MEDIA_RE.test(t)) return [];
    return t.split(/\n|(?<=[。！!？?])/).map((s) => s.trim()).filter((s) => s && REQUIREMENT_RE.test(s)).map((s) => clip(s, 80));
  }));
  return { customer: cust, requirements: reqAll.slice(-maxEach).reverse(), staff: uniq(staff).slice(-maxEach).reverse() };
}

/** LLM に渡す糸口のブロック（無ければ空＝③は書かない） */
export function buildPropertySendThreadsBlock(th: PropertySendThreads): string {
  if (th.customer.length === 0 && th.staff.length === 0 && th.requirements.length === 0) {
    return "【会話の糸口（候補）】無し → ③（会話に合わせた文）は書かず、②の後に⑤で締める";
  }
  const lines: string[] = ["【会話の糸口（候補・新しい順）— ③はこの中の事柄だけから選ぶ（1〜2文・無関係なものは使わない）】"];
  if (th.requirements.length) {
    lines.push("＜お客様の続いている事情（今回送る物件にも関わる）→ 該当すれば「お気に召されたお部屋〇〇可能か全て交渉（確認）させて頂きます！！」のように、今回の物件でこちらがどうするかを1文で＞");
    lines.push(...th.requirements.map((s) => `・${s}`));
  }
  if (th.staff.length) { lines.push("＜こちらが約束したこと・経緯（言い方をそのまま活かす）＞"); lines.push(...th.staff.map((s) => `・${s}`)); }
  const wishes = th.customer.filter((s) => !th.requirements.includes(s));
  if (wishes.length) { lines.push("＜お客様の希望・気にしていること（②の言い方に使う）＞"); lines.push(...wishes.map((s) => `・${s}`)); }
  return lines.join("\n");
}

/** 内覧誘導・日時の行を落とす（内覧提案 OFF の時。日時は AIX【内覧日調整】で送る） */
const INVITE_LINE_RE = /ご案内させて(?:頂|いただ)きます|ご都合よろしいお日にち|ご内覧(?:如何|いかが)|ご案内可能です|直近ですと|^\s*\d{1,2}\/\d{1,2}[（(]/;
export function stripViewingInviteLines(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split("\n").filter((l) => { if (INVITE_LINE_RE.test(l)) { removed++; return false; } return true; });
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: removed ? out : text, removed };
}
