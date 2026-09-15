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
  /** こちらが約束したこと・お伝えした経緯（交渉・確認・サポート・条件を広げる・審査否決のご連絡 等） */
  staff: string[];
  /** お客様の期限・困りごと（退去を伝えてしまった・更新しない・急な事情）→ 挨拶の次に「無事ご入居間に合いますようにサポートさせて頂きます！！」 */
  deadline?: string[];
};

/** 続いている事情（今回の物件にも関わる。スタッフの実送信: 代理契約→「お気に召されたお部屋代理契約可能か全て交渉させて頂きます」）
 *  2026-09-15（慶次事例）: 裸の「名義」は「友人に名義を貸した」（信用の話）を代理契約と取り違えたので契約の名義に絞る */
const REQUIREMENT_RE = /代理契約|契約(?:者)?名義|名義人|名義変更|名義で(?:の)?契約|保証人|保証会社|審査|ペット|猫|犬|駐車場|バイク|生活保護|外国|楽器|障害|高齢|同棲|2人|二人|お子|子供|子ども/;
/** 申込フォームの項目・「無し」の答え（「・ペット飼育有無 無し」「・駐車場利用の有無（台数）0」）は事情ではない（慶次事例: ペット・駐車場の一文を足す所だった） */
const NEGATED_ITEM_RE = /有無|(?:無し|なし|ナシ|不要|ありません|いません|ございません|御座いません)[。！!]*$|[\s：:]0台?[。！!]*$/;
/**
 * お客様の期限・困りごと（2026-09-15 竹内・慶次事例）: 審査否決の後に「10月末で今の家を退去する旨を管理会社に言ってしまったので困りました」→
 * スタッフ実送信「無事ご入居間に合いますようにサポートさせて頂きます！！」を挨拶の次に置いた（it_0「急なご事情とのことですので、9月中のご入居を最優先に…」も同じ型）。
 * 物件の退去予定を聞く質問（「203はいつ退去予定ですか」）は拾わない＝自分の退去を伝えた・決めた形だけ
 */
const DEADLINE_RE = /退去(?:する|の)?旨|退去(?:の)?(?:連絡|通知)(?:を|し)|退去(?:を|日を)?(?:伝え|言っ|申し出|決め)|退去(?:日|期限)が決ま|解約(?:通知|の連絡|を伝え|を言っ|を申し)|更新(?:せず|しない|しません)|(?:今の家|今の部屋|今の住まい|実家)を(?:出|追い出)|追い出され|急遽|間に合(?:わ|う|い)/;
export const DEADLINE_SUPPORT_LINE = "無事ご入居間に合いますようにサポートさせて頂きます！！";
/** こちらの前の発言にある挨拶・お礼（内覧のお礼は内覧後の挨拶で送信済み。ピックアップの文で繰り返さない） */
const REPEATED_THANKS_LINE_RE = /^(?:[^\n]{0,12}さん[、,]?\s*)?(?:本日|昨日|先日)(?:は)?(?:お時間|ご来店|ご内覧)(?:を)?(?:頂|いただ)き(?:まして)?(?:誠に)?ありがとうございました[！!。]*\s*$/;
/**
 * ピックアップ行を過去形にそろえる（物件と一緒に送る文なので「ピックアップさせて頂きました」が正。
 * 本番確認: 直前のこちらの「…ピックアップしお送りさせていただきます」を写して未来形になった回が3回中2回）
 */
export function fixPickupTense(text: string): { text: string; fixed: number } {
  let fixed = 0;
  const out = text.replace(/ピックアップ(?:し|して)?(?:お送り)?させて(頂|いただ)きます/g, (_m, k: string) => { fixed++; return `ピックアップさせて${k}きました`; })
    .replace(/(お部屋|物件)(?:を)?お送りさせて(頂|いただ)きます(?=[！!😊😌]|$)/gm, (_m, o: string, k: string) => { fixed++; return `${o}お送りさせて${k}きました`; });
  return { text: fixed ? out : text, fixed };
}

/**
 * 続いている事情への一文を決定論で差し込む（LLM が糸口の候補にあっても書かない時の保険。初期費用を抑える一文と同じ考え:
 * 名前だけ 0/3 → 文例入り 1/3 → 差し込み 3/3）。本文に既にその話題があれば足さない。締めの行（ご査収）の前に置く
 */
const REQUIREMENT_LINES: ReadonlyArray<{ re: RegExp; topic: RegExp; line: string }> = [
  { re: /代理契約|契約(?:者)?名義|名義人|名義変更|名義で(?:の)?契約/, topic: /代理契約|名義/, line: "お気に召されたお部屋代理契約可能か全て交渉させて頂きます！！" },
  { re: /ペット|猫|犬/, topic: /ペット|猫|犬|飼育/, line: "お気に召されたお部屋ペット飼育可能か全て確認させて頂きます！！" },
  { re: /駐車場|バイク/, topic: /駐車場|バイク|駐輪/, line: "お気に召されたお部屋駐車場の空き状況も確認させて頂きます！！" },
  { re: /保証人|保証会社|審査/, topic: /保証人|保証会社|審査/, line: "お気に召されたお部屋の保証会社・審査面も確認させて頂きます！！" },
];
export function ensureRequirementLine(text: string, requirements: readonly string[]): { text: string; added: string | null } {
  if (requirements.length === 0) return { text, added: null };
  const joined = requirements.join("\n");
  const rule = REQUIREMENT_LINES.find((r) => r.re.test(joined));
  if (!rule || rule.topic.test(text)) return { text, added: null };
  const lines = text.split("\n");
  // 締め（ご査収）の行の前に、空行を挟んで置く
  let idx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (/ご査収|ご確認ください/.test(lines[i])) { idx = i; break; }
  const before = lines.slice(0, idx).join("\n").trimEnd();
  const after = lines.slice(idx).join("\n");
  const out = after ? `${before}\n\n${rule.line}\n${after}` : `${before}\n\n${rule.line}`;
  return { text: out, added: rule.line };
}

/**
 * お客様の期限・困りごとがあるのに本文に「間に合う」の一文が無ければ、挨拶の行の次に差し込む（スタッフ実送信の文そのまま・日付は足さない）。
 * 慶次の実送信: 「慶次さん夜分遅くに失礼致します！！\n無事ご入居間に合いますようにサポートさせて頂きます！！\n現在募集が出ているお部屋で…ピックアップさせて頂きました！！」
 */
export function ensureDeadlineSupportLine(text: string, deadline: readonly string[]): { text: string; added: boolean } {
  if (deadline.length === 0 || /間に合/.test(text)) return { text, added: false };
  const lines = text.split("\n");
  // 1行目が挨拶・名前の行（〇〇さん…）ならその次、そうでなければ先頭に
  const head = lines[0] ?? "";
  const isGreetingLine = /さん|様|お世話になっております|失礼致します|ありがとう/.test(head) && !/ピックアップ|ご査収/.test(head);
  if (!isGreetingLine) return { text: `${DEADLINE_SUPPORT_LINE}\n\n${text}`, added: true };
  const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
  return { text: rest ? `${head}\n\n${DEADLINE_SUPPORT_LINE}\n\n${rest}` : `${head}\n\n${DEADLINE_SUPPORT_LINE}`, added: true };
}

/** 直近でまだこちらが応えていないお客様の発言（最後のこちらの文より後）。お礼の対象がここに無ければ古い話 */
export function freshCustomerTexts(messages: readonly ThreadMessage[]): string[] {
  let lastStaff = -1;
  messages.forEach((m, i) => { if (m.sender === "staff" && (m.text ?? "").trim() && !MEDIA_RE.test((m.text ?? "").trim())) lastStaff = i; });
  return messages.slice(lastStaff + 1).filter((m) => m.sender === "customer").map((m) => (m.text ?? "").trim()).filter((t) => t && !MEDIA_RE.test(t));
}

/**
 * 古い話へのお礼の行を落とす（2026-09-15 慶次事例: 本番で「給与明細と労働条件通知書のご準備ありがとうございます😊！！」＝5日前の書類へのお礼が入った。
 * 物件ピックアップの文にお礼の行は無い＝スタッフ実文6通とも挨拶の行だけ）。1行目（挨拶の行）は触らない。
 * お礼の対象の言葉（漢字・カタカナ2字以上）が、まだ応えていないお客様の発言に無ければ落とす
 */
const THANKS_STOPWORDS = new Set(["準備", "用意", "連絡", "返信", "確認", "共有", "本日", "先日", "昨日", "お部屋", "部屋", "物件", "案内", "対応", "お時間", "時間", "丁寧", "迅速", "誠", "頂", "様"]);
export function stripUnanchoredThanksLines(text: string, fresh: readonly string[]): { text: string; removed: string[] } {
  const freshJoined = fresh.join("\n");
  const removed: string[] = [];
  const lines = text.split("\n");
  const kept = lines.filter((l, i) => {
    if (i === 0 || !/ありがと(?:う|ー)/.test(l)) return true;
    // ピックアップ行・約束の行にお礼が混ざっている時は行ごとは落とさない（本文の芯を消さない）
    if (/ピックアップ|ご査収|募集|間に合|交渉|確認させて|サポート/.test(l)) return true;
    // 希望条件を受け取った直後の「ご条件お送り頂きありがとうございます」は、まだ応えていない発言に条件があれば残す
    if (/条件/.test(l) && /家賃|万|間取り|エリア|駅|徒歩|条件/.test(freshJoined)) return true;
    const words = (l.match(/[一-龯々ァ-ヴー]{2,}/g) ?? []).filter((w) => !THANKS_STOPWORDS.has(w));
    if (words.length > 0 && words.some((w) => freshJoined.includes(w))) return true;
    removed.push(l.trim());
    return false;
  });
  if (removed.length === 0) return { text, removed };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

export function stripRepeatedThanksLines(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split("\n").filter((l) => { if (REPEATED_THANKS_LINE_RE.test(l.trim())) { removed++; return false; } return true; });
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: removed ? out : text, removed };
}

/** 前回の物件送付（この送付より前）の文。ここより後の発言だけを糸口にする */
const PREVIOUS_PICKUP_SENT_RE = /ピックアップ(?:し|して)?(?:お送り)?させて(?:頂|いただ)きました|募集に(?:で|出)ました|お送りさせて(?:頂|いただ)きました|ご査収ください/;
/** お客様の気にしていること（この語がある発言を糸口にする） */
// 「労働条件通知書」「条件面」の書類の話は拾わない（慶次事例: 在籍確認の書類のやり取りが糸口に混ざった）
const CUSTOMER_TOPIC_RE = /代理契約|契約(?:者)?名義|名義人|保証人|保証会社|審査|入居(?:日|時期|まで|が)|急ぎ|早め|間に合|ペット|猫|犬|駐車場|バイク|駐輪|初期費用|家賃|広め|広い|大きめ|狭|静か|日当たり|楽器|在宅|テレワーク|2人|二人|同棲|お子|子供|子ども|赤ちゃん|出産|学生|外国|生活保護|障害|高齢|退去|引越|引っ越|階|エレベーター|オートロック|洗面|風呂|トイレ|収納|(?<!労働)条件(?!通知)/;
/** こちらの約束・経緯（未来形。「ピックアップしてお送りします」の定型は糸口にしない）。「お部屋探しさせていただきます」も約束 */
const STAFF_PROMISE_RE = /(?:交渉|確認|サポート|相談|お調べ|探し|手配|お伝え|ご連絡)(?:させて(?:頂|いただ)き|いたし|致し)(?:ます|ますので)|広げ(?:て|させて(?:頂|いただ)き)|優先(?:して|的に)/;
/** こちらからお伝えした経緯（審査否決・募集終了・他の方のお申込）— 今回のピックアップの理由になる（慶次: 審査否決 → 次の物件） */
const STAFF_EVENT_RE = /審査(?:否決|に落ち|が通らな|NG)|否決|募集(?:終了|が終了|ございませんでした|がございませんでした)|(?:他の方|別の方)(?:の|から)?(?:お)?申込|申込(?:み)?が入/;
const STAFF_PICKUP_PROMISE_RE = /ピックアップ(?:し|して)?(?:お送り)?させて(?:頂|いただ)きます/;
const MEDIA_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]/;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * 直近の会話から「会話を合わせる」の糸口を拾う（前回の物件送付より後・最大 maxEach 件ずつ・新しい順）。
 * 拾うだけで、使うかは生成側（候補に無い事柄は書かせない）
 */
export function extractPropertySendThreads(
  messages: readonly ThreadMessage[],
  opts: {
    maxEach?: number; lookback?: number;
    /** 続いている事情を探す範囲（省略時は messages）。画面が渡す直近の発言は御見積書・内覧の往復で埋まりやすく、
     *  代理契約のような会話の最初からの事情が窓の外に出る（カイナ: 直近16件に代理契約が1件も無かった）→ サーバはお客様の発言を長めに渡す */
    requirementSources?: readonly ThreadMessage[];
  } = {},
): PropertySendThreads {
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
  const deadline: string[] = [];
  for (const m of slice) {
    const t = (m.text ?? "").replace(/\r/g, "").trim();
    if (!t || MEDIA_RE.test(t)) continue;
    if (m.sender === "customer") {
      // 発言を文ごとに見て、気にしている語のある文だけ（申込フォームの項目・「無し」の答えは除く）
      const sentences = t.split(/\n|(?<=[。！!？?])/).map((s) => s.trim()).filter(Boolean);
      for (const s of sentences) {
        if (NEGATED_ITEM_RE.test(s)) continue;
        if (CUSTOMER_TOPIC_RE.test(s)) customer.push(clip(s, 80));
        if (DEADLINE_RE.test(s)) deadline.push(clip(s, 80));
      }
    } else if (m.sender === "staff") {
      const sentences = t.split(/\n|(?<=[。！!？?])/).map((s) => s.trim()).filter(Boolean);
      // 定型の「ピックアップしてお送りします」だけの文は糸口にしない（「エリア広げさせていただき、…ピックアップしお送りします」は経緯なので拾う）
      for (const s of sentences) {
        if (STAFF_EVENT_RE.test(s)) { staff.push(clip(s, 80)); continue; }
        if (STAFF_PROMISE_RE.test(s) && !(STAFF_PICKUP_PROMISE_RE.test(s) && !/広げ|優先|交渉|サポート/.test(s))) staff.push(clip(s, 80));
      }
    }
  }
  const uniq = (a: string[]) => [...new Set(a)];
  const cust = uniq(customer).slice(-maxEach).reverse();
  // 続いている事情は前回の送付より前の発言からも拾う（代理契約は会話の最初から続く事情）
  const reqAll = uniq((opts.requirementSources ?? recent).flatMap((m) => {
    if (m.sender !== "customer") return [];
    const t = (m.text ?? "").replace(/\r/g, "").trim();
    if (!t || MEDIA_RE.test(t)) return [];
    return t.split(/\n|(?<=[。！!？?])/).map((s) => s.trim()).filter((s) => s && REQUIREMENT_RE.test(s) && !NEGATED_ITEM_RE.test(s)).map((s) => clip(s, 80));
  }));
  return { customer: cust, requirements: reqAll.slice(-maxEach).reverse(), staff: uniq(staff).slice(-maxEach).reverse(), deadline: uniq(deadline).slice(-maxEach).reverse() };
}

/** LLM に渡す糸口のブロック（無ければ空＝③は書かない） */
export function buildPropertySendThreadsBlock(th: PropertySendThreads): string {
  const deadline = th.deadline ?? [];
  if (th.customer.length === 0 && th.staff.length === 0 && th.requirements.length === 0 && deadline.length === 0) {
    return "【会話の糸口（候補）】無し → ③（会話に合わせた文）は書かず、②の後に⑤で締める";
  }
  const lines: string[] = ["【会話の糸口（候補・新しい順）— ③はこの中の事柄だけから選ぶ（1〜2文・無関係なものは使わない）】"];
  if (deadline.length) {
    lines.push(`＜お客様の期限・困りごと（退去を伝えてしまった・更新しない・急な事情）→ ①挨拶の次の行に「${DEADLINE_SUPPORT_LINE}」（スタッフ実送信の文そのまま・日付や理由を足さない）。その後に②＞`);
    lines.push(...deadline.map((s) => `・${s}`));
  }
  if (th.requirements.length) {
    lines.push("＜お客様の続いている事情（今回送る物件にも関わる。前回の物件で確認・解決済みでも、今回送る物件については未確認）→ 必ず「お気に召されたお部屋〇〇可能か全て交渉（確認）させて頂きます！！」のように、今回の物件でこちらがどうするかを1文で書く＞");
    lines.push(...th.requirements.map((s) => `・${s}`));
  }
  if (th.staff.length) { lines.push("＜こちらが約束したこと・お伝えした経緯（言い方をそのまま活かす。審査否決・募集終了は「だから今回この物件を送る」理由として受け止めるだけで、理由の推測や新しい提案はしない）＞"); lines.push(...th.staff.map((s) => `・${s}`)); }
  const wishes = th.customer.filter((s) => !th.requirements.includes(s) && !deadline.includes(s));
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
