// app/lib/__tests__/aix-brought-prefill.test.ts — 物件確認した を開いた時の物件名・件数の初期値（実行: npx tsx app/lib/__tests__/aix-brought-prefill.test.ts）
//   名前は 90日の監査（10/28）で台帳に混ざっていた実物の形
import { broughtForCheck, cleanBroughtName, broughtMaterialLine, aixBroughtPrefillEnabled, orderByCustomerText, aixEstimatePrefillEnabled, checkResultFormMaterial, aixCheckFormMaterialEnabled } from "../aix-brought-prefill";
import type { PropertyThreadState } from "../property-thread";
import { buildSecondMaterialNote } from "../second-message-scene";

let pass = 0, fail = 0;
const withEnv = <T>(k: string, v: string | undefined, f: () => T): T => { const old = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { return f(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; } };
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

const room = (display: string, events: Array<{ at: string; kind: string; text?: string }>, origin: "ours" | "customer" = "customer") =>
  ({ key: display, ref: { display } as never, names: [display], events: events.map((e) => ({ by: "named", ...e })) as never, sentByUs: origin === "ours", origin });
const st = (rooms: ReturnType<typeof room>[]): PropertyThreadState => ({ rooms: rooms as never, turnTargets: [] });

// 名前の掃除
t("普通の物件名はそのまま", cleanBroughtName("フォーリアライズ京橋 404号室") === "フォーリアライズ京橋 404号室");
t("先頭の記号を外す", cleanBroughtName("# サニーコート西川2 102号室") === "サニーコート西川2 102号室");
t("▼ を外す", cleanBroughtName("▼ShaMaison Nonno") === "ShaMaison Nonno");
t("戸建ての末尾の 1- を外す", cleanBroughtName("中川西1丁目戸建 1-") === "中川西1丁目戸建");
t("末尾の . を外す", cleanBroughtName("Mv.imp大阪放出.") === "Mv.imp大阪放出");
t("ポータルの見出しは頭の物件名", cleanBroughtName("ラボルトヴィタ 1K/5階(大阪府大阪市東成区/玉造駅)の賃貸") === "ラボルトヴィタ");
for (const junk of ["(thanks)", "あと、こちらの物件も見積もり出していただきたいです💦", "（室内イメージ）", "パンジー支店", "桜川1LDK+S", "桜川 1K", "物件①", "物件名 208号室", "アプリ上でご覧いただけます", "前家賃だけ", "マンション 903号室", "ソース: 積水ハウスの賃貸住宅シャーメゾン", "下記の物件を調べて頂けますでしょうか", "JR東海道本線/千里丘駅 歩5分", ""]) {
  t(`物件名でない: ${junk}`, cleanBroughtName(junk) === null, cleanBroughtName(junk));
}

// まだ確認の結果を返していない持ち込みだけ・送ってきた順
{
  const s = st([
    room("エスライズ難波 802号室", [{ at: "2026-10-20T10:00:00Z", kind: "customer_shared" }]),
    room("アドバンス難波南ワイズ 601号室", [{ at: "2026-10-20T10:01:00Z", kind: "customer_shared" }]),
    room("オーロラ・タワー難波 202号室", [{ at: "2026-10-18T10:00:00Z", kind: "customer_shared" }, { at: "2026-10-19T10:00:00Z", kind: "check_available" }]),
    room("こちらが送った物件 101号室", [{ at: "2026-10-20T09:00:00Z", kind: "sent" }], "ours"),
  ]);
  const p = broughtForCheck(s);
  t("確認済みとこちらが送った物件は入れない・2件", p.count === 2, p);
  t("送ってきた順", p.rooms.map((r) => r.name).join(",") === "エスライズ難波 802号室,アドバンス難波南ワイズ 601号室", p.rooms);
  // AIX【物件確認した】を送った時刻（物件名の記録が空）より前の持ち込みは入れない
  const p2 = broughtForCheck(s, { checkAts: ["2026-10-20T10:00:30Z"] });
  t("物件確認した を送った後の持ち込みだけ", p2.count === 1 && p2.rooms[0].name === "アドバンス難波南ワイズ 601号室", p2);
}
{
  // 名前が読めない持ち込みは数にだけ入れる（推測で入れない）
  const s = st([room("物件①", [{ at: "2026-10-20T10:00:00Z", kind: "customer_shared" }]), room("グランドウール敦津 903号室", [{ at: "2026-10-20T10:02:00Z", kind: "customer_shared" }])]);
  const p = broughtForCheck(s);
  t("名前が読めない物は null で数える", p.count === 2 && p.rooms[0].name === null && p.rooms[1].name === "グランドウール敦津 903号室", p);
  t("材料の1段に件数と名前", /2件/.test(broughtMaterialLine(p)) && /グランドウール敦津/.test(broughtMaterialLine(p)) && /物件名が読めない/.test(broughtMaterialLine(p)));
}
{
  // 古い持ち込み（一番新しい持ち込みから 72時間より前）は混ぜない
  const s = st([room("古い物件", [{ at: "2026-10-01T10:00:00Z", kind: "customer_shared" }]), room("新しい物件", [{ at: "2026-10-20T10:00:00Z", kind: "customer_shared" }])]);
  t("72時間より前の持ち込みは入れない", broughtForCheck(s).count === 1);
}
t("台帳が無い時は0件", broughtForCheck(null).count === 0);
t("材料は0件なら空", broughtMaterialLine({ rooms: [], count: 0, lastCheckAt: null }) === "");
t("スイッチ既定 off", aixBroughtPrefillEnabled({}) === false && aixBroughtPrefillEnabled({ NEXT_PUBLIC_AIX_BROUGHT_PREFILL: "on" }) === true);

// 見積書の枠: お客様が書いた順（#4 未来穂 10/22 の形・名前は実物）
{
  const cust = "レジュールアッシュOSAKAディフィール 807と、グランドロアール上新庄 402、Live Casa上新庄 0102の見積もりお願いします";
  const handoffOrder = ["Live Casa上新庄 0102号室", "レジュールアッシュOSAKAディフィール 807号室", "グランドロアール上新庄 402号室", "Live Casa上新庄 0102号室"];
  const o = orderByCustomerText(handoffOrder, cust);
  t("お客様が書いた順・重複なし", o.join(",") === "レジュールアッシュOSAKAディフィール 807号室,グランドロアール上新庄 402号室,Live Casa上新庄 0102号室", o);
  t("文に無い物は後ろ", orderByCustomerText(["別の物件 101号室", "グランドロアール上新庄 402号室"], cust).join(",") === "グランドロアール上新庄 402号室,別の物件 101号室");
  t("最大3件", orderByCustomerText(["a物件", "b物件", "c物件", "d物件"], "").length === 3);
  t("見積書の先入れは既定 off", aixEstimatePrefillEnabled({}) === false);
}

// 竹内さんの文の型の材料
{
  const a = checkResultFormMaterial({ pattern: "available", hasEstimate: false });
  t("物件あった: ご査収・ご案内が多数・申込の締めは申込が入りそうな時だけ", /ご査収/.test(a) && /申込・抑えたいと言った時/.test(a));
  t("見積書が無い時は見積の約束をしない", /約束も書かない/.test(a));
  t("見積書がある時は見積の約束の行は無い", !/約束も書かない/.test(checkResultFormMaterial({ pattern: "available", hasEstimate: true })));
  t("物件なかった: 1文で終える", /1文で終える/.test(checkResultFormMaterial({ pattern: "unavailable", hasEstimate: false })));
  t("管理会社に確認した等は空", checkResultFormMaterial({ pattern: "mgmt_parking", hasEstimate: false }) === "");
  t("型の材料は既定 off", aixCheckFormMaterialEnabled({}) === false);
}

// 物件オススメの2通目: ご希望に合わない点（資料で確かめた物）を書く役に渡す（RECOMMEND_SECOND_WISH_NG）
{
  const row = { equipment: { match: [{ label: "ペット可", result: "ng" }, { label: "独立洗面台", result: "ok" }] } } as never;
  const off = withEnv("RECOMMEND_SECOND_WISH_NG", undefined, () => buildSecondMaterialNote(row));
  const on = withEnv("RECOMMEND_SECOND_WISH_NG", "on", () => buildSecondMaterialNote(row));
  t("off: 合わない点は材料に無い（従来）", !/合わない点/.test(off) && /独立洗面台/.test(off));
  t("on: 合わない点を先に正直に書く材料", /ご希望に合わない点（資料で確かめた物）: ペット可/.test(on) && /御座いませんが/.test(on));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
