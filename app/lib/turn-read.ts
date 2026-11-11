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
// 切替: TURN_READ = off | log（既定・11/11〜）（ブレインの今ある読み＝turn_contract の about/property・latent_intent を digest に残すだけ）| on（log ＋ ブレインに欄と【直前のこちらの誘導】を渡す）
// テスト: app/lib/__tests__/turn-read.test.ts

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
export type TurnReadMode = "off" | "log" | "on";
// 2026-11-11 統括役の OK（記録だけなので判断は変えない）: 既定は log。止める TURN_READ=off・ブレインに渡す TURN_READ=on
export function turnReadMode(env?: Env): TurnReadMode {
  const v = (envOf(env).TURN_READ ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "off" ? "off" : "log";
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

// ─── 気持ちの細かい型（11/11 竹内さん KB 542e92c9「気持ちも実際のやり取りから細かく細分化しておく。質低いのは細分化できていないから」）
//   元の状態（customer-mindset の12種）×何に対してか（object）×どれくらいか（degree）。object の並びは KB の例と竹内さんの番389の多数決（scripts/audit-turn-read-1111.ts --phase=mood-gold）から。
export const MOOD_OBJECTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  刺さっている: ["家賃", "広さ・間取り", "駅・場所", "新しさ・綺麗さ", "設備", "初期費用", "写真・見た目", "物件全体"],
  興味が薄い: ["予算が合わない", "場所が合わない", "広さ・間取りが合わない", "設備が合わない", "築年・古さ", "提案全体がまだ"],
  急いでいる: ["退去日・今の家", "転勤・就職・入学", "他社と同時進行", "理由は言っていない"],
  審査の不安: ["職業・収入", "勤続・転職", "保証人・保証会社", "過去の滞納・信用", "年齢・その他"],
  先に取られる不安: ["人気の物件", "入居日が先", "迷っている間"],
  抑えたい: ["申込したい", "仮押さえ・審査だけ先に", "決めたいが条件付き"],
  安くしたい: ["初期費用", "家賃", "礼金・敷金", "仲介手数料", "総額の確かめ"],
  内覧したい: ["日を出してきた", "見られるか聞いた", "複数まとめて見たい"],
  時間が無い: ["仕事で都合がつかない", "遠方", "先の日になる"],
  迷い: ["複数の物件で", "他社・他の物件と", "家族・同居人と相談", "時期・入居日で", "条件の優先で"],
  "不満・離れかけ": ["返事・対応", "物件が無い・合わない", "費用が高い", "他で決めた・見送り"],
  普通の依頼: ["了承・お礼（こちらの送信への受け）", "条件の提示・言い直し", "物件・設備の質問", "費用・手続きの質問", "日程の連絡", "持ち込み物件の確認"],
};
export const MOOD_DEGREES = ["弱い", "中", "強い"] as const;
export type MoodRead = { base: string; object: string; degree: (typeof MOOD_DEGREES)[number] };

export type TurnRead = {
  target: { kind: TurnTargetKind; property: string | null; detail: string | null; how: "言った" | "文脈から" | null };
  intent: TurnIntent; intent2: TurnIntent | null;
  lead: { kind: LeadKind; answer: LeadAnswer } | null;
  feeling: string | null;
  mood: MoodRead | null;
};
/** 生の mood を型に直す（base が12種に無ければ null・object が表に無ければ「その他」） */
export function normalizeMoodRead(raw: unknown): MoodRead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const base = typeof o.base === "string" ? o.base.trim() : "";
  const objs = MOOD_OBJECTS[base]; if (!objs) return null;
  const ob = typeof o.object === "string" ? o.object.trim() : "";
  const degree = (MOOD_DEGREES as readonly string[]).includes(String(o.degree)) ? (o.degree as MoodRead["degree"]) : "中";
  return { base, object: objs.includes(ob) ? ob : "その他", degree };
}
export const MOOD_FIELD_TEXT = `"mood": {"base": "${Object.keys(MOOD_OBJECTS).join("|")}", "object": base ごとの何に対してか（${Object.entries(MOOD_OBJECTS).map(([b, os]) => `${b}＝${os.join("/")}`).join("；")}）, "degree": "${MOOD_DEGREES.join("|")}（気になる程度＝弱い・かなり＝中・決めたい／強く困っている＝強い）"}`;

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
export const TURN_READ_BRAIN_FIELD = `"turn_read"（お客様の今の一通を細かく読む。{"target": {"kind": "${TURN_TARGET_KINDS.join("|")}", "property": "物件の事なら物件名と号室（会話・送った束の表記のまま）・無ければ null", "detail": "細かい対象 25字（どの設備・どの費用の項目・どの日の内覧・どの約束）", "how": "言った|文脈から"}, "intent": "${TURN_INTENTS.join("|")} から一番の意図", "intent2": "2番目か null", "lead": 直前のこちらの誘導があれば {"kind": "${LEAD_KINDS.join("|")}", "answer": "${LEAD_ANSWERS.join("|")}"}・無ければ null, "feeling": "気持ちの中身 25字（どの程度気に入っているか・何が不安か・迷いの中身）"}。読み方: 対象を言っていない時は直前のこちらの送信・開いている約束・今の番の物件から決める（「ここ」「予算オーバー」「駐車場は？」の主語）。物件を送った後の「よろしくお願いします」「拝見します」は物件への感想ではなく直前の送信への了承（kind=こちらの約束の結果・intent=お礼・了承）。URL・資料の画像だけの持ち込みは kind=持ち込み物件。お礼・了承だけの番に、前の番の気持ち（刺さっている・安くしたい・審査の不安）を持ち越さない＝"mindset" の state も今の一通で決め、了承だけなら 普通の依頼）。条件フォーム（ご希望のお部屋探しご条件）では、お客様が⑧その他の欄などに自分で書いた気持ちの言葉（ブラック・夜職・借入あり・急ぎ 等）だけを拾い、フォームに初めから印刷されている「※審査に不安な事がある方お気軽にお伝えください」等の定型の文はお客様の言葉ではないので拾わない。lead.answer=応じた（例 内覧の候補日への日の答え）の番は、その誘導を一段進める事（日の確定＝待ち合わせ場所）を一番にし、付いてきた気持ち・相談（審査の不安 等）で道を変えない（竹内さんは日を先に確定し、審査の相談はその後の AIX【電話をかける】で受ける・KB 030882c3）`;
// 2026-11-11 作業員14: mood（細かい型）はブレインに読ませる欄から外した＝統括役の決定。mood を欄に入れると q406 で重点が審査の相談に移り
//   meeting_place→phone_call（直しの1文を足しても待ち合わせ場所 2/4）。mood は道が決まった後の記録だけの読み（別の軽い読み・夜の監査）で付ける。MOOD_FIELD_TEXT・normalizeMoodRead はその用。
// 2026-11-11 作業員14: フォームの1文は「⑧の欄にお客様が書いた言葉だけ・印刷の定型文は拾わない」に絞った（前の after2 は定型文「※審査に不安な事がある方…」を拾って読みすぎた）
// 2026-11-11 作業員14: 「条件フォーム・URL の持ち込みの中の気持ちの一言を拾う」1文を足して試した（部品の試し after2）が、
//   フォームの決まった欄や了承の番まで「審査の不安」と読ませ、当たり 71→70・了承 25→23（得4・失5）で差し引き良くならなかった＝足さない（scripts/audit-turn-read-1111.ts --phase=mood-probe）
// ─── 組み合わせた理解（主・従）: 竹内さんの決定 11/11（KB P1 ee7ddf07・親 ecd7b961）「何のことについて言っているかを細かく読み、それを組み合わせて理解できればズレは起きない」
//   対象（こちらのどの送信・誘いへの答えか）×意図×気持ち×こちら側 を合わせ、一番の要点（主）と脇の話（従）に分ける。道と重点は主で決める。
//   例 q406: 主＝誘った内覧の日を決める（内覧の日・場所×日程の調整→日の確定が先）／従＝審査の不安（手続き・審査→後で答える）
//   切替: TURN_READ_FOCUS=on（TURN_READ=on の時だけ効く・既定 off）
export const FOCUS_SUB_MOVES = ["後で答える", "一言添える", "この番で答える", "触れない"] as const;
export type TurnFocus = { main: { about: TurnTargetKind; intent: TurnIntent; move: string | null }; sub: { about: TurnTargetKind; intent: TurnIntent; move: (typeof FOCUS_SUB_MOVES)[number] } | null };
export function turnReadFocusOn(env?: Env): boolean { return turnReadMode(env) === "on" && (envOf(env).TURN_READ_FOCUS ?? "").trim().toLowerCase() === "on"; }
export const TURN_READ_FOCUS_FIELD = `"turn_focus"（上の読みを組み合わせた理解を1行で: {"main": {"about": "${TURN_TARGET_KINDS.join("|")}", "intent": "${TURN_INTENTS.join("|")}", "move": "主に対してこの番でする事 20字（主の事だけ。従の相談への扱いはここに書かず sub.move にだけ書く）"}, "sub": 脇の話があれば {"about": 同じ選択肢, "intent": 同じ選択肢, "move": "${FOCUS_SUB_MOVES.join("|")}"}・無ければ null}。主の決め方: 直前のこちらの送信・誘いへの答え（lead.answer=応じた）があればそれが主、付いてきた気持ち・相談は従。答えでなければ、お客様が一番してほしい事が主。道（返信か AIX か・AIX の種類）と重点は主だけで決める: 主が誘導への答えなら、その誘導を一段進める AIX にする（内覧の候補日への日の答え＝待ち合わせ場所・物件を送ってと誘った後の持ち込み＝募集確認の約束）。従の相談（審査・費用・持ち物 等）を理由に別の AIX（電話・保証会社の説明 等）へ道を変えない。従は move のとおりに扱う（例: 内覧の候補日への「土曜日で＋審査の相談」＝主 内覧の日・場所×日程の調整→日の確定／従 手続き・審査×手続き・審査の質問→後で答える）)`;
export function normalizeTurnFocus(raw: unknown): TurnFocus | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const m = (o.main && typeof o.main === "object" ? o.main : null) as Record<string, unknown> | null;
  const ma = m ? pickOf(TURN_TARGET_KINDS, m.about) : null, mi = m ? pickOf(TURN_INTENTS, m.intent) : null;
  if (!ma || !mi) return null;
  const s = (o.sub && typeof o.sub === "object" ? o.sub : null) as Record<string, unknown> | null;
  const sa = s ? pickOf(TURN_TARGET_KINDS, s.about) : null, si = s ? pickOf(TURN_INTENTS, s.intent) : null, sm = s ? pickOf(FOCUS_SUB_MOVES, s.move) : null;
  return { main: { about: ma, intent: mi, move: short(m!.move, 30) }, sub: sa && si ? { about: sa, intent: si, move: sm ?? "後で答える" } : null };
}
/** digest.tf: "主の種類×意図>従の種類×意図:扱い" */
export function turnFocusDigest(f: TurnFocus | null | undefined): string | null {
  if (!f) return null;
  return `${f.main.about}×${f.main.intent}${f.sub ? `>${f.sub.about}×${f.sub.intent}:${f.sub.move}` : ""}`.slice(0, 120);
}

// ─── 気持ちの4欄（竹内さんの指示 KB d72ad06b・P1）: 何で（きっかけ）・何の部分を・どんな気持ちで（強さ）・本当はどうしたいのか
//   記録だけの欄（夜の監査の読みで付ける・ブレインの道の判断には入れない＝q406 で mood を欄に入れると道が揺れたため）。
//   型の中身（kind の並び）は作業員5 が竹内さんの198通から作る＝ここは形と正規化だけ。kind は今は MOOD_OBJECTS の base を仮に使う。
//   trigger.ref: きっかけになったこちらの送信（直前の束・新着1件・見積書・候補日 等）か、お客様の持ち込み・前の話の持ち出し
export const MOOD_TRIGGERS = ["こちらの送信", "こちらの約束・結果", "お客様の持ち込み", "前の話の持ち出し", "お客様の事情", "その他"] as const;
export type MoodFour = {
  trigger: { kind: (typeof MOOD_TRIGGERS)[number]; ref: string | null };  // 何で
  part: string | null;                                                     // 何の部分を（物件の広さ・駅・家賃・初期費用の項目・審査・日程 等）
  feeling: { kind: string; degree: (typeof MOOD_DEGREES)[number] };        // どんな気持ちで（強さ）
  want: string | null;                                                     // 本当はどうしたいのか
};
export function normalizeMoodFour(raw: unknown, kinds: ReadonlyArray<string> = Object.keys(MOOD_OBJECTS)): MoodFour | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const t = (o.trigger && typeof o.trigger === "object" ? o.trigger : {}) as Record<string, unknown>;
  const f = (o.feeling && typeof o.feeling === "object" ? o.feeling : {}) as Record<string, unknown>;
  const fk = typeof f.kind === "string" ? f.kind.trim() : "";
  if (!kinds.includes(fk)) return null;
  const tk = pickOf(MOOD_TRIGGERS, t.kind) ?? "その他";
  const deg = (MOOD_DEGREES as readonly string[]).includes(String(f.degree)) ? (f.degree as MoodFour["feeling"]["degree"]) : "中";
  return { trigger: { kind: tk, ref: short(t.ref, 40) }, part: short(o.part, 30), feeling: { kind: fk, degree: deg }, want: short(o.want, 40) };
}
/** 当たりの測り方（案）: 4欄それぞれを別に数える。trigger.kind・feeling.kind・feeling.degree は完全一致、
 *  part・want は自由記述なので「同じ物を指すか」を判定の役（DeepSeek 1回・伏せた文）か Claude Code の目で。物件の部分は語の重なりでも可 */
export function moodFourExact(a: MoodFour | null, b: MoodFour | null): { trigger: boolean; feeling: boolean; degree: boolean } {
  return { trigger: !!a && !!b && a.trigger.kind === b.trigger.kind, feeling: !!a && !!b && a.feeling.kind === b.feeling.kind, degree: !!a && !!b && a.feeling.kind === b.feeling.kind && a.feeling.degree === b.feeling.degree };
}

// ─── 話題ごとに分ける（弱い所 578: 1通に話題が3つ以上・何通も前の話を急に持ち出す番）
//   竹内さんの番100のうち該当12番（scripts/.replay-out/topics-578-claude.json）の答え方:
//   ・お礼・了承の話題は省くことが多い（9/12 で省いた）・主の話題から答え、要件ごとに通を分ける（2cb0feb7）
//   ・前の話の持ち出し（数通前の条件・前の見積書・前に送った物件）は、その送信に結び付けて主として答える（83391dda・f11b7b1a・22b2511e）
//   ・気に入った・考えたい の話題には触れず押さない番がある（83391dda）／内覧の答え＋別の質問は日の確定だけ（c16e9f4a）
//   切替: TURN_READ_TOPICS=on（TURN_READ=on の時だけ・既定 off）。試験はまだ。
export const TOPIC_ROLES = ["主", "従"] as const;
export type TurnTopic = { n: number; about: TurnTargetKind; intent: TurnIntent; quote: string | null; ref: string | null; role: (typeof TOPIC_ROLES)[number] };
export function turnReadTopicsOn(env?: Env): boolean { return turnReadMode(env) === "on" && (envOf(env).TURN_READ_TOPICS ?? "").trim().toLowerCase() === "on"; }
export const TURN_READ_TOPICS_FIELD = `"turn_topics"（1通に話題が2つ以上ある時だけ・出てきた順に最大5: [{"n": 1, "about": "${TURN_TARGET_KINDS.join("|")}", "intent": "${TURN_INTENTS.join("|")}", "quote": "その話題の言葉 25字", "ref": 前の話の持ち出しなら「どの送信のどの話か」（例: 数通前にお客様が言った地域の条件／前にこちらが送った〇〇の見積書）・直前の流れの続きなら null, "role": "主|従"}]・話題が1つなら null。答える順は主から。お礼・了承の話題は省いてよい。前の話の持ち出しはその送信に結び付けて答える）`;
export function normalizeTurnTopics(raw: unknown): TurnTopic[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const out: TurnTopic[] = [];
  for (const [i, x] of raw.slice(0, 5).entries()) {
    const o = (x ?? {}) as Record<string, unknown>;
    const about = pickOf(TURN_TARGET_KINDS, o.about), intent = pickOf(TURN_INTENTS, o.intent);
    if (!about || !intent) continue;
    const ref = short(o.ref, 40);
    out.push({ n: Number.isFinite(Number(o.n)) ? Number(o.n) : i + 1, about, intent, quote: short(o.quote, 30), ref: ref && !/^(null|なし)$/i.test(ref) ? ref : null, role: o.role === "主" ? "主" : "従" });
  }
  return out.length >= 2 ? out : null;
}
/** digest.tt: "数|主の数|前の話の持ち出しの数" */
export function turnTopicsDigest(ts: TurnTopic[] | null | undefined): string | null {
  if (!ts || !ts.length) return null;
  return `${ts.length}|${ts.filter((t) => t.role === "主").length}|${ts.filter((t) => t.ref).length}`;
}

export function turnReadOutputItem(env?: Env): string {
  if (turnReadMode(env) !== "on") return "";
  return `、${TURN_READ_BRAIN_FIELD}${turnReadFocusOn(env) ? `、${TURN_READ_FOCUS_FIELD}` : ""}${turnReadTopicsOn(env) ? `、${TURN_READ_TOPICS_FIELD}` : ""}`;
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
    mood: normalizeMoodRead(o.mood),
  };
}

// ─── 記録（digest）の短い形 ─────────────────────────────────
/** turn_read → "種類|物件|意図|誘導:答え"（digest.tr） */
export function turnReadDigest(tr: TurnRead | null | undefined): string | null {
  if (!tr) return null;
  return [tr.target.kind, tr.target.property ?? "", tr.intent, tr.lead ? `${tr.lead.kind}:${tr.lead.answer}` : "", tr.mood ? `${tr.mood.base}/${tr.mood.object}/${tr.mood.degree}` : ""].join("|").slice(0, 160);
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
  const tf = turnFocusDigest(normalizeTurnFocus(meta.turn_focus)); if (tf) (out as Record<string, unknown>).tf = tf;
  const tt = turnTopicsDigest(normalizeTurnTopics(meta.turn_topics)); if (tt) (out as Record<string, unknown>).tt = tt;
  return out;
}
