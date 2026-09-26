// app/lib/daily-greeting.ts
// 「お世話になっております」は1日1回（その日こちらがはじめて送る LINE にだけ付ける）。純関数・DB 依存なし。
//
// 2026-09-22 竹内「お世話になっておりますの部分も今日お客さんとやりとりしているのに AIX で出てしまうことがある。
//   今日初めてのLINEだったらお世話になっておりますをつける／今日初めてじゃないときはお世話になっておりますはつかわない」
//
// ■ 実測（scripts/audit-aix-osewa-sameday.ts・直近60日・文のある送信）
//   手打ち: 今日はじめて 58.0% ／ お客様からだけ届いている日のこちらの1通目 43.2% ／ **こちらが今日すでに送った後 9.5%**
//   AIX  : 今日はじめて 26.0% ／ お客様からだけ届いている日のこちらの1通目 33.3% ／ **こちらが今日すでに送った後 2.7%（31通）**
// ■ 付いてしまう経路（実物を読んで見つけた）
//   ① 画面の判定が AIX の送信を数えていなかった（page.tsx `!m.isAix`）→ 今日のやり取りが AIX だけだと「今日まだ送っていない」
//   ② AIX テンプレートは「お世話になっております」固定（TemplateModal が AIX カテゴリだけ staffMessagedToday=false を強制）
//   ③ AIX 本体は画面から渡された一覧だけで判定 → 1分前に手打ちで送った通が一覧にまだ無い（08:35 手打ち → 08:36 AIX で付いた）
//   ④ 物件確認した（物件なかった）の固定文に「〇〇さんお世話になっております！！」が直書き
// ■ 直した形（四者同名）: 「今日こちらが送ったか」を sentByStaffToday（＋サーバーでは DB）で1回決め、
//   AIX の仕上げ（finalize）で applyDailyGreeting を全経路に通す。
//   - 今日すでに送った → 冒頭の挨拶（お世話になっております／夜分遅くに失礼致します）を消す
//   - 今日はじめて → 挨拶が無ければ決まった挨拶（buildGreeting の値）を付ける
//     （初回は「ご連絡頂きありがとうございます」・夜にこちらから届ける連絡は「夜分遅くに失礼致します」＝以前の竹内さん方針のまま）
//   - 物件カード・御見積書の金額の通（【】・🌟 で始まる）には付けない

const JST_MS = 9 * 3600_000;
const jstDay = (t: number) => new Date(t + JST_MS).toISOString().slice(0, 10);

export type DayMsg = { sender?: string | null; createdAt?: string | null; rawCreatedAt?: string | null };

/** 今日（日本時間）こちらが1通でも送っているか（手打ち・AIX・画像すべて。時刻の無い通は数えない） */
export function sentByStaffToday(messages: ReadonlyArray<DayMsg>, now: number = Date.now()): boolean {
  const today = jstDay(now);
  return messages.some((m) => {
    if (m.sender !== "staff") return false;
    const iso = m.rawCreatedAt ?? m.createdAt;
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && jstDay(t) === today;
  });
}

/** 冒頭の挨拶（先頭2行までを見る。「〇〇さん」だけの行の次の行に挨拶がある形も拾う） */
const HEAD_OSEWA_RE = /^([ \t　]*(?:[^\n！!。]{0,15}(?:さん|様)[、,]?[ \t　]*)?)(?:いつも)?お世話になっております[😊😌🙇]*[！!。]*[ \t　]*/;
const HEAD_NIGHT_RE = /^([ \t　]*(?:[^\n！!。]{0,15}(?:さん|様)[、,]?[ \t　]*)?)夜分(?:遅く)?に?(?:大変)?失礼(?:致|いた)?します[😊😌🙇]*[！!。]*[ \t　]*/;
/** 既に冒頭にある挨拶・書き出し（これがあれば足さない） */
const ANY_OPENING_RE = /お世話になっております|夜分|お待たせ(?:致|いた)しました|ご連絡(?:頂|いただ)きありがとう|はじめまして|初めまして|(?:本日|先日|昨日)(?:は)?[^\n]{0,10}(?:ありがとう|失礼)|お時間(?:頂|いただ)き/;
/** 付けない通（物件カード・御見積書の金額・画像や URL だけ） */
const NO_GREETING_HEAD_RE = /^\s*(?:【|🌟|\[画像\]|https?:\/\/|（室内イメージ）)/u;

export type DailyGreetingResult = { text: string; action: "removed" | "added" | "none" };

/**
 * その日の挨拶を決定論でそろえる（AIX の仕上げで全経路に通す）。
 * @param staffSentToday 今日こちらが既に送っているか（sentByStaffToday ＋ サーバーの DB 確認）
 * @param greetingPhrase 今日はじめての時に使う挨拶（buildGreeting の値。"" なら付けない）
 * @param name 「〇〇さん」（分からなければ ""）
 */
export function applyDailyGreeting(text: string, opts: { staffSentToday: boolean; greetingPhrase: string; name: string }): DailyGreetingResult {
  if (!text?.trim()) return { text, action: "none" };
  const lines = text.split("\n");
  const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0).slice(0, 2);
  if (opts.staffSentToday) {
    for (const i of idx) {
      const m = HEAD_OSEWA_RE.exec(lines[i]) ?? HEAD_NIGHT_RE.exec(lines[i]);
      if (!m) continue;
      const keepName = m[1].trim();
      const rest = lines[i].slice(m[0].length).trim();
      // 「〇〇さんお世話になっております！！」→「〇〇さん」＋本文（名前の行は残す＝実送信の2通目以降は名前行か本題から）
      //   挨拶の直後にまた名前が続く1行（「〇〇さんお世話になっております！！〇〇さんにオススメ…」・全件監査の実物）は名前を重ねない
      const replaced = /^[^\n！!。]{0,15}(?:さん|様)/.test(rest) ? rest : [keepName, rest].filter(Boolean).join("");
      const out = replaced ? [...lines.slice(0, i), replaced, ...lines.slice(i + 1)] : [...lines.slice(0, i), ...lines.slice(i + 1)];
      return { text: out.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n"), action: "removed" };
    }
    return { text, action: "none" };
  }
  if (!opts.greetingPhrase) return { text, action: "none" };
  const head = idx.map((i) => lines[i]).join("\n");
  if (ANY_OPENING_RE.test(head)) return { text, action: "none" };
  const first = idx[0];
  if (first === undefined || NO_GREETING_HEAD_RE.test(lines[first])) return { text, action: "none" };
  // 1行目が「〇〇さん」だけ → その行に挨拶をつなぐ（名前と挨拶は同じ行＝実送信の形）
  const nameOnly = /^[ \t　]*[^\n！!。]{1,15}(?:さん|様)[、,]?[ \t　]*$/.test(lines[first]);
  if (nameOnly) {
    const out = [...lines];
    out[first] = `${lines[first].trim().replace(/[、,]$/, "")}${opts.greetingPhrase}`;
    return { text: out.join("\n"), action: "added" };
  }
  // 1行目が「〇〇さん」で始まる本文 → 名前の後ろに挨拶の行を挟む
  // 名前の直後が助詞（「〇〇さんにオススメ」）の時は文の一部なので切り離さない（下の「先頭に挨拶の行を足す」に回す）
  const afterName = opts.name ? lines[first].trim().slice(opts.name.length) : "";
  const nameHead = opts.name && lines[first].trim().startsWith(opts.name) && !/^[にのがはへもとを]/.test(afterName) ? opts.name : "";
  if (nameHead) {
    const out = [...lines];
    const body = lines[first].trim().slice(nameHead.length).replace(/^[、,\s　]+/, "");
    out[first] = `${nameHead}${opts.greetingPhrase}`;
    if (body) out.splice(first + 1, 0, body);
    return { text: out.join("\n"), action: "added" };
  }
  return { text: `${opts.name}${opts.greetingPhrase}\n${text.replace(/^\n+/, "")}`, action: "added" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 「今日こちらが会話文を送ったか」（資料文・画像は数えない）— テンプレート最適化（AIX→テンプレ）の挨拶で使う
//
// 2026-09-26 竹内「こちらが言ったことの関係性…たとえば AIX からテンプレートの場合は挨拶入れない等」
// ■ 実測（scripts/audit-staff-relation.ts・template_selection_logs 180日 420件の「最適化した文 × スタッフが送った文」）
//   - 今日こちらが会話文を送っている時に、最適化した文の冒頭に挨拶が残った → 9/22 の方針以降 9件、送った6件は **6件ともスタッフが消した**（残した0件）
//     出所: テンプレの挨拶は入口（applyGreetingSwap）で消えるが、LLM が【AIX物件情報】（AIX の本文の冒頭「〇〇さんお世話になっております！！」）を写して足していた
//   - 今日こちらが送ったのが**資料文だけ**（🌟物件カード・【】見積の本体・室内イメージの URL・画像）の時は、
//     最適化した文の挨拶をスタッフが残した 37/38（97%）・無い時に足した 13/61 → 資料文は「その日の会話文」に数えないのがスタッフの形
//     （姉妹の測定 R2a: 資料だけの日の添え文は挨拶か呼びかけ 67%／会話文がある日は 13%）
// ■ AIX 本体の仕上げ（applyDailyGreeting に sentByStaffToday＝画像も数える）は今回は変えない（測っていないため）。
//   テンプレート最適化の入口（applyGreetingSwap）・プロンプト・出口だけ、スタッフの形に合わせてこちらを使う。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 資料文（その日の会話文に数えない通）: 物件カード・御見積書の本体・画像・動画・URL だけの通
 * 2026-09-26 反証レビューで追加: 「①【物件名】初期費用さらに🌟〇円割引」（複数物件の見積の本体・30日で12通）・[スタンプ]・[ファイル]・[通話リクエスト]
 *   （generate-reply の hasAnyStaffTextMsg もスタンプ・ファイルを会話文に数えない＝同じ扱いにそろえる）。
 *   template_selection_logs 180日 421件ではこの追加で判定が変わる行は0件。資料側に倒すと出口（挨拶を消す）が通らなくなる方向＝誤削除は増えない。
 */
const MATERIAL_HEAD_RE = /^\s*(?:【|🌟|[①-⑳]\s*【|\[(?:画像|動画|スタンプ|ファイル|通話リクエスト)\]|https?:\/\/|（室内イメージ）)/u;
export function isMaterialOnlyText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return !t || MATERIAL_HEAD_RE.test(t);
}

export type TalkMsg = DayMsg & { text?: string | null };

/** 今日（日本時間）こちらが会話文（資料文・画像・動画ではない通）を1通でも送っているか。時刻の無い通は数えない */
export function staffTalkedToday(messages: ReadonlyArray<TalkMsg>, now: number = Date.now()): boolean {
  const today = jstDay(now);
  return messages.some((m) => {
    if (m.sender !== "staff" || isMaterialOnlyText(m.text)) return false;
    const iso = m.rawCreatedAt ?? m.createdAt;
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && jstDay(t) === today;
  });
}
