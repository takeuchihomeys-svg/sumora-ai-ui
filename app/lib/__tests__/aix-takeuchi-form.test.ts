// 実行: npx tsx app/lib/__tests__/aix-takeuchi-form.test.ts
// 2026-10-08 竹内「（物件ピックアップの文は）竹内が送っているような形で」
import { takeuchiPickupSystem, takeuchiPickupConditionsRule, TAKEUCHI_PICKUP_LINE_EXAMPLES } from "../aix-takeuchi-form";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const SIMPLE = `【厳守ルール】
・②は「〇〇から[お客様名]ご希望の〜なお部屋ピックアップさせて頂きました！！」の形で1行に完結させる。希望条件が渡されている場合は「ご条件に合った」という抽象表現ではなく具体条件（エリア必須・最大4個）を文中に織り込むこと

【出力例】
[お客様への挨拶]

大阪駅・難波駅周辺からRさんご希望のご条件に合ったお部屋ピックアップさせて頂きました！！`;
const NEW = `・エリアと間取りは必ず入れる（両方必須・省略不可）
・入れる条件は最大4個まで（エリア・間取りの2つは必ず含む）。箇条書きにせず文中に自然に埋め込む
例：「新着で梅田まで30分圏内のエリアから[お客様名]にオススメできる2LDK・2口ガスコンロ付きの9/1入居可能なお部屋が3件募集にでました！！」`;

const s = takeuchiPickupSystem(SIMPLE);
// 2026-10-08 竹内さん「条件の数は実際の LINE を参考に（決め打ちしない）」: 既定は「決め打ちしない」（PICKUP_COND_COUNT=off で旧の「2つまで」）
t("最大4個 → 決め打ちしない（旧は2つまで）", !s.includes("最大4個") && s.includes("条件の数は決め打ちしない"));
t("②の型が竹内さんの形", s.includes("〇〇周辺全域から[お客様名]にオススメできる〜のお部屋ピックアップさせて頂きました😊！！"));
t("出力例が竹内さんの形", s.includes("大阪駅・難波駅周辺全域からRさんにオススメできるお部屋ピックアップさせて頂きました😊！！") && !s.includes("ご条件に合ったお部屋ピックアップ"));
const n = takeuchiPickupSystem(NEW);
t("新着: 間取り必須を外す・最大4個を外す・竹内さんの新着の行を手本に", !n.includes("両方必須") && !n.includes("最大4個") && n.includes("新着で[お客様名]にオススメ出来るお部屋が2件募集に出ました！！"));
t("新着の例は条件2つまで", n.includes("2LDKのお部屋が3件募集にでました") && !n.includes("2口ガスコンロ付きの9/1入居可能"));
t("当たらない文は1バイトも変えない", takeuchiPickupSystem("関係ない文") === "関係ない文");
const r = takeuchiPickupConditionsRule();
t("条件ルール: 決め打ちしない・エリア必須・ご条件に合ったは使わない・手本は竹内さんの送信", r.includes("決め打ちしない") && r.includes("エリアは必ず") && r.includes("「ご希望のご条件に合ったお部屋」は使わない") && TAKEUCHI_PICKUP_LINE_EXAMPLES.every((e) => r.includes(e)));
t("手本はどれもピックアップの行で条件2つまで", TAKEUCHI_PICKUP_LINE_EXAMPLES.every((e) => /ピックアップさせて頂きました/.test(e) && (e.split("から")[1] ?? "").split(/・/).length <= 2));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
