// app/lib/__tests__/turn-contract.test.ts — この番の本質の仕様（実行: npx tsx app/lib/__tests__/turn-contract.test.ts）
//   実物は不一致 194番の読み込み（scratchpad r12/r13）から伏せて作った
import {
  buildTurnContract, renderTurnContractNote, normalizeBrainTurnContract, contractAllowsConfirmPromise,
  issueContradictsContract, auditDraftAgainstContract, turnContractEnabled, contractProtectsSentence, contractSkipsInsertion, reconcileTurnContractWithAix, isConfirmPromiseAsk,
} from "../turn-contract";
import { splitRequests } from "../request-ledger";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const NOW = "2026-10-08T10:00:00.000Z";

// ① #49 型: 「2階って虫入りますか？」＝一般的な事で答える（確認の約束にしない）
{
  const brain = { asks: [{ quote: "2階って虫入りますか？", kind: "question", route: "reply", answer: "入る可能性あり・7階以上がオススメ", basis: "general" }], lead_with: 0, close_only: false };
  const c = buildTurnContract({ brain, brainFresh: true, ledgerItems: splitRequests(["2階って虫入りますか？"], NOW), alreadySaid: [], settled: [] });
  t("#49 ブレインの答え方が勝つ（reply・一般）", c.source === "brain" && c.asks.length === 1 && c.asks[0].route === "reply", c.asks);
  t("#49 確認の約束は許さない", contractAllowsConfirmPromise(c, {}) === false);
  const note = renderTurnContractNote(c);
  t("#49 注記に★先に・答えの要点", note.includes("★先に") && note.includes("7階以上"), note);
  t("#49 出口: 確認の約束を書いた下書きは H4", auditDraftAgainstContract("かしこまりました！！管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", c, []).some((x) => x.startsWith("H4")));
}

// ② 一覧の項目はブレインが落とせない（#173: 「1LDKと2LDKも」→ブレインが1つだけ）
{
  const brain = { asks: [{ quote: "1LDKも探して", kind: "request", route: "promise", answer: "1LDKでピックアップ" }] };
  const ledger = splitRequests(["1LDKも探してください", "初期費用いくらになりますか？"], NOW);
  const c = buildTurnContract({ brain, brainFresh: true, ledgerItems: ledger, alreadySaid: [], settled: [] });
  t("ブレインに無い一覧の項目は残る（費用）", c.asks.some((a) => a.topic === "cost"), c.asks);
  t("同じ項目は二重にしない", c.asks.filter((a) => a.quote.includes("1LDK")).length === 1, c.asks);
  t("ピックアップの約束は確認の約束ではない（10/09 邪魔の型）", contractAllowsConfirmPromise(c, {}) === false);
  const cc = buildTurnContract({ brain: { asks: [{ quote: "駐車場空いてますか", route: "promise", answer: "管理会社に駐車場の空きを確認" }] }, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("確認の約束（管理会社に確認）は許す", contractAllowsConfirmPromise(cc, {}) === true);
}

// ③ 古い判断は使わない（ledger だけ＝予備）
{
  const c = buildTurnContract({ brain: { asks: [{ quote: "x", route: "aix" }] }, brainFresh: false, ledgerItems: splitRequests(["駐車場ありますか？"], NOW), alreadySaid: [], settled: [] });
  t("古い判断は source=ledger", c.source === "ledger");
  t("ledger では確認の約束の関門を判断しない（null）", contractAllowsConfirmPromise(c, {}) === null);
}

// ④ #174 待っての番（close_only）: 書き直しで要素を足させない
{
  const brain = { asks: [{ quote: "決まったら連絡してもいいですか？", kind: "question", route: "reply", answer: "お決まりになりましたらご連絡ください" }], close_only: true };
  const c = buildTurnContract({ brain, brainFresh: true, ledgerItems: [], alreadySaid: ["ピックアップ出来次第お送りさせて頂きます！！"], settled: [] });
  const note = renderTurnContractNote(c);
  t("#174 閉じる番の注記", note.includes("返事の要らない番") && note.includes("お決まりになりましたら"), note);
  t("#174 もう言った事が注記に", note.includes("もう言った事"));
  t("#174 WE_DO_MISSING の書き直しは見送る", issueContradictsContract({ code: "WE_DO_MISSING" }, c, {}) === true);
  t("#174 安全の指摘（NG_PROPERTY_MENTION）は見送らない", issueContradictsContract({ code: "NG_PROPERTY_MENTION" }, c, {}) === false);
  t("#174 TURN_CONTRACT_FINAL_CHECK=off で見送らない", issueContradictsContract({ code: "WE_DO_MISSING" }, c, { TURN_CONTRACT_FINAL_CHECK: "off" }) === false);
}

// ⑤ 出し切った（Q4）: 探す依頼は AIX 全力サポート
{
  const c = buildTurnContract({ brain: null, brainFresh: false, ledgerItems: splitRequests(["他にもお部屋探してほしいです"], NOW), alreadySaid: [], settled: [], facts: { exhausted: true } });
  t("出し切った番は pickup の依頼が aix/zenryoku_support", c.asks.some((a) => a.route === "aix" && a.aixKey === "zenryoku_support"), c.asks);
  t("注記に全力サポート", renderTurnContractNote(c).includes("AIX【全力サポート】"));
}

// ⑥ 最終チェック: 本質に約束が無いのに確認の約束を足させる指摘は見送る／AIX の項目への MISSED_QUESTION も
{
  const brain = { asks: [{ quote: "空室ありますか？こちら", kind: "question", route: "aix", aix: "property_check_result" }] };
  const c = buildTurnContract({ brain, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  // AIX の番は約束の一文で受けてよい（10/08 m151）＝確認の約束を足す指摘は見送らない
  t("AIX の項目がある時は確認の約束を足す指摘を見送らない", issueContradictsContract({ code: "RULE_VIOLATION", message: "「確認出来次第ご連絡」の次アクション文を追加すること" }, c, {}) === false);
  const cReply = buildTurnContract({ brain: { asks: [{ quote: "2階って虫入りますか", kind: "question", route: "reply", answer: "入る可能性あり" }] }, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("返信で答える項目だけの時は確認の約束を足させる RULE_VIOLATION を見送る", issueContradictsContract({ code: "RULE_VIOLATION", message: "「確認出来次第ご連絡」の次アクション文を追加すること" }, cReply, {}) === true);
  t("AIX の項目への MISSED_QUESTION は見送る", issueContradictsContract({ code: "MISSED_QUESTION", evidence: "空室ありますか？こちら" }, c, {}) === true);
}

// ⑦ 正規化: 型の外れた値・空は null
{
  t("空は null", normalizeBrainTurnContract({ asks: [] }) === null);
  const n = normalizeBrainTurnContract({ asks: [{ quote: "q", route: "weird", kind: "x", aix: "null" }], lead_with: "0", close_only: "true", must_not: ["見積書", ""] });
  t("route の外れは reply・aix の 'null' は null・lead_with 文字列も読む", !!n && n.asks![0].route === "reply" && n.asks![0].aix === null && n.lead_with === 0 && n.close_only === true && (n.must_not as string[]).length === 1, n);
}

// ⑧ 繰り返し（H1）
{
  const c = buildTurnContract({ brain: null, brainFresh: false, ledgerItems: [], alreadySaid: [], settled: [] });
  const prev = ["かしこまりました！！\n天満周辺全域から〇〇さんのご条件に合ったお部屋ピックアップしお送りさせて頂きます！！"];
  t("もう言った文を下書きが繰り返したら H1", auditDraftAgainstContract("はい！！\n天満周辺全域から〇〇さんのご条件に合ったお部屋ピックアップしお送りさせて頂きます！！", c, prev).some((x) => x.startsWith("H1")));
  t("締めの定型は H1 にしない", !auditDraftAgainstContract("何卒よろしくお願い致します😊！！", c, ["何卒よろしくお願い致します😊！！"]).some((x) => x.startsWith("H1")));
}

// ⑨ 刺さりの担当からの穴（10/08）: 内覧したい＝内覧日調整の AIX は確認の約束にしない・抑える／撮影の提案を段階の指摘で消させない
{
  const brain = { asks: [{ quote: "今週は無理なんですが見たいです", kind: "request", route: "aix", aix: "viewing_invite" }], proposals: ["お申込みでお部屋を抑える", "室内の撮影をしてお送り"] };
  const c = buildTurnContract({ brain, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("内覧日調整の AIX だけ → 確認の約束を許さない", contractAllowsConfirmPromise(c, {}) === false);
  t("提案が注記に（消さない）", renderTurnContractNote(c).includes("こちらから添える提案") && renderTurnContractNote(c).includes("抑える"));
  t("提案の文に付いた STAGE_MISMATCH は書き直さない", issueContradictsContract({ code: "STAGE_MISMATCH", evidence: "お申込みでお部屋を抑える事も可能です" }, c, {}) === true);
  t("提案の文に付いた PHOTO_NO_PREMISE は書き直さない", issueContradictsContract({ code: "PHOTO_NO_PREMISE", evidence: "室内撮影しお送りさせて頂きます" }, c, {}) === true);
  const ce = buildTurnContract({ brain: { asks: [{ quote: "見積もりください", route: "aix", aix: "estimate_sheet" }] }, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("見積の AIX → 「確認」の約束にはしない（作成の約束は別の注記・10/09 邪魔の型）", contractAllowsConfirmPromise(ce, {}) === false);
  const cpc = buildTurnContract({ brain: { asks: [{ quote: "空いてますか", route: "aix", aix: "property_check_result" }] }, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("物件確認の AIX → 確認の約束は許す", contractAllowsConfirmPromise(cpc, {}) === true);
}

// ⑩ 10/09 調査の担当（audit-brain-interference）の邪魔の型
{
  const c = buildTurnContract({ brain: { asks: [{ quote: "見積もりください", route: "promise", answer: "最大限割引の御見積書を作成しお送り" }] }, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("見積の約束の文は AIX の関所で消さない", contractProtectsSentence(c, "最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！", {}));
  t("金額の言い切りは守らない（安全の線）", !contractProtectsSentence(c, "初期費用は132,000円となります！！", {}));
  t("TURN_CONTRACT_PROTECT=off", !contractProtectsSentence(c, "最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！", { TURN_CONTRACT_PROTECT: "off" }));
  t("見積の約束がある時は ESTIMATE_NO_TRIGGER を書き直さない", issueContradictsContract({ code: "ESTIMATE_NO_TRIGGER" }, c, {}) === true);
  const close = buildTurnContract({ brain: { asks: [], close_only: true, must_not: ["初期費用の話"] }, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] });
  t("閉じる番は初期費用の一文を差し込まない", contractSkipsInsertion(close, "initial_cost", {}));
  t("ポータルを言わない指定が無ければポータルの説明は差し込む", !contractSkipsInsertion(close, "portal", {}));
  const rec = reconcileTurnContractWithAix({ asks: [{ quote: "見積もりください", route: "aix", aix: "estimate_sheet" }] }, null);
  t("最終の AIX が無い→ aix の項目は promise（見積の中身つき）", rec!.asks![0].route === "promise" && /見積/.test(String(rec!.asks![0].answer)), rec);
  t("見積の約束は確認の約束ではない", !isConfirmPromiseAsk({ route: "promise", aixKey: null, answer: "最大限割引の御見積書を作成しお送り", topic: "other" }));
  t("管理会社に確認の約束は確認の約束", isConfirmPromiseAsk({ route: "promise", aixKey: null, answer: "管理会社に確認", topic: "other" }));
}

t("TURN_CONTRACT=off", turnContractEnabled({ TURN_CONTRACT: "off" }) === false && turnContractEnabled({}) === true);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
