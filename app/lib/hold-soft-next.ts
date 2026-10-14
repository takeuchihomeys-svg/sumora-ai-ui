// app/lib/hold-soft-next.ts — 物件をお送りした後の保留の番（検討します・相談します・確認します）の「柔らかい次の一手」（純関数・DB/LLM なし）
//
// 2026-10-15 竹内さん（7番）「営業マン的思考の部分をブレイン強化していく。そうすれば空気感や状況理解力が改善されて100%により近くなる」
//   scripts/audit-sales-mind.ts（竹内さんの手打ちの営業の番・30日 107番）で一番直された種類は「迷い」（直さず送れた 17%・押し引き 0%）。
//   迷いの番を1番ずつ読むと、保留（検討します・相談の上また連絡・帰ってからゆっくり見ます）でブレインの方向が
//   「感謝を受け取り検討を見守る待ちの姿勢で締める」（brain-core ルール⑧）・「押さずに待つ」（customer-mindset の迷いの返し方）で、
//   下書きは扉の文だけ。竹内さんは扉の文はそのままに「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」
//   （内覧の後・抑える場面は「お気に召されましたらお申込みしお部屋抑えさせていただきます！！」）を1文添える。
//   ＝ブレインに「待つ＝何も置かない」しか無く、「押さずに次の一手を置く」が無い（文の側ではなくブレインの判断の材料の穴）。
//
// ■ 実データ（scripts/audit-hold-soft-next.ts・180日・物件をお送りした後の保留の番・竹内さんの手打ち 54番／39会話）
//   柔らかい次の一手を添えた: 全体 20/54（37%・内覧 17・申込で抑える 3）／今ご内覧頂ける部屋 17/36（47%）／内覧の後 2/6／
//   「確認します・帰ってからゆっくり見て返信」6/11（同じ番の下書き 1/10）／まだ内覧できない部屋（退去予定）2/15（入れない事が多い）。従業員 5/33（15%）。
//   同じ番の AI の下書き 13/47（28%）→ 竹内さん 19/47（40%）・今ご内覧頂ける部屋 10/30（33%）→ 16/30（53%）。appeal-timing の率（after_recommend|thinking 申込 11%・内覧 11%）は従業員を含む人の手打ち。
//   物差しは竹内さんの手打ちだけ（3b508208）。判断はブレイン（材料として渡す・必須にしない）。
// 戻す: HOLD_SOFT_NEXT=off（ブレインの材料の1行・ルール⑧の但し書き・迷いの返し方の文が旧に戻る）

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

export function holdSoftNextEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.HOLD_SOFT_NEXT ?? "").trim().toLowerCase() !== "off";
}

export type HoldKind = "検討" | "相談" | "確認";
/** 保留の言い方。質問・依頼が主の番は当てない（それはその番の中身に答える） */
const HOLD_RE: Array<[HoldKind, RegExp]> = [
  ["相談", /(?:家族|妻|嫁|夫|旦那|主人|彼氏|彼女|親|両親|母|父|同居人|パートナー|相方|友達|友人|息子|娘)[^。\n]{0,12}(?:と|に)?(?:相談|話し合|確認して|聞いて|見せ|目を通)|(?:1|一)度相談/],
  ["確認", /(?:1|一)度確認|確認(?:します|してから|して(?:また|改めて))|(?:帰っ|家に着い|落ち着い)て?から[^。\n]{0,10}(?:見|確認|返信|連絡)|ゆっくり見(?:て|ます)|見てから(?:返信|連絡)|拝見(?:させて|します)/],
  ["検討", /検討(?:し|させ|中)|考え(?:ます|させ|てみ)|候補に|また(?:ご)?連絡|改めて(?:ご)?連絡|決まり次第|折り返/],
];
export function holdTurnKind(customerText: string | null | undefined): HoldKind | null {
  const t = N(customerText);
  if (!t.trim()) return null;
  // 「相談の上またご連絡させて頂いてもよろしいでしょうか」は許しを求める言い方で質問ではない（fae94673 10/14）
  const q = t.replace(/(?:連絡|返信|お返事)[^。\n]{0,24}(?:よろしい|いい|大丈夫|宜しい)(?:でしょうか|ですか)[?？]?/g, "");
  if (/[?？]|ですか|ますか|でしょうか|ありますか|頂けますか|いただけますか/.test(q)) return null;
  for (const [k, re] of HOLD_RE) if (re.test(t)) return k;
  return null;
}

/** 文の中の柔らかい次の一手: viewing＝内覧のご案内／apply＝お申込みで抑える（監査が使う） */
export function softNextMoveOf(text: string | null | undefined): "viewing" | "apply" | null {
  const t = N(text);
  for (const s of t.split(/\n|(?<=[!！。])/)) {
    if (/(?:お申込|申込)[^。！!\n]{0,20}(?:抑え|押さえ)|お部屋(?:を)?(?:お?抑え|お?押さえ)させ/.test(s)) return "apply";
    if (/ご案内(?:させ|出来|でき|可能|致し)|ご?内覧(?:も)?(?:頂|いただ|可能|出来|でき|させ)|お部屋ご内覧|現地[^。！!\n]{0,6}待ち合わせ/.test(s)) return "viewing";
  }
  return null;
}

type HistMsg = { sender: string; text?: string | null };
/** その会話で内覧を済ませたか（監査用の目安） */
export function viewedAlready(hist: ReadonlyArray<HistMsg>): boolean {
  return hist.some((m) => (m.sender === "customer" && /見てきました|内覧(?:し|させて頂き)ました|見学しました|内見しました/.test(N(m.text)))
    || (m.sender !== "customer" && /ご内覧(?:頂き|いただき)ありがとうございました|本日(?:は)?ご内覧/.test(N(m.text))));
}
/** お送りした物件がまだ内覧できない（退去予定・内覧不可）と伝えた（監査用の目安） */
export function notViewableYet(hist: ReadonlyArray<HistMsg>): boolean {
  return hist.slice(-12).some((m) => m.sender !== "customer" && /退去予定|内覧(?:が)?(?:まだ)?(?:出来ない|できない|不可)|ご内覧(?:が)?(?:まだ)?出来ない/.test(N(m.text)));
}

export const HOLD_SOFT_LINES = {
  viewing: "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！",
  apply: "お気に召されましたらお申込みしお部屋抑えさせていただきます！！",
} as const;

/** 物件を見せた後の場面（appeal-timing の scene と同じ名前） */
const SHOWN = new Set(["after_recommend", "after_pickup", "after_estimate", "after_check", "post_viewing"]);

/**
 * ブレインに渡す材料の1行（保留の番・物件をお送りした後だけ・申込の手続きの後は呼ぶ側で外す）。置くかどうか・どちらかはブレインが決める。
 *   scene / room / delayed は appeal-timing の読み（resolveAppealFromConversation の input）をそのまま使う（同じ番を2つの物差しで読まない）
 */
export function holdSoftNextMaterial(i: { customerText: string; scene: string; room: string; delayed?: boolean; env?: Record<string, string | undefined> }): string {
  if (!holdSoftNextEnabled(i.env)) return "";
  const kind = holdTurnKind(i.customerText);
  if (!kind || !SHOWN.has(i.scene)) return "";
  const notViewable = i.room === "move_out_not_viewable";
  const after = i.scene === "post_viewing";
  const situ = notViewable
    ? `お送りしたお部屋はまだ内覧できない（退去予定）。竹内さんはこの場面の保留では添えない事が多い（2/15）`
    : after || i.delayed
      ? `${after ? "内覧の後" : "お客様はすぐには内覧に来られない"}。竹内さんの件数は少ない（内覧の後 2/6）。添えるなら【訴求のタイミング】の形`
      : `今ご内覧頂けるお部屋。竹内さんはこの場面の保留の 47%（17/36）で扉の文に1文添える（内覧 14・申込で抑える 3）${kind === "確認" ? "・「確認します・帰ってからゆっくり見て返信」は 6/11" : ""}。添えるなら「${HOLD_SOFT_LINES.viewing}」`;
  return `\n【保留の番の柔らかい次の一手（材料・判断はブレイン・竹内さんの手打ち 180日 54番の率＝弱い参考）】お客様は物件の話の後に保留（${kind}）。押さない（急かす・期限・申込の催促・日時の候補は書かない）のはそのまま。ただし「待つ」は何も置かない事ではない: ${situ}。この1文は扉の文で、申込の催促・申込誘導には当たらない（訴求のタイミングの率は従業員を含む人の手打ち・竹内さんだけだと上の率）。添えると決めたら reply_direction に「受け止め＋扉の文＋その1文」と書く。添えない（離れかけ・不満・断り・他で決めた・家族の反対・同じ1文を直前に送った）なら書かない`;
}

/**
 * 返信の材料（届かない側の直し）: ブレインが保留の番で柔らかい次の一手を添えると決めた（reply_direction に内覧のご案内・お部屋を抑える）時だけ、
 *   生成に「その1文を扉の文の後に入れる」と渡す。再生（YUMA4・前後各11番）で、ブレインの方向に「ご都合の良い日に内覧案内できる旨の柔らかい1文」が
 *   あるのに下書きから落ちた番があった（他の材料の「訴求の率 11%」「迷い: 押すのは少ない」に負けた）。ブレインが書いていない番は何も渡さない
 */
export function holdSoftReplyNote(i: { customerText: string; brainDirection: string | null | undefined; env?: Record<string, string | undefined> }): string {
  if (!holdSoftNextEnabled(i.env) || !holdTurnKind(i.customerText)) return "";
  const d = N(i.brainDirection);
  if (!d.trim()) return "";
  const apply = /抑え|押さえ/.test(d);
  const viewing = /内覧|ご案内|案内/.test(d) && !/内覧[^。、]{0,6}(?:しない|入れない|書かない|は不要)/.test(d);
  if (!apply && !viewing) return "";
  const line = apply ? HOLD_SOFT_LINES.apply : HOLD_SOFT_LINES.viewing;
  return `- 【保留の番の柔らかい次の一手（ブレインの判断）】ブレインがこの保留の番に次の一手の1文を添えると決めた。受け止め・扉の文はそのまま、「${line}」の形の1文を1つだけ入れる（押さない・日時の候補・期限・催促は書かない）。この1文は扉の文で、避ける話題の申込誘導・内見誘導・申込の催促に当たらない`;
}

/**
 * ルール⑧の reply_direction の型そのものに足す一言（試験 q022: 但し書きがあってもブレインが「検討を見守る待ちの姿勢で締める」を写して、
 * 竹内さんの「お気に召されましたらお申込みしお部屋抑えさせていただきます」が抜けた）。保留の番だけ・置くかはブレインの判断
 */
export function rule8HoldDirectionSuffix(env?: Record<string, string | undefined>): string {
  if (!holdSoftNextEnabled(env)) return "";
  return "（お客様の発言が検討します・相談してまた連絡等の保留の時は、締めの扉の文に次に進む時の柔らかい1文を添えるかを【保留の番の柔らかい次の一手】の材料で決め、添えるならこの方向に「＋その1文」と書く）";
}

/** ブレインのルール⑧（強推し直後の了承には再推奨しない・旧の文）に足す但し書き（保留の番は待ちでも柔らかい1文を置いてよい） */
export function rule8HoldNote(env?: Record<string, string | undefined>): string {
  if (!holdSoftNextEnabled(env)) return "";
  return "　【但し書き（2026-10-15 竹内さんの手打ち）】お客様の発言が「検討します・相談してまた連絡します・帰ってからゆっくり見ます」等の保留の時は、待ちの姿勢の締めの扉の文に、次に進む時の柔らかい1文（今ご内覧頂けるお部屋なら「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます」）を添えてよい（竹内さん 今ご内覧頂けるお部屋の保留の 47%）。これは再推奨・申込誘導・催促に当たらない（avoid_topics の『申込誘導』はお申込いかがでしょうか・お早めに等の催促）。添えるかは【保留の番の柔らかい次の一手】の材料で決める。\n";
}
