// app/lib/procedure-question.ts
// お客様の「手続きの質問」（審査の期間・申込から入居までの期間と流れ・必要書類・本人確認書類）と、
// 「確認した」系の質問（入居可能日・ペット・駐車場）を資料で答えるか AIX【確認した】で答えるかの決まり（純関数・DB 依存なし）。
//
// 2026-09-30 竹内（みこと・内覧調整中 16:28「本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？」）
//   画面は AIX【物件確認した】（テンプレ自動選択）＋帯「管理会社・オーナー・近隣月極から回答が届いた場面です」だった。
//   竹内「この場合は AIX の確認したではない。本人確認書類としてマイナンバーカードがあるので審査をかけることが出来る。
//         そのため申込から審査、入居までの期間と流れを説明する部分、返信すれば大丈夫」
//   竹内（追加）「『物件確認した』と『確認した』は別の AIX。物件確認した＝物件についてのこと。確認した＝設備や入居のことや管理会社に確認が必要な部分。
//         審査期間について答えるが、物件が退去予定か即入居可能かで入居日が変わるので、その点も注意（物件資料から）。
//         資料を読み取って分からなかったら AIX をそのまま送れるようにする。逆に物件資料に記載があればそこで答えて大丈夫」
//
// 【出所（穴の型 G1＝決定論の入口が無い＋G3＝材料が届かない）】
//   ・場面の証拠（aix-scene-evidence）は null。ブレイン（LLM）がプロンプトの「④審査進捗・通過可能性 → 橋渡しのみ」に寄せて
//     property_check_result（check_pattern なし）を選んだ（reason「審査期間は物件個別で断定不可」）。
//   ・帯の文は AIX_STAFF_NOTES.property_check_result の固定文（check_pattern が無い時は「物件確認した」と「確認した」を併記した文）で、
//     お客様の質問を「管理会社から回答が届いた場面」と言い切っていた。
//   ・会社の事実（company-facts）に審査の期間・流れが無く（cancel の事実の中に「3日〜10日」があるだけ）、質問の形にも当たらなかった。
//
// 【実送信の線（365日・scripts/audit-procedure-question.ts）】
//   審査・入居までの期間の質問にスタッフは**本文で**答えている（AIX を押した例は無い）:
//     07-07 79f057b5「申込後に保証会社審査（3日〜10日）が完了し、ご契約書類の記入と初期費用のご入金（1週間程）が完了次第ご入居頂けます！！
//                     最短で2週間後がご入居の目安のお日にちとなります！！」
//     07-24 affa98c7「お申込から最短で2週間程でご入居出来ます😊！！申込後に保証会社審査（3日〜10日）が完了し、ご契約書類の記入と初期費用のご入金が完了次第ご入居頂けます！！」
//     09-12 f568a14b「空室で即入居可能なお部屋は審査通過後契約書類記入捺印出来次第ご入居可能です！！審査期間は早くて3日ながくて10日間必要となります！
//                     契約書類の手続きをあわせて余裕を持っていただきお申込みから14日間程となります！！」
//     09-26 f2196d11「お申込み〜審査の流れは、①お申込み ②保証会社による入居審査（通常3日〜10日程）③審査通過後、ご契約手続き ④ご契約・初期費用のお支払い完了後、ご入居」
//     退去予定の物件は資料・確認結果の日付で答えている: 06-27 5254182a「6月30日退去予定のため…ご入居可能は7月下旬頃」・07-27 b771af1f「9/23日退去予定」
//   本人確認書類: 運転免許証またはマイナンバーカード（company-facts apply_docs・77通）。パスポートは「一度パスポートでお申し込みさせていただきます」（07-29 b771af1f）・
//     「パスポート写真…一度こちらでお申込を進めさせて頂きます…運転免許証またはマイナンバーカードのお写真…お送り頂きますと幸い」（06-01 d9d1f3c5）
//   数字は上の実送信と会社の決定（2026-09-26 審査期間は「3日〜10日」）だけを使う（創作しない）。

// ═════════════════════════════════════════════════════════════════════════════
// ① 手続きの質問の検出
// ═════════════════════════════════════════════════════════════════════════════

export type ProcedureKind = "screening_period" | "move_in_lead" | "flow" | "docs" | "id_doc";
export type ProcedureQuestion = {
  kinds: ProcedureKind[];
  /** 審査に通るか・厳しいか（通りやすさの質問）が同じ連投にある → 保証会社・審査面の AIX の領分なので、返信だけに倒さない */
  passability: boolean;
  /** 保証会社そのもの（どこか・種類）を聞いている → AIX【保証会社について】の領分 */
  guarantorIdentity: boolean;
  /** 申込後の審査の進み具合（結果・まだか）→ 申込以降の場面（今の対象外） */
  progress: boolean;
  /** お客様の文に出てくる本人確認書類（持っている・使えるか聞いている物）。答える事実を変える（idDocFactFor） */
  ids: IdDocKind[];
};

// 2026-10-01 竹内（みこと「本人確認書類がマイナンバー、パスポート両方あるのですが…」→ 下書き「マイナンバーカード・パスポートどちらでもお申込みを進めることができます」）:
//   「マイナンバーカードがあれば大丈夫。パスポートの場合はパスポートと現在の住所記載の住民票がいる。
//     今回はマイナンバー持っているので、マイナンバーカードの部分でお客さんに伝えたら大丈夫。パスポートに関して触れなくて大丈夫」
//   実送信（365日）でパスポートで進めたのは、どれもパスポートしか無いお客様（06-01・07-29・08-11）。
//   カードがある人にパスポートも同じく使えると答えた実送信は0通。
export type IdDocKind = "my_number" | "license" | "passport";
const ID_DOC_KIND_RE: Record<IdDocKind, RegExp> = {
  my_number: /マイナンバー|マイナ(?:カード|保険証)?(?![ァ-ヶ])/,
  license: /免許証|運転免許/,
  passport: /パスポート|旅券/,
};
/** お客様の文に出てくる本人確認書類（出てくる順ではなく決まった順） */
export function idDocsIn(text: string | null | undefined): IdDocKind[] {
  const t = String(text ?? "").normalize("NFKC");
  return (Object.keys(ID_DOC_KIND_RE) as IdDocKind[]).filter((k) => ID_DOC_KIND_RE[k].test(t));
}

const HOW_LONG = "(?:どの(?:くらい|ぐらい|位)|どれ(?:くらい|ぐらい|位)|何日|何週間?|何ヶ月|何か月|期間|日数|いつ(?:頃|ごろ)?まで)";
/** 審査にかかる期間 */
const SCREENING_PERIOD_RE = new RegExp(
  // ⚠ 「かかる」は審査のすぐ後ろだけ（「審査OKなら…費用のかかる順に」09-08 d3f7f5f3 を拾わない）
  `審査[^。\\n]{0,16}${HOW_LONG}|審査[^。\\n]{0,8}(?:かか|掛か)(?:り|る)|${HOW_LONG}[^。\\n]{0,6}審査[^。\\n]{0,4}(?:かか|掛か)|審査期間`,
);
/** 申込・審査から入居までの期間 */
const MOVE_IN_LEAD_RE = new RegExp([
  `(?:申込|申し込|審査|契約)[^。\\n]{0,20}(?:から|含め|込み|後|通って)[^。\\n]{0,20}(?:入居|住め|住む|住ん|引っ?越|鍵)[^。\\n]{0,15}(?:${HOW_LONG}|最短|いつ)`,
  `(?:申込|申し込|審査|契約)[^。\\n]{0,20}(?:から|含め|込み|後|通って)[^。\\n]{0,12}(?:最短|いつ|${HOW_LONG})[^。\\n]{0,15}(?:入居|住め|住む|住ん|引っ?越)`,
  `入居(?:する)?まで[^。\\n]{0,10}(?:${HOW_LONG}|かかり|掛かり|かかる)`,
].join("|"));
/** 申込・契約・入居までの流れ */
const FLOW_RE = /(?:申込|申し込み?|お申込み?|契約|入居|審査)[^。\n]{0,10}(?:流れ|手順|ステップ|段取り)|(?:流れ|手順|段取り)[^。\n]{0,8}(?:教え|知りたい|どう|どんな|ですか|でしょうか)/;
/** 必要書類 */
const DOCS_RE = /必要(?:な|になる|となる)?(?:書類|もの|物)[^。\n]{0,12}(?:何|なに|教え|あり|ござい|ですか|でしょうか|[？?])|必要書類|(?:申込|申し込み?|契約|入居|審査)[^。\n]{0,10}(?:何が(?:必要|いり|要り)|何(?:か)?(?:必要|用意|準備))|(?:用意|準備)(?:する|すべき|しておく)(?:もの|物|書類)/;
/** 本人確認書類がこれで良いか・これで審査できるか */
const ID_DOC_WORD = "(?:本人確認書類|身分証(?:明書)?|マイナンバー(?:カード)?|パスポート|(?:運転)?免許証?|保険証|在留カード|住民票)";
const ID_DOC_RE = new RegExp(
  // ⚠ 質問の形まで見る（「マイナンバーカード、保険証が家に置いていて何時に帰宅できるかわからないので」07-14 6fc6828c は質問ではない）
  `${ID_DOC_WORD}[^。\\n]{0,25}(?:(?:大丈夫|いけ|使え|可能|OK|ＯＫ|でもいい|でも良い|でもよろし|でいい|で良い|でよろしい|のみ|だけ)[^。\\n]{0,8}(?:ですか|でしょうか|ますか|ですかね|ですよね|[？?])|(?:ある|あり|持って)[^。\\n]{0,12}(?:ですが|のですが|んですが|ますが))`,
  "i",
);

/** 審査に通るか・厳しいか（通りやすさ） */
const PASSABILITY_RE = /(?:審査|保証会社)[^。\n]{0,12}(?:通り(?:ます|そう|やす|にく)|通れ(?:ます|る|そう)|通る(?:か|でしょう|と思|の?(?:です|でしょう)か)|通過(?:でき|出来|します|しそう)|厳し|緩|ゆる|甘|きつ|キツ|難し|落ち|不安|心配)/;
/** 保証会社そのもの */
const GUARANTOR_IDENTITY_RE = /保証会社[^。\n]{0,6}(?:どこ|どちら|は何|って何|の名前|の種類|何系)|独立系|信販系|信用系|LICC/;
/** 申込後の審査の進み具合 */
const PROGRESS_RE = /審査中|審査(?:の)?(?:結果|状況|進捗)[^。\n]{0,8}(?:どう|まだ|出まし|来まし|いかが|わかり|分かり)|まだ[^。\n]{0,6}審査|審査[^。\n]{0,4}まだ/;
/** 画像の書き起こしの通（お客様の質問ではない） */
const IMAGE_UNIT_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル)\]/;

/**
 * 手続きの質問か（当たらなければ null）。通は改行2つ・区切り文字で分かれていてもよい（画像の書き起こしの通は見ない）。
 */
export function detectProcedureQuestion(text: string | null | undefined): ProcedureQuestion | null {
  const units = String(text ?? "").split(/\n⁣\n/).map((u) => u.trim()).filter((u) => u && !IMAGE_UNIT_RE.test(u));
  if (units.length === 0) return null;
  const t = units.join("\n").normalize("NFKC");
  const kinds: ProcedureKind[] = [];
  if (SCREENING_PERIOD_RE.test(t)) kinds.push("screening_period");
  if (MOVE_IN_LEAD_RE.test(t)) kinds.push("move_in_lead");
  if (FLOW_RE.test(t)) kinds.push("flow");
  if (DOCS_RE.test(t)) kinds.push("docs");
  if (ID_DOC_RE.test(t)) kinds.push("id_doc");
  if (kinds.length === 0) return null;
  return {
    kinds,
    passability: PASSABILITY_RE.test(t),
    guarantorIdentity: GUARANTOR_IDENTITY_RE.test(t),
    progress: PROGRESS_RE.test(t),
    ids: idDocsIn(t),
  };
}

/** 返信（本文）で答える手続きの質問か（通りやすさ・保証会社そのもの・申込後の進み具合が混ざる時は従来の判断に任せる） */
export function isProcedureReplyQuestion(q: ProcedureQuestion | null | undefined): q is ProcedureQuestion {
  return !!q && q.kinds.length > 0 && !q.passability && !q.guarantorIdentity && !q.progress;
}
export function isProcedureReplyText(text: string | null | undefined): boolean {
  return isProcedureReplyQuestion(detectProcedureQuestion(text));
}

/** 入居までの期間が答えに入る質問か（審査の期間・入居までの期間・流れ）。必要書類・本人確認書類だけなら入居時期は要らない */
export function procedureNeedsMoveIn(q: ProcedureQuestion): boolean {
  return q.kinds.some((k) => k === "screening_period" || k === "move_in_lead" || k === "flow");
}

// ═════════════════════════════════════════════════════════════════════════════
// ② 「確認した」系の質問: 資料に記載あり → 資料で答える／無し → AIX【確認した】
// ═════════════════════════════════════════════════════════════════════════════
//   「物件確認した」＝物件そのもの（空き・募集状況・募集終了・別の部屋・室内写真）
//   「確認した」　　＝設備・入居（入居可能日・退去予定）・ペット・駐車場・保証会社・初期費用の交渉など、管理会社に確認が要る事
//   設備は equipment-question.ts（同じ考え: 設備欄に有る → 本文／無い・言い切れない → 確認）が受け持つ。ここは入居・ペット・駐車場。

export type ConfirmTopic = "move_in" | "pet" | "parking";
export const CONFIRM_TOPIC_LABEL: Record<ConfirmTopic, string> = { move_in: "入居可能日", pet: "ペット", parking: "駐車場" };
/** AIX【確認した（条件・交渉）】のピッカー（aix-taxonomy CHECK_PATTERN_DETECTORS と同じ値） */
export const CONFIRM_TOPIC_CHECK_PATTERN: Record<ConfirmTopic, string> = { move_in: "mgmt_move_in", pet: "mgmt_pet", parking: "mgmt_parking" };

export type ConfirmRoute = {
  topic: ConfirmTopic;
  /** material＝資料の文字で答えてよい／confirm＝資料に無い・言い切れない → AIX【確認した】 */
  route: "material" | "confirm";
  /** 資料の行（文字のまま）。無ければ空 */
  lines: string[];
  /** なぜその道か（ログ・監査・プロンプト用の短い語） */
  why: string;
};

/** 資料の行（image_details.lines・property_pickups.image_lines の「項目: 値」）から項目の行を拾う */
function linesOf(lines: readonly (string | null | undefined)[], head: RegExp): string[] {
  return lines.map((l) => String(l ?? "").trim()).filter((l) => head.test(l));
}
const valueOf = (line: string) => line.replace(/^[^:：]+[:：]\s*/, "").trim();
const EMPTY_VALUE_RE = /^(?:[ーｰ\-－—]|不明|記載なし|なし|無し)?$/;
const VAGUE_VALUE_RE = /相談|未定|要確認|確認|応相談|調整中|問い?合わせ/;

export type MoveInMaterial = {
  /** 資料の文字のまま（「現況: 退去予定(9/30)」「入居可能日: 2026年10月下旬」） */
  lines: string[];
  /** immediate＝即入居の記載／date＝入居可能日に日付／leaving＝退去予定・居住中で入居可能日の日付なし／unknown＝相談・未定・記載なし */
  kind: "immediate" | "date" | "leaving" | "unknown";
};

/**
 * 資料の行から入居時期を読む（書いてある文字のまま）。
 *   即入居と読むのは「即入・即時・即日」がある時だけ（「空室」だけ・「相談」は即入居ではない＝aix-material-facts と同じ線）。
 *   日付＝入居可能日・入居時期の値に 月 か 旬 か M/D がある時。退去予定・居住中で日付が無い時は leaving（いつ入れるかは確認が要る）。
 */
export function readMoveInMaterial(lines: readonly (string | null | undefined)[]): MoveInMaterial {
  const hit = linesOf(lines, /^(?:現況(?:\s*\/\s*入居時期)?|入居可能日|入居可能時期|入居時期|入居日|退去予定(?:日)?|引渡し?(?:可能)?(?:日|時期)?)\s*[:：]?/)
    .filter((l) => !EMPTY_VALUE_RE.test(valueOf(l)));
  if (hit.length === 0) return { lines: [], kind: "unknown" };
  const moveInLines = hit.filter((l) => /^(?:入居|引渡)/.test(l) || /^現況\s*\/\s*入居時期/.test(l));
  const moveInText = moveInLines.map(valueOf).join(" ");
  const all = hit.join(" ");
  // 監査（売上サポ 1,720行）: 「現況: 居住中／入居可能日: 即入居可」が4行 → 食い違いは即入居にしない（確認が要る側）
  if (/即入|即時|即日/.test(all) && !/未定/.test(all) && !/退去予定|居住中|賃貸中|入居中/.test(all)) return { lines: hit, kind: "immediate" };
  if (/[0-9０-９]{1,2}\s*月|[上中下]旬|[0-9０-９]{1,2}\s*\/\s*[0-9０-９]{1,2}/.test(moveInText) && !/未定/.test(moveInText)) return { lines: hit, kind: "date" };
  if (/退去予定|居住中|賃貸中|入居中/.test(all)) return { lines: hit, kind: "leaving" };
  return { lines: hit, kind: "unknown" };
}

/** 「確認した」系の質問の道（資料の行から）。設備は equipment-question.ts */
export function routeConfirmTopic(topic: ConfirmTopic, lines: readonly (string | null | undefined)[]): ConfirmRoute {
  if (topic === "move_in") {
    const m = readMoveInMaterial(lines);
    if (m.kind === "immediate" || m.kind === "date") return { topic, route: "material", lines: m.lines, why: m.kind === "immediate" ? "資料に即入居の記載" : "資料に入居可能日の記載" };
    return { topic, route: "confirm", lines: m.lines, why: m.kind === "leaving" ? "退去予定・居住中で入居可能日の日付が資料に無い" : m.lines.length ? "資料の入居時期が相談・未定" : "資料に入居時期の記載なし" };
  }
  if (topic === "pet") {
    const hit = linesOf(lines, /^ペット\s*[:：]/).filter((l) => !EMPTY_VALUE_RE.test(valueOf(l)));
    const v = hit.map(valueOf).join(" ");
    if (!hit.length) return { topic, route: "confirm", lines: [], why: "資料にペットの記載なし" };
    // 言い切れるのは「不可」だけ。「可」「相談」は種類・頭数・敷金の条件が物件ごとに違う（確認が要る）
    if (/不可|禁止|NG/i.test(v) && !VAGUE_VALUE_RE.test(v)) return { topic, route: "material", lines: hit, why: "資料にペット不可の記載" };
    return { topic, route: "confirm", lines: hit, why: "ペットは可・相談（種類・頭数・条件は確認が要る）" };
  }
  const hit = linesOf(lines, /^駐車場\s*[:：]/).filter((l) => !/^[ーｰ\-－—]?$/.test(valueOf(l)));
  const v = hit.map(valueOf).join(" ");
  if (!hit.length) return { topic, route: "confirm", lines: [], why: "資料に駐車場の記載なし" };
  // 言い切れるのは「無し」だけ。有る時も空きがあるかは確認が要る
  if (/^(?:無|なし|無し|不可)/.test(v) && !VAGUE_VALUE_RE.test(v)) return { topic, route: "material", lines: hit, why: "資料に駐車場なしの記載" };
  return { topic, route: "confirm", lines: hit, why: "駐車場は空きの確認が要る" };
}

/** お客様の文が聞いている「確認した」系の項目（入居可能日は scene-patterns の入居日の質問と同じ語で呼び出し側が渡す） */
const PET_Q_RE = /ペット|(?:猫|犬|小型犬|うさぎ|ウサギ)[^。\n]{0,10}(?:飼|可|OK|大丈夫|いけ|相談)/;
const PARKING_Q_RE = /駐車場|(?:車|バイク)[^。\n]{0,8}(?:停め|止め|置け|置き)/;
const QUESTION_FORM_RE = /[？?]|ですか|ますか|でしょうか|ですかね|知りたい|教えて/;
export function detectConfirmTopics(text: string | null | undefined, o?: { moveInAsked?: boolean }): ConfirmTopic[] {
  const t = String(text ?? "").normalize("NFKC");
  const out: ConfirmTopic[] = [];
  if (o?.moveInAsked) out.push("move_in");
  const sentences = t.split(/(?<=[。！!？?\n])/);
  if (sentences.some((s) => PET_Q_RE.test(s) && QUESTION_FORM_RE.test(s))) out.push("pet");
  if (sentences.some((s) => PARKING_Q_RE.test(s) && QUESTION_FORM_RE.test(s))) out.push("parking");
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// ③ 手続きの質問の答え方（返信／返信か AIX【確認した】の2択）
// ═════════════════════════════════════════════════════════════════════════════

export type ProcedureTarget = { name: string; roomNo: string | null } | null;
export type ProcedurePlan = {
  /** reply＝返信で答える／two_choice＝返信か AIX【確認した→入居可能日】の2択（資料で入居時期が分からない） */
  mode: "reply" | "two_choice";
  question: ProcedureQuestion;
  target: ProcedureTarget;
  moveIn: ConfirmRoute | null;
};

/**
 * 手続きの質問の答え方。
 *   ・必要書類・本人確認書類だけ → 返信
 *   ・審査の期間・入居までの期間・流れ → 返信。対象の物件（主のお部屋）がある時は資料の入居時期を読む:
 *       資料に即入居／入居可能日の日付 → 返信（資料の値のまま）
 *       資料で分からない（記載なし・相談・未定・退去予定で日付なし）→ 2択（返信では入居日を断言しない／AIX【確認した→入居可能日】）
 *   ・対象の物件が無い（まだ物件の話になっていない）→ 返信（一般の流れ）
 */
export function resolveProcedurePlan(o: {
  question: ProcedureQuestion;
  target: ProcedureTarget;
  /** 対象の物件の資料の行（読めなければ空） */
  materialLines: readonly (string | null | undefined)[];
}): ProcedurePlan {
  if (!procedureNeedsMoveIn(o.question) || !o.target) return { mode: "reply", question: o.question, target: o.target, moveIn: null };
  const moveIn = routeConfirmTopic("move_in", o.materialLines);
  return { mode: moveIn.route === "material" ? "reply" : "two_choice", question: o.question, target: o.target, moveIn };
}

/** 事実（実送信・会社の決定）。送る文ではなく事実として渡す（丸写しを促さない） */
export const PROCEDURE_FACTS = {
  flow: "申込から入居までの流れ: ①お申込み（お申込フォーマットのご入力＋ご本人確認書類）→ ②保証会社による審査（3日〜10日程）→ ③審査通過後、ご契約のお手続き（ご契約書類の記入・初期費用のご入金で1週間程）→ ④完了次第ご入居。",
  lead: "空室で即入居できるお部屋なら、お申込から最短で2週間程がご入居の目安。",
  call: "審査の過程で保証会社からご本人確認のお電話が入る場合がある。",
  // 2026-10-01 竹内「パスポートの場合はパスポートと現在の住所記載の住民票がいる」（旧「パスポートしか無い時は一度パスポートで進められる」を置き換え）
  idDoc: "ご本人確認書類は運転免許証またはマイナンバーカード（裏表の写真）の**どちらか1点**でお申込みして審査をかけられる。パスポートの場合は**パスポートと現住所記載の住民票の2点**が必要。お客様が運転免許証かマイナンバーカードを持っている時は、そのカードで進められるとだけ答え、**パスポートには触れない**。※この説明文をそのまま写さない。",
  docs: "申込に必要なのは2つ: ①お申込フォーマットへのご入力 ②ご本人確認書類（運転免許証またはマイナンバーカードの裏表の写真）。",
} as const;

/**
 * 本人確認書類の事実を、お客様が持っている物に合わせて1つにする（送る文ではない）。
 *   カード（マイナンバー・免許証）がある → そのカードで進められる・パスポートには触れない
 *   パスポートだけ → パスポートと現住所記載の住民票の2点
 *   どれも出てこない → 一般の事実（PROCEDURE_FACTS.idDoc）
 */
export function idDocFactFor(ids: ReadonlyArray<IdDocKind>): string {
  const card = ids.includes("my_number") ? "マイナンバーカード" : ids.includes("license") ? "運転免許証" : null;
  if (card) {
    return `お客様は${card}をお持ち → **${card}（裏表の写真）でお申込みして審査をかけられる**と答える。${ids.includes("passport") ? "お客様はパスポートにも触れているが、" : ""}**パスポートには触れない**（パスポートは住民票も要るので、カードがある方には話に出さない・「どちらでも」と並べない）。※この説明文をそのまま写さない。`;
  }
  if (ids.includes("passport")) {
    return "お客様の手元はパスポート → パスポートの場合は**パスポートと現住所記載の住民票の2点**が必要と答える（運転免許証かマイナンバーカードがあればその1点で良い）。※この説明文をそのまま写さない。";
  }
  return PROCEDURE_FACTS.idDoc;
}

const targetLabel = (t: ProcedureTarget) => (t ? `${t.name}${t.roomNo ? ` ${t.roomNo}号室` : ""}` : "");

/** ブレイン・返信生成に渡す1ブロック */
export function buildProcedureAnswerNote(plan: ProcedurePlan): string {
  const q = plan.question;
  const out: string[] = ["【📝 お客様の手続きの質問（審査・入居までの期間と流れ・必要書類）— 本文で答える】"];
  out.push("→ 管理会社に確認する話ではない。「確認させて頂きます」で返さず、下の事実で**本文で答える**（AIX【物件確認した】は使わない）。");
  if (procedureNeedsMoveIn(q)) {
    out.push(`- ${PROCEDURE_FACTS.flow}`);
    out.push(`- ${PROCEDURE_FACTS.call}`);
  }
  if (q.kinds.includes("docs")) out.push(`- ${PROCEDURE_FACTS.docs}`);
  if (q.kinds.includes("id_doc") || q.kinds.includes("docs")) out.push(`- ${idDocFactFor(q.ids ?? [])}`);
  if (procedureNeedsMoveIn(q)) {
    if (!plan.target) {
      out.push(`- ${PROCEDURE_FACTS.lead}（退去予定のお部屋は退去・クリーニングの後になるので、お部屋が決まってから入居可能日をお伝えする）`);
    } else if (plan.moveIn?.route === "material") {
      out.push(`- 対象のお部屋（${targetLabel(plan.target)}）の資料の入居時期（文字のまま）: ${plan.moveIn.lines.join("／")}`);
      out.push(plan.moveIn.why.includes("即入居")
        ? `→ 資料に即入居の記載あり。${PROCEDURE_FACTS.lead}`
        : "→ 入居できる日は**資料の入居可能日のとおり**に書く（日付・旬は資料の文字のまま。早めたり「即入居」「最短2週間でご入居」と書かない）。審査・契約の期間は上の事実のとおり。");
    } else {
      out.push(`- 対象のお部屋（${targetLabel(plan.target)}）の入居時期は資料で分からない（${plan.moveIn?.why ?? "記載なし"}${plan.moveIn?.lines.length ? `: ${plan.moveIn.lines.join("／")}` : ""}）。`);
      out.push("→ 本文では審査の期間と流れだけ答え、**このお部屋にいつ入居できるか（日付・「即入居」・「最短2週間でご入居」）は断言しない**。入居可能日はスタッフが管理会社に確認して AIX【確認した→入居可能日】で伝える。");
    }
  }
  out.push("→ 審査に通るかどうか・保証会社の名前や種類は書かない（物件によって変わる）。期間の数字は上の事実にある物だけ使う。");
  return out.join("\n");
}

/** ブレインの返信の方向（決定論で手続きの質問を返信に倒した時） */
export function procedureReplyDirection(plan: ProcedurePlan): string {
  const parts: string[] = [];
  if (procedureNeedsMoveIn(plan.question)) parts.push("申込→保証会社の審査（3日〜10日程）→契約のお手続き→ご入居の期間と流れを本文で説明する");
  if (plan.question.kinds.includes("id_doc")) {
    const ids = plan.question.ids ?? [];
    const card = ids.includes("my_number") ? "マイナンバーカード" : ids.includes("license") ? "運転免許証" : null;
    parts.push(card ? `${card}でお申込み・審査に進めると答える（パスポートには触れない）`
      : ids.includes("passport") ? "パスポートの場合はパスポートと現住所記載の住民票の2点が必要と答える"
      : "運転免許証かマイナンバーカードでお申込み・審査に進めると答える");
  }
  if (plan.question.kinds.includes("docs")) parts.push("申込に必要な物（フォーマットのご入力・ご本人確認書類）を答える");
  const tail = plan.moveIn?.route === "material" ? "入居時期は資料の記載のとおりに書く"
    : plan.moveIn ? "このお部屋の入居可能日は断言しない" : "";
  return `${parts.join("・")}（管理会社への確認の宣言はしない${tail ? `・${tail}` : ""}）`.slice(0, 120);
}

/** 2択の時のスタッフ向けの帯 */
export function procedureTwoChoiceNote(plan: ProcedurePlan): string {
  return `お客様の質問は審査・入居までの期間と流れ（管理会社からの回答が届いた場面ではありません）。返信で期間と流れを説明できます。${targetLabel(plan.target)}の入居可能日は資料で分からない（${plan.moveIn?.why ?? "記載なし"}）ので、入居日まで答える時は管理会社に確認して AIX【確認した（条件・交渉）→入居可能日】で送ってください`;
}

// ═════════════════════════════════════════════════════════════════════════════
// ④ 「確認した」系の質問の材料の文（入居可能日・ペット・駐車場）
// ═════════════════════════════════════════════════════════════════════════════

/** 聞かれた項目がすべて資料で答えられるか（1つでも確認が要れば false＝AIX【確認した】） */
export function confirmTopicsAllInMaterial(routes: readonly ConfirmRoute[]): boolean {
  return routes.length > 0 && routes.every((r) => r.route === "material");
}

/** ブレイン・返信生成に渡す1ブロック（項目が無ければ空） */
export function buildConfirmTopicNote(target: ProcedureTarget, routes: readonly ConfirmRoute[]): string {
  if (!target || routes.length === 0) return "";
  const out: string[] = [`【🔎 お客様が聞いた入居・ペット・駐車場（対象: ${targetLabel(target)}）— 資料に記載あり→資料で答える／無し→AIX【確認した】】`];
  for (const r of routes) {
    out.push(r.route === "material"
      ? `- ${CONFIRM_TOPIC_LABEL[r.topic]}: 資料に記載あり（文字のまま）「${r.lines.join("／")}」→ **本文で資料のとおりに答える**（日付・可否は資料の文字のまま。足さない・早めない）`
      : `- ${CONFIRM_TOPIC_LABEL[r.topic]}: 資料では答えられない（${r.why}${r.lines.length ? `: ${r.lines.join("／")}` : ""}）→ 本文で可否・日付を断言しない。スタッフが管理会社に確認して AIX【確認した（条件・交渉）→${CONFIRM_TOPIC_LABEL[r.topic]}】で答える`);
  }
  out.push("→ 「物件確認した」は物件そのもの（空き・募集状況）の報告。設備・入居・ペット・駐車場など管理会社に確認が要る事は「確認した（条件・交渉）」。");
  return out.join("\n");
}
