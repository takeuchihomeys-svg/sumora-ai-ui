// app/lib/recommend-closing.ts
// AIX【1件特にオススメする】の締めと冒頭を状況に合わせる（純関数・DB 依存なし）。
//
// 2026-09-18 竹内（𝒮 さん事例）「このように状況に合わせて、物件申込誘導するのと、
//   物件1件しか送っていない場合は**お送りさせて頂いたお部屋の中でも**の部分はいれない。
//   今の状況はブレインが分かっているんやから、それと AIX のところリンクさせて状況に応じた文をおくれば、さらに良くなる」
//
// 生成（テンプレート「1件特にオススメする」の AI 最適化）:
//   「**お送りさせて頂きましたお部屋の中でも特に**UMEDA ILAND REIDENCE 302号室が…／
//     9月30日退去予定のため10月1日以降にご内覧可能です！！
//     **お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！**」
// 実送信:
//   「UMEDA ILAND REIDENCE 302号室が…／9月30日退去予定のため10月1日以降にご内覧可能です！！／
//     **お気に召されましたら…お申込みで抑えさせていただき、ご案内させていただきます😊！！**」
//
// 実データ（365日・スタッフ実送信）:
//  ①比較フレーム「お送りさせて頂きましたお部屋の中でも」179件。直前3日にこちらが送った物件の数は
//    0件…**0**／1件…**0**／2件…2／3件以上…177 ＝**2件以上送っている時だけ**使う語。
//  ②退去予定の物件の締め: お申込みで抑える **34件** ／ ご都合よろしいお日にちにご案内 **9件**（79% が申込誘導）
//    ＝まだ内覧できないお部屋は「見に行く」ではなく「先に押さえる」。
//  ③その申込誘導の言い回しは「お気に召されましたらお申込しお部屋抑えさせて頂きます！！」が最多（6件）。
//    煽り（「埋まってしまう前に」23件）は少数なので決定論では足さない（既存の煽り禁止とも整合）。

import { readPropertyStateFromText } from "./property-send-state";

/** 比較フレーム（送った中から1件を推す語）。2件以上送っている時だけ使える */
const COMPARISON_FRAME_RE = /(?:お送り(?:させて(?:頂|いただ)き|)ました?|ご紹介(?:させて(?:頂|いただ)き|)ました?)(?:お部屋|物件)の中でも(?:特に)?|(?:お送り|ご紹介)(?:した|しました)(?:中|なか)でも(?:特に)?/;
/** 内覧の誘導（退去予定でまだ見られない時は申込誘導に差し替える） */
const VIEWING_INVITE_RE = /お気に召され(?:まし)?たら[^\n]{0,20}(?:ご都合|お日にち|日程)[^\n]{0,20}ご案内させて(?:頂|いただ)き(?:ます|ましたら)[^\n]{0,4}[！!。]*|お気に召され(?:まし)?たら[^\n]{0,10}ご案内させて(?:頂|いただ)きます[^\n]{0,4}[！!。]*/;
/** 実データ最多（6件）の申込誘導 */
export const APPLY_CLOSING_LINE = "お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
/** 既に申込の誘導があるか */
const HAS_APPLY_RE = /お申込(?:み)?[^\n]{0,8}(?:抑え|押さえ)|申込(?:み)?(?:で|し)[^\n]{0,8}(?:抑え|押さえ)/;

export type RecommendClosingResult = { text: string; applied: string[] };

/**
 * 本文に書かれた退去予定日から「まだ内覧できない」か（内覧解禁日が明日以降）。
 * 判定の中身は property-send-state に1本化してある（ブレイン・AIX・テンプレートが同じ関数を読む）。
 */
export function stillNotViewable(text: string, nowMs: number = Date.now()): boolean {
  return readPropertyStateFromText(text ?? "", nowMs).notViewable;
}

/**
 * 1件オススメの文を状況に合わせる。
 *  ①送った物件が1件以下なら比較フレーム（「お送りした中でも特に」）を落とす
 *  ②まだ内覧できないお部屋（退去予定・解禁日が明日以降）なら内覧誘導を申込誘導に差し替える
 *    （既に申込の誘導があれば内覧誘導を落とすだけ）
 */
export function fixRecommendClosing(
  text: string,
  o: {
    sentPropertyCount: number;
    /** ブレインの判断（渡されればこちらが正。渡されなければ本文から読む） */
    notViewable?: boolean | null;
    nowMs?: number;
  },
): RecommendClosingResult {
  const src = text ?? "";
  if (!src.trim()) return { text: src, applied: [] };
  const applied: string[] = [];
  let out = src;

  // ① 比較フレーム（2件以上送っている時だけ使える）
  if (o.sentPropertyCount <= 1 && COMPARISON_FRAME_RE.test(out)) {
    out = out.replace(COMPARISON_FRAME_RE, "").replace(/^[\s、,]+/gm, "");
    applied.push("comparison_frame");
  }

  // ② まだ内覧できないお部屋は申込誘導（ブレインの判断があればそれ、無ければ本文から読む）
  const notViewable = typeof o.notViewable === "boolean" ? o.notViewable : stillNotViewable(out, o.nowMs);
  if (notViewable && VIEWING_INVITE_RE.test(out)) {
    const hadApply = HAS_APPLY_RE.test(out);
    out = out.replace(VIEWING_INVITE_RE, hadApply ? "" : APPLY_CLOSING_LINE);
    applied.push(hadApply ? "viewing_invite_removed" : "apply_instead_of_viewing");
  }

  out = out.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!out) return { text: src, applied: [] }; // 全部落ちたら元のまま（安全側）
  return applied.length ? { text: out, applied } : { text: src, applied: [] };
}

/** 生成の指示（ブレインが知っている状況を文に反映させる） */
export function buildRecommendClosingNote(o: {
  sentPropertyCount: number;
  notViewable: boolean;
  /** 内覧解禁日（「10月1日」）。ブレインが持っていれば文に書かせる */
  viewableFrom?: string | null;
}): string {
  const lines = ["【この場面の状況（この通りに書く）】"];
  lines.push(o.sentPropertyCount <= 1
    ? `・これまでにお送りした物件は${o.sentPropertyCount}件 → 「お送りさせて頂きましたお部屋の中でも特に」等の**比較の言い方は書かない**（比べる相手がいない）。物件名から始める（実データ179件すべて2件以上送っている時だけ使われている）`
    : `・これまでにお送りした物件は${o.sentPropertyCount}件 → 「お送りさせて頂きましたお部屋の中でも特に〇〇が」の比較の言い方が使える`);
  // 2026-09-23（scripts/audit-recommend-apply-line.ts・物件オススメ267件）: 「申込34件 vs 内覧9件」は**締めに誘導がある時**の
  //   条件付きの率で、退去予定の通の締めは 申込誘導9.3%／内覧誘導11.6%／誘導なし79.1%。締め自体を必須に読ませない。
  //   空室の通で申込の一文は実送信4.7%（スタッフが自分から足したのは1.4%）→ 書かない、を1行足す。
  //   ⚠ 空室側の「締めは内覧の誘導でよい」も実送信では 誘導なし59.9%／ご査収のみ28.8%／内覧誘導6.6% で強すぎるが、今回は触らない（第2段）
  lines.push(o.notViewable
    ? `・このお部屋は退去予定で**まだご内覧頂けない**${o.viewableFrom ? `（${o.viewableFrom}以降にご内覧可能）` : ""} → 締めに誘導を入れるなら内覧の誘導ではなく**申込の誘導**「${APPLY_CLOSING_LINE}」（誘導がある通では申込34件 vs 内覧9件）。ただし締めの誘導自体は必須ではない（退去予定の通で誘導なし79%）`
    : "・このお部屋は今ご内覧頂ける → 締めは内覧の誘導（お気に召されましたらご都合よろしいお日にちにご案内させて頂きます）でよい。申込の一文は書かない（空室の通で申込の一文は実送信4.7%）");
  lines.push("・「埋まってしまう前に」「残り1部屋」等の煽りは書かない");
  return lines.join("\n");
}
