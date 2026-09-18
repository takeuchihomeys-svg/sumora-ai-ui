// app/lib/__tests__/brain-strategy-note.test.ts
// 実行: npx tsx app/lib/__tests__/brain-strategy-note.test.ts（自己完結ハーネス・全 PASS で exit 0）
import {
  isTruncatedText, truncateAtBoundary, safeBrainPhrase,
  buildBrainStrategyNote, describeBrainStrategyNote,
} from "../brain-strategy-note";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

console.log("── 切れた文字列を見分ける（本番 DB の20字ちょうど5件が実例）");
{
  // brain-core が slice(0,20) で切った実データ
  t("閉じていない括弧は切れている", isTruncatedText("契約書類・手続きの確認（引き落とし口座書"));
  t("助詞で終わるのは切れている", isTruncatedText("在籍証明が用意できない（審査書類不備の不") === true);
  t("読点で終わるのは切れている", isTruncatedText("審査の確認、"));
  t("完結していれば切れていない", !isTruncatedText("審査（保証人・名義ブラック）"));
  t("普通の語は切れていない", !isTruncatedText("初期費用の安さ・複数物件比較"));
  t("空は切れていない扱い", !isTruncatedText("") && !isTruncatedText(null));
}

console.log("── 区切りまで縮める");
{
  t("閉じない括弧ごと落とす（契約書類…）",
    truncateAtBoundary("契約書類・手続きの確認（引き落とし口座書", 60) === "契約書類・手続きの確認",
    String(truncateAtBoundary("契約書類・手続きの確認（引き落とし口座書", 60)));
  t("閉じない括弧ごと落とす（在籍証明…）",
    truncateAtBoundary("在籍証明が用意できない（審査書類不備の不", 60) === "在籍証明が用意できない",
    String(truncateAtBoundary("在籍証明が用意できない（審査書類不備の不", 60)));
  // 括弧を落とせば「トイレに扉／エリア」で完結する（中黒まで削ると意味が痩せるので削らない）
  t("括弧を落として意味を残す（トイレに扉／エリア…）",
    truncateAtBoundary("トイレに扉／エリア（大国町・本町・堺筋本", 60) === "トイレに扉／エリア",
    String(truncateAtBoundary("トイレに扉／エリア（大国町・本町・堺筋本", 60)));
  t("完結した語はそのまま",
    truncateAtBoundary("審査（保証人・名義ブラック）", 60) === "審査（保証人・名義ブラック）");
  t("上限を超えたら区切りで切る",
    truncateAtBoundary("駐車場申込・DKポータル入力対応・書類の提出", 12) === "駐車場申込",
    String(truncateAtBoundary("駐車場申込・DKポータル入力対応・書類の提出", 12)));
  t("縮めて短すぎるなら渡さない", truncateAtBoundary("契約（引き落と", 60) === null,
    String(truncateAtBoundary("契約（引き落と", 60)));
  t("空は null", safeBrainPhrase("") === null && safeBrainPhrase(null) === null);
}

const META = {
  closing_strategy: "鍵の受け渡し日を確定させて頂く",
  winning_pattern: "鍵受け渡し最短時間を管理会社に確認し来阪日程と合わせて即回答し契約完了させる",
  reply_direction: "鍵の受け渡し日をお伝えする",
  key_topics: ["契約手続き完了の確認", "鍵受け渡し時間の最終確認"],
  repeated_concern: "契約書類・手続きの確認（引き落とし口座書",
  latent_intent: "手続き完了を報告し、次は鍵受け渡しの確定を待っている安心感を求めている",
  customer_questions: ["鍵はいつ受け取れますか"],
  current_property: "スペーシア日本橋東608号室",
  customer_emotion: "前向き",
  engagement_stance: "push",
  purchase_signal_level: "strong",
  checkpoint_stage: "contract",
};

console.log("── 渡し方（返信AI と同じ扱いに揃える）");
{
  const fresh = buildBrainStrategyNote(META, { fresh: true });

  t("『必ず含める』の強制が無い", !/必ず含める|最低1つ|必ず拾う/.test(fresh), fresh.match(/[^\n]*必ず[^\n]*/)?.[0] ?? "");
  t("主要トピックは『関係する時だけ』", /主要トピック.*関係する時だけ/.test(fresh.replace(/\n/g, " ")));
  t("繰り返し関心事は『触れている時に限り』", /限り.*事実で答える/.test(fresh.replace(/\n/g, " ")));
  t("触れていなければ一切言及しない、が入る", fresh.includes("一切言及しない"));
  t("切れた文字列が縮まって渡る（引き落とし口座書 が消える）",
    fresh.includes("契約書類・手続きの確認") && !fresh.includes("引き落とし口座書"),
    fresh.match(/[^\n]*関心事[^\n]*/)?.[0] ?? "");
  t("潜在動機は判断材料に下がっている", /潜在動機[^\n]*訴求の選び方の判断にだけ使う/.test(fresh));
  t("勝ちパターンは WE DO 宣言1文に統合される",
    /勝ちパターン×成約戦略[^\n]*1文だけ/.test(fresh) && fresh.includes("社内の段取り"),
    fresh.match(/[^\n]*勝ちパターン[^\n]*/)?.[0] ?? "");

  const stale = buildBrainStrategyNote(META, { fresh: false });
  // 末尾の固定文に「潜在動機等は転記しない」が入るので、行頭の項目行だけを見る
  const staleItems = stale.split("\n").filter((l) => l.startsWith("・"));
  t("古い判断では鮮度従属を落とす（関心事・潜在動機・注目物件が出ない）",
    !staleItems.some((l) => /会話全体を通じた関心事|潜在動機|注目物件|顧客感情|購買シグナル|局面スタンス/.test(l)),
    staleItems.filter((l) => /関心事|潜在動機|注目物件|顧客感情|購買シグナル|局面スタンス/.test(l)).join(" / "));
  t("古い判断でも戦略（勝ちパターン・返信方向）は残る",
    stale.includes("勝ちパターン") && stale.includes("返信方向"));
  t("古い判断には警告が付く", stale.includes("最新のお客様の発言より前の分析"));

  const mismatch = buildBrainStrategyNote(META, { fresh: true, otherActionLabel: "物件ピックアップした", actionLabel: "物件オススメ" });
  t("別アクション推奨時の警告が出る", mismatch.includes("Brainは別アクション（物件ピックアップした）"));

  t("meta が無ければ空", buildBrainStrategyNote(null, { fresh: true }) === "");
  t("煽り禁止が立つ", buildBrainStrategyNote({ ...META, urgency_appropriate: false }, { fresh: true }).includes("使用禁止"));
  t("禁止話題はそのまま渡る", buildBrainStrategyNote({ ...META, avoid_topics: ["他社の話"] }, { fresh: true }).includes("禁止話題"));
  t("NG 物件が渡る", buildBrainStrategyNote(META, { fresh: true, ngPropertyLabels: ["A 101号室"] }).includes("再提案禁止物件"));
}

console.log("── 監査の1行");
{
  t("落とした物が分かる",
    describeBrainStrategyNote({ repeated_concern: "契約（引き落と" }, { fresh: false }).includes("truncated"),
    describeBrainStrategyNote({ repeated_concern: "契約（引き落と" }, { fresh: false }));
  t("brain が無い時", describeBrainStrategyNote(null, { fresh: true }) === "brain=none");
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
