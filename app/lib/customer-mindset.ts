// app/lib/customer-mindset.ts — お客様の「状態」（お部屋探しに特化した気持ち）・迷いの中身・決め手の残り（純関数・DB/LLM なし）
//
// 2026-10-09 竹内さん:
//   「ブレインはその状況でのお客さんの反応によって感情を読み取れるようになっているか…状況と感情を理解して、それに合った考察をして AIX-META を作る」
//   「感情は一般の前向き/不安/迷いではなく、この LINE（お部屋探し）に特化した状態で。不安も語だけでなく本質（何が不安か・向き）で」
//   ①状態は 12種（気持ち11＋普通の依頼・不安には向き）で確定 ②ブレインの7択の気持ちは出さず mindset に置き換える
//   ④迷いは中身で細分化 ／「あと1点で決まる（決め手の残り）」＝解き方で3つ (a)確かめる (b)交渉・見積 (c)別の物件
//   「確認して問題無ければ決まる、も重要な発想」→「〇〇なら決める」と「前向き＋(a)の残り1点」は刺さりの最上位の印
//   決め手の残りはメモとブレインの両方に同じ値で置く（この関数の出力を両方が使う）
//
// ■ 実データ（scripts/audit-customer-mindset.ts・竹内さんの番＝staff_writer=takeuchi・申込の書類の手前で切る・数字は相関＝弱い参考）
//   60日 674番（DeepSeek で状態を付けて目で確かめた）:
//   ・本番のブレインの気持ちは4択（前向き/普通/不安/冷めかけ）。前向きな不安（審査・先に取られる）54番は 前向き43%/不安31%/普通26% に割れていた（向きが無い）
//   ・審査の不安 → 竹内さんは安心の一文 54%（他の状態 1〜11%）・申込の誘い 0%／先に取られる不安 → 申込の誘い 33%
//   迷いの細分（180日 99番・会話ごとの最初の番で数え直し）:
//   ・複数物件で迷う 22: 内覧の誘いの後 内覧 0/4・申込 3/4、申込の誘いの後 申込 3/4 → 竹内さんの決定（10/09）「1件を推す・抑えるのを提案する」
//   ・急がない・保留 13: 扉（ご検討・いつでも）76%・内覧14日 58%（1会話が4番）／家族・同居人に相談 6: 扉 75%・申込 0%
//   ・内覧してから決めたい 10: 内覧の誘い・AIX内覧調整・内覧14日 78%／他社と比べる 10: 別の物件を探す・確認の約束
//   決め手の残り（60日 674番・DeepSeek）: 読める番 276（41%）・前向きで物件が分かる 103（54会話）申込30日 46%（普段 30%）
//   ・(a)確かめる 85番 申込 49% ／(b)交渉・見積 73番 16% ／(c)別の物件 30番 22%
//   ・室内・実物 40: 内覧調整 66%・室内写真 25%（写真の後の申込 82%・11番）
//   「〇〇なら決める」の言い方（120日・全会話）: 19通・申込30日 47%（お客様の通全体 35%）
//   確認の AIX（竹内さん 53通）: 結果が問題無し 26 → 同じ文で申込・抑える提案 4（申込 3/4）・締めなし 21（申込 42%）
//
// 切り替え（2026-10-09 既定は全部 off・on で入る）: CUSTOMER_MINDSET=on（ブレインの出力を mindset に）／DECIDE_GAP=on（決め手の残りの注記・メモの行・刺さりの印）／
//       DECIDE_GAP_HOLD_CLOSE=on（確認の結果の締め・DECIDE_GAP=on も要る）／HESITATION_NOTE=on（迷いの中身の注記）／MINDSET_REPLY_LINES=on（返信の任意の1行の材料）
// テスト: app/lib/__tests__/customer-mindset.test.ts（実物の発言・伏せ字）

const envOf = (env?: Record<string, string | undefined>) => env ?? (typeof process !== "undefined" ? process.env : {});
const off = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "off";
// 2026-10-09 竹内さん「本番に入れていく」: 試験・YUMA で確かめるまで既定は off（=on で入る）。off の時はブレインのプロンプト・注記・文は今までと1文字も変わらない
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
export function customerMindsetEnabled(env?: Record<string, string | undefined>): boolean { return on(envOf(env).CUSTOMER_MINDSET); }
export function decideGapEnabled(env?: Record<string, string | undefined>): boolean { return on(envOf(env).DECIDE_GAP); }
export function decideGapHoldCloseEnabled(env?: Record<string, string | undefined>): boolean { return decideGapEnabled(env) && on(envOf(env).DECIDE_GAP_HOLD_CLOSE); }
export function hesitationNoteEnabled(env?: Record<string, string | undefined>): boolean { return on(envOf(env).HESITATION_NOTE); }

// ─── 状態（12種） ──────────────────────────────────────────────────────────
export const MINDSET_STATES = [
  "刺さっている", "興味が薄い", "急いでいる", "審査の不安", "先に取られる不安", "抑えたい",
  "安くしたい", "内覧したい", "時間が無い", "迷い", "不満・離れかけ", "普通の依頼",
] as const;
export type MindsetState = typeof MINDSET_STATES[number];
export const MINDSET_STATE_DEF: Record<MindsetState, string> = {
  刺さっている: "送った物件・提案を気に入っている・前のめり",
  興味が薄い: "この物件・提案に興味が無い・反応が薄い（断りまではいかない）",
  急いでいる: "入居・決定を急いでいる（今月中・すぐ・早めに・他店と同時進行）",
  審査の不安: "審査が通るか心配（＝申込したい前向きな不安。職業・収入・滞納・保証会社）",
  先に取られる不安: "先に他の人に申込が入らないか心配（＝抑えたい前向きな不安）",
  抑えたい: "決めに来ている・申込や仮押さえを望む",
  安くしたい: "初期費用・家賃を抑えたい・総額を気にしている",
  内覧したい: "見に行きたい・日程を出してきた（時間の問題なし）",
  時間が無い: "見に行きたいが都合が付かない・遠方・先の日になる",
  迷い: "決めきれない・検討する・比べている・相談する（中身は hesitation）",
  "不満・離れかけ": "返事が遅い・話が違う・高い等の不満／他で決めた・見送り",
  普通の依頼: "条件の提示・物件の質問・手続きの質問・お礼・日程の調整など、気持ちの動きが主でない番",
};
export const ANXIETY_TARGETS = ["審査", "先に取られる", "費用", "物件の中身", "立地・治安", "手続き", "日程", "その他"] as const;
export type AnxietyTarget = typeof ANXIETY_TARGETS[number];
export type Anxiety = { target: AnxietyTarget; direction: "前向き" | "後ろ向き" };

/**
 * お客様が自分で書いた文だけ（条件のフォーム・画像の書き起こし・物件の資料の項目・URL を落とす）。
 *   監査（det-check）: 条件のフォーム（①【ご入居の時期】…駐車場代込）・画像の書き起こし（【物件名】【号室名】）から決め手の残り・迷いを読んでいた
 */
export function customerOwnText(raw: string | null | undefined): string {
  let t = String(raw ?? "").normalize("NFKC");
  if (/お部屋探しご条件|お部屋お探し中|①\s*【?ご?(?:入居|希望)|①[^\n]{0,6}(?:入居|家賃)/.test(t)) return "";
  // 条件を並べただけの文（家賃・間取り・エリア・築年…が3つ以上）は物件1件の話ではない
  if ((t.match(/家賃|賃料|間取|エリア|築年|築浅|最寄|駅徒歩|徒歩\s*[0-9]|[1-4]\s*(?:LDK|DK|K)\b|ワンルーム/gi) ?? []).length >= 3) return "";
  const cut = t.search(/\[画像\]|\*\*物件情報\*\*|【物件の画面/);
  if (cut >= 0) t = t.slice(0, cut);
  return t.split("\n").filter((l) => !/https?:\/\/|by SUUMO|物件情報|^\s*【[^】]{1,10}】|^\s*[^\s]{1,8}[：:]/.test(l)).join("\n");
}

// ─── 迷いの中身 ────────────────────────────────────────────────────────────
export const HESITATION_KINDS = [
  "複数物件で迷う", "他社・他の物件と比べる", "家族・同居人に相談", "費用で迷う", "立地・周辺で迷う", "設備・広さの1点で迷う",
  "時期・入居日で迷う", "内覧してから決めたい", "審査・手続きの見通し待ち", "決め手が無い", "急がない・保留",
] as const;
export type HesitationKind = typeof HESITATION_KINDS[number];

/** 迷いの中身ごとの竹内さんの返し方（材料・件数は 180日の竹内さんの番・弱い参考）。言い回しの指示ではない */
export const HESITATION_MOVE: Record<HesitationKind, string> = {
  複数物件で迷う: "1件を推す・お申込みでお部屋を抑える提案（竹内さんの決定 10/09。内覧の誘いの後 内覧0/4・申込3/4、申込の誘いの後 申込3/4）",
  "他社・他の物件と比べる": "比べている物件の確認・別の物件を探す約束（内覧14日 0%・申込30日 30%）",
  "家族・同居人に相談": "押さずに扉を開けて待つ（竹内さん 75%・ご相談の上いつでも）",
  費用で迷う: "迷っている費用の点に答える（見積書・最大限割引の説明）",
  "立地・周辺で迷う": "迷っている点に答える・内覧で確かめる提案",
  "設備・広さの1点で迷う": "その1点に答える・確認する（竹内さん 55%）",
  "時期・入居日で迷う": "入居日の見通しを答える（申込から入居まで・抑えられる期間）",
  内覧してから決めたい: "AIX【内覧調整】（竹内さん 内覧の誘い 50%・内覧14日 78%）",
  "審査・手続きの見通し待ち": "見通しを説明し、お申込みで審査をかける提案",
  決め手が無い: "押さずに扉を開けて待つ・新着でオススメが出次第お送りする",
  "急がない・保留": "押さずに扉を開けて待つ（竹内さん 扉 76%）",
};

const HES_RES: Array<[HesitationKind, RegExp]> = [
  ["内覧してから決めたい", /(?:見て|内覧して|内見して|実際に(?:見|確認))(?:から|みて)[^。\n]{0,8}(?:決め|考え|検討|判断)|(?:直接|実物を?)(?:見て|みて)から/],
  ["家族・同居人に相談", /(?:家族|妻|嫁|夫|旦那|主人|彼氏|彼女|親|両親|母|父|同居人|パートナー|相方|友達|友人)[^。\n]{0,10}(?:と|に)?(?:相談|話し合|確認|聞いて|決め|目を通|見てみ)|一人(?:で|じゃ)[^。\n]{0,6}決め(?:かね|兼ね|られ)|(?:1|一)度相談/],
  ["他社・他の物件と比べる", /他(?:社|の(?:不動産|会社|業者|お店|店))|他(?:の|店)でも|同時進行|別の(?:不動産|会社)|自分で(?:見つけ|探し)た|他(?:の)?物件と(?:比|検討)|(?:他にも|他の)[^。\n]{0,8}比較(?:して|中)/],
  ["審査・手続きの見通し待ち", /(?:審査|内定|勤務先|仕事|職場|転職|書類|ローン)[^。\n]{0,14}(?:決まって|決まり次第|分かって|わかって|次第|見通し|まだ|待ち)/],
  ["時期・入居日で迷う", /(?:時期|入居日|入居の?時期|いつ(?:から|頃)|タイミング|退去|今の(?:家|部屋)|更新)[^。\n]{0,14}(?:迷|悩|検討|考え|決まって(?:い)?な|未定|ずれ)/],
  ["複数物件で迷う", /(?:どちら|どっち|どれ)(?:に|が|を|の方|にする)?[^。\n]{0,10}(?:迷|悩|しよう|するか|いいか|良いか|決め)|[2-5２-５二三]件(?:で|とも|の(?:どちら|中|うち))[^。\n]{0,12}(?:迷|悩|検討)|(?:候補|第一候補|絞)[^。\n]{0,10}(?:迷|悩|検討|考え)|迷っ(?:て|てい)[^。\n]{0,6}(?:ます|る)[^。\n]{0,4}(?:どちら|どっち)/],
  ["費用で迷う", /(?:初期費用|家賃|費用|予算|金額|お金|値段)[^。\n]{0,12}(?:迷|悩|検討|考え|厳し|ギリギリ|高(?:い|かった|め)|抑えたい|安く(?:なり|でき))/],
  ["立地・周辺で迷う", /(?:立地|場所|周辺|治安|駅|距離|通勤|エリア)[^。\n]{0,10}(?:迷|悩|気にな|心配|不安)/],
  ["設備・広さの1点で迷う", /(?:広さ|間取り|狭|収納|設備|[0-9一二]階|虫|日当たり|騒音|音|キッチン|お風呂|洗面)[^。\n]{0,10}(?:迷|悩|気にな|心配|ちょっと)/],
  ["決め手が無い", /ピンと(?:こ|来)|決め手(?:が|に)?(?:な|欠)|いまいち|イマイチ|もう少し(?:探|見)(?:たい|てみ)/],
  ["急がない・保留", /検討(?:し|させ|中)|考え(?:ます|させ|てみ|中)|また(?:ご)?連絡|改めて(?:ご)?連絡|一旦|保留|ゆっくり|折り返/],
];

/** お客様の今の連投から迷いの中身を読む（決まった言い方だけ・無ければ null）。判断はブレイン */
export function hesitationKindOf(text: string | null | undefined): { kind: HesitationKind; quote: string } | null {
  const t = customerOwnText(text);
  if (!t.trim()) return null;
  for (const [k, re] of HES_RES) { const m = t.match(re); if (m) return { kind: k, quote: m[0].slice(0, 30) }; }
  return null;
}

// ─── 決め手の残り（decide_gap） ──────────────────────────────────────────────
export const DECIDE_GAP_POINTS = ["室内・実物", "設備", "駐車場・駐輪場", "空き・募集状況", "入居日・時期", "ペット・条件の可否", "審査", "初期費用", "家賃", "広さ", "立地・駅", "築年", "階", "その他"] as const;
export type DecideGapPoint = typeof DECIDE_GAP_POINTS[number];
/** a＝確かめれば解ける（AIX 確認した／物件確認した）・b＝交渉・見積で解ける（見積書・代表確認）・c＝物件そのものの差＝別の物件で解く（似ていて〇〇が違う物件を探す） */
export type DecideGapSolve = "a" | "b" | "c";
export const SOLVE_JA: Record<DecideGapSolve, string> = { a: "確かめれば解ける", b: "交渉・見積で解ける", c: "別の物件で解く" };

export type DecideGap = {
  point: DecideGapPoint;
  solve: DecideGapSolve;
  /** どの物件か（分からなければ null） */
  property: string | null;
  /** お客様の言葉（30字まで） */
  quote: string;
  /** 「〇〇なら決める・確認して問題無ければ申込」の言い方（決める寸前の強い信号） */
  conditional: boolean;
  /** その物件に前向き（気に入った・候補・申込の意思） */
  forward: boolean;
  /** 言った時刻（ISO） */
  at: string | null;
};

/** 「〇〇なら決める・申込する」「確認して問題無ければ決める」（120日 19通・申込30日 47%） */
export const CONDITIONAL_DECIDE_RE = /(?:なら|れば|たら|だったら|でしたら|であれば)[^。\n？?]{0,16}(?:決め|申し?込|契約|ここに(?:し|決)|即決|進め(?:たい|ます))|(?:確認|確かめ)[^。\n]{0,10}(?:問題(?:な|無)|大丈夫)[^。\n]{0,10}(?:決め|申し?込|進め)|(?:決め(?:たい|ます)|申し?込(?:みたい|みます))[^。\n]{0,6}(?:けど|が)[^。\n]{0,20}(?:確認|気になる|だけ)/;
/** 条件つきの決めるに見えて違う物（「申し込みの流れ」の質問・他を見てから決める・名義の手続き） */
const CONDITIONAL_NOT_RE = /他の(?:お部屋|部屋|物件)も[^。\n]{0,12}比較|比較してから決め|名義|更新/;

const FORWARD_RE = /気に入|気にな(?:り|る|って)|いいですね|良いですね|良さそう|よさそう|いい感じ|素敵|理想|ここ(?:が|で)?(?:いい|良い)|こちら(?:が|で)?(?:いい|良い)|第一候補|候補|申し?込(?:み)?(?:たい|します|みます)|抑え(?:たい|て)|押さえ(?:たい|て)|内覧(?:し|させ)たい|内見(?:し|させ)たい|見に行きたい|前向き/;

type GapRule = { point: DecideGapPoint; solve: DecideGapSolve; re: RegExp; not?: RegExp };
/** (a) 確かめれば解ける: その物件1件について確かめたい事（質問・条件つき） */
const A_RULES: GapRule[] = [
  { point: "室内・実物", solve: "a", re: /(?:直接|実物|実際に)[^。\n]{0,6}(?:見|み|確認)|見てから決め|室内(?:の)?(?:写真|動画|状態|様子)|内装|お部屋の(?:中|雰囲気)|中(?:を|が)見(?:たい|れ)|どんな感じか[^。\n]{0,6}見/ },
  { point: "駐車場・駐輪場", solve: "a", re: /(?:駐車場|駐輪場|バイク置|車庫)[^。\n]{0,14}(?:空き|空いて|ありますか|ございますか|ありますでしょうか|いくら|料金|ですか|でしょうか|止め|停め|置け)/, not: /駐車場(?:付き|有り|あり)の?(?:物件|部屋|お部屋)(?:で|を)?(?:探|お願い)|駐車場付きで|なくても|無くても/ },
  { point: "ペット・条件の可否", solve: "a", re: /(?:ペット|猫|犬|[0-9０-９一二三]匹|楽器|二人入居|2人入居|ルームシェア|事務所)[^。\n]{0,12}(?:可能|大丈夫|いけ|OK|できます|出来ます|ですか|でしょうか)/i },
  { point: "空き・募集状況", solve: "a", re: /空いて(?:い)?(?:ますか|ましたら|たら|れば)|空室|まだ(?:ありますか|空い|募集)|募集(?:中|して)(?:ですか|でしょうか)|埋ま(?:る|って)/, not: /何時|[0-9０-９]{1,2}\s*日|曜日|予定(?:が)?空|ご都合/ },
  { point: "入居日・時期", solve: "a", re: /(?:入居(?:日|でき|可能|時期)|いつから(?:入|住)|何日から(?:入|住)|[0-9０-９]{1,2}月[^。\n]{0,6}(?:入居|入れ|住め))[^。\n]{0,12}(?:ですか|でしょうか|可能|いけ|大丈夫|ますか|合え|合う)/ },
  { point: "設備", solve: "a", re: /(?:エアコン|洗濯機置|浴室乾燥|追い焚き|追焚|独立洗面|ネット|インターネット|wi-?fi|コンロ|オートロック|宅配ボックス|モニター付|収納|クローゼット|ベランダ|家具の寸法|冷蔵庫|畳)[^。\n]{0,14}(?:ありますか|あります|あれば|付いて|ついて|ですか|でしょうか|可能|入りますか|収まれ|大丈夫|変えて)/i },
  { point: "審査", solve: "a", re: /審査[^。\n]{0,12}(?:通(?:る|り|れ)|不安|心配|大丈夫|厳し|緩)/ },
];
/** (b) 交渉・見積で解ける: その物件の初期費用・家賃を知りたい・安くしたい（探す形は c） */
const B_RULES: GapRule[] = [
  { point: "初期費用", solve: "b", re: /(?:初期費用|見積|お見積|諸費用)[^。\n]{0,10}(?:いくら|教え|知り|出し|計算|ください|お願い|安く|抑え|どれ|どのくらい|どの位)|(?:礼金|敷金|消臭|クリーニング)[^。\n]{0,8}(?:なし|無く|安く|なくな|どうにか|下がり)|(?:ここ|こちら|この(?:物件|部屋|お部屋))[^。\n]{0,10}(?:安く|いくら)|安く(?:なり|でき|いけ)(?:ます|ませ)/, not: /(?:物件|部屋|お部屋|ところ|とこ|所)(?:は|が|を)?(?:ない|あり|ござい|あれば|探)/ },
];

const CLOSING_GAP_TO_POINT: Record<string, DecideGapPoint> = {
  rent_lower: "家賃", initial_cost: "初期費用", equipment: "設備", wider: "広さ", closer: "立地・駅", newer: "築年", floor_higher: "階", sunlight: "その他", quiet: "その他",
};

/** 物件名を文から拾う（こちらが送った名前の一覧に当たる物だけ・長い方から） */
export function propertyMentioned(text: string, known: ReadonlyArray<string>): string | null {
  const t = String(text ?? "").normalize("NFKC").replace(/\s/g, "");
  const ks = [...known].filter((k) => k && k.replace(/\s/g, "").length >= 3).sort((a, b) => b.length - a.length);
  for (const k of ks) { const kk = k.normalize("NFKC").replace(/\s/g, ""); if (t.includes(kk) || (kk.length >= 6 && t.includes(kk.slice(0, 6)))) return k; }
  return null;
}

export type GapMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null };

/** こちらが送った物件の名前（🌟の行・【物件名 号室】・「〇〇号室」の前の名前） */
export function sentPropertyNames(msgs: ReadonlyArray<GapMsg>): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.sender === "customer") continue;
    const t = String(m.text ?? "").normalize("NFKC");
    for (const l of t.split("\n")) {
      const s = l.trim();
      const star = s.match(/^🌟+\s*([^\n]{2,40})$/);
      if (star && !/割引|見積|初期費用|節約|ご査収/.test(star[1])) out.push(star[1].replace(/[!！。]+$/, "").trim());
    }
    for (const mm of t.matchAll(/【([^】]{3,40})】/g)) if (!/希望|ご入居|家賃|間取り|築年数|エリア|駅名|徒歩|初期費用|その他|広さ|見積|オススメ|ポイント/.test(mm[1])) out.push(mm[1].trim());
    for (const mm of t.matchAll(/([^\s、。！!「」（）()【】\n]{3,24}?)\s?([0-9０-９]{3,4})号室/g)) out.push(`${mm[1]} ${mm[2]}`.trim());
  }
  return [...new Set(out)];
}

/**
 * お客様の1回の連投（束）から決め手の残りを読む（決まった言い方だけ）。
 * 1つの束に複数の型があれば全部返す。property は束の文・直前のこちらの物件の送信から。
 */
export function readDecideGapsInTurn(i: { text: string; at?: string | null; knownProperties?: ReadonlyArray<string>; focusProperty?: string | null }): DecideGap[] {
  // 物件の画面の書き起こし・条件のフォーム・URL の行は読まない（お客様が貼った資料の文）
  const text = customerOwnText(i.text);
  if (!text.trim()) return [];
  const conditional = CONDITIONAL_DECIDE_RE.test(text) && !CONDITIONAL_NOT_RE.test(text);
  const forward = conditional || FORWARD_RE.test(text);
  const property = propertyMentioned(text, i.knownProperties ?? []) ?? i.focusProperty ?? null;
  const out: DecideGap[] = [];
  const seen = new Set<string>();
  const push = (point: DecideGapPoint, solve: DecideGapSolve, quote: string) => {
    const k = `${point}|${solve}`; if (seen.has(k)) return; seen.add(k);
    out.push({ point, solve, property, quote: quote.replace(/\s+/g, " ").slice(0, 30), conditional, forward, at: i.at ?? null });
  };
  for (const r of A_RULES) { const m = text.match(r.re); if (m && !(r.not?.test(text))) push(r.point, r.solve, conditionalQuote(text) ?? sentenceOf(text, m.index ?? 0)); }
  for (const r of B_RULES) { const m = text.match(r.re); if (m && !(r.not?.test(text))) push(r.point, r.solve, sentenceOf(text, m.index ?? 0)); }
  return out;
}

function sentenceOf(text: string, idx: number): string {
  const before = text.slice(0, idx); const s = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("。"), before.lastIndexOf("？"), before.lastIndexOf("?")) + 1;
  const rest = text.slice(idx); const e = rest.search(/[\n。？?]/);
  return text.slice(s, e < 0 ? text.length : idx + e + 1).trim();
}
function conditionalQuote(text: string): string | null { const m = text.match(CONDITIONAL_DECIDE_RE); return m ? sentenceOf(text, m.index ?? 0) : null; }

/** (c) 別の物件で解く: closing-target の「あと一つ」（家賃をもう少し下げて・もう少し広く・築浅 等）を同じ形に写す */
export function decideGapsFromClosing(reads: ReadonlyArray<{ kind: string; evidence: string }>, o: { property: string | null; at: string | null; forward: boolean; conditional: boolean }): DecideGap[] {
  return reads.map((r) => ({ point: CLOSING_GAP_TO_POINT[r.kind] ?? "その他", solve: "c" as const, property: o.property, quote: r.evidence.slice(0, 30), conditional: o.conditional, forward: o.forward, at: o.at }));
}

export const DECIDE_GAP_TTL_DAYS = 14;

/**
 * 会話（古い順・申込の書類の通は呼ぶ側で落とす）から、今も残っている決め手の残りを読む。
 *   ・お客様の束ごとに読み、新しい物を優先（同じ物件×同じ点は新しい1つ）
 *   ・その後にこちらが同じ点を解いた送信（a=確認の結果・物件確認／b=御見積書）があっても消さない＝解いた後の締めに使う。
 *     ただし TTL（14日）を過ぎた物・その物件の募集終了の後は外す
 *   ・(c) は closing-target の読み（呼ぶ側が readClosingGaps の結果を渡す・無ければ読まない）
 */
export function readDecideGaps(msgs: ReadonlyArray<GapMsg>, o: { nowMs: number; closingReads?: (text: string) => ReadonlyArray<{ kind: string; evidence: string }> }): DecideGap[] {
  const known = sentPropertyNames(msgs);
  const out: DecideGap[] = [];
  let focus: string | null = null;
  for (let k = 0; k < msgs.length; k++) {
    const m = msgs[k];
    if (m.sender !== "customer") {
      const p = propertyMentioned(String(m.text ?? ""), known); if (p) focus = p;
      continue;
    }
    if (k > 0 && msgs[k - 1].sender === "customer") continue; // 束の先頭だけ（束は下でつなぐ）
    let j = k; while (j + 1 < msgs.length && msgs[j + 1].sender === "customer") j++;
    const text = msgs.slice(k, j + 1).map((x) => String(x.text ?? "")).join("\n");
    const at = msgs[j].createdAt;
    if (o.nowMs - Date.parse(at) > DECIDE_GAP_TTL_DAYS * 86_400_000) continue;
    const gaps = readDecideGapsInTurn({ text, at, knownProperties: known, focusProperty: focus });
    if (o.closingReads) {
      const reads = o.closingReads(text);
      if (reads.length) {
        const conditional = CONDITIONAL_DECIDE_RE.test(text) && !CONDITIONAL_NOT_RE.test(text);
        gaps.push(...decideGapsFromClosing(reads, { property: propertyMentioned(text, known) ?? focus, at, forward: conditional || FORWARD_RE.test(text), conditional }));
      }
    }
    out.push(...gaps);
  }
  // 募集終了・申込が入ったと伝えた物件の残りは外す
  const ended = new Set<string>();
  for (const m of msgs) if (m.sender !== "customer" && /募集終了|お申込(?:み)?が入っ|ご紹介出来(?:ない|かね)/.test(String(m.text ?? ""))) { const p = propertyMentioned(String(m.text ?? ""), known); if (p) ended.add(p); }
  const byKey = new Map<string, DecideGap>();
  for (const g of out) { if (g.property && ended.has(g.property)) continue; byKey.set(`${g.property ?? "-"}|${g.point}`, g); }
  return [...byKey.values()].sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
}

/** 刺さりの最上位の印: 「〇〇なら決める」か「前向き＋(a)の残りが1点」（その物件ごと） */
/**
 * 2026-10-09 監査（det-check・60日の竹内さんの番）: 決まった計算の「前向き＋(a)の残り1点」は 9番・申込 2/8 で、
 *   DeepSeek で読んだ同じ型（103番・申込 46%）と違い当たらなかった（「12日と13日は何時空いてますか」を空きと読む・URL だけの番 等）。
 *   → 決まった計算で強い印にするのは「〇〇なら決める」の言い方だけ。「前向き＋残り1点」はブレインが読んだ decide_gap（brainGap）がある時だけ強い印にする。
 */
export function decideSignalOf(gaps: ReadonlyArray<DecideGap>, property?: string | null, brainGap?: { point: string; solve: DecideGapSolve; property: string | null; quote: string } | null): { strong: boolean; why: string } {
  const g = gaps.filter((x) => !property || !x.property || x.property === property);
  const cond = g.find((x) => x.conditional);
  if (cond) return { strong: true, why: `「${cond.quote}」（〇〇なら決める＝決める寸前）` };
  if (brainGap && brainGap.solve === "a" && brainGap.point !== "審査" && (!property || !brainGap.property || brainGap.property === property)) {
    return { strong: true, why: `前向き＋あと「${brainGap.point}」が確かめられれば決まる（ブレインの読み${brainGap.quote ? `・「${brainGap.quote}」` : ""}）` };
  }
  return { strong: false, why: "" };
}

/** 解く一手（AIX の鍵＝aix-catalog の「ボタン/ピッカー」）。材料として渡す */
export function solveMoveOf(g: DecideGap, o: { viewed?: boolean; farOrBusy?: boolean } = {}): string {
  switch (g.point) {
    case "室内・実物": return o.farOrBusy ? "AIX【物件確認した→室内写真を確認した】（撮影・室内イメージ）／抑えてから内覧" : "AIX【内覧調整】（竹内さん 66%）／遠方・時間が無ければ室内写真";
    case "駐車場・駐輪場": return "確認の約束→AIX【確認した→駐車場について】";
    case "ペット・条件の可否": return "確認の約束→AIX【確認した→ペット飼育について】";
    case "空き・募集状況": return "確認の約束→AIX【物件確認した】（募集状況）";
    case "入居日・時期": return "会話・資料で答えられれば返信／無ければ確認の約束→AIX【確認した→入居日について】";
    case "設備": return g.solve === "c" ? "その設備がある似た物件を探す（決め手の条件・登録の条件を直す）" : "資料にあれば返信／無ければ確認の約束→AIX【確認した→設備について】";
    case "審査": return "審査の見通しを説明し支える（竹内さん 77%）→お申込みで審査をかける提案";
    case "初期費用": return g.solve === "c" ? "初期費用を抑えられる似た物件を探す" : "AIX【見積書送る】（最大限割引）。見積書の文に内覧（未内覧・空室）か申込の訴求を添えて反応を待つ。代表確認は反応の後（further-discount）";
    case "家賃": return g.solve === "c" ? "この物件に似ていて家賃帯が低い物件を探す（決め手の条件・登録の条件を直す）" : "家賃の値下げは基本できない＝似た物件で家賃帯の低い物件を探す";
    default: return `この物件に似ていて「${g.point}」が違う物件を探す（決め手の条件・登録の条件を直す）`;
  }
}

/** ブレイン・メモに置く1行（同じ値） */
export function decideGapLine(g: DecideGap): string {
  return `${g.property ? `${g.property}: ` : ""}あと「${g.point}」${g.solve === "a" ? "が確かめられれば" : g.solve === "b" ? "（費用）が納得できれば" : "が違う物件なら"}決まる見込み（${SOLVE_JA[g.solve]}${g.conditional ? "・〇〇なら決める" : ""}）「${g.quote}」`;
}

/** ブレインの注記（決め手の残り＋迷いの中身）。何も無ければ空 */
// ─── 返信の任意の1行（状態で割れる物だけ・材料）──────────────────────────────
//   2026-10-09 竹内さん「入れたり入れなかったりする1行も…入れる場面と入れない場面の違いが明確になる」。
//   竹内さんの手打ち 180日 739番（scripts/audit-customer-mindset.ts --phase=optional-lines）で、状態で 25pt 以上割れた1行だけ:
//   扉「気になる点ございましたら…」: 迷い 42%（全体 8%）・保留 62% ／お気軽に: 迷い 52%（13%）／申込・抑える提案: 抑えたい 33%・先に取られる不安 37%（5%）／
//   安心の一文: 審査の不安 48%（23%）・内覧したい 0%・抑えたい 5% ／内覧の誘い: 刺さっている 33%・内覧したい 26%（7%）・審査の不安 0%。
//   何卒・全力でサポートは状態ではなく、初回・その日最初・文の数で割れる（sent-shape の側）。戻す MINDSET_REPLY_LINES=off
export function mindsetReplyLinesEnabled(env?: Record<string, string | undefined>): boolean { return on(envOf(env).MINDSET_REPLY_LINES); }
const STATE_LINES: Partial<Record<MindsetState, string>> = {
  迷い: "扉の一文（「気になる点ございましたらいつでもお気軽にご連絡ください」系）竹内さん 42%（普段 8%）・「お気軽に」52%（普段 13%）。申込・内覧で押すのは少ない",
  抑えたい: "申込・抑える提案（「お申込みしお部屋抑えさせて頂きます」）33%（普段 5%）・受けは「かしこまりました」82%。安心の一文 5%",
  先に取られる不安: "申込・抑える提案 37%（普段 5%）。先に申込が入らないかの不安＝抑えたい前向きな不安",
  審査の不安: "安心の一文（「審査通過出来ますようサポートさせて頂きます」系）48%（普段 23%）。申込・内覧の誘いは 0%",
  刺さっている: "内覧の誘い 33%（普段 7%）",
  内覧したい: "内覧の誘い 26%・安心の一文 0%",
};
/** 返信に渡す材料（今の状態で竹内さんが足す1行の率）。状態が無い・割れない状態なら空 */
export function buildMindsetReplyLinesNote(state: string | null | undefined, hesitation?: string | null, env?: Record<string, string | undefined>): string {
  if (!mindsetReplyLinesEnabled(env) || !state) return "";
  const line = STATE_LINES[state as MindsetState];
  const hes = state === "迷い" && hesitation === "急がない・保留" ? "（迷いの中身が保留の時は扉の一文 62%）" : "";
  return line ? `【今のお客様の状態（${state}）で竹内さんが足している1行（竹内さんの手打ち 180日の率・材料）】\n- ${line}${hes}` : "";
}

export function buildDecideGapNote(i: { gaps: ReadonlyArray<DecideGap>; brainGap?: BrainGap | null; hesitation?: { kind: HesitationKind; quote: string } | null; viewed?: boolean; farOrBusy?: boolean; env?: Record<string, string | undefined> }): string {
  const lines: string[] = [];
  if (decideGapEnabled(i.env)) {
    for (const g of i.gaps.slice(0, 3)) lines.push(`- ${decideGapLine(g)} → 解く一手: ${solveMoveOf(g, { viewed: i.viewed, farOrBusy: i.farOrBusy })}`);
    const sig = decideSignalOf(i.gaps, null, i.brainGap ?? null);
    if (sig.strong) lines.push(`- ★決める寸前の信号: ${sig.why}。確かめた結果が問題無ければ、その結果の文で「お気に召されましたらお申込みしお部屋抑えさせて頂きます」につなぐ（竹内さんの実送信 4通・申込 3/4・弱い参考）`);
  }
  // 「検討します」だけ（急がない・保留）は決まった言い方では中身が分からない（det-check: DeepSeek の細分と同じ 13/52）＝出さない。中身はブレインが流れで読む
  if (i.hesitation && i.hesitation.kind !== "急がない・保留" && hesitationNoteEnabled(i.env)) lines.push(`- 迷いの中身: ${i.hesitation.kind}「${i.hesitation.quote}」→ 竹内さんの返し方: ${HESITATION_MOVE[i.hesitation.kind]}`);
  if (!lines.length) return "";
  return `【決め手の残り・迷いの中身（決まった言い方で読んだ候補・判断はブレイン・数字は相関の弱い参考）】\n${lines.join("\n")}`;
}

// ─── ブレインの出力（mindset）──────────────────────────────────────────────
/** ブレインの今回の発言の層に出させる項目（brain-core の「追加で出力する項目」に入れる） */
export const MINDSET_BRAIN_FIELD = `"mindset"（お客様の今の状態。一般の感情でなくお部屋探しの中での本質で選ぶ。{"state": "${MINDSET_STATES.join("/")} のいずれか1つ", "anxiety": 不安・心配があれば {"target": "${ANXIETY_TARGETS.join("|")}", "direction": "前向き|後ろ向き"}（審査が通るか・先に申込が入らないかは、進みたいがゆえの前向きな不安）・無ければ null, "hesitation": 迷い・検討中なら "${HESITATION_KINDS.join("/")}" のいずれか・無ければ null（中身ごとの竹内さんの返し方＝材料: 複数物件で迷う→1件を推す・お申込みで抑える提案／急がない・保留と家族・同居人に相談→押さずに扉を開けて待つ／内覧してから決めたい→AIX 内覧調整／他社・他の物件と比べる→確認・別の物件を探す）, "decide_gap": 特定の物件について「あと1点が解ければ決まる」なら {"property": "物件名か null", "point": "${DECIDE_GAP_POINTS.join("|")}", "solve": "a（確かめれば解ける＝室内・設備・駐車場の空き・入居日・ペット等→AIX 確認した／物件確認した）|b（交渉・見積で解ける＝初期費用→最大限割引の見積書・代表確認）|c（物件そのものの差＝広さ・家賃帯・階・築年→似ていて〇〇が違う物件を探す）", "quote": "お客様の言葉25字"}・無ければ null（a は確かめた結果が問題無ければその結果の文で申込・抑える提案につなぐ／b は見積書に内覧（未内覧・空室）か申込の訴求を添えて反応を待つ／c は登録の条件を直して似た物件を探す）}。【決め手の残り・迷いの中身】【気持ちの流れ】があれば言葉だけでなく流れも見て決める）`;

/** 旧の7択（CUSTOMER_MINDSET=off の時に今まで通り出す言い方） */
export const LEGACY_EMOTION_CHOICES = "前向き/迷い/不安/不満/急ぎ/離れかけ/普通";
/** ai_summary_json.emotion・顧客プロファイルの温度感の選択肢（7択を 12種に置き換え） */
export function emotionChoicesText(env?: Record<string, string | undefined>): string {
  return customerMindsetEnabled(env) ? MINDSET_STATES.join("/") : LEGACY_EMOTION_CHOICES;
}
/** 今回の発言の層の「追加で出力する項目」の1つ目（mindset／旧 emotion） */
export function mindsetFreshOutputItem(env?: Record<string, string | undefined>): string {
  return customerMindsetEnabled(env)
    ? `${MINDSET_BRAIN_FIELD}（"emotion" は出さない＝コードが mindset から作る）`
    : `"emotion"（${LEGACY_EMOTION_CHOICES} のいずれか。今回の発言の感情。【気持ちの流れ】があれば言葉だけでなく前回からの変化も見て決める）`;
}

export type CustomerMindset = { state: MindsetState; anxiety: Anxiety | null; hesitation: HesitationKind | null; decideGap: Omit<DecideGap, "conditional" | "forward" | "at"> | null };

/** ブレインの出力を形にそろえる（読めなければ null） */
export function normalizeMindset(raw: unknown): CustomerMindset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const st = typeof r.state === "string" ? r.state.trim() : "";
  if (!(MINDSET_STATES as readonly string[]).includes(st)) return null;
  const ax = r.anxiety && typeof r.anxiety === "object" ? r.anxiety as Record<string, unknown> : null;
  const anxiety: Anxiety | null = ax && (ANXIETY_TARGETS as readonly string[]).includes(String(ax.target)) && (ax.direction === "前向き" || ax.direction === "後ろ向き")
    ? { target: ax.target as AnxietyTarget, direction: ax.direction } : null;
  const hes = typeof r.hesitation === "string" && (HESITATION_KINDS as readonly string[]).includes(r.hesitation) ? r.hesitation as HesitationKind : null;
  const dg = r.decide_gap && typeof r.decide_gap === "object" ? r.decide_gap as Record<string, unknown> : null;
  const decideGap = dg && (DECIDE_GAP_POINTS as readonly string[]).includes(String(dg.point)) && (dg.solve === "a" || dg.solve === "b" || dg.solve === "c")
    ? { point: dg.point as DecideGapPoint, solve: dg.solve as DecideGapSolve, property: typeof dg.property === "string" && dg.property.trim() && dg.property !== "null" ? dg.property.trim().slice(0, 40) : null, quote: typeof dg.quote === "string" ? dg.quote.slice(0, 30) : "" }
    : null;
  return { state: st as MindsetState, anxiety, hesitation: hes, decideGap };
}

/** 旧の気持ちの欄（customer_emotion）に入れる短い言葉。審査・先に取られる不安は向きを付ける（「不安」とだけ書かない） */
export function mindsetEmotionLabel(m: CustomerMindset | null): string | null {
  if (!m) return null;
  if (m.anxiety && (m.state === "審査の不安" || m.state === "先に取られる不安")) return `${m.state}(前向き)`.slice(0, 10);
  return m.state.slice(0, 10);
}

/** 記録（brain_decision_logs.digest.ms）に残す短い形: 状態|不安の向き|迷い|決め手の残り */
export function mindsetDigest(m: CustomerMindset | null): string | null {
  if (!m) return null;
  return [m.state, m.anxiety ? `${m.anxiety.target}:${m.anxiety.direction}` : "", m.hesitation ?? "", m.decideGap ? `${m.decideGap.point}:${m.decideGap.solve}` : ""].join("|").slice(0, 80);
}

// ─── 確認の結果が問題無しの時の締め（AIX 物件確認した／確認した）─────────────────
//   竹内さんの決定（10/09）: お客様が前に「〇〇なら」と言っていた時と、(a) の残りが1点の時だけ、同じ文で申込・抑える提案につなぐ。
export const HOLD_CLOSE_LINE = "お気に召されましたらお申込みしお部屋抑えさせて頂きます！！";
const HOLD_CLOSE_PATTERNS = new Set(["available", "interior_photo", "mgmt_equipment", "mgmt_parking", "mgmt_pet", "mgmt_move_in", "mgmt_guarantor", "mgmt_availability", "vacate_date"]);
/** 問題ありの結果（募集終了・申込が入った・不可・空き無し）＝締めを足さない */
const NEG_RESULT_RE = /募集終了|お申込(?:み)?(?:が)?(?:入っ|有り|あり)|[2２二]番手|ご紹介出来(?:ない|かね)|不可(?:となり|でし|です)|出来かね|できかね|難しい(?:状況|との事|です)|満車|空き(?:が)?(?:ない|無い|ございません)|ございません|審査中|商談中/;
const APPLY_APPEAL_RE = /お申込み?[^\n。]{0,16}(?:お部屋)?(?:抑え|押さえ)|お部屋(?:を)?(?:お?抑え|お?押さえ)|お申込み?(?:の方)?(?:いかが|如何)|お申込みし審査/;

export type BrainGap = { point: string; solve: DecideGapSolve; property: string | null; quote: string };
export function decideGapHoldClose(i: { text: string; aixType: string | null | undefined; checkPattern: string | null | undefined; gaps: ReadonlyArray<DecideGap>; property?: string | null; brainGap?: BrainGap | null; env?: Record<string, string | undefined> }): { text: string; added: boolean; reason: string } {
  const src = String(i.text ?? "");
  const no = (reason: string) => ({ text: src, added: false, reason });
  if (!decideGapHoldCloseEnabled(i.env)) return no("off");
  if (i.aixType !== "property_check_result" && i.aixType !== "acknowledge_check") return no("確認の AIX ではない");
  if (!i.checkPattern || !HOLD_CLOSE_PATTERNS.has(i.checkPattern)) return no(`ピッカー ${i.checkPattern ?? "-"}`);
  if (!src.trim() || NEG_RESULT_RE.test(src)) return no("結果が問題無しと言えない");
  if (APPLY_APPEAL_RE.test(src)) return no("もう申込の誘いがある");
  const sig = decideSignalOf(i.gaps, i.property ?? null, i.brainGap ?? null);
  if (!sig.strong) return no("〇〇なら・前向き＋残り1点の印が無い");
  const lines = src.replace(/\s+$/, "").split("\n");
  const last = lines.length - 1;
  const receiptAt = /ご査収|ご確認(?:の程|下さい|ください)|何卒よろしく/.test(lines[last] ?? "") ? last : -1;
  const out = receiptAt >= 0 ? [...lines.slice(0, receiptAt), HOLD_CLOSE_LINE, ...lines.slice(receiptAt)].join("\n") : `${lines.join("\n")}\n\n${HOLD_CLOSE_LINE}`;
  return { text: out, added: true, reason: sig.why };
}

// ─── 見積書の後（お客様が見積を頼んだ＝その物件に興味がある）──────────────────────
/** お客様が直近（3日）に見積・初期費用を頼んだか（竹内さんの見積書 120日: 頼まれた×内覧の前 98通 → 内覧 36%・申込 33%・ご査収だけ 32%） */
export const ESTIMATE_ASK_RE = /見積|初期費用(?:は|って|を|も)?[^。\n]{0,6}(?:いくら|教え|知り|出し|計算|どれ|どのくらい|どの位|お願い)|いくら(?:に|くらい|ぐらい)(?:なり|かかり)|安く(?:なり|でき|いけ)(?:ます|ませ)/;
export function customerAskedEstimate(msgs: ReadonlyArray<{ sender?: string | null; text?: string | null; created_at?: string | null; createdAt?: string | null; rawCreatedAt?: string | null }>, nowMs = Date.now()): boolean {
  return msgs.some((m) => {
    if (m.sender !== "customer") return false;
    const at = Date.parse(String(m.rawCreatedAt ?? m.created_at ?? m.createdAt ?? ""));
    if (Number.isFinite(at) && nowMs - at > 3 * 86_400_000) return false;
    return ESTIMATE_ASK_RE.test(String(m.text ?? "").normalize("NFKC"));
  });
}
