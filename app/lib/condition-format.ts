// app/lib/condition-format.ts
// 「これはうちの条件フォーマットか」を決定論で判定する（純関数・DB 依存なし）。
//
// 2026-09-18 竹内（💋chibi💋 事例）「なんでお客さんから物件の条件送られたのにこれ条件としては読みとって
//   ないんかな？物件検索の拡張ツールにも反映されていない」:
//   お客様は 20:08 にうちのフォーマットをそのまま埋めて送ったのに property_customers に行が作られず、
//   Chrome 拡張が検索する元データが無かった（返信には条件が反映されていたので気付きにくい）。
//
// 【原因】line-webhook の autoParseFormat は、条件の抽出（Sonnet）の前に Haiku の分類を通していて、
//   その分類プロンプトが知っている「うちのフォーマット」が**古い形**だった:
//     プロンプト: ①希望エリア ②希望間取り ③希望家賃 ④入居時期 …（項目名も順番も違う）
//     実際:       ①【ご入居の時期】②【ご希望の家賃（◯万円〜◯万円）】③【希望の広さ・間取り】
//                 ④【希望築年数】⑤【ご希望のエリア・駅名】⑥【ご希望の駅徒歩分数】
//                 ⑦【初期費用の限度額】⑧【その他ご要望あれば】
//   chibi の分類は 20:08:07 に走って（llm_usage_logs）その後の抽出が1件も無い＝ここで弾かれた。
//
// 【実データ】120日でうちのフォーマットを送ったお客様 126人のうち **26人（21%）** が
//   顧客データに入っていなかった（23人は行すら無い・3人はエリア空）。
//
// 【直し】**自分が送ったテンプレートが埋まって返ってきたか**は、語の一覧で確実に分かる。
//   判断の要らない事を LLM に聞くと、揺れる分だけ黙って落ちる。決定論で先に確定させ、
//   LLM の分類は「テンプレートではない普通の文」だけに使う。

/**
 * スタッフが送るテンプレートの項目（実送信から。① の番号や 【】 の有無は問わない）。
 * 「の」の有無・言い換え（ご入居時期／初期費用ご予算／その他こだわり条件／駅からの徒歩分数）は
 * 実データ 120日の全件監査で出た表記ゆれ。**項目が3つ以上そろって初めてフォーム**と見るので、
 * 1語が広くても（初期費用など）単独では発火しない。
 */
export const SUMORA_FORM_LABELS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: "move_in",      re: /ご?入居(?:の)?時期|入居希望日/ },
  { key: "rent",         re: /ご?希望(?:の)?家賃|家賃帯/ },
  { key: "floor_plan",   re: /希望の広さ|ご?希望(?:の)?間取り|広さ・間取り/ },
  { key: "building_age", re: /ご?希望(?:の)?築年数/ },
  { key: "area",         re: /ご?希望(?:の)?エリア|エリア・駅名|希望の場所・地域|ご?希望(?:の)?地域/ },
  { key: "walk",         re: /徒歩分数/ },
  { key: "initial_cost", re: /初期費用(?:の)?(?:限度額|ご?予算)/ },
  { key: "other",        re: /その他(?:ご要望|こだわり)/ },
];

/** テンプレートの見出し（これがあれば1発で確定） */
const FORM_HEADING_RE = /お部屋探しご条件|お部屋お探し中/;

/**
 * その行の「値」を取り出す（値の前に付く ⇒ → = ： : と空白は落とす）。
 * 【】がある行は **】より後ろだけ**を見る（旧実装は 】の後ろが空の時に行全体へ落ちてしまい、
 * 「④【希望築年数】」のような**空欄を「記入あり」と数えていた**）。
 */
function valueAfterLabel(line: string): string {
  const b = line.indexOf("】");
  if (b >= 0) return line.slice(b + 1).replace(/^[\s⇒→=＝:：]+/, "").trim();
  const m = line.match(/[⇒→=＝:：](.*)$/);
  return m ? m[1].trim() : "";
}

/**
 * その行の「見出し部分」（値より前）。
 * 項目の照合は必ずここに対して行う。行全体で照合すると、**値に入っている語が項目名と誤認**される
 * （chibi の「⑧【その他ご要望あれば】⇒本当に初期費用2980円なんでしょうか？」が
 *  ⑦初期費用の行として数えられ、⑧が消えた）。
 */
function labelPartOf(line: string): string {
  const b = line.indexOf("】");
  if (b >= 0) return line.slice(0, b + 1);
  const m = line.match(/^(.*?)[⇒→=＝:：]/);
  return m ? m[1] : line;
}

/** その行がテンプレートの項目行か */
function labelOfLine(line: string): string | null {
  const head = labelPartOf(line);
  for (const l of SUMORA_FORM_LABELS) if (l.re.test(head)) return l.key;
  return null;
}

export type SumoraFormVerdict = {
  /** テンプレートの項目がいくつ見つかったか */
  labelCount: number;
  /** そのうち値が書かれている項目 */
  filled: string[];
  /** 見出し（（ご希望のお部屋探しご条件）等）があるか */
  hasHeading: boolean;
  /** うちのフォーマットが「埋まって」返ってきたか */
  isFilledForm: boolean;
};

/**
 * うちのテンプレートが埋まって返ってきたかを決定論で判定する。
 *   値は同じ行（「①【ご入居の時期】⇒最短」）でも次の行（「②【…】」の次が「⇒45000~50000」）でもよい。
 *   項目が3つ以上あり、1つ以上に値が入っていれば「埋まったフォーム」。
 *   空のまま返ってきた（スタッフのテンプレートのコピー）時は false（作るものが無い）。
 */
export function analyzeSumoraForm(text: string | null | undefined): SumoraFormVerdict {
  const raw = (text ?? "").trim();
  const lines = raw.split("\n");
  const seen = new Set<string>();
  const filled = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const key = labelOfLine(lines[i]);
    if (!key) continue;
    seen.add(key);
    let v = valueAfterLabel(lines[i]);
    // 値が次の行に来る形（LINE の折り返し）にも対応
    if (!v) {
      const next = (lines[i + 1] ?? "").trim();
      if (/^[⇒→=＝:：]/.test(next) && !labelOfLine(next)) v = next.replace(/^[\s⇒→=＝:：]+/, "").trim();
    }
    // 「特になし」「なし」も「答えた」ので値として扱う（条件が無いことも条件）
    if (v) filled.add(key);
  }
  const hasHeading = FORM_HEADING_RE.test(raw);
  return {
    labelCount: seen.size,
    filled: [...filled],
    hasHeading,
    isFilledForm: seen.size >= 3 && filled.size >= 1,
  };
}

/** うちのフォーマットが埋まって返ってきたか（LLM に聞かずに確定させる入口） */
export function isFilledSumoraForm(text: string | null | undefined): boolean {
  return analyzeSumoraForm(text).isFilledForm;
}

/**
 * 分類・抽出のプロンプトに埋め込む「うちのフォーマット」の説明。
 * ここが実物とずれると、埋まったフォームが not_condition に落ちる（chibi 事例）。
 * テンプレートを変えたら**必ずここも直す**。
 */
export const CONDITION_FORMAT_TEMPLATE = `
【スモラの希望条件フォーマット（スタッフがお客さんに送るテンプレート）】
お客さんがこの形式で送ってきたものが「正式フォーマット」です:
（ご希望のお部屋探しご条件）
①【ご入居の時期】⇒（例: 最短、10月、9月末）
②【ご希望の家賃（◯万円〜◯万円）】⇒（例: 45000~50000、11万まで、5万円〜7万円）
③【希望の広さ・間取り】⇒（例: 1LDK、1K/1DK/1LDK、2LDK以上）
④【希望築年数】⇒（例: 築浅、10年以内）
⑤【ご希望のエリア・駅名】⇒（例: 杉本町、桜川・心斎橋・難波、大阪市内）
⑥【ご希望の駅徒歩分数】⇒（例: 15、10分以内）
⑦【初期費用の限度額】⇒（例: 30、10万まで、少ないほどいい）
⑧【その他ご要望あれば】⇒（例: ペット可、バストイレ別、二人入居可）

注意:
- 先頭に「▶︎【お部屋お探し中！】」、末尾に「________________________」や
  「※ 〇〇さんご希望のご条件お送りください」が付いたまま返ってくることがある（テンプレートの飾り）。
  これらが付いていても、項目に値が入っていれば「正式フォーマット」です。
- 空欄の項目（④⑦など未記入）があっても正式フォーマットです。
- ⑧に質問（「本当に初期費用2980円なんでしょうか？」等）が書かれていても正式フォーマットです。
  質問が含まれることを理由に not_condition にしてはいけません。
- 番号は多少前後・欠番があってもOK。項目名が多少違っても内容で判断。
`;
