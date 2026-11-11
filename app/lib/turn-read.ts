// app/lib/turn-read.ts — お客様の一通を「対象 × 意図 × 気持ち」と「直前のこちらの誘導への答え」まで読む欄（純関数・DB/LLM なし）
//
// 2026-11-11 竹内さん（KB P1 5cb0dd4c・親 P0 575a7cd5）「物件をさすか・内覧にいきたいのか・この部屋を気に入っているのか（どれか言っていない場合文脈から見つける）…
//   もっと広い部屋の物件ないのか、等こういった事理解してるのかな。お客さんの潜在意識の部分や気持ちの部分」
//   追加「こちらからの LINE は何に誘導しているのか細かい部分も把握できれば理解度上がる」（P0 ecd7b961 の子）
// 作業員14 の測り（scripts/audit-turn-read-1111.ts・竹内さんの番30）:
//   - 番ごとの「何の事か」の読みが記録に無い（digest.tc は道の数だけ・cs は締めの方針）＝当たりを測れない → mode=log で記録だけ残す
//   - お客様が直前のこちらの誘導に応じた番 19/30 のうち、ブレインが答えとして読んだのは 15。誘導を読む材料が無い（cta-guidance・appeal-timing は締めを決めるだけ）
//   - お礼・了承の番を「刺さっている」「安くしたい」と読む（前の番の気持ちの持ち越し）10/30
// 決め打ちにしない（P0「判断はすべてブレイン基準」）: ここは候補の網（直前の誘導の語）と、ブレインの出力の欄の形・記録の短い形だけ。
// 切替: TURN_READ = off（既定）| log（ブレインの今ある読み＝turn_contract の about/property・latent_intent を digest に残すだけ）| on（log ＋ ブレインに欄と【直前のこちらの誘導】を渡す）
// テスト: app/lib/__tests__/turn-read.test.ts

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
export type TurnReadMode = "off" | "log" | "on";
export function turnReadMode(env?: Env): TurnReadMode {
  const v = (envOf(env).TURN_READ ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "log" ? "log" : "off";
}

// ─── 欄の値 ─────────────────────────────────────────────
export const TURN_TARGET_KINDS = ["送った物件", "持ち込み物件", "新着の1件", "探す条件", "費用・見積", "内覧の日・場所", "手続き・審査", "会社・店", "こちらの約束の結果", "その他"] as const;
export type TurnTargetKind = typeof TURN_TARGET_KINDS[number];
/** 意図の細分（竹内さん 11/11 の一覧＋竹内さんの番30で出た型） */
export const TURN_INTENTS = [
  "内覧したい", "申込したい・抑えたい", "初期費用を抑えたい", "家賃を下げたい", "もっと良い部屋・別の物件も見たい", "もっと広い部屋", "設備の確かめ", "条件に合うかの確かめ",
  "空き・募集状況の確かめ", "費用の確かめ", "日程の調整・連絡", "手続き・審査の質問", "条件を伝える・言い直す", "気に入った・感想", "まだ刺さっていない・興味が薄い", "検討する・保留・相談", "断り・他で決めた", "お礼・了承", "その他",
] as const;
export type TurnIntent = typeof TURN_INTENTS[number];
export const LEAD_KINDS = ["内覧", "申込・抑える", "見積", "物件を送ってもらう", "条件を聞く", "新着の約束", "確認の約束", "関係をつなぐ"] as const;
export type LeadKind = typeof LEAD_KINDS[number];
export const LEAD_ANSWERS = ["応じた", "断った・先送り", "別の話", "関係なし"] as const;
export type LeadAnswer = typeof LEAD_ANSWERS[number];

export type TurnRead = {
  target: { kind: TurnTargetKind; property: string | null; detail: string | null; how: "言った" | "文脈から" | null };
  intent: TurnIntent; intent2: TurnIntent | null;
  lead: { kind: LeadKind; answer: LeadAnswer } | null;
  feeling: string | null;
};

// ─── 直前のこちらの誘導（候補の網・語だけ。どれが効いているかはブレインが決める） ───────────
const LEAD_RES: ReadonlyArray<[LeadKind, RegExp]> = [
  ["内覧", /ご?内覧|ご?内見|見に(?:行|来|い)|ご案内(?:させて|可能|出来|でき)|ご都合(?:の)?(?:よろしい|良い)(?:お)?日/],
  ["申込・抑える", /お?申し?込み?|抑え(?:る|て|ら)|押さえ|仮押さえ|審査(?:を|だけ)?先に/],
  ["見積", /御?見積(?:書|もり)?/],
  ["物件を送ってもらう", /(?:気になる|お気に召した|ご希望の)(?:お)?(?:部屋|物件)[^。\n]{0,20}(?:お送り|送って|URL|スクショ|画像)|URL[^。\n]{0,10}(?:お送り|送って)|お送り頂け(?:ましたら|れば)/],
  ["条件を聞く", /ご希望の?(?:条件|エリア|家賃|間取り|時期)|(?:ご条件|お部屋探しご条件)[^。\n]{0,12}(?:教えて|お聞か|ご記入|お送り)|いかがでしょうか[^。\n]{0,4}[？?]?$/],
  ["新着の約束", /新着|出次第|出てき(?:次第|たら)|入り次第/],
  ["確認の約束", /確認(?:させて頂|致し|いたし|出来次第|でき次第)|確認後|お調べ/],
  ["関係をつなぐ", /全力で(?:サポート|お探し)|何か(?:ございましたら|あれば)|お気軽に|いつでも(?:ご連絡|お声)/],
];
export type LeadCand = { kind: LeadKind; quote: string; pos: number; strong: boolean };
/** こちらの1通の誘導の候補（文の後ろほど締めの誘導＝並びは後ろから）。強い＝日時・候補・問いかけまである */
export function leadCandidatesOf(text: string | null | undefined): LeadCand[] {
  const s = String(text ?? "");
  if (!s.trim()) return [];
  const out: LeadCand[] = [];
  for (const [kind, re] of LEAD_RES) {
    const m = re.exec(s);
    if (!m) continue;
    const sentStart = Math.max(s.lastIndexOf("\n", m.index), s.lastIndexOf("。", m.index)) + 1;
    const sentEnd = (() => { const a = s.indexOf("\n", m.index), b = s.indexOf("。", m.index); const c = [a, b].filter((x) => x >= 0); return c.length ? Math.min(...c) : s.length; })();
    const sent = s.slice(sentStart, sentEnd).trim();
    const strong = /\d{1,2}[\/月]\d{1,2}|\d{1,2}[:：時]\d{0,2}|候補|いかがでしょうか|如何でしょうか|ご都合|宜しいでしょうか|よろしいでしょうか|[？?]/.test(sent);
    out.push({ kind, quote: Array.from(sent).slice(0, 40).join(""), pos: m.index, strong });
  }
  return out.sort((a, b) => b.pos - a.pos);
}

export type LeadMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null };
/** 今の番（お客様の連投）の直前のこちらの送信の束（最大3通・新しい順に読む）を返す */
export function lastStaffBurst(msgs: ReadonlyArray<LeadMsg>): LeadMsg[] {
  let k = msgs.length; while (k - 1 >= 0 && msgs[k - 1].sender === "customer") k--;
  if (k === msgs.length) return [];   // 今の番が無い（最後がこちら）
  const out: LeadMsg[] = [];
  for (let i = k - 1; i >= 0 && msgs[i].sender !== "customer" && out.length < 3; i--) out.unshift(msgs[i]);
  return out;
}

/** 【直前のこちらの誘導】の注記（候補・判断はブレイン）。候補が無ければ空文字 */
export function buildPrevLeadNote(msgs: ReadonlyArray<LeadMsg>): string {
  const burst = lastStaffBurst(msgs);
  if (!burst.length) return "";
  const cands: Array<LeadCand & { aix: boolean }> = [];
  for (const m of [...burst].reverse()) for (const c of leadCandidatesOf(m.text)) if (!cands.some((x) => x.kind === c.kind)) cands.push({ ...c, aix: !!m.isAix });
  if (!cands.length) return "";
  const lines = cands.slice(0, 3).map((c, i) => `${i === 0 ? "▶" : "・"}${c.kind}（${c.strong ? "強い" : "弱い"}${c.aix ? "・AIX" : ""}）「${c.quote}」`);
  return [
    "【直前のこちらの誘導（候補の語・どれが効いているかはブレインが決める）】",
    ...lines,
    "→ お客様の今の一通を、まずこの誘導への答えとして読めるかを見る（例: 内覧に誘った後の「土曜は？」＝日の答え・抑える提案の後の「審査が不安」＝前向きな不安）。答えが来たら同じ誘導を繰り返さず一段進める。答えでない別の話なら、その話を先に受ける。",
  ].join("\n");
}

// ─── ブレインの出力の欄 ─────────────────────────────────────
export const TURN_READ_BRAIN_FIELD = `"turn_read"（お客様の今の一通を細かく読む。{"target": {"kind": "${TURN_TARGET_KINDS.join("|")}", "property": "物件の事なら物件名と号室（会話・送った束の表記のまま）・無ければ null", "detail": "細かい対象 25字（どの設備・どの費用の項目・どの日の内覧・どの約束）", "how": "言った|文脈から"}, "intent": "${TURN_INTENTS.join("|")} から一番の意図", "intent2": "2番目か null", "lead": 直前のこちらの誘導があれば {"kind": "${LEAD_KINDS.join("|")}", "answer": "${LEAD_ANSWERS.join("|")}"}・無ければ null, "feeling": "気持ちの中身 25字（どの程度気に入っているか・何が不安か・迷いの中身）"}。読み方: 対象を言っていない時は直前のこちらの送信・開いている約束・今の番の物件から決める（「ここ」「予算オーバー」「駐車場は？」の主語）。物件を送った後の「よろしくお願いします」「拝見します」は物件への感想ではなく直前の送信への了承（kind=こちらの約束の結果・intent=お礼・了承）。URL・資料の画像だけの持ち込みは kind=持ち込み物件。お礼・了承だけの番に、前の番の気持ち（刺さっている・安くしたい・審査の不安）を持ち越さない＝"mindset" の state も今の一通で決め、了承だけなら 普通の依頼）`;
export function turnReadOutputItem(env?: Env): string {
  return turnReadMode(env) === "on" ? `、${TURN_READ_BRAIN_FIELD}` : "";
}

const pickOf = <T extends string>(list: ReadonlyArray<T>, v: unknown): T | null => (typeof v === "string" && (list as ReadonlyArray<string>).includes(v.trim()) ? (v.trim() as T) : null);
const short = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? Array.from(v.trim()).slice(0, n).join("") : null);
/** 生の turn_read を型に直す（型の外れた値は落とす・target か intent が無ければ null） */
export function normalizeTurnRead(raw: unknown): TurnRead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const t = (o.target && typeof o.target === "object" ? o.target : {}) as Record<string, unknown>;
  const kind = pickOf(TURN_TARGET_KINDS, t.kind);
  const intent = pickOf(TURN_INTENTS, o.intent);
  if (!kind || !intent) return null;
  const l = (o.lead && typeof o.lead === "object" ? o.lead : null) as Record<string, unknown> | null;
  const lk = l ? pickOf(LEAD_KINDS, l.kind) : null, la = l ? pickOf(LEAD_ANSWERS, l.answer) : null;
  const how = t.how === "言った" || t.how === "文脈から" ? t.how : null;
  const prop = short(t.property, 40);
  return {
    target: { kind, property: prop && !/^(null|なし|無し)$/i.test(prop) ? prop : null, detail: short(t.detail, 30), how },
    intent, intent2: pickOf(TURN_INTENTS, o.intent2),
    lead: lk && la ? { kind: lk, answer: la } : null,
    feeling: short(o.feeling, 30),
  };
}

// ─── 記録（digest）の短い形 ─────────────────────────────────
/** turn_read → "種類|物件|意図|誘導:答え"（digest.tr） */
export function turnReadDigest(tr: TurnRead | null | undefined): string | null {
  if (!tr) return null;
  return [tr.target.kind, tr.target.property ?? "", tr.intent, tr.lead ? `${tr.lead.kind}:${tr.lead.answer}` : ""].join("|").slice(0, 120);
}
/** 今ある読み（turn_contract.asks の about・property）→ ["about:物件", …]（digest.ta・最大4） */
export function askAboutDigest(turnContract: unknown): string[] | null {
  const asks = (turnContract as { asks?: unknown } | null | undefined)?.asks;
  if (!Array.isArray(asks) || !asks.length) return null;
  const out = asks.slice(0, 4).map((a) => {
    const x = (a ?? {}) as { about?: unknown; property?: unknown; topic?: unknown };
    const about = typeof x.about === "string" ? x.about : typeof x.topic === "string" ? `t:${Array.from(x.topic).slice(0, 12).join("")}` : "?";
    const p = typeof x.property === "string" && x.property.trim() ? Array.from(x.property.trim()).slice(0, 24).join("") : "";
    return p ? `${about}:${p}` : about;
  });
  return out.length ? out : null;
}
/** digest に足す欄（mode=off は空・log/on は今ある読み＋（on なら）turn_read） */
export function turnReadDigestExtra(meta: Record<string, unknown>, env?: Env): { tr?: string; ta?: string[]; li?: string } {
  if (turnReadMode(env) === "off") return {};
  const out: { tr?: string; ta?: string[]; li?: string } = {};
  const ta = askAboutDigest(meta.turn_contract); if (ta) out.ta = ta;
  const li = short(meta.latent_intent, 50); if (li) out.li = li;
  const tr = turnReadDigest(normalizeTurnRead(meta.turn_read)); if (tr) out.tr = tr;
  return out;
}
