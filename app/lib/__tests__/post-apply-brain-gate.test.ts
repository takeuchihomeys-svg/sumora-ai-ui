// app/lib/__tests__/post-apply-brain-gate.test.ts — 申込中・審査中はブレインを否決・取り消し・クレームの時だけ回す（10/07 竹内さんの決定）
// 実行: npx tsx app/lib/__tests__/post-apply-brain-gate.test.ts  （文は本番の申込中のお客様の番・scripts/audit-post-apply-brain-gate.ts）
import { decidePostApplyBrainGate, latestCustomerTurnText, postApplyAnchorAt, type GateMsg } from "../post-apply-brain-gate";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };
let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 0, n++)).toISOString();
const c = (text: string): GateMsg => ({ sender: "customer", text, created_at: at() });
const s = (text: string): GateMsg => ({ sender: "staff", text, created_at: at() });
const PUSH = "2026-09-30T00:00:00.000Z";
const gate = (msgs: GateMsg[], status = "applying", env: Record<string, string> = {}) => decidePostApplyBrainGate({ status, msgs, applicationPushAt: PUSH, env });

// 回す（否決・取り消し・クレーム・迷い・別の物件）
for (const [name, txt] of [
  ["審査落ちの報告", "前の物件が審査落ちした為新たに物件を紹介してほしいです!!"],
  ["審査落ちたってことですかね？（結果の問い）", "月曜日連絡なかったんですけど、審査落ちたってことですかね？"],
  ["キャンセル", "キャンセルで！"],
  ["辞退", "ご連絡おそくなってすいません。\n少し考えたいので今回は辞退させていただきます。"],
  ["内覧のキャンセル", "では本日内覧予定だったのですがキャンセル目お願いします。"],
  ["保留", "こちらかなりいいですね、、、"],
  ["他の物件を探す", "承知致しました。\n\n他の物件を探しますので引き続き宜しくお願い致します。"],
  ["一旦考えて", "一旦考えて、また連絡します！"],
  ["考えた結果やはり高い", "沢山考えた結果やはり家賃が高すぎて…もう少し安く初期費用がこの位の家は見つからないでしょうか"],
  ["違う不動産会社", "もうオンライン内見さっき違う不動産会社にしてもらいました😂"],
  ["クレーム（おかしい）", "うん？？\nなんか自分でおかしい事言うてるん、わかってないんですか？"],
  ["解約（こちらの契約）", "申込したところ解約したいです"],
] as const) {
  const msgs = name === "保留" ? [s("ご査収くださいませ"), c(txt), c("いったん保留で！")] : [s("よろしくお願い致します！！"), c(txt)];
  const g = gate(msgs);
  t(`回す: ${name}`, g.run, g);
}
// 回さない（申込の手続き・書類・お礼）
for (const [name, txt] of [
  ["お礼", "ありがとうございます🙇‍♀️"],
  ["申込フォームの記入", "【お申込者様記入欄】\nフリガナ：ヤマダ タロウ"],
  ["本人確認書類の画像", "[画像] 本人確認書類"],
  ["手続きの質問", "初期費用の振込先はどちらになりますか？"],
  ["日程の了承", "了解しました🙇‍♀️\n14時半ぐらいでお願いいたします🙇‍♀️"],
  ["今の家の解約（手続き）", "今の家の解約があるので8月終わりぐらいがありがたいです。"],
  ["他の階（同じ物件）", "他の階は空きありますか？"],
] as const) {
  const g = gate([s("よろしくお願い致します！！"), c(txt)]);
  t(`回さない: ${name}`, !g.run, g);
}
// 否決の文脈（日数で切らない・申込へを押した後）
{
  const g = gate([s("大変申し訳ございません、審査否決となってしまいました"), c("わかりました"), s("別のお部屋お探しさせて頂きます！！"), c("ありがとうございます🙏🏻")]);
  t("否決を伝えた後はお礼でも回す（切り替えの期間）", g.run && g.reason === "after_staff_fail", g);
  const old = decidePostApplyBrainGate({ status: "screening", msgs: [{ sender: "staff", text: "審査否決となりました", created_at: "2026-09-01T00:00:00Z" }, c("ありがとうございます")], applicationPushAt: PUSH, env: {} });
  t("否決が申込へを押す前（前の申込）なら数えない", !old.run, old);
}
// 画像の読み取りの文では当てない
{
  const g = gate([s("よろしくお願い致します！！"), c("[画像] 重要事項説明書\n解約時の内容については、契約書に定める"), c("承知致しました")]);
  t("重要事項説明書の読み取りの「解約」では回さない", !g.run, g);
}
// 関門の外
t("提案中（申込前に戻した）は今まで通り回す", decidePostApplyBrainGate({ status: "proposing", msgs: [c("ありがとうございます")], env: {} }).run);
t("BRAIN_POST_APPLY_GATE=off で今まで通り回す", gate([c("ありがとうございます")], "applying", { BRAIN_POST_APPLY_GATE: "off" }).run);
t("審査中（screening）も関門に入る", !gate([c("ありがとうございます")], "screening").run);
// 2026-10-18 status が遅れている会話（記録では申込以降・status は提案中・内覧＝lagging）
{
  const lag = (msgs: GateMsg[], presses: Array<{ aix_type: string; created_at: string }> = [], env: Record<string, string> = {}) =>
    decidePostApplyBrainGate({ status: "proposing", lagging: true, msgs, presses, applicationPushAt: PUSH, env });
  t("遅れ: 申込の手続きの番は止める", !lag([s("代理契約のフォーマットです"), c("分かりました！確認して明日中に送ります！")]).run);
  t("遅れ: お礼だけは止める", !lag([s("お申込みさせていただきます！！"), c("お願い致します")]).run);
  t("遅れ: 申込へを押した後に「他のお部屋にしようかと」→ 後のお礼でも回す",
    lag([c("他のお部屋にしようかと思います🙇🙇"), s("かしこまりました！！"), c("物件また送っていただけるとありがたいです!!")]).reason.startsWith("after_customer_alert"));
  t("遅れ: 「同じ条件で他の場所探しても」は回す", lag([s("x"), c("同じ条件で他の場所探してもよろしいですか？")]).run);
  t("遅れ: 申込へを押した後にスタッフが物件確認を押した（2番手キャンセルの後の物件探し）→ 回す",
    lag([s("2番手お申込みがキャンセルとなっております"), c("15日いけますか？")], [{ aix_type: "property_check_result", created_at: "2026-10-01T00:00:00Z" }]).reason === "after_pre_apply_aix:property_check_result");
  t("遅れ: 申込へより前の物件確認は数えない",
    !lag([s("x"), c("お願いします")], [{ aix_type: "property_check_result", created_at: "2026-09-29T00:00:00Z" }]).run);
  t("遅れ: 申込中に押す AIX（電話）は数えない", !lag([s("x"), c("お願いします")], [{ aix_type: "phone_call", created_at: "2026-10-01T00:00:00Z" }]).run);
  t("遅れ: 今の番に物件の URL（最後ここだけ募集してるか）→ 回す", lag([s("x"), c("最後ここだけ募集してるか確認してもらうことはできますか？ https://suumo.jp/chintai/x")]).reason === "turn_url");
  t("遅れ: 否決を伝えた後は回す", lag([s("審査否決となってしまいました"), c("ありがとうございます")]).reason === "after_staff_fail");
  t("遅れ: BRAIN_POST_APPLY_GATE=off は回す", lag([s("x"), c("お願いします")], [], { BRAIN_POST_APPLY_GATE: "off" }).run);
  // 2026-10-18 確かめる人: 網の漏れ（本番 4f1df513・fb8ab8d5・f895b126）
  t("遅れ: 今の番に物件の資料の読み取り（部屋の切り替え）→ 回す",
    lag([s("x"), c("[画像] 【物件の資料】 物件名：アプリーレ松屋町 号室名：1405"), c("今月末に入居予定なので こちらに変更できますか？")]).reason.startsWith("turn_pre_apply"));
  t("遅れ: 今の番に「内覧」→ 回す", lag([s("x"), c("内覧などはできるんでしょうか？")]).reason === "turn_pre_apply:内覧");
  {
    const stale = (custAt: string, idDocumentAt: string | null = null) => decidePostApplyBrainGate({ status: "proposing", lagging: true,
      msgs: [{ sender: "staff", text: "フォーマットです", created_at: PUSH }, { sender: "customer", text: "また今から申し込みするのってできますか？", created_at: custAt }],
      applicationPushAt: PUSH, idDocumentAt, env: {} });
    t("遅れ: 申込へ押下だけで72時間より後に戻ってきた → 回す", stale("2026-10-04T00:00:01Z").reason === "push_stale");
    t("遅れ: 申込へ押下から72時間以内は止める", !stale("2026-10-02T00:00:00Z").run);
    t("遅れ: 押下の後に書類が届いていれば72時間を過ぎても止める", !stale("2026-10-10T00:00:00Z", "2026-10-02T00:00:00Z").run);
  }
  t("lagging でない提案中は今まで通り回す", decidePostApplyBrainGate({ status: "proposing", msgs: [c("お願いします")], env: {} }).reason === "not_post_apply");
  t("起点＝申込へ押下と書類の新しい方", postApplyAnchorAt("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z") === "2026-10-02T00:00:00Z"
    && postApplyAnchorAt(null, null) === null && postApplyAnchorAt("2026-10-03T00:00:00Z", "bad") === "2026-10-03T00:00:00Z");
}
t("今の番＝最後のお客様の連投（こちらが最後でも1つ前の連投）", latestCustomerTurnText([c("A"), s("x"), c("B"), c("C"), s("y")]).replace(/[\s⁣]/g, "") === "BC");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
