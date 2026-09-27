// app/lib/__tests__/customer-sim-shadow.test.ts
// お客様役の「影の道」（customer-sim-shadow.ts）の固定。文は本番の実物（生成の下書き・スタッフの送信・お客様役の送信）をそのまま使う（名前は伏せた）。
// 2026-09-27 竹内「YUMAとLINEする際AIXもくみあわせておこなう／返信もAIXも仮定して送る形でズレなくしていく」
// 実行: npx tsx app/lib/__tests__/customer-sim-shadow.test.ts（全 PASS で exit 0・DB にはつながない）
export {}; // モジュールにする（import/export の無いファイル同士で t / main がぶつからないように）
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

async function main() {
  const s = await import("../customer-sim-shadow");
  const kinds = (fs: ReadonlyArray<{ kind: string }>) => fs.map((f) => f.kind).join(",");

  console.log("■ こちらの文が何をしているか（staffActsOf）");
  {
    const a = s.staffActsOf("〇〇さん 最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！ 7万円台のお部屋も並行してピックアップさせて頂きます");
    t("見積書を送る宣言＋ピックアップの宣言", a.has("estimate_promise") && a.has("pickup_promise"));
    t("募集状況の確認の宣言", s.staffActsOf("お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！").has("check_promise"));
    t("管理会社への確認の宣言", s.staffActsOf("海外在住で収入証明がない場合の審査可否につきましては、管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます😊！！").has("check_promise"));
    t("見積書のカバー文", s.staffActsOf("エグゼ大阪 BAY CITY 201号室最大限割引しました初期費用の御見積書となります！！ お手隙の際にご査収ください😌！！").has("estimate_cover"));
    t("見積の金額（AIX の本文）", s.staffActsOf("【エステムコート大阪WEST】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円").has("cost_amount"));
    t("家賃だけ（初期費用の金額でない）は金額にしない", !s.staffActsOf("家賃管理費込67,000円の1K、敷金礼金なし・角部屋でかなりオススメ出来るお部屋となります！！").has("cost_amount"));
    t("物件の紹介の「敷金礼金なし・保証会社」は中身の説明にしない", !s.staffActsOf("🌟サンシャイン御幸 402号室 敷金礼金なし・収納たっぷりの2DK").has("cost_items"));
    t("中身の説明（日割・前家賃が別途）", s.staffActsOf("初期費用とは別に発生いたします😊！！ ②8月分の日割家賃 ③9月分の前家賃：1ヶ月分 ②と③が見積書とは別に発生する形となります！！").has("cost_items"));
    t("条件受付の「審査が通りやすい独立系保証会社」は保証会社名にしない",
      !s.staffActsOf("審査に不安がある場合は、審査が通りやすい独立系保証会社を使用している物件を中心にピックアップさせて頂きますので").has("guarantor_detail"));
    t("保証会社名（全保連・Casa）は保証会社名", s.staffActsOf("審査に柔軟な独立系保証会社（全保連・Casa・ジェイリース等）を使用している物件を優先的に").has("guarantor_detail"));
    t("内覧の候補日時", s.staffActsOf("かしこまりました！！ 9/12(土)12:00〜14:00の枠でしたら、ご案内可能です😊！！").has("viewing_datetime"));
    t("お客様役の内覧へ！の本文は候補日時", s.staffActsOf("直近ですと\n10/3(土) 14:00〜17:00\n10/4(日) 10:30〜12:30にてご案内可能です😌！！").has("viewing_datetime"));
    t("待ち合わせの本文は場所・住所", s.staffActsOf("10/4 10:30にエステムコート大阪WEST\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市西区九条１丁目19-10").has("meeting_detail"));
    t("室内写真の撮影の約束", s.staffActsOf("3件とも室内写真撮影して参りますので、少しお時間頂けますと幸いです！！").has("photo"));
    t("本人確認書類の写真は室内の写真にしない", !s.staffActsOf("ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください！！").has("photo"));
    t("申込フォーム本体", s.staffActsOf("お申込みフォーマットご入力頂けますでしょうか😊！！ 【お申込者様記入欄】 ・入居希望日 ・氏名、フリガナ ・生年月日").has("apply_form"));
    t("②の案内（本人確認書類）はフォーム本体でない", !s.staffActsOf("こちらお申込に必要なご情報となります😊！！ 上記フォーマットご入力いただき、ご本人確認書類として運転免許証…").has("apply_form"));
    t("募集中の断言", s.staffActsOf("A602号室は今月末退去予定で現在募集中となります😊！！").has("vacancy_assert"));
    t("「まだ募集中ですか？」（お客様の問い）は断言にしない", !s.staffActsOf("エステムコート大阪WESTってまだ募集中ですか？").has("vacancy_assert"));
    t("時刻つきの電話の約束", s.staffActsOf("もちろんです！明日17時にお電話させていただきます😊").has("phone_promise"));
  }

  console.log("■ AIX の番: 影の下書き × 選んだ AIX");
  {
    // 実物（180日・AIX【物件ピックアップした】の番の生成の下書き → スタッフは「ピックアップ」に書き換えた）
    const f1 = s.judgeShadowTurn({ chosen: "aix", aix: { action: "property_send", checkPattern: null, text: "…ピックアップさせて頂きました！！" },
      draftText: "かしこまりました！！ 最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！ 何卒よろしくお願い致します😊！！" });
    t("物件ピックアップの番に見積書の宣言 → 別の道", kinds(f1) === "draft_conflicts_aix", kinds(f1));
    // 条件つき（スタッフが送った形）は別の道にしない
    const f2 = s.judgeShadowTurn({ chosen: "aix", aix: { action: "property_send", checkPattern: null, text: null },
      draftText: "9月中旬でのご入居に向けて心斎橋・難波徒歩圏内のお部屋新着状況確認させて頂きます！！ お気に召されましたお部屋、初期費用も最大限割引させていただいた御見積書作成しお送りさせて頂きます😊！！" });
    t("「お気に召されましたお部屋…御見積書」（条件つき）は別の道にしない", !f2.some((f) => f.kind === "draft_conflicts_aix"), kinds(f2));
    // 見積書送るの番の確認の宣言: こちらの送ったお部屋の時だけ
    const draftCheck = "かしこまりました！！ 募集状況・初期費用確認させて頂きます！！確認出来次第ご連絡させて頂きます！！";
    t("見積書送る×確認の宣言（こちらが送ったお部屋）→ 別の道",
      s.judgeShadowTurn({ chosen: "aix", aix: { action: "estimate_sheet", checkPattern: null, text: null }, draftText: draftCheck, focusSentByUs: true }).some((f) => f.kind === "draft_conflicts_aix"));
    t("見積書送る×確認の宣言（お客様の持ち込み）→ 別の道にしない（募集状況確認＋見積書が正しい）",
      !s.judgeShadowTurn({ chosen: "aix", aix: { action: "estimate_sheet", checkPattern: null, text: null }, draftText: "お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", focusSentByUs: false }).length);
    // 二重（AIX の申込フォームを下書きも書く・スタッフは消した）
    const f3 = s.judgeShadowTurn({ chosen: "aix", aix: { action: "application_push", checkPattern: null, text: null },
      draftText: "かしこまりました！！ 702号室お申込み進めさせて頂きます！！ お申込みフォーマットご入力頂けますでしょうか😊！！ 【お申込者様記入欄】 ・入居希望日 ・氏名、フリガナ" });
    t("申込へ×フォーム本体 → 二重", kinds(f3) === "draft_does_aix_job", kinds(f3));
    // 待ち合わせの番に日程を聞き直す
    const f4 = s.judgeShadowTurn({ chosen: "aix", aix: { action: "meeting_place", checkPattern: null, text: null },
      draftText: "かしこまりました！！ YUMAさんご都合よろしいお日にち御座いますでしょうか！！" });
    t("待ち合わせ×日程を聞く → 別の道", f4.some((f) => f.kind === "draft_conflicts_aix"), kinds(f4));
    // 見積書の橋渡し（宣言）は正しい
    t("見積書送る×「御見積しお送りさせて頂きます」（橋渡し）→ ズレなし",
      s.judgeShadowTurn({ chosen: "aix", aix: { action: "estimate_sheet", checkPattern: null, text: null }, draftText: "かしこまりました！！ 最大限割引しました初期費用御見積し送らせて頂きます😊！！", focusSentByUs: true }).length === 0);
  }

  console.log("■ AIX の番: AIX の後の一言");
  {
    const est = "【エステムコート大阪WEST】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円\n\nスモラなら一般的な不動産業者より269,570円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";
    const f = s.judgeShadowTurn({ chosen: "aix", aix: { action: "estimate_sheet", checkPattern: null, text: est }, draftText: null, followupSent: false });
    t("お客様役の見積書送る（本文だけ・一言なし）→ AIX の後の一言が無い", kinds(f) === "aix_followup_missing", kinds(f));
    t("一言を送っていれば出さない", s.judgeShadowTurn({ chosen: "aix", aix: { action: "estimate_sheet", checkPattern: null, text: est }, draftText: null, followupSent: true }).length === 0);
    t("followupSent を渡さない（不明）時は出さない", s.judgeShadowTurn({ chosen: "aix", aix: { action: "estimate_sheet", checkPattern: null, text: est }, draftText: null }).length === 0);
    t("内覧へ（一言を添えないのが普通・8%）は出さない",
      s.judgeShadowTurn({ chosen: "aix", aix: { action: "viewing_invite", checkPattern: null, text: "直近ですと…" }, draftText: null, followupSent: false }).length === 0);
    t("物件ピックアップした（58%・AIX の2通目と見分けられない）は表に入れていない", !s.AIX_FOLLOWUP_RATE.property_send);
  }

  console.log("■ 下書きの番: 送った下書き × 影の候補");
  {
    const vi = [{ action: "viewing_invite", checkPattern: null, source: "scene" as const }];
    const f1 = s.judgeShadowTurn({ chosen: "draft", candidates: vi, draftText: "かしこまりました！！ 9/12(土)12:00〜14:00の枠でしたら、〇〇様にご案内可能です😊！！ 〇〇様のご都合よろしいか、ご確認いただけますでしょうか！！" });
    t("内覧の場面の下書きが候補日時を書いた → 本来 AIX", kinds(f1) === "draft_does_aix_job", kinds(f1));
    const ph = [{ action: "property_check_result", checkPattern: "interior_photo", source: "scene" as const }];
    const f2 = s.judgeShadowTurn({ chosen: "draft", candidates: ph, draftText: "かしこまりました😊！！ 3件とも室内写真撮影して参りますので、少しお時間頂けますと幸いです！！ 撮影出来次第すぐにご連絡させて頂きます😌！！" });
    t("室内写真の依頼に撮影の約束の下書き → 本来 AIX＋決まりの場面", kinds(f2) === "draft_does_aix_job,aix_scene_skipped", kinds(f2));
    const mp = [{ action: "meeting_place", checkPattern: null, source: "scene" as const }];
    t("待ち合わせの場面の下書きの場所（手打ちでも普通に書く）→ 本来 AIX にしない",
      !s.judgeShadowTurn({ chosen: "draft", candidates: mp, draftText: "現地エントランスお待ち合わせで何卒よろしくお願い致します！！" }).some((f) => f.kind === "draft_does_aix_job"));
    const alt = [{ action: "estimate_sheet", checkPattern: null, source: "alt" as const }];
    t("並べた AIX（alt）は決まりの場面にしない", !s.judgeShadowTurn({ chosen: "draft", candidates: alt, draftText: "かしこまりました！！" }).length);
    t("管理会社の回答の型（mgmt_move_in）は募集中の断言を見ない",
      !s.judgeShadowTurn({ chosen: "draft", candidates: [{ action: "property_check_result", checkPattern: "mgmt_move_in", source: "scene" }], draftText: "現在募集中となります！！" }).length);
    t("募集状況の場面（S1）の下書きが募集中を断言 → 本来 AIX",
      s.judgeShadowTurn({ chosen: "draft", candidates: [{ action: "property_check_result", checkPattern: null, source: "scene" }], draftText: "A602号室は今月末退去予定で現在募集中となります😊！！" }).some((f) => f.kind === "draft_does_aix_job"));
  }

  console.log("■ 影の候補（shadowAixCandidates）");
  {
    const meta = { action: "viewing_invite", reply_mode: "aix", check_pattern: null, scene_evidence: { candidate: "viewing_invite", check_pattern: null }, alt_actions: ["property_send"] };
    const c1 = s.shadowAixCandidates(meta, { action: "viewing_invite", checkPattern: null });
    t("AIX の番: 選んだ AIX は除き、並べた AIX だけ", c1.length === 1 && c1[0].action === "property_send" && c1[0].source === "alt", JSON.stringify(c1));
    const c2 = s.shadowAixCandidates({ action: "estimate_sheet", reply_mode: "auto_reply", scene_evidence: { candidate: "estimate_sheet" } });
    t("下書きの番: ブレインの action（reply_mode が aix でない）と場面の候補の重複は1つ", c2.length === 1 && c2[0].source === "brain", JSON.stringify(c2));
    const c3 = s.shadowAixCandidates({ action: "", reply_mode: "auto_reply", scene_evidence: { candidate: "property_check_result", check_pattern: "interior_photo" } });
    t("場面の候補の check_pattern を持つ", c3.length === 1 && c3[0].checkPattern === "interior_photo");
    t("判断が無い時は空", s.shadowAixCandidates(null).length === 0);
  }

  console.log("■ generate-reply の応答を読む");
  {
    const raw = `{"ok":true,"tier":"T1"}\nかしこまりました！！\nお部屋ご案内させて頂きます！！\n<<<SUGGESTED_AIX:{"action":"viewing_invite"}>>>\n<<<FINAL_CHECK:{"ok":true}>>>`;
    const p = s.parseGenerateReplyStream(raw);
    t("1行目のメタを読み、内部タグを外す", p.meta?.tier === "T1" && p.text === "かしこまりました！！\nお部屋ご案内させて頂きます！！", JSON.stringify(p));
    t("メタの無い本文だけ", s.parseGenerateReplyStream("かしこまりました！！\n二行目").text === "かしこまりました！！\n二行目");
  }

  console.log("■ 影を作る（customer-sim-shadow-run）: 送らない・書かない呼び方が無ければ下書きを作らない");
  {
    const run = await import("../customer-sim-shadow-run");
    t("手元の入口だけ", run.isLocalBase("http://localhost:3000") && run.isLocalBase("http://127.0.0.1:3000/") && !run.isLocalBase("https://sumora-ai-ui.vercel.app"));
    t("書かない呼び方の目印（今の generate-reply には無い形）", !run.generateReplyAcceptsShadow("let includeStopReason = false;") &&
      run.generateReplyAcceptsShadow("import { SHADOW_NO_WRITE_FIELD } from \"x\";\n  const persist = !shadowNoWrite;"));
    const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
    const conv = { account: "sumora", customer_name: "YUMA", status: "viewing" };
    const msgs = [
      { sender: "staff", text: "【エステムコート大阪WEST】\n初期費用：137,980円", created_at: "2026-09-27T01:44:00Z", is_aix_generated: true },
      { sender: "customer", text: "見積もりありがとうございます！", created_at: "2026-09-27T02:19:10Z" },
      { sender: "customer", text: "今週の土曜の午後か、日曜の午前だと助かるのですが、いかがでしょうか？", created_at: "2026-09-27T02:19:19Z" },
    ];
    const body = run.buildShadowDraftBody(CONV, conv, msgs);
    t("影の下書きの body: 最後のお客様の連投・書かない欄", !!body && (body.customerMessages as string[]).length === 2 && body.shadowNoWrite === true && body.conversationId === CONV, JSON.stringify(body).slice(0, 200));
    t("最後がこちらの発言なら作らない", run.buildShadowDraftBody(CONV, conv, msgs.slice(0, 1)) === null);
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, message_text: "YUMAさん、土曜の午後か日曜の午前でしたら…" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const meta = { action: "viewing_invite", reply_mode: "aix", scene_evidence: { candidate: "viewing_invite" }, alt_actions: ["application_push"] };
    const r1 = await run.runShadowTurn(
      { base: "http://localhost:3000", conversationId: CONV, draftAccepted: false, fetchImpl: fakeFetch },
      { chosen: "aix", meta, aix: { action: "viewing_invite", checkPattern: null }, conv, msgs, pool: null, sentPropertyCount: 11 },
    );
    t("書かない呼び方が無い時は影の下書きを作らない（generate-reply を呼ばない）", r1.draft === null && !!r1.draftSkipped && !calls.some((u) => u.includes("generate-reply")), JSON.stringify(r1));
    t("並べた AIX（申込へ・会話だけで作れる）の影は aix/action だけ", r1.candidates.length === 1 && r1.candidates[0].action === "application_push" && !!r1.candidates[0].text);
    t("送る API（send-line-message・log-aix-usage・mark_sent）は呼ばない", calls.every((u) => /\/api\/aix\/action$/.test(u)), calls.join(","));
    calls.length = 0;
    const r2 = await run.runShadowTurn(
      { base: "https://sumora-ai-ui.vercel.app", conversationId: CONV, draftAccepted: true, fetchImpl: fakeFetch },
      { chosen: "aix", meta, aix: { action: "viewing_invite", checkPattern: null }, conv, msgs, pool: null, sentPropertyCount: 11 },
    );
    t("本番の入口では影を作らない（何も呼ばない）", calls.length === 0 && r2.draft === null && r2.candidates.every((c) => !!c.skipped));
    const est = { kind: "estimate" as const, recordId: 264, imageUrl: "https://example.invalid/est.jpeg", propertyName: "エステムコート大阪WEST", roomNo: null, initialCostYen: 137980, discountYen: 124050, savedText: null };
    t("見積書の影は画像を読む（既定では作らない印）", run.aixRequestForMaterial("estimate_sheet", est, 1).needsImage === true);
    const mt = { kind: "meeting" as const, date: "10/4(日)", time: "10:30", propertyName: "エステムコート大阪WEST", address: null, source: "conversation" as const };
    t("待ち合わせの影は画面の固定文（API を呼ばない）", (run.aixRequestForMaterial("meeting_place", mt, 1).fixedText ?? "").includes("現地エントランスお待ち合わせ"));
  }

  console.log("■ 要約");
  {
    const sum = s.summarizeShadow([{ shadowFindings: [{ kind: "aix_followup_missing", aix: "estimate_sheet", detail: "" }] }, { shadowFindings: null }]);
    t("種類ごとの件数", sum.find((x) => x.kind === "aix_followup_missing")?.count === 1 && sum.length === s.SHADOW_KINDS.length);
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
