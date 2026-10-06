// app/lib/requirement-strength.ts — お客様の要望の強さ（絶対／強い希望／できれば）を読み、判定（NG・保留・加点）に変える1か所（純関数）
//
// 2026-10-06 ⑫ 竹内さん（ゆいと 10月後半入居）:
//   「10月後半入居希望なのだから物件NGかどうかちゃんと見る必要ある。10月中の入居間に合う物件を送って決める為、物件検索ブレインは考え方として決める方法も取り入れる」
//   「10月入居っていう希望が今回の場合は絶対となるので、そこも読みとれるようにする。ここちゃんと状況によって決めきるようにする。…この考え方を他にも活かせる…
//    お客さんの要望に連動してスコアリングのところも大きく状況によって変化出来れば理想」
//   ゆいと: 10/02「そろそろ決めないと時間的に厳しいので一週間以内決めたい」→ 10/03 BLANCOSTA（最短11月中旬）に「10月後半くらいに入れるところとかありますか？」
//   ＝入居時期は絶対。スタッフの実送信「10月後半ご入居可能なお部屋を優先して」「10月中にご入居出来るお部屋ですと、〇〇が一番オススメ」「10月中でのご入居間に合います！！」
//
// 使う所（全部この1か所の値を読む）:
//   読み: readRequirementStrengths（LINE の発言・条件の欄）→ property_customers.requirement_strength（webhook が書く）
//   判定: property-brain.buildCustomerProfile（requirementStrengthsOfCustomer）→ judgeProperty が strengthCodes の札を足す
//         （絶対に合わない＝外す候補＝送らない／分からない＝保留でスタッフが確かめる／合う＝加点で先頭へ＝決めきる並び）
//   送付文: mustSendLine（スタッフの言い方のまま）

export type Strength = "must" | "strong" | "nice";
export type RequirementKey = "move_in" | "pet" | "rent_max" | "area";
export type RequirementStrengths = Partial<Record<RequirementKey, { strength: Strength; evidence: string; at?: string | null }>>;

const nf = (s: unknown) => String(s ?? "").normalize("NFKC");

// 「絶対に今すぐというより」（否定）は絶対の語にしない
const MUST_WORD_RE = /絶対(?!に?今すぐというより)(?!に?(?:今すぐ|すぐ)?(?:という|って)わけ)|必ず|マスト|必須|でないと(?:困|無理|ダメ|だめ)|じゃないと(?:困|無理|ダメ|だめ)|以外(?:は)?(?:無理|ダメ|だめ|NG)|譲れない/;
const NICE_WORD_RE = /できれば|出来れば|なるべく|可能なら|あれば(?:嬉|うれ|助か)|理想|特に(?:決まって|こだわり|気にし)|いつでも|未定|余裕あれば/;

// ── 入居時期 ─────────────────────────────────────────────
const MOVE_IN_CTX_RE = /入居|引っ越|引越|住み始め|入れる(?:ところ|とこ|部屋|物件|お部屋)|入れ(?:ます|ません)/;
// 期限: 「間に合う」「〜までに入居／引っ越し」「〜中に引っ越さないと」。条件のフォームの「10月〜3月までには」（幅の答え）は期限にしない
const MOVE_IN_DEADLINE_RE = /までに(?:は)?(?:入居|引っ越|引越|住|出)|間に合|(?:中|まで|末)に(?:は)?(?:引っ越|引越|入居|出)(?:し|さ)?(?:な(?:いと|ければ)|を?完了|終え|たい)|(?:引っ越|引越|入居|出)(?:さ|し)?ないと(?:いけ|なら|だめ|ダメ)/;
// 物件1件の入居の質問（「即入居可ですか」「入居可能日は」「最短」「ここは」）は要望ではない。「〜に入れるところありますか」（探す依頼）は要望
const MOVE_IN_PROPERTY_Q_RE = /可(?:ですか|でしょうか)|入居可能日|最短|^(?:ここ|こちら|この)|号室/;
const MOVE_IN_REASON_RE = /退去(?:日|予定|しなければ|しないと)|更新(?:日|時期|が|前|まで)|転勤|契約(?:満了|が切れ)|立ち退き|引き渡し|今の家(?:を|が)(?:出|退)|今住んでいる(?:ところ|所|家)(?:の|を)(?:退去|出)/;
const URGENT_RE = /時間的に厳しい|そろそろ決めないと|急ぎ|急いで|早く決めたい|一週間以内|1週間以内|今週中に決め|すぐにでも/;
const MOVE_IN_WHEN_RE = /[0-9]{1,2}月|今月|来月|年内|すぐ(?:にでも)?(?:入居|引っ越|引越|住)|即入居/;

/** 1通の文から入居時期の要望の強さ（入居の話が無ければ null） */
export function moveInStrengthOf(text: string): Strength | null {
  const t = nf(text);
  const talksMoveIn = MOVE_IN_CTX_RE.test(t) && MOVE_IN_WHEN_RE.test(t);
  if (MOVE_IN_PROPERTY_Q_RE.test(t)) return null;
  if (!talksMoveIn && !(URGENT_RE.test(t) && /決め|入居|引っ越/.test(t))) return null;
  if (NICE_WORD_RE.test(t) && !MUST_WORD_RE.test(t) && !URGENT_RE.test(t)) return "nice";
  if (MUST_WORD_RE.test(t) || MOVE_IN_DEADLINE_RE.test(t) || MOVE_IN_REASON_RE.test(t) || URGENT_RE.test(t)) return "must";
  return "strong";
}

// ── ペット・家賃の上限・エリア ─────────────────────────────────
// 「ペット可の物件を探しています」（今は飼っていない）は飼っているにしない
const PET_OWN_RE = /(?:犬|猫|ねこ|いぬ|小型犬|中型犬|大型犬|うさぎ|ペット(?!可))[^。\n]{0,8}?(?:を飼って|飼って(?:い|お)|飼育して|が(?:[0-9一二三]匹)?い(?:る|ます)|も(?:[0-9一二三]匹)?い(?:る|ます)|一緒に(?:住|暮)|を連れて|連れて(?:いき|行き|く))|(?:[0-9一二三]匹)(?:の)?(?:犬|猫|小型犬)|(?:犬|猫|小型犬)[0-9一二三]匹/;
const PET_FUTURE_RE = /将来(?:的に)?[^。\n]{0,10}(?:ペット|犬|猫)|(?:ペット|犬|猫)[^。\n]{0,10}(?:飼いたい|飼えたら|飼う予定)/;
export function petStrengthOf(text: string): Strength | null {
  const t = nf(text);
  if (PET_OWN_RE.test(t)) return /可能性|かも|予定/.test(t) ? "strong" : "must";
  if (PET_FUTURE_RE.test(t)) return NICE_WORD_RE.test(t) || /将来/.test(t) ? "nice" : "strong";
  return null;
}
const RENT_CTX_RE = /家賃|予算|賃料|管理費込|共益費込/;
// 「家賃上限金額」（フォームの見出し）・「上限を11万まで上げても大丈夫」は絶対にしない（「12万上限」の言い切りだけ）
const RENT_MUST_RE = /(?:これ|それ)以上(?:は)?(?:無理|厳しい|出せ)|[0-9.]+万(?:円)?(?:が|で)?上限(?:です|で|。|$|\))|超え(?:られ|たく)ない|超えると(?:厳しい|無理)|限界/;
const RENT_NICE_RE = /多少(?:は|なら)?(?:オーバー|超え|上が)|少し(?:なら|くらい)(?:オーバー|超え|上が)|上がっても(?:いい|大丈夫|OK)/;
export function rentStrengthOf(text: string): Strength | null {
  const t = nf(text);
  if (!RENT_CTX_RE.test(t) && !/万/.test(t)) return null;
  if (RENT_NICE_RE.test(t)) return "nice";
  if (MUST_WORD_RE.test(t) && RENT_CTX_RE.test(t)) return "must";
  if (RENT_MUST_RE.test(t) && RENT_CTX_RE.test(t)) return "must";
  return null;
}
const AREA_MUST_RE = /(?:エリア|区|市|駅|沿線)[^。\n]{0,8}(?:じゃないと|でないと|以外(?:は)?(?:無理|ダメ|だめ|NG))|(?:通勤|通学|保育園|学校|職場)(?:の関係|のため|があるので|が近い)/;
export function areaStrengthOf(text: string): Strength | null {
  const t = nf(text);
  if (AREA_MUST_RE.test(t) || (MUST_WORD_RE.test(t) && /エリア|区|市|駅/.test(t))) return "must";
  // 「なるべく豊中で」＝できれば。条件のフォームの「その他こだわり条件（ペット・保証人・駐車場等）」の行や
  //   「できれば駐車場が」（設備）はエリアにしない（2026-10-06 urara の行を エリアのできれば と読んでいた）
  if (/こだわり条件|保証人|ペット/.test(t)) return null;
  const m = t.match(/(?:なるべく|できれば|出来れば)[^。\n]{0,8}?([一-鿿]{1,6})(?:区|市|駅|町|方面|周辺|エリア|で|が)/);
  if (m && !/(?:場|人|機|台|室|付|込|代|費|料|器|口|帖|畳)$/.test(m[1])) return "nice";
  return null;
}

const RANK: Record<Strength, number> = { nice: 1, strong: 2, must: 3 };

/**
 * お客様の発言（古い順）から要望ごとの強さを読む。同じ要望は新しい発言が勝つ。ただし同じ会話で「急ぎ」と言った後の入居の話は絶対にする
 *   （ゆいと: 10/02 の「時間的に厳しい・一週間以内に決めたい」→ 10/03「10月後半くらいに入れるところ」）
 */
export function readRequirementStrengths(statements: ReadonlyArray<{ text: string | null | undefined; at?: string | null }>): RequirementStrengths {
  const out: RequirementStrengths = {};
  let urgentAt: string | null = null;
  for (const s of statements) {
    const whole = nf(s.text);
    if (!whole || /^\s*\[(?:画像|動画|ファイル)\]/.test(whole)) continue;
    // 申込の書類（「お申込者様記入欄」「入居希望日」「生年月日」）は物件探しの要望ではない
    if (/お申込者様記入欄|生年月日|現住所|勤務先(?:名|住所)/.test(whole)) continue;
    if (URGENT_RE.test(whole)) urgentAt = s.at ?? "1";
    // 急ぎの言葉は14日まで（180日前の「急ぎ」で今の入居の話を絶対にしない）
    const urgentNow = !!urgentAt && (urgentAt === "1" || !s.at || Date.parse(s.at) - Date.parse(urgentAt) <= 14 * 86400_000);
    // 行ごとに見る（条件のフォームは1通に入居・家賃・エリアが並ぶ＝別の行の「必須」「上限」を他の要望に付けない）。フォームの見出し（【〜】⇒・①）は外す
    for (const raw of whole.split(/\n|(?<=[。！!？?])(?![。！!？?])/)) {
      const t = raw.replace(/【[^】]*】|[①-⑩⓵-⓾]|^\s*[0-9]{1,2}\s*[、.)]\s*|⇒|→/g, " ").trim();
      if (!t) continue;
      const ev = t.replace(/\s+/g, " ").slice(0, 80);
      const mi = moveInStrengthOf(t);
      if (mi) out.move_in = { strength: mi !== "nice" && urgentNow ? "must" : mi, evidence: ev, at: s.at ?? null };
      const pet = petStrengthOf(t); if (pet) out.pet = { strength: pet, evidence: ev, at: s.at ?? null };
      const rent = rentStrengthOf(t); if (rent) out.rent_max = { strength: rent, evidence: ev, at: s.at ?? null };
      const area = areaStrengthOf(t); if (area) out.area = { strength: area, evidence: ev, at: s.at ?? null };
    }
  }
  return out;
}

/** 保存してある強さと、今読んだ強さを合わせる（新しく読めた物が勝つ） */
export function mergeRequirementStrengths(stored: unknown, read: RequirementStrengths): RequirementStrengths {
  const base = (stored && typeof stored === "object" ? stored : {}) as RequirementStrengths;
  return { ...base, ...read };
}

/** 保存の値を読む（形が違う物は捨てる） */
export function normalizeRequirementStrengths(v: unknown): RequirementStrengths {
  if (!v || typeof v !== "object") return {};
  const out: RequirementStrengths = {};
  for (const k of ["move_in", "pet", "rent_max", "area"] as RequirementKey[]) {
    const e = (v as Record<string, unknown>)[k] as { strength?: unknown; evidence?: unknown; at?: unknown } | undefined;
    if (e && (e.strength === "must" || e.strength === "strong" || e.strength === "nice")) out[k] = { strength: e.strength, evidence: String(e.evidence ?? ""), at: typeof e.at === "string" ? e.at : null };
  }
  return out;
}

export function isMust(s: RequirementStrengths | null | undefined, k: RequirementKey): boolean { return s?.[k]?.strength === "must"; }
export function strongerOf(a: Strength | null | undefined, b: Strength | null | undefined): Strength | null {
  if (!a) return b ?? null; if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

// ── 判定の札（property-brain.judgeProperty が足す）────────────────────
/**
 * 判定の札（今の札）と要望の強さから、足す札を返す。札の意味・点・保留／外す候補は property-brain の表（reasonPoints・DROP／HOLD）に置く
 *   絶対の入居時期: 遅い＝MOVE_IN_LATE_MUST（外す候補＝送らない）／分からない＝MOVE_IN_UNKNOWN_MUST（保留＝スタッフが入居日を確かめる）／
 *                   間に合う＝MOVE_IN_OK_MUST（+15・決めきる並びで先頭へ）
 *   絶対のペット（今飼っている）: ペット不可＝PET_NG_MUST（外す候補）／絶対の家賃の上限: 1割超＝RENT_OVER_MUST（外す候補）／絶対のエリア: 希望外＝AREA_MUST_NG（保留）
 */
export function strengthCodes(codes: ReadonlyArray<string>, s: RequirementStrengths | null | undefined): string[] {
  if (!s) return [];
  const has = (c: string | RegExp) => typeof c === "string" ? codes.includes(c) : codes.some((x) => c.test(x));
  const out: string[] = [];
  if (isMust(s, "move_in")) {
    if (has("MOVE_IN_LATE")) out.push("MOVE_IN_LATE_MUST");
    else if (has("MOVE_IN_UNKNOWN")) out.push("MOVE_IN_UNKNOWN_MUST");
    else if (has("MOVE_IN_OK")) out.push("MOVE_IN_OK_MUST");
  }
  if (isMust(s, "pet") && has(/^(?:PET_NG|EQUIP_PET_NG|CONDITION_PET_NG|IMAGE_PET_NG)$/)) out.push("PET_NG_MUST");
  if (isMust(s, "rent_max") && has(/^RENT_OVER_(?:110|130)$/)) out.push("RENT_OVER_MUST");
  if (isMust(s, "area") && has(/^(?:AREA_EXCLUDED|AREA_FAR|AREA_ANCHOR_FAR|AREA_DIRECTION_NG)$/)) out.push("AREA_MUST_NG");
  return out;
}

/** 絶対の入居時期の送付文（スタッフの実送信の言い方のまま・月は希望の月）。絶対でなければ null */
export function mustSendLine(s: RequirementStrengths | null | undefined, moveInLabel: string | null | undefined): string | null {
  if (!isMust(s, "move_in") || !moveInLabel) return null;
  return `${moveInLabel}ご入居可能なお部屋を優先して`;
}

/** この1通に要望の強さの手がかりがあるか（webhook が読み直すかの入口） */
export function hasStrengthSignal(text: string | null | undefined): boolean {
  const t = nf(text);
  if (!t || /^\s*\[(?:画像|動画|ファイル)\]/.test(t)) return false;
  return URGENT_RE.test(t) || Object.keys(readRequirementStrengths([{ text: t }])).length > 0;
}

/**
 * AIX【物件ピックアップ】【物件オススメ】の生成に渡す注記（決めきる送付文）。絶対の入居時期が無ければ空。
 *   言い方はスタッフの実送信のまま（ゆいと 10/04「10月後半ご入居可能なお部屋を優先して」・10/04「10月中にご入居出来るお部屋ですと、〇〇が一番オススメ」・
 *   10/05「10月中でのご入居間に合います！！」）。物件ごとの間に合う／分からないは判定の札（MOVE_IN_OK_MUST／MOVE_IN_UNKNOWN_MUST）で渡す
 *   使う所: app/api/aix/action/route.ts の property_send（pickupFactsNote の隣）・property_recommendation（⑰ の作業の後に配線）
 */
export function buildMustSendNote(s: RequirementStrengths | null | undefined, moveInLabel: string | null | undefined): string {
  const line = mustSendLine(s, moveInLabel);
  if (!line) return "";
  return [
    `【決めきる（お客様の絶対の要望）】入居時期は絶対（お客様の言葉「${(s?.move_in?.evidence ?? "").slice(0, 50)}」）。`,
    `・冒頭の条件の文に「${line}」を入れる（スタッフの実送信の言い方のまま）`,
    `・1件だけ勧める時は「${mustTimePhrase(moveInLabel ?? "").at}ご入居出来るお部屋ですと、〇〇が一番オススメ出来るご条件のお部屋となります！！」「${mustTimePhrase(moveInLabel ?? "").of}ご入居間に合います！！」の形（間に合う物件だけ）`,
    `・入居時期が分からない物件に「間に合います」と書かない`,
  ].join("\n");
}

/**
 * 送付文に書く入居時期の言い方。お客様の絶対の言葉の中の時期（「10月後半くらいに入れるところ」→「10月後半」）を先に、無ければ条件の欄（「10月」）
 */
export function mustMoveInLabel(s: RequirementStrengths | null | undefined, moveInTime: string | null | undefined): string | null {
  if (!isMust(s, "move_in")) return null;
  const pick = (x: string | null | undefined) => nf(x).match(/(?:[0-9]{1,2}月(?:[0-9]{1,2}日)?(?:上旬|中旬|下旬|前半|後半|末|頭|初旬)?)|年内|今月(?:中|末)?|来月(?:中|末|上旬|中旬|下旬)?/)?.[0] ?? null;
  return pick(s?.move_in?.evidence) ?? pick(moveInTime);
}

/**
 * 時期の後ろの助詞（スタッフの実送信 180日の形）: 月だけ（「10月」）＝「10月中に」「10月中でのご入居」／
 *   上旬・中旬・下旬・前半・後半・末つき（「10月後半」）＝「10月後半に」「10月後半のご入居」（「10月後半中に」は作らない）。
 *   実送信: 「10月中にご入居」「10月中のご入居」「7月下旬にご入居」「12月上旬にご入居」「10月下旬のご入居」「8月前半のご入居」
 */
export function mustTimePhrase(label: string): { at: string; of: string } {
  const l = nf(label).trim();
  if (/(?:上旬|中旬|下旬|前半|後半|末|頭|初旬|[0-9]日)$/.test(l)) return { at: `${l}に`, of: `${l}の` };
  if (/^[0-9]{1,2}月$|^(?:今月|来月)$/.test(l)) return { at: `${l}中に`, of: `${l}中での` };
  return { at: `${l}に`, of: `${l}の` };
}
