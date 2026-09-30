// 2026-09-30 竹内「内覧は1件なら1〜2時間の枠・件数で枠を増やす・予定の住所と移動時間も入れる・始まり11:00〜終了18:30・営業時間は伝えない」
// 実行: npx tsx app/lib/__tests__/viewing-slot-plan.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { planDaySlots, slotLengthFor, travelGapFor, travelTierBetween, placesOfText, placeKeyOf, isOutingViewingNotes, TRAVEL_GAP, OFFER_START_MIN, OFFER_END_MIN, type SlotBusy } from "../viewing-slot-plan";
import { parseCandidateSlots } from "../viewing-hold";
import { limitSlotsPerDay } from "../viewing-slots";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const ev = (from: string, to: string, extra: Partial<SlotBusy> = {}): SlotBusy => ({ start: hm(from), end: hm(to), ...extra });
const slots = (o: Parameters<typeof planDaySlots>[0]) => planDaySlots(o).slots.join(" ");
const mins = (s: string) => { const m = s.match(/(\d+):(\d+)〜(\d+):(\d+)/)!; return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]; };

// ─── ① 枠は 11:00 開始〜18:30 終了の中 ───
it("YUMA の実物の日（10/3 予定なし・旧は 10:00〜17:00 をそのまま出した）→ 13:00 から2時間ずつ", () => expect(slots({ busy: [] })).toBe("13:00〜15:00 15:00〜17:00 17:00〜18:30"));
it("朝の予定（8:00〜9:00）があっても 11:00 より前の枠は出さない", () => expect(slots({ busy: [ev("8:00", "9:00")] })).toBe("11:00〜13:00 13:00〜15:00 15:00〜17:00"));
it("どの形でも枠は 11:00〜18:30 の中・長さは件数の表の中", () => {
  const cases: SlotBusy[][] = [[], [ev("9:00", "10:00")], [ev("12:00", "13:00")], [ev("14:00", "15:30")], [ev("17:30", "19:00")], [ev("10:00", "11:30"), ev("15:00", "16:00")]];
  for (const busy of cases) for (const count of [1, 2, 3, 4]) {
    const { min, max } = slotLengthFor(count);
    for (const s of planDaySlots({ busy, count }).slots) {
      const [a, b] = mins(s);
      if (a < OFFER_START_MIN || b > OFFER_END_MIN) throw new Error(`範囲の外: ${s}`);
      if (b - a < min || b - a > max) throw new Error(`長さが表の外: ${s}（${count}件）`);
    }
  }
});
it("夕方の予定（17:30〜19:00）→ 枠は 16:30 までに終わる", () => expect(slots({ busy: [ev("17:30", "19:00")] })).toBe("11:00〜13:00 13:00〜15:00 15:00〜16:30"));

// ─── ② 件数 → 枠の長さ ───
it("1件は 1〜2時間", () => expect(JSON.stringify(slotLengthFor(1))).toBe(JSON.stringify({ min: 60, max: 120 })));
it("件数が増えると長く（2件 1.5〜2.5時間・3件 2〜3時間・4件以上 2.5〜3.5時間）", () => {
  expect(JSON.stringify(slotLengthFor(2))).toBe(JSON.stringify({ min: 90, max: 150 }));
  expect(JSON.stringify(slotLengthFor(3))).toBe(JSON.stringify({ min: 120, max: 180 }));
  expect(JSON.stringify(slotLengthFor(4))).toBe(JSON.stringify({ min: 150, max: 210 }));
  expect(JSON.stringify(slotLengthFor(7))).toBe(JSON.stringify({ min: 150, max: 210 }));
  expect(JSON.stringify(slotLengthFor(null))).toBe(JSON.stringify({ min: 60, max: 120 }));
});
it("3件の予定なしの日 → 13:00〜16:00 と 16:00〜18:30", () => expect(slots({ busy: [], count: 3 })).toBe("13:00〜16:00 16:00〜18:30"));
it("1件なら入る1時間の空き（11:00〜12:00）も、2件では出さない", () => {
  const busy = [ev("13:00", "14:00")];
  expect(slots({ busy, count: 1 })).toBe("11:00〜12:00 15:00〜17:00 17:00〜18:30");
  expect(slots({ busy, count: 2 })).toBe("15:00〜17:30");
});

// ─── ③ 前後の予定との間（場所で段を分ける） ───
const SUITA = "【物件】エスリード吹田\n内覧方法: 現地\n住所: 大阪府吹田市片山町1丁目2-3";
it("竹内さんの例: 吹田の内覧（〜14:00）の次に東大阪 → 終了から2時間空ける（16:00 から）", () => {
  const busy = [ev("13:00", "14:00", { text: SUITA, outing: true })];
  expect(travelGapFor(busy[0], placesOfText("東大阪市")).minutes).toBe(120);
  expect(slots({ busy, place: "東大阪市長田" })).toBe("16:00〜18:00");
});
it("同じ市の内覧なら1時間（前 11:00〜12:00・後 15:00 から）", () => {
  const busy = [ev("13:00", "14:00", { text: SUITA, outing: true })];
  expect(travelGapFor(busy[0], placesOfText("吹田市")).tier).toBe("same");
  expect(slots({ busy, place: "吹田市江坂町" })).toBe("11:00〜12:00 15:00〜17:00 17:00〜18:30");
});
it("近い区（浪速区の予定 → 西区の内覧）は1時間半", () => {
  const b = ev("13:00", "14:00", { text: "【物件】セレニテ難波\n住所: 大阪市浪速区日本橋東2-2-3", outing: true });
  expect(travelGapFor(b, placesOfText("大阪市西区南堀江")).minutes).toBe(90);
  expect(slots({ busy: [b], place: "大阪市西区南堀江" })).toBe("15:30〜17:30 17:30〜18:30");
});
it("内覧の場所が分からない時は、決まった内覧の予定とは長め（2時間）に空ける", () => {
  const b = ev("13:00", "14:00", { text: SUITA, outing: true });
  expect(travelGapFor(b, []).tier).toBe("unknown");
  expect(slots({ busy: [b] })).toBe("16:00〜18:00");
});
it("予定の側の住所が読めない内覧（物件名だけ）も長めに空ける", () => {
  const b = ev("13:00", "14:00", { text: "【物件】グランドメゾン 402号室 / 現地", outing: true });
  expect(travelGapFor(b, placesOfText("東大阪市")).minutes).toBe(TRAVEL_GAP.unknown);
});
it("出かけない予定（電話・連絡・時間確保）は今まで通り1時間", () => {
  expect(travelGapFor(ev("13:00", "14:00", { text: "かしこまりました！！\n17:30からお電話お待ちしております！！" }), placesOfText("東大阪市")).minutes).toBe(60);
  expect(travelGapFor(ev("13:00", "14:00", { text: "【時間確保】\n候補: 10/2(金) 13:00〜15:00" }), []).minutes).toBe(60);
});
it("出かけない予定でも本文に離れた場所があれば場所で空ける（「吹田で用事」→ 東大阪）", () => {
  expect(travelGapFor(ev("13:00", "14:00", { text: "吹田市役所で手続き" }), placesOfText("東大阪市")).minutes).toBe(120);
});
it("2件の内覧の予定（浪速区と吹田市）は一番離れた組で決める", () => {
  const b = ev("13:00", "15:00", { text: "【1件目】A / 現地\n住所: 大阪市浪速区日本橋東2-2-3\n【2件目】B\n住所: 大阪府吹田市片山町1", outing: true });
  expect(travelGapFor(b, placesOfText("大阪市浪速区")).tier).toBe("far");
});
it("場所の段（同じ・近い・離れた・読めない）", () => {
  expect(travelTierBetween(placesOfText("吹田市"), placesOfText("東大阪市"))).toBe("far");
  expect(travelTierBetween(placesOfText("大阪市北区"), placesOfText("大阪市中央区"))).toBe("near");
  expect(travelTierBetween(placesOfText("大阪市北区"), placesOfText("住所: 大阪府大阪市北区梅田1"))).toBe("same");
  expect(travelTierBetween(placesOfText("吹田市"), placesOfText("メモなし"))).toBe(null);
  expect(placeKeyOf("住所: 大阪府大阪市福島区海老江7丁目18-5 ダイヤル錠【3008】")).toBe("大阪市福島区");
});
it("決まった内覧の予定の見分け（物件・住所がある予定だけ）", () => {
  expect(isOutingViewingNotes("viewing", "【物件】カーザSunⅠ 202号室\n内覧方法: 未入力\n住所: 大阪府大阪市福島区海老江7丁目18-5")).toBe(true);
  expect(isOutingViewingNotes("viewing", "【1件目】OPUS RESIDENCE / 管理会社(…)\n【2件目】ミラージュパレス本町")).toBe(true);
  expect(isOutingViewingNotes("viewing", "【時間確保】\n候補: 9/18(金) 10:30〜11:30")).toBe(false);
  expect(isOutingViewingNotes("viewing", "件数: 1件\n物件: （未確定）（現地）")).toBe(false);
  expect(isOutingViewingNotes("viewing", "【必ず】連絡")).toBe(false);
  expect(isOutingViewingNotes("phone", "住所: 大阪市北区")).toBe(false);
});

// ─── ④ 長い空きは切る・当日 ───
it("長い空き（旧 10:00〜17:00 の形）は1本で出さない", () => {
  for (const s of planDaySlots({ busy: [ev("9:00", "9:30")] }).slots) { const [a, b] = mins(s); if (b - a > 120) throw new Error(s); }
});
it("当日は今から1時間後以降（14:10 → 15:30 から）", () => expect(slots({ busy: [], notBeforeMin: hm("14:10") })).toBe("15:30〜17:30 17:30〜18:30"));
it("当日の 17:45 はもう出さない", () => expect(slots({ busy: [], notBeforeMin: hm("17:45") })).toBe(""));
it("定休日（終日）は出さない", () => expect(slots({ busy: [{ start: 0, end: 24 * 60 }] })).toBe(""));

// ─── ⑤ 出す形は今の文のまま・読む側（時間確保）も今まで通り読める ───
it("新しい枠の形を parseCandidateSlots が読む（送った文 → 時間確保）", () => {
  const NOW = Date.parse("2026-09-30T13:00:00+09:00");
  const text = "直近ですと\n10/2(金) 13:00〜15:00\n10/3(土) 11:00〜13:00にてご案内可能です😊！！";
  expect(parseCandidateSlots(text, NOW).map((s) => `${s.ymd} ${s.start}-${s.end}`).join(", ")).toBe("2026-10-02 13:00-15:00, 2026-10-03 11:00-13:00");
});
it("材料の行（1日に複数の枠）は今まで通り1日1つに落ちる", () => {
  expect(limitSlotsPerDay(`10/2(金) ${planDaySlots({ busy: [] }).slots.join(" / ")}`)).toBe("10/2(金) 13:00〜15:00");
});
it("枠の文字に営業時間（10:00・19:00）が出ない", () => {
  const all = [[], [ev("8:00", "9:00")], [ev("17:30", "19:00")]].flatMap((busy) => [1, 2, 3, 4].flatMap((count) => planDaySlots({ busy, count }).slots)).join(" ");
  expect(/(?:^|[^\d])10:00|19:00/.test(all)).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
