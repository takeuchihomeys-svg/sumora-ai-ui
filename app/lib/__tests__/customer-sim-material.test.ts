// app/lib/__tests__/customer-sim-material.test.ts
// お客様役のスタッフ役が AIX を送る時の材料の選び方（customer-sim-material.ts）と、planStaffAction の広げ方の固定。
// 2026-09-27 竹内「ほかにも見積書や物件資料は保存されてると思うから使いながらためしていく／AIXもテストでおくるかたちにする」
// 実行: npx tsx app/lib/__tests__/customer-sim-material.test.ts（全 PASS で exit 0・DB にはつながない）
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

async function main() {
  const mat = await import("../customer-sim-material");
  const sim = await import("../customer-sim");
  const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
  // 2026-09-27 10:00 JST（日曜）
  const NOW = Date.parse("2026-09-27T01:00:00Z");

  // 実物（YUMA の保存済みの見積書 estimate_records 264・送った本文）
  const EST_264 = {
    recordId: 264, conversationId: CONV, propertyName: "エステムコート大阪WEST", roomNo: null, initialCostYen: 137980, discountYen: 124050,
    imageUrl: "https://example.invalid/aix/est.jpeg",
    sentText: "【エステムコート大阪WEST】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円\n\nスモラなら一般的な不動産業者より269,570円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
    estimatedAt: "2026-09-27T01:13:12Z",
  };
  const PICK = (id: number, name: string, room: string | null, o: Partial<import("../customer-sim-material").SimPickupSource> = {}) => ({
    id, propertyName: name, roomNo: room, imageUrl: `https://example.invalid/trim/${id}.jpg`, pdfUrl: null, summaryText: `【${id}】${name}`, address: null,
    rank: id, status: "pending", sentAt: null, completeGroupId: "cg_509cd061_661", batchId: "物件まとめ_x.pdf", ...o,
  });
  const basePool = (o: Partial<import("../customer-sim-material").SimMaterialPool> = {}): import("../customer-sim-material").SimMaterialPool => ({
    conversationId: CONV,
    estimates: [EST_264],
    pickups: [
      PICK(678, "エステムコート大阪WEST", null, { status: "sent", sentAt: "2026-09-26T17:03:00Z", address: "大阪府大阪市西区九条南1丁目" }),
      PICK(681, "エステムコート難波WEST-SIDE IV ザ・フォース", null),
      PICK(675, "エステムコート阿波座プレミアム", null),
      PICK(663, "エステムコート中之島GATEⅡ", null, { imageUrl: null }),
      PICK(677, "エステムコートディアシティWEST", null),
    ],
    sentPropertyNames: ["エステムコート大阪WEST", "エステムコート難波WEST-SIDEⅨレデント 404", "S-FORT大正リヴィエール 603"],
    focusPropertyName: "エステムコート大阪WEST",
    history: [
      { sender: "customer", text: "エステムコート大阪WESTの初期費用っていくらくらいになりますか？" },
      { sender: "staff", text: EST_264.sentText },
    ],
    nowMs: NOW,
    ...o,
  });

  console.log("── 見積書（保存済みの値だけ）");
  {
    const p = mat.pickEstimate(basePool());
    t("主のお部屋の保存済みの見積書を選ぶ", p.ok && p.material.kind === "estimate" && p.material.recordId === 264);
    const other = mat.pickEstimate(basePool({ focusPropertyName: "S-FORT大正リヴィエール" }));
    t("★ 主のお部屋の見積書が無ければ止める（別の物件の見積書を流用しない）", !other.ok && /S-FORT/.test(other.ok ? "" : other.reason));
    const none = mat.pickEstimate(basePool({ estimates: [] }));
    t("見積書が無ければ止めて理由", !none.ok && /見積書が無い/.test(none.ok ? "" : none.reason));
    const noImg = mat.pickEstimate(basePool({ estimates: [{ ...EST_264, imageUrl: null }] }));
    t("★ 画像が無い見積書は使わない", !noImg.ok);
    const noAmt = mat.pickEstimate(basePool({ estimates: [{ ...EST_264, initialCostYen: null }] }));
    t("★ 金額が無い見積書は使わない（創作しない）", !noAmt.ok);
    const otherConv = mat.pickEstimate(basePool({ estimates: [{ ...EST_264, conversationId: "0b5c3f6e-1111-4222-8333-444455556666" }] }));
    t("★ 他の会話（他のお客様）の見積書は使わない", !otherConv.ok);

    // 生成の本文の物件名を保存済みの名前へ（画像の建物名を読んだ時の手直し）
    const gen = "【コンフォリア・リヴ博労町一丁目Q 406号室】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円\n\nスモラなら一般的な不動産業者より269,570円節約出来ます！！";
    const a = mat.alignEstimateText(gen, { propertyName: "エステムコート大阪WEST", initialCostYen: 137980, discountYen: 124050 });
    t("画像の建物名は保存済みの名前にそろえる（手直し＝edited）", !!a && a.edited && a.text.startsWith("【エステムコート大阪WEST】") && a.text.includes("137,980円"), JSON.stringify(a));
    const same = mat.alignEstimateText(EST_264.sentText, { propertyName: "エステムコート大阪WEST", initialCostYen: 137980, discountYen: 124050 });
    t("同じ名前なら手直ししない", !!same && !same.edited && same.text === EST_264.sentText);
    const wrong = mat.alignEstimateText(gen.replace("137,980", "173,980"), { propertyName: "エステムコート大阪WEST", initialCostYen: 137980, discountYen: 124050 });
    t("★ 金額が保存済みと食い違えば送らない（null）", wrong === null);
    const wrongDisc = mat.alignEstimateText(gen.replace("124,050", "24,050"), { propertyName: "エステムコート大阪WEST", initialCostYen: 137980, discountYen: 124050 });
    t("★ 割引が食い違っても送らない", wrongDisc === null);
  }

  console.log("── ピックアップ（保存済み・送っていない物）");
  {
    const p = mat.pickPickups(basePool(), 3);
    const ids = p.ok && p.material.kind === "pickups" ? p.material.items.map((x) => x.id) : [];
    t("送っていない・画像のある物を点の順に3件", JSON.stringify(ids) === JSON.stringify([681, 675, 677]), JSON.stringify(ids));
    t("★ 送った物（status=sent・送った物件の名前）は選ばない", !ids.includes(678));
    t("★ 画像の無い物は選ばない", !ids.includes(663));
    const one = mat.pickPickups(basePool(), 1);
    t("物件オススメは1件", one.ok && one.material.kind === "pickups" && one.material.items.length === 1);
    const empty = mat.pickPickups(basePool({ pickups: [] }));
    t("ピックアップが無ければ止める", !empty.ok);
    const used = mat.pickPickups(basePool({ pickups: [PICK(1, "A棟", null, { status: "sent" })] }));
    t("全部送っていれば止める", !used.ok && /残っていない/.test(used.ok ? "" : used.reason));
  }

  console.log("── 資料の所在地");
  {
    const pdf = "物件名 エステムコート難波WEST-SIDEIXレデント\n号室名 404（4階部分）\n所在地\n大阪府大阪市大正区三軒家東２丁目2-22\n〒551-0002";
    t("「所在地」の次の行", mat.addressFromPdfText(pdf) === "大阪府大阪市大正区三軒家東２丁目2-22");
    t("同じ行の形", mat.addressFromPdfText("所在地：大阪市西区九条南1-2-3") === "大阪市西区九条南1-2-3");
    t("所在地が無ければ null（創作しない）", mat.addressFromPdfText("物件名 X") === null && mat.addressFromPdfText(null) === null);
  }

  console.log("── 物件確認した（募集中の設定）");
  {
    const p = mat.pickCheckResult(basePool(), null);
    t("主のお部屋を 募集中/available で・資料は同じ建物のピックアップ", p.ok && p.material.kind === "check_result" && p.material.propertyName === "エステムコート大阪WEST" && p.material.checkPattern === "available" && p.material.pickupId === 678, JSON.stringify(p));
    const other = mat.pickCheckResult(basePool(), "mgmt_guarantor");
    t("★ 管理会社の回答が要る型（mgmt_*）は止める", !other.ok);
    const noProp = mat.pickCheckResult(basePool({ focusPropertyName: null, sentPropertyNames: [] }), "available");
    t("物件が決まっていなければ止める", !noProp.ok);
    const fallback = mat.pickCheckResult(basePool({ focusPropertyName: null }), null);
    t("主のお部屋が無ければ直近に送った物件", fallback.ok && fallback.material.kind === "check_result" && fallback.material.propertyName === "エステムコート大阪WEST");
  }

  console.log("── 日時の読み取り（明日以降だけ）");
  {
    const d1 = mat.extractDateMentions("今週の土曜の午後か日曜の午前はどうですか？", NOW);
    t("曜日＋午前午後（9/27 日曜 → 土曜=10/3・日曜=10/4）", d1.length === 2 && d1[0].ymd === "2026-10-03" && d1[0].ampm === "pm" && d1[1].ymd === "2026-10-04" && d1[1].ampm === "am", JSON.stringify(d1));
    const d2 = mat.extractDateMentions("10/3の14時でお願いします", NOW);
    t("月日＋時刻", d2.length === 1 && d2[0].ymd === "2026-10-03" && d2[0].time === "14:00" && d2[0].label === "10/3(土)", JSON.stringify(d2));
    const d3 = mat.extractDateMentions("明日の午後2時半で", NOW);
    t("明日＋午後2時半 → 14:30", d3.length === 1 && d3[0].ymd === "2026-09-28" && d3[0].time === "14:30", JSON.stringify(d3));
    const d4 = mat.extractDateMentions("9/27 11:00", NOW);
    t("★ 今日・過去の日は採らない", d4.length === 0, JSON.stringify(d4));
    const d5 = mat.extractDateMentions("１０月５日（月）１１：００〜", NOW);
    t("全角も読む", d5.length === 1 && d5[0].ymd === "2026-10-05" && d5[0].time === "11:00", JSON.stringify(d5));
    const d6 = mat.extractDateMentions("家賃7万くらいで探してます", NOW);
    t("日時の無い文は空", d6.length === 0);
    const fx = mat.fixedViewingSlots(NOW);
    // 2026-10-02 竹内「直近は基本3候補いれる」→ 固定の候補も3つ
    t("固定の候補は明日・明後日・3日後", fx.length === 3 && fx[0].label === "9/28(月)" && fx[1].label === "9/29(火)" && fx[2].label === "9/30(水)", JSON.stringify(fx));
  }

  console.log("── 内覧へ！・待ち合わせ");
  {
    const v = mat.pickViewingSlots(basePool({ history: [{ sender: "customer", text: "土曜の午後か日曜の午前で内覧したいです" }] }));
    t("お客様が出した候補を使う", v.ok && v.material.kind === "viewing_slots" && v.material.source === "conversation" && v.material.slots[0].label === "10/3(土)" && v.material.slots[0].start === "14:00");
    const vf = mat.pickViewingSlots(basePool());
    t("候補が無ければ固定の候補（明日以降）", vf.ok && vf.material.kind === "viewing_slots" && vf.material.source === "fixed");
    const m = mat.pickMeeting(basePool({ history: [{ sender: "staff", text: "10/3(土) 14:00〜17:00 ご案内可能です" }, { sender: "customer", text: "10/3の15時でお願いします" }] }));
    t("お客様が選んだ日時と主のお部屋・資料の住所", m.ok && m.material.kind === "meeting" && m.material.date === "10/3(土)" && m.material.time === "15:00" && m.material.propertyName === "エステムコート大阪WEST" && m.material.address === "大阪府大阪市西区九条南1丁目", JSON.stringify(m));
    const ms = mat.pickMeeting(basePool({ history: [{ sender: "staff", text: "10/3(土) 14:00〜17:00 ご案内可能です" }, { sender: "customer", text: "その日でお願いします" }] }));
    t("お客様が時刻を言わなければ、こちらの候補の最初", ms.ok && ms.material.kind === "meeting" && ms.material.date === "10/3(土)" && ms.material.time === "14:00", JSON.stringify(ms));
    const mn = mat.pickMeeting(basePool({ focusPropertyName: null, sentPropertyNames: [] }));
    t("物件が決まっていなければ止める", !mn.ok);
    const text = mat.buildMeetingPlaceText({ date: "10/3(土)", time: "15:00", propertyName: "エステムコート大阪WEST", address: null });
    t("待ち合わせの文（画面の時間ありの形）", text === "かしこまりました！！\n10/3（土）ご案内させて頂きます！！\n\n10/3 15:00にエステムコート大阪WEST\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！", text);
    const modal = readFileSync("app/components/AixModal.tsx", "utf8");
    t("★ 画面（AixModal の meeting_place・時間あり）の文面と一字一句同じ型", modal.includes("let msg = `かしこまりました！！\\n${meetingDateFixed}ご案内させて頂きます！！\\n\\n${meetingDateNoWd} ${meetingTime}に${meetingPropertyName}\\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！`;") && modal.includes("if (meetingPropertyAddress.trim()) msg += `\\n住所: ${meetingPropertyAddress}`;"));
  }

  console.log("── 材料の選び方のまとめ・planStaffAction");
  {
    const pool = basePool();
    t("止める AIX は理由つき（管理会社宛て・電話・入力が無い）", ["acknowledge_check", "cost_explain", "cost_breakdown", "guarantor_info", "phone_call", "phone_followup"].every((a) => { const r = mat.pickSimMaterial(a, null, pool); return !r.ok && r.reason.length > 5; }));
    t("知らない AIX も止める", !mat.pickSimMaterial("something_new", null, pool).ok);
    const pe = sim.planStaffAction({ action: "estimate_sheet", reply_mode: "aix" }, pool);
    t("★ 材料が揃う AIX は aix_material（見積書）", pe.kind === "aix_material" && pe.material.kind === "estimate");
    const pc = sim.planStaffAction({ action: "property_check_result", reply_mode: "aix", check_pattern: null }, pool);
    t("物件確認した は check_pattern=available で送る", pc.kind === "aix_material" && pc.checkPattern === "available");
    const pn = sim.planStaffAction({ action: "guarantor_info", reply_mode: "aix" }, pool);
    t("★ 揃わない物は止めて理由（aix_needs_material・reason）", pn.kind === "aix_needs_material" && pn.reason.length > 0);
    const noPool = sim.planStaffAction({ action: "estimate_sheet", reply_mode: "aix" });
    t("材料の候補を渡さなければ従来どおり止める", noPool.kind === "aix_needs_material");
    t("会話だけの AIX は材料に関係なく aix", sim.planStaffAction({ action: "greeting_viewing", reply_mode: "aix" }, pool).kind === "aix");
    t("AIX なしは下書き", sim.planStaffAction({ action: null, reply_mode: "auto_reply" }, pool).kind === "draft");
  }

  console.log("── 記録と検査（使った材料）");
  {
    const est = mat.pickEstimate(basePool());
    const m = est.ok ? est.material : null;
    t("使った材料の1行", !!m && /見積書#264.*137,980円.*124,050円/.test(mat.describeSimMaterial(m)), m ? mat.describeSimMaterial(m) : "");
    t("見積書の文に入るべき事実は初期費用", !!m && JSON.stringify(mat.mustShowOfMaterial(m)) === JSON.stringify(["137,980円"]));
    const okAudit = sim.auditSimTurn({ sentText: EST_264.sentText, historyBefore: [], groundingExtra: m ? mat.groundingOfMaterial(m) : [], materialMustShow: m ? mat.mustShowOfMaterial(m) : [] });
    t("★ 保存済みの金額で送った見積書は創作にも取りこぼしにもならない", okAudit.length === 0, JSON.stringify(okAudit));
    const miss = sim.auditSimTurn({ sentText: "御見積書お送りさせて頂きます！！", historyBefore: [], materialMustShow: ["137,980円"] });
    t("★ 材料の金額が文に無ければ 材料の取りこぼし", miss.some((f) => f.kind === "material_missing"));
    const mt = { kind: "meeting" as const, date: "10/3(土)", time: "15:00", propertyName: "エステムコート大阪WEST", address: null, source: "conversation" as const };
    const mtAudit = sim.auditSimTurn({ sentText: mat.buildMeetingPlaceText(mt), historyBefore: [], groundingExtra: mat.groundingOfMaterial(mt), materialMustShow: mat.mustShowOfMaterial(mt) });
    t("待ち合わせの文は材料の日時・物件で検査が通る", mtAudit.length === 0, JSON.stringify(mtAudit));
  }

  console.log(`\n合計: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
