// app/lib/__tests__/viewing-before-detail.test.ts — 内覧前の挨拶の物件名と待ち合わせ場所の1行（No.18・文は作り物）
import { viewingBeforeDetailOn, meetingAddressOf, viewingBeforeDetailLine, withViewingBeforeDetail, buildViewingBeforeGreeting } from "../viewing-greeting-text";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定 off", !viewingBeforeDetailOn({}) && viewingBeforeDetailOn({ VIEWING_BEFORE_DETAIL: "on" }));
t("住所の行", meetingAddressOf("11/4 13:00にメゾンA 305号室\n現地エントランスお待ち合わせ\n住所：大阪市北区天満3丁目1-2") === "大阪市北区天満3丁目1-2");
const line = viewingBeforeDetailLine({ properties: ["メゾンA 305号室", "ハイツB 201号室"], place: "メゾンA 305号室", address: "大阪市北区天満3丁目1-2" });
t("1行", line === "本日ご案内のお部屋はメゾンA 305号室・ハイツB 201号室、待ち合わせ場所はメゾンA 305号室（大阪市北区天満3丁目1-2）となります！", line);
t("何も無ければ足さない", viewingBeforeDetailLine({ properties: [], place: null, address: null }) === "");
const g = buildViewingBeforeGreeting({ name: "YUMAさん", greeting: "お世話になっております！！", time: "13:00" });
const g2 = withViewingBeforeDetail(g, line);
t("ご案内の次の行に入る", g2.split("\n")[2] === line && g2.split("\n").length === g.split("\n").length + 1, g2);
console.log(`viewing-before-detail: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
