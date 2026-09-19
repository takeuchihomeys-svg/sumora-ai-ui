// 2026-09-16 竹内（カイナ事例）: 内覧の流れの判定と、物件確認した×会話を合わせるの出口の決定論
// 実行: npx tsx app/lib/__tests__/viewing-thread.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  resolveViewingThread, buildViewingThreadBlock, stripEstimatePromiseLines, stripNewSlotLines, ensureViewingContinuationLine,
  resolveEnclosedRooms, buildEnclosedCountLines, ensureRoomCountPhrase, VIEWING_CONTINUATION_LINE, type ThreadMsg,
} from "../viewing-thread";
import { normalizeForDup } from "../closed-ack";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

// カイナ（🐈‍⬛）の実会話（rawCreatedAt は UTC）。生成は 9/16 08:56 JST = 2026-09-15T23:56Z
const NOW = Date.parse("2026-09-15T23:56:00Z");
const KAINA: ThreadMsg[] = [
  { sender: "staff", text: "カイナさんお世話になっております！！\n\n浪速区・中央区全域から広めのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！", rawCreatedAt: "2026-09-15T10:05:00Z" },
  { sender: "staff", text: "🌟YMK NAMBA\nお送りさせて頂いたお部屋の中でも\n30.77㎡とお部屋かなり広いです！！", rawCreatedAt: "2026-09-15T10:08:00Z" },
  { sender: "customer", text: "こちらと", rawCreatedAt: "2026-09-15T10:28:00Z" },
  { sender: "customer", text: "こちら1度見てみたいです！", rawCreatedAt: "2026-09-15T10:29:00Z" },
  { sender: "staff", text: "かしこまりました！！\n2部屋ともご案内させて頂きます！！\n\n直近ですと\n明日 9/16(水) 15:30〜17:00にてご案内可能です😊！！\nカイナさんご都合如何でしょうか！！", rawCreatedAt: "2026-09-15T10:31:00Z" },
  { sender: "customer", text: "[画像] suumo.jp アーバンフラッツ心斎橋の賃貸物件情報", rawCreatedAt: "2026-09-15T13:16:00Z" },
  { sender: "customer", text: "お世話になっております\nこの物件対応できますか💭", rawCreatedAt: "2026-09-15T13:16:10Z" },
];
const GEN = "カイナさんお世話になっております！！\n\nアーバンフラッツ心斎橋のお部屋、確認させて頂きましたところ現在も募集中となっております！！\n\n最大限割引しました初期費用の御見積書作成しお送りさせて頂きます！！\nお手隙の際にご査収ください😌！！";
const SENT = "カイナさんお世話になっております！！\n\nアーバンフラッツ心斎橋のお部屋、確認させて頂きましたところ、こちらの3部屋現在募集中となっております！！\nよろしければご案内させて頂きます！！";

it("カイナ: 打診済み・返事待ち（9/16(水) 15:30〜17:00・2部屋・お客様「見てみたい」）", () => {
  const v = resolveViewingThread(KAINA, { nowMs: NOW });
  expect(v.kind).toBe("proposed_waiting_reply");
  expect(v.pending).toBe(true);
  expect(v.slots).toEqual(["9/16(水) 15:30〜17:00"]);
  expect(v.roomsWanted).toBe(2);
  expect(v.customerWish ?? "").toContain("見てみたい");
  expect(v.reason).toBe("staff_proposed_no_reply");
});
it("お客様が日時を受諾したら scheduled（「明日15:30でお願いします」「はい、大丈夫です！」）", () => {
  expect(resolveViewingThread([...KAINA, { sender: "customer", text: "明日15:30でお願いします！", rawCreatedAt: "2026-09-15T14:00:00Z" }], { nowMs: NOW }).kind).toBe("scheduled");
  const v = resolveViewingThread([...KAINA, { sender: "customer", text: "はい、大丈夫です！", rawCreatedAt: "2026-09-15T14:00:00Z" }], { nowMs: NOW });
  expect(v.kind).toBe("scheduled"); expect(v.reason).toBe("customer_accepted");
});
it("別件の依頼（「この物件もお願いします」）は受諾にしない", () => {
  expect(resolveViewingThread([...KAINA, { sender: "customer", text: "この物件もお願いします", rawCreatedAt: "2026-09-15T14:00:00Z" }], { nowMs: NOW }).kind).toBe("proposed_waiting_reply");
});
it("キャンセル・待ち合わせ送付済み・内覧後のお礼は続きにしない", () => {
  expect(resolveViewingThread([...KAINA, { sender: "customer", text: "明日は行けなくなりました", rawCreatedAt: "2026-09-15T14:00:00Z" }], { nowMs: NOW }).reason).toBe("customer_cancelled");
  expect(resolveViewingThread([...KAINA, { sender: "staff", text: "明日15:30に なんば駅 改札前で待ち合わせお願いします", rawCreatedAt: "2026-09-15T14:00:00Z" }], { nowMs: NOW }).reason).toBe("meeting_place_sent");
  expect(resolveViewingThread([...KAINA, { sender: "staff", text: "カイナさん本日はお時間頂きありがとうございました！！", rawCreatedAt: "2026-09-16T09:00:00Z" }], { nowMs: Date.parse("2026-09-16T10:00:00Z") }).reason).toBe("viewing_done");
});
it("48時間より前の打診は拾わない（時刻が全て無ければ末尾12件で判定し reason に印）", () => {
  const old = KAINA.map((m) => ({ ...m, rawCreatedAt: "2026-09-10T10:00:00Z" }));
  expect(resolveViewingThread(old, { nowMs: NOW }).reason).toBe("no_viewing_thread");
  const noTs = KAINA.map((m) => ({ sender: m.sender, text: m.text }));
  const v = resolveViewingThread(noTs, { nowMs: NOW });
  expect(v.kind).toBe("proposed_waiting_reply"); expect(v.reason).toBe("staff_proposed_no_reply+fallback_lookback");
});
it("候補の枠が過ぎて返事も無ければ続きにしない（9/16 17:00 の3時間後）", () => {
  expect(resolveViewingThread(KAINA, { nowMs: Date.parse("2026-09-16T12:00:00Z") }).reason).toBe("slots_expired");
});
it("打診が無くお客様の希望だけ → customer_wants_viewing。「まだ考えていません」は希望ではない。物件送付の「ご案内もさせていただきます」は打診ではない", () => {
  const a = resolveViewingThread([{ sender: "customer", text: "空室あれば内覧したいと思ってます！", rawCreatedAt: "2026-09-15T13:00:00Z" }], { nowMs: NOW });
  expect(a.kind).toBe("customer_wants_viewing"); expect(a.pending).toBe(true); expect(a.slots).toEqual([]);
  expect(resolveViewingThread([{ sender: "customer", text: "内覧はまだ考えていません", rawCreatedAt: "2026-09-15T13:00:00Z" }], { nowMs: NOW }).kind).toBe("none");
  expect(resolveViewingThread([{ sender: "staff", text: "お気に召されたお部屋のご案内もさせていただきます😊！！", rawCreatedAt: "2026-09-15T13:00:00Z" }], { nowMs: NOW }).kind).toBe("none");
});
it("糸口のブロック: 提案済みの日時・お客様の言葉・続きの1文・御見積書なしの注意", () => {
  const v = resolveViewingThread(KAINA, { nowMs: NOW });
  const b = buildViewingThreadBlock(v, { customerName: "カイナさん", estimateEnclosed: false, active: true, staffForced: false, lineForced: true });
  expect(b).toContain("9/16(水) 15:30〜17:00"); expect(b).toContain(VIEWING_CONTINUATION_LINE); expect(b).toContain("御見積書");
  expect(buildViewingThreadBlock(v, { customerName: "カイナさん", estimateEnclosed: true, active: true, staffForced: false, lineForced: true })).notToContain("御見積書");
  expect(buildViewingThreadBlock(v, { customerName: "カイナさん", estimateEnclosed: false, active: false, staffForced: false })).toBe("");
  expect(buildViewingThreadBlock(resolveViewingThread([], { nowMs: NOW }), { customerName: "x", estimateEnclosed: false, active: true, staffForced: true })).toContain("スタッフの指定");
});
// 2026-09-19 竹内「実際の成約データや直近でスタッフが書き直したのも参考にして」:
//   「よろしければご案内させて頂きます」は実送信365日 11,918通中1件。自動判定で毎回足していたため 49% で削られていた。
//   → 自動判定（lineForced なし）では締めの1文を書かせない。日程を出さない縛りだけ残す。
it("自動判定では締めの1文を書かせない（日程を出さない縛りだけ残す）", () => {
  const v = resolveViewingThread(KAINA, { nowMs: NOW });
  const auto = buildViewingThreadBlock(v, { customerName: "カイナさん", estimateEnclosed: true, active: true, staffForced: false });
  expect(auto).toContain("9/16(水) 15:30〜17:00");        // 糸口は渡す
  expect(auto).toContain("新しい日時");                    // 日程を出さない縛りは残る
  expect(auto).notToContain(VIEWING_CONTINUATION_LINE);   // 締めの1文は書かせない
  expect(auto).toContain("次の一手も書かない");
  expect(auto).toContain("ご査収");
  // スタッフが「流れを続ける」を押した時だけ1文が入る
  expect(buildViewingThreadBlock(v, { customerName: "カイナさん", estimateEnclosed: true, active: true, staffForced: false, lineForced: true })).toContain(VIEWING_CONTINUATION_LINE);
});
it("御見積書を同封しない時は約束の行（と直後のご査収）を落とす。同封済みの過去形は落とさない", () => {
  const r = stripEstimatePromiseLines(GEN, { estimateEnclosed: false });
  expect(r.removed.length).toBe(2);
  expect(r.text).toBe("カイナさんお世話になっております！！\n\nアーバンフラッツ心斎橋のお部屋、確認させて頂きましたところ現在も募集中となっております！！");
  expect(stripEstimatePromiseLines(GEN, { estimateEnclosed: true }).removed.length).toBe(0);
  expect(stripEstimatePromiseLines("募集中です！！\n最大限割引しました御見積書同封させて頂きました！！\nお手隙の際にご査収ください😌！！", { estimateEnclosed: false }).removed.length).toBe(0);
  expect(stripEstimatePromiseLines("確認出来次第、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！", { estimateEnclosed: false }).removed.length).toBe(1);
  // 空行を挟んだ別段落の「ご査収」は残す
  expect(stripEstimatePromiseLines("御見積書作成しお送りさせて頂きます！！\n\nお手隙の際にご査収ください😌！！", { estimateEnclosed: false }).text).toBe("お手隙の際にご査収ください😌！！");
});
it("新しい日時の行を落とす（続きの1文は残る）", () => {
  const r = stripNewSlotLines("よろしければご案内させて頂きます！！\n直近ですと\n9/18(金) 10:30〜11:30\nご案内可能です！！");
  expect(r.text).toBe("よろしければご案内させて頂きます！！"); expect(r.removed.length).toBe(3);
});
it("続きの1文を足す（ご査収の前・改行1つ／無ければ末尾）。既に「ご案内」があれば足さない", () => {
  expect(ensureViewingContinuationLine("…募集中となっております！！", true).text).toBe(`…募集中となっております！！\n${VIEWING_CONTINUATION_LINE}`);
  expect(ensureViewingContinuationLine("…募集中となっております！！\n\nお手隙の際にご査収ください😌！！", true).text).toBe(`…募集中となっております！！\n${VIEWING_CONTINUATION_LINE}\nお手隙の際にご査収ください😌！！`);
  expect(ensureViewingContinuationLine(SENT, true).added).toBe(null);
  expect(ensureViewingContinuationLine("…募集中です", false).added).toBe(null);
});
it("部屋数はスタッフの入力が正（資料の枚数から推定しない）", () => {
  expect(resolveEnclosedRooms({ propertyCount: 1, roomCounts: [3], imageCount: 3 })).toEqual({ rooms: 3, docs: 3, source: "room_counts" });
  expect(resolveEnclosedRooms({ propertyCount: 1, roomCounts: [null], imageCount: 3 })).toEqual({ rooms: null, docs: 3, source: null });
  expect(resolveEnclosedRooms({ propertyCount: 2, imageCount: 2 })).toEqual({ rooms: 2, docs: 2, source: "cards" });
  expect(resolveEnclosedRooms({ propertyCount: 2, roomCounts: [3, null], imageCount: 4 }).rooms).toBe(4);
  expect(resolveEnclosedRooms({ propertyCount: 1, imageCount: 1, staffNote: "同じ間取りは301号室と101号室のみ" }).rooms).toBe(null);
  expect(resolveEnclosedRooms({ propertyCount: 1, imageCount: 3, staffNote: "3部屋とも募集中" })).toEqual({ rooms: 3, docs: 3, source: "staff_note" });
  expect(buildEnclosedCountLines({ rooms: 3, docs: 3, source: "room_counts" })[0]).toContain("こちらの3部屋");
  expect(buildEnclosedCountLines({ rooms: null, docs: 3, source: null })[0]).toContain("数は書かない");
  expect(buildEnclosedCountLines({ rooms: 1, docs: 1, source: null }).length).toBe(0);
});
it("部屋数が本文に無ければ「こちらのN部屋」を差し込む・あれば触らない", () => {
  expect(ensureRoomCountPhrase("…ところ現在も募集中となっております！！", 3).text).toBe("…ところこちらの3部屋現在も募集中となっております！！");
  expect(ensureRoomCountPhrase("こちら3件現在募集中となります！！", 3).fixed).toBe(false);
  expect(ensureRoomCountPhrase("…募集中です", null).fixed).toBe(false);
  expect(ensureRoomCountPhrase("…募集中です", 1).fixed).toBe(false);
});
it("出口の合成（route と同じ順）: 旧生成文 → カイナの実送信とほぼ同じ", () => {
  let t = stripEstimatePromiseLines(GEN, { estimateEnclosed: false }).text;
  t = stripNewSlotLines(t).text;
  t = ensureViewingContinuationLine(t, true).text;
  t = ensureRoomCountPhrase(t, 3).text;
  expect(t).toBe("カイナさんお世話になっております！！\n\nアーバンフラッツ心斎橋のお部屋、確認させて頂きましたところこちらの3部屋現在も募集中となっております！！\nよろしければご案内させて頂きます！！");
  // 実送信との違いは「、」と「も」だけ
  expect(normalizeForDup(t).replace("現在も", "現在")).toBe(normalizeForDup(SENT));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
