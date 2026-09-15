// app/lib/phone-call.ts
// 2026-09-15 竹内（H 事例）「公式LINEから電話ボタンを送って電話に繋がるようにしている。電話ボタンここ連動できるのか。
//   AIX で電話するボタンつけて、電話と会話おくれたら良い。電話をかけるピッカーと電話終了後ピッカー。
//   電話終了後ピッカーのテキスト部分に内容をいれると文が生成される形」。
//   - 電話をかける: LINE 公式アカウントの LINEコール（お客様 → 公式アカウントへの無料通話）へ繋がる「電話をかける」ボタンのカードと案内文を送る。
//     管理画面の「通話リクエスト」カードは Messaging API から送れないので、同じ見た目の Flex メッセージのボタンに LINEコールの通話URL を入れる。
//     通話URL は管理画面（設定 → チャット → 通話 → LINEコールを告知）でアカウントごとに発行されるので、aix_settings に登録して使う
//     （通話リクエストに有効期限を設定していると通話URL は使えない＝LINE の仕様）。
//   - 電話終了後: スタッフが電話で話した内容のメモを入れると、お礼＋決まったこと＋こちらがすること／お客様にお願いすることの1通を作る。
//     メモに無い金額・日付・時刻・号室は作らない（〇〇 に伏せて送信前チェックで止める）。
// 依存ゼロ（他の app/lib/* を import しない・画面とサーバーの両方から使う）

/** 会話に残す「電話をかける」ボタンの記録（messages.text）。ブレイン・台帳はこの文字で送付を知る */
export const CALL_BUTTON_MESSAGE_TEXT = "[通話リクエスト] 電話をかけるボタン";

/** aix_settings のキー（アカウントごとの LINEコール通話URL） */
export function callUrlSettingKey(accountKey: string): string {
  return `line_call_url:${accountKey}`;
}

/** LINE の URL か（管理画面の通話URL は line.me / lin.ee） */
export function isValidLineCallUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  if (!/^https:\/\/[^\s]+$/.test(u)) return false;
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === "line.me" || host.endsWith(".line.me") || host === "lin.ee";
  } catch {
    return false;
  }
}

/** 「電話をかける」ボタンのカード（LINE 管理画面の通話リクエストと同じ見た目の Flex メッセージ） */
export function buildCallRequestFlex(callUrl: string): Record<string, unknown> {
  return {
    type: "flex",
    altText: "通話リクエスト：下のボタンをタップすると、このアカウントに電話をかけることができます。",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "📞", size: "3xl", align: "center" },
          { type: "text", text: "通話リクエスト", weight: "bold", size: "lg", color: "#111111" },
          { type: "text", text: "下のボタンをタップすると、このアカウントに電話をかけることができます。", size: "sm", color: "#666666", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "button", style: "primary", color: "#06C755", height: "md", action: { type: "uri", label: "電話をかける", uri: callUrl } },
        ],
      },
    },
  };
}

// ─── お客様が電話で話したいと言っているか（ブレインの場面の証拠 S10） ───
// 実データ（150日・お客様の「電話」を含む発言）: 「ご相談があるのですがお電話では無理でしょうか？」「本日電話いける時間ありますか？」
//   「1度お電話いただけませんか？」「物件の事で聞きたい事がありますのでお手隙の際電話いけますか？」→ スタッフは「お電話大丈夫です😊！！
//   こちらの電話をかけるボタンよりお電話お願い致します！！」「お手隙の際にお電話おかけください！！」。
//   一方「電話番号」「管理会社から電話がありました」「電話は大丈夫です」「電子契約はどなたにお電話したら」は電話の依頼ではない
const PHONE_REQUEST_RE =
  /(?:お?電話|通話|テレビ電話|ビデオ通話)(?:で|でも|にて|は|って|を|の)?[^。\n？?！!]{0,14}?(?:いけ|行け|可能|でき|出来|無理|大丈夫|よろし|いい(?:です|でしょう)|頂け|いただけ|もらえ|貰え|くれ|くださ|話し|はなし|相談|お願い)[^。\n]{0,14}?(?:か[。？?！!\s]*$|か[？?]|[？?]|たい|したく|幸い)/m;
// 実データで外したもの: 他所への電話（「長谷工ライフネットに電話すればいいですか」「ガス、電気にお電話してもよろしいでしょうか」）・
//   書類の欄（「電話はどちらも記入した方がいいでしょうか」）・「ビデオ通話が終わってから郵送する方がよろしい」
const PHONE_NOT_REQUEST_RE =
  /電話番号|番号|から(?:の)?(?:お?電話|着信|連絡)(?:が|も)?(?:あ|有|来|き|入|かか|掛か)|(?:お?電話|着信)(?:が|も)?(?:あり|有り|来|き(?:た|て|ました)|かかって|掛かって|かかってき|入っ|鳴)|電話対応|電話確認|電話(?:に)?出(?:れ|られ)|どなた|誰に|だれに|どこに|どちらに|(?:に|へ)(?:お?電話)(?:すれば|したら|して(?:も)?(?:いい|よろし))|記入|欄|終わ(?:って|った|り次第)|方が(?:よろし|いい)|(?:お?電話|通話)は(?:大丈夫|無くて|なくて|不要|いらない|結構)|電話(?:させて|さして|かけさせて)(?:頂|いただ)|電話(?:します|しますね|かけます)(?:ね)?[。！!]?$/;

/** お客様がこちらと電話で話したい（電話の可否・時間を聞いた・電話を頼んだ）か */
export function customerRequestsPhoneCall(customerTurn: string): boolean {
  const t = (customerTurn ?? "").normalize("NFKC").trim();
  if (!t || /^\s*\[画像\]/.test(t)) return false;
  if (!/電話|通話/.test(t)) return false;
  return t.split(/\n+/).some((line) => PHONE_REQUEST_RE.test(line) && !PHONE_NOT_REQUEST_RE.test(line));
}

// ─── 電話をかける: 案内文（スタッフの実送信） ───
/**
 * 「電話をかける」ボタンと一緒に送る文。
 * お客様から電話の依頼があった時は実送信（H 9/15）「お電話大丈夫です😊！！／こちらの電話をかけるボタンよりお電話お願い致します！！」。
 * こちらから電話を案内する時は用件（任意）を入れる。実送信（いぬい 9/1）「審査無事通すお打ち合わせお電話で5分程で完了しますので…」
 */
export function buildCallRequestText(o: { customerAsked: boolean; customerName: string; purpose?: string }): string {
  const purpose = (o.purpose ?? "").trim().replace(/[。！!]+$/, "");
  const name = o.customerName ? `${o.customerName}さん` : "";
  if (o.customerAsked && !purpose) return "お電話大丈夫です😊！！\nこちらの電話をかけるボタンよりお電話お願い致します！！";
  if (o.customerAsked) return `お電話大丈夫です😊！！\n${purpose}につきましてお電話にてご説明させて頂きます！！\nこちらの電話をかけるボタンよりお電話お願い致します！！`;
  if (purpose) return `${name}\n${purpose}につきましてお電話にてご説明させて頂きます😊！！\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します！！`.replace(/^\n/, "");
  return `${name}\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します😊！！`.replace(/^\n/, "");
}

// ─── 電話終了後: スタッフの実送信（手本・中身は写さない） ───
export const PHONE_FOLLOWUP_STAFF_EXAMPLES: readonly string[] = [
  "お電話有難うございました😊！！\n審査通過する為に保証会社を取り扱う事が出来る独立系の保証会社を中心に家賃8万円以内、リビング12帖洋室6帖のお部屋ピックアップしお送りさせて頂きます！！\n\n出来る限り早くご入居頂くためにも気にいったお部屋審査かけて頂き、保証会社の審査を通過したお部屋ご内覧いただくのを推奨いたします😌！！\n※保証会社通過まではキャンセル料不要となります。\n\n引き続き何卒よろしくお願い致します！！",
  "友也さん\n先ほどはお電話ありがとうございました😊！！\n\n宅配ボックスの件、管理会社に確認でき次第ご連絡させていただきます！！\n\n重要事項説明ですが、明日の15:00からご予約取らせていただきます！！",
  "こちらこそ先ほどはお電話ありがとうございました😊！！\n\n当初のエリア周辺で\n・家賃7万円以内でトイレお風呂別のお部屋\n・家賃なるべく抑えられるユニットバス（洗濯機置き場　内外可）\nの2パターンの初期費用なるべく抑えられるお部屋ピックアップ出来次第お送りさせていただきます😌！！",
  "アヤさん\n先ほどはお電話ありがとうございました😊！！\n\n管理会社に\n705号室の入居可能時期11/1日可能かとエアコンが取り替え行われるか確認出来次第ご連絡させていただきます😌！！",
  "千葉さん\n先ほどはお電話ありがとうございました😊！！\n上記フォーマットと身分証表裏のお写真お送りいただけましたら、プレサンスNEO九条ディアシス402号室のお申込みさせていただきます😌！！",
];

// ─── 電話終了後の文の数字の照合（メモに無い金額・日付・時刻・号室は作らない） ───
/** 数字だけ半角に（文そのものは変えない。NFKC は「！！」まで半角にするので使わない） */
const digitsHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[，]/g, ",").replace(/[．]/g, ".");
/** 単位つきの数字（金額・日付・時刻・号室・帖・%・分・年・階 等） */
const UNIT_NUMBER_RE = /([0-9０-９][0-9０-９,，.．]*)\s*(?=万円|万|円|千円|月|日|時|:|：|号室|号|帖|畳|%|％|ヶ月|か月|カ月|分|年|階|件|名|人|親等|台)/g;

/** 文の単位つきの数字のうち、メモに無いものを 〇〇 に伏せる（伏せた数字を返す） */
export function maskNumbersNotInNotes(text: string, notes: string): { text: string; unmatched: string[] } {
  const noteNums = new Set<string>();
  for (const m of digitsHalf(notes ?? "").matchAll(/\d[\d,.]*/g)) {
    const n = m[0].replace(/[,.]/g, "");
    noteNums.add(n);
    // 「8万」と「80,000」を同じに見る
    if (/^\d+$/.test(n)) { noteNums.add(String(Number(n) * 10000)); if (Number(n) % 10000 === 0) noteNums.add(String(Number(n) / 10000)); }
  }
  const unmatched: string[] = [];
  const out = (text ?? "").replace(UNIT_NUMBER_RE, (whole: string, num: string) => {
    const n = digitsHalf(num).replace(/[,.]/g, "");
    if (noteNums.has(n)) return whole;
    unmatched.push(num);
    return whole.replace(num, "〇〇");
  });
  return { text: out, unmatched };
}
