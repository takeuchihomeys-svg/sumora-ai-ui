// RAG ごとの精度の物差し（2026-11-15 作業員H・土台②）
// 実行: npx tsx scripts/lib/__tests__/rag-precision.test.ts
import { familyOfExample, usableNeighbors, majorityFamily, scoreHeldOut, tallyRag, type HeldOut, type Neighbor } from "../rag-precision";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };

t("道: line_reply は返信・aix_action は系統", familyOfExample("line_reply", null) === "返信" && familyOfExample("aix_action", "viewing_invite") === "内覧" && familyOfExample("aix_action", "estimate_sheet") === "見積" && familyOfExample("aix_property", "property_send") === "物件");
// 実物の形（q428 の竹内さんの1通目）
const h: HeldOut = { key: "12496", scene: "返信:物件への反応", conversationId: "c1", at: "2026-11-08T08:37:34Z", truthFamily: "返信",
  takeuchiTexts: ["ご確認頂きありがとうございます😊！！ 周辺ですと現在こちらのお部屋のみになります！！ お気に召されましたら一度ご案内させて頂きます！！ 並行して新着で条件に合うお部屋が出次第お送りさせて頂きます！！"] };
const ns: Neighbor[] = [
  { id: "same", family: "返信", reply: "同じ会話の文", sim: 0.99, conversationId: "c1", at: "2026-11-01T00:00:00Z" },
  { id: "future", family: "返信", reply: "後の文", sim: 0.95, conversationId: "c2", at: "2026-11-10T00:00:00Z" },
  { id: "a", family: "内覧", reply: null, sim: 0.9, conversationId: "c3", at: "2026-11-01T00:00:00Z" },
  { id: "b", family: "返信", reply: "ご確認頂きありがとうございます😊！！ よろしければご都合よろしいお日にちにご案内させて頂きます！！", sim: 0.85, conversationId: "c4", at: "2026-11-02T00:00:00Z" },
  { id: "c", family: "返信", reply: "かしこまりました！！", sim: 0.8, conversationId: "c5", at: "2026-11-03T00:00:00Z" },
];
const u = usableNeighbors(h, ns);
t("同じ会話・その番より後の手本は外す", u.map((n) => n.id).join(",") === "a,b,c", u.map((n) => n.id));
t("多数の道", majorityFamily(u) === "返信");
const s = scoreHeldOut("返信＋AIX（近さ順）", h, ns);
t("1件目の道は外れ（内覧）・多数は当たり", s.top1Route === false && s.majRoute === true && s.got === 3);
t("骨は文のある一番近い手本（b）で数える・2通目は数えない", !!s.skeleton && s.skeleton.length > 0 && !s.skeleton.some((r) => r.el === "2通目"), s.skeleton);
const s2 = scoreHeldOut("返信の手本", h, ns, { routeAware: false });
t("道を数えない RAG は null", s2.top1Route === null && s2.majRoute === null);
const s3 = scoreHeldOut("AIX の手本", { ...h, truthFamily: "内覧", takeuchiTexts: [] }, ns);
t("AIX の番は骨を数えない", s3.skeleton === null && s3.top1Route === true);
const tl = tallyRag([s, s2, s3, scoreHeldOut("返信の手本", h, [])]);
const all = tl.find((x) => x.rag === "返信の手本" && x.scene === "全体");
t("足し算: 空の数・全体の行", !!all && all.n === 2 && all.empty === 1, all);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
// 連携①の読み（実物の digest の形）
import("../rag-precision").then(({ readingOf, readingMatch, rerankByReading }) => {
  const r1 = readingOf({ tc: "2:r1p1a0n0", ta: "[\"search_condition\", \"search_condition\"]", intent: "desire", emoF: "普通の依頼", fc: "promise_make:search|束:promise_make(6件・51%)" });
  const r2 = readingOf({ tc: "1:r0p0a1n0", ta: "[\"viewing_day:GrandPaseo south 302号室\"]", intent: "chat", emoF: "内覧したい", fc: "relation|束:close(30件・40%)" });
  const ok1 = !!r1 && r1.route === "promise" && r1.about.join() === "search_condition" && r1.focus === "promise_make" && r1.emo === "普通の依頼";
  const ok2 = !!r2 && r2.route === "aix" && r2.about.join() === "viewing_day" && r2.focus === "relation";
  const ok3 = readingMatch(r1, r1, "about") && !readingMatch(r1, r2, "route") && !readingMatch(r1, null, "intent");
  const ranked = rerankByReading([{ id: "x", family: "内覧", reply: null, sim: 0.82, conversationId: "c9", at: null, reading: r2 }, { id: "y", family: "返信", reply: "探す約束", sim: 0.8, conversationId: "c8", at: null, reading: r1 }], r1, ["route", "focus"]);
  const ok4 = ranked[0].id === "y" && Math.abs(ranked[0].sim - 0.9) < 1e-9;
  console.log(ok1 && ok2 && ok3 && ok4 ? "  OK  連携①: 読み・突き合わせ・加点の並べ替え" : `  NG  連携① ${JSON.stringify({ r1, r2, ok1, ok2, ok3, ok4 })}`);
  if (!(ok1 && ok2 && ok3 && ok4)) process.exit(1);
});
import("../rag-precision").then(({ tallyRag }) => {
  const base = { rag: "R", got: 1, top1Route: true, majRoute: true, skeleton: null, topSim: 0.8 };
  const tl = tallyRag([{ ...base, scene: "返信:条件提示" }, { ...base, scene: "重点:answer" }]);
  const all = tl.find((x) => x.scene === "全体"), f = tl.find((x) => x.scene === "重点:answer");
  const ok = !!all && all.n === 1 && !!f && f.n === 1;
  console.log(ok ? "  OK  重点の写しは全体に足さない" : "  NG  重点の写し");
  if (!ok) process.exit(1);
});
