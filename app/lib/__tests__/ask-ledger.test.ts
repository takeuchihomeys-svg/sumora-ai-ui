// 要件の帳面（作業員M・2026-11-15・竹内さん「どの部分を返信で答え、どの部分を AIX で送るかを把握する」）
// 実行: npx tsx app/lib/__tests__/ask-ledger.test.ts
// 場面は本番の竹内さんの番の形（名前・物件名は伏せた）。asks は turn_contract.asks のまま
import { askLedgerMode, askIdOf, askKeyOf, matchPrevId, buildAskLedger, checkAskLedger, askLedgerFromMeta, askLedgerOf, annotateAsks, progressAfterSends, openAsksFrom, askLedgerAlert, asksOf, askProgressOn, nextAskProgress, askProgressOf, type AskEntry } from "../ask-ledger";
import { planMessages, type TwoMessagePlan } from "../two-message-plan";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

// スイッチ
t("既定 off", askLedgerMode({}) === "off" && askLedgerMode({ ASK_LEDGER: "x" }) === "off");
t("shadow / on", askLedgerMode({ ASK_LEDGER: "shadow" }) === "shadow" && askLedgerMode({ ASK_LEDGER: " ON " }) === "on");

// id: 同じ言葉＝同じ id・空白や句読点の違いは同じ・違う言葉は違う
t("id は同じ言葉で同じ", askIdOf("初期費用はいくらですか？") === askIdOf("初期費用は いくらですか"));
t("id は違う言葉で違う", askIdOf("初期費用はいくらですか") !== askIdOf("内覧したいです"));
t("id の形", /^q[0-9a-z]{7}$/.test(askIdOf("駐車場はありますか")), askIdOf("駐車場はありますか"));
t("正規化は句読点と空白を落とす", askKeyOf("「ペット、可能ですか？」") === "ペット可能ですか");
t("前の番の同じ要件の id を引き継ぐ", matchPrevId("ペット可能ですか？猫です", [{ id: "qprev001", quote: "ペット可能ですか" }]) === "qprev001");
t("違う要件は引き継がない", matchPrevId("駐車場ありますか", [{ id: "qprev001", quote: "ペット可能ですか" }]) === null);

// ① 返信だけの番（会社の事実で答える）＝1通目の返信
{
  const L = buildAskLedger({ asks: [{ quote: "審査は通りますか", route: "reply", about: "procedure", kind: "question" }] });
  t("① 返信1通: msg=1・slot=reply", L.items[0].msg === 1 && L.items[0].slot === "reply" && L.shape === "R", L);
  t("① 外れなし", L.check.ok && askLedgerAlert(L) === null);
  t("① 出所は作り直し", L.plan_from === "rebuilt");
}

// ② 約束の返信 → AIX（持ち込みの物件の募集状況＋見積書）＝RA(T)
{
  const asks = [
    { quote: "この物件まだ空いてますか", route: "promise", answer: "募集状況を確認しお送り", about: "vacancy", kind: "question" },
    { quote: "初期費用も知りたいです", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "request" },
  ];
  const L = buildAskLedger({ asks, finalAix: "estimate_sheet" });
  const [a, b] = L.items;
  t("② 約束は1通目の返信・later", a.msg === 1 && a.slot === "reply" && a.later === true, a);
  t("② 見積は2通目の AIX", b.msg === 2 && b.slot === "aix" && b.aix === "estimate_sheet", b);
  t("② 型 RAT", L.shape === "RAT", L.shape);
  t("② 約束の空きは取り違えにしない", L.check.ok, L.check);
  // 送った所まで: 返信だけ送った
  const p1 = progressAfterSends(L, [{ kind: "reply" }]);
  t("② 返信だけ送った→約束済み・見積は残り・次は AIX", p1.sentUpTo === 1 && p1.promised.includes(a.id) && p1.remaining.includes(b.id) && p1.next?.slot === "aix" && p1.next.answers.includes(b.id), p1);
  // AIX まで送った
  const p2 = progressAfterSends(L, [{ kind: "reply" }, { kind: "aix", aix: "estimate_sheet/with_appeal" }]);
  t("② AIX まで→見積は答えた・次はテンプレート", p2.answered.includes(b.id) && p2.remaining.length === 0 && p2.next?.slot === "aix_template", p2);
  // 次の番に渡す物: 約束の結果がまだ
  const open = openAsksFrom(L, p2);
  t("② 次の番へは約束だけ（promised）", open.length === 1 && open[0].id === a.id && open[0].state === "promised", open);
  // 計画と違う AIX を送った
  const p3 = progressAfterSends(L, [{ kind: "reply" }, { kind: "aix", aix: "property_check_result" }]);
  t("② 違う AIX → offPlan で止める（推し直さない）", !!p3.offPlan && p3.next === null && p3.remaining.includes(b.id), p3);
}

// ③ AIX → 返信（見積書の AIX ＋ 審査の不安の質問）＝AR か ATR
{
  const asks = [
    { quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "request" },
    { quote: "夜職でも審査通りますか不安です", route: "reply", about: "procedure", kind: "concern" },
  ];
  const L = buildAskLedger({ asks, finalAix: "estimate_sheet" });
  t("③ AIX が1通目・質問は後ろの返信", L.items[0].msg === 1 && L.items[0].slot === "aix" && L.items[1].slot === "reply" && (L.items[1].msg ?? 0) > 1, L.items);
  t("③ 型 ATR", L.shape === "ATR", L.shape);
  const p = progressAfterSends(L, [{ kind: "aix", aix: "estimate_sheet" }]);
  t("③ AIX の後: 質問は残り・次の通はテンプレート", p.remaining.includes(L.items[1].id) && p.next?.slot === "aix_template", p);
  // テンプレートを飛ばして返信を送った（竹内さんの AR）
  const p2 = progressAfterSends(L, [{ kind: "aix", aix: "estimate_sheet" }, { kind: "reply" }]);
  t("③ AR で送った: 手打ちの返信は返信の席（テンプレートは飛ばす）＝質問は答えた", p2.answered.includes(L.items[1].id) && p2.remaining.length === 0, p2);
  const p2t = progressAfterSends(L, [{ kind: "aix", aix: "estimate_sheet" }, { kind: "reply", template: true }]);
  t("③ テンプレートの印の送信はテンプレートの席＝質問は残り・次は返信", p2t.remaining.includes(L.items[1].id) && p2t.next?.slot === "reply", p2t);
  const p3 = progressAfterSends(L, [{ kind: "aix", aix: "estimate_sheet" }, { kind: "reply", template: true }, { kind: "reply" }]);
  t("③ 3通送った: 全部答えた", p3.remaining.length === 0 && p3.next === null && !p3.offPlan, p3);
}

// ④ 文を書く AIX（内覧調整）は質問も AIX の文の中＝1通
{
  const L = buildAskLedger({ asks: [
    { quote: "土曜に内覧したいです", route: "aix", aix: "viewing_invite", about: "viewing_day", kind: "request" },
    { quote: "駐車場ありますか", route: "reply", about: "viewing_day", kind: "question" },
  ], finalAix: "viewing_invite" });
  t("④ 1通: 両方とも1通目の AIX", L.count === 1 && L.items.every((e) => e.msg === 1 && e.slot === "aix"), L.items);
  t("④ 外れなし", L.check.ok, L.check);
}

// ⑤ 取りこぼし: AIX の番なのに AIX が決まっていない（aix が null・最終の AIX も無し）
{
  const L = buildAskLedger({ asks: [
    { quote: "写真送ってもらえますか", route: "aix", aix: null, about: "property_equipment", kind: "request" },
    { quote: "ありがとうございます", route: "none", kind: "feeling" },
  ] });
  t("⑤ 取りこぼし dropped", L.check.dropped.length === 1 && L.check.dropped[0] === L.items[0].id, L.check);
  t("⑤ none は数えない", L.items[1].msg === null && !L.check.dropped.includes(L.items[1].id));
  t("⑤ 知らせの1行", (askLedgerAlert(L) ?? "").includes("取りこぼし"));
  t("⑤ digest に d1", L.digest.endsWith("|d1"), L.digest);
}

// ⑥ 取り違え: 空き・募集状況を返信で答える
{
  const L = buildAskLedger({ asks: [{ quote: "まだ募集してますか", route: "reply", about: "vacancy", kind: "question" }] });
  t("⑥ 一般の見込み（埋まる可能性）は除く（q072）", buildAskLedger({ asks: [{ quote: "今見ている物件は埋まる可能性が高いですか", route: "reply", about: "vacancy", kind: "question" }] }).check.ok);
  t("⑥ 取り違え misrouted（空きを返信）", L.check.misrouted.length === 1, L.check);
}

// ⑦ 重ね・AIX の番を返信で（統括が置いた組み立て＝meta.two_message_plan に返信と AIX の両方が同じ要件を載せた）
{
  const asks = [{ quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet", kind: "request" }];
  const plan: TwoMessagePlan = { order: "reply_first", count: 2, shape: "RA", shapeWhy: "", why: "",
    messages: [
      { no: 1, slot: "reply", aix: null, answers: ["見積もりお願いします"], role: "", duties: ["answer"] },
      { no: 2, slot: "aix", aix: "estimate_sheet", answers: ["見積もりお願いします"], role: "", duties: ["answer"] },
    ] };
  const L = buildAskLedger({ asks, plan });
  t("⑦ 重ね doubled", L.check.doubled.length === 1 && L.items[0].alsoMsg?.[0] === 2, L.check);
  t("⑦ AIX の番を返信の通で＝取り違え", L.check.misrouted.length === 1, L.check);
  t("⑦ 出所は meta", L.plan_from === "meta");
}
// 同じ側の2通（AIX → テンプレート）は重ねにしない
{
  const plan: TwoMessagePlan = { order: "aix_first", count: 2, shape: "AT", shapeWhy: "", why: "",
    messages: [
      { no: 1, slot: "aix", aix: "estimate_sheet", answers: ["見積もりお願いします"], role: "", duties: [] },
      { no: 2, slot: "aix_template", aix: "estimate_sheet", answers: ["見積もりお願いします"], role: "", duties: [] },
    ] };
  const L = buildAskLedger({ asks: [{ quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet" }], plan });
  t("AIX→テンプレートの同じ要件は重ねにしない", L.check.ok, L.check);
}

// AIX の要件が2種類（見積書＋内覧調整）＝組み立ては AIX を1つしか持たない → 2つ目は取りこぼし
{
  const L = buildAskLedger({ asks: [
    { quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet", kind: "request" },
    { quote: "週末内覧できますか", route: "aix", aix: "viewing_invite", kind: "request" },
  ], finalAix: "estimate_sheet" });
  t("AIX 2種類: 2つ目の AIX は取りこぼし", L.check.dropped.length === 1 && L.check.dropped[0] === L.items[1].id && L.check.misrouted.length === 0, L.check);
}
// 要件の AIX と最終の AIX（押される AIX）が違う → 取り違え
{
  const L = buildAskLedger({ asks: [{ quote: "まだ空いてますか", route: "aix", aix: "property_check_result", kind: "question" }], finalAix: "estimate_sheet/with_appeal" });
  t("要件の AIX ≠ 最終の AIX＝取り違え", L.check.misrouted.length === 1 && L.final_aix === "estimate_sheet", L.check);
}

// 同じ言葉の要件が2つ → id を分ける
{
  const L = buildAskLedger({ asks: [{ quote: "はい", route: "none" }, { quote: "はい", route: "none" }] });
  t("同じ言葉の2つ目は _2", L.items[0].id !== L.items[1].id && L.items[1].id.endsWith("_2"), L.items.map((e) => e.id));
}

// 前の番の帳面から id を引き継ぐ（次の番が同じ id で読む）
{
  const prev = buildAskLedger({ asks: [{ quote: "この物件まだ空いてますか", route: "promise", about: "vacancy" }] });
  const now = buildAskLedger({ asks: [{ quote: "この物件まだ空いてますか？確認まだですか", route: "promise", about: "vacancy" }], prev: prev.items });
  t("引き継ぎ: 同じ id・carried", now.items[0].id === prev.items[0].id && now.items[0].carried === true, now.items[0]);
}

// meta から作る・読む・書き足す
{
  const meta: Record<string, unknown> = {
    action: "estimate_sheet", analyzed_msg_ts: "2026-11-15T03:00:00Z",
    turn_contract: { asks: [{ quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet", kind: "request" }, { quote: "", route: "reply" }, null] },
  };
  const L = askLedgerFromMeta(meta)!;
  t("meta から: 壊れた行は落とす", L.items.length === 1 && L.seen_customer_at === "2026-11-15T03:00:00Z", L);
  t("auto_reply の番でも要件の aix で AIX の通を組む（組み立てと同じ）", askLedgerFromMeta({ ...meta, reply_mode: "auto_reply" })!.items[0].slot === "aix");
  t("asks が無い番は null", askLedgerFromMeta({ action: "x" }) === null && askLedgerFromMeta(null) === null);
  const saved = JSON.parse(JSON.stringify({ ask_ledger: L }));
  t("保存した帳面を読み戻す", askLedgerOf(saved)?.items[0].id === L.items[0].id && askLedgerOf({ ask_ledger: { v: 2 } }) === null);
  const raw = (meta.turn_contract as { asks: Array<Record<string, unknown>> }).asks;
  const ann = annotateAsks(raw.filter(Boolean) as Array<Record<string, unknown>>, L);
  t("asks に id と msg を書き足す（元は変えない）", ann[0].id === L.items[0].id && ann[0].msg === 1 && !("id" in raw[0]) && !("id" in ann[1]), ann);
  // 統括が置いた組み立てを使う（同じ番号）
  const plan = planMessages({ asks: asksOf(raw), finalAix: "estimate_sheet" });
  const L2 = askLedgerFromMeta({ ...meta, two_message_plan: { ...plan, seen_customer_at: null } })!;
  t("meta.two_message_plan があればそれを使う", L2.plan_from === "meta" && L2.items[0].msg === L.items[0].msg);
}

// checkAskLedger 単体（組み立てなし）
{
  const items: AskEntry[] = [{ id: "q1", quote: "a", kind: null, route: "reply", aix: null, about: null, basis: null, msg: null, slot: null, later: false }];
  t("単体: 行き先ありで通なし＝取りこぼし", checkAskLedger(items).dropped[0] === "q1");
}

// 送り済み・残りの書き戻し（ASK_PROGRESS）
{
  t("ASK_PROGRESS 既定 off", askProgressOn({}) === false && askProgressOn({ ASK_PROGRESS: "on" }) === true);
  const L = buildAskLedger({ asks: [
    { quote: "この物件まだ空いてますか", route: "promise", about: "vacancy", kind: "question" },
    { quote: "初期費用も知りたいです", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "request" },
  ], finalAix: "estimate_sheet", seenCustomerAt: "2026-11-15T01:00:00Z" });
  const r1 = nextAskProgress(L, null, { kind: "reply" }, "2026-11-15T01:01:00Z")!;
  t("1通目: 約束済み・次は AIX", r1.sends.length === 1 && r1.promised.length === 1 && r1.next?.slot === "aix", r1);
  const r2 = nextAskProgress(L, JSON.parse(JSON.stringify(r1)), { kind: "aix", aix: "estimate_sheet" }, "2026-11-15T01:02:00Z")!;
  t("2通目: 前の記録に足す・見積は答えた", r2.sends.length === 2 && r2.answered.length === 1 && r2.remaining.length === 0, r2);
  const L2 = { ...L, seen_customer_at: "2026-11-15T05:00:00Z" };
  const r3 = nextAskProgress(L2, r2, { kind: "reply" }, "2026-11-15T05:01:00Z")!;
  t("新しいお客様の発言の後は数え直し", r3.sends.length === 1);
  t("読む側: 今の帳面の続きだけ", askProgressOf(L, r2) !== null && askProgressOf(L2, r2) === null && askProgressOf(L, { v: 2 }) === null);
  t("帳面が無ければ書かない", nextAskProgress(null, null, { kind: "reply" }, "x") === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
