// app/lib/property-send-now.ts
// AIX【物件ピックアップした】の「会話を合わせる」で、**今この送付が会話のどこに当たるか**を時系列から決める（純関数・DB 依存なし）。
//
// 2026-10-06 ⑰ 竹内「会話を合わせるボタンしたらちゃんと会話に合わせた物件を出す形とする。…あかりさんの場合変な文がでた。
//   …どの物件のことについて話しているのか、時系列や最新のやり取りなどもふまえて正確に判断できるように」
//
// ■ あかりさんの実物（10/04・名前は伏せる）
//   前回の送付（10/01 物件確認した）の後: お客様「別れることになって」「私一人になるかもです」「なんかいい部屋ありますかね」
//   「ここの部屋に似た感じでちっさくて大丈夫です！」→ スタッフ「オススメできるお部屋ピックアップさせていただきます」
//   → 物件ピックアップ（会話を合わせる・送り方は履歴からの既定で「新着」）。
//   下書き「新着で〇〇さんにオススメできるお部屋募集に出ましたのでピックアップさせて頂きました！！」
//   スタッフ「〇〇さんお一人暮らしされる際にオススメ出来るご条件のお部屋西淀川区全域からピックアップさせて頂きました！！」
//   原因: ①送り方の既定（前に送った記録 → 新着）がそのまま「新着で…募集に出ました」の決まった言い方を指示した（お客様の依頼に応えた送付なのに）
//         ②会話の糸口は「気にしている語」の正規表現で拾う物だけで、「一人になる」「別れる」「似た感じ」「ちっさく」は拾われず、
//           最新のやり取り（条件が変わった・依頼された）が生成に届いていなかった（③は「糸口無し → 書かない」）
//
// ■ ここで決めること
//   ・前回の物件の送付より後の、お客様の発言（全部・新しい順・最大 maxCustomer）とこちらの約束（ピックアップします 等）
//   ・お客様が物件を頼んだか（requested）・条件の変化を言ったか（conditionChange）
//   ・送り方の枠: 「新着」は、前回の送付の後にお客様の依頼・条件の変化が**無い**時だけ（あれば「ご依頼に応えた送付」）
//   線は scripts/audit-pickup-send-frame.ts（AIX 物件ピックアップの下書き↔スタッフの送信・60日）で決める

export type NowMsg = { sender: string; text?: string | null; created_at?: string | null };

/** こちらが物件を送った文（前回の送付の線） */
const PROPERTY_SENT_RE = /ピックアップ(?:し|して)?(?:お送り)?させて(?:頂|いただ)きました|募集に(?:で|出)ました|お送り頂きました物件の中で|現在募集中となります|募集終了しているお部屋|お手隙の際にご査収ください/;
/** お客様が物件を頼んだ・探してほしい（依頼） */
const CUSTOMER_REQUEST_RE = /(?:いい|良い|よい|他の|ほかの|別の|新しい)(?:お)?(?:部屋|物件)|(?:部屋|物件)(?:が|は)?(?:あり|有り|ない|無い)(?:ます|ません)?か|探して|さがして|送って|ピックアップ|似た(?:感じ|ような|部屋|物件)|みたいな(?:部屋|物件)|紹介して|教えて(?:ほしい|欲しい|ください)|見つけて/;
/** お客様が条件の変化を言った（世帯・予算・広さ・エリアの言い直し） */
const CONDITION_CHANGE_RE = /一人(?:暮らし|になる|で住|の場合)?|ひとり(?:暮らし|になる|で)?|1人(?:暮らし|になる|で)|二人(?:で|入居)|ふたり|2人(?:で|入居)|別れ|同棲(?:を|は)?(?:やめ|解消|なし)|(?:小さく|狭く|ちっさく|ちいさく|コンパクト)(?:て|で)?(?:も)?(?:大丈夫|いい|良い|OK)|広め|予算(?:を|は)?(?:上げ|下げ|変)|家賃(?:を|は)?(?:上げ|下げ)|エリア(?:を|は)?(?:変|広げ)|(?:条件|希望)(?:を|が|は)?(?:変|変わ)/;
/** こちらの約束（これからピックアップ・お探しする）と、条件の変更の確認 */
const STAFF_PICKUP_PROMISE_RE = /ピックアップ(?:し|して)?(?:お送り)?させて(?:頂|いただ)きます|お探しさせて(?:頂|いただ)きます|お部屋(?:探し|さがし)(?:を)?させて(?:頂|いただ)きます|変更される条件|ご条件(?:を)?(?:改めて|教えて)/;
const MEDIA_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]/;

export type SendNow = {
  /** 前回の送付より後のお客様の発言（新しい順） */
  customerLatest: string[];
  /** 前回の送付より後のこちらの約束（新しい順） */
  staffPromises: string[];
  requested: boolean;
  conditionChange: string[];
  /** 前回の送付が見つかったか */
  hasPreviousSend: boolean;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** 会話（古い順）→ 今の送付が当たる場面 */
export function readSendNow(messages: readonly NowMsg[], opts: { maxCustomer?: number; lookback?: number } = {}): SendNow {
  const maxCustomer = opts.maxCustomer ?? 8;
  const recent = messages.slice(-(opts.lookback ?? 40));
  let start = 0, hasPreviousSend = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.sender !== "customer" && PROPERTY_SENT_RE.test(m.text ?? "")) { start = i + 1; hasPreviousSend = true; break; }
  }
  const after = recent.slice(start);
  const customerLatest: string[] = [];
  const staffPromises: string[] = [];
  const conditionChange: string[] = [];
  let requested = false;
  for (const m of after) {
    const t = String(m.text ?? "").replace(/\r/g, "").trim();
    if (!t || MEDIA_RE.test(t) || /https?:\/\//.test(t)) continue;
    if (m.sender === "customer") {
      for (const s of t.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
        customerLatest.push(clip(s, 60));
        if (CUSTOMER_REQUEST_RE.test(s)) requested = true;
        // 質問（「ふたり入居可ですか？」）は条件の変化ではない（あかりさん: 変化の前の物件の質問）
        if (CONDITION_CHANGE_RE.test(s) && !/[？?]\s*$|(?:です|ます|でしょう)か/.test(s)) conditionChange.push(clip(s, 60));
      }
    } else {
      for (const s of t.split(/\n+|(?<=[！!。])/).map((x) => x.trim()).filter(Boolean)) {
        if (STAFF_PICKUP_PROMISE_RE.test(s)) { staffPromises.push(clip(s, 60)); requested = true; }
      }
    }
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    customerLatest: uniq(customerLatest).slice(-maxCustomer).reverse(),
    staffPromises: uniq(staffPromises).slice(-3).reverse(),
    requested,
    conditionChange: uniq(conditionChange).slice(-4).reverse(),
    hasPreviousSend,
  };
}

/**
 * 送り方の枠。画面の既定（前に送った記録があれば「新着」）を、時系列で直す:
 *   前回の送付の後にお客様の依頼・条件の変化・こちらのピックアップの約束があれば、新着ではなく「ご依頼に応えた送付」
 */
export function effectiveSendFrame(sendMode: string | null | undefined, now: SendNow): "new_arrival" | "requested" | "as_is" {
  if (sendMode !== "new_arrival") return "as_is";
  return now.requested || now.conditionChange.length > 0 ? "requested" : "new_arrival";
}

/** LLM に渡す「今の場面」のブロック（会話を合わせる・物件ピックアップ） */
export function buildSendNowBlock(now: SendNow): string {
  if (!now.customerLatest.length && !now.staffPromises.length) return "";
  const lines: string[] = ["【今の場面（前回の物件の送付より後のやり取り・新しい順）— ②と③はこの場面に合わせる】"];
  if (now.conditionChange.length) {
    lines.push("＜お客様が言った条件の変化（登録の希望条件より新しい・こちらを優先。古い条件のうちこの変化と食い違う物は書かない）＞");
    lines.push(...now.conditionChange.map((s) => `・${s}`));
  }
  if (now.staffPromises.length) {
    lines.push("＜こちらが約束したこと（今回の送付はこの約束を果たす通）＞");
    lines.push(...now.staffPromises.map((s) => `・${s}`));
  }
  if (now.customerLatest.length) {
    lines.push("＜お客様の最新の発言＞");
    lines.push(...now.customerLatest.map((s) => `・${s}`));
  }
  return lines.join("\n");
}
