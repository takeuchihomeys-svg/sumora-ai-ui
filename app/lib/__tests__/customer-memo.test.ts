// 2026-10-08 お客様のメモ（customer-memo.ts）と気持ちの流れ（customer-mood-flow.ts）
// 実行: npx tsx app/lib/__tests__/customer-memo.test.ts
// 文は実物（11巡目の不一致 194番・scripts/audit-customer-mood-flow.ts で読んだ物・名前と物件名は伏せた）
import {
  toldKindsOf, summarizeTold, applyMemoOps, memoLlmMessages, resolveOpSources, liveItems, parseMemoLlmOutput, buildCustomerMemoNote, buildMemoLlmUser, memoViewRows, toldRuleId,
  EMPTY_MEMO, type StoredMemo,
} from "../customer-memo";
import { customerBursts, resolveMoodFlow, buildMoodFlowNote, proposalKindOf, moodSignals } from "../customer-mood-flow";


let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 200))} to contain ${JSON.stringify(sub)}`); }
function not(s: string, sub: string) { if (s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 200))} NOT to contain ${JSON.stringify(sub)}`); }
const iso = (s: string) => new Date(Date.parse(`${s}+09:00`)).toISOString();
let seq = 0; const newId = () => `l-${++seq}`;
const NOW = Date.parse("2026-10-08T12:00:00+09:00");

console.log("もう伝えた事の種類（竹内さんの文の型）");
it("初回の挨拶＝名乗り", () => eq(toldKindsOf("はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！").includes("intro"), true));
it("全て送った＋新着待ち", () => eq(toldKindsOf("現在募集中のご条件に近いお部屋は全てピックアップさせて頂きました！！\n引き続き新着で出次第お送りさせて頂きます！！").sort(), ["all_sent", "new_arrival"]));
it("内覧の誘い", () => eq(toldKindsOf("〇〇さんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！").includes("viewing_invite"), true));
it("申込で抑える", () => eq(toldKindsOf("お気に召されましたらお申込みしお部屋抑えさせていただきます！！").includes("apply_invite"), true));
it("確認の約束", () => eq(toldKindsOf("お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！"), ["check_promise"]));
it("締めの定型だけは数えない", () => eq(toldKindsOf("はい😊！！何卒よろしくお願い致します！！お気軽にご連絡ください"), []));
it("🌟カードの箇条（・家賃…）は誘いに数えない", () => eq(toldKindsOf("🌟〇〇マンション 105\n・ご内覧可能"), []));
it("回数と最後の日", () => {
  const t = summarizeTold([
    { sender: "staff", text: "お部屋ご案内させて頂きます", createdAt: iso("2026-10-01T10:00:00") },
    { sender: "customer", text: "はい", createdAt: iso("2026-10-01T11:00:00") },
    { sender: "staff", text: "ご内覧頂けます", createdAt: iso("2026-10-05T10:00:00"), isAix: true },
  ]);
  eq(t[0].kind, "viewing_invite"); eq(t[0].count, 2); eq(t[0].byAix, true); eq(t[0].lastAt, iso("2026-10-05T10:00:00"));
});

console.log("差分の ops（DeepSeek・スタッフ）");
it("追加・同じ中身は重ねない", () => {
  const r1 = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "concern", text: "審査が不安（カードブラック）", quote: "カードブラックなので厳しいかと", at: iso("2026-10-04T19:27:00") }], { origin: "llm", nowIso: iso("2026-10-08T12:00:00"), newId });
  eq(r1.applied, 1);
  const r2 = applyMemoOps(r1.memo, [{ op: "add", kind: "concern", text: "審査が不安（カードブラック）" }], { origin: "llm", nowIso: iso("2026-10-08T12:01:00"), newId });
  eq(r2.applied, 0); eq(r2.memo.items.length, 1);
});
it("スタッフが直した行は DeepSeek が書き換え・外せない", () => {
  const a = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "people", text: "新生児と2人暮らし" }], { origin: "staff", nowIso: iso("2026-10-08T12:00:00"), newId: () => "s-1" });
  eq(a.memo.items[0].locked, true);
  const b = applyMemoOps(a.memo, [{ op: "retire", id: "s-1", reason: "x" }, { op: "update", id: "s-1", text: "一人暮らし" }], { origin: "llm", nowIso: iso("2026-10-08T12:01:00"), newId });
  eq(b.refused, 2); eq(liveItems(b.memo, NOW)[0].text, "新生児と2人暮らし");
});
it("外した行は消さず印（retiredAt）", () => {
  const a = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "ng", text: "神崎川は不便" }], { origin: "llm", nowIso: iso("2026-10-08T12:00:00"), newId: () => "l-x" });
  const b = applyMemoOps(a.memo, [{ op: "retire", id: "l-x", reason: "条件を言い直した" }], { origin: "llm", nowIso: iso("2026-10-08T12:01:00"), newId });
  eq(b.memo.items.length, 1); eq(!!b.memo.items[0].retiredAt, true); eq(liveItems(b.memo, NOW).length, 0);
});
it("古くなる日（ttl）を過ぎたら効かない", () => {
  const a = applyMemoOps(EMPTY_MEMO, [{ op: "add", kind: "circumstance", text: "今週は仕事が忙しい", at: iso("2026-09-20T10:00:00"), ttlDays: 7 }], { origin: "llm", nowIso: iso("2026-09-20T10:00:00"), newId });
  eq(liveItems(a.memo, NOW).length, 0);
});
it("DeepSeek の返事を読む（崩れ・種類の外れは落とす）", () => {
  eq(parseMemoLlmOutput("前置き {\"ops\":[{\"op\":\"add\",\"kind\":\"core\",\"text\":\"ペット可は絶対\"},{\"op\":\"add\",\"kind\":\"xxx\",\"text\":\"a\"},{\"op\":\"retire\",\"id\":\"l-1\",\"reason\":\"解決\"}]}")?.length, 2);
  eq(parseMemoLlmOutput("JSON ではない"), null);
  eq(parseMemoLlmOutput("{\"ops\":[]}"), []);
});

console.log("根拠の線（dry-run で直した形）");
it("番号から時刻・送り手を引く／種類と送り手が合わない・言葉が無い op は落とす", () => {
  const msgs = [
    { sender: "staff", text: "🌟日宝メゾン・ド・ショウ 405 敷金礼金なし", createdAt: iso("2026-08-22T11:31:00") },
    { sender: "customer", text: "上記2軒が気になっているのですが", createdAt: iso("2026-08-23T10:00:00") },
  ];
  const r = resolveOpSources([
    { op: "add", kind: "like", text: "日宝メゾン405を提案", n: 1, quote: "日宝メゾン・ド・ショウ 405" },
    { op: "add", kind: "like", text: "2軒が気になる", n: 2, quote: "上記2軒が気になっている" },
    { op: "add", kind: "concern", text: "審査が不安", n: 2, quote: "審査が不安です" },
    { op: "add", kind: "core", text: "番号なし", quote: "x" },
  ], msgs);
  eq(r.ops.length, 1); eq((r.ops[0] as { at?: string }).at, iso("2026-08-23T10:00:00")); eq(r.dropped.map((d) => d.why.slice(0, 6)), ["種類と送り手", "根拠の言葉が", "根拠の番号な"]);
});
it("DeepSeek の返事の n（数字・#3 の文字）を読む", () => eq((parseMemoLlmOutput("{\"ops\":[{\"op\":\"add\",\"kind\":\"core\",\"text\":\"a\",\"n\":\"#3\"}]}")![0] as { n?: number }).n, 3));

it("dry-run で直した誤りの型（実物を伏せた）は落とす", () => {
  const msgs = [
    { sender: "customer", text: "吹田までだと思っています", createdAt: iso("2026-09-01T10:00:00") },
    { sender: "customer", text: "小型犬だけなんですか、", createdAt: iso("2026-09-01T10:01:00") },
    { sender: "customer", text: "初期費用156980円となります！！", createdAt: iso("2026-09-01T10:02:00") },
    { sender: "customer", text: "今回はお客様で契約を進めることになりました", createdAt: iso("2026-09-01T10:03:00") },
    { sender: "staff", text: "アーバネックスはオーナー回答待ちで、交渉でき次第ご連絡させて頂きます", createdAt: iso("2026-09-01T10:04:00") },
    { sender: "customer", text: "家賃は共益費込みでの値段なので", createdAt: iso("2026-09-01T10:05:00") },
  ];
  const r = resolveOpSources([
    { op: "add", kind: "ng", text: "桃山台は吹田外のため見送り", n: 1, quote: "吹田までだと思っています" },
    { op: "add", kind: "core", text: "小型犬のみ可の部屋を希望", n: 2, quote: "小型犬だけなんですか" },
    { op: "add", kind: "core", text: "初期費用15万6980円の部屋", n: 3, quote: "初期費用156980円となります" },
    { op: "add", kind: "ng", text: "今回はお客様で契約を進めることになり見送り", n: 4, quote: "今回はお客様で契約を進める" },
    { op: "add", kind: "told", text: "アーバネックスはオーナー回答待ち、交渉次第連絡と伝えた", n: 5, quote: "オーナー回答待ちで" },
    { op: "add", kind: "core", text: "家賃5〜6万円（共益費込み）", n: 6, quote: "家賃は共益費込みでの値段なので" },
  ], msgs);
  eq(r.ops.length, 0);
});

console.log("ブレインへの注記");
const memo: StoredMemo = applyMemoOps(EMPTY_MEMO, [
  { op: "add", kind: "concern", text: "審査が不安（カードブラック）", quote: "厳しいかと", at: iso("2026-10-04T19:27:00") },
  { op: "add", kind: "like", text: "〇〇マンション401が良い", at: iso("2026-10-05T10:00:00") },
  { op: "add", kind: "core", text: "ペット可は絶対", at: iso("2026-10-01T10:00:00") },
], { origin: "llm", nowIso: iso("2026-10-06T10:00:00"), newId }).memo;
const told = summarizeTold([{ sender: "staff", text: "お部屋ご案内させて頂きます", createdAt: iso("2026-10-06T10:00:00") }]);
it("場面で要る種類だけ（費用の場面に「好き」は出さない）", () => {
  const n = buildCustomerMemoNote({ memo, told, scene: "cost", nowMs: NOW });
  has(n, "気にしている事: 審査が不安"); has(n, "条件の芯: ペット可は絶対"); not(n, "401が良い"); has(n, "内覧の誘い 10/6");
});
it("もう伝えた事は種類の名前だけ（本文を引用しない）", () => not(buildCustomerMemoNote({ memo, told, scene: "ack", nowMs: NOW }), "ご案内させて頂きます"));
it("スタッフが外した「もう伝えた」は出さない", () => not(buildCustomerMemoNote({ memo: { ...memo, hiddenRuleIds: [toldRuleId("viewing_invite")] }, told, scene: "ack", nowMs: NOW }), "内覧の誘い"));
it("何も無ければ空", () => eq(buildCustomerMemoNote({ memo: EMPTY_MEMO, told: [], scene: "ack", nowMs: NOW }), ""));
it("画面の行（出所つき・もう伝えたも id 付き）", () => {
  const rows = memoViewRows({ memo, told, nowMs: NOW });
  eq(rows.some((r) => r.id === "told:viewing_invite" && r.origin === "rule"), true);
  has(rows.find((r) => r.kind === "concern")!.source, "10/4");
});
it("DeepSeek に渡す材料: 今のメモ＋新しい通（時刻つき）", () => {
  const u = buildMemoLlmUser({ memo, nowMs: NOW, msgs: [{ sender: "customer", text: "2LDKも知りたいです", createdAt: iso("2026-10-08T11:00:00") }] });
  has(u, "concern | 審査が不安"); has(u, "客 10-08 11:00");
});
it("DeepSeek に書類・個人の値・URL・書き起こしを渡さない", () => {
  const m = memoLlmMessages([
    { sender: "customer", text: "申込者様記入欄\n氏名 山田太郎\n携帯番号 090-1234-5678", createdAt: iso("2026-10-08T10:00:00") },
    { sender: "customer", text: "[画像] 【物件の画面（ポータル）】 〇〇マンション 家賃8万", createdAt: iso("2026-10-08T10:01:00") },
    { sender: "customer", text: "https://suumo.jp/chintai/xxx ここはどうですか？", createdAt: iso("2026-10-08T10:02:00") },
  ], ["山田"]);
  eq(m.length, 2); eq(m[0].text, "[画像]"); has(m[1].text!, "[URL]"); not(m[1].text!, "suumo");
});

console.log("気持ちの流れ");
it("提案の種類", () => { eq(proposalKindOf("お部屋ご案内させて頂きます"), "内覧"); eq(proposalKindOf("🌟〇〇 105"), "物件"); eq(proposalKindOf("御見積書となります"), "見積"); });
it("迷い（実物: 長居の方と悩んでいるので検討）", () => eq(moodSignals(["ありがとうございます。\n長居の方と悩んでいるので検討させていただきます。"]).hesitation != null, true));
it("離れかけ（実物: 内覧はやはりキャンセル）", () => eq(resolveMoodFlow([
  { sender: "staff", text: "お部屋ご案内させて頂きます", createdAt: iso("2026-09-10T20:00:00") },
  { sender: "customer", text: "こちらの内覧はやはりキャンセルでお願いします", createdAt: iso("2026-09-11T23:12:00") },
])!.hint, "離れかけ"));
it("いつもより遅く・短く（URL の持ち込みは長さを見ない）", () => {
  const base = [] as Array<{ sender: string; text: string; createdAt: string }>;
  for (let d = 1; d <= 3; d++) {
    base.push({ sender: "staff", text: "ご確認ください", createdAt: iso(`2026-10-0${d}T10:00:00`) });
    base.push({ sender: "customer", text: "ありがとうございます！とても良いと思います！他にも駅近のお部屋があれば見てみたいです！よろしくお願いします！", createdAt: iso(`2026-10-0${d}T10:05:00`) });
  }
  const f = resolveMoodFlow([...base, { sender: "staff", text: "お部屋ご案内させて頂きます", createdAt: iso("2026-10-05T10:00:00") }, { sender: "customer", text: "了解です", createdAt: iso("2026-10-06T10:00:00") }])!;
  eq(f.changes.some((c) => c.startsWith("返事が遅くなった")), true); eq(f.changes.some((c) => c.startsWith("文が短くなった")), true);
  eq(f.reaction?.to, "内覧"); eq(f.hint, "淡々");
  const g = resolveMoodFlow([...base, { sender: "staff", text: "x", createdAt: iso("2026-10-05T10:00:00") }, { sender: "customer", text: "https://suumo.jp/x ここは？", createdAt: iso("2026-10-05T10:06:00") }])!;
  eq(g.changes.some((c) => c.startsWith("文が短くなった")), false);
});
it("返事なしで日をまたいで追った後", () => {
  const f = resolveMoodFlow([
    { sender: "customer", text: "よろしくお願いします", createdAt: iso("2026-10-01T10:00:00") },
    { sender: "staff", text: "🌟〇〇 105", createdAt: iso("2026-10-02T10:00:00"), isAix: true },
    { sender: "staff", text: "🌟△△ 201", createdAt: iso("2026-10-04T10:00:00"), isAix: true },
    { sender: "customer", text: "ありがとうございます確認します", createdAt: iso("2026-10-06T10:00:00") },
  ])!;
  has(f.changes.join(), "2日に分けて送った後");
});
it("束: 間にこちらが無ければ1つ", () => eq(customerBursts([
  { sender: "customer", text: "a", createdAt: iso("2026-10-01T10:00:00") }, { sender: "customer", text: "b", createdAt: iso("2026-10-01T10:01:00") },
  { sender: "staff", text: "c", createdAt: iso("2026-10-01T10:02:00") }, { sender: "customer", text: "d", createdAt: iso("2026-10-01T10:03:00") },
]).length, 2));
it("注記: 変化も言葉も無ければ出さない／あれば前回までの気持ちと出す", () => {
  const plain = resolveMoodFlow([{ sender: "customer", text: "了解です", createdAt: iso("2026-10-01T10:00:00") }]);
  eq(buildMoodFlowNote(plain, { prevEmotions: ["前向き"] }), "");
  const n = buildMoodFlowNote(resolveMoodFlow([{ sender: "staff", text: "お部屋ご案内させて頂きます", createdAt: iso("2026-10-01T09:00:00") }, { sender: "customer", text: "一度考えさせてください🙇", createdAt: iso("2026-10-01T10:00:00") }]), { prevEmotions: ["前向き", "前向き"] });
  has(n, "迷い「一度考えさせてください"); has(n, "前回までの気持ち"); has(n, "前のこちらの提案（内覧）への反応: 迷い");
});
it("！・絵文字が無くなったは出さない（実データで下向きの印にならない）", () => {
  const base = [] as Array<{ sender: string; text: string; createdAt: string }>;
  for (let d = 1; d <= 3; d++) { base.push({ sender: "staff", text: "x", createdAt: iso(`2026-10-0${d}T10:00:00`) }); base.push({ sender: "customer", text: "ありがとうございます😊！", createdAt: iso(`2026-10-0${d}T10:05:00`) }); }
  const f = resolveMoodFlow([...base, { sender: "staff", text: "x", createdAt: iso("2026-10-05T10:00:00") }, { sender: "customer", text: "ありがとうございます", createdAt: iso("2026-10-05T10:04:00") }])!;
  eq(f.changes.some((c) => c.includes("絵文字が無くなった")), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
