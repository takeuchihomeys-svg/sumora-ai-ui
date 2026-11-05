// app/lib/__tests__/sent-image-reread.test.ts — 送った資料の画像の読み直し待ち（2026-11-05 案3'）
//   実行: npx tsx app/lib/__tests__/sent-image-reread.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickRereadTargets, sourceOfImage, sentImageRereadOn, type RereadMsg, type RereadAix } from "../sent-image-reread";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}`); } };
const now = Date.parse("2026-11-05T03:00:00Z");
const conv = "0177e9ed-a7bb-4dcd-be32-b04c212ca336";
// 11/05 11:46（JST）の実物の形: AIX【物件ピックアップ】で2枚・読み取りが 402 で失敗＝sent_image_properties に行が無い
const msgs: RereadMsg[] = [
  { id: 1, conversation_id: conv, created_at: "2026-11-05T02:46:50Z", image_url: "https://x/a.jpg", is_aix_generated: true },
  { id: 2, conversation_id: conv, created_at: "2026-11-05T02:46:51Z", image_url: "https://x/b.jpg", is_aix_generated: true },
  { id: 3, conversation_id: conv, created_at: "2026-11-05T01:00:00Z", image_url: "https://x/done.jpg", is_aix_generated: true },      // 記録済み
  { id: 4, conversation_id: conv, created_at: "2026-11-01T01:00:00Z", image_url: "https://x/old.jpg", is_aix_generated: false },      // 72時間より前
  { id: 5, conversation_id: "c2", created_at: "2026-11-05T02:00:00Z", image_url: "https://x/est.jpg", is_aix_generated: true },      // 見積書
  { id: 6, conversation_id: "f7deb105-f908-41ad-95e7-f13aafdfa032", created_at: "2026-11-05T02:00:00Z", image_url: "https://x/yuma3.jpg", is_aix_generated: true }, // 試験の会話
  { id: 7, conversation_id: "c3", created_at: "2026-11-05T02:10:00Z", image_url: "https://x/manual.jpg", is_aix_generated: false },  // 手で送った
  { id: 8, conversation_id: conv, created_at: "2026-11-05T02:47:00Z", image_url: "https://x/a.jpg", is_aix_generated: true },        // 同じ画像の2通目
];
const aix: RereadAix[] = [
  { conversation_id: conv, created_at: "2026-11-05T02:42:40Z", aix_type: "property_send" },
  { conversation_id: "c2", created_at: "2026-11-05T01:58:00Z", aix_type: "estimate_sheet" },
];
const skip = (id: string) => id === "f7deb105-f908-41ad-95e7-f13aafdfa032";
const got = pickRereadTargets(msgs, new Set(["https://x/done.jpg"]), aix, { nowMs: now, skipConv: skip });
t("読み直すのは記録の無い送付の画像（a・b・手で送った物）", JSON.stringify(got.map((g) => g.imageUrl)) === JSON.stringify(["https://x/manual.jpg", "https://x/a.jpg", "https://x/b.jpg"]));
t("経路は直前の AIX（物件ピックアップ）", got.find((g) => g.imageUrl === "https://x/a.jpg")?.source === "aix:property_send");
t("手で送った画像は staff_image", got.find((g) => g.imageUrl === "https://x/manual.jpg")?.source === "staff_image");
t("送った時刻は元の通の時刻", got.find((g) => g.imageUrl === "https://x/b.jpg")?.sentAt === "2026-11-05T02:46:51Z");
t("見積書の画像は読み直さない", !got.some((g) => g.imageUrl === "https://x/est.jpg"));
t("試験の会話は外す", !got.some((g) => g.imageUrl === "https://x/yuma3.jpg"));
t("72時間より前は外す", !got.some((g) => g.imageUrl === "https://x/old.jpg"));
t("上限", pickRereadTargets(msgs, new Set(), aix, { nowMs: now, limit: 1 }).length === 1);
t("AIX の印があっても直前10分に AIX が無ければ staff_image", sourceOfImage({ id: 9, conversation_id: "c9", created_at: "2026-11-05T02:00:00Z", image_url: "u", is_aix_generated: true }, aix) === "staff_image");
t("既定 on", sentImageRereadOn({}) === true && sentImageRereadOn({ SENT_IMAGE_REREAD: "off" }) === false);

// LINE には何も送らない: 読み直しの道のファイルが送信の口を import していない
const lib = join(__dirname, "..");
for (const f of ["sent-image-reread.ts", "sent-image-reread-server.ts", "sent-image-record.ts", "image-detail-store.ts"]) {
  // 注記（//・/* */）は除いて、コードだけを見る
  const src = readFileSync(join(lib, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  t(`${f}: LINE の送信の口を使わない`, !/send-line-message|line-client|pushMessage|replyMessage|api\.line\.me|messaging-api|scheduled_messages/.test(src));
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
