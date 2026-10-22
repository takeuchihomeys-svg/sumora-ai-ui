// app/lib/aix-brain.ts — AIX のブレイン（実行の指揮官）: AIX の文（1通目・2通目・テンプレート）の組み立てを決め、実行役に書かせ、確かめる（純関数・DB も fetch も持たない）
//
// 2026-10-22 竹内さんの決定（設計知見 4f027a6b・721d5cf3・55575458・76c249e0・d04ed51b）:
//   AIX は LINE のブレイン（統括）が管轄する。統括が「返信か AIX か・どのボタン×ピッカーか・なぜか・要る部品」を決め、
//   AIX のブレインはその下の実行の指揮官として「1通目・2通目・テンプレートの組み立て」（段の順・どの事実・訴求の一文・締め）を決める。
//   実行役（DeepSeek flash＝伏せた・個人情報の無い材料だけ。審査・申込の会話は Claude だけ）が部品を書き、確かめる（足りない物・スタッフだけが知る事の言い切り・竹内基準の形）。
//   書き方は LINE の返信と同じ構成（文の設計図 writing-blueprint・文の基礎の構成・竹内基準）。意味は aixMeaningForGenerator（竹内さんの送信から学んだ物）。
//   お手本の文は渡さない（お手本の金額・物件名を写す恐れ＝10/22「お手本から値を写さない」）。
//
// 流れ（呼ぶ側＝aix/action・aix-template-generate が LLM の呼び出しを持つ・ここは文の組み立てと確かめだけ）:
//   ① 網（決まった処理）: スタッフが入力した事（ピッカーの値）・材料から「必ず入れる字」を拾う（mustItemsOf）
//   ② 指揮官（LLM）: 下書き（今までの書く役の文）・材料・意味・統括の判断の束を読み、設計図（段・事実・外す文・締め）を決める。下書きが設計図どおりなら keep
//   ③ 実行役（LLM）: 設計図どおりに竹内基準で書く
//   ④ 確かめ（決まった処理）: 埋め字・伏せ字の残り・必ず入れる字の抜け・材料に無い数字・スタッフだけが知る事の根拠なし → 下書きより悪ければ下書きを使う
// 切替: AIX_BRAIN（既定＝内覧日調整だけ・off＝全部止める・on＝通せるボタン全部・viewing_invite,… ＝書いたボタンだけ）＝aixBrainEnabledFor
// テスト: app/lib/__tests__/aix-brain.test.ts

export type EnvLike = Record<string, string | undefined>;

/**
 * ボタンごとの切替（2026-10-23 レビューの3回の試験: 内覧日調整だけ on が一貫して良い＝off 約71点 → on 約90点・ほかのボタンはばらつきの中）。
 *   AIX_BRAIN 未設定・空 … 既定＝AIX_BRAIN_DEFAULT_ACTIONS（内覧日調整だけ）
 *   off              … 全部止める
 *   on / all         … 通せるボタン全部（呼ぶ側の AIX_BRAIN_ACTIONS 等で絞った物）
 *   viewing_invite,property_send … 書いたボタンだけ（aix_type の名前・カンマ区切り）
 */
export const AIX_BRAIN_DEFAULT_ACTIONS: readonly string[] = ["viewing_invite"];
export type AixBrainSwitch = { mode: "off" } | { mode: "all" } | { mode: "list"; actions: ReadonlySet<string> };
export function aixBrainSwitch(env: EnvLike = typeof process !== "undefined" ? process.env : {}): AixBrainSwitch {
  const v = (env.AIX_BRAIN ?? "").trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return { mode: "off" };
  if (v === "on" || v === "all" || v === "true" || v === "1") return { mode: "all" };
  const actions = v ? v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [...AIX_BRAIN_DEFAULT_ACTIONS];
  return actions.length ? { mode: "list", actions: new Set(actions) } : { mode: "off" };
}
/** このボタンでブレインを通すか（呼ぶ側の「通せるボタン」の絞りはこの後に掛かる） */
export function aixBrainEnabledFor(aixType: string | null | undefined, env: EnvLike = typeof process !== "undefined" ? process.env : {}): boolean {
  const s = aixBrainSwitch(env);
  return s.mode === "all" || (s.mode === "list" && s.actions.has(String(aixType ?? "").trim().toLowerCase()));
}
/** どれか1つのボタンでも入っているか（AIX_BRAIN=off の時だけ false） */
export function aixBrainOn(env: EnvLike = typeof process !== "undefined" ? process.env : {}): boolean {
  return aixBrainSwitch(env).mode !== "off";
}

/** 指揮官・実行役の呼び出しの名札（llm-alt-provider が DeepSeek の flash に回す・申込以降／審査の事情は Claude） */
export const AIX_BRAIN_ACTION = "aix_brain";

/** 文の名前（統括の判断の束で言う「1通目・2通目・テンプレート」） */
export type AixTextKind = "first" | "second";

export type AixBrainMsg = { sender?: string | null; text?: string | null };

export type AixBrainInput = {
  aixType: string;
  /** ピッカーの値（check_pattern／send_mode／pickupType／viewing_mode） */
  picker: string | null;
  kind: AixTextKind;
  /** お客様の呼び名（「〇〇さん」の〇〇）。無ければ null */
  callName: string | null;
  /** スタッフが入力・選択した事（ピッカーの値・カレンダー・物件名 等）＝スタッフだけが知る事の根拠 */
  staffInputs: Array<[string, string]>;
  /** 材料（物件の資料の事実・1通目の本文・希望条件 等） */
  material: string;
  /** 直近の会話（古い→新しい） */
  recent: ReadonlyArray<AixBrainMsg>;
  /** 統括（LINE のブレイン）の判断の束 */
  bundleNote?: string;
  /** このボタン・ピッカーの意味（竹内基準・お手本なし） */
  meaning?: string;
  /** 呼ぶ側が決めた事（推す物件・締めの向き・退去予定の一文 等） */
  decided?: string[];
  /** 今までの書く役の下書き */
  draft: string;
  /** 呼ぶ側が決めた締めの向き（文に要る）。viewing＝内覧へ・apply＝申込へ・ask_date＝ご都合の日を聞く */
  closeKind?: CloseKind | null;
};
export type CloseKind = "viewing" | "apply" | "ask_date";
export const CLOSE_KIND_RE: Record<CloseKind, RegExp> = {
  viewing: /ご案内|ご内覧|内覧|内見/,
  apply: /お申込|申込(?:み)?(?:し|頂|いただ|で)/,
  ask_date: /ご都合[^。！!\n]{0,16}(?:御座|ござ)いますでしょうか|ご都合[^。！!\n]{0,10}(?:お知らせ|お聞かせ|教えて)/,
};
export const CLOSE_KIND_JA: Record<CloseKind, string> = { viewing: "内覧へ（お気に召されましたらご都合よろしいお日にちにお部屋ご案内）", apply: "申込へ（お気に召されましたらお申込しお部屋抑え）", ask_date: "ご都合よろしいお日にちを伺う" };

// ─── 組み立ての型（竹内さんの形・ボタンごと）────────────────────────────────────
// 中身は竹内さんの決定と aix-catalog の意味（竹内さんの送信の型）から。お手本の値は入れない（形の言葉だけ）。
const FORM_HINTS: Array<{ when: (a: string, p: string | null, k: AixTextKind) => boolean; hint: string }> = [
  { when: (a, _p, k) => a === "property_send" && k === "first",
    hint: "物件ピックアップした（1通目）: 書き出し→「〈エリア〉全域から〈ご条件（会話・希望条件の字のまま・最大4つ）〉で〈名前〉さんにオススメできるお部屋ピックアップさせて頂きました😊！！」の1文（竹内さんの文に入る物＝物件の束）→（材料・会話に根拠がある時だけ）訴求か誘いの1文→「お手隙の際にご査収ください😌！！」。新着・条件を広げた時はその事を会話の字のまま。数字が分からない条件は書かない（〇〇万円 のように埋めない）" },
  { when: (a, _p, k) => a === "property_recommendation" && k === "second",
    hint: "物件オススメ（2通目＝資料の後）: 推す〈物件名 号室〉（材料の字のまま）を頭の方で1回（複数送った束の中から推す時は「お送りさせて頂きましたお部屋の中でも特に」・新着／退去予定ならその一言）→訴求の1文（竹内さんの文に入る物＝1件の推し・金額・設備。材料の推しどころから2〜4つ・字のまま。「〈名前〉さんにかなりオススメ出来る」の形）→【呼ぶ側が決めた事】の締めの向き（内覧へ／申込へ／ご査収）→ご査収。聞かれていない説明（希望とのずれ等）は書かない" },
  { when: (a, _p, k) => a === "property_recommendation" && k === "first",
    hint: "物件オススメ（1通目）: 🌟物件名 号室→（オススメポイント）の箇条（材料の字のまま）→見積書を付けた時は「🌟最大限割引しました初期費用の御見積書同封させて頂きました！」" },
  { when: (a) => a === "property_check_result",
    hint: "物件確認した／確認した: 結果を先に（「〈何を〉確認させて頂きましたところ、〈結果〉」）。どの物件・号室の結果かを会話・入力の字のまま書く（「こちらのお部屋」でぼかさない）。結果はスタッフの入力のまま（ある／無い・可／不可）。次の一手（見積書同封・代わりを探す・誘い）は入力にある物だけ。確認前の文（確認させて頂きます）にしない" },
  { when: (a) => a === "viewing_invite",
    hint: "内覧日調整: 受け（かしこまりました😊！！）→「〈物件名 号室〉お部屋ご案内させて頂きます！！」→「直近ですと」＋スタッフが入力した日時の行（字のまま・全部）→「〈名前〉さんご都合よろしいお日にち御座いますでしょうか😌！！」。日時の入力がある時は必ず日時の行を入れる" },
  { when: (a) => a === "estimate_sheet",
    hint: "見積書送る: 【物件名】→割引の額と初期費用（見積書の字のまま）→節約の一文→※日割の注意。2通目は御見積書の件数・物件名を材料のまま・ご査収" },
  { when: (a) => a === "meeting_place",
    hint: "待ち合わせ: 日時・場所はスタッフの入力のまま。お気をつけてお越しください" },
];
export function formHintOf(aixType: string, picker: string | null, kind: AixTextKind): string {
  return FORM_HINTS.find((h) => h.when(aixType, picker, kind))?.hint ?? "";
}

// ─── ① 網: 必ず入れる字 ────────────────────────────────────────────────
const N = (t: string) => String(t ?? "").normalize("NFKC");
const SQ_RE = /[\s　・()（）「」『』【】🌟,，、。！!？?😊😌]/g;
const squash = (t: string) => N(t).replace(SQ_RE, "").toLowerCase();
/**
 * 物件名の字を変えない正規化（2026-10-23 レビュー: 「鳳Ⅱ」が「鳳II」に書き換わっても NFKC では同じ＝抜けと数えなかった）。
 *   ローマ数字（Ⅰ〜ⅿ）は NFKC を掛けずに残す（全角・半角の英数字・空白の揺れは今まで通り同じと見る）
 */
const NK = (t: string) => String(t ?? "").replace(/[^Ⅰ-ⅿ]+/g, (s) => s.normalize("NFKC"));
const squashKeep = (t: string) => NK(t).replace(SQ_RE, "").toLowerCase();
const DATE_MUST_RE = /^(\d{1,2}\/\d{1,2})\([^)]*\)\s*(\d{1,2}:\d{2})/;

/**
 * 本文の中の「入力の物件名を書き換えた並び」（NFKC で同じだが字が違う＝鳳Ⅱ→鳳II）を入力の字に戻す（決まった処理）。
 *   names は入力の字のまま（号室つき・なしのどちらでも）。字が同じ所は触らない
 */
export function copyNamesVerbatim(text: string, names: ReadonlyArray<string | null | undefined>): { text: string; fixes: Array<{ from: string; to: string }> } {
  let out = String(text ?? "");
  const fixes: Array<{ from: string; to: string }> = [];
  const ks = [...new Set(names.flatMap((n) => { const s = String(n ?? "").trim(); if (!s) return []; const base = s.replace(/\s*\d{2,4}[A-Za-z]?\s*号室?$/, "").trim(); return [s, base]; }).filter((k) => k.length >= 3 && N(k) !== k))]
    .sort((a, b) => b.length - a.length);
  for (const k of ks) {
    const kn = N(k);
    let res = "";
    for (let i = 0; i < out.length;) {
      let hit = 0;
      if (N(out[i]) === kn[0] || out[i] === k[0]) {
        for (let len = Math.max(1, k.length - 2); len <= k.length + 6 && i + len <= out.length; len++) {
          const seg = out.slice(i, i + len);
          // 後ろに英字・ローマ数字が続く（「鳳III」の頭の「鳳II」）時は別の名前＝触らない
          if (N(seg) === kn) { if (!/^[A-Za-zＡ-Ｚａ-ｚⅠ-ⅿ]/.test(out.slice(i + len, i + len + 1)) || !/[A-Za-zⅠ-ⅿ]$/.test(kn)) hit = len; break; }
        }
      }
      if (hit) {
        const seg = out.slice(i, i + hit);
        if (seg !== k) fixes.push({ from: seg, to: k });
        res += k; i += hit;
      } else { res += out[i]; i++; }
    }
    out = res;
  }
  return { text: out, fixes };
}

/** スタッフの入力から「そのまま必ず入れる字」（日時の行・物件名）。網＝候補。決めるのは指揮官（設計図の facts）＋確かめ */
export function mustItemsOf(input: Pick<AixBrainInput, "aixType" | "staffInputs">): string[] {
  const out: string[] = [];
  for (const [k, v0] of input.staffInputs) {
    const v = String(v0 ?? "").trim();
    if (!v) continue;
    if (/カレンダー|内覧の候補|日時/.test(k)) {
      for (const line of v.split(/\n+/)) {
        const m = N(line).match(/(\d{1,2}\/\d{1,2}\([^)]{1,3}\)\s*\d{1,2}:\d{2}(?:\s*[〜~～-]\s*\d{1,2}:\d{2})?)/);
        if (m) out.push(m[1].replace(/\s+/g, " "));
      }
    }
    if (/^物件名$|推す物件/.test(k)) {
      // 物件名は入力の字のまま（NFKC を掛けると「鳳Ⅱ」が「鳳II」になる＝書き換えた名前を抜けと数えなくなる）
      const name = NK(v).replace(/\s*\d{2,4}[A-Za-z]?\s*号室?$/, "").trim();
      if (name.length >= 2) out.push(name);
    }
  }
  return [...new Set(out)];
}

/** 必ず入れる字のうち本文に無い物 */
export function missingMust(text: string, must: ReadonlyArray<string>): string[] {
  const t = squash(text), tk = squashKeep(text);
  return must.filter((m) => {
    const s = squash(m);
    if (!s) return false;
    // 日時は「10/16(金) 13:00〜15:00」を日付と時刻に分けて探す（曜日の表記の揺れ）
    const dm = N(m).match(DATE_MUST_RE);
    if (dm) return !(t.includes(s) || (t.includes(squash(dm[1])) && t.includes(squash(dm[2]))));
    // 物件名: 入力の字のまま（ローマ数字を変えない）で探す。NFKC でだけ同じ＝書き換えた名前は抜け
    const sk = squashKeep(m);
    if (tk.includes(sk)) return false;
    // NFKC でだけ同じ（書き換え）も、頭だけ同じ（字を落とした）も抜け。2026-10-23 試験 it2c: 頭の5字で通すと「プレミアス鳳Ⅱ」→「プレミアス鳳」（Ⅱを落とした）を抜けと数えなかった → 物件名は全部の字を求める（空白・記号の揺れだけ許す）
    return true;
  });
}

// ─── ④ 確かめ ─────────────────────────────────────────────────────────
const PLACEHOLDER_RE = /〇〇|◯◯|○○|〇{1,}(?:万|円|分|号室|帖|階)|◯(?:万|円|分|号室|帖)|【物件名】|\[[^\]\n]{1,20}\]|XX|ＸＸ/;
const MASK_LEAK_RE = /〈名前〉|お客様さん|\[[^\]]*非表示\]|〔[^〕]*〕|【回答済み・非表示】/;
const FACT_RES: Array<[string, RegExp]> = [
  ["日付", /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g],
  ["時刻", /(\d{1,2})[:：](\d{2})/g],
  ["金額", /([\d,]{4,})\s*円/g],
  ["号室", /(\d{2,4})\s*号室/g],
  ["徒歩", /徒歩\s*(\d{1,2})\s*分/g],
  ["広さ", /(\d{1,3}(?:\.\d{1,2})?)\s*(?:帖|畳|㎡)/g],
];
/** 本文の数字の事実で、根拠（材料・スタッフの入力・会話）に無い物 */
export function unfoundedFacts(text: string, basis: string): string[] {
  const out: string[] = [];
  const b = N(basis).replace(/,/g, "");
  for (const [k, re] of FACT_RES) {
    for (const m of N(text).matchAll(re)) {
      const parts = m.slice(1).filter(Boolean).map((x) => x.replace(/,/g, "").replace(/^0+(?=\d)/, ""));
      if (!parts.length) continue;
      const pat = k === "日付" ? `(?<!\\d)0?${parts[0]}\\s*[/月]\\s*0?${parts[1]}(?!\\d)`
        : k === "時刻" ? `(?<!\\d)0?${parts[0]}\\s*[:：時]\\s*${parts[1]}`
        : `(?<![\\d.])${parts.join("\\D{1,3}")}(?![\\d])`;
      let ok = new RegExp(pat).test(b);
      if (!ok && k === "金額") { const n = Number(parts[0]); if (n >= 10000 && n % 1000 === 0) ok = new RegExp(`(?<![\\d.])${n / 10000}\\s*万`).test(b); }
      if (!ok) out.push(`${k}:${parts.join("/")}`);
    }
  }
  return [...new Set(out)];
}

/** スタッフだけが知る事（募集状況・割引・確認の結果）の言い切り */
const STAFF_CLAIMS: Array<[string, RegExp]> = [
  ["募集中", /募集中|空いて(?:おり|い)|空室/],
  ["募集終了", /募集(?:が)?終了|埋まって|(?:お)?申込(?:み)?が入|成約(?:済|と)|募集に出ていない|募集されていない/],
  ["割引", /最大限割引|[\d,]+円(?:の)?割引|割引(?:させて|致し|して)/],
  ["確認済み", /確認(?:致し|させて頂き|させていただき)ました|確認が取れ|確認(?:致し|した|させて頂き)ましたところ/],
];
export function claimsOf(t: string): Set<string> { const s = N(t); return new Set(STAFF_CLAIMS.filter(([, re]) => re.test(s)).map(([k]) => k)); }

// ─── 文の働き（同じ働きの文を重ねない・組み立てと確かめで使う）─────────────────────────────
// 2026-10-23 レビュー（内覧日調整）: 下書きの「お部屋ご案内させて頂きます！！」の前に実行役の「〈物件〉の102号室にてご案内させて頂きます」「内覧のご希望承りました」が足され、
//   受け・ご案内の宣言が2回になった → 働きで見て、同じ働きの文が下書きにあれば足さない（足す方に物件名・号室等の事実があって下書きの文に無い時は、下書きの文と入れ替える）
export type LineFunction = "受け" | "ご案内の宣言" | "直近ですと" | "ご都合の伺い";
const LINE_FUNCTIONS: Array<[LineFunction, RegExp]> = [
  ["受け", /かしこまりました|承知(?:致し|いたし)?ました|承りました|^\s*はい[😊😌]*[！!、。]*\s*$/],
  ["ご案内の宣言", /(?:ご)?案内(?:させて|致し|いたし)(?:頂|いただ)?きます|ご案内(?:です|致します)|ご案内させて(?:頂|いただ)ければ/],
  ["直近ですと", /^\s*直近ですと/],
  ["ご都合の伺い", /ご都合[^。！!\n]{0,20}(?:御座|ござ)いますでしょうか|ご都合[^。！!\n]{0,20}(?:伺え|お知らせ|お聞かせ|教えて)/],
];
/** 文（1行・1文）の働き。「〜にてご案内可能です」は日時の段の終わり（宣言ではない） */
export function lineFunctionsOf(line: string): LineFunction[] {
  const s = N(line);
  return LINE_FUNCTIONS.filter(([, re]) => re.test(s)).map(([k]) => k);
}
const sentencesOf = (text: string) => String(text ?? "").split(/\n|(?<=！！)/).map((x) => x.trim()).filter(Boolean);
/** 同じ働きの文が2回以上ある働き */
export function dupFunctionsOf(text: string): LineFunction[] {
  const count = new Map<LineFunction, number>();
  for (const sent of sentencesOf(text)) for (const f of lineFunctionsOf(sent)) count.set(f, (count.get(f) ?? 0) + 1);
  return [...count].filter(([, n]) => n >= 2).map(([f]) => f);
}

export type AixBrainIssues = {
  placeholder: boolean;
  maskLeak: boolean;
  missingMust: string[];
  unfounded: string[];
  staffNoBasis: string[];
  /** 名前の呼びかけが下書きにあって消えた */
  nameLost: boolean;
  empty: boolean;
  /** 決めた締めの向きが文に無い */
  closeMissing: CloseKind | null;
  /** 同じ働きの文が2回（受け・ご案内の宣言・直近ですと・ご都合の伺い） */
  dupParts: string[];
};
export function checkAixText(text: string, o: { must: ReadonlyArray<string>; basis: string; staffBasis: string; callName: string | null; draft?: string; closeKind?: CloseKind | null }): AixBrainIssues {
  const t = String(text ?? "").trim();
  const basisClaims = claimsOf(o.staffBasis);
  const callRe = o.callName ? new RegExp(`${o.callName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:さん|様)`) : null;
  return {
    empty: !t,
    placeholder: PLACEHOLDER_RE.test(N(t)),
    maskLeak: MASK_LEAK_RE.test(t),
    missingMust: missingMust(t, o.must),
    unfounded: unfoundedFacts(t, o.basis),
    staffNoBasis: [...claimsOf(t)].filter((c) => !basisClaims.has(c)),
    nameLost: !!callRe && !!o.draft && callRe.test(o.draft) && !callRe.test(t),
    closeMissing: o.closeKind && !CLOSE_KIND_RE[o.closeKind].test(N(t)) ? o.closeKind : null,
    dupParts: dupFunctionsOf(t),
  };
}
/** 重さ（大きいほど悪い）。埋め字・伏せ字・空は送れない＝大きく */
export function issueWeight(i: AixBrainIssues): number {
  return (i.empty ? 100 : 0) + (i.maskLeak ? 50 : 0) + (i.placeholder ? 20 : 0) + 6 * i.missingMust.length + 5 * i.unfounded.length + 4 * i.staffNoBasis.length + (i.nameLost ? 2 : 0) + (i.closeMissing ? 5 : 0) + 3 * (i.dupParts?.length ?? 0);
}
export function describeIssues(i: AixBrainIssues): string[] {
  const L: string[] = [];
  if (i.empty) L.push("空");
  if (i.maskLeak) L.push("伏せ字の残り");
  if (i.placeholder) L.push("埋め字（〇〇 等）");
  if (i.missingMust.length) L.push(`必ず入れる字の抜け: ${i.missingMust.join("・")}`);
  if (i.unfounded.length) L.push(`材料に無い数字: ${i.unfounded.join("・")}`);
  if (i.staffNoBasis.length) L.push(`スタッフの入力に無い言い切り: ${i.staffNoBasis.join("・")}`);
  if (i.nameLost) L.push("名前の呼びかけが消えた");
  if (i.closeMissing) L.push(`決めた締めが無い: ${CLOSE_KIND_JA[i.closeMissing]}`);
  if (i.dupParts?.length) L.push(`同じ働きの文が重なる: ${i.dupParts.join("・")}`);
  return L;
}

// ─── ② 指揮官 ─────────────────────────────────────────────────────────
// 2026-10-22 試験 aixbrain1: 実行役に全文を書き直させると、下書き（専用の指示で書いた良い形）が崩れた（「何卒😊」「直近ですと＋明日…」・会話の別の日時の持ち込み）。
//   → 指揮官は「下書きのどの文を外し、どこに何の部品を足すか」を決め、実行役は足す部品の文だけを書き、組み立ては決まった処理（assembleText）。
export const CONDUCTOR_SYSTEM = `あなたは不動産仲介スモラの「AIX のブレイン（実行の指揮官）」。LINE のブレイン（統括）が決めたボタン×ピッカーで送る文（1通目・2通目・テンプレート）の組み立てを決める。
下書きは別の実行役が専用の指示で書いた物。あなたは下書きを土台に「外す文」と「足す部品（どこに・何を）」だけを決めて JSON で返す。部品の文は別の実行役が書く。

【文の基礎の構成（竹内さん・LINE の返信と同じ）】
書き出し（〈名前〉さん＋挨拶）→受け止め（かしこまりました／お礼・1回だけ）→本題（結果・答え・推す物件）→訴求（材料にある事実で・1文）→誘い（内覧・申込）→締め（ご査収・何卒）。
同じ言葉・同じ働きの文を重ねない。説明口調・作業の説明を入れない。竹内さんの文は短い（3〜6文）。

【決め方】
- 【このボタン・ピッカーの意味】の「竹内さんの文に入る物」・【組み立ての型】・【必ず入れる字】のうち、下書きに無い物だけを部品として足す。
- 下書きの文で、材料・スタッフの入力に根拠の無い言い切り・場違いの文（聞かれていない説明・同じ働きの重なり・作業の説明）は外す。
- 〇〇 のような埋め字のある文は、文ごと消さず、埋め字の条件だけを抜いた形（数字の無い言い方）の部品に置き換える（ほかの条件の語は字のまま残す）。
- 件数・数を足さない（材料に書いてある時だけ）。
- 正しい文は触らない（言い回しを変えるためだけに外して足し直さない）。足す物も外す物も無ければ keep=true。
- スタッフだけが知る事（募集状況・確認の結果・見積の金額・割引・内覧の日時・交渉の結果）は【スタッフが入力した事】にある物だけ。物件名・号室・金額・帖・駅徒歩・日付・時刻は材料・入力の字のまま（部品の facts に写す）。分からない数字は足さない。
- 【統括の判断の束】【呼ぶ側が決めた事】（推す物件・締めの向き）は上書きしない。会話の中の別の日時・別の物件を持ち込まない。

【返す JSON だけ】
{"keep":true|false,"why":"短く","drop":["下書きから外す文（下書きの字のまま）"],"add":[{"part":"受け止め|本題|訴求|誘い|締め|日時","after":"この部品を置く直前の下書きの文（字のまま）か「先頭」か「締めの前」","brief":"この部品で言う事（短く）","facts":["そのまま写す事実（材料・入力の字）"]}],"close":"ご査収|内覧へ|申込へ|質問|何卒|なし"}`;

const short = (s: string, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

export function recentBlock(recent: ReadonlyArray<AixBrainMsg>, maxMsgs = 8, maxChars = 500): string {
  const rows = recent.filter((m) => String(m?.text ?? "").trim()).slice(-maxMsgs);
  return rows.map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${short(String(m.text ?? "").replace(/\n{2,}/g, "\n"), maxChars)}`).join("\n");
}

export function staffInputsBlock(staffInputs: ReadonlyArray<[string, string]>): string {
  return staffInputs.filter(([, v]) => String(v ?? "").trim()).map(([k, v]) => `・${k}: ${String(v).trim()}`).join("\n");
}

export function buildConductorUser(input: AixBrainInput, must: ReadonlyArray<string>, found: ReadonlyArray<string> = []): string {
  const L: string[] = [];
  L.push(`【ボタン×ピッカー】${input.aixType}${input.picker ? ` → ${input.picker}` : ""}（${input.kind === "first" ? "1通目（AIX の本文）" : "2通目・テンプレート（資料の後の文）"}）`);
  const hint = formHintOf(input.aixType, input.picker, input.kind);
  if (hint) L.push(`【組み立ての型（竹内さんの形）】\n${hint}`);
  if (input.meaning?.trim()) L.push(input.meaning.trim());
  if (input.bundleNote?.trim()) L.push(`【統括の判断の束】\n${short(input.bundleNote, 1500)}`);
  const decidedAll = [...(input.decided ?? []), ...(input.closeKind ? [`締めの向き: ${CLOSE_KIND_JA[input.closeKind]}`] : [])];
  if (decidedAll.length) L.push(`【呼ぶ側が決めた事】\n${decidedAll.map((d) => `・${d}`).join("\n")}`);
  const si = staffInputsBlock(input.staffInputs);
  L.push(`【スタッフが入力した事（スタッフだけが知る事の根拠）】\n${si || "（なし）"}`);
  if (must.length) L.push(`【必ず入れる字（スタッフの入力・そのまま）】\n${must.map((m) => `・${m}`).join("\n")}`);
  if (input.material.trim()) L.push(`【材料】\n${short(input.material, 2500)}`);
  const rc = recentBlock(input.recent);
  if (rc) L.push(`【直近の会話（古い→新しい）】\n${rc}`);
  L.push(`【下書き（土台）】\n${input.draft}`);
  if (found.length) L.push(`【確かめで見つかった下書きの外れ（これを直す・ほかは触らない）】\n${found.map((f) => `・${f}`).join("\n")}`);
  L.push("仕事: 外す文と足す部品を JSON で返す。");
  return L.join("\n\n");
}

export type PlanAdd = { part: string; after: string; brief: string; facts: string[] };
export type ConductorPlan = { keep: boolean; why: string; drop: string[]; add: PlanAdd[]; close: string };
export function parseConductorPlan(raw: string): ConductorPlan | null {
  const s = String(raw ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    const o = JSON.parse(s.slice(i, j + 1)) as Record<string, unknown>;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
    const add = Array.isArray(o.add) ? (o.add as unknown[]).map((p) => {
      const r = (p ?? {}) as Record<string, unknown>;
      return { part: String(r.part ?? "").trim(), after: String(r.after ?? "").trim(), brief: String(r.brief ?? "").trim(), facts: arr(r.facts).slice(0, 8) };
    }).filter((p) => p.brief).slice(0, 5) : [];
    return { keep: o.keep === true, why: String(o.why ?? "").trim(), drop: arr(o.drop).slice(0, 6), add, close: String(o.close ?? "").trim() };
  } catch { return null; }
}

// ─── ③ 実行役（足す部品の文だけを書く）─────────────────────────────────────
export const EXECUTOR_SYSTEM = `あなたは不動産仲介スモラの AIX の実行役（部品の文を書く役）。指揮官が決めた部品ごとに、竹内さんの書き方で1〜2文ずつ書く。部品以外は書かない。

【竹内基準の書き方（絶対）】
- 文末は「！！」。絵文字は 😊 か 😌 を文末に（部品全体で1個まで・ほかの絵文字は使わない）。
- 頂く・致します・御座います は漢字。「お待たせ致しました」は使わない。名前を書く時は「〈名前〉さん」。
- 事実（物件名・号室・金額・帖・駅徒歩・日付・時刻）は facts の字のまま。facts に無い数字・物件名・日時は書かない。〇〇 のような埋め字は書かない。
- 日時の部品は「直近ですと」の行の後に facts の日時を1行ずつ（字のまま）、最後の行に「にてご案内可能です！！」。
- ご都合を伺う部品は「〈名前〉さんご都合よろしいお日にち御座いますでしょうか😌！！」の字のまま（「伺えますと幸いです」等に言い換えない）。
- 前後の下書きの文と同じ言葉を繰り返さない。挨拶・名前の呼びかけ・締めの言葉は、その部品でなければ書かない。

【返す JSON だけ】{"parts":["部品1の文","部品2の文"]}（指揮官の部品の順・同じ数。1つの部品は2文でも1つの文字列に入れる）
- brief と facts に無い事（日当たり・広さの感想・お客様の予定の推測）は足さない。`;

export function buildExecutorUser(input: AixBrainInput, plan: ConductorPlan): string {
  const L: string[] = [];
  L.push(`【部品（指揮官）】\n${plan.add.map((p, i) => `${i + 1}. ${p.part}: ${p.brief}${p.facts.length ? `｜facts: ${p.facts.join(" ／ ")}` : ""}`).join("\n")}`);
  const si = staffInputsBlock(input.staffInputs);
  if (si) L.push(`【スタッフが入力した事】\n${si}`);
  if (input.material.trim()) L.push(`【材料】\n${short(input.material, 1500)}`);
  L.push(`【前後の下書き（参考・書き直さない）】\n${input.draft}`);
  L.push("仕事: 部品の文を JSON で返す。");
  return L.join("\n\n");
}
export function parseExecutorParts(raw: string, n: number): string[] | null {
  const s = String(raw ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    const o = JSON.parse(s.slice(i, j + 1)) as Record<string, unknown>;
    const parts = Array.isArray(o.parts) ? (o.parts as unknown[]).map((x) => String(x ?? "").trim()) : [];
    // 2026-10-22 試験 aixbrain3: 1つの部品を2文に分けて返す（配列の数が多い）→ 前から部品の数だけ使う（足された飾りの文は使わない）
    const use = parts.slice(0, n);
    return use.length === n && use.every(Boolean) ? use : null;
  } catch { return null; }
}
/** 旧（全文を書かせた形）の読み。今は使わない（テストの互換） */
export function parseExecutorMessage(raw: string): string {
  const s = String(raw ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { const o = JSON.parse(s.slice(i, j + 1)) as Record<string, unknown>; if (typeof o.message === "string") return o.message.trim(); } catch { /* 下へ */ }
  }
  return "";
}

// ─── 組み立て（決まった処理）──────────────────────────────────────────────
const CLOSING_LINE_RE = /ご査収|何卒|よろしくお願い|お気軽に/;
const DATE_LINE_RE = /^\s*(?:明日|本日|今日)?\s*\d{1,2}\s*[\/月]\s*\d{1,2}/;
const DATE_BLOCK_RE = /^\s*直近ですと|ご案内可能/;
/** 日時の段（直近ですと→日時の行→にてご案内可能です）の途中か（ここに部品を挟むと段が割れる） */
function insideDateBlock(lines: ReadonlyArray<string>, at: number): boolean {
  if (at <= 0 || at >= lines.length) return false;
  const cur = lines[at], prev = lines[at - 1];
  if (/^\s*(?:にて|で(?:の)?ご案内|と(?:なり|なって))/.test(cur)) return true;
  return (DATE_LINE_RE.test(cur) || /^\s*にて/.test(cur)) && (DATE_LINE_RE.test(prev) || /^\s*直近ですと/.test(prev));
}
/** 文に物件名・号室等の事実があるか（keyFacts は入力の字＝物件名） */
/** 事実の多さ（入力の物件名を字のまま全部含む＝2・頭だけ＝1・号室＝1）。入れ替えるかの比べに使う */
function keyFactScore(s: string, keyFacts: ReadonlyArray<string>): number {
  const sk = squashKeep(s);
  let n = /\d{2,4}\s*号室/.test(N(s)) ? 1 : 0;
  for (const f of keyFacts) {
    const fk = squashKeep(f);
    if (fk.length < 3) continue;
    if (sk.includes(fk)) n += 2; else if (sk.includes(fk.slice(0, Math.min(5, fk.length)))) n += 1;
  }
  return n;
}
/** 日時の段（直近ですと の行から、日時の行・「にてご案内可能」の行まで）の範囲と日時の行の数。無ければ null */
// 2026-10-23 試験 it2b-view-r3: 下書きが「最短ですと」で始めた段を見落とし、部品の「直近ですと」の段を別に足した → 段の始まりを広げる・間の空行は段の中
const DATE_INTRO_RE = /^\s*(?:直近|最短|明日|本日|今日)[^。！!\n]{0,14}ですと[😊😌！!]*\s*$/;
function dateBlockOf(lines: ReadonlyArray<string>): { from: number; to: number; dates: number } | null {
  let from = lines.findIndex((l) => DATE_INTRO_RE.test(l) || /^\s*直近ですと/.test(l));
  if (from < 0) from = lines.findIndex((l) => DATE_LINE_RE.test(l));
  if (from < 0) return null;
  let to = from, dates = DATE_LINE_RE.test(lines[from]) ? 1 : 0;
  if (dates && /ご案内可能/.test(lines[from])) return { from, to, dates };
  for (let k = from + 1; k < lines.length; k++) {
    const l = lines[k];
    if (!l.trim()) { if (k + 1 < lines.length && (DATE_LINE_RE.test(lines[k + 1]) || /^\s*にて/.test(lines[k + 1]))) continue; break; }
    if (DATE_LINE_RE.test(l)) { dates++; to = k; if (/ご案内可能/.test(l)) break; continue; }
    if (/^\s*にて|ご案内可能/.test(l)) to = k;
    break;
  }
  return { from, to, dates };
}
/**
 * 部品の文のうち、下書きに同じ働きの文がある物を除く（2026-10-23 レビュー・内覧日調整の重なり）。
 *   足す文に物件名・号室があって下書きの同じ働きの文に無い時は、下書きの文をその文に入れ替える（場所は下書きのまま）。
 *   日時の段（直近ですと）が下書きにあれば、部品の日時の段は丸ごと足さない。戻りは残った部品の文（空なら足さない）
 */
export function dedupePart(lines: string[], part: string, keyFacts: ReadonlyArray<string> = []): string {
  // 日時の段は2回足さない。部品の段の方が日時の行が多い（下書きが日時を落とした）時は、下書きの段をその場で部品の段に入れ替える
  const db = dateBlockOf(lines);
  const pl = part.split("\n");
  const pb = dateBlockOf(pl);
  if (db && pb && pb.dates > 0) {
    const dateKey = (l: string) => { const m = N(l).match(/(\d{1,2}\/\d{1,2})[^\d]{0,6}(\d{1,2}:\d{2})/); return m ? `${m[1]} ${m[2]}` : squash(l); };
    const have = new Set(lines.slice(db.from, db.to + 1).filter((l) => DATE_LINE_RE.test(l)).map(dateKey));
    const partDates = pl.slice(pb.from, pb.to + 1).filter((l) => DATE_LINE_RE.test(l));
    const newDates = partDates.map((l) => l.replace(/\s*にて.*$/, "").trim()).filter((l) => l && !have.has(dateKey(l)));
    if (pb.dates > db.dates && [...have].every((k) => partDates.some((l) => dateKey(l) === k))) {
      // 部品の段が下書きの日時を全部含んで多い → 段ごと入れ替える
      lines.splice(db.from, db.to - db.from + 1, ...pl.slice(pb.from, pb.to + 1));
    } else if (newDates.length) {
      // 下書きの段に無い日時の行だけを、段の最後（「にてご案内可能」の前）に足す
      const last = db.to, m = lines[last].match(/^(.*?)(\s*にて.*)$/);
      if (m && DATE_LINE_RE.test(m[1])) { lines[last] = m[1]; newDates[newDates.length - 1] += m[2].trim(); lines.splice(last + 1, 0, ...newDates); }
      else if (/^\s*にて/.test(lines[last])) lines.splice(last, 0, ...newDates);
      else lines.splice(last + 1, 0, ...newDates);
    }
    const rest = [...pl.slice(0, pb.from), ...pl.slice(pb.to + 1)].join("\n").trim();
    return rest ? dedupePart(lines, rest, keyFacts) : "";
  }
  const keep: string[] = [];
  for (const pl of part.split("\n")) {
    const sents = pl.split(/(?<=！！)/).filter((x) => x.trim());
    const rest: string[] = [];
    for (const s of sents) {
      const fs = lineFunctionsOf(s);
      if (!fs.length) { rest.push(s); continue; }
      const idx = lines.findIndex((l) => sentencesOf(l).some((ls) => lineFunctionsOf(ls).some((f) => fs.includes(f))));
      if (idx < 0) { rest.push(s); continue; }
      if (keyFactScore(s, keyFacts) > keyFactScore(lines[idx], keyFacts)) {
        // 下書きの同じ働きの文（行の中の1文）だけを入れ替える
        const old = sentencesOf(lines[idx]).find((ls) => lineFunctionsOf(ls).some((f) => fs.includes(f))) ?? lines[idx];
        lines[idx] = lines[idx].replace(old, s.trim());
      }
    }
    if (rest.join("").trim()) keep.push(rest.join("").trim());
    else if (!sents.length) keep.push(pl);
  }
  return keep.join("\n").replace(/^\n+|\n+$/g, "");
}
/** 下書きの行から外す文を消し、部品を置く（置き場所が見つからない部品は締めの前）。同じ働きの文は重ねない・日時の段は割らない */
export function assembleText(draft: string, plan: Pick<ConductorPlan, "drop" | "add">, parts: ReadonlyArray<string>, opts: { keyFacts?: ReadonlyArray<string> } = {}): string {
  let lines = String(draft ?? "").replace(/\r/g, "").split("\n");
  for (const d of plan.drop) {
    const ds = squash(d);
    if (ds.length < 4) continue;
    lines = lines.flatMap((l) => {
      const ls = squash(l);
      if (!ls) return [l];
      if (ls === ds || (ds.includes(ls) && ls.length >= 4)) return [];
      if (ls.includes(ds)) { const rest = l.replace(d, "").trim(); return rest && squash(rest).length >= 4 ? [rest] : []; }
      return [l];
    });
  }
  const closingIdx = () => { for (let i = lines.length - 1; i >= 0; i--) if (CLOSING_LINE_RE.test(lines[i])) { let k = i; while (k > 0 && CLOSING_LINE_RE.test(lines[k - 1])) k--; return k; } return lines.length; };
  plan.add.forEach((a, i) => {
    const text = dedupePart(lines, String(parts[i] ?? "").trim(), opts.keyFacts ?? []).trim();
    if (!text) return;
    let at: number;
    if (a.after === "先頭") {
      // 名前・挨拶・受けの行の後
      let k = 0; while (k < lines.length && (!lines[k].trim() || (/さん|お世話|夜分|かしこまり|ありがとう|はい/.test(lines[k]) && lines[k].length <= 40))) k++;
      at = k;
    } else if (a.after === "締めの前" || !a.after) at = closingIdx();
    else {
      const as = squash(a.after);
      const idx = as.length >= 4 ? lines.findIndex((l) => { const ls = squash(l); return ls && (ls.includes(as) || as.includes(ls)); }) : -1;
      at = idx >= 0 ? idx + 1 : closingIdx();
    }
    // 日時の段の途中には挟まない（試験: 「…16:00〜17:30」と「にてご案内可能です！！」の間にご都合の伺いが入った）
    while (insideDateBlock(lines, at)) at++;
    // ご都合の伺いは日時の段より後（日時を出す前に聞かない）
    if (lineFunctionsOf(text).includes("ご都合の伺い")) {
      let last = -1; lines.forEach((l, k) => { if (DATE_BLOCK_RE.test(l) || DATE_LINE_RE.test(l)) last = k; });
      if (last >= at) at = last + 1;
    }
    const block = ["", ...text.split("\n"), ""];
    lines.splice(at, 0, ...block);
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// ─── 名前の伏せ（DeepSeek に回る時・呼ぶ側の伏せの前に呼び名を札にする）────────────────────
export const NAME_TOKEN = "〈名前〉";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function tokenizeName(text: string, callName: string | null): string {
  if (!callName || callName.length < 1) return text;
  return String(text ?? "").replace(new RegExp(escRe(callName), "g"), NAME_TOKEN);
}
export function restoreName(text: string, callName: string | null): string {
  return String(text ?? "").split(NAME_TOKEN).join(callName ?? "お客様");
}

// ─── 選ぶ ─────────────────────────────────────────────────────────────
export type AixBrainChoice = { text: string; used: "draft" | "brain"; reason: string; draftIssues: AixBrainIssues; brainIssues: AixBrainIssues | null };
/** 実行役の文が下書きより悪くない時だけ使う（埋め字・伏せ字・空は必ず落とす） */
export function chooseText(draft: string, brain: string | null, check: (t: string) => AixBrainIssues): AixBrainChoice {
  const di = check(draft);
  if (!brain || !brain.trim()) return { text: draft, used: "draft", reason: "実行役の文なし", draftIssues: di, brainIssues: null };
  const bi = check(brain);
  if (bi.empty || bi.maskLeak || (bi.placeholder && !di.placeholder)) return { text: draft, used: "draft", reason: `実行役の文が送れない（${describeIssues(bi).join("／")}）`, draftIssues: di, brainIssues: bi };
  // 下書きに無い新しい事実（材料に無い数字・スタッフの入力に無い言い切り）を持ち込んだら、他の外れが減っても使わない（足し引きで新しい事実を通さない）
  const added = [...bi.unfounded.filter((x) => !di.unfounded.includes(x)), ...bi.staffNoBasis.filter((x) => !di.staffNoBasis.includes(x))];
  if (added.length) return { text: draft, used: "draft", reason: `実行役の文が下書きに無い事実を持ち込んだ（${added.join("・")}）`, draftIssues: di, brainIssues: bi };
  const wd = issueWeight(di), wb = issueWeight(bi);
  if (wb >= wd) return { text: draft, used: "draft", reason: `組み立てで確かめの外れが減らない（${wb}≥${wd}）`, draftIssues: di, brainIssues: bi };
  return { text: brain.trim(), used: "brain", reason: wb < wd ? `確かめの外れが減った（${wd}→${wb}）` : "設計図どおり", draftIssues: di, brainIssues: bi };
}
