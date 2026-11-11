// app/lib/__tests__/takeuchi-anatomy-roles.test.ts — 文ごとの役目（純関数・文は竹内さんの実際の送信を伏せた物）
import { splitSentences, parseRoles, majorityRoles, rolePattern, compareRoles, rolesPrompt, ROLES_SYSTEM } from "../takeuchi-anatomy-roles";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

const b1 = "YUMAさんお世話になっております！！ 2階のお部屋、退去済みのため現在ご内覧可能です！！ YUMAさんご都合よろしいお日にちにお部屋ご案内させて頂きます！！ お気軽にお申し付けください😊！！";
const s1 = splitSentences(b1);
t("！！で分ける・絵文字は前の文に付く", s1.length === 4 && s1[3] === "お気軽にお申し付けください😊！！", s1);
const b2 = "【AIX】かしこまりました！！\n9/19（土）ご案内させて頂きます！！\n\n住所: 大阪府大阪市〈住所〉";
const s2 = splitSentences(b2);
t("改行で分ける・【AIX】は残す・空行は捨てる", s2.length === 3 && s2[0].startsWith("【AIX】") && s2[2].startsWith("住所"), s2);
t("絵文字だけの行は前に付ける", splitSentences("ありがとうございます！！\n😊").length === 1);
t("。でも分ける", splitSentences("10月中以降ご内覧出来ます。お申込みで抑える事もできます。").length === 2);

const r = parseRoles('{"roles":[{"i":1,"role":"greet","why":"挨拶"},{"i":2,"role":"answer","why":"問いに答える"},{"i":3,"role":"viewing","why":"内覧へ"},{"i":4,"role":"close","why":"締め"},{"i":9,"role":"answer"},{"i":2,"role":"zzz"}],"main_role":"answer","lead_to":"viewing","background":"内覧可能を答えて内覧へ"}', 4);
t("読み取り（範囲外・一覧外は捨てる）", !!r && r.roles.length === 4 && r.main_role === "answer" && r.lead_to === "viewing", r);
t("壊れた JSON は null", parseRoles("x", 3) === null && parseRoles('{"roles":[]}', 3) === null);
const r2 = parseRoles('{"roles":[{"i":1,"role":"greet"},{"i":2,"role":"answer"},{"i":3,"role":"trust"},{"i":4,"role":"close"}],"main_role":"answer","lead_to":"answer_only"}', 4);
const r3 = parseRoles('{"roles":[{"i":1,"role":"greet"},{"i":2,"role":"worry"},{"i":3,"role":"keep"},{"i":4,"role":"close"}],"main_role":"answer","lead_to":"viewing"}', 4);
const m = majorityRoles([r, r2, r3], 4);
t("文ごとの多数・割れた文は null", m.roles[1].role === "answer" && m.roles[2].role === null && m.splitSentences === 1 && m.lead_to === "viewing" && m.main_role === "answer", m);
t("読めなかった回を数える（割れと分ける）", m.failedReads === 0 && majorityRoles([r, null, null], 4).failedReads === 2 && majorityRoles([r, null, null], 4).splitSentences === 4);
t("境目の決まり（全力サポート＝trust・途中で切れた行・お気軽に＋対象）", ROLES_SYSTEM.includes("全力でサポートさせて頂きます」「最善のサポート」はサポートの姿勢＝trust") && ROLES_SYSTEM.includes("文の途中で切れた行") && ROLES_SYSTEM.includes("何も付いていなければ close") && !/全力でサポート＝keep/.test(ROLES_SYSTEM));
t("埋まる可能性は状況による（barrier に固定しない・c44d2b50）", ROLES_SYSTEM.includes("状況で役目が変わる（固定しない）") && /埋まる可能性[^。]*worry/.test(ROLES_SYSTEM) && /埋まる可能性[^。]*barrier/.test(ROLES_SYSTEM) && !/barrier は[^。]*埋まる可能性/.test(ROLES_SYSTEM));
t("外の LLM の直前に名乗った本名を伏せる（客の発言と竹内さんの文の両方）", (() => { const p = rolesPrompt({ maskedCustomer: "山田花です！", sentences: ["山田花さんお世話になっております！！", "何卒よろしくお願い致します！！"], scene: "other" }); return !p.includes("山田花") && p.includes("1. YUMAさんお世話になっております！！") && p.includes("2. 何卒"); })());
t("多数の役目と同じ回の why", m.roles[1].why === "問いに答える", m.roles[1]);
t("並びの型（続く同じは1つ）", rolePattern(["greet", "answer", "answer", "viewing", "close"]) === "greet>answer>viewing>close");
const c = compareRoles(["greet", "answer", "barrier", "apply", "close"], ["uke", "answer", "apply", "trust", "close"]);
t("比べ: 欠け・余分（挨拶・受け・締めは数えない）", c.missing.join() === "barrier" && c.extra.join() === "trust" && !c.orderDiff && !c.same, c);
t("比べ: 順番の違い", compareRoles(["answer", "viewing"], ["viewing", "answer"]).orderDiff);
t("比べ: 同じ", compareRoles(["greet", "answer", "close"], ["uke", "answer"]).same);
t("指示と材料", ROLES_SYSTEM.includes("barrier") && rolesPrompt({ maskedCustomer: "内覧できますか", sentences: s1, scene: "viewing" }).includes("2. 2階のお部屋"));

console.log(`takeuchi-anatomy-roles: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
