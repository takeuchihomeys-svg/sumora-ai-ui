// こちらの送信に対して、お客様がどう返してくるか（実測）とこの会話の現在地をブレインに渡す（純関数・DB 依存なし）
//
// 2026-09-23 竹内「実際の成約データや直近のLINEもみて、送信の時間にたいしてどのように返信しているかも学べば
//   さらに質が良くなる。その返信や送信のバランスがより分かるから。返信したのとAIXも掛け合わせたらより鮮明になる」
//
// 【なぜ要るか】ブレインには「最終顧客メッセージ: N日前」という**日単位**の1行しか無かった。
//   ルールには「物件送付直後で顧客の反応がまだ無い場合は aix:null」と書いてあるのに、
//   ①「直後」かどうか ②その送信が何だったか ③その種類は普通どれくらいで返ってくるのか が渡っていなかった。
//
// 【実測】scripts/audit-reply-timing.ts（直近180日・メッセージ21,672通・こちらの送信5,187通・連投はまとめた）
//   種類によって返り方が全く違う:
//     内覧のご案内  返信100.0% 中央値20分  90%で20.4時間  ← ほぼ必ず、すぐ返る
//     物件確認した  返信 95.3% 中央値27分  90%で25.0時間
//     見積書        返信 93.7% 中央値21分  90%で24.1時間
//     手打ち        返信 92.9% 中央値43分  90%で46.6時間
//     物件送付      返信 83.3% 中央値1.7時間 90%で3.3日
//     物件オススメ  返信 72.8% 中央値1.7時間 90%で**5.1日**  ← 一番返ってこない・一番待つ
//   ＝「物件オススメを送って2日返事が無い」は普通のこと。「内覧のご案内を送って2日」は異常。
//      同じ「2日沈黙」でも意味が逆になるので、種類と時間を一緒に渡さないと判断できない。
//
// 【静的データはハードコード】この表は学習で動く物ではなく実測の分布なので、DB に置かずここに持つ
//   （竹内さんの方針・設計知見「静的データはハードコード・動的データのみ DB」）。測り直したら数字を入れ替える。

/** 種類ごとの実測（直近180日）。h は時間 */
export type SendStat = { label: string; n: number; replied: number; within1h: number; medianH: number; p75H: number; p90H: number };

export const SEND_REPLY_STATS: Record<string, SendStat> = {
  viewing_invite: { label: "内覧のご案内", n: 102, replied: 100.0, within1h: 60.8, medianH: 0.33, p75H: 2.8, p90H: 20.4 },
  property_check_result: { label: "物件確認した", n: 253, replied: 95.3, within1h: 59.7, medianH: 0.45, p75H: 3.3, p90H: 25.0 },
  meeting_place: { label: "待ち合わせ場所", n: 75, replied: 98.7, within1h: 57.3, medianH: 0.53, p75H: 6.1, p90H: 25.6 },
  application_push: { label: "申込へ", n: 60, replied: 96.7, within1h: 60.0, medianH: 0.32, p75H: 4.2, p90H: 60.0 },
  estimate_sheet: { label: "見積書", n: 174, replied: 93.7, within1h: 54.6, medianH: 0.35, p75H: 3.2, p90H: 24.1 },
  condition_hearing: { label: "条件ヒアリング", n: 36, replied: 80.6, within1h: 50.0, medianH: 0.37, p75H: 4.4, p90H: 42.9 },
  property_send: { label: "物件送付", n: 186, replied: 83.3, within1h: 38.7, medianH: 1.7, p75H: 16.3, p90H: 79.2 },
  property_recommendation: { label: "物件オススメ", n: 386, replied: 72.8, within1h: 32.1, medianH: 1.7, p75H: 25.5, p90H: 122.4 },
  manual: { label: "手打ち", n: 3883, replied: 92.9, within1h: 49.3, medianH: 0.72, p75H: 7.2, p90H: 46.6 },
};

/** 会話全体のバランスの実測（⑤）。成約した会話はお客様の方が多く喋っている */
export const BALANCE_STATS = {
  won: { convs: 35, staffMedian: 57, customerMedian: 66, ratioMedian: 0.90 },
  other: { convs: 271, staffMedian: 23, customerMedian: 10, ratioMedian: 2.00 },
} as const;

/** 返事が無い時にこちらが次を送るまでの実測（④） */
export const CHASE_STATS = { n: 785, medianH: 19.5, q25H: 2.1, q75H: 93.6, wonMedianH: 5.0, otherMedianH: 22.9 } as const;

/** 成約側 / それ以外 の返り方（②） */
export const OUTCOME_STATS = {
  won: { n: 1217, replied: 99.5, within1h: 57.4, medianH: 0.47 },
  other: { n: 3970, replied: 88.8, within1h: 46.1, medianH: 0.82 },
} as const;

const hStr = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)}日` : h < 1 ? `${Math.round(h * 60)}分` : `${h.toFixed(1)}時間`);

/** 経過時間が分布のどこにいるか（材料として渡す。判断はブレインがする） */
export function wherePositioned(elapsedH: number, s: SendStat): string {
  if (elapsedH <= s.medianH) return `半分のお客様がまだ返していない時間帯（中央値 ${hStr(s.medianH)}）`;
  if (elapsedH <= s.p75H) return `4人に1人はまだ返していない時間帯（75%が ${hStr(s.p75H)}まで）`;
  if (elapsedH <= s.p90H) return `10人に1人はまだ返していない時間帯（90%が ${hStr(s.p90H)}まで）`;
  return `この種類では9割が返し終わっている時間を過ぎた（90%が ${hStr(s.p90H)}）`;
}

export type TimingInput = {
  /** 直前にこちらが送った時刻（ISO） */
  lastStaffAt: string | null | undefined;
  /** その送信の種類（AIX の aix_type。手打ちなら null） */
  lastStaffAixType: string | null | undefined;
  /** その送信より後にお客様が返しているか */
  customerRepliedAfter: boolean;
  /**
   * 返している場合、その返信の時刻（ISO）。
   * 2026-09-23 全件監査で気づいた: ブレインが走るのはほとんど**お客様が返信した瞬間**なので、
   *   「あと何時間待つか」より「**今回は何時間で返してきたか**」の方が判断に効く
   *   （いつもより早い＝熱が高い／いつもより遅い＝冷めかけ）。竹内さんの問い（送信の時間に対してどう返信しているか）そのもの。
   */
  customerRepliedAt?: string | null;
  /** この会話の通数 */
  staffCount: number;
  customerCount: number;
  now?: number;
};

/**
 * ブレインに渡す【送信と返信のバランス】。事実と実測だけを渡し、「待て」「追え」とは書かない
 * （設計知見「AIX の要否・種類はブレインだけが判断」「率をプロンプトで釣ると振り子になる」）。
 */
export function buildSendReplyTimingNote(input: TimingInput): string {
  const now = input.now ?? Date.now();
  const t = Date.parse(input.lastStaffAt ?? "");
  const lines: string[] = [];

  if (Number.isFinite(t) && !input.customerRepliedAfter) {
    const elapsedH = Math.max(0, (now - t) / 3600_000);
    const key = (input.lastStaffAixType ?? "").trim() || "manual";
    const s = SEND_REPLY_STATS[key] ?? SEND_REPLY_STATS.manual;
    lines.push(`- 直前にこちらが送ったのは【${s.label}】で、お客様はまだ返していない（${hStr(elapsedH)}経過）`);
    lines.push(`  実測(180日・${s.n}通): 最終的に返信あり ${s.replied}% ／ 1時間以内 ${s.within1h}% ／ 中央値 ${hStr(s.medianH)} ／ 75% ${hStr(s.p75H)} ／ 90% ${hStr(s.p90H)}`);
    lines.push(`  → 今は「${wherePositioned(elapsedH, s)}」`);
    // 種類による違いが一番効くので、極端な2つだけ並べて相対化する
    if (key === "property_recommendation" || key === "property_send") {
      lines.push(`  ※ この種類は実測で一番返ってこない（内覧のご案内は返信100%・中央値20分）。沈黙＝脈なし とは限らない`);
    } else if (key === "viewing_invite" || key === "property_check_result") {
      lines.push(`  ※ この種類は実測でほぼ必ず・すぐ返る。長く空いているなら普段と違う`);
    }
  } else if (Number.isFinite(t) && input.customerRepliedAfter) {
    const rt = Date.parse(input.customerRepliedAt ?? "");
    const key = (input.lastStaffAixType ?? "").trim() || "manual";
    const s = SEND_REPLY_STATS[key] ?? SEND_REPLY_STATS.manual;
    if (Number.isFinite(rt) && rt >= t) {
      const tookH = (rt - t) / 3600_000;
      // いつもより早いか遅いか。線は中央値と75%（実測の分布そのまま・こちらで決めた線ではない）
      const speed = tookH <= s.medianH
        ? `この種類の中央値（${hStr(s.medianH)}）より早い返信`
        : tookH <= s.p75H
          ? `中央値は過ぎたが4人に3人の範囲内（75%が ${hStr(s.p75H)}）`
          : tookH <= s.p90H
            ? `遅い方の4分の1に入る（90%が ${hStr(s.p90H)}）`
            : `この種類では9割が返し終わる時間を過ぎてからの返信`;
      lines.push(`- お客様は【${s.label}】から ${hStr(tookH)}後に返信した（実測: 中央値 ${hStr(s.medianH)} ／ 75% ${hStr(s.p75H)} ／ 90% ${hStr(s.p90H)}）`);
      lines.push(`  → ${speed}`);
    } else {
      lines.push(`- 直前のこちらの送信【${s.label}】にはお客様が返している（反応待ちではない）`);
    }
  }

  const total = input.staffCount + input.customerCount;
  if (total >= 6) {
    const ratio = input.staffCount / Math.max(input.customerCount, 1);
    lines.push(`- この会話の通数: こちら ${input.staffCount}通 : お客様 ${input.customerCount}通（比 ${ratio.toFixed(2)}）`);
    lines.push(`  実測: 申込以降まで進んだ会話の比は ${BALANCE_STATS.won.ratioMedian.toFixed(2)}（お客様の方が多く話している）／それ以外は ${BALANCE_STATS.other.ratioMedian.toFixed(2)}（こちらが2倍送っている）`);
    if (ratio >= 1.8) lines.push(`  → 今はこちらが多く送っている側。送る量を増やすより、お客様が返しやすい形かを見る`);
  }

  if (lines.length === 0) return "";
  return `\n【⏱ 送信と返信のバランス（実測 180日・こちらの送信5,187通）】\n${lines.join("\n")}\n`;
}
