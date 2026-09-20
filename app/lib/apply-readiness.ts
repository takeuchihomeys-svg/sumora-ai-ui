// app/lib/apply-readiness.ts
// 「このお客様は申込になりそうか」を会話から決定論で見る（純関数・DB 依存なし）。
//
// 2026-09-20 竹内「ブレインがここの部分強化して、ここなら申込になりそうなお客さんだと分析して、
//   そこから申込の流れにいく形はどうか」「過去の成約データや直近の会話から学習して」
//
// 【なぜ既存の purchase_signal_level では足りないか】
// 既に purchase_signal_level（none/soft/strong/peak）があるが、実測すると**予測になっていない**:
//   最初に peak が出た時刻 vs 最初の申込AIXの時刻 → **10件中8件が peak より前に申込済み**（中央値 -8.4日）。
//   定義に「申込許可伺い・手続き/審査プロセスの具体質問は単独1件でも peak」とあり、
//   **もう申込の話をしている段階**を peak と呼んでいた＝事後の追認。
//   段階としても soft 0% / none 0% で機能していない。
//
// 【線の引き方（実データ・対照群つき）】
// 群A=申込に到達した会話21件 / 群B=提案中などで未到達254件。
// 群Aは「最初の申込AIX」の直前7日、群Bは「最後のやり取り」の直前7日で同じ合図を数えた。
//   見積書を送った        86% / 36%  +49pt
//   お客様が内覧を希望した  62% / 14%  +48pt
//   割引・還元を伝えた     76% / 41%  +35pt
//   手続き・審査を聞いた    52% / 22%  +31pt
//   お客様が前向きな反応    33% /  4%  +29pt（比8倍・一番シャープ）
//   内覧・待ち合わせをした   38% /  9%  +29pt
//   物件を名指しした       43% / 15%  +28pt
//   入居時期を聞いた       33% /  8%  +25pt
//   自ら費用を聞いた       57% / 39%  +18pt
//   ---- ここから下は使わない ----
//   1件に絞って強く推した   62% / 48%  +13pt   ← 対照群でも同じくらい起きている
//   審査・保証の不安を解消   10% /  6%  + 3pt   ← 同上
// ※ applying_pattern の key_success_factors は「1件に絞る」「不安解消」を成功要因として書いているが、
//   実データでは**未到達の会話でも同じくらい起きていた**＝後付けの説明。数字で落とした。
//
// 【この関数は文を作らない】
// 出すのは「度合い」と「根拠」だけ。文面は既存の AIX / 返信生成が作る。
// 設計知見「事実は入力・言い回しは決まった文・判断は決定論」。

export type ApplyMsg = { sender?: string | null; text?: string | null; createdAt?: string | null };

export type ApplySignalDef = {
  key: string;
  label: string;
  /** 誰の発言で見るか */
  who: "staff" | "customer";
  /** 実測の差（pt）＝重み */
  weight: number;
  re: RegExp;
};

/** 実測の差が +25pt 以上の合図だけを使う（それ未満は対照群でも同じくらい起きている） */
export const APPLY_SIGNALS: ApplySignalDef[] = [
  { key: "estimate_sent", label: "見積書を送った", who: "staff", weight: 49, re: /御見積書|お見積書|初期費用[^\n。]{0,8}(?:御|お)?見積/ },
  { key: "cust_viewing_req", label: "お客様が内覧を希望した", who: "customer", weight: 48, re: /見てみたい|内覧|内見|見学|見たいです|ご案内(?:して|お願い)/ },
  { key: "discount_told", label: "割引・還元を伝えた", who: "staff", weight: 35, re: /割引させて|最大限割引|還元|節約出来|お安く/ },
  { key: "cust_proc_q", label: "お客様が手続き・審査を聞いた", who: "customer", weight: 31, re: /審査|保証会社|必要(?:な)?(?:もの|書類)|書類|申込|申し込|何が(?:いる|要る)|流れ/ },
  { key: "cust_positive", label: "お客様が前向きな反応", who: "customer", weight: 29, re: /良さそう|いいですね|良いですね|気に入|素敵|ここ(?:が|に)し|これ(?:が|に)し|いい感じ/ },
  { key: "viewed", label: "内覧・待ち合わせをした", who: "staff", weight: 29, re: /待ち合わせ|待合せ|現地エントランス|本日はご内覧|お時間頂きありがとう/ },
  { key: "cust_named", label: "お客様が物件を名指しした", who: "customer", weight: 28, re: /号室|この(?:お?部屋|物件)|こちらの(?:お?部屋|物件)/ },
  { key: "cust_move_q", label: "お客様が入居時期を言った・聞いた", who: "customer", weight: 25, re: /入居(?:日|時期|可能)|いつから|何日から|引っ越し(?:は|日)/ },
];

/** 合図を見る窓（日）。実データの測定と同じ7日 */
export const APPLY_WINDOW_DAYS = 7;

export type ApplyLevel = "low" | "warm" | "hot";
export type ApplyReadiness = {
  /** 0〜100 */
  score: number;
  level: ApplyLevel;
  hits: Array<{ key: string; label: string }>;
  /** スタッフに見せる根拠（文面ではなく事実の列挙） */
  reason: string;
  /** 窓に入った発言の数（少なすぎる時は判定しない） */
  windowCount: number;
};

const MAX_SCORE = APPLY_SIGNALS.reduce((s, x) => s + x.weight, 0);

// ─── 閾値を実データで決めた（scripts/audit-apply-threshold.ts --stale=30）─────────────
// 【最初に測り方を間違えた】対照群を「申込に到達していない会話」全部にしたら、**まだ進行中の人**
//   （その日に内覧日程を送ったばかりの方など）が高得点で「空振り」に数えられ、当たりの割合が
//   最大45%にしかならなかった。対照群を「**最後のやり取りから30日以上動いていない**」＝実質の失注
//   105件に絞り直すと像が変わった:
//     閾値45: 群A 71% / 空振り 4% → 当たり79%
//     閾値50: 群A 62% / 空振り 3% → 当たり81%   ← ここに引く
//     閾値55: 群A 52% / 空振り 1% → 当たり92%
//
// 【線の外側を読んだ（設計知見「外れた側の中身を必ず読む」）】50点以上の空振り3件:
//   Runa 52点  … 他社で申込進行中と分かって乗り換え断念。**申込直前まで行っていた**
//   前田 50点  … 「こちらで審査お願いしてもよろしいでしょうか」まで来て、
//                **中を見ていないことで止まった**（＝内覧が抜けたまま申込に行こうとして失注）
//   LiWei 58点 … USDT交換の勧誘（詐欺アカウント）。合図自体は本物だった
//   → 3件中2件は**予測として当たっていた**。実質の当たりはこの数字より高い。
//
// 【取りこぼし側も読んだ】群Aの低得点は 友哉18点・💜22点 で、どちらも
//   **お客様から先に「審査出して欲しい」が来た人**＝この機能が要らない人だった。
//   取りこぼしても害が無い側に落ちている。
export const HOT_SCORE = 50;
export const WARM_SCORE = 30;
/** 窓にこれ未満の発言しかなければ判定しない（材料不足で hot にしない） */
const MIN_MESSAGES = 4;

/**
 * 申込になりそうか。**文は作らない**（度合いと根拠だけ）。
 * messages は順不同でよい。createdAt が無い発言は窓の判定に使わない。
 */
export function detectApplyReadiness(
  messages: ReadonlyArray<ApplyMsg>,
  nowMs: number = Date.now(),
): ApplyReadiness {
  const from = nowMs - APPLY_WINDOW_DAYS * 86_400_000;
  const win = messages.filter((m) => {
    const t = m.createdAt ? Date.parse(m.createdAt) : NaN;
    return Number.isFinite(t) && t >= from && t <= nowMs && !!(m.text ?? "").trim();
  });
  const hits: Array<{ key: string; label: string }> = [];
  let score = 0;
  for (const s of APPLY_SIGNALS) {
    const hit = win.some((m) => {
      const isCust = (m.sender ?? "") === "customer";
      if (s.who === "customer" && !isCust) return false;
      if (s.who === "staff" && isCust) return false;
      return s.re.test(m.text ?? "");
    });
    if (!hit) continue;
    hits.push({ key: s.key, label: s.label });
    score += s.weight;
  }
  const pct = Math.round((100 * score) / MAX_SCORE);
  const level: ApplyLevel =
    win.length < MIN_MESSAGES ? "low"
    : pct >= HOT_SCORE ? "hot"
    : pct >= WARM_SCORE ? "warm"
    : "low";
  return {
    score: pct,
    level,
    hits,
    reason: hits.length ? hits.map((h) => h.label).join("・") : "",
    windowCount: win.length,
  };
}

/**
 * ブレイン・プロンプトに渡す覚え書き（**文面ではなく事実の要約**）。
 * hot の時だけ出す＝スタッフの注意を安売りしない。
 *
 * 【全ての行を「- 」で始める理由】竹内「文おかしい文が出来ないかテストしておこなう」。
 *   この覚え書きが万一そのまま下書きに混ざっても、行頭の「- 」は
 *   **スタッフの実送信365日 11,815通で0件**（meta-narration.ts の WORKNOTE_SHAPE_RES）なので
 *   stripMetaNarration が丸ごと落とす。__tests__/apply-readiness.test.ts で固定している。
 *   ＝「混ざらないように書く」ではなく「混ざっても落ちる形で書く」。
 *
 * 【お客様の名前を入れない理由】本番で出してみたら「まりあは 見積書を送った…」と敬称なしで名前が入った。
 *   プロンプトの中身は元々1人のお客様の話なので名前は要らず、入れれば
 *   **名前が本文へ流れ込む経路を1つ増やすだけ**（慶次事例＝別のお客様の情報混入と同じ根）。
 *
 * 【本文用は「知らせる・迫らない」だけにする】本番で通したら、内覧が抜けている場面に
 *   「この返信の次の一手は内覧のご案内にする」と書いても**届かなかった**。理由は設計にあった:
 *   内覧の打診は AIX【内覧日調整】の仕事で、本文に候補日時を書くと final-check が弾く
 *   （「AIX の要否・種類はブレインだけが判断する」）。
 *   本文で実行できない指示を本文のプロンプトに置くのは、おかしな文を作る元でしかない。
 *   → 抜けている手順の名指しは buildApplyReadinessBrainNote（AIX を決めるブレイン側）に置いた。
 */
export function buildApplyReadinessNote(r: ApplyReadiness): string {
  if (r.level !== "hot") return "";
  return [
    `- 【申込が近い合図・直近${APPLY_WINDOW_DAYS}日・${r.score}点】このお客様は ${r.reason} ＝ 実データで申込に到達した会話と同じ並び`,
    `- 申込の話はお客様から出るまで待つ（合図が強くてもこちらから申込を迫らない・お客様が申込を口にした時だけ応じる）`,
    `- この合図は判断の材料。本文にこの文言をそのまま書かない`,
  ].join("\n");
}

/**
 * ブレイン（AIX を決める側）に渡す合図。**事実と実データの割合だけを渡し、AIX は選ばせない**。
 *
 * 【一度「内覧を先に埋めよ」と書いて、実データで取り消した】
 *   前田さんの実物「申し込もうと思っており…いざとなると中を見ていないというところで話が進まずでした」を根拠に
 *   「抜けている内覧を埋める AIX を先に選ぶ」と書いたが、対照群つきで測ったら規則にする根拠が無かった
 *   （scripts/audit-apply-viewing-need.ts）:
 *     申込に到達 21件 … 内覧の合図なしで申込 6件（29%）友哉・Sky・💜・大野・吉田雄貴・♥︎
 *     申込が近いのに停滞 3件 … 内覧の合図なし 1件（33%）Runa
 *     差 +5pt ＝ **両方で同じくらい起きている**。内覧なしの申込は普通にある。
 *   → 1件の実例から規則を作らない。事実（内覧の合図がまだ無い）と割合を渡して、選ぶのはブレイン。
 *
 * 【言い回しも指定しない】「〇〇の1文を添えろ」型の強制指示は創作を誘発する（記録済みのルール）。
 */
export function buildApplyReadinessBrainNote(r: ApplyReadiness): string {
  if (r.level !== "hot") return "";
  const has = (k: string) => r.hits.some((h) => h.key === k);
  const facts: string[] = [];
  if (!has("viewed") && !has("cust_viewing_req")) {
    facts.push(`※ **内覧の合図はまだ無い**（実データでは申込に到達した会話の71%に内覧の合図があり、29%は内覧なしで申込している＝内覧が必須という意味ではない）。`);
  }
  if (!has("estimate_sent")) {
    facts.push(`※ **御見積書はまだ送っていない**（実データでは申込に到達した会話の86%で送っている）。`);
  }
  return `\n【📈 申込が近い合図（直近${APPLY_WINDOW_DAYS}日・${r.score}点）】${r.reason}
※ 実データで申込に到達した会話と同じ並び（この点数以上で当たり81%・空振り3%）。
※ ただし**申込を迫る材料ではない**（お客様が申込を口にするまで待つ）。${facts.length ? `\n${facts.join("\n")}` : ""}`;
}
