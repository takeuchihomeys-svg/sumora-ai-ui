// app/lib/__tests__/compose-checks.test.ts — 設計図の確かめの段の3つ（純関数・文は作り物）
import { composeCheckOn, assignAsks, coverageMisses, coverageRewriteNote, groundCheck, parseCustomerRead, customerReadRewriteNote, composeChecksDigest, askKeys } from "../compose-checks";
import { buildBlueprint, fallbackIntent } from "../compose-blueprint";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

t("既定 off・親のスイッチが要る", !composeCheckOn("ground", { COMPOSE_CHECK_GROUND: "on" }) && composeCheckOn("ground", { BRAIN_COMPOSE_BLUEPRINT: "on", COMPOSE_CHECK_GROUND: "on" }) && !composeCheckOn("reader", { BRAIN_COMPOSE_BLUEPRINT: "on", COMPOSE_CHECK_GROUND: "on" }));
t("語を拾う", askKeys("初期費用はいくらですか").includes("初期費用"));

const req = [{ rank: 1, item: "初期費用の御見積書を送ると約束する", handling: "confirm" }];
const bp = buildBlueprint({ intent: fallbackIntent(req), requirements: req });
const slots = assignAsks(["初期費用はいくらですか？", "あとペット飼えますか？"], bp, "2026-11-03T00:00:00Z");
t("質問を出して部品に割り当てる（ペットは割り当てなし）", slots.length === 2 && slots.find((s) => /初期費用/.test(s.quote))?.part != null && slots.find((s) => /ペット/.test(s.quote))?.part == null, slots);
const miss = coverageMisses("かしこまりました！！\n最大限割引しました初期費用の御見積書作成しお送りさせて頂きます！！\n何卒よろしくお願い致します！！", slots);
t("答え漏れ＝ペットだけ", miss.length === 1 && /ペット/.test(miss[0].quote), miss);
t("書き直しの注記", /答え漏れ/.test(coverageRewriteNote(miss)) && coverageRewriteNote([]) === "");

const g = groundCheck("YUMAさん11月20日の14時にご案内させて頂きます！！", "お客様: 内覧したいです", { DRAFT_FACT_GROUNDING_KINDS: "date,time" });
t("根拠の無い日付・時刻は統括へ返す形", !!g.sendBack && g.sendBack.kind === "no_ground" && g.sendBack.needs.length >= 1 && /根拠の無い事実の文/.test(g.sendBack.why), g.sendBack);
t("根拠があれば返さない", groundCheck("かしこまりました！！", "x").sendBack === null);

const r = parseCustomerRead('{"unclear":["確認して送ると言いつつ今送ると書いている"],"unanswered":[]}');
t("読み直しを読む", !!r && r.unclear.length === 1 && r.unanswered.length === 0, r);
t("読み直しの注記", /1回だけ書き直す/.test(customerReadRewriteNote(r)) && customerReadRewriteNote({ unclear: [], unanswered: [] }) === "");
t("壊れた JSON は null", parseCustomerRead("なし") === null);
t("digest", composeChecksDigest({ coverage: 1, ground: 2, sentBack: true, reader: r, rewrote: true }) === "compose-checks: 答え漏れ=1 根拠なし=2（統括へ返した） 読み直し=意味1・未回答0 書き直し=1回");

console.log(`compose-checks: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
import { worryCheck, mainPointMissed, composeCheckWorryOn } from "../compose-checks";
{
  const okOn = !composeCheckWorryOn({ COMPOSE_CHECK_WORRY: "on" }) && composeCheckWorryOn({ BRAIN_COMPOSE_BLUEPRINT: "on", COMPOSE_CHECK_WORRY: "on" });
  const w = worryCheck("かしこまりました！！\n募集状況確認させて頂きます！！", { mainPoint: "初期費用を抑えられる物件か", worries: ["screening", "cost"] });
  const ok = okOn && w.mainMissed && w.worryMissed.join() === "screening,cost" && /奥の心配（審査に通るか）/.test(w.note)
    && !mainPointMissed("初期費用の御見積書をお送りさせて頂きます", "初期費用の見積") && worryCheck("審査は独立系の保証会社で通過しやすいです", { worries: ["screening"] }).worryMissed.length === 0;
  console.log(ok ? "compose-check-worry: pass" : "compose-check-worry: FAIL", ok ? "" : JSON.stringify(w));
  if (!ok) process.exit(1);
}
