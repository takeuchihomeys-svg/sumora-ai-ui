// app/lib/okyaku-address.ts
// お客様に送る文で相手を「お客様」と呼ばない（〇〇さん・分からなければ呼ばない）出口（純関数・DB も fetch も持たない）。
//
// 2026-10-02 竹内さん（YUMA の LINE「…分割回数はお客様のカード会社側で設定いただけます」を読んで）「お客様って言葉使わない」。
// 線（scripts/audit-okyaku-address.ts・365日の本番のスタッフの送信）:
//   人の手打ち 6,029通で「お客様」を含むのは 23通（0.38%）。その大半は**他の人のこと**（「1番手で別のお客様が」「他のお客様に取られて」
//   「多くのお客様が」「ご紹介頂きましたお客様」「お仕事のお客様（契約名義人）」「スモラのお客様限定」「お客様名（記入欄）」）。
//   相手その人を「お客様」と呼んだ文は 5月の AI 下書き由来の数通だけ（6月以降の手打ちで 0）。AIX は 26通（「お客様にかなりオススメ出来る
//   お部屋」「お客様ご希望の」＝名前が分からない時の言い換え）。
//   → 相手を指す形（下の RULES）だけを、名前があれば「〇〇さん」に、無ければ呼ばずに書く形に直す。他の人を指す「お客様」は触らない
//     （前に 他の・別の・多くの・番手の・お仕事の 等が付く・後ろに 限定・名・ご紹介料 等が続く）。
//   入口（生成の指示）は line-reply-prompts の STYLE_RULE。会社の事実の文（company-facts）にも「お客様が」と書かない。

export type OkyakuFix = { text: string; changes: string[] };

/** 前にこれがあれば他の人のこと（触らない） */
const THIRD_PARTY_BEFORE = /(?:[（(【「]|他の|他|別の|多くの|一般の|番手の|番手|前の|次の|新規の|各|全ての|すべての|お仕事の|ご紹介頂きました|ご紹介いただきました|ご紹介頂いた|ご紹介いただいた|弊社の|スモラの|うちの|同じ|ほかの|一部の)\s*$/;
/** 後ろにこれが続けば一般の話・別の意味（触らない） */
const GENERAL_AFTER = /^(?:限定|名|ご紹介料|紹介料|同士|様|ご来店|の初期費用に還元|に還元|の声|満足度)/;

type Rule = { re: RegExp; withName: (n: string) => string; noName: string };
/**
 * 相手を指す「お客様」の形（実物: 「分割回数はお客様のカード会社側で設定」「お客様にかなりオススメ出来るお部屋」「お客様ご希望の南向き」
 * 「お客様のご希望のお部屋探し」「お客様の方でお預かりしてる契約書」「お客様ご自身で」）
 */
const RULES: Rule[] = [
  { re: /お客様の(?=(?:お持ちの)?(?:カード|クレジット))/, withName: (n) => `${n}の`, noName: "ご自身の" },
  { re: /お客様の(?=方で|方の|方に|ほうで)/, withName: (n) => `${n}の`, noName: "ご自身の" },
  { re: /お客様の(?=ご都合|ご希望|ご要望|ご条件|ご予算|ご負担|ご状況|ご事情|生活|お手元|お引越し|お引っ越し|ご入居|ご判断|ペース)/, withName: (n) => `${n}の`, noName: "" },
  { re: /お客様に(?=かなり|オススメ|おすすめ|お勧め|ピッタリ|ぴったり|合った|合う|ご満足|ご案内|ご連絡|お送り|ご提案)/, withName: (n) => `${n}に`, noName: "" },
  { re: /お客様(?=ご希望|ご自身|側で|側の|側に)/, withName: (n) => n, noName: "" },
  { re: /お客様が(?=ご自身|ご希望|お気に|ご納得|ご安心)/, withName: (n) => `${n}が`, noName: "" },
  { re: /お客様ご自身(?=で|の)/, withName: (n) => `${n}ご自身`, noName: "ご自身" },
];

/** 行が「お客様」だけ（前後の空白のみ）＝名前の欄（2026-10-06 ⑰） */
const NAME_SLOT_LINE_RE = /(^|\n)[ \t　]*お客様[ \t　]*(\n|$)/g;
/** 行頭の「お客様」の直後に挨拶・本題が続く＝名前の欄（「お客様お世話になっております」「お客様確認させていただきました」） */
const NAME_SLOT_HEAD_RE = /(^|\n)([ \t　]*)お客様(?=お世話|確認させ|お送り|お待たせ|夜分|ご連絡|こんにちは|おはよう|こんばんは|ご査収|いつも)/g;

/** 「〇〇さん」の形にする（既に さん／様 が付いていれば付けない・「お客様」は名前でない） */
function honorific(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  if (!n || /^お客様$|^お客さん$/.test(n)) return "";
  if (/(?:さん|様|さま|ちゃん|くん)$/.test(n)) return n.replace(/様$|さま$/, "さん");
  return `${n}さん`;
}

/**
 * 相手を指す「お客様」を「〇〇さん」（名前が無ければ呼ばない形）に直す。他の人を指す「お客様」・一般の話は触らない。
 * name … 呼び名（姓・表示名・「〇〇さん」どれでも）。無い・「お客様」なら呼ばない形
 */
export function fixSecondPersonOkyaku(text: string | null | undefined, name?: string | null): OkyakuFix {
  let s = String(text ?? "");
  if (!s.includes("お客様")) return { text: s, changes: [] };
  const n = honorific(name);
  const changes: string[] = [];
  // 2026-10-06 ⑰: 行頭の名前の欄の「お客様」（AIX の下書きで名前が取れなかった時の受け皿・60日で30回）。
  //   行が「お客様」だけ → 名前があれば「〇〇さん」・無ければ行ごと書かない。行頭の「お客様」＋挨拶/本題 → 名前があれば名前・無ければ呼ばない。
  //   線: スタッフの送信 365日 13,908通で当たるのは1通（AI の下書きのまま送った「お客様お世話になっております」）＝誤削除0
  s = s.replace(NAME_SLOT_LINE_RE, (_m: string, head: string, tail: string) => {
    changes.push(`行頭のお客様→${n || "（呼ばない）"}`);
    return n ? `${head}${n}${tail}` : head;
  });
  s = s.replace(NAME_SLOT_HEAD_RE, (_m: string, head: string, sp: string) => {
    changes.push(`行頭のお客様→${n || "（呼ばない）"}`);
    return `${head}${sp}${n}`;
  });
  if (changes.length) s = s.replace(/^\n+/, "");
  if (!s.includes("お客様")) return { text: s, changes };
  for (const r of RULES) {
    const g = new RegExp(r.re.source, "g");
    s = s.replace(g, (m: string, ...rest: unknown[]) => {
      const off = rest.find((x) => typeof x === "number") as number;
      const before = s.slice(Math.max(0, off - 14), off);
      const after = s.slice(off + m.length, off + m.length + 12);
      if (THIRD_PARTY_BEFORE.test(before)) return m;
      if (GENERAL_AFTER.test(s.slice(off + "お客様".length, off + "お客様".length + 12))) return m;
      void after;
      const rep = n ? r.withName(n) : r.noName;
      changes.push(`${m}→${rep || "（呼ばない）"}`);
      return rep;
    });
  }
  // 呼ばない形にした後の「、、」「。、」や行頭の読点を整える
  if (changes.length) s = s.replace(/、{2,}/g, "、").replace(/(^|\n)、/g, "$1").replace(/[、,]\s*(?=[！!。])/g, "");
  return { text: s, changes };
}
