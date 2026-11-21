// app/lib/__tests__/check-unread.test.ts — 読めていない型の点検（2026-11-21 作業員N）
//   実行: npx tsx app/lib/__tests__/check-unread.test.ts
import { isReactionText, reactedOurImages, unreadLine, type CuMsg } from "../check-unread";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("反応の語", isReactionText("綺麗ですね！ここ！") && isReactionText("玄関も広いですか？") && !isReactionText("ありがとうございます"));

const at = (m: number) => new Date(Date.parse("2026-11-20T03:00:00Z") + m * 60_000).toISOString();
const msgs: CuMsg[] = [
  { id: "a", sender: "staff", text: "[画像]", image_url: "https://x/a.jpg", created_at: at(0) },
  { id: "b", sender: "staff", text: "1件新着でかなりオススメ出来るお部屋が募集に出ました", image_url: null, created_at: at(0), is_aix_generated: true },
  { id: "h", sender: "staff", text: "[画像]", image_url: "https://x/h.jpg", created_at: at(300) },
  { id: "i", sender: "staff", text: "手打ちの別の話です", image_url: null, created_at: at(301) },
  { id: "j", sender: "customer", text: "綺麗ですね", image_url: null, created_at: at(305) },
  { id: "c", sender: "customer", text: "綺麗ですね！ここ！", image_url: null, created_at: at(5) },
  { id: "d", sender: "staff", text: "[画像]", image_url: "https://x/d.jpg", created_at: at(100) },
  { id: "e", sender: "customer", text: "ありがとうございます", image_url: null, created_at: at(102) },
  { id: "f", sender: "staff", text: "[画像]", image_url: "https://x/f.jpg", created_at: at(200) },
  { id: "g", sender: "customer", text: "これ", image_url: null, created_at: at(900), quoted_message_id: "f" },
];
const r = reactedOurImages(msgs);
t("AIX の画像と本文（同じ送り）の後の反応は拾う", r.some((m) => m.id === "a"));
t("お礼だけは反応にしない", !r.some((m) => m.id === "d"));
t("引用された画像は時間に関係なく拾う", r.some((m) => m.id === "f"));
t("手打ちの別の文が挟まった画像は拾わない（数え過ぎない）", !r.some((m) => m.id === "h"));

t("行の形", unreadLine({ field: "customer_image", total: 10, read: 7, examples: ["m1"] }) === "customer_image: 読むべき物 10・読んだ記録あり 7・無い 3（30%）・例 m1");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
