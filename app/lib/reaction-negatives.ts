// app/lib/reaction-negatives.ts — 送った物件へのお客様の反応（「上過ぎる」「狭い」「駅から遠い」「高い」「古い」）とメモを、
//   次の物件の判定（ピックアップ・物件オススメ）に「弱い減点」で返す（純関数・DB/LLM なし・画面とサーバーで共用できる）
//
// 2026-10-20 竹内さん（P1 1a57c6db）「AIX ツールはお客さんの反応（送った物件のここが良い・リビング10帖以上が良い等）に反応して、
//   それに伴って判断も変えているかな？変えている方が質は高くなる」／（P1 db22f3ca）反応は『物件ごと』と『送った束への条件』に分けて、
//   物件検索には弱い扱い（必須にしない）で渡す・どの物件への反応かは決定論で決める（引用 ＞ 1件だけ ＞ 物件名 ＞ 束）。
//
// ■ 何をするか
//   ① readNegativeAttrs: 1通の文から「どの向きの不満か」（floor_high・narrow・far・expensive・old）と強さ（hard＝NG・無理・絶対）を読む
//   ② buildReactionNegatives: 送付のかたまり（30分以内の送付）の後 72時間以内のお客様の発言を、どの物件への反応か決めて
//      「物差しの値」（その物件の階・広さ・徒歩・家賃・築年）付きの不満にする。決まらない物は束の中央値（束への条件＝弱い扱い）。
//      スタッフのメモ（customer_memos の ng・concern・core）も同じ読み方で足す（物件に結べる時はその物件の値・文に数字がある時はその値）
//   ③ reactionCodesFor: 候補の物件の事実と照らして札を返す（REACTION_*_NG 弱い減点・*_HARD 保留・*_OK 少し加点）
//   ④ 物件ごとの反応（気に入った／見送り）は perProperty に残す（送った物件の中から👑を選ぶ時に使う・reactionRowAdjust）
//
// ■ 決まり（竹内さんの決まり・設計知見）
//   ・束への反応は物件の NG にしない（束の中央値を物差しにした弱い減点だけ）
//   ・hard（「NG」「無理」「絶対」と言った）だけ保留（外す候補にはしない）。それ以外は点だけ
//   ・オススメの正誤のラベルにはしない（property_selection_patterns・scoring-learning にはつながない）
//   ・新しい LLM は呼ばない（読めない言い方は拾わない＝外す側に倒れない）
// 戻す: AIX_REACTIONS_LINK=off（2026-10-22 既定 on。scripts/audit-reactions-link.ts 60日: 点の1位が不満に当たる 29→25・上位3件 59→55・通す→保留 0）
// テスト: app/lib/__tests__/reaction-negatives.test.ts

export function reactionsLinkEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return !/^(?:off|0|false)$/i.test((env.AIX_REACTIONS_LINK ?? "").trim());
}

export type ReactionAttr = "floor_high" | "narrow" | "far" | "expensive" | "old";
export const REACTION_ATTRS: readonly ReactionAttr[] = ["floor_high", "narrow", "far", "expensive", "old"];
export const REACTION_ATTR_JA: Record<ReactionAttr, string> = {
  floor_high: "階が上過ぎる", narrow: "狭い", far: "駅から遠い", expensive: "家賃が高い", old: "古い",
};

const n = (s: string) => s.normalize("NFKC");
// 質問（「駅から遠いですか？」）は不満ではない
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか/;
// 受け入れ（「狭くても大丈夫」「古いけどいい」「高いけど気に入った」）は不満ではない
//   2026-10-20 査読: 実データの「古すぎ無ければ大丈夫」（条件の言い方）・「予算はオーバーするのですが、特に上2つは結構好み」も受け入れ
const ACCEPT_RE = /(?:くても|でも|けど|けれど|ですが)[^。\n]{0,14}(?:大丈夫|いい|良い|OK|構わ|気にしな|問題な|気に入|好み)|(?:無|な)ければ[^。\n]{0,4}(?:大丈夫|いい|良い|OK|構わ)/i;
const HARD_RE = /NG|無理|絶対|ありえな|除外|論外/i;

const ATTR_RES: Array<{ attr: ReactionAttr; re: RegExp; not?: RegExp }> = [
  // 階: 「（部屋・階が）上過ぎる」「高層すぎ」「階が高すぎ」「高層は怖い」「もう少し下の階」「低層がいい」
  //   ⚠ 実データ（60日）でただ1つの「上過ぎる」は「〇〇（駅名）は上過ぎる」＝場所が北に寄り過ぎ（エリアの向き）だった → 階・層・部屋の語がある時だけ階と読む
  { attr: "floor_high", re: /(?:階|層|部屋)[^。\n]{0,8}上(?:の階)?(?:過ぎ|すぎ)|上の階(?:過ぎ|すぎ)|高層(?:階)?[^。\n]{0,6}(?:すぎ|過ぎ|怖|こわ|苦手|嫌|NG|無理|避け)|(?:階|階数)[^。\n]{0,4}(?:高すぎ|高過ぎ|怖|こわ|苦手)|(?:もう少し|もっと|もうちょっと)(?:下の階|低い階|低層|下の方)|低層(?:階)?(?:が|の方が|希望|がいい|が良い)|(?:[0-9]{1,2})階(?:以上|より上)[^。\n]{0,4}(?:怖|こわ|嫌|NG|無理|苦手)/i },
  // 広さ: 「狭い」「せまい」「もう少し広い」（収納・キッチン・玄関・ベランダの狭さは部屋の広さではない）
  { attr: "narrow", re: /狭(?:い|すぎ|過ぎ|そう|め|かった|く感じ)|せま(?:い|すぎ|そう)|(?:もう少し|もっと|もうちょっと|少し)広(?:い|め|く)|小さ(?:すぎ|過ぎ)/, not: /(?:収納|クローゼット|キッチン|台所|玄関|ベランダ|バルコニー|お?風呂|浴室|トイレ|洗面|靴箱|駐車|道|通路|廊下|階段)[^。\n]{0,4}(?:狭|せま|小さ|広)/ },
  // 駅から遠い: 駅・徒歩の語と一緒の「遠い」・「もう少し駅近」（職場・実家・学校からの遠さは通勤の話でここでは読まない）
  { attr: "far", re: /(?:駅|徒歩|歩い|歩き)[^。\n]{0,10}(?:遠(?:い|すぎ|過ぎ|そう|め|かった)|かかり(?:すぎ|過ぎ)|長い)|(?:もう少し|もっと|もうちょっと)駅(?:に|から|まで)?近|駅近(?:が|の方が)(?:いい|良い|希望)/, not: /職場|会社|実家|学校|勤務|通勤|大学|保育/ },
  // 家賃: 「家賃が高い」「予算オーバー」「もう少し安く」・物の語が無い「高いですね」（階・初期費用の語がある時は読まない）
  { attr: "expensive", re: /(?:家賃|賃料|値段|金額|お値段|月々|毎月|予算)[^。\n]{0,8}(?:高|オーバー|超え|超えて|厳し|きつ)|予算オーバー|(?:もう少し|もっと|もうちょっと)(?:安(?!心|全|定)|家賃(?:を|が)?(?:抑|下|安))|^[^。\n]{0,6}高(?:い|すぎ|過ぎ|め)(?:です|かな|ですね|な|ね|し|ので|。|$)/, not: /初期費用|敷金|礼金|敷礼|仲介|業者|引っ?越し|保険|鍵交換|階|層|天井|日当|見積|可能性|確率|順位|評価|レベル|期待|人気|倍率|審査|意識|満足/ },
  // 築年: 「古い」「古そう」「もう少し新しい」「築年数が気になる」
  { attr: "old", re: /古(?:い|すぎ|過ぎ|そう|め|かった|く感じ)|(?:もう少し|もっと|もうちょっと)新し|築(?:年数)?[^。\n]{0,6}(?:古|気にな|経って|経ってる)/, not: /古くて(?:も|いい)/ },
];

/** 1通（またはメモ1行）の文から、不満の向きと強さを読む。質問・受け入れの言い方は読まない */
export function readNegativeAttrs(text: string | null | undefined): Array<{ attr: ReactionAttr; hard: boolean }> {
  const out: Array<{ attr: ReactionAttr; hard: boolean }> = [];
  const t = n(String(text ?? "")).replace(/https?:\/\/\S+/g, "");
  if (!t.trim()) return out;
  // 画像の読み取りの文・条件のフォーム（「①【ご入居の時期】⇒…」）は反応ではない（条件は条件の読み取りが見る）
  if (/^\s*\[(?:画像|ファイル|スタンプ)/.test(t) || /【[^】]{1,14}】\s*(?:⇒|→|:)/.test(t) || /①[^②]{0,120}②[^③]{0,120}③/.test(String(text))) return out;
  for (const clause of t.split(/[。！!\n]+/).map((s) => s.trim()).filter(Boolean)) {
    if (QUESTION_RE.test(clause) || ACCEPT_RE.test(clause)) continue;
    const inClause = ATTR_RES.filter(({ re, not }) => re.test(clause) && !(not && not.test(clause))).map((x) => x.attr);
    for (const attr of inClause) {
      // 階の「高い」は家賃の「高い」と取り合わない（階の語がある節は floor_high だけ）
      if (attr === "expensive" && inClause.includes("floor_high")) continue;
      const hard = HARD_RE.test(clause);
      const prev = out.find((x) => x.attr === attr);
      if (prev) { prev.hard ||= hard; continue; }
      out.push({ attr, hard });
    }
  }
  return out;
}

// 物件ごとの反応（送った物件の中から👑を選ぶ時の材料）
const GOOD_RE = /気に入(?:り|っ|る)|いいですね|良いですね|良さそう|よさそう|いい感じ|良い感じ|素敵|理想|(?:内覧|内見|見学)(?:したい|希望|させて|お願い)|見に行(?:きたい|けますか)|申し?込(?:みたい|みます|もう)|ここ(?:が|に)(?:いい|良い)|こちら(?:が|に)(?:いい|良い)/;
const GOOD_NOT_RE = /気に入(?:ら|りませ)|好きじゃ|好きでは/;
const DECLINE_RE = /(?:ここ|こちら|この(?:物件|お部屋|部屋)|そちら)(?:の物件)?(?:は|も)?[^。！!？?\n]{0,6}(?:やめ|なし|ナシ|パス|見送|遠慮|結構です)|見送り|イメージと(?:違|ちが)|ピンとこ|好みじゃ|気に入(?:ら|りませ)/;

export type RxProp = {
  /** 見分け（normalizeBuildingName(建物)＋"|"＋号室） */
  key: string;
  /** 物件名（建物名。本文に名前が出たかの照合に使う） */
  name: string;
  floor: number | null;
  /** 家賃＋管理費（円） */
  rentTotal: number | null;
  areaSqm: number | null;
  walk: number | null;
  age: number | null;
  /** 送った画像（引用返信の照合） */
  imageUrls?: string[];
};
export type RxSend = { conv: string; at: string; props: RxProp[] };
export type RxMsg = { conv: string; at: string; text: string | null; quotedImageUrl?: string | null };
export type RxMemo = { kind: string; text: string; property?: string | null; at: string | null; retired?: boolean; expiresAt?: string | null };

export type ReactionNegative = {
  attr: ReactionAttr;
  /** 物差しの値（階・㎡・分・円・年）。無い物は札にしない */
  ref: number | null;
  hard: boolean;
  /** property＝物件に結べた・bundle＝束の中央値・memo＝メモから */
  scope: "property" | "bundle" | "memo";
  at: string;
  /** 結べた物件の見分け（scope=property の時） */
  propKey?: string | null;
};
export type PropReaction = { good: boolean; declined: boolean; attrs: ReactionAttr[]; at: string };
export type ReactionState = { negatives: ReactionNegative[]; perProperty: Record<string, PropReaction> };

export const REACTION_RULE = {
  /** 送付のかたまり（この分以内の送付は1つの束） */
  blockMinutes: 30,
  /** 送ってからこの時間以内のお客様の発言を反応として読む */
  replyHours: 72,
  /** これより古い反応は使わない（日） */
  maxAgeDays: 60,
};

const VALUE_OF: Record<ReactionAttr, (p: RxProp) => number | null> = {
  floor_high: (p) => p.floor, narrow: (p) => p.areaSqm, far: (p) => p.walk, expensive: (p) => p.rentTotal, old: (p) => p.age,
};
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const nameKey = (s: string) => n(s).replace(/[\s　・･\-－ー()（）]/g, "").toLowerCase();

/** メモの文の数字（「5階以上は怖い」→5・「8万円まで」→80000・「徒歩10分」→10・「25㎡」→25・「築20年」→20） */
export function memoRefOf(attr: ReactionAttr, text: string): number | null {
  const t = n(text);
  let m: RegExpMatchArray | null;
  if (attr === "floor_high" && (m = t.match(/([0-9]{1,2})階/))) return Number(m[1]);
  if (attr === "expensive" && (m = t.match(/([0-9]{1,2}(?:\.[0-9])?)万/))) return Math.round(Number(m[1]) * 10000);
  if (attr === "far" && (m = t.match(/([0-9]{1,2})分/))) return Number(m[1]);
  if (attr === "narrow" && (m = t.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*(?:㎡|m2|平米)/))) return Number(m[1]);
  if (attr === "old" && (m = t.match(/築\s*([0-9]{1,2})\s*年/))) return Number(m[1]);
  return null;
}

/** どの物件への反応か（引用 ＞ 1件だけ ＞ 物件名）。決まらなければ null（束） */
export function resolveTarget(msg: RxMsg, props: readonly RxProp[]): RxProp | null {
  if (msg.quotedImageUrl) {
    const hit = props.find((p) => (p.imageUrls ?? []).includes(msg.quotedImageUrl as string));
    if (hit) return hit;
  }
  if (props.length === 1) return props[0];
  const t = nameKey(String(msg.text ?? ""));
  const named = props.filter((p) => { const k = nameKey(p.name); return k.length >= 3 && t.includes(k.slice(0, Math.min(6, k.length))); });
  return named.length === 1 ? named[0] : null;
}

/** 送付と発言とメモから、反応の不満と物件ごとの反応を作る（now は判定する時刻） */
export function buildReactionNegatives(input: { sends: readonly RxSend[]; msgs: readonly RxMsg[]; memos?: readonly RxMemo[]; now: string | Date }, rule = REACTION_RULE): ReactionState {
  const nowMs = typeof input.now === "string" ? Date.parse(input.now) : input.now.getTime();
  const minMs = nowMs - rule.maxAgeDays * 86_400_000;
  const negatives: ReactionNegative[] = [];
  const perProperty: Record<string, PropReaction> = {};
  // 会話ごとの送付のかたまり
  const byConv = new Map<string, RxSend[]>();
  for (const s of input.sends) { if (!byConv.has(s.conv)) byConv.set(s.conv, []); byConv.get(s.conv)!.push(s); }
  const blocks = new Map<string, Array<{ start: number; end: number; props: RxProp[] }>>();
  for (const [conv, ss] of byConv) {
    const sorted = [...ss].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const out: Array<{ start: number; end: number; props: RxProp[] }> = [];
    for (const s of sorted) {
      const t = Date.parse(s.at);
      const last = out[out.length - 1];
      if (last && t - last.end <= rule.blockMinutes * 60_000) {
        last.end = t;
        for (const p of s.props) if (!last.props.some((x) => x.key === p.key)) last.props.push(p);
      } else out.push({ start: t, end: t, props: [...s.props] });
    }
    blocks.set(conv, out);
  }
  for (const m of input.msgs) {
    const t = Date.parse(m.at);
    if (!Number.isFinite(t) || t < minMs || t > nowMs) continue;
    const bs = blocks.get(m.conv) ?? [];
    let block: { start: number; end: number; props: RxProp[] } | null = null;
    for (const b of bs) if (b.end < t) block = b;
    if (!block || t - block.end > rule.replyHours * 3_600_000 || !block.props.length) continue;
    const text = String(m.text ?? "");
    const attrs = readNegativeAttrs(text);
    const target = resolveTarget(m, block.props);
    const nt = n(text);
    if (target) {
      const good = GOOD_RE.test(nt) && !GOOD_NOT_RE.test(nt);
      const declined = DECLINE_RE.test(nt);
      if (good || declined || attrs.length) {
        const prev = perProperty[target.key];
        perProperty[target.key] = {
          good: (prev?.good ?? false) || (good && !declined),
          declined: (prev?.declined ?? false) || declined,
          attrs: [...new Set([...(prev?.attrs ?? []), ...attrs.map((a) => a.attr)])],
          at: m.at,
        };
      }
    }
    for (const a of attrs) {
      const ref = target ? VALUE_OF[a.attr](target) : median(block.props.map(VALUE_OF[a.attr]).filter((v): v is number => v != null));
      negatives.push({ attr: a.attr, ref, hard: a.hard, scope: target ? "property" : "bundle", at: m.at, propKey: target?.key ?? null });
    }
  }
  // スタッフのメモ（NG・気にしている事・芯）
  const allProps = input.sends.flatMap((s) => s.props);
  for (const memo of input.memos ?? []) {
    if (memo.retired || !["ng", "concern", "core"].includes(memo.kind)) continue;
    if (memo.expiresAt && Date.parse(memo.expiresAt) < nowMs) continue;
    const at = memo.at ?? new Date(nowMs).toISOString();
    for (const a of readNegativeAttrs(memo.text)) {
      const prop = memo.property ? allProps.find((p) => nameKey(String(memo.property)).includes(nameKey(p.name).slice(0, 6)) && nameKey(p.name).length >= 3) ?? null : null;
      const ref = memoRefOf(a.attr, memo.text) ?? (prop ? VALUE_OF[a.attr](prop) : null);
      negatives.push({ attr: a.attr, ref, hard: a.hard, scope: "memo", at, propKey: prop?.key ?? null });
    }
  }
  return { negatives, perProperty };
}

// ─── 札 ───
export const REACTION_POINTS: Record<string, number> = {
  REACTION_FLOOR_HIGH_NG: -8, REACTION_NARROW_NG: -8, REACTION_FAR_NG: -8, REACTION_EXPENSIVE_NG: -8, REACTION_OLD_NG: -6,
  REACTION_FLOOR_HIGH_HARD: -15, REACTION_NARROW_HARD: -15, REACTION_FAR_HARD: -15, REACTION_EXPENSIVE_HARD: -15, REACTION_OLD_HARD: -15,
  REACTION_FLOOR_HIGH_OK: 4, REACTION_NARROW_OK: 4, REACTION_FAR_OK: 4, REACTION_EXPENSIVE_OK: 4, REACTION_OLD_OK: 3,
  // 送った物件の中から👑を選ぶ時だけ（reactionRowAdjust）
  REACTION_PROP_GOOD: 12, REACTION_PROP_DECLINED: -25,
};
export const REACTION_JA: Record<string, string> = {
  ...Object.fromEntries(REACTION_ATTRS.flatMap((a) => [
    [`REACTION_${a.toUpperCase()}_NG`, `お客様の反応「${REACTION_ATTR_JA[a]}」に当たる（前に送った物件と同じか悪い）`],
    [`REACTION_${a.toUpperCase()}_HARD`, `お客様が NG と言った「${REACTION_ATTR_JA[a]}」に当たる（保留）`],
    [`REACTION_${a.toUpperCase()}_OK`, `お客様の反応「${REACTION_ATTR_JA[a]}」を解消（前に送った物件より良い）`],
  ])),
  REACTION_PROP_GOOD: "お客様がこの物件に前向きな反応（送った物件の中から推す）",
  REACTION_PROP_DECLINED: "お客様がこの物件を見送った",
};
export const REACTION_HOLD_CODES = new Set(REACTION_ATTRS.map((a) => `REACTION_${a.toUpperCase()}_HARD`));

export type RxCandidate = { floor: number | null; rentTotal: number | null; areaSqm: number | null; walk: number | null; age: number | null };

/** 向きごとに一番新しい不満を1つ（物差しのある物だけ） */
export function latestNegatives(negs: readonly ReactionNegative[]): ReactionNegative[] {
  const out = new Map<ReactionAttr, ReactionNegative>();
  for (const x of negs) {
    if (x.ref == null) continue;
    const prev = out.get(x.attr);
    if (!prev || Date.parse(x.at) >= Date.parse(prev.at)) out.set(x.attr, { ...x, hard: x.hard || (prev?.hard ?? false) });
  }
  return [...out.values()];
}

/** 候補の物件と照らした札（値が分からない向きは何も付けない） */
export function reactionCodesFor(c: RxCandidate, negs: readonly ReactionNegative[]): string[] {
  const codes: string[] = [];
  for (const x of latestNegatives(negs)) {
    const ref = x.ref as number;
    const A = x.attr.toUpperCase();
    let bad: boolean | null = null, good = false;
    if (x.attr === "floor_high" && c.floor != null) { bad = c.floor >= ref; good = c.floor < ref; }
    else if (x.attr === "narrow" && c.areaSqm != null) { bad = c.areaSqm <= ref * 1.02; good = c.areaSqm >= ref * 1.1; }
    else if (x.attr === "far" && c.walk != null) { bad = c.walk >= ref; good = c.walk <= ref - 2; }
    else if (x.attr === "expensive" && c.rentTotal != null) { bad = c.rentTotal >= ref * 0.98; good = c.rentTotal <= ref * 0.95; }
    else if (x.attr === "old" && c.age != null) { bad = c.age >= ref - 1; good = c.age <= ref - 5; }
    if (bad == null) continue;
    if (bad) codes.push(`REACTION_${A}_${x.hard ? "HARD" : "NG"}`);
    else if (good) codes.push(`REACTION_${A}_OK`);
  }
  return codes;
}

/**
 * 保存済みの行（property_pickups）の点に反応の札を足し直す（送った物件の中から👑を選ぶ時・送った後に来た反応を入れる）。
 *   前の REACTION_* は外してから付け直す。key が perProperty にあれば気に入った／見送りの札も付ける
 */
export function reactionRowAdjust(
  row: { score?: number | null; verdict?: string | null; reason_codes?: string[] | null },
  c: RxCandidate, key: string | null, state: ReactionState,
): { score: number | null; verdict: string | null; reason_codes: string[] } {
  const old = (row.reason_codes ?? []).filter((x) => !x.startsWith("REACTION_"));
  const before = (row.reason_codes ?? []).filter((x) => x.startsWith("REACTION_")).reduce((a, x) => a + (REACTION_POINTS[x] ?? 0), 0);
  const add = reactionCodesFor(c, state.negatives);
  const pr = key ? state.perProperty[key] : undefined;
  if (pr?.declined) add.push("REACTION_PROP_DECLINED");
  else if (pr?.good) add.push("REACTION_PROP_GOOD");
  const delta = add.reduce((a, x) => a + (REACTION_POINTS[x] ?? 0), 0) - before;
  const score = row.score == null ? null : Math.max(0, row.score + delta);
  const hold = add.some((x) => REACTION_HOLD_CODES.has(x)) || add.includes("REACTION_PROP_DECLINED");
  const verdict = hold && (row.verdict ?? "pass") === "pass" ? "hold" : (row.verdict ?? null);
  return { score, verdict, reason_codes: [...old, ...add] };
}
