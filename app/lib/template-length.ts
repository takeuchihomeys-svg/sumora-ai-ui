// app/lib/template-length.ts
// AIX テンプレート（AIX の直後に送る2通目）の**質**の指示（純関数・実測が根拠）。
//
// 2026-09-20 竹内「長さで文を切るのではなくて質を上げるイメージ。
//   **AIX の文が長いので、そこで終わったら返信帰ってきにくい。
//   AIX テンプレートは要点絞ってるから返信しやすいお客さんが**」「返信や訴求の為」
//
// ＝ 2通目の役割は「**返信を引き出すこと**」と「**訴求**」。長さは結果であって目的ではない。
//   だから指示も「◯字以内」ではなく「返信が来る形にする」と書き、根拠に実測の返信率を添える。
//
// ■ 実測1: 2通目があると返信が増えるか（scripts/audit-second-message-reply.ts・120日・72時間以内・1,646件）
//   全体では 1通目だけ 85.8% / 2通目あり 76.8% だが、これは meeting_place（100%）等が1通目だけに
//   偏っているため。**AIX 種類別に見ると竹内さんの言うとおり**:
//     物件オススメ        1通目だけ 50.0%（2/4）  → 2通目あり **64.4%**（324/503）
//     物件ピックアップ    1通目だけ 61.7%（29/47）→ 2通目あり **74.1%**（232/313）
//     申込へ！            1通目だけ 75.0%         → 2通目あり **90.2%**
//     ヒアリング          1通目だけ  0.0%（0/2）  → 2通目あり **84.6%**
//   ＝ **1通目が長い物件系ほど、2通目が返信を引き出している**。
//
// ■ 実測2: どんな2通目が返信を引き出すか（2通目のある1,343件・全体の返信率76.8%）
//     **100〜140字  81.0%（462件）** ← 最も高い
//     0〜60字       79.2%（255件） ／ 60〜100字 78.6%（220件）
//     140〜180字    68.8%（109件）
//     **240字〜     67.1%（213件）** ← 低い
//     **箇条書き（・で始まる行2行以上） 63.9%（294件）** ← 全体より13ポイント低い
//     内覧の誘導 82.3%（147件）↑ ／ 申込の誘導 81.6%（147件）
//     お気軽に 89.5%（19件）↑ ／ お申し付けください 90.0%（10件）↑ ／ 何卒よろしく 97.2%（36件）↑
//   ＝ **オススメポイントを箇条書きで並べ直すと返信が減る**（それは1通目の役目）。
//     要点を1つに絞り、次の行動へ誘い、気軽に言ってもらえる締めにすると返信が来る。
//
// ■ 実測3: 実送信の2通目の長さ（scripts/audit-template-length.ts・1,419通）
//   中央値 120字・4行／**成約した会話では 108字・3行**／140字未満が69.5%。
//
// ■ 長さで本文を切らない
//   切ると文の途中で終わって壊れる。入口（指示）で形を決め、出口では**測って記録するだけ**。

/** 長さ・形を縛らない AIX（フォーム・定型の全文を送る物） */
export const LENGTH_FREE_ACTIONS: ReadonlySet<string> = new Set([
  "condition_hearing",          // 条件ヒアリングフォーム（①〜⑧の全文・実測9行）
  "application_push_format",    // 申込フォーマット（記入欄の全文・実測230字）
  "application_format",
  "document_request",
]);

export type LengthGuide = { min: number; target: number; max: number; lines: string };

/** 実送信と返信率から決めた目安（全 AIX 共通。種類ごとに散らさないのは「1つの線の方が守られる」ため） */
export const TEMPLATE_LENGTH_GUIDE: LengthGuide = { min: 100, target: 140, max: 180, lines: "3〜5行" };

/** その AIX で形を縛るか */
export function isLengthGuided(action: string | null | undefined): boolean {
  const a = (action ?? "").trim();
  if (!a) return true; // 種類が分からない時は縛る（長い方に倒さない）
  if (LENGTH_FREE_ACTIONS.has(a)) return false;
  for (const k of LENGTH_FREE_ACTIONS) if (a.startsWith(`${k}_`)) return false;
  return true;
}

/**
 * プロンプトに入れる「2通目の質」の指示。縛らない種類なら空文字。
 *
 * 竹内さんの言葉どおり**長さの制限ではなく目的**（返信・訴求）から書く。
 * 数字は根拠として添えるだけで、先に来るのは「何のための1通か」。
 */
export function buildLengthNote(action: string | null | undefined): string {
  if (!isLengthGuided(action)) return "";
  const g = TEMPLATE_LENGTH_GUIDE;
  return [
    `【この2通目の役目（最優先）】1通目（AIX）は情報が多く、そこで終わるとお客様は返信しづらい。`,
    `この2通目は**返信をもらうため**と**訴求のため**の1通。要点を1つに絞って、返事のきっかけを作る。`,
    `・実測（AIX の直後72時間の返信率・1,343件）: **100〜140字で81.0%** ／ 240字以上で67.1% ／`,
    `  **オススメポイントを「・」で並べ直すと63.9%**（全体76.8%より13ポイント低い）。`,
    `  物件の条件・設備の箇条書きは**1通目で既に送っている**ので、ここで並べ直さない。`,
    `・返信が来ているのは、次の行動へ誘って気軽に言ってもらう締め:`,
    `  内覧の誘導82.3% ／ 申込の誘導81.6% ／「お気軽に」89.5% ／「お申し付けください」90.0%。`,
    `・書く中身は「①1件に絞った推しどころを1文（1通目に無い切り口で）②次の一歩の誘い1文`,
    `  ③気軽に返事できる締め1文」。スタッフの実送信は中央値120字・4行、**成約した会話では108字・3行**。`,
    `・${g.min}〜${g.target}字・${g.lines}に収め、${g.max}字を超えたら**要点を削って**書き直す（文を途中で切らない）。`,
  ].join("\n");
}

/** 生成後の点検（出口ではなく記録用。長さで本文を切ると文が壊れるので切らない） */
export function checkLength(text: string, action: string | null | undefined): { ok: boolean; len: number; lines: number; over: number; bullets: number } {
  const len = text.length;
  const ln = text.split("\n").filter((x) => x.trim()).length;
  // 2026-09-20: 箇条書きは返信率が13ポイント低い（63.9%）ので、長さと一緒に記録して後から追えるようにする
  const bullets = (text.match(/^[・･]/gm) ?? []).length;
  if (!isLengthGuided(action)) return { ok: true, len, lines: ln, over: 0, bullets };
  const over = Math.max(0, len - TEMPLATE_LENGTH_GUIDE.max);
  return { ok: over === 0 && bullets < 2, len, lines: ln, over, bullets };
}
