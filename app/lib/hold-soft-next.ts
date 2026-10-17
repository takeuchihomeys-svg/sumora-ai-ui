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

// 2026-10-15 竹内さんの決定④（同じ日の夕方）「保留の時の柔らかい次の一手」:
//   ・退去予定のお部屋でも「申込で抑える」1文は入れる（旧: 添えない事が多い 2/15 を材料に渡していた）
//   ・家族や友人に相談すると言われた時も添える
//   ・空室（今内覧できる）なら内覧の案内、退去予定のお部屋なら申込（で抑える）の案内
//   ・期間が空きそう（遠方にいる・すぐ来られない等）は申込で抑える（内覧の後も、もう一度の内覧ではなく抑える）
//   どちらの1文かは場面と部屋の読みで決まる（holdSoftMoveFor）。添えない（離れかけ・不満・断り・他で決めた・家族の反対・同じ1文を直前に送った）はブレインが読む。
//   戻す HOLD_SOFT_1015=off（朝の版＝率の参考だけ・退去予定は添えない事が多い・内覧の1文だけ）
export function holdSoft1015Enabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return holdSoftNextEnabled(env) && (env.HOLD_SOFT_1015 ?? "").trim().toLowerCase() !== "off";
}
/** 竹内さんの決定④: 添える1文の向き（空室で今内覧できる→内覧／退去予定・すぐ来られない・内覧の後→申込で抑える） */
export function holdSoftMoveFor(i: { scene: string; room: string | null | undefined; delayed?: boolean }): "viewing" | "apply" {
  if (i.room === "move_out_not_viewable" || i.delayed || i.scene === "post_viewing") return "apply";
  return "viewing";
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

/** お礼・了承だけ（物件の中身・質問・保留の語が無い） */
export function isThanksOnly(customerText: string | null | undefined): boolean {
  const t = N(customerText).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s！!。、〜ー♪✨]/gu, "");
  if (!t || t.length > 30 || /[?？]/.test(t)) return false;
  return /^(?:はい|わかりました|分かりました|了解(?:です|しました)?|承知(?:しました|致しました|いたしました)?|かしこまりました)?(?:ありがとう(?:ございます|ございました)?|有難う(?:ございます)?|助かります|お願い(?:します|いたします|致します))(?:よろしくお願い(?:します|いたします|致します))?$/.test(t);
}
/** 10/15 竹内さんの追加の決定の手本（紗季さん 10/11・物件ピックアップした 2部屋の後「ありがとうございます🙇」だけ） */
/**
 * 2026-10-18 竹内さん 10/16「保留の返事に『全力サポート』で締めるかは状況による」: 10/15 の「刺さっていない保留は新着＋全力でサポートの文で締める」の決め打ちをやめ、ブレインの判断に任せる。
 *   戻す HOLD_ZENRYOKU_FREE=off（10/15 の決め打ち＝全力でサポートの文まで必ず）
 */
export function holdZenryokuFree(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.HOLD_ZENRYOKU_FREE ?? "").trim().toLowerCase() !== "off";
}
export function holdZenryokuClause(env?: Record<string, string | undefined>): string {
  return holdZenryokuFree(env)
    ? "（「ご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます」で締めるかは状況で決める＝決め打ちしない・竹内さん 10/16。直前に同じ文を送っている時・短く閉じる番は付けない）"
    : "＋全力でサポートの文";
}
export const PIERCE_NOT_CLOSE_EXAMPLE = "はい😊！！\n新着物件も随時確認させて頂き、〇〇さんにオススメ出来る新着のお部屋が募集に出次第お送りさせて頂きます！！\nご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！何卒よろしくお願い致します！！";
export const PIERCE_MATERIAL = `【送った物件が刺さっているか（竹内さんの決定 2026-10-15・判断はブレイン）】お客様の反応は物件を見せた後のお礼だけ。刺さっているか（物件名・中身に触れた前向きな反応・内覧や詳細を聞く・温度）を会話から読む。刺さっていない（お礼だけ・反応が薄い・物件に触れない）時は内覧・申込に誘わず、新着を探し続ける文で締める${holdZenryokuClause()}＝信頼を得る締め（竹内さんの実送信「${PIERCE_NOT_CLOSE_EXAMPLE.replace(/\n/g, "／")}」）。刺さっている時だけ内覧／申込の柔らかい1文（空室→内覧のご案内・退去予定やすぐ来られない→お申込みで抑える）。前のこちらの約束（ピックアップ・確認）がまだ果たせていない番は、その約束への了承の返事（ack_form・決定 C）が先。お礼が物件を見せた直後の物でなく、こちらがもう締めた文（「ごゆっくりご検討」「いつでもご連絡ください」等）への返事の時は、刺さりの読みの番ではない＝短く受けて閉じる（竹内さんの実送信・試験 q024）。reply_direction にどちらの締めかを書く`;

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
export function holdSoftNextMaterial(i: { customerText: string; scene: string; room: string; delayed?: boolean; checkAllUnavailable?: boolean; env?: Record<string, string | undefined> }): string {
  if (!holdSoftNextEnabled(i.env)) return "";
  // brain-merge 10/15（指摘6）: 直前の物件確認の結果が全部 募集に出ていない番は、刺さっているか・保留の1文の材料を出さない（指すお部屋が無い・締めは受け＋何卒＝unavailable-ack）
  if (i.checkAllUnavailable) return "";
  const kind = holdTurnKind(i.customerText);
  // 10/15 竹内さんの追加の決定（紗季さん 10/11）: 物件を見せた後のお礼だけの番は、刺さっているかをブレインが読む材料を渡す
  if (!kind && SHOWN.has(i.scene) && i.scene !== "post_viewing" && holdSoft1015Enabled(i.env) && isThanksOnly(i.customerText)) return `\n${PIERCE_MATERIAL}`;
  if (!kind || !SHOWN.has(i.scene)) return "";
  const notViewable = i.room === "move_out_not_viewable";
  const after = i.scene === "post_viewing";
  if (holdSoft1015Enabled(i.env)) {
    const move = holdSoftMoveFor({ scene: i.scene, room: i.room, delayed: i.delayed });
    const why = notViewable ? "お送りしたお部屋は退去予定（まだ内覧できない）" : i.delayed ? "お客様はすぐには内覧に来られない（遠方・期間が空きそう）" : after ? "内覧の後" : "今ご内覧頂けるお部屋（空室）";
    return `\n【保留の番の柔らかい次の一手（竹内さんの決定 2026-10-15）】お客様は物件の話の後に保留（${kind}${kind === "相談" ? "・ご家族やご友人との相談も同じ" : ""}）。押さない（急かす・期限・申込の催促・日時の候補は書かない）のはそのまま、扉の文に次に進む時の柔らかい1文を添える。${why}なので「${HOLD_SOFT_LINES[move]}」（空室で今内覧できる→内覧のご案内／退去予定・すぐ来られない・内覧の後→お申込みで抑える）。この1文は扉の文で、申込の催促・申込誘導には当たらない。reply_direction に「受け止め＋扉の文＋その1文」と書く。ただしこの1文はお送りした物件が刺さっている（物件名・中身に触れた前向きな反応・内覧や詳細を聞く・温度が高い）時だけ。刺さっていない（物件に触れない・反応が薄い）保留は内覧・申込に誘わず、新着を探し続ける文で締める${holdZenryokuClause()}（竹内さんの実送信「${PIERCE_NOT_CLOSE_EXAMPLE.replace(/\n/g, "／")}」の形・保留の受け止めはそのまま）。添えないのは刺さっていない・離れかけ・不満・断り・他で決めた・家族の反対・同じ1文を直前に送った時`;
  }
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
export function holdSoftReplyNote(i: { customerText: string; brainDirection: string | null | undefined; scene?: string | null; room?: string | null; delayed?: boolean; checkAllUnavailable?: boolean; env?: Record<string, string | undefined> }): string {
  if (!holdSoftNextEnabled(i.env) || !holdTurnKind(i.customerText)) return "";
  // brain-merge 10/15（指摘6）: 直前の物件確認の結果が全部 募集に出ていない番は内覧・申込の1文を渡さない
  if (i.checkAllUnavailable) return "";
  // fix(review) 10/15: ブレインの材料と同じ網（物件を見せた後の場面だけ・申込の手続きの後は渡さない）。場面が読めない時（null）は今まで通り方向だけで決める
  if (i.scene && !SHOWN.has(i.scene)) return "";
  const d = N(i.brainDirection);
  if (!d.trim()) return "";
  // fix(review) 10/15: 方向の打ち消し（内覧・案内・申込を控える/しない/まだできない）と、申込の後（抑えました）は渡さない
  const NEG = "(?:控え|しない|せず|入れない|書かない|不要|避け|触れない|まだ(?:でき|出来)|(?:でき|出来)ない|不可)";
  if (/(?:抑え|押さえ)(?:ました|ている|てい|てお)/.test(d)) return "";
  // 「押しを抑える」「初期費用を抑える」は申込で抑えるの1文ではない
  const apply = /(?:申込|申し込|お部屋)[^。、]{0,12}(?:抑え|押さえ)/.test(d) && !new RegExp(`(?:抑え|押さえ)[^。、]{0,8}${NEG}`).test(d);
  const viewingWord = /内覧|内見|(?:お部屋|お日にち|ご都合)[^。]{0,12}ご?案内/.test(d) && !new RegExp(`(?:内覧|内見|案内)[^。、]{0,10}${NEG}`).test(d);
  // 10/15 竹内さんの決定④: 退去予定・すぐ来られない・内覧の後は申込で抑える／空室は内覧のご案内（場面が読める時は向きをそれに合わせる）
  const v1015 = holdSoft1015Enabled(i.env);
  const viewing = viewingWord && (v1015 || i.room !== "move_out_not_viewable");
  if (!apply && !viewing) return "";
  // fix(review) 10/15（P0 ②）: 向きはブレインの書いた語のとおり。場面で上書きするのは安全の線だけ＝まだ内覧できないお部屋に内覧の1文（事実と違う）→ 申込で抑える。
  //   空室で抑える・すぐ来られない/内覧の後で内覧 は竹内さんの決定の向きを材料で渡した上でのブレインの判断なので上書きしない
  const line = apply ? HOLD_SOFT_LINES.apply : v1015 && i.room === "move_out_not_viewable" ? HOLD_SOFT_LINES.apply : HOLD_SOFT_LINES.viewing;
  return `- 【保留の番の柔らかい次の一手（ブレインの判断）】ブレインがこの保留の番に次の一手の1文を添えると決めた。受け止め・扉の文はそのまま、「${line}」の形の1文を1つだけ入れる（押さない・日時の候補・期限・催促は書かない）。この1文は扉の文で、避ける話題の申込誘導・内見誘導・申込の催促に当たらない`;
}

/**
 * ルール⑧の reply_direction の型そのものに足す一言（試験 q022: 但し書きがあってもブレインが「検討を見守る待ちの姿勢で締める」を写して、
 * 竹内さんの「お気に召されましたらお申込みしお部屋抑えさせていただきます」が抜けた）。保留の番だけ・置くかはブレインの判断
 */
export function rule8HoldDirectionSuffix(env?: Record<string, string | undefined>): string {
  if (!holdSoftNextEnabled(env)) return "";
  if (holdSoft1015Enabled(env)) return "（お客様の発言が検討します・家族や友人と相談してまた連絡等の保留の時は、締めの扉の文に次に進む時の柔らかい1文（空室なら内覧のご案内・退去予定やすぐ来られない時はお申込みで抑える）を添え、この方向に「＋その1文」と書く。向きは【保留の番の柔らかい次の一手】の材料のとおり）";
  return "（お客様の発言が検討します・相談してまた連絡等の保留の時は、締めの扉の文に次に進む時の柔らかい1文を添えるかを【保留の番の柔らかい次の一手】の材料で決め、添えるならこの方向に「＋その1文」と書く）";
}

/** ブレインのルール⑧（強推し直後の了承には再推奨しない・旧の文）に足す但し書き（保留の番は待ちでも柔らかい1文を置いてよい） */
export function rule8HoldNote(env?: Record<string, string | undefined>): string {
  if (!holdSoftNextEnabled(env)) return "";
  if (holdSoft1015Enabled(env)) return "　【但し書き（2026-10-15 竹内さんの決定）】お客様の発言が「検討します・家族や友人と相談してまた連絡します・帰ってからゆっくり見ます」等の保留の時は、待ちの姿勢の締めの扉の文に、次に進む時の柔らかい1文を添える: 空室で今ご内覧頂けるお部屋なら「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます」／退去予定のお部屋・遠方などすぐ来られない（期間が空きそう）・内覧の後なら「お気に召されましたらお申込みしお部屋抑えさせていただきます」。これは再推奨・申込誘導・催促に当たらない（avoid_topics の『申込誘導』はお申込いかがでしょうか・お早めに等の催促）。向きは【保留の番の柔らかい次の一手】の材料のとおり。添えるのはお送りした物件が刺さっている時だけ。お礼だけ・反応が薄い（刺さっていない）時の待ちの締めは「新着物件も随時確認させて頂き…募集に出次第お送り」（「ご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます」で締めるかは状況による・竹内さん 10/16）（【送った物件が刺さっているか】・竹内さんの決定 10/15）。\n";
  return "　【但し書き（2026-10-15 竹内さんの手打ち）】お客様の発言が「検討します・相談してまた連絡します・帰ってからゆっくり見ます」等の保留の時は、待ちの姿勢の締めの扉の文に、次に進む時の柔らかい1文（今ご内覧頂けるお部屋なら「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます」）を添えてよい（竹内さん 今ご内覧頂けるお部屋の保留の 47%）。これは再推奨・申込誘導・催促に当たらない（avoid_topics の『申込誘導』はお申込いかがでしょうか・お早めに等の催促）。添えるかは【保留の番の柔らかい次の一手】の材料で決める。\n";
}
