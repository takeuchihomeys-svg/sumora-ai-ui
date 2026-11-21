// app/lib/__tests__/property-thread-photo-sent.test.ts — 2026-11-22 作業員K2（#287 の③・PROPERTY_THREAD_PHOTO_SENT）
//   実行: npx tsx app/lib/__tests__/property-thread-photo-sent.test.ts
import { resolvePropertyThreads, propertyThreadPhotoSentOn, type PtMsg, type PtAix } from "../property-thread";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const messages: PtMsg[] = [
  { sender: "customer", text: "サンプルレジデンス 101号室の室内の写真ありますか？", created_at: "2026-11-20T03:00:00Z", line_message_id: "c1" },
  { sender: "staff", text: "[画像]", created_at: "2026-11-20T03:10:00Z", line_message_id: "s1", image_url: "u-int1", is_aix_generated: true },
];
const aix: PtAix[] = [{ created_at: "2026-11-20T03:10:05Z", aix_type: "property_check_result", check_pattern: "interior_photo", property_names: ["サンプルレジデンス 101号室"], prop_statuses: ["available"] }];
const kindsOf = (env: string | undefined) => {
  const prev = process.env.PROPERTY_THREAD_PHOTO_SENT;
  if (env == null) delete process.env.PROPERTY_THREAD_PHOTO_SENT; else process.env.PROPERTY_THREAD_PHOTO_SENT = env;
  try { return resolvePropertyThreads({ messages, imageLabels: new Map(), aix }).rooms.flatMap((r) => r.events.map((e) => e.kind)); }
  finally { if (prev == null) delete process.env.PROPERTY_THREAD_PHOTO_SENT; else process.env.PROPERTY_THREAD_PHOTO_SENT = prev; }
};
t("既定 off", !propertyThreadPhotoSentOn({}) && propertyThreadPhotoSentOn({ PROPERTY_THREAD_PHOTO_SENT: "on" }));
t("off は出来事を足さない（今まで通り）", !kindsOf(undefined).includes("photo_sent"), kindsOf(undefined));
t("on は室内写真の型の AIX で photo_sent を足す", kindsOf("on").includes("photo_sent"), kindsOf("on"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
