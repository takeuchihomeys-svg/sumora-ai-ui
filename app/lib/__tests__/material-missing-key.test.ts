// 自己申告の材料の名前を決まった鍵に寄せる（app/lib/material-missing-key.ts）＋届いていない材料の行（app/lib/brain-material-wiring.ts）のテスト
// 文はすべて実物（brain_unknowns kind=material_missing の label・11/11 時点の14日 437種類から。回数の多い物と、並びの順で取り違えやすい物）
// 実行: npx tsx app/lib/__tests__/material-missing-key.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { materialMissingKey, materialMissingSide, tallyMaterialKeys } from "../material-missing-key";
import { pickupCandidatesMaterialLine, freshPickupCandidates, focusDocDigestNote, pickupCandidatesListOn, focusDocDigestOn } from "../brain-material-wiring";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}`, extra); } };
const k = (label: string, want: string) => { const got = materialMissingKey(label); t(`${label} → ${want}`, got === want, got); };

// 回数の多い物（上位）
k("送れる物件の候補", "sendable_candidates"); k("送れる新しい物件の候補", "sendable_candidates"); k("送れる新着物件の候補", "sendable_candidates");
k("送れる新しい物件候補", "sendable_candidates"); k("送れる物件候補", "sendable_candidates"); k("新着の候補物件", "sendable_candidates");
k("見積の金額", "estimate_amount"); k("御見積書の金額", "estimate_amount");
k("送った物件の現況", "vacancy_status"); k("法人契約の可否", "mgmt_answer"); k("入居可能日", "move_in_date"); k("管理会社の回答", "mgmt_answer");
k("内覧可否", "viewing_slot"); k("内覧可能な日時", "viewing_slot"); k("募集状況", "vacancy_status"); k("奥様名義申込の可否", "mgmt_answer");
k("304号室の審査状況", "screening_status"); k("撮影済みの室内写真・動画", "room_photos"); k("保証会社名", "guarantor_company"); k("家賃上限", "customer_conditions");
// 並びで取り違えやすい物
k("お客様が送った物件の現況(管理会社の確認結果)", "vacancy_status");    // 「送った」でも持ち込み＝確かめる事
k("お客様が送った3物件の資料・現況", "vacancy_status");
k("送った2件の物件名・資料", "sent_property_status");                    // こちらが送った物件の資料＝記録にある
k("アプリーレ堺筋本町等5件の募集状況", "vacancy_status");                // 物件名の「アプリ」を知識にしない
k("入居者アプリの種類", "company_knowledge");
k("1件目の待ち合わせ場所の住所", "viewing_record");                      // 住所でも物件資料ではない
k("住所の用途(契約書類か現住所か)", "conversation_context");
k("築年数・初期費用上限", "customer_conditions");                        // 費用の語でも見積ではない
k("入居可能日(管理会社回答)", "mgmt_answer");                           // 管理会社の回答待ち
k("持ち込み2物件の入居可能日", "brought_property_detail");
k("TikTok物件の家賃・間取り", "brought_property_detail");
k("スタッフの本日18:30の空き", "viewing_slot");
k("引越しに向いている時期の会社の見解", "company_knowledge");
k("コーポ加島306号室のエアコン有無", "property_doc");
k("内覧後のお客様の感想", "customer_feedback");
k("どの物件の話か", "conversation_context");
k("", "other");

t("side: 候補は system・募集状況は staff・条件は customer", materialMissingSide("送れる物件の候補") === "system" && materialMissingSide("募集状況") === "staff" && materialMissingSide("エリア希望") === "customer");
const tally = tallyMaterialKeys([{ label: "送れる物件の候補", count: 45 }, { label: "送れる新着物件の候補", count: 10 }, { label: "見積の金額", count: 10 }]);
t("数え: 鍵ごとに足して多い順", tally[0].key === "sendable_candidates" && tally[0].n === 55 && tally[0].labels === 2 && tally[1].key === "estimate_amount", tally);

// 届いていない材料の行（既定 off）
t("スイッチは既定 off", !pickupCandidatesListOn({}) && !focusDocDigestOn({}) && pickupCandidatesListOn({ BRAIN_PICKUP_CANDIDATES_LIST: "on" }) && focusDocDigestOn({ BRAIN_FOCUS_DOC_DIGEST: "on" }));
const now = Date.parse("2026-11-10T10:00:00Z");
const rows = [
  { property_name: "グルーヴ日本橋", room_no: "502", summary_text: "家賃7.2万・1LDK・日本橋徒歩5分", score: 81, rank: 2, created_at: "2026-11-10T01:00:00Z" },
  { property_name: "ラシーヌ日本橋", room_no: "501", summary_text: "家賃6.8万・1K", score: 90, rank: 1, created_at: "2026-11-10T01:00:00Z" },
  { property_name: "古い候補", room_no: "101", score: 99, rank: 1, created_at: "2026-11-01T01:00:00Z" },                 // 3日より前
  { property_name: "送付前の候補", room_no: "201", score: 70, rank: 3, created_at: "2026-11-09T01:00:00Z" },             // 最後の送付より前
  { property_name: "期限切れ", room_no: "301", score: 88, rank: 1, created_at: "2026-11-10T02:00:00Z", expired_at: "2026-11-10T03:00:00Z" },
];
const fresh = freshPickupCandidates(rows, { lastPropertiesSentAt: "2026-11-09T12:00:00Z", nowMs: now });
t("候補: 新しさの線（3日・送付の後・期限切れなし）で2件・rank 順", fresh.map((r) => r.property_name).join(",") === "ラシーヌ日本橋,グルーヴ日本橋", fresh.map((r) => r.property_name));
const line = pickupCandidatesMaterialLine(rows, { lastPropertiesSentAt: "2026-11-09T12:00:00Z", nowMs: now });
t("候補の行: 中身と件数・返信に写さない注意", line.includes("今送れる 2件") && line.includes("ラシーヌ日本橋 501：家賃6.8万・1K（点 90）") && line.includes("写さない"), line);
t("候補が無い時は空", pickupCandidatesMaterialLine(rows, { lastPropertiesSentAt: "2026-11-10T09:00:00Z", nowMs: now }) === "");
const digest = focusDocDigestNote({ name: "グルーヴ日本橋", roomNo: "502" }, [
  { topic: "move_in", route: "material", facts: ["即入居"], why: "資料" },
  { topic: "guarantor_company", route: "material", facts: ["日本セーフティー"], why: "資料" },
  { topic: "key_money", route: "confirm", facts: [], why: "記載なし" },
  { topic: "deposit", route: "material", facts: ["1ヶ月"], why: "資料", unitUnclear: ["1ヶ月", "1万円"] },
]);
t("資料の行: 資料にある項目だけ（確認・単位不明は出さない）・聞かれていない注意", digest.includes("入居時期・退去予定: 「即入居」") && digest.includes("保証会社: 「日本セーフティー」") && !digest.includes("礼金") && !digest.includes("敷金") && digest.includes("聞かれていない"), digest);
t("資料の行: 項目が無ければ空", focusDocDigestNote({ name: "x", roomNo: null }, [{ topic: "parking", route: "confirm", facts: [], why: "" }]) === "");

// 配線（brain-core）
const src = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: 候補の中身は pickupCandidatesListOn の時だけ列を足して読み、ready の時に行を足す", /const candList = pickupCandidatesListOn\(\);/.test(src) && /if \(candList && readyNow\) \{/.test(src) && /pickupCandidatesMaterialLine\(\(pendNow \?\? \[\]\)/.test(src));
t("配線: 資料の行は focusDocDigestOn・contract-terms が無い・主のお部屋がある時だけ", /if \(focusDocDigestOn\(\) && !contractTerms && focusRoomForMaterial && !isPostApplyStatus\(convStatus\)\)/.test(src) && /focusDocDigestNote\(/.test(src));
console.log(`material-missing-key: ${pass}/${pass + fail}`); if (fail) process.exit(1);
