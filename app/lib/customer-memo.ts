// app/lib/customer-memo.ts — お客様ごとの「メモ」（人の営業のメモ帳）。純関数（DB・fetch を持たない＝画面からも import できる）
//
// 2026-10-08 竹内「お客さんの重要な部分は残す場所を作るなど。こっちが伝えた物件の事や、お客さんに聞かれた重要な部分は起こしておくなど。
//   人間でいうメモが必要。そして気持ちの判断する部分も強化する必要ある。LINE で流れを見たらそこも判断できると思う」
//
// 【実データ】11巡目の不一致 194番（下書き×竹内さんの実送信・8/29〜10/06）を1番ずつ読むと、メモがあれば防げた番は 57（29%）:
//   もう言った事の繰り返し 13／前に言った事と食い違う 6／お客様の事情・芯を汲めない 14／聞かれた事の答え漏れ 7／気持ちの読み違い 8／決まった事を知らない 9。
//   そのうち 52番は必要な情報が直前12通の中に**見えていた**（窓の外は 5番だけ）＝「長く残す」より「項目として取り出して目の前に置く」事が効く。
//
// 【重ねて作らない】既にブレインへ届いている物はここで作り直さない:
//   決まった事（段階・内覧の予定）＝customer-state／物件ごとの送った・金額・オススメ・持ち込み＝property-thread／
//   予定・〇日以降・遠方・同行者・体調＝customer-circumstances／連投の依頼と未対応＝request-ledger／約束＝action-ledger。
//   メモが足すのは: ①「もう伝えた事」の**種類**（名乗り・全て送った・新着待ち・全力サポート・内覧/申込の誘い・見積/確認/撮影の約束 等）
//                   ②お客様の言葉から読む芯・妥協・決める人・同居・気にしている事・好き嫌い・NG・言葉づかい（文から読む物だけ DeepSeek・差分だけ）
//                   ③スタッフが画面で付けた・直したメモ（手で付けた印＝自動で上書き・外さない）
// 【引用しない】「これを繰り返すな」は本文を引用すると逆効果（設計知見 55686a40）＝もう伝えた事は**種類の名前と日付だけ**渡す。
// 戻す: CUSTOMER_MEMO=off（ブレインへの注記）／CUSTOMER_MEMO_LLM=off（DeepSeek の差分の読み取り）／NEXT_PUBLIC_CUSTOMER_MEMO=off（画面）
// テスト: app/lib/__tests__/customer-memo.test.ts

import { maskPII } from "./pii-mask";
import { applicationMaterialReason } from "./test-pii-guard";

export type MemoKind =
  | "core"         // 条件の芯（譲れない）
  | "flexible"     // 妥協できる所
  | "circumstance" // 事情・予定（customer-circumstances が読まない物）
  | "people"       // 決める人・同居人・同行者
  | "concern"      // 気にしている事・不安
  | "like"         // 好き・気に入った
  | "ng"           // 嫌い・NG
  | "style"        // 言葉づかい・距離感
  | "told"         // こちらが伝えた事（物件の事実・会社の説明・約束の中身）
  | "asked"        // 聞かれた重要な事と、その答え
  | "decide_gap";  // 決め手の残り（あと1点で決まる・物件・解き方）。2026-10-09 竹内さん「メモとブレインの両方に同じ値で」＝決まった計算の行は customer-mindset.readDecideGaps（保存しない）・スタッフも手で足せる

export const MEMO_KIND_JA: Record<MemoKind, string> = {
  core: "条件の芯", flexible: "妥協できる所", circumstance: "事情・予定", people: "決める人・同居", concern: "気にしている事",
  like: "好き・気に入った", ng: "NG・嫌い", style: "言葉づかい", told: "こちらが伝えた事", asked: "聞かれた事", decide_gap: "決め手の残り",
};
export const LLM_MEMO_KINDS: ReadonlyArray<MemoKind> = ["core", "flexible", "circumstance", "people", "concern", "like", "ng", "style", "told", "asked"];

export type MemoOrigin = "llm" | "staff";
export type MemoItem = {
  id: string;
  kind: MemoKind;
  /** 短い1行（60字まで） */
  text: string;
  property?: string | null;
  /** いつの発言から（ISO） */
  sourceAt: string | null;
  /** どの発言から（30字まで・お客様／こちらの言葉） */
  sourceQuote?: string | null;
  sourceBy: "customer" | "staff";
  /** 言い切り／たぶん */
  certainty: "sure" | "maybe";
  /** 古くなる日（ISO・無ければ古くならない） */
  expiresAt?: string | null;
  origin: MemoOrigin;
  /** スタッフが付けた・直した＝自動（DeepSeek）で上書き・外さない */
  locked?: boolean;
  retiredAt?: string | null;
  retiredReason?: string | null;
  updatedAt: string;
};

export type StoredMemo = {
  items: MemoItem[];
  /** スタッフが「違う」で外した、決まった計算の行の id（伝えた事の種類） */
  hiddenRuleIds: string[];
  /** DeepSeek が読み終えた最後の通の時刻 */
  llmWatermark: string | null;
  llmAt?: string | null;
  version?: string | null;
};
export const EMPTY_MEMO: StoredMemo = { items: [], hiddenRuleIds: [], llmWatermark: null };
export const CUSTOMER_MEMO_VERSION = "m1";

export type MemoMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null };

const JST = 9 * 3600_000;
export const mdOf = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ""); if (!Number.isFinite(t)) return ""; const d = new Date(t + JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

// ─────────────────────────────────────────────────────────────
// ① もう伝えた事の種類（こちらの送信＝手打ち・AIX から・決まった計算）
//   竹内さんの文は型が決まっているので、決まった言い方で種類だけ数える（中身の引用はしない）。
//   締めの定型（何卒・お気軽に・ご査収）は数えない（繰り返すのが普通＝設計知見 a59e3efd）。
// ─────────────────────────────────────────────────────────────
export type ToldKind =
  | "intro"          // 名乗り（はじめまして・担当の〇〇と申します）
  | "all_sent"       // 今募集中の物件は全てお送りした
  | "new_arrival"    // 新着が出次第お送りする
  | "full_support"   // 全力でサポート
  | "screening_support" // 審査のサポート
  | "viewing_invite" // 内覧の誘い
  | "apply_invite"   // 申込で抑える誘い
  | "estimate_promise" // 見積をお送りする約束
  | "check_promise"  // 確認してご連絡する約束
  | "photo_promise"  // 撮影してお送りする約束
  | "discount_explain" // 初期費用を最大限割引する説明
  | "online_viewing"; // オンライン内見・撮影の案内

export const TOLD_JA: Record<ToldKind, string> = {
  intro: "名乗り（担当の挨拶）", all_sent: "今募集中のお部屋は全てお送りした", new_arrival: "新着が出次第お送りする",
  full_support: "全力でサポートする", screening_support: "審査のサポート", viewing_invite: "内覧の誘い", apply_invite: "申込で抑える誘い",
  estimate_promise: "見積をお送りする約束", check_promise: "確認してご連絡する約束", photo_promise: "撮影してお送りする約束",
  discount_explain: "初期費用を最大限割引する説明", online_viewing: "オンライン内見・撮影の案内",
};

const TOLD_RES: Array<[ToldKind, RegExp]> = [
  ["intro", /はじめまして|担当(?:させて頂きます|の)[^\n。！!]{0,12}と申します|と申します[！!]/],
  ["all_sent", /(?:現在|今)募集(?:中|が出ている)[^\n。]{0,40}(?:全て|すべて|全部)(?:ピックアップ|お送り)|(?:全て|すべて)(?:ピックアップ|お送り)させて(?:頂|いただ)きました/],
  ["new_arrival", /新着[^\n。]{0,30}(?:出次第|出ましたら|随時|お送り)|募集に出次第|随時[^\n。]{0,10}確認/],
  ["full_support", /全力で(?:サポート|お部屋探し)|最善のサポート|ご満足頂けるまで/],
  ["screening_support", /審査[^\n。]{0,12}(?:サポート|通過出来ます|通過できます)/],
  ["viewing_invite", /(?:ご内覧|お部屋ご案内|ご案内させて(?:頂|いただ)きます|ご内覧(?:頂|いただ)け)/],
  ["apply_invite", /お申込み?[^\n。]{0,16}(?:お部屋)?(?:抑え|押さえ)|お部屋(?:を)?(?:抑え|押さえ)(?:る|て|させ)/],
  ["estimate_promise", /御?見積書?[^\n。]{0,30}(?:お送りさせて(?:頂|いただ)きます|ご用意|作成し)/],
  ["check_promise", /確認(?:させて(?:頂|いただ)きます|出来次第|でき次第)/],
  ["photo_promise", /撮影[^\n。]{0,16}(?:お送り|出来次第|でき次第|させて)/],
  ["discount_explain", /最大限[^\n。]{0,8}割引|仲介手数料[^\n。]{0,12}(?:無料|0円|かから)|2,?980円/],
  ["online_viewing", /オンライン内見|室内の撮影/],
];

export function toldKindsOf(text: string | null | undefined): ToldKind[] {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  // 来店・資料の定型（🌟カードの中の「オススメポイント」）は誘いの数に入れない＝カードの見出しの行を除く
  const body = t.split("\n").filter((l) => !/^[・\-]/.test(l.trim())).join("\n");
  return TOLD_RES.filter(([, re]) => re.test(body)).map(([k]) => k);
}

export type ToldSummary = { kind: ToldKind; lastAt: string; count: number; byAix: boolean };

/** こちらの送信（新しい物も古い物も・順不同可）から、伝えた種類ごとの最後の日と回数 */
export function summarizeTold(msgs: ReadonlyArray<MemoMsg>, o: { sinceMs?: number } = {}): ToldSummary[] {
  const by = new Map<ToldKind, ToldSummary>();
  for (const m of msgs) {
    if (m.sender === "customer") continue;
    const at = Date.parse(m.createdAt);
    if (o.sinceMs != null && at < o.sinceMs) continue;
    for (const k of toldKindsOf(m.text)) {
      const cur = by.get(k);
      if (!cur) by.set(k, { kind: k, lastAt: m.createdAt, count: 1, byAix: !!m.isAix });
      else { cur.count++; if (at > Date.parse(cur.lastAt)) { cur.lastAt = m.createdAt; cur.byAix = !!m.isAix; } }
    }
  }
  return [...by.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

export const toldRuleId = (k: ToldKind) => `told:${k}`;

// ─────────────────────────────────────────────────────────────
// ② 保存するメモ（DeepSeek の差分・スタッフの手）を当てる
// ─────────────────────────────────────────────────────────────
export type MemoOp =
  | { op: "add"; kind: MemoKind; text: string; quote?: string | null; at?: string | null; n?: number | null; by?: "customer" | "staff"; certainty?: "sure" | "maybe"; ttlDays?: number | null; property?: string | null }
  | { op: "update"; id: string; text: string; quote?: string | null; at?: string | null; n?: number | null; certainty?: "sure" | "maybe" }
  | { op: "retire"; id: string; reason: string };

const norm = (s: string) => s.normalize("NFKC").replace(/[\s、。・！!？?「」（）()]/g, "");
const clip = (s: string | null | undefined, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) : t; };

/** ops を当てる（純関数）。origin=llm の時はスタッフの行（locked）を書き換え・外さない。同じ種類で同じ中身の追加は重ねない */
export function applyMemoOps(memo: StoredMemo, ops: ReadonlyArray<MemoOp>, o: { origin: MemoOrigin; nowIso: string; newId: () => string }): { memo: StoredMemo; applied: number; refused: number } {
  const items = memo.items.map((x) => ({ ...x }));
  let applied = 0, refused = 0;
  for (const op of ops) {
    if (op.op === "add") {
      // decide_gap（決め手の残り）は決まった計算の行が正。手で足すのはスタッフだけ（DeepSeek の読み取りには出させない）
      if (!(LLM_MEMO_KINDS.includes(op.kind) || (op.kind === "decide_gap" && o.origin === "staff")) || !op.text?.trim()) { refused++; continue; }
      const text = clip(op.text, 60);
      const dup = items.find((x) => !x.retiredAt && x.kind === op.kind && (norm(x.text) === norm(text) || (norm(text).length >= 6 && (norm(x.text).includes(norm(text)) || norm(text).includes(norm(x.text))))));
      if (dup) { refused++; continue; }
      const ttl = op.ttlDays != null && op.ttlDays > 0 ? Math.min(op.ttlDays, 365) : null;
      const base = Date.parse(op.at ?? o.nowIso);
      items.push({
        id: o.newId(), kind: op.kind, text, property: op.property ? clip(op.property, 40) : null,
        sourceAt: op.at ?? null, sourceQuote: op.quote ? clip(op.quote, 30) : null, sourceBy: op.by ?? "customer",
        certainty: op.certainty === "maybe" ? "maybe" : "sure",
        expiresAt: ttl && Number.isFinite(base) ? new Date(base + ttl * 86_400_000).toISOString() : null,
        origin: o.origin, locked: o.origin === "staff", updatedAt: o.nowIso,
      });
      applied++;
    } else {
      const it = items.find((x) => x.id === op.id && !x.retiredAt);
      if (!it || (o.origin === "llm" && it.locked)) { refused++; continue; }
      if (op.op === "update") {
        it.text = clip(op.text, 60); if (op.quote) it.sourceQuote = clip(op.quote, 30); if (op.at) it.sourceAt = op.at;
        if (op.certainty) it.certainty = op.certainty;
        it.updatedAt = o.nowIso; if (o.origin === "staff") { it.locked = true; it.origin = "staff"; }
      } else { it.retiredAt = o.nowIso; it.retiredReason = clip(op.reason, 60) || "外した"; }
      applied++;
    }
  }
  return { memo: { ...memo, items }, applied, refused };
}

/** 今効いている行（外していない・古くなっていない） */
export function liveItems(memo: StoredMemo, nowMs: number): MemoItem[] {
  return memo.items.filter((x) => !x.retiredAt && (!x.expiresAt || Date.parse(x.expiresAt) > nowMs));
}

// ─────────────────────────────────────────────────────────────
// ③ DeepSeek の差分の読み取り（前置きは固定＝キャッシュが効く・新しい通だけ後ろ）
// ─────────────────────────────────────────────────────────────
export const MEMO_LLM_SYSTEM = `あなたは不動産仲介の営業担当の「お客様メモ」を更新する係です。人の営業がメモ帳に書き留めるように、LINE の新しいやり取りから、後で返信やご提案に効く大事な事だけを短く書き留めます。

入力: ①今のメモ（id・種類・中身）②前回より後の新しいやり取り（#番号・客=お客様・我=こちら・時刻）
出力: JSON だけ。{"ops":[...]}。何も変わらなければ {"ops":[]}。

ops の形:
- 追加 {"op":"add","kind":種類,"text":"60字以内の1行","n":根拠の通の#番号,"quote":"その通からそのまま抜き出した言葉30字以内","certainty":"sure|maybe","ttl_days":数字かnull,"property":"物件名かnull"}
- 直す {"op":"update","id":"今のメモのid","text":"直した中身","n":根拠の通の#番号,"quote":"根拠の言葉"}
- 外す {"op":"retire","id":"今のメモのid","reason":"なぜ（例: 条件を言い直した・解決した・見送った）"}

種類（kind）と、根拠にしてよい通:
- core（客の通だけ）: お客様が自分の言葉で言った条件の芯 例「ペット可（里親希望）」「初期費用は安さ最優先」。「絶対」「必須」はお客様がそう言った時だけ書く。特定の物件の話は like／ng、質問は asked、不安は concern にする（質問・不安を条件に言い換えない）。お客様が貼った御見積書・こちらの文の写しは条件にしない
- flexible（客の通だけ）: お客様が自分で「〜でもいい」「〜なくても」「妥協」と言った所だけ 例「駅から遠くても良い」「2階でも良い（早く入りたいので）」。希望の金額や条件そのものは core
- circumstance（客の通だけ）: 事情（仕事・家族・お金の用意の時期・引越しの理由・他社と並行）例「初期費用は10月末まで用意できない」「別の不動産会社とも並行して探している」
- people（客の通だけ）: 決める人・同居人・一緒に来る人 例「新生児と2人暮らし」「旦那様と相談して決める」
- concern（客の通だけ）: 気にしている事・不安 例「審査が不安（カードブラック）」「治安が心配」
- like（客の通だけ）: お客様が気に入った・気になると言った物件・設備 例「カシミマンション401が気になる」。こちらが勧めた物件は like にしない
- ng（客の通だけ）: お客様が嫌・見送り・候補から外すと言った物 例「神崎川は不便だったので嫌」「〇〇マンションは見送り」
- style（客の通だけ・はっきり分かる時だけ）: 言葉づかい・距離感 例「業者として連絡（自分のお客様のため）」
- told（我の通だけ）: こちらが伝えた物件・条件の**事実の説明**（規定・退去日・募集の有無・費用の条件・入居や申込の時期の説明）例「エスリード長居は10/15退去で内覧は10/16以降と伝えた」「北区・福島区・西区のガスコンロ付きは今は募集なしと伝えた」
- asked（客の通だけ）: お客様に聞かれた大事な事と、その後の答え（答えた／約束した／まだ）例「2LDKも知りたい→まだ答えていない」「初期費用は家賃だけか→翌月家賃＋2,980円と答えた」

書かない物（別の所で持っている・古くなる）:
- 送った物（物件の資料・オススメ・御見積書・ピックアップ）と、その送付の事実
- 内覧の日時・候補日・待ち合わせ・確定の事実、「確認します」「お送りします」「ご連絡します」の約束、御見積書の金額・割引額
- 出張中・遠方・〇日以降なら来られる等の来られる日の事情（別の所で読んでいる）
- 「〇日以降なら来られる」「遠方」「体調」等の来られる日の事情
- 物件の資料・画像の書き起こし・条件のフォームの項目の並び
- お礼・挨拶・定型の締め・「全力でサポート」等の決まり文句

決まり:
- 書くのは、入力の文に書いてある事だけ。推測しない・言い換えで中身を足さない（quote に無い事を text に書かない・（）で理由や見立てを足さない）。曖昧な物は certainty を maybe に。
- 名前（お客様・ご家族・紹介者の名前）・名乗り・電話・住所・生年月日・年収の数字・勤務先の名前は書かない（「〇〇」で伏せる）。
- 「お客様」「（弊社）」は伏せ字・会社の呼び名。「お客様で契約を進める」のように読みにくい時は書かない。
- 今のメモと同じ中身は追加しない。条件や事情・気に入った物件が変わったら、古い行を retire して新しく足す。
- 古くなる物は ttl_days を付ける（予定・気分は 7〜30・芯や NG は null）。
- 1回の ops は多くても8つ。大事な物から。`;

export function buildMemoLlmUser(i: { memo: StoredMemo; nowMs: number; msgs: ReadonlyArray<MemoMsg> }): string {
  const cur = liveItems(i.memo, i.nowMs).slice(0, 30).map((x) => `${x.id} | ${x.kind} | ${x.text}${x.property ? `（${x.property}）` : ""}${x.locked ? " | 手で付けた" : ""}`);
  // 2026-10-08 dry-run: 時刻を DeepSeek に写させると「09-18 14:32」の形で返り読めない → 通に #番号を付け、根拠は番号で返させる（時刻・送り手はこちらで引く）
  const lines = i.msgs.map((m, k) => {
    const who = m.sender === "customer" ? "客" : "我";
    const at = new Date(Date.parse(m.createdAt) + JST).toISOString().slice(5, 16).replace("T", " ");
    return `#${k + 1} ${who} ${at}: ${clip(m.text, 300)}`;
  });
  return `①今のメモ\n${cur.length ? cur.join("\n") : "（まだ無し）"}\n\n②新しいやり取り\n${lines.join("\n")}`;
}

/** DeepSeek に渡す通を作る（純関数）: 書類・個人の値の通は落とし、名前と番号は伏せる。画像の書き起こし・URL は短く */
export function memoLlmMessages(msgs: ReadonlyArray<MemoMsg>, names: ReadonlyArray<string | null | undefined>): MemoMsg[] {
  const out: MemoMsg[] = [];
  for (const m of msgs) {
    const t = String(m.text ?? "");
    if (!t.trim()) continue;
    if (applicationMaterialReason(t)) continue;
    let s = t;
    if (/^\s*\[(?:画像|動画|スタンプ|ファイル)/.test(s)) s = (s.match(/^\s*\[[^\]]*\]/)?.[0] ?? "[画像]").trim(); // 書き起こしは渡さない
    s = s.replace(/https?:\/\/\S+/g, "[URL]");
    if (/①|【ご入居の時期】|ご希望のお部屋探しご条件/.test(s)) s = "[条件のフォーム]";
    if (m.sender !== "customer" && /🌟/.test(s)) s = s.split("\n").filter((l) => /🌟/.test(l)).join(" ").slice(0, 120) + "（物件オススメの資料）";
    // 2026-10-08 dry-run: maskPII の敬称の型が「スモラさん」を「お客様」に替え、「今回はスモラさんで契約を進める」を「お客様で契約＝見送り」と読み違えた → 会社名は先に（弊社）へ
    s = s.replace(/(スモラ|イエヤス|ギガ賃貸)\s*(?:さん|様|さま)/g, "$1（弊社）");
    out.push({ ...m, text: maskPII(s, names as string[]) });
  }
  return out;
}

/** 客の通だけを根拠にしてよい種類（told だけが我の通） */
const CUSTOMER_KINDS: ReadonlySet<MemoKind> = new Set(["core", "flexible", "circumstance", "people", "concern", "like", "ng", "style", "asked"]);
/** 中身の語の照合で数えない決まった言い回し（種類の名前・まとめの語） */
const GENERIC_WORDS: ReadonlySet<string> = new Set(["希望", "部屋", "物件", "検討", "検討中", "気", "不安", "心配", "条件", "同時進行", "並行", "見送", "候補", "見学", "内見", "内覧", "申込", "状況", "可能", "予定", "依頼", "確認", "質問", "回答", "場合", "程度", "以内", "以上", "以下", "前後", "付近", "周辺", "エリア", "タイプ", "家賃", "初期費用", "費用", "万円", "審査", "他社", "不動産", "第一候補", "一番", "拡大", "範囲", "契約", "明言", "希望条件", "必須", "設置", "同時"]);
const qnorm = (s: string) => s.normalize("NFKC").replace(/[\s、。・！!？?「」『』（）()〜~…]/g, "");

/**
 * 2026-10-08 dry-run で直した形（決まった計算の線）: DeepSeek の op の根拠（#番号）を、渡した通（msgs）の時刻・送り手に引き直し、
 *   ①番号が無い・範囲外 ②種類と送り手が合わない（こちらが勧めた物件を like にした・客の発言を told にした）③quote がその通の文に無い（作り事の疑い）
 *   の op は落とす。update も同じ。retire はそのまま。戻り値の dropped は監査用
 */
export function resolveOpSources(ops: ReadonlyArray<MemoOp>, msgs: ReadonlyArray<MemoMsg>): { ops: MemoOp[]; dropped: Array<{ op: MemoOp; why: string }> } {
  const out: MemoOp[] = []; const dropped: Array<{ op: MemoOp; why: string }> = [];
  for (const op of ops) {
    if (op.op === "retire") { out.push(op); continue; }
    const n = op.n ?? null;
    const m = n != null && n >= 1 && n <= msgs.length ? msgs[n - 1] : null;
    if (!m) { dropped.push({ op, why: "根拠の番号なし" }); continue; }
    const by = m.sender === "customer" ? "customer" : "staff";
    if (op.op === "add") {
      if (op.kind === "told" ? by !== "staff" : CUSTOMER_KINDS.has(op.kind) && by !== "customer") { dropped.push({ op, why: `種類と送り手が合わない（${op.kind}・${by}）` }); continue; }
    }
    if (/名乗|と申します|名前は/.test(op.text ?? "")) { dropped.push({ op, why: "名前・名乗り" }); continue; }
    // dry-run 2巡目（40会話・387行を目で読んだ）で残った誤りの型:
    //   「お客様」は maskPII の伏せ字（人の名前・「〇〇さん」）＝「今回はお客様で契約を進める→見送り」等の読み違いの元 → 書かない
    if (/お客様/.test(`${op.text ?? ""} ${op.quote ?? ""}`)) { dropped.push({ op, why: "伏せ字（お客様）の読み違い" }); continue; }
    //   4巡目: told に約束（「駐車場料金は明日確認すると伝えた」＝action-ledger が持つ）・お客様の事情の聞き返し（「8/5に大阪へ戻る予定と伝えられた」）が残った
    //   8巡目: お客様がこちらの御見積書の文を貼った通（「初期費用156980円となります！！」）を条件の芯にした → こちらの言い回しの根拠はお客様の種類にしない
    if (op.op === "add" && op.kind !== "told" && op.kind !== "asked" && /となります|させて頂|させていただ|致します|ご査収/.test(op.quote ?? "")) { dropped.push({ op, why: "こちらの文の写しを根拠にした" }); continue; }
    //   7巡目: 「吹田までだと思っています」→「桃山台は見送り」＝断りの言葉の無い発言を NG にした → NG は根拠の言葉に断り・難点の言葉がある時だけ
    if (op.op === "add" && op.kind === "ng" && !/なし|無し|ない|厳し|除外|外|保留|不便|嫌|無理|やめ|パス|住みづら|住みずら|見送|いらな|要らな|ちょっと|微妙|遠い|狭い|高い|NG/i.test((op.quote ?? "").normalize("NFKC"))) { dropped.push({ op, why: "断りの言葉の無い NG" }); continue; }
    if (op.op === "add" && op.kind === "told" && /確認する|ご連絡する|連絡する|次第(?:ご)?連絡|お送りする|送ると|案内すると|伝えられた|と言われた/.test(op.text ?? "")) { dropped.push({ op, why: "told に約束・お客様の事情" }); continue; }
    const q = qnorm(op.quote ?? "");
    if (op.op === "add" && op.kind !== "told" && q.length < 6) { dropped.push({ op, why: "根拠の言葉が短い" }); continue; }
    //   3巡目: 発言に無い語で中身を足した（「家賃が少し高くなってしまいますね」→「家賃は安い方がよい」・「吹田までだと思っています」→「桃山台は見送り」）
    //   → お客様の種類（聞かれた事を除く）は、中身の漢字・カタカナの語（2字以上・決まった言い回しを除く）の7割以上が根拠の通にあること
    //   5巡目: 物件の話（like・ng）は名前が前の通にある事が多く、この線で正しい行の大半を落とした（102件）→ 物件の種類は外し、決まった語を増やした
    if (op.op === "add" && op.kind !== "told" && op.kind !== "asked" && op.kind !== "like" && op.kind !== "ng") {
      const src = (m.text ?? "").normalize("NFKC");
      const words = ((op.text ?? "").normalize("NFKC").replace(/（[^）]*）|\([^)]*\)/g, "").match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu) ?? [])
        .filter((w) => !GENERIC_WORDS.has(w));
      if (/安い方|安く/.test(op.text ?? "") && !/安/.test(src)) { dropped.push({ op, why: "発言に無い語で中身を足した" }); continue; }
      if (words.length >= 1 && words.filter((w) => src.includes(w)).length / words.length < 0.7) { dropped.push({ op, why: "発言に無い語で中身を足した" }); continue; }
    }
    //   質問（「小型犬だけなんですか」「住吉区とかでも無いですか」）を条件の芯・妥協に言い換えた（逆の意味の誤り 2件）→ 問いの形の根拠は芯・妥協にしない
    if (op.op === "add" && (op.kind === "core" || op.kind === "flexible") && /(?:[？?]|ですか|ますか|でしょうか|ません?か|かね)[！!。…、,\s]*$/.test((op.quote ?? "").normalize("NFKC").trim())) { dropped.push({ op, why: "問いを条件にした" }); continue; }
    //   中身の数字が根拠の通に無い（「家賃は共益費込みでの値段なので」→「家賃5〜6万円」）→ 足した数字は書かない（told・asked は答えの数字が後の通にあるので見ない）
    if (op.op === "add" && op.kind !== "told" && op.kind !== "asked") {
      const src = (m.text ?? "").normalize("NFKC").replace(/[,，]/g, "");
      const nums = ((op.text ?? "").normalize("NFKC").replace(/[,，]/g, "").match(/\d+(?:\.\d+)?/g) ?? []);
      if (nums.some((d) => !src.includes(d))) { dropped.push({ op, why: "数字が発言に無い" }); continue; }
    }
    if (q && !qnorm(m.text ?? "").includes(q.slice(0, Math.min(14, q.length)))) { dropped.push({ op, why: "根拠の言葉がその通に無い" }); continue; }
    out.push(op.op === "add" ? { ...op, at: m.createdAt, by } : { ...op, at: m.createdAt });
  }
  return { ops: out, dropped };
}

/** DeepSeek の返事を読む（崩れていれば null）。種類・形の外れた op は落とす */
export function parseMemoLlmOutput(text: string): MemoOp[] | null {
  const body = String(text ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  let j: unknown; try { j = JSON.parse(body); } catch { return null; }
  const ops = (j as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return null;
  const out: MemoOp[] = [];
  for (const r of ops.slice(0, 8) as Array<Record<string, unknown>>) {
    const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    const n = typeof r.n === "number" ? r.n : typeof r.n === "string" && /^#?\d+$/.test(r.n) ? Number(String(r.n).replace("#", "")) : null;
    if (r.op === "add" && LLM_MEMO_KINDS.includes(s("kind") as MemoKind) && s("text")) {
      out.push({ op: "add", kind: s("kind") as MemoKind, text: s("text")!, quote: s("quote"), n, certainty: s("certainty") === "maybe" ? "maybe" : "sure", ttlDays: typeof r.ttl_days === "number" ? r.ttl_days : null, property: s("property") });
    } else if (r.op === "update" && s("id") && s("text")) out.push({ op: "update", id: s("id")!, text: s("text")!, quote: s("quote"), n, certainty: s("certainty") === "maybe" ? "maybe" : undefined });
    else if (r.op === "retire" && s("id")) out.push({ op: "retire", id: s("id")!, reason: s("reason") ?? "" });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// ④ ブレインへの注記（場面で要る種類だけ・短く）
// ─────────────────────────────────────────────────────────────
type SceneKey = "ack" | "considering" | "question" | "conditions" | "property_share" | "cost" | "viewing" | "apply" | "other";
const SCENE_KINDS: Record<SceneKey, MemoKind[]> = {
  ack: ["decide_gap", "concern", "people", "told", "asked"],
  considering: ["decide_gap", "core", "flexible", "concern", "people", "like", "ng", "told"],
  question: ["decide_gap", "concern", "circumstance", "told", "asked", "people"],
  conditions: ["decide_gap", "core", "flexible", "ng", "like", "circumstance", "people", "told"],
  property_share: ["decide_gap", "core", "ng", "like", "concern", "told", "asked"],
  cost: ["decide_gap", "core", "circumstance", "concern", "told", "asked"],
  viewing: ["decide_gap", "people", "circumstance", "like", "told", "asked"],
  apply: ["decide_gap", "circumstance", "concern", "people", "told", "asked"],
  other: ["decide_gap", "core", "concern", "people", "circumstance", "told", "asked", "ng", "like"],
};

export function customerMemoEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CUSTOMER_MEMO ?? "").trim().toLowerCase() !== "off";
}

export function buildCustomerMemoNote(i: { memo: StoredMemo; told: ReadonlyArray<ToldSummary>; scene?: string | null; nowMs: number; maxItems?: number }): string {
  const scene = (i.scene && i.scene in SCENE_KINDS ? i.scene : "other") as SceneKey;
  const kinds = SCENE_KINDS[scene];
  const hidden = new Set(i.memo.hiddenRuleIds ?? []);
  const items = liveItems(i.memo, i.nowMs)
    .filter((x) => kinds.includes(x.kind))
    .sort((a, b) => Number(!!b.locked) - Number(!!a.locked) || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || Date.parse(b.sourceAt ?? b.updatedAt) - Date.parse(a.sourceAt ?? a.updatedAt))
    .slice(0, i.maxItems ?? 8);
  const lines: string[] = [];
  for (const x of items) {
    const src = [x.sourceAt ? mdOf(x.sourceAt) : "", x.sourceQuote ? `「${x.sourceQuote}」` : ""].filter(Boolean).join(" ");
    lines.push(`- ${MEMO_KIND_JA[x.kind]}: ${x.text}${x.property ? `（${x.property}）` : ""}${x.certainty === "maybe" ? "（たぶん）" : ""}${x.locked ? "【スタッフのメモ】" : ""}${src ? ` ＝${src}` : ""}`);
  }
  const told = i.told.filter((t) => !hidden.has(toldRuleId(t.kind))).slice(0, 8);
  const toldLine = told.length ? `- もう伝えた事（種類と最後の日・回数）: ${told.map((t) => `${TOLD_JA[t.kind]} ${mdOf(t.lastAt)}${t.count > 1 ? `・${t.count}回` : ""}`).join("／")}` : "";
  if (!lines.length && !toldLine) return "";
  return `【お客様のメモ（人の営業のメモ帳・出所つき）】\n${[...lines, toldLine].filter(Boolean).join("\n")}\n→ メモの事情・芯・気にしている事を踏まえて方向を決める。もう伝えた事は言い直さず先へ進める（今回の答えにその中身が要る時・日付や物件を足して進める時だけ書く）`;
}

/** 画面の行（短い箇条・出所つき）。決まった計算の「もう伝えた事」も id 付きで出す（スタッフが外せる） */
export type MemoViewRow = { id: string; kind: MemoKind | "told_kind"; label: string; text: string; source: string; origin: MemoOrigin | "rule"; locked: boolean };
export function memoViewRows(i: { memo: StoredMemo; told: ReadonlyArray<ToldSummary>; nowMs: number }): MemoViewRow[] {
  const hidden = new Set(i.memo.hiddenRuleIds ?? []);
  const rows: MemoViewRow[] = liveItems(i.memo, i.nowMs).map((x) => ({
    id: x.id, kind: x.kind, label: MEMO_KIND_JA[x.kind], text: `${x.text}${x.property ? `（${x.property}）` : ""}${x.certainty === "maybe" ? "（たぶん）" : ""}`,
    source: [x.sourceAt ? mdOf(x.sourceAt) : "", x.sourceBy === "staff" ? "こちら" : "お客様", x.sourceQuote ? `「${x.sourceQuote}」` : ""].filter(Boolean).join(" "),
    origin: x.origin, locked: !!x.locked,
  }));
  for (const t of i.told) if (!hidden.has(toldRuleId(t.kind))) rows.push({ id: toldRuleId(t.kind), kind: "told_kind", label: "もう伝えた", text: TOLD_JA[t.kind], source: `${mdOf(t.lastAt)}${t.count > 1 ? `・${t.count}回` : ""}${t.byAix ? "・AIX" : ""}`, origin: "rule", locked: false });
  return rows;
}
