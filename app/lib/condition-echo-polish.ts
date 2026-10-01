// app/lib/condition-echo-polish.ts
// 条件の復唱（「〇〇周辺全域から〔条件〕で〇〇さんにオススメできるお部屋ピックアップして…」）のうち、
// 「スタッフが同じように直している小さな手直し」だけを決定論で当てる（純関数・DB 依存なし）。
//
// 2026-10-01 竹内「初回返信の条件を読み直すところの返信の部分、今そのまま読み直ししているが、
//   少しだが接続語つけたり、全域つけたり、にしたりして、実際は微々たる改善してスタッフが改善しているところ多いから、
//   その点も実際のLINEを見て改善する」
//
// 測った物（scripts/audit-condition-echo-polish.ts・読むだけ）:
//   ・generate-reply の下書き×実送信でピックアップの文を持つ 235組（初回 84組・うち復唱の文をスタッフが直した 18組）
//   ・人が書いた実送信（AI の下書きのまま送った通と AIX を除く）のピックアップの文 334通
//   ※ 下書きのまま送った通は「スタッフがその形を選んだ」証拠に数えない（設計知見「実送信にある は AI の下書きのまま送った通で数えない」）
//
// 出口で当てるのは「人の文で9割以上が守っている形」かつ「下書きをスタッフが直した組で近づき、遠ざかる組が無い」物だけ:
//   ② 間取りの「か」→「または」（人の文で 間取り＋か＋間取り 0通。直した組 近づく1・遠ざかる0）
//   （＋ validate-reply の「くらい」→「程」の取りこぼしを直した。normalizeKurai は 09-22 からあったが本文に戻していなかった）
//
// ★ ①「全域」を付ける（addZeniki）— 2026-10-01 夕 竹内さんの決定「全域にする」で出口の既定に入れた
//   （午後は下の監査で一度止めた。止めた理由の数字は残す。竹内さんは「スタッフが直さず送った」を良しとせず、人が一から書く形に揃える判断）
//   当てる終わり方（人が一から書いた宣言の文で 全域あり が過半数の物）: 周辺 98/103・市内 9/10・エリア 25/47（53%）・付近 2/3・近辺 1/1・府内 1/1（→「府全域」）
//   当てない: 素の区の並び 3/9（33%）・沿線 0/1・時間や距離のエリア（「梅田まで30分圏内」）・既に全域
// （以下は午後の監査の記録）
//   ・人が一から書いた宣言の文: 周辺全域98 ／ 周辺だけ5（95%）・市内全域9 ／ 1・エリア全域25 ／ エリアだけ22（53%）
//   ・ところが AI の下書きの「〜周辺から」は、スタッフが直さず送った組が 8、同じ文を直した組でも
//     全域を足した 2（北区…西区周辺→周辺全域 08-30・枚方周辺→周辺全域 09-01）／ 足さずに他所だけ直した 2（09-22・09-07）／ エリアごと書き換え 1
//     → 実送信に近づく2・遠ざかる3（＋そのまま8）。「エリア」は「→周辺全域」にしても 近づく8・遠ざかる6（＋そのまま13）
//   ・＝スタッフは全域を「毎回同じように」足してはいない。出口では当てず（polishConditionEcho の既定は空）、
//     入口（conditionDirection と first_reply の型の「周辺全域から」・CONDITION_ECHO_STYLE_NOTE）に任せる。
//     出口で当てるかは竹内さんの判断待ち（当てるなら polishConditionEcho(text, { zenikiKinds: ZENIKI_KINDS })）
//
// 線が引けず入れなかった物（入口＝route の conditionDirection の一文と手本で扱う。ここでは触らない）:
//   ・素の区の並び（「中央区・浪速区から」）: 全域あり3 ／ なし6。付近・近辺・府内: 件数が少ない（各1〜4）
//   ・「・」→「の」（「2LDK・RC造」→「2LDKのRC造」）: 直した組で2件・形が割れる
//   ・「〇万まで」→「以内」: 人の文は 以内52 ／ まで1 だが、下書きの「まで」をスタッフが直した組は0（下書きのまま2）
//   ・条件の取捨・お客様の言葉の言い換え（「ペット可（犬）」→「ペット飼育可能」「お子様1人ありでも審査OK」→「お子様もご入居可能」）
//   ・出口の原則（CLAUDE.md）: 本文を書き換える出口は誤削除0でなければ入れない → ここの変換は語を足す・言い換えるだけで、情報を消さない

/** 「から」の直後が通勤・距離の言い方（＝この「から」はエリアの区切りではない。「梅田から20分以内」「宗右衛門町2-3から自転車10分」） */
//   数字は「20分」「2駅」「1本」の時だけ（「7万円程」「2LDK」は条件の並びなので区切りの から）
const COMMUTE_AFTER_RE = /^(?:\s*(?:[0-9０-９]+\s*(?:分|駅|本|km|キロ)|電車|自転車|徒歩|車|タクシー|バス|乗り換え|乗換|乗り継ぎ|通い|通勤|1本|一本|アクセス|近|すぐ|出やす|行け|行き|まで|の距離|離れ))/;
const TAIL_ALREADY_RE = /全域$/;
/** 物件を送った後の報告の文（「ピックアップさせて頂きました」）。①は宣言の文だけ（報告は AIX の領分で、直し方も割れる） */
const REPORT_RE = /(?:させて|して)(?:頂き|いただき)ました|致しました|いたしました/;

export type PolishResult = { text: string; applied: string[] };

/** エリアの区切りの「から」の位置（直後が通勤の言い方でない最初の「から」・ピックアップより前）。無ければ -1 */
export function findAreaDelimiter(sentence: string): number {
  const verbAt = sentence.search(/ピックアップ/);
  const limit = verbAt < 0 ? sentence.length : verbAt;
  let from = 0;
  while (true) {
    const i = sentence.indexOf("から", from);
    if (i < 0 || i >= limit) return -1;
    if (COMMUTE_AFTER_RE.test(sentence.slice(i + 2))) { from = i + 2; continue; }
    return i;
  }
}

export type AreaTailKind = "周辺" | "付近" | "近辺" | "エリア" | "市内" | "府内" | "区市" | "沿線" | "その他";

function classifyTail(head: string, hasZeniki = false): AreaTailKind {
  const m = head.match(/(周辺|付近|近辺|エリア)$/);
  if (m) return m[1] as AreaTailKind;
  if (/市内$/.test(head)) return "市内";
  if (/府内$/.test(head) || (hasZeniki && /府$/.test(head))) return "府内";
  if (/沿線$|沿い$|線$/.test(head)) return "沿線";
  // 素の行政区の並び（「中央区・浪速区」「阿倍野区」）。並びの前が文の切れ目の時だけ
  const r = head.match(/((?:[一-龯ァ-ヶー]{1,6}[区市][・、,]\s*)*[一-龯ァ-ヶー]{1,6}[区市])$/);
  if (r && (r.index === 0 || /[、,。！!\s「（(]$/.test(head.slice(0, r.index)))) return "区市";
  return "その他";
}

/** 区切りの「から」の前の語の終わり方（「全域」を外して見る）。hasZeniki＝もう全域が付いている（監査で使う） */
export function areaTailOf(sentence: string): { kind: AreaTailKind; hasZeniki: boolean } | null {
  const i = findAreaDelimiter(sentence);
  if (i < 0) return null;
  let head = sentence.slice(0, i);
  const hasZeniki = TAIL_ALREADY_RE.test(head);
  if (hasZeniki) head = head.replace(/全域$/, "");
  return { kind: classifyTail(head, hasZeniki), hasZeniki };
}

/** 「全域」を付ける終わり方（2026-10-01 竹内さんの決定・人の文で全域ありが過半数の物。ファイル冒頭） */
export const ZENIKI_KINDS: ReadonlySet<AreaTailKind> = new Set<AreaTailKind>(["周辺", "付近", "近辺", "エリア", "市内", "府内"]);

/**
 * ① エリアの後ろに「全域」を付ける（2026-10-01 竹内さんの決定で既定 ON）。「大阪府内」は「大阪府全域」（実送信の形）。
 *   直した実物: 「北区（中崎西、大淀）・西区周辺から」→「…西区周辺全域から」（08-30）／「枚方周辺から」→「枚方周辺全域から」（09-01）
 */
export function addZeniki(sentence: string, kinds: ReadonlySet<AreaTailKind> = ZENIKI_KINDS): { text: string; tail: AreaTailKind | null } {
  const i = findAreaDelimiter(sentence);
  if (i < 0) return { text: sentence, tail: null };
  const head = sentence.slice(0, i);
  if (TAIL_ALREADY_RE.test(head)) return { text: sentence, tail: null };
  // 「平野区全体のエリア」に全域を重ねない（AIX 09-03 の実物）
  if (/全体|一帯|全部/.test(head.slice(-12))) return { text: sentence, tail: null };
  const kind = classifyTail(head);
  if (!kinds.has(kind)) return { text: sentence, tail: null };
  const newHead = kind === "府内" ? `${head.slice(0, -1)}全域` : `${head}全域`;
  return { text: `${newHead}${sentence.slice(i)}`, tail: kind };
}

/**
 * ② 間取りの「か」→「または」（「1LDKか2LDK」→「1LDKまたは2LDK」）。
 *   直した実物: チンシャンさん（10/01）。人の文 334通で 間取り＋「か」＋間取り は 0通。
 */
export function layoutOrToMataha(s: string): { text: string; count: number } {
  let count = 0;
  const text = s.replace(/([1-5１-５][SLDKR]{1,4}|ワンルーム)か([1-5１-５][SLDKR]{1,4}|ワンルーム)/g, (_m, a: string, b: string) => { count++; return `${a}または${b}`; });
  return { text, count };
}

// ③（検討して入れなかった・2026-10-01）お客様がぼかしていない金額に「程」を足さない（「7万」→ 下書き「7万円程」）
//   YUMA で4巡4回出たので出口を作ったが、実送信に当てると「程」のある 50通のうち 11通が変わる＝誤変換。
//   スタッフ自身がお客様の「5万円〜7万円」「〜9万」に「7万円程」「9万円程」と書く（AIX の報告に多い・初回の手打ちにも1通）→ 癖ではなく言い方の一つ。入口の手本の注記だけにした

/** 文を区切る（改行・！！・。の後ろ）。区切りの文字は残す */
function splitSentences(text: string): string[] {
  return text.split(/(\n|(?<=[！!。])(?=[^！!。\n]))/).filter((x) => x !== "");
}

/**
 * 本文のピックアップの文（条件の復唱）にだけ①②を当てる。
 *   ・①は既定でこれからの宣言の文だけ。AIX【物件ピックアップした】の報告の文（「ピックアップさせて頂きました」）は includeReports で当てる
 *     （AIX の人の文: 周辺全域131 ／ 周辺16＝89%・scripts/audit-condition-echo-polish.ts）
 *   ・zenikiKinds に空の Set を渡せば①を当てない
 *   ・ピックアップの文以外（挨拶・初期費用・締め）は触らない
 *   ・②はピックアップの語より前（条件の並び）だけ
 */
export function polishConditionEcho(text: string, opts: { zenikiKinds?: ReadonlySet<AreaTailKind>; includeReports?: boolean } = {}): PolishResult {
  const kinds = opts.zenikiKinds ?? ZENIKI_KINDS;
  const src = text ?? "";
  if (!/ピックアップ/.test(src)) return { text: src, applied: [] };
  const applied: string[] = [];
  const parts = splitSentences(src).map((s) => {
    if (!/ピックアップ/.test(s)) return s;
    let out = s;
    if (kinds.size && (opts.includeReports || !REPORT_RE.test(s))) {
      const z = addZeniki(out, kinds);
      if (z.tail) { out = z.text; applied.push(`ZENIKI_ADDED:${z.tail}`); }
    }
    const verbAt = out.search(/ピックアップ/);
    const a = layoutOrToMataha(out.slice(0, verbAt));
    if (a.count) { out = a.text + out.slice(verbAt); applied.push(`LAYOUT_KA_TO_MATAHA×${a.count}`); }
    return out;
  });
  if (!applied.length) return { text: src, applied: [] };
  return { text: parts.join(""), applied };
}

/**
 * 入口（route の conditionDirection・first_reply の型）に渡す一文。条件を「原文の語のまま」並べると、
 * お客様の書き方（「1LDKか2LDK」「7万くらい」）がそのまま残り、スタッフが直していた。
 * 2026-10-01 夕: 「ペット可（犬）→ペット飼育可能」は手本から外した（人が一から書いた文でも「ペット可（犬）」「ペット可(猫)」と残す通が2つ＝直す癖ではない）
 * 例は全部、下書き→実送信でスタッフが直した実物（創作の言い回しは入れない）。
 */
export const CONDITION_ECHO_STYLE_NOTE =
  "条件はお客様の語を使い、条件の形に整えて並べる（実送信のスタッフの手直し: 「1LDKか2LDK・RC造」→「1LDKまたは2LDKのRC造」／「7万円くらい」→「7万円程」／「11万まで」→「家賃11万以内」／「8万から11万」「8-9万円」→「8万〜11万」「8〜9万円」／「同棲可能、子供1人います」→「同棲可・お子様もご入居可能」／" +
  "エリア: 「堀江本町」→「堀江、本町周辺全域」・「難波心斎橋辺り」→「難波・心斎橋エリア周辺全域」・「梅田まで30分」→「梅田まで30分圏内全域」（時間・距離のエリアに「周辺」は付けない）・「大阪市内」→「大阪市内全域」）。条件の追加・お客様が書いていない条件の創作はしない";
