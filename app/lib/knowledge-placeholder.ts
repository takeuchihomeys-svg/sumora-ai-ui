// app/lib/knowledge-placeholder.ts
// ナレッジ（ai_reply_knowledge）の**言い回しの手本**に埋まっている「他のお客様の具体条件」を伏せる（純関数）。
//
// 2026-09-19 竹内（慶次事例）「ナレッジの部分から進める。成約データや直近のLINEを基に1つずつ改善する」
//
// 【何が起きていたか】
// 慶次さん（新条件＝中央大通りより北側）に「**ペット可条件で**お部屋ピックアップさせて頂きます！！」。
// 出所は phrase（言い回しの手本）カテゴリのナレッジで、**顧客名は〇〇に伏せてあるのに条件は生のまま**だった:
//   「〇〇さんお待たせ致しました！！大阪市内全域から**ペット可・駅徒歩5分以内・家賃15万円以内の2LDK**の
//     ご条件に合ったお部屋ピックアップさせて頂きました！！」（used=501 apply=348 **wrong=52**）
//
// 【ナレッジ自身が正解を言っていた】
//   「ピックアップ行で**ペット可・礼金なし・審査通過しやすい等の具体的条件を列挙するのはNG**。
//     『ご条件のエリアから』とシンプルにまとめ、条件の詳細説明は省略する」（used=310）
//   ＝ 手本と方針が**矛盾していて、写しやすい手本の方が勝っていた**。
//
// 【線】phrase（そのまま写させる物）だけを伏せる。pattern / principle / style は説明文なので、
//   具体条件は「例」として意味があるので触らない（伏せると説明が成り立たない）。
//   DB は書き換えない＝**プロンプトに入れる直前に伏せる**（可逆・元の学習データは残る）。

/** お客様ごとに違う設備条件（これが手本に残ると「このお客様の条件」と取り違えられる） */
const COND_WORDS = [
  "ペット可", "ペット相談", "ペット", "駐車場", "オートロック", "独立洗面", "バストイレ別", "風呂トイレ別",
  "宅配ボックス", "ウォークインクローゼット", "楽器", "事務所", "二人入居", "ルームシェア", "同棲", "喫煙",
  "角部屋", "分譲", "ガスコンロ", "礼金なし", "敷金礼金なし", "審査通過しやすい",
];
/** 家賃・間取り・徒歩分・築年・面積・階数の具体値 */
const SPEC_RE = /[0-9０-９]+(?:[.．][0-9０-９]+)?\s*(?:万円|円)|[0-9０-９]\s*[LDKSRlmdks]{1,4}(?![a-zA-Z])|ワンルーム|徒歩\s*[0-9０-９]+\s*分|築\s*[0-9０-９]+\s*年|[0-9０-９]+\s*㎡|[0-9０-９]+\s*階以上/;

/** 条件のまとまりに具体値が入っているか */
function hasSpecific(s: string): boolean {
  return COND_WORDS.some((w) => s.includes(w)) || SPEC_RE.test(s);
}

/** ピックアップ・お探しの宣言を含む文か（言い回しの手本のうち、条件列挙が起きる所） */
const PICKUP_RE = /(?:ピックアップ|お探し|探させて|お調べ|探して)/;

/**
 * 「〜から <条件の列挙> の(ご条件に合った)?お部屋」の条件の列挙を落とす。
 * エリアの列挙も「〇〇」に畳む（他のお客様のエリアを今のお客様のエリアと取り違えない）。
 */
function foldPickupSpan(line: string): string {
  let out = line;
  // ① 「<エリア>から <条件> の… お部屋/物件」→「〇〇から ご条件に合った お部屋」
  //    2026-09-19 監査で見つけた誤り: 区切りを見ずに「から」の手前40字を畳むと
  //    「乗り換えなしのエリア」の途中で切れて「エ〇〇から」になった（文が壊れる）。
  //    → **句読点・行頭からしか畳まない**（語の途中で切らない）。
  out = out.replace(
    /(^|[。！!、，,\s])([^\n。！!、，,]{0,40}?)から([^\n。！!]{0,70}?)(?=(?:のご条件に合った|ご条件に合った|のご条件に近い|のご希望|の)?(?:お部屋|物件))/g,
    (whole, head: string, area: string, cond: string) => {
      if (!hasSpecific(`${area}${cond}`)) return whole;      // 具体値が無ければ触らない
      return `${head}〇〇から`;
    },
  );
  // ② 括弧の中の条件列挙「（5階以上・ペット可・広めの間取り）」→「（〇〇）」
  out = out.replace(/[（(]([^（()）\n]{2,40})[）)]/g, (whole, inner: string) => (hasSpecific(inner) ? "（〇〇）" : whole));
  // ③ 残った設備条件語の連なり「ペット可・礼金なし・審査通過しやすい」→ 落とす
  for (const w of COND_WORDS) {
    if (!out.includes(w)) continue;
    out = out.replace(new RegExp(`[^\\n。！!、，,]{0,8}?${w}[^\\n。！!、，,]{0,6}?(?:[・･]|$)`, "g"), "");
  }
  return out
    .replace(/〇〇(?:から)?(?:〇〇から)+/g, "〇〇から")
    // 元の「…の2LDK**の**ご条件に合った」の助詞が余るので整える（実送信の型は「〜からご条件に合ったお部屋」）
    .replace(/〇〇からの(?=ご条件|ご希望|お部屋|物件)/g, "〇〇から")
    .replace(/[・･]{2,}/g, "・").replace(/\s{2,}/g, " ");
}

/**
 * ナレッジ自身の「説明文」か（NG/OK の対比・方針の言い切り）。
 * 2026-09-19 監査: 「NG:AIが一般的な条件（築年数・家賃・駐車場付き等）を並べて…」を
 *   「（〇〇）」に畳んでしまい、方針の説明が読めなくなった。**説明文は丸ごと触らない**。
 */
const EXPLANATION_RE = /NG|OK|禁止|不要|しない|省略|べき|望ましい|方が|する事|すること|のは|→/;

export type MaskResult = { text: string; changed: boolean };

/**
 * ナレッジ1件を、プロンプトに入れてよい形にする。
 * phrase（そのまま写させる言い回し）だけ条件を伏せる。それ以外はそのまま。
 */
export function maskKnowledgeSpecifics(content: string, category: string | null | undefined): MaskResult {
  const text = String(content ?? "");
  if ((category ?? "").trim() !== "phrase") return { text, changed: false };
  if (!PICKUP_RE.test(text)) return { text, changed: false };     // 条件列挙が起きるのは宣言文だけ
  if (!hasSpecific(text)) return { text, changed: false };
  if (EXPLANATION_RE.test(text)) return { text, changed: false }; // ナレッジ自身の方針の説明は触らない
  const out = text.split("\n").map((l) => (PICKUP_RE.test(l) ? foldPickupSpan(l) : l)).join("\n").trim();
  return { text: out, changed: out !== text };
}

/** 伏せた事を LLM に伝える1行（手本の後ろに付ける） */
export const MASKED_NOTE = "※ 手本の〇〇は「このお客様の条件を入れる所」。手本に書かれていた条件は**別のお客様の物**なので使わない";
