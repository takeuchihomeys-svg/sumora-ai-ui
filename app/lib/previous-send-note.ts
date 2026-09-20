// app/lib/previous-send-note.ts
// 直前に自分が送った文を「繰り返さないための材料」に変える（純関数・DB 依存なし）。
//
// 2026-09-21 竹内（スクショ: ゆーたさん 13:39 の実送信）
//   「生成した文は送った内容と同じ内容を再度送っていた形となるので、これを防ぐ。
//    全く同じ内容いれたら文がおかしいので、ここの根本的な原因を見つける」
//
// ■ 実測で線を引いた（scripts/audit-repeat-previous.ts / scripts/audit-after-ack.ts・直近180日）
//   ・焼き直し（生成文の述部が全部「直前のスタッフ送信」に有る）
//       実送信   12/1209 組 = 1.0%
//       生成     21/1951 件 = 1.1%   ← **実送信と同じ率で出る＝抑えられていない**
//       ※ ai_reply_examples は「送った下書き」しか残らない。捨てた下書きは
//         conversations.ai_draft が上書きされて消えるので、実際はこれより多い。
//   ・場面「スタッフが締めを送る → お客様が短いお礼・了承だけ返す」（96件）
//       スタッフが返信した 52.1% / 返信しない 47.9%  ← **過半数の線が引けない**ので
//       「下書きを出さない」は必須にできない（設計知見「必須にしてよいのは過半数が守っている形だけ」）
//       返信した時: 中央値 54字・3行
//       よく使う述部: 「よろしくお願い致します」15件 /「お気軽にご連絡ください」13件
//         ＝ **定型の締めは繰り返してよい**（禁止にすると実送信を消す）
//   ・良い返信と焼き直しの差は**固有の1つ**を足しているかだった（実物12件を目で読んだ）
//       「8/9日当日はよろしくお願いいたします」      ← 日付を復唱
//       「明日16:00にJ's Gardenでお待ちしております」 ← 日時＋物件名
//       「あんしん+住道矢田08のお部屋、気になる点等…」 ← 物件名
//       「7月20日に最新の物件でピックアップし一度お送りさせて頂きます」 ← 次の予定
//     純粋に「はい＋定型」だけも 12件中2件あった → **禁止ではなく、足せる時に足す**形にする。
//
// ■ どこに置くか
//   設計知見「同じ事実について『書くな』と『書け』を別の場所から渡さない」に従い、
//   **直前送信を渡しているその行に添える**（generate-reply の staffContextNote）。
//   新しい禁止ブロックを別に作らない。
//   出口（本文の書き換え）は作らない — 実送信に1.0%の正当な焼き直しがあり、誤削除0にできないため
//   （設計知見「出口は誤削除0でなければ入れない」）。検査は final-check の DOUBLE_DECLARATION が担当。
//
// 四者同名: 生成（generate-reply の staffContextNote）・監査（scripts/audit-repeat-previous.ts）・
//   テスト（__tests__/previous-send-note.test.ts）・本番検証（scripts/yuma-repeat-test.ts）が
//   同じ「締めの言い回し」「足せる具体」を見る。

/**
 * 締めの種類。**言い回しそのものは渡さず、この名前だけを渡す**。
 *
 * ⚠ 2026-09-21 YUMA ③で分かった事: 直前の締めを「お手隙の際にご査収ください😌！！」のように
 *   **引用して渡したら、モデルはそれをそのまま書いた**（改善前より悪くなった）。
 *   「これを繰り返すな」と本文付きで渡すと、本文の方が効く。
 *   だから渡すのは「もう締めてある」という事実と、その種類の名前だけにする。
 */
const CLOSING_KINDS: Array<{ label: string; re: RegExp }> = [
  { label: "ご査収の依頼", re: /ご査収(?:ください|下さい)/ },
  { label: "ご連絡のお願い", re: /お気軽に(?:ご連絡|ご質問|お申し付け|お知らせ)|何なりとお申し付け/ },
  { label: "お願いの挨拶", re: /何卒(?:よろしく|宜しく)お願い/ },
  { label: "お返事待ち", re: /(?:ご返事|ご返答|ご連絡)?お待ちしております/ },
  { label: "ご検討のお願い", re: /ごゆっくりご検討/ },
  { label: "サポートの申し出", re: /サポートさせて(?:頂|いただ)き/ },
];
/** 締めの言い回し（次にこちらがやる事の宣言が無い、会話を閉じる文）。実送信の述部上位から取った */
const CLOSING_CLAUSE_RE = new RegExp(CLOSING_KINDS.map((k) => k.re.source).join("|"));

/** 「まだ伝えていない具体」として足せる物。直前送信の中に**事実として在る**物だけを拾う */
export type ConcreteFact = { kind: "日程" | "時刻" | "物件名" | "号室"; value: string };

/** 日付（9/8・9月8日・明日・本日） */
const DATE_RE = /(?:[0-9０-９]{1,2}\s*[\/月]\s*[0-9０-９]{1,2}\s*日?|明日|本日|当日)/g;
/** 時刻（15:00・15時） */
const TIME_RE = /[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時(?:[0-9０-９]{1,2}\s*分)?/g;
/**
 * 物件名＋号室。次の2つの形だけを取る（scripts/audit-previous-send-note.ts で実送信12,093通に当てて決めた）:
 *   ① 物件カードの行     「🌟パルビゾン箕面 203」「【ハイツカトレア B 202号室】」（🌟・【 で始まる）
 *   ② 号室が明記された行 「…お部屋の中でも特にジェントリー3 201号室が…」
 * ⚠ 旧: 号室の明記も目印も要らない形にしていたら、「お風呂部分　140cm」を
 *   物件名=お風呂部分・号室=140号室 として拾った（監査②）。号室か目印のどちらかを必須にする。
 * ⚠ 🌟 はサロゲートペアなので u フラグが要る（aix-chain-note.ts で同じ穴を踏んだ）。
 */
const PROPERTY_LABEL_RE =
  /(?:^|\n)[\s　]*(?:[🌟【][\s　]*([^\n【】🌟、。！!]{2,28}?)[\s　]+([0-9０-９]{2,4})[\s　]*(?:号室?)?[\s　]*[】]?|([^\n【】🌟、。！!]{2,40}?)[\s　]+([0-9０-９]{2,4})[\s　]*号室)/gu;

/**
 * 物件名の前に付いた業務の言い回しを落とす。
 * 実送信の形「お送りさせて頂きましたお部屋の中でも特にジェントリー3 201号室が…」で、
 * 旧実装は前置き全部を物件名として拾っていた（監査②で22件）。
 * 最後の区切り語より後ろだけを名前にする。
 */
// ⚠ s フラグは es2018 で型エラーになる（過去に踏んだ）。名前に改行は入らないので付けない。
const NAME_HEAD_CUT_RE = /^.*(?:中でも特に|中でも|特に|お部屋|ました|ます|です|、|。|！|!)/;
/** 物件名ではない語（述語・敬語・署名・設備の説明）。含んでいたら捨てる */
const NOT_A_NAME_RE =
  /(?:させて|頂き|いただ|ください|下さい|ございま|なります|できま|出来ま|可能|よろしい|でしょうか|代表者|代表取締役|担当者|宅地建物|部分|以降|まで|から)/;
/** 物件名として扱わない語（費用・条件の行） */
const NOT_A_PROPERTY_RE = /(?:初期費用|家賃|管理費|敷金|礼金|割引|節約|合計|総額|日割|保証|徒歩|築|万円|円)/;
/**
 * 数字・日付・記号だけの物は物件名ではない。
 * ⚠ 実物「9/8 15:00にウェルスクエア池田井口堂」で、PROPERTY_LABEL_RE が
 *   物件名="9/8"・号室="15号室" を拾った（テスト F1）。日付＋時刻の行が物件名の形と同じになる。
 */
const NUMERIC_ONLY_RE = /^[0-9０-９\s　/／月日年:：時分曜月火水木金土\-–—()（）]+$/;
/**
 * 待ち合わせの行から会場（物件名）を取る。実送信の形:
 *   「9/8 15:00にウェルスクエア池田井口堂 」「明日16:00にJ's Gardenでお待ちしております」
 *   「8/10 14:30にエスリード中之島ザ・コア 607号室」
 * 時刻の直後の「に」から、助詞・号室・行末までを名前とする。
 */
const VENUE_AFTER_TIME_RE =
  /[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}\s*に\s*([^\n、。！!]{2,28}?)(?=[\s　]*(?:[0-9０-９]{2,4}\s*号室|[でへ]|$|\n))/gu;

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * 拾った物件名を整える。物件名でなければ null（＝渡さない）。
 * 設計知見「汚れた材料はブレインに渡さない方がまし」— 迷う物は捨てる側に倒す。
 */
export function cleanName(raw: string | null | undefined): string | null {
  let n = (raw ?? "").trim();
  if (!n) return null;
  n = n.replace(NAME_HEAD_CUT_RE, "").trim();      // 「…お部屋の中でも特に」を落とす
  n = n.replace(/^[のはがもをに、。\s　]+/, "").trim();
  if (n.length < 2 || n.length > 28) return null;
  if (NOT_A_PROPERTY_RE.test(n)) return null;       // 費用・条件の行
  if (NOT_A_NAME_RE.test(n)) return null;           // 述語・敬語・署名（人名）・設備の説明
  if (NUMERIC_ONLY_RE.test(n)) return null;         // 「9/8 15:00」「9/15(火)」
  return n;
}

/**
 * 直前送信から「締めの言い回し」を取り出す（人が読める元の節のまま）。
 * 定型かどうかは判定しない — 定型でも「今回また同じ事を言おうとしている」と気付かせるのが目的。
 */
export function extractClosingClauses(text: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of (text ?? "").split(/[\n。]+/)) {
    const s = line.trim().replace(/^[\s　]*/, "");
    if (!s || s.length < 5) continue;
    if (!CLOSING_CLAUSE_RE.test(s)) continue;
    const key = s.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 直前送信の締めを「種類の名前」に変える（言い回しは返さない）。
 * これがプロンプトに渡る唯一の締めの情報。
 */
export function classifyClosings(text: string | null | undefined): string[] {
  const t = text ?? "";
  return CLOSING_KINDS.filter((k) => k.re.test(t)).map((k) => k.label);
}

/**
 * 直前送信から「まだ言い直していない具体」を取り出す。
 * ここで作らない（直前送信に**書いてある物だけ**）。何も無ければ空配列。
 */
export function extractConcreteFacts(text: string | null | undefined): ConcreteFact[] {
  const t = text ?? "";
  const out: ConcreteFact[] = [];
  const seen = new Set<string>();
  const push = (kind: ConcreteFact["kind"], value: string) => {
    const v = value.trim();
    if (!v) return;
    const key = `${kind}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value: v });
  };

  PROPERTY_LABEL_RE.lastIndex = 0;
  for (let m = PROPERTY_LABEL_RE.exec(t); m; m = PROPERTY_LABEL_RE.exec(t)) {
    const name = cleanName(m[1] ?? m[3]);
    const room = (m[2] ?? m[4] ?? "").trim();
    if (!name) continue;
    push("物件名", name);
    if (room) push("号室", `${toHalf(room)}号室`);
  }
  VENUE_AFTER_TIME_RE.lastIndex = 0;
  for (let m = VENUE_AFTER_TIME_RE.exec(t); m; m = VENUE_AFTER_TIME_RE.exec(t)) {
    const name = cleanName(m[1]);
    if (name) push("物件名", name);
  }
  for (const m of t.match(DATE_RE) ?? []) push("日程", toHalf(m).replace(/\s+/g, ""));
  for (const m of t.match(TIME_RE) ?? []) push("時刻", toHalf(m).replace(/\s+/g, ""));
  return out.slice(0, 6);
}

/** 実送信の長さ（scripts/audit-after-ack.ts・96件中の返信50件） */
export const AFTER_ACK_MEDIAN_CHARS = 54;
export const AFTER_ACK_MEDIAN_LINES = 3;

/**
 * 直前送信から作る、**userPrompt の一番最後に置く**材料。
 * 何も添えるものが無ければ空文字（余計な指示を増やさない）。
 *
 * ⚠ 「繰り返すな」とは書かない。実送信の 1.0% は正当な焼き直しで、
 *   定型の締め（何卒／お気軽にご連絡）は繰り返す方が普通だから（実送信の述部1位・2位）。
 *   書くのは「同じ種類の締めをもう一度書かない」と「足せる具体があれば1つ足す」まで。
 */
export function buildPreviousSendNote(prevStaffText: string | null | undefined): string {
  const prev = (prevStaffText ?? "").trim();
  if (!prev) return "";
  const kinds = classifyClosings(prev);
  const facts = extractConcreteFacts(prev);
  if (kinds.length === 0 && facts.length === 0) return "";

  const parts: string[] = [];
  // ⚠ 締めは言い回しを書かない（書くとモデルがそれを写す。YUMA ③で実証）。種類の名前だけ。
  //   実送信では連続2通に同じ締めが重なるのは 2.1%（scripts/audit-repeat-previous.ts ⑤・近さ0.70超）
  //   ＝「同じ締めを重ねない」はスタッフが実際にしている事で、創作の強制ではない。
  if (kinds.length > 0) {
    parts.push(`直前の送信は既に【${kinds.join("・")}】で締めてある。同じ種類の締めをもう一度書かない`);
  }
  // ⚠ 足す物が有る時だけ「足せ」と言う。
  //   無い時にも言っていたら、YUMA ① で「書類お送りいただきありがとうございます！！」という
  //   **起きていない事**を作った（お客様は書類を送っていない）。
  //   設計知見「率をプロンプトで釣ると振り子になる → 条件で分ける」。
  if (facts.length > 0) {
    const byKind = new Map<string, string[]>();
    for (const f of facts) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind)!.push(f.value);
    }
    parts.push(`直前の送信に出ている具体: ${[...byKind.entries()].map(([k, v]) => `${k}=${v.join("・")}`).join(" ／ ")}`
      + `。このうちまだ言っていない物を1文だけ足す（無ければ足さない）`);
  } else {
    parts.push(`足せる具体（確定した日程・時刻・物件名）は直前の送信に無い`
      + `。開口語1行＋一言だけで終える（この場面の実送信は中央値 ${AFTER_ACK_MEDIAN_CHARS}字・${AFTER_ACK_MEDIAN_LINES}行）`
      + `。履歴に無い事（書類が届いた・日程が決まった・物件を送った等）を新しく書かない`);
  }
  // ⚠ これは**上書きの指示**なので、呼び出し側は userPrompt の一番最後に置く
  //   （staffContextNote の位置に置いたら後続の骨格に負けた。YUMA ①で実証）。
  return `\n\n【最後に確認：直前に自分が送った文と重ねない】${parts.join("。")}。`;
}
