// app/lib/compose-blueprint.ts — 文の指示役（構成のブレイン）: 意図（趣旨・主語・メインの1文・添え・締め）→ 文の設計図（純関数・DB/LLM なし）
//
// 2026-11-03 作業員6（竹内さん 11/03 KB 885e25fd「文生成の際も統括されるから文の中でぶつかっているのを防ぎ、竹内の LINE の構成のように全体として意味の通った文に」・
//   1310343e「パターンによってブレインと連携させて、文の主語となる部分やメインとなる部分を意識して構成。訴求の場面なら訴求、サポートならサポートとブレインが判断」・
//   「意図をちゃんとブレインから文の設計の所と連携できれば。この場面にはこれが良いってのも RAG 検索等で分かれば」）。
// 流れ（返信・AIX の1通目・2通目・✨テンプレートで同じ）: ①統括の判断（plan＝何を言うか・要件の順・2通に割るか／作業員2）→ ②構成のブレイン（このファイル＝主役・趣旨・主語・添え・締め）
//   → ③書き手が設計図に従う（網・決まりは設計図の部品の中だけで効かせる）→ ④最終チェックは安全の線だけ。先例は second-appeal-judge.ts（判断→書き手が従う）。
// 趣旨の種類と型は竹内さん本人の返信 1,794 通（staff_writer=takeuchi・device・sure・AIX でない・7/11〜11/01）を SQL で数えて決めた（LLM なし）:
//   案内・説明 444／訴求 387（半分は AIX の直後の2通目）／約束 361／受けだけ 314／サポート 57（主役は少なく、約束の後ろの添えに 28%）／問い 51。
//   お断り（19）は返信の趣旨にしない＝AIX の番（募集終了・申込が入っていた報告）／定型・資料（68）は構成のブレインの外（統括 11/03 決定）。
// スイッチ: BRAIN_COMPOSE_BLUEPRINT=on（既定 off＝今と1文字も変わらない）。
// テスト: app/lib/__tests__/compose-blueprint.test.ts

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function composeBlueprintOn(env: Env = envOf()): boolean {
  return (env.BRAIN_COMPOSE_BLUEPRINT ?? "").trim().toLowerCase() === "on";
}

// ── 型 ──────────────────────────────────────────────────────────────────
export const COMPOSE_PURPOSES = ["appeal", "support", "promise", "inform", "ask", "ack"] as const;
export type ComposePurpose = typeof COMPOSE_PURPOSES[number];
export const COMPOSE_PURPOSE_JA: Record<ComposePurpose, string> = {
  appeal: "訴求（物件を勧める）", support: "サポート（不安を受け止める）", promise: "約束（確認・お送り・ピックアップ・ご連絡）",
  inform: "案内・説明（質問への答え・手続き・費用の中身）", ask: "問い・ヒアリング（ご希望・書類のお願い）", ack: "受け（お礼・了承だけ）",
};
export const COMPOSE_NEXT = ["reply", "viewing", "apply", "send_property", "wait_check", "answer_only", "none"] as const;
export type ComposeNext = typeof COMPOSE_NEXT[number];
export const COMPOSE_SUBJECT = ["customer", "property", "us", "process"] as const;
export type ComposeSubject = typeof COMPOSE_SUBJECT[number];
export const COMPOSE_ADDS = ["support", "promise", "appeal", "ask"] as const;
export type ComposeAdd = typeof COMPOSE_ADDS[number];
export const COMPOSE_CLOSING = ["nanitozo", "receipt", "kigaru", "viewing_cta", "apply_cta", "none"] as const;
export type ComposeClosing = typeof COMPOSE_CLOSING[number];

/** ブレイン → 構成のブレインに渡す意図（SituationSummary.compose と同じ口） */
export type ComposeIntent = {
  purpose: ComposePurpose;
  /** なぜこの番でこれを言うのか（1文） */
  why: string;
  /** お客様に何を感じてほしいか（安心・刺さる・待てる 等） */
  feel: string;
  /** 次に何をしてほしいか */
  next: ComposeNext;
  /** メインの1文の主語と、言う事 */
  main: { subject: ComposeSubject; what: string };
  /** 添える部品（最大2・メインと同じ趣旨は入れない） */
  adds: ComposeAdd[];
  closing: ComposeClosing;
  confidence: "high" | "mid" | "low";
  source: "brain" | "fallback";
};

export type BlueprintRole = "name_greet" | "uke" | "main" | "add" | "cta" | "close";
export type BlueprintPart = { role: BlueprintRole; say: string; from: "decision" | "situation" | "material" | "rag" | "form"; nets?: string[] };
export type ComposeBlueprint = {
  intent: ComposeIntent;
  parts: BlueprintPart[];
  messages: 1 | 2;
  lengthBand: "short" | "mid" | "long";
  /** RAG で引いた竹内さんの送信の id（根拠・写す物ではない） */
  evidence: string[];
  check: { mainOnPurpose: boolean; addsNotEatingMain: boolean; issues: string[] };
};

// ── 竹内さんの型（11/03 の数え・趣旨ごと） ───────────────────────────────────────
/** 趣旨ごとの既定: よく出る部品の並び・締め・長さ（竹内さん 1,794 通から） */
export const TAKEUCHI_PURPOSE_FORMS: Record<ComposePurpose, { seq: string; closing: ComposeClosing; lengthBand: ComposeBlueprint["lengthBand"]; note: string }> = {
  promise: { seq: "受け→約束（→サポート）→締め", closing: "nanitozo", lengthBand: "mid", note: "受けの言葉の後にすぐ約束（受け 60%）・締めは「何卒よろしくお願い致します」42%・全力サポートを添えるのは 28%" },
  appeal: { seq: "名前と挨拶（または受け）→訴求→（サポート）→締め", closing: "receipt", lengthBand: "long", note: "勧める物件を主語に1〜2点を強く・締めは「お手隙の際にご査収」33%・内覧の誘い 23%・申込の誘いは返信ではほぼ無い" },
  inform: { seq: "（受け）→案内（→約束）", closing: "none", lengthBand: "mid", note: "聞かれた事に先に答える（案内だけ 37 が最多）・締めは無しが多い（31% だけ締める）" },
  support: { seq: "受け→サポート→締め", closing: "nanitozo", lengthBand: "mid", note: "不安を受け止める番だけ主役にする（受け 67%）・締めは「何卒」46%" },
  ask: { seq: "受け→問い→締め", closing: "kigaru", lengthBand: "mid", note: "聞きたい事は1つに絞る・締めは「お気軽に」33%・何卒 24%" },
  ack: { seq: "受け→締め", closing: "nanitozo", lengthBand: "short", note: "受けと締めだけ（約45字）・中身を足さない" },
};

// ── 文の部品の札（決定論・SQL の数えと同じ線。採点・毎晩の数え・設計図の確かめに使う） ─────────
export type SentenceTag = "list" | "opener" | "greet" | "ack" | "thanks" | "close" | "cta_viewing" | "cta_apply" | "support" | "decline" | "appeal" | "promise" | "ask" | "info" | "other";
const T: Array<[SentenceTag, (s: string) => boolean]> = [
  ["list", (s) => /^[・①-⑳🟢【（〒0-9０-９h]/.test(s) || /^(?:🌟|★)/.test(s) || s.length <= 3],
  ["opener", (s) => /お待たせ/.test(s)],
  ["greet", (s) => /^.{0,14}(?:お世話になっております|はじめまして|おはようございます|こんにちは|こんばんは)[。！!😊😌]*$/u.test(s) || /担当させて頂きます.{0,6}と申します/.test(s) || /^この度ご連絡/.test(s)],
  ["ack", (s) => /^(?:はい|かしこまりました|承知(?:致|いた)?しました|了解(?:です)?|全然大丈夫です|大丈夫です)[😊😌！!。　 ]*$/u.test(s)],
  ["thanks", (s) => /ありがとうございま/.test(s) && s.length < 40],
  ["close", (s) => /何卒よろしくお願い|お手隙の際に|ご査収|いつでもお気軽に|お気軽にご連絡|ごゆっくりご確認|お気をつけて|お待ちしております|いつでもご連絡/.test(s)],
  ["cta_viewing", (s) => /(?:お気に召されましたら|よろしければ).{0,30}(?:ご案内|ご内覧)/.test(s) || /ご内覧如何/.test(s)],
  ["cta_apply", (s) => /お申込|申込し|抑えさせて|押さえ/.test(s) && /如何|頂ければ|おすすめ|オススメ|お早め/.test(s)],
  ["support", (s) => /全力でサポート|最善|ご満足頂|ご安心|ご不安|出来る限り|できる限り|お力になれ/.test(s)],
  ["decline", (s) => /申し訳|難し|募集終了|申込が入|お申込が入っ|必須となります|出来かね|できかね|終了して|決まってしまい|お取り扱い出来ません/.test(s)],
  ["appeal", (s) => /オススメ|おすすめ|好条件|特に|人気|抑える事が|抑えられ|お得|ピッタリ|ぴったり|如何でしょうか/.test(s)],
  ["promise", (s) => /(?:確認|お送り|ピックアップ|ご連絡|交渉|調整|作成|手配|審査掛け|抑え|お伝え|探させ|お調べ).{0,20}(?:させて頂きます|致します|いたします)/.test(s) || /次第/.test(s)],
  ["ask", (s) => /お送りください|ご記入|頂けますでしょうか|ございますか|でしょうか|教えて|お送りの程|ご確認ください|幸い/.test(s)],
  ["info", (s) => /となります|でございます|可能です|ございます|頂けます|流れ|必要|出来ます|できます|です/.test(s)],
];
export function sentencesOf(text: string): string[] {
  return String(text ?? "").split(/\n+|(?<=[！!。？?])(?=[^！!。？?😊😌🌟✨\s])/u).map((s) => s.trim()).filter(Boolean);
}
export function tagSentence(s: string): SentenceTag {
  for (const [tag, f] of T) if (f(s)) return tag;
  return "other";
}
const MAIN_TAGS: ReadonlySet<SentenceTag> = new Set(["appeal", "promise", "ask", "info", "support", "decline"]);
const TAG_TO_PURPOSE: Partial<Record<SentenceTag, ComposePurpose | "decline">> = { appeal: "appeal", promise: "promise", ask: "ask", info: "inform", support: "support", decline: "decline" };
/** 文の趣旨（メインの1文＝挨拶・受け・お礼・締め・誘いを除いた最初の中身の文の札）・定型の行が3行以上なら material */
export function purposeOfText(text: string): { purpose: ComposePurpose | "decline" | "material"; main: string | null; seq: SentenceTag[] } {
  const sens = sentencesOf(text);
  const tags = sens.map(tagSentence);
  if (tags.filter((t) => t === "list").length >= 3) return { purpose: "material", main: null, seq: compactSeq(tags) };
  const i = tags.findIndex((t) => MAIN_TAGS.has(t));
  if (i < 0) return { purpose: "ack", main: null, seq: compactSeq(tags) };
  return { purpose: TAG_TO_PURPOSE[tags[i]] as ComposePurpose | "decline", main: sens[i], seq: compactSeq(tags) };
}
/** 続く同じ札をまとめ・定型の行を除いた並び */
export function compactSeq(tags: SentenceTag[]): SentenceTag[] {
  const out: SentenceTag[] = [];
  for (const t of tags) if (t !== "list" && out[out.length - 1] !== t) out.push(t);
  return out;
}

// ── ① ブレインに意図を決めさせる（LLM の指示と読み取り） ───────────────────────────
export const COMPOSE_INTENT_SYSTEM = [
  "あなたは賃貸仲介会社の営業の統括（ブレイン）の「文の構成」の担当です。統括が決めた要件（何を言うか・順番・何通か）を受けて、この1通の趣旨と主役を決めます（文は書きません）。",
  "竹内さん（社長）は1通ごとに主役を1つ決めて書きます（中身の種類は平均1.4）。主役の1文が先に来て、添えは1つまで、締めは趣旨で変わります。",
  "趣旨（purpose）は1つ: appeal＝物件を勧める／support＝お客様の不安を受け止める番だけ（全力サポートの一言は添えにする）／promise＝確認・お送り・ピックアップ・ご連絡を約束する／inform＝聞かれた事に答える・手続きや費用の中身を説明する／ask＝ご希望・都合・書類を聞く／ack＝お礼・了承を受けるだけ（中身を足さない）。",
  "募集終了・申込が入っていた等の残念な報告と、申込フォーマット・条件のフォームの定型は、ここでは決めない（AIX と定型の番）。",
  "決める物: purpose・why（なぜこの番でこれを言うか）・feel（お客様に何を感じてほしいか）・next（reply/viewing/apply/send_property/wait_check/answer_only/none）・main（subject＝customer/property/us/process と、メインの1文で言う事 what）・adds（support/promise/appeal/ask から0〜2・purpose と同じ物は入れない）・closing（nanitozo＝何卒よろしくお願い致します／receipt＝お手隙の際にご査収／kigaru＝お気軽にご連絡／viewing_cta＝お気に召されましたらご案内／none）・confidence（high/mid/low）。",
  "統括の要件に無い事を main・adds に足さない。事実（物件・金額・日時）は要件と材料にある物だけ。",
  "出力は JSON だけ: {\"purpose\":\"…\",\"why\":\"…\",\"feel\":\"…\",\"next\":\"…\",\"main\":{\"subject\":\"…\",\"what\":\"…\"},\"adds\":[…],\"closing\":\"…\",\"confidence\":\"…\"}",
].join("\n");

export type ComposeRequirement = { rank: number; item: string; handling?: string | null; who?: string | null; include?: string | null; msg?: number | null };
export type ComposeIntentInput = {
  customerText: string;
  scene: string;
  requirements: ComposeRequirement[];
  situation?: string | null;
  emotion?: string | null;
  appeal?: string | null;
  ragHints?: string[];
};
export function composeIntentPrompt(i: ComposeIntentInput): string {
  const req = replyRequirements(i.requirements);
  return [
    `## お客様の今の発言\n${i.customerText.slice(0, 500) || "（無し）"}`,
    `## 場面\n${i.scene}`,
    `## 統括が決めたこの1通の要件（この順・この中から主役を選ぶ）\n${req.map((r) => `${r.rank}. ${r.item}${r.handling ? `（${r.handling}）` : ""}`).join("\n") || "（無し＝受けだけの番）"}`,
    i.situation ? `## 状況のまとめ・統括の決定（決め直さない）\n${i.situation.slice(0, 1200)}` : "",
    i.emotion ? `## お客様の気持ち\n${i.emotion.slice(0, 200)}` : "",
    i.appeal ? `## 訴求の判断（ブレイン）\n${i.appeal.slice(0, 300)}` : "",
    i.ragHints?.length ? `## 似た場面の竹内さんの構成（根拠・写さない）\n${i.ragHints.slice(0, 3).map((h, k) => `${k + 1}) ${h.slice(0, 160)}`).join("\n")}` : "",
    `## 竹内さんの趣旨ごとの型\n${COMPOSE_PURPOSES.map((p) => `・${COMPOSE_PURPOSE_JA[p]}: ${TAKEUCHI_PURPOSE_FORMS[p].seq}（${TAKEUCHI_PURPOSE_FORMS[p].note}）`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}
/** 返信の本文に入る要件だけ（plan の include=in・who=reply／priorities の aix・later・skip は外す） */
export function replyRequirements(rs: ReadonlyArray<ComposeRequirement>): ComposeRequirement[] {
  return rs.filter((r) => (r.include == null || r.include === "in") && (r.who == null || r.who === "reply") && !/^(?:aix|later|skip)$/.test(String(r.handling ?? "")))
    .slice().sort((a, b) => a.rank - b.rank);
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list as readonly string[]).includes(String(v)) ? (String(v) as T) : d;
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export function parseComposeIntent(text: string): ComposeIntent | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (!(COMPOSE_PURPOSES as readonly string[]).includes(String(o.purpose))) return null;
    const purpose = o.purpose as ComposePurpose;
    const main = (o.main ?? {}) as { subject?: unknown; what?: unknown };
    const adds = (Array.isArray(o.adds) ? o.adds : []).map(String).filter((a): a is ComposeAdd => (COMPOSE_ADDS as readonly string[]).includes(a) && a !== purpose);
    return {
      purpose, why: clip(o.why, 120), feel: clip(o.feel, 60),
      next: oneOf(o.next, COMPOSE_NEXT, "none"),
      main: { subject: oneOf(main.subject, COMPOSE_SUBJECT, "us"), what: clip(main.what, 120) },
      adds: [...new Set(adds)].slice(0, 2),
      closing: oneOf(o.closing, COMPOSE_CLOSING, TAKEUCHI_PURPOSE_FORMS[purpose].closing),
      confidence: oneOf(o.confidence, ["high", "mid", "low"] as const, "mid"),
      source: "brain",
    };
  } catch { return null; }
}
/** ブレインが意図を出せなかった時の既定（要件の1番の扱いから・決定論は候補の網だけ＝低い確かさで渡す） */
export function fallbackIntent(rs: ReadonlyArray<ComposeRequirement>): ComposeIntent {
  const req = replyRequirements(rs);
  const top = req[0];
  const purpose: ComposePurpose = !top ? "ack" : top.handling === "confirm" ? "promise" : "inform";
  return {
    purpose, why: top ? `要件の1番（${clip(top.item, 40)}）` : "要件が無い＝受けだけ", feel: "", next: purpose === "promise" ? "wait_check" : "none",
    main: { subject: purpose === "promise" ? "us" : "process", what: top ? clip(top.item, 120) : "" },
    adds: [], closing: TAKEUCHI_PURPOSE_FORMS[purpose].closing, confidence: "low", source: "fallback",
  };
}

// ── ② 設計図を作る・④ 設計図の段で確かめる ───────────────────────────────────
const CLOSING_SAY: Record<ComposeClosing, string> = {
  nanitozo: "何卒よろしくお願い致します！！", receipt: "お手隙の際にご査収ください😌！！", kigaru: "ご不明点等ございましたらいつでもお気軽にご連絡ください😌！！",
  viewing_cta: "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！",
  apply_cta: "お気に召されましたらお申込しお部屋抑えさせて頂きます！！", none: "",
};
const ADD_SAY: Record<ComposeAdd, string> = {
  support: "〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます（添え・1文まで）",
  promise: "要件のうち約束の物（確認・お送り）を1文で", appeal: "要件のうち勧める点を1つだけ", ask: "聞きたい事を1つだけ",
};
export function buildBlueprint(o: { intent: ComposeIntent; requirements: ComposeRequirement[]; planMessages?: number; greet?: "name_greet" | "uke" | "none"; nets?: Partial<Record<BlueprintRole, string[]>>; evidence?: string[] }): ComposeBlueprint {
  const it = o.intent;
  const req = replyRequirements(o.requirements);
  const parts: BlueprintPart[] = [];
  const greet = o.greet ?? (it.purpose === "ack" || it.purpose === "promise" || it.purpose === "support" || it.purpose === "ask" ? "uke" : "name_greet");
  if (greet !== "none") parts.push({ role: greet, say: greet === "uke" ? "受けの言葉（かしこまりました！！／はい😊！！ 等・1つ）" : "名前と挨拶（〇〇さんお世話になっております！！）", from: "form", nets: o.nets?.[greet] });
  if (it.purpose !== "ack") parts.push({ role: "main", say: it.main.what || (req[0]?.item ?? ""), from: "decision", nets: o.nets?.main });
  // 主役以外の要件は統括の順のまま添える（構成のブレインは並べ替えない・足さない）
  const mainReq = it.purpose === "ack" ? null : (req.find((r) => r.item === it.main.what || it.main.what.includes(r.item) || r.item.includes(it.main.what)) ?? req[0] ?? null);
  const rest = req.filter((r) => r !== mainReq);
  for (const r of rest) parts.push({ role: "add", say: r.item, from: "decision", nets: o.nets?.add });
  const covered = (a: ComposeAdd) => (a === "support" && rest.some((r) => /サポート|ご不安|ご安心/.test(r.item))) || (a === "promise" && rest.some((r) => r.handling === "confirm"));
  for (const a of it.adds) if (!covered(a)) parts.push({ role: "add", say: ADD_SAY[a], from: "form", nets: o.nets?.add });
  if (it.closing === "viewing_cta" || it.closing === "apply_cta") parts.push({ role: "cta", say: CLOSING_SAY[it.closing], from: "form", nets: o.nets?.cta });
  if (it.closing !== "none" && it.closing !== "viewing_cta" && it.closing !== "apply_cta") parts.push({ role: "close", say: CLOSING_SAY[it.closing], from: "form", nets: o.nets?.close });
  const bp: ComposeBlueprint = {
    intent: it, parts, messages: o.planMessages && o.planMessages >= 2 ? 2 : 1,
    lengthBand: TAKEUCHI_PURPOSE_FORMS[it.purpose].lengthBand, evidence: (o.evidence ?? []).slice(0, 5),
    check: { mainOnPurpose: true, addsNotEatingMain: true, issues: [] },
  };
  bp.check = checkBlueprint(bp);
  return bp;
}

/** 設計図の段の確かめ: メインの1文が趣旨から外れていないか・添える部分がメインを食っていないか */
export function checkBlueprint(bp: Pick<ComposeBlueprint, "intent" | "parts">): ComposeBlueprint["check"] {
  const issues: string[] = [];
  const it = bp.intent;
  const main = bp.parts.find((p) => p.role === "main");
  const adds = bp.parts.filter((p) => p.role === "add");
  let mainOnPurpose = true;
  if (it.purpose === "ack") {
    if (main || adds.length) { mainOnPurpose = false; issues.push("受けだけの番に中身の部品がある"); }
  } else if (!main || !main.say.trim()) {
    mainOnPurpose = false; issues.push("メインの1文が無い");
  } else {
    const t = main.say;
    const off: Partial<Record<ComposePurpose, RegExp>> = {
      promise: /オススメ|おすすめ|如何でしょうか|お申込/, inform: /させて頂きます$|確認出来次第/, ask: /オススメ|おすすめ/, support: /お申込|内覧/,
    };
    if (off[it.purpose]?.test(t)) { mainOnPurpose = false; issues.push(`メインの1文が趣旨（${COMPOSE_PURPOSE_JA[it.purpose]}）から外れている: ${t.slice(0, 40)}`); }
  }
  let addsNotEatingMain = true;
  if (adds.length > 2) { addsNotEatingMain = false; issues.push(`添えが多い（${adds.length}）`); }
  if (main && adds.some((a) => a.say.length > Math.max(60, main.say.length * 1.5))) { addsNotEatingMain = false; issues.push("添えがメインより長い"); }
  const mi = bp.parts.findIndex((p) => p.role === "main");
  if (mi >= 0 && bp.parts.slice(0, mi).some((p) => p.role === "add")) { addsNotEatingMain = false; issues.push("添えがメインより前にある"); }
  if (it.purpose === "support" && it.adds.includes("appeal")) { addsNotEatingMain = false; issues.push("不安を受け止める番に訴求を添えている"); }
  return { mainOnPurpose, addsNotEatingMain, issues };
}

/** 書き手への注記（設計図・この通りに組む）。網・決まりは部品の中だけで効かせる */
export function blueprintNote(bp: ComposeBlueprint): string {
  const it = bp.intent;
  const roleJa: Record<BlueprintRole, string> = { name_greet: "名前と挨拶", uke: "受け", main: "メインの1文", add: "添え", cta: "誘い", close: "締め" };
  return [
    "",
    "【文の設計図（構成のブレイン・この順と役割で組む・自分で部品を足したり並べ替えたりしない）】",
    `・趣旨: ${COMPOSE_PURPOSE_JA[it.purpose]}（理由: ${it.why || "―"}）${it.feel ? `／お客様に感じてほしい事: ${it.feel}` : ""}`,
    it.purpose !== "ack" ? `・主語: ${({ customer: "お客様のこと", property: "物件", us: "こちら（弊社）がする事", process: "手続き・流れ" } as const)[it.main.subject]}` : "",
    ...bp.parts.map((p, k) => `${k + 1}. ${roleJa[p.role]}: ${p.say}${p.nets?.length ? `（この部品の中の決まり: ${p.nets.join("／")}）` : ""}`),
    `・長さ: ${({ short: "短く（50字前後）", mid: "中くらい（100字前後）", long: "長め（140字前後）" } as const)[bp.lengthBand]}・竹内さんの型: ${TAKEUCHI_PURPOSE_FORMS[it.purpose].seq}`,
    "・メインの1文が一番に伝わるように。添えはメインより短く、メインの後ろに。",
  ].filter(Boolean).join("\n");
}

/** 書き手が設計図から外れたか（決定論の札で見る・記録だけ。統括の決定は決め直さない＝外れは数えて場面ごとに毎晩見る）
 *  2026-11-03 統括「書き手が設計図から外れたら digest に記録・外れが続く場面は毎晩数える」 */
export function blueprintDeviations(draft: string, bp: Pick<ComposeBlueprint, "intent" | "parts">): string[] {
  const out: string[] = [];
  const p = purposeOfText(draft);
  const tags = sentencesOf(draft).map(tagSentence);
  const it = bp.intent;
  if (p.purpose !== it.purpose && !(it.purpose === "ack" && p.purpose === "material")) out.push(`趣旨=${p.purpose}`);
  if (it.purpose !== "appeal" && !it.adds.includes("appeal") && tags.includes("appeal")) out.push("頼んでいない訴求");
  if (it.purpose === "ack" && tags.some((t) => t === "promise" || t === "info" || t === "appeal")) out.push("受けだけの番に中身");
  const wantCta = bp.parts.some((x) => x.role === "cta");
  const hasCta = tags.includes("cta_viewing") || tags.includes("cta_apply");
  if (wantCta && !hasCta) out.push("誘いが無い");
  if (!wantCta && hasCta) out.push("頼んでいない誘い");
  const adds = tags.filter((t) => t === "support").length;
  if (!it.adds.includes("support") && it.purpose !== "support" && adds > 0 && !bp.parts.some((x) => /サポート/.test(x.say))) out.push("頼んでいないサポート");
  return out;
}

/** digest の1行（意図が設計に届いたか・設計が書き手に届いたか・出た文の趣旨が合うか・設計図から外れた所） */
export function composeDigestLine(o: { intent: ComposeIntent | null; blueprint: ComposeBlueprint | null; writerGotNote: boolean; draft?: string | null }): string {
  if (!o.intent) return "compose: 意図なし（ブレインから届かない）";
  const out = o.draft ? purposeOfText(o.draft) : null;
  const dev = o.draft && o.blueprint ? blueprintDeviations(o.draft, o.blueprint) : [];
  return [
    `compose: 趣旨=${o.intent.purpose}(${o.intent.source}/${o.intent.confidence})`,
    `主語=${o.intent.main.subject}`, `添え=${o.intent.adds.join("+") || "なし"}`, `締め=${o.intent.closing}`,
    `設計図=${o.blueprint ? "yes" : "no"}`, `書き手に届いた=${o.writerGotNote ? "yes" : "no"}`,
    o.blueprint && o.blueprint.check.issues.length ? `確かめ=${o.blueprint.check.issues.join("・")}` : "",
    out ? `出た文の趣旨=${out.purpose}${out.purpose === o.intent.purpose ? "（合う）" : "（ずれ）"}` : "",
    dev.length ? `設計図から外れ=${dev.join("・")}` : (o.draft && o.blueprint ? "設計図から外れ=なし" : ""),
  ].filter(Boolean).join(" ");
}

// ── 場面の RAG（takeuchi_compose_examples）の純な部品 ───────────────────────────────
/** 効いた重み: 基本 1・その後のお客様の反応で足す（1時間以内の返信 +0.3／7日以内の内覧 +0.5／14日以内の申込 +0.7） */
export function composeExampleWeight(o: { replyMinutes: number | null; viewing7d: boolean | null; applied14d: boolean | null }): number {
  let w = 1;
  if (o.replyMinutes != null && o.replyMinutes <= 60) w += 0.3;
  if (o.viewing7d) w += 0.5;
  if (o.applied14d) w += 0.7;
  return Math.round(w * 100) / 100;
}
/** 埋め込みの入力（場面×趣旨×お客様の発言の要約）。引く時も同じ形で作る（四者同名） */
export function composeEmbedInput(o: { scene: string; purpose: string; customerGist: string | null; intentWhat?: string | null }): string {
  return [`場面: ${o.scene}`, `趣旨: ${o.purpose}`, o.intentWhat ? `言う事: ${o.intentWhat.slice(0, 120)}` : "", `お客様: ${(o.customerGist ?? "（こちらから）").slice(0, 200)}`].filter(Boolean).join("\n");
}
/** 引いた例を構成の根拠の1行に（本文は写させない＝並びとメインの1文だけ） */
export function composeRagHint(r: { scene: string; purpose: string; seq: string[]; main_line: string; weight: number }): string {
  return `${r.scene}／${r.purpose}: 並び ${r.seq.join("→")}・メインの1文「${r.main_line.slice(0, 80)}」${r.weight > 1 ? `（その後の反応あり ×${r.weight}）` : ""}`;
}

// ── 設計図と二重になる注記を外す口（COMPOSE_DROP_DUPLICATES=on・既定 off・設計図が書き手に渡った番だけ） ─────────────────
// 2026-11-03 作業員6（統括「文に入る物を全部、統括を通す」・一覧は scratchpad の writer-notes-inventory.md）。
//   外すのは設計図の部品（締め・メイン・長さ・全体の形）と同じ事を言う注記だけ。安全の線・材料（事実・会話・台帳）は外さない。
//   stanceNote（姿勢の注記）は締め以外の印も持つので、ここでは外さない（締めの行だけ外す形は次の段）。
export const COMPOSE_DUPLICATE_NOTES = ["closing", "brainGuidance", "direction", "sceneStyle", "writingBlueprint", "ackLength", "sentShape"] as const;
export type ComposeDuplicateNote = typeof COMPOSE_DUPLICATE_NOTES[number];
export function composeDropDuplicatesOn(env: Env = envOf()): boolean {
  return composeBlueprintOn(env) && (env.COMPOSE_DROP_DUPLICATES ?? "").trim().toLowerCase() === "on";
}
/** この注記を外すか（設計図が書き手に渡った番・スイッチ on・COMPOSE_DROP_KEEP に書いた名前は残す） */
export function composeDropsDuplicate(k: ComposeDuplicateNote, composeOn: boolean, env: Env = envOf()): boolean {
  if (!composeOn || !composeDropDuplicatesOn(env)) return false;
  const keep = new Set((env.COMPOSE_DROP_KEEP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return !keep.has(k);
}
