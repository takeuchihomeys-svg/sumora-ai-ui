// app/lib/__tests__/second-block-receipt.test.ts — 2026-11-21 作業員K2（SECOND_BLOCK_RECEIPT_SEEN）
//   実行: npx tsx app/lib/__tests__/second-block-receipt.test.ts
import { secondBlockReceiptNote, secondBlockReceiptSeenOn } from "../second-block-receipt";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const at = (m: number) => new Date(Date.parse("2026-10-21T10:00:00Z") + m * 60_000).toISOString();
const NOTICE = "YUMAさんお世話になっております！！ 〇〇駅周辺全域からオススメできるお部屋ピックアップさせて頂きました！！ お手隙の際にご査収ください😌！！";
const CARD = "🌟サンプルレジデンス 101号室\n家賃65,000円";
t("既定 off", !secondBlockReceiptSeenOn({}) && secondBlockReceiptSeenOn({ SECOND_BLOCK_RECEIPT_SEEN: "on" }));
const block = [
  { sender: "customer", text: "よろしくお願いします", rawCreatedAt: at(0) },
  { sender: "staff", text: NOTICE, isAix: true, rawCreatedAt: at(5) },
  { sender: "staff", text: CARD, isAix: true, rawCreatedAt: at(6) },
];
t("同じ塊のお知らせにご査収がある → 1行を渡す（昔の時刻のままでも）", /もう「お手隙の際にご査収ください」を伝えている/.test(secondBlockReceiptNote(block, CARD)));
t("お客様の発言を挟んだ前の塊のご査収は数えない", secondBlockReceiptNote([{ sender: "staff", text: NOTICE, isAix: true, rawCreatedAt: at(1) }, { sender: "customer", text: "はい", rawCreatedAt: at(3) }, { sender: "staff", text: CARD, isAix: true, rawCreatedAt: at(6) }], CARD) === "");
t("30分より前の通は数えない", secondBlockReceiptNote([{ sender: "customer", text: "x", rawCreatedAt: at(0) }, { sender: "staff", text: NOTICE, isAix: true, rawCreatedAt: at(1) }, { sender: "staff", text: CARD, isAix: true, rawCreatedAt: at(40) }], CARD) === "");
t("手打ちの通（AIX でない）のご査収は数えない", secondBlockReceiptNote([{ sender: "customer", text: "x", rawCreatedAt: at(0) }, { sender: "staff", text: NOTICE, isAix: false, rawCreatedAt: at(1) }, { sender: "staff", text: CARD, isAix: true, rawCreatedAt: at(2) }], CARD) === "");
t("1通目そのものにご査収がある時は渡さない（aixChainNote が扱う）", secondBlockReceiptNote(block, NOTICE) === "");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
