// app/lib/customer-mood-flow.ts — お客様の「気持ちの流れ」を LINE の流れから決まった計算で測る（純関数・DB も fetch も持たない）
//
// 2026-10-08 竹内「気持ちの判断する部分も強化する必要ある。LINE で流れを見たらそこも判断できると思う」
//   今あるもの: ブレインが毎回 emotion（前向き/不安/冷めかけ/普通）を LLM で1語出す（brain_decision_logs.digest.emo）／
//   send-reply-timing が「直前のこちらの送信の種類×今回の返事の速さ」を全体の実測と比べて渡す。
//   無かったもの: ①**このお客様自身のいつも**と比べた変化（返事の間・文の長さ・！や絵文字・質問の多さ）
//                 ②前のこちらの提案（物件・内覧・申込・見積）への反応（触れたか・前向きか・迷いか）
//                 ③前回までの気持ちの並び（前向き→迷い の変化）＝人の営業が「さっきより冷めたな」と感じる所
//   → ここで数字と言葉の当たり（引用）だけを作り、気持ちの判断そのものはブレインが流れを見て決める（語だけで決めない＝10/08 の総点検の方針）。
//
// 読まない物: 条件のフォーム・申込の書類・画像/スタンプだけの通・URL だけの通（長さや！の数の物差しにならない）。
// 戻す: CUSTOMER_MOOD_FLOW=off（ブレインへの注記）
// テスト: app/lib/__tests__/customer-mood-flow.test.ts

export type MoodMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null };

export type MoodLabel = "前向き" | "迷い" | "不安" | "不満" | "急ぎ" | "離れかけ" | "淡々" | "不明";

export type Burst = {
  startAt: string;
  endAt: string;
  texts: string[];
  /** 物差しに使える通か（フォーム・書類・画像だけ・URL だけを除いた文字がある） */
  usable: boolean;
  chars: number;
  /** ！ と絵文字の数 */
  expressive: number;
  questions: number;
  /** 直前のこちらの送信からの分（無ければ null） */
  latencyMin: number | null;
  /** 直前のこちらの送信が提案（物件・内覧・申込・見積）だったか・その種類 */
  prevProposal: ProposalKind | null;
  prevStaffAt: string | null;
  /** この束の前に、こちらが返事をもらえずに続けて送った回数（束と束の間のこちらの送信のまとまりの数 - 1 ではなく、間の「日」の数） */
  unansweredStaffDays: number;
};

export type ProposalKind = "物件" | "内覧" | "申込" | "見積";

export type MoodSignals = Partial<Record<"positive" | "hesitation" | "anxiety" | "dissatisfaction" | "distancing" | "urgency", string>>;

export type MoodFlow = {
  now: Burst;
  /** このお客様のいつも（今回より前の使える束・最大6） */
  base: { n: number; latencyMedMin: number | null; charsMed: number | null; expressiveShare: number | null };
  changes: string[];
  signals: MoodSignals;
  reaction: { to: ProposalKind; kind: "前向き" | "迷い" | "断り" | "触れていない" } | null;
  /** 決まった計算での見立て（ブレインへの材料。判断はブレイン） */
  hint: MoodLabel;
  /** 下向きの変化の数（遅く・短く・！が消えた・返事なしの後） */
  downward: number;
};

const FORM_RE = /①|【ご入居の時期】|ご希望のお部屋探しご条件|生年月日|携帯番号|勤務先(?:名|所在地|電話)|年収|フリガナ|【お申込/;
/** 画像・動画だけの通／画像の書き起こし（「[画像] 【物件の画面（ポータル）】…」＝お客様の文ではない） */
const MEDIA_ONLY_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル|位置情報)[^\]]*\]/;
const URL_RE = /https?:\/\/\S+/g;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EXCLAIM_RE = /[！!]/g;
const QUESTION_RE = /[？?]|(?:ます|です|でしょう|ません)か(?=[。！!\s]|$)/g;

/** 提案の送信（こちらの文から） */
export function proposalKindOf(text: string | null | undefined): ProposalKind | null {
  const t = String(text ?? "");
  if (/お申込み?|お申し込み|お部屋(?:を)?(?:抑え|押さえ)/.test(t)) return "申込";
  if (/御見積書|お見積書|見積書/.test(t)) return "見積";
  if (/ご内覧|内覧|ご案内させて/.test(t)) return "内覧";
  if (/🌟|ピックアップ(?:させて(?:頂|いただ)き|し)ました|お送りさせて(?:頂|いただ)きました/.test(t)) return "物件";
  return null;
}

const SIGNAL_RES: Array<[keyof MoodSignals, RegExp]> = [
  ["distancing", /他(?:で|の(?:会社|不動産|業者|お店))[^。\n]{0,10}決|見送|一旦(?:大丈夫|保留|やめ|白紙)|今回は(?:大丈夫|やめ|見送|なし)|もう(?:大丈夫|いい)です|結構です|キャンセル(?:で|し|さ)|やめておき|探すのをやめ/],
  ["dissatisfaction", /高い(?:です|な|かも|ので)|高すぎ|微妙|ちょっと違|イメージと違|狭すぎ|遠すぎ|まだですか|遅い(?:です|な)|返事(?:が)?(?:ない|来ない)|連絡(?:が)?(?:ない|来ない)|話が違/],
  ["anxiety", /不安|心配|大丈夫でしょうか|大丈夫ですか|通る(?:か|でしょう)|通りますか|厳しい(?:かも|です)|無理(?:かも|ですか)|💦/],
  ["hesitation", /悩(?:ん|み|む)|迷(?:っ|い|う)|検討(?:し|さ|中)|考え(?:ます|たい|させ|てみ)|もう少し(?:探|考|見)|他(?:も|の物件も)見|比較|決めきれ/],
  ["urgency", /急ぎ|早めに|すぐ(?:に)?(?:入|住|引|決)|今月中|今週中|至急|できるだけ早|出来るだけ早|早く(?:決|入|住)/],
  ["positive", /気に入|良さそう|いいですね|良いですね|すごく(?:良|いい)|ぜひ|是非|内見(?:し|させ)たい|内覧(?:し|させ)たい|見に行きたい|申し?込(?:み)?たい|ここにし|決めたい|楽しみ|ありがたいです|助かります/],
];

function cleanText(t: string): string {
  return t.replace(URL_RE, "").replace(/\[(?:画像|動画|スタンプ|ファイル|位置情報)[^\]]*\]/g, "").trim();
}

function quoteOf(text: string, re: RegExp): string | null {
  const t = text.normalize("NFKC");
  const m = t.match(re);
  if (!m || m.index == null) return null;
  const s = Math.max(0, t.lastIndexOf("\n", m.index) + 1);
  let e = t.indexOf("\n", m.index); if (e < 0) e = t.length;
  return t.slice(s, e).trim().slice(0, 40);
}

const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const DAY = 86_400_000;
const JST = 9 * 3600_000;
const jstDay = (ms: number) => Math.floor((ms + JST) / DAY);

/** お客様の連投の束（間にこちらの送信が無い通のまとまり）。こちらの送信は手打ちも AIX も数える */
export function customerBursts(msgs: ReadonlyArray<MoodMsg>): Burst[] {
  const out: Burst[] = [];
  let cur: MoodMsg[] = [];
  let lastStaff: MoodMsg | null = null;
  let staffSinceBurst: MoodMsg[] = [];
  let pendingPrev: { staff: MoodMsg | null; staffBetween: MoodMsg[] } = { staff: null, staffBetween: [] };
  const flush = () => {
    if (!cur.length) return;
    const texts = cur.map((m) => String(m.text ?? ""));
    const usableTexts = texts.filter((t) => t.trim() && !MEDIA_ONLY_RE.test(t) && !FORM_RE.test(t)).map(cleanText).filter((t) => /[\p{L}\p{N}]/u.test(t));
    const joined = usableTexts.join("\n");
    const start = Date.parse(cur[0].createdAt);
    const prev = pendingPrev.staff;
    const prevMs = prev ? Date.parse(prev.createdAt) : NaN;
    // こちらの送信がいくつの日に分かれていたか（返事なしで日をまたいで追った回数）
    const days = new Set(pendingPrev.staffBetween.map((m) => jstDay(Date.parse(m.createdAt))));
    const prevProposal = [...pendingPrev.staffBetween].reverse().map((m) => proposalKindOf(m.text)).find((k) => k) ?? null;
    out.push({
      startAt: cur[0].createdAt,
      endAt: cur[cur.length - 1].createdAt,
      texts,
      usable: joined.length > 0,
      chars: joined.replace(/\s/g, "").length,
      expressive: (joined.match(EXCLAIM_RE)?.length ?? 0) + (joined.match(EMOJI_RE)?.length ?? 0),
      questions: joined.normalize("NFKC").match(QUESTION_RE)?.length ?? 0,
      latencyMin: Number.isFinite(prevMs) ? Math.max(0, Math.round((start - prevMs) / 60_000)) : null,
      prevProposal,
      prevStaffAt: prev?.createdAt ?? null,
      unansweredStaffDays: Math.max(0, days.size - 1),
    });
    cur = [];
  };
  for (const m of msgs) {
    if (m.sender === "customer") {
      if (!cur.length) pendingPrev = { staff: lastStaff, staffBetween: staffSinceBurst };
      cur.push(m);
    } else {
      if (cur.length) { flush(); staffSinceBurst = []; }
      lastStaff = m;
      staffSinceBurst.push(m);
    }
  }
  flush();
  return out;
}

export function moodSignals(texts: ReadonlyArray<string>): MoodSignals {
  const joined = texts.filter((t) => !FORM_RE.test(t)).map(cleanText).join("\n");
  const out: MoodSignals = {};
  for (const [k, re] of SIGNAL_RES) { const q = quoteOf(joined, re); if (q) out[k] = q; }
  return out;
}

const hm = (min: number) => (min >= 2880 ? `${(min / 1440).toFixed(1)}日` : min >= 60 ? `${(min / 60).toFixed(1)}時間` : `${min}分`);

/** 最後の束（今回の発言）の気持ちの流れ。束が無ければ null */
export function resolveMoodFlow(msgs: ReadonlyArray<MoodMsg>, o: { baseN?: number } = {}): MoodFlow | null {
  const bursts = customerBursts(msgs);
  if (!bursts.length) return null;
  const now = bursts[bursts.length - 1];
  const prev = bursts.slice(0, -1).filter((b) => b.usable).slice(-(o.baseN ?? 6));
  const lat = prev.map((b) => b.latencyMin).filter((x): x is number => x != null);
  const base = {
    n: prev.length,
    latencyMedMin: med(lat),
    charsMed: med(prev.map((b) => b.chars)),
    expressiveShare: prev.length ? prev.filter((b) => b.expressive > 0).length / prev.length : null,
  };
  const changes: string[] = [];
  let downward = 0;
  if (base.n >= 2 && now.usable) {
    if (now.latencyMin != null && base.latencyMedMin != null) {
      if (now.latencyMin >= 180 && now.latencyMin >= base.latencyMedMin * 3 && now.latencyMin >= base.latencyMedMin + 180) { changes.push(`返事が遅くなった（今回 ${hm(now.latencyMin)}・いつも ${hm(Math.round(base.latencyMedMin))}）`); downward++; }
      else if (base.latencyMedMin >= 30 && now.latencyMin <= base.latencyMedMin / 3) changes.push(`返事が早くなった（今回 ${hm(now.latencyMin)}・いつも ${hm(Math.round(base.latencyMedMin))}）`);
    }
    // 物件の URL を送ってきた束は「ここはどうですか」だけで短いのが普通（離れていない）＝長さの変化は見ない
    const sharesUrl = now.texts.some((t) => /https?:\/\//.test(t));
    if (base.charsMed != null && !sharesUrl) {
      if (base.charsMed >= 30 && now.chars <= base.charsMed * 0.4) { changes.push(`文が短くなった（今回 ${now.chars}字・いつも ${Math.round(base.charsMed)}字）`); downward++; }
      else if (now.chars >= 60 && now.chars >= base.charsMed * 2.5) changes.push(`文が長くなった（今回 ${now.chars}字・いつも ${Math.round(base.charsMed)}字）`);
    }
    if (base.expressiveShare != null) {
      // 2026-10-08 実データ（scripts/audit-customer-mood-flow.ts・120日 2,789束）: 「！・絵文字が無くなった」束の会話は申込 46%（変化なし 40%）
      //   ＝下向きの印にならない → 出さない。増えた方だけ材料に。
      if (base.expressiveShare <= 0.2 && now.expressive >= 2) changes.push(`！・絵文字が増えた`);
    }
  }
  if (now.questions >= 2) changes.push(`質問が多い（${now.questions}つ）`);
  if (now.unansweredStaffDays >= 1) { changes.push(`こちらが返事なしで ${now.unansweredStaffDays + 1}日に分けて送った後の返事`); downward++; }
  const signals = moodSignals(now.texts);
  let reaction: MoodFlow["reaction"] = null;
  if (now.prevProposal) {
    const kind = signals.distancing ? "断り" : signals.positive ? "前向き" : signals.hesitation ? "迷い" : null;
    reaction = { to: now.prevProposal, kind: kind ?? "触れていない" };
    // 触れていないの判定は、提案の言葉にも触れていない時だけ
    if (!kind) {
      const j = now.texts.join("\n");
      const touched = now.prevProposal === "物件" ? /物件|お部屋|部屋|🌟|号室|ありがとう/.test(j)
        : now.prevProposal === "内覧" ? /内覧|内見|見学|日|時/.test(j)
        : now.prevProposal === "申込" ? /申し?込|審査|書類/.test(j)
        : /見積|費用|金額|円/.test(j);
      if (touched) reaction = null; // 触れているが気持ちの言葉は無い＝材料にしない
    }
  }
  const hint: MoodLabel = signals.distancing ? "離れかけ"
    : signals.dissatisfaction ? "不満"
    : signals.anxiety ? "不安"
    : signals.hesitation ? "迷い"
    : signals.urgency ? "急ぎ"
    : signals.positive ? "前向き"
    // 2026-10-08: 遅く・短くの数字だけで「離れかけ」としない（実物 25束を読むと URL だけの持ち込み・短い質問が大半＝離れていない）
    : now.usable ? "淡々" : "不明";
  return { now, base, changes, signals, reaction, hint, downward };
}

const SIGNAL_JA: Record<keyof MoodSignals, string> = {
  positive: "前向き", hesitation: "迷い", anxiety: "不安", dissatisfaction: "不満", distancing: "離れかけ", urgency: "急ぎ",
};

export function moodFlowEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CUSTOMER_MOOD_FLOW ?? "").trim().toLowerCase() !== "off";
}

/**
 * ブレインへの短い注記（材料だけ・判断はブレイン）。言う事が無ければ空文字。
 * prevEmotions: 前回までのブレインの気持ちの判断（古い→新しい・最大4）
 */
export function buildMoodFlowNote(f: MoodFlow | null, o: { prevEmotions?: ReadonlyArray<string | null | undefined> } = {}): string {
  if (!f) return "";
  const lines: string[] = [];
  if (f.changes.length) lines.push(`- このお客様のいつもとの違い: ${f.changes.join("／")}`);
  const sig = (Object.keys(f.signals) as Array<keyof MoodSignals>).map((k) => `${SIGNAL_JA[k]}「${f.signals[k]}」`);
  if (sig.length) lines.push(`- 気持ちの言葉: ${sig.join("・")}`);
  if (f.reaction) lines.push(`- 前のこちらの提案（${f.reaction.to}）への反応: ${f.reaction.kind}`);
  const prev = (o.prevEmotions ?? []).filter((x): x is string => typeof x === "string" && !!x.trim()).slice(-4);
  if (!lines.length && !prev.length) return "";
  if (prev.length) lines.push(`- 前回までの気持ち（ブレインの判断・古い→新しい）: ${prev.join("→")}`);
  if (!lines.some((l) => !l.startsWith("- 前回まで"))) return ""; // 変化も言葉も無い時は出さない（いつも通り）
  return `\n【気持ちの流れ（決まった計算・材料）】\n${lines.join("\n")}\n→ 今回の emotion は言葉だけでなくこの流れ（前回からの変化）も見て決める。流れが下向きなら、押す一文（申込・内覧の誘い）を足す前に、受け止めと答えを先にするかを判断する\n`;
}
