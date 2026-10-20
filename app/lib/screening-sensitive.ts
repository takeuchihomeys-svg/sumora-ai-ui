// app/lib/screening-sensitive.ts
// 審査に関わる「人の事情」（職業・国籍・保証人の事情・他人の名義・借金や滞納・生活保護 等）が会話に出たかを決める（純関数・LLM なし）。
//
// 2026-10-20 竹内「個人情報が絡む部分はかならずクロードにする」「質の影響でなければ出来る限り個人情報にちかいのも渡さない」:
//   監査で、名前・番号の伏せ（maskPII）と申込の線（post-apply.ts）だけでは止まらない道が見つかった。
//   お客様が申込の前に「夜の仕事で保証人が使えない・恋人の名義で審査を通したい・恋人は外国籍で求職中」の様に打ち明けると、
//   ① お客様のメモ（customer-memo-server・必ず DeepSeek）が「事情」として読む
//   ② 返信の下書き（reply_generate・本番は DeepSeek）の履歴にそのまま入る
//   → この判定が当たった会話は、返信の下書きを Claude に固定し（申込以降と同じ blocked の印を使う）、メモの LLM 読み取りは止める。
//
// 【当てる物】お客様の打ち明け・スタッフ／AIX の審査の返事に出る「その人の事情」だけ。
// 【当てない物】物件の条件（「外国人可」「保証人不要」「生活保護相談可」「水商売不可」）・「保証会社」だけ・「職場」「勤務先」だけ。
//   条件の言い方（語の直後に 可／OK／不可／NG／相談可／歓迎／不要／不問）は判定の前に消してから見る。
// 戻す: SCREENING_PII_CLAUDE=off（既定 on・締める側の安全策）

export type ScreeningSensitiveCategory =
  | "職業（夜の仕事・無職 等）"
  | "国籍・在留"
  | "保証人の事情"
  | "他人の名義"
  | "借金・滞納・信用"
  | "生活保護・受給"
  | "前科"
  | "家庭の事情（離婚・DV 等）";

export type ScreeningSensitiveHit = { category: ScreeningSensitiveCategory; word: string };

/** 物件の条件の言い方（語＋可／不可…）。判定の前に消す */
const CONDITION_SUFFIX = String.raw`(?:の方|の人|の入居)?(?:も|は)?\s*(?:[（(]?\s*)?(?:可能?|ＯＫ|OK|ok|不可|NG|ＮＧ|相談(?:可能?)?|応相談|歓迎|不要|不問|なし|無し|ナシ|OK物件|可物件|可の物件|入居可|(?:契約|入居|受け?入れ)(?:可能?|OK|ＯＫ|不可))`;
const CONDITION_TERMS = [
  "外国人", "外国籍", "留学生", "生活保護", "生保", "水商売", "夜職", "夜のお仕事", "風俗", "無職", "保証人", "連帯保証人", "高齢者", "母子家庭", "シングルマザー", "ブラック",
];
const CONDITION_RE = new RegExp(`(?:${CONDITION_TERMS.join("|")})${CONDITION_SUFFIX}`, "g");

const RULES: Array<{ category: ScreeningSensitiveCategory; re: RegExp }> = [
  { category: "職業（夜の仕事・無職 等）", re: /夜職|夜の(?:お)?仕事|水商売|キャバ(?:クラ|嬢)|ホステス|風俗(?:店|嬢|勤務|で働)|ガールズバー|ラウンジ(?:勤務|嬢|で働)|スナック(?:勤務|で働)|無職|求職中|失業中?|休職中|就活中|就職活動中|仕事を?(?:辞めて|やめて|探して)(?:いる|います|おり|て)/ },
  { category: "国籍・在留", re: /外国人|外国籍|在留(?:カード|資格|期限)|就労ビザ|ビザ(?:が|の更新|更新|の期限)|留学生|日本国籍(?:では|じゃ)?(?:ない|無い|ありません)/ },
  { category: "保証人の事情", re: /保証人(?:が|は|も)?\s*(?:いない|いません|居ない|おらず|おりません|使えない|使えません|立てられ|頼めない|頼めません|頼れる|見つからない|用意(?:でき|出来)(?:ない|ません))|保証人(?:に)?なって(?:くれる|もらえる)人が/ },
  { category: "他人の名義", re: /(?:彼氏|彼女|恋人|婚約者|旦那|主人|夫|妻|嫁|親|父|母|兄|姉|弟|妹|祖父|祖母|友人|友達|知人|パートナー)(?:さん)?の?名義|名義(?:を)?(?:借り|貸し)|名義人(?:を|に)(?:彼氏|彼女|恋人|親|友人)/ },
  { category: "借金・滞納・信用", re: /滞納|延滞|借金|借入|借り入れ|自己破産|破産|債務整理|任意整理|個人再生|ブラック(?:リスト|です|なんです|になって|になり|かも|入り|で|の可能性)|信用情報|カード(?:の)?(?:支払い|返済)(?:が)?(?:遅れ|止まっ)|携帯(?:代|料金)(?:の)?未払い|未払い(?:が|の)?(?:ある|あり)/ },
  { category: "生活保護・受給", re: /生活保護|生保(?:受給|で|です|の方)|保護受給|障害年金|障(?:害|がい)者手帳/ },
  { category: "前科", re: /前科|刑務所|服役|出所/ },
  { category: "家庭の事情（離婚・DV 等）", re: /離婚(?:調停|協議|中|して|する|予定)|ＤＶ|\bDV\b|別居中|シングルマザー|母子家庭|父子家庭/ },
];

/** 文に審査に関わる人の事情があれば最初の当たり、無ければ null */
export function screeningSensitiveSignal(text: string | null | undefined): ScreeningSensitiveHit | null {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  // URL・物件の条件の言い方は消してから見る
  const t = raw.replace(/https?:\/\/\S+/g, " ").replace(CONDITION_RE, " ");
  for (const r of RULES) {
    const m = t.match(r.re);
    if (m) return { category: r.category, word: m[0] };
  }
  return null;
}

export type SensitiveMsg = { sender?: string | null; text?: string | null; isAix?: boolean | null; checkPattern?: string | null };

/**
 * スタッフ／AIX の通を見るか: 審査の返事（AIX の check_pattern が審査・保証人・入居審査の確認の物）だけ。
 *   2026-10-20 時点で check_pattern に mgmt_screening は無い（実データ 90日: mgmt_guarantor 2件）。審査の確認に当たる mgmt_guarantor と、
 *   今後付く mgmt_screening／screening_* を含める。スタッフの定型の物件紹介（「外国籍の方も相談できます」）まで見ると当たりすぎるので、印の無い通は見ない。
 */
export const SCREENING_CHECK_PATTERNS = ["mgmt_screening", "mgmt_guarantor"] as const;
export function isScreeningCheckPattern(p: string | null | undefined): boolean {
  const s = (p ?? "").trim();
  return (SCREENING_CHECK_PATTERNS as readonly string[]).includes(s) || s.startsWith("screening");
}

/** 会話の窓（送る通）に審査の事情があるか。お客様の通は全部・スタッフ／AIX の通は審査の確認の印がある物だけ */
export function screeningSensitiveInMessages(msgs: ReadonlyArray<SensitiveMsg>): ScreeningSensitiveHit | null {
  for (const m of msgs) {
    const sender = (m.sender ?? "").trim();
    const look = sender === "customer" || isScreeningCheckPattern(m.checkPattern);
    if (!look) continue;
    const hit = screeningSensitiveSignal(m.text);
    if (hit) return hit;
  }
  return null;
}

/** 使うか（既定 on・SCREENING_PII_CLAUDE=off で旧の動き） */
export function screeningPiiClaudeEnabled(env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): boolean {
  return (env.SCREENING_PII_CLAUDE ?? "on").trim().toLowerCase() !== "off";
}

/** DB で先に絞る語（どの規則も必ずどれかを含む。ilike の OR） */
export const SCREENING_SENSITIVE_PREFILTER_WORDS = [
  "夜職", "夜の仕事", "夜のお仕事", "水商売", "キャバ", "ホステス", "風俗", "ガールズバー", "ラウンジ", "スナック", "無職", "求職", "失業", "休職", "就活", "就職活動", "仕事を",
  "外国", "在留", "ビザ", "留学生", "日本国籍", "保証人", "名義", "滞納", "延滞", "借金", "借入", "借り入れ", "破産", "債務", "任意整理", "個人再生", "ブラック", "信用情報",
  "カード", "未払い", "生活保護", "生保", "保護受給", "障害年金", "障害者", "障がい者", "前科", "刑務所", "服役", "出所", "離婚", "DV", "ＤＶ", "別居", "シングルマザー", "母子家庭", "父子家庭",
];
export const SCREENING_SENSITIVE_PREFILTER = SCREENING_SENSITIVE_PREFILTER_WORDS.map((w) => `text.ilike.%${w}%`).join(",");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
type Res = { data: unknown; error: { message: string } | null };

/**
 * 会話のお客様の通（新しい方から 300通・語で先に絞る）に審査の事情があるか。会話ごとに一度出たら、その会話は以後も当たる
 *   （メモ・要約・セーブデータに事情が残るので、窓から外れても DeepSeek に出さない）。
 * 読めなければ例外（呼び出し側で「当たった」側＝Claude に倒す）。
 */
export async function loadScreeningSensitive(sb: Sb, conversationId: string): Promise<ScreeningSensitiveHit | null> {
  const [cust, aix] = (await Promise.all([
    sb.from("messages").select("text, sender").eq("conversation_id", conversationId).eq("sender", "customer")
      .or(SCREENING_SENSITIVE_PREFILTER).order("created_at", { ascending: false }).limit(300),
    // スタッフ／AIX の審査の返事（check_pattern が審査の確認の物）の本文
    sb.from("aix_usage_logs").select("generated_text, check_pattern").eq("conversation_id", conversationId)
      .in("check_pattern", [...SCREENING_CHECK_PATTERNS]).order("created_at", { ascending: false }).limit(50),
  ])) as [Res, Res];
  if (cust.error) throw new Error(`screening-sensitive: messages: ${cust.error.message}`);
  if (aix.error) throw new Error(`screening-sensitive: aix_usage_logs: ${aix.error.message}`);
  return screeningSensitiveInMessages([
    ...((cust.data ?? []) as Array<{ text?: string | null; sender?: string | null }>),
    ...((aix.data ?? []) as Array<{ generated_text?: string | null; check_pattern?: string | null }>)
      .map((r) => ({ sender: "staff", text: r.generated_text ?? null, checkPattern: r.check_pattern ?? null })),
  ]);
}
