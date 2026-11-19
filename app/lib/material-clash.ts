// app/lib/material-clash.ts — 材料どうしの食い違いの見張り（純関数・LLM なし・DB なし・記録だけ）
//
// 2026-11-15 作業員L（統括の土台②・KB 878a2f0b q091・c6e35b5d）。
//   q091 の型: 竹内さんの決定（★の決まり・【まだ果たしていないこちらの約束】＝お礼・了承だけなら約束を果たす AIX）を、
//   別の材料（【前の約束への了承】＝竹内さんの実送信の返信の形の並びだけで道を言わない／ルール⑥「aix は null」）が打ち消していた。
//   材料が食い違うと LLM は割れる（KB c6e35b5d「材料が食い違っていると LLM は古い方に寄る」）。
// 何をするか: ブレインに渡す材料の塊（brain-core が組み立てた system と user の文）を【見出し】ごとに切り、文ごとに
//   「道（返信か AIX か約束か）について何と言っているか」を決まった形で読む。条件つきの文（〜なら・〜の場合・〜の番は）は、
//   この番の形（お礼・了承だけ／問いがある）で当てはまるかを決める。そのうえで
//   ① 道について逆を言う塊の組（AIX × 返信・AIX × 約束）
//   ② 形だけを並べて道を言わない塊（返信の形・受けだけ・待ちの形の数の並び）が、道を言う決まりの塊（★・竹内さんの決定）と同じ番に出ている
//   を見つける。
// 置き方: BRAIN_MATERIAL_CLASH=shadow の時だけ brain-core が meta.material_clash に入れる（既定 off）。道・材料・下書きは変えない（プロンプトに1文字も足さない）。
//   記録は brain_decision_logs.digest.mcl（materialClashDigest）。試験の答案での数えは scripts/audit-material-clash.ts（録音の入力に当てる）。
// 限界（決まった形の読み）: 道の言葉の網と条件の網で読む。条件の中身が網で決まらない文は weak（弱い）として別に数え、組の本数（yes）には入れない。
//   いつも出る手順の塊（返信か AIX かの決め方・ボタンの一覧・アクション別ルール 等）は、全部の番に同じ文が出て食い違いの見分けにならないので外す。
//   system の文は、条件がこの番に当てはまった文（yes）だけ数える（条件なし・条件が決まらない system の文は全部の番に出るので外す）。
//   括弧の中（数の内訳・出所の但し書き）は道の言葉として読まない。

export type ClashStance = "aix" | "reply" | "promise";
export type ClashLevel = "yes" | "weak";
export type TurnShape = "ack" | "question" | "other";
/** この番の状況のうち、条件の当てはまりに使う物（決まった形で拾う） */
export type TurnCtx = { shape: TurnShape; openPromise: boolean };
export type StanceHit = { block: string; stance: ClashStance; level: ClashLevel; decision: boolean; quote: string };
/** dyn＝どちらかがこの番の材料の塊（user）。system どうしの組は番の形で決まる決まりの食い違い（全部のお礼の番に出る）＝別に数える */
export type OpposedPair = { a: string; b: string; kind: "aix_reply" | "aix_promise"; level: ClashLevel; dyn: boolean };
export type MaterialClash = {
  v: 1;
  turn: TurnShape;
  /** 道を言った塊（塊×向き×確かさの重なりは1つに） */
  stances: StanceHit[];
  /** ① 道について逆を言う塊の組（yes×yes は level=yes・どちらかが weak なら weak） */
  opposed: OpposedPair[];
  /** ② 形だけを並べて道を言わない塊（同じ番に道を言う決まりの塊がある時だけ）と、その決まりの塊 */
  shapeNoRoute: Array<{ block: string; with: string[] }>;
};

type Env = Record<string, string | undefined>;
/** 既定 off。shadow で記録（on と書いても記録だけ＝同じ。道を変える形は作らない） */
export function materialClashMode(env: Env = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" {
  const v = (env.BRAIN_MATERIAL_CLASH ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}

/** いつも出る手順・一覧・出力の指定・会話の要約の塊（全部の番に出る＝見分けにならない）。見出しの頭で比べる */
const PROCEDURE_HEADS = [
  "返信か AIX かの決め方", "AIX のボタン×ピッカー", "アクション別ルール", "今回の発言の分析モード", "テンプレート候補", "記録用・判断は変えない",
  "顧客プロファイル", "顧客の会話ストーリー", "前回の全体分析", "時間情報", "今日の挨拶", "⏱ 送信と返信のバランス", "成約実績・次打ちマップ",
  "会話全体で使用済みのAIXアクション", "関連ナレッジ",
];
const isProcedure = (head: string) => PROCEDURE_HEADS.some((h) => head.startsWith(h));

/** 見出しの名前（括弧の中・日付の伏せ字を外す） */
export function blockName(headLine: string): string {
  const m = headLine.match(/^【([^】]{1,60})】?/);
  const raw = m ? m[1] : headLine.slice(0, 30);
  return raw.replace(/<[^>]+>/g, "").replace(/[（(].*$/, "").trim() || raw.trim();
}

export type Block = { name: string; text: string; from: "system" | "user" };
/** 【見出し】で始まる行ごとに切る。会話の行（[顧客 …] [スタッフ …] [AIX …]）は塊に入れない */
export function splitBlocks(text: string, from: "system" | "user"): Block[] {
  const out: Block[] = [];
  let cur: Block = { name: from === "system" ? "system:前置き" : "前置き", text: "", from };
  for (const line of text.split(/\r?\n/)) {
    if (/^\[(顧客|スタッフ|AIX|お客様|担当)[^\]]*\]/.test(line)) continue;
    if (/^【[^】]{1,60}/.test(line)) {
      if (cur.text.trim()) out.push(cur);
      const nm = blockName(line);
      cur = { name: from === "system" ? `system:${nm}` : nm, text: line + "\n", from };
    } else cur.text += line + "\n";
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

/** この番の形: 会話の最後のこちらの行より後のお客様の行から（お礼・了承だけ／問いがある／他） */
export function turnShapeOf(userText: string): TurnShape {
  const lines = userText.split(/\r?\n/);
  let lastOurs = -1;
  lines.forEach((l, i) => { if (/^\[(スタッフ|AIX|担当)[^\]]*\]/.test(l)) lastOurs = i; });
  const cust = lines.slice(lastOurs + 1).filter((l) => /^\[(顧客|お客様)[^\]]*\]/.test(l)).map((l) => l.replace(/^\[[^\]]*\]\s*/, ""));
  // 材料の塊が言う形も見る（【前の約束への了承】の「お客様の今の発言: 了承だけ」）
  const ackMark = /お客様の今の発言[:：]\s*(?:了承だけ|お礼だけ|お礼・了承だけ)/.test(userText);
  if (!cust.length) return ackMark ? "ack" : "other";
  const t = cust.join(" ").replace(/https?:\S+/g, "").trim();
  if (/[？?]/.test(t)) return "question";
  const ackWords = /ありがと|宜しく|よろしく|お願いします|お願い致します|分かりました|わかりました|了解|承知|かしこまりました|はい|大丈夫です|助かります/;
  if ((t.length <= 60 && ackWords.test(t)) || ackMark) return "ack";
  return "other";
}

// 道の言葉（文ごと）。順番に見て最初に当たった向きを取る（約束を果たす AIX → 約束 → 返信 → AIX）
const RE_AIX_STRONG = /約束を果たす\s*AIX|AIX\s*の番(?!でも)/;
const RE_PROMISE = /約束の返信|(?:まず|先に)[^。]{0,24}約束(?:の返信|する|に|で)|約束(?:にする|で返す|を返す|で受ける)|route\s*は\s*promise|route=promise|2段にする|2段の返信/;
const RE_REPLY = /aix\s*(?:フィールド)?\s*(?:は|を|=|＝|[:：])\s*\**\s*null|"aix"\s*:\s*null|AIX[^。]{0,14}(?:出さない|選ばない|使わない|押さない|不要|ではない)|AIX(?:（[^）]*）)?も[^。]{0,30}出さず|返信で(?:締め|閉じ|答え|受け|済ませ)|返信にする|返信の番|返信が先|返信（AIX\s*なし）|AIX\s*なし|AIXなし|本文で答える/;
const RE_AIX = /AIX(?:【[^】]{1,20}】)?\s*(?:を|で|に)\s*(?:直接|選ぶ|送る|押す|果たす)|AIX【[^】]{1,20}】(?:を|で)?(?:直接|選ぶ|送る|押す)|aix\s*(?:は|=|＝|[:：])\s*["「]?[a-z]+_[a-z_]+/;
const stanceOf = (s: string): ClashStance | null => (RE_AIX_STRONG.test(s) ? "aix" : RE_PROMISE.test(s) ? "promise" : RE_REPLY.test(s) ? "reply" : RE_AIX.test(s) ? "aix" : null);

/** 条件の部分（文の頭から 80字の中の 〜なら・〜の場合・〜の番は・〜の時は・→ の前） */
const RE_COND = /^(.{0,80}?)(?:なら[、,]?|ならば|場合(?:は)?|番でも|番は|時は|時だけ|とき(?:は)?|→)/;
/** 打ち消しの句（「質問・要望・懸念を含まない」等）は条件の向きから外す */
const stripNeg = (s: string) => s.replace(/[^、。（）「」]{0,20}(?:含まない|含まず|無い|ない|なし)/g, "");
const ACK_COND = /お礼|了承|感謝|ありがとう|かしこまりました|承知/;
const Q_COND = /新しい問い|問い|質問|ご事情|聞かれ/;
/** 問いの条件のうち、話題を問わない形（「新しい問い・ご事情を書いた番」）だけ当てはまりを決める。「費用の質問」「物件の質問」等の話題つきは網で決まらない＝weak */
const Q_COND_GENERIC = /新しい問い|ご事情|問いを書いた|質問・依頼|質問や依頼/;
/** 「約束の直後」「約束が残る」等＝まだ果たしていない約束がある時だけ当てはまる */
const PROMISE_COND = /約束(?:の直後|の後|が残|を果たして|への了承)|ピックアップ・確認・見積|確認・見積の約束/;

function condLevel(cond: string, ctx: TurnCtx): ClashLevel | null {
  const c = stripNeg(cond);
  const turn = ctx.shape;
  if (PROMISE_COND.test(c) && !ctx.openPromise) return null;
  const ack = ACK_COND.test(c), q = Q_COND.test(c);
  if (ack && !q) return turn === "ack" ? "yes" : null;
  if (q && !ack) return turn === "ack" ? null : turn === "question" && Q_COND_GENERIC.test(c) ? "yes" : "weak";
  return "weak";
}

const unparen = (s: string) => s.replace(/（[^（）]*）/g, "").replace(/（[^（）]*）/g, "");

/** 1つの塊から、道を言った文を読む */
export function stancesOfBlock(b: Block, ctx: TurnCtx): StanceHit[] {
  if (isProcedure(b.name.replace(/^system:/, ""))) return [];
  const decisionBlock = /★|竹内さんの決定/.test(b.text.slice(0, 200));
  const out: StanceHit[] = [];
  for (const line of b.text.split(/\r?\n/)) {
    // system の決まりは「ルール⑥（…）:」の頭の名前で分ける（1つの見出しの下に決まりが並ぶ）
    const rule = b.from === "system" ? line.match(/^\s*(ルール[①-⑳0-9０-９]+)/)?.[1] : undefined;
    const unit = rule ? `system:${rule}` : b.name;
    let inherited: ClashLevel | null | undefined; // 同じ行の前の文の条件を引き継ぐ（ルール⑥「…の場合 → …。aix は null にする」）
    for (const sent of line.split(/(?<=。)/)) {
      const s0 = sent.trim();
      if (!s0) continue;
      const s = unparen(s0);
      const cm = s.match(RE_COND);
      let level: ClashLevel | null;
      if (cm) { level = condLevel(cm[1], ctx); inherited = level; }
      else if (inherited !== undefined) level = inherited;
      else level = b.from === "system" ? null : /人だけが知る|スタッフだけが知る|スタッフしか/.test(s) ? "weak" : "yes";
      if (!level || (b.from === "system" && level !== "yes")) continue; // system は条件がこの番に当てはまった文だけ
      const stance = stanceOf(s);
      if (!stance) continue;
      const decision = decisionBlock || /★|竹内さんの決定/.test(s0);
      const same = out.find((y) => y.block === unit && y.stance === stance && y.level === level);
      if (!same) out.push({ block: unit, stance, level, decision, quote: Array.from(s0).slice(0, 60).join("") });
      else if (decision) same.decision = true;
    }
  }
  return out;
}

/** 形だけを並べる塊（返信の形・受けだけ・待ちの形 等の数の並び）か。道の言葉が1つも無い時だけ true */
const RE_SHAPE = /受けだけ|待ちの形|返信の形|形の並び|締めの形|ack_form|receive_only|wait_line|言い回しの型/g;
export function isShapeOnlyBlock(b: Block): boolean {
  if (b.from === "system" || isProcedure(b.name)) return false;
  const shapeHits = (b.text.match(RE_SHAPE) ?? []).length;
  const hasCounts = /\d+\s*[・／/）)]|\d+\s*(?:件|通|回)/.test(b.text);
  if (shapeHits < 2 || !hasCounts) return false;
  return !b.text.split(/(?<=。)|\r?\n/).some((s) => stanceOf(unparen(s)) !== null || /道は|route\s*は/.test(s));
}

const OPP: Array<[ClashStance, ClashStance, OpposedPair["kind"]]> = [["aix", "reply", "aix_reply"], ["aix", "promise", "aix_promise"]];

/** 本体: system と user の文 → 食い違い */
export function detectMaterialClash(input: { system: string; user: string }): MaterialClash {
  const turn = turnShapeOf(input.user);
  const userBlocks = splitBlocks(input.user, "user");
  const ctx: TurnCtx = { shape: turn, openPromise: userBlocks.some((b) => b.name.startsWith("まだ果たしていないこちらの約束")) || /お客様の今の発言[:：]s*了承だけ/.test(input.user) };
  const blocks = [...splitBlocks(input.system, "system"), ...userBlocks];
  const stances = blocks.flatMap((b) => stancesOfBlock(b, ctx));
  const opposed: OpposedPair[] = [];
  for (const [x, y, kind] of OPP) {
    for (const a of stances.filter((s) => s.stance === x)) for (const b of stances.filter((s) => s.stance === y)) {
      if (a.block === b.block) continue;
      const level: ClashLevel = a.level === "yes" && b.level === "yes" ? "yes" : "weak";
      const same = opposed.find((o) => o.a === a.block && o.b === b.block && o.kind === kind);
      if (!same) opposed.push({ a: a.block, b: b.block, kind, level, dyn: !a.block.startsWith("system:") || !b.block.startsWith("system:") });
      else if (level === "yes") same.level = "yes";
    }
  }
  const decisionBlocks = [...new Set(stances.filter((s) => s.decision && s.level === "yes").map((s) => s.block))];
  const shapeNoRoute = decisionBlocks.length ? blocks.filter(isShapeOnlyBlock).map((b) => ({ block: b.name, with: decisionBlocks.filter((d) => d !== b.name) })).filter((x) => x.with.length) : [];
  return { v: 1, turn, stances, opposed, shapeNoRoute };
}

/** digest.mcl の短い形（o＝逆の組 yes でこの番の材料の塊を含む数・os＝system どうしの yes の数・w＝weak の数・s＝形だけの塊の数・t＝番の形の頭文字・p＝最初の組の名前 40字） */
export function materialClashDigest(m: unknown): { o: number; os: number; w: number; s: number; t: string; p?: string } | null {
  if (!m || typeof m !== "object") return null;
  const c = m as Partial<MaterialClash>;
  if (!Array.isArray(c.opposed) || !Array.isArray(c.shapeNoRoute)) return null;
  const yes = c.opposed.filter((o) => o.level === "yes" && o.dyn !== false);
  const sysYes = c.opposed.filter((o) => o.level === "yes" && o.dyn === false);
  const first = yes[0] ?? sysYes[0];
  const out: { o: number; os: number; w: number; s: number; t: string; p?: string } = { o: yes.length, os: sysYes.length, w: c.opposed.filter((o) => o.level === "weak").length, s: c.shapeNoRoute.length, t: String(c.turn ?? "other")[0] };
  if (first) out.p = Array.from(`${first.a}×${first.b}`).slice(0, 40).join("");
  else if (c.shapeNoRoute[0]) out.p = Array.from(`形:${c.shapeNoRoute[0].block}`).slice(0, 40).join("");
  return out;
}
