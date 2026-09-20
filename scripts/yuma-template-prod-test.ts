// YUMA で AIX テンプレートの2通目を**画面とまったく同じ形**で生成し、判断と文を確かめる
//
// 2026-09-21 竹内「実際に YUMA でテストしてちゃんと文生成されるか、ちゃんと判断できるのか調査」
//
// 設計知見「本番検証は『画面が渡すのと同じ形』で渡す — 形が違うと直す必要のない物を直してしまう」
//   （recent_messages を { sender, text } だけで渡したら3回中2回で不要な挨拶行が付いた。
//     画面と同じ形（sender / text / rawCreatedAt / isAix / imageUrl）にしたら 3/3 で消えた）
//
// ■ 画面が渡す物（app/page.tsx:10306 → TemplateModal:2374 を写した）
//   actionType / actionCategory / conversationId / customerName / conversationState /
//   recentMessages（slice(-25) を TemplateModal が slice(-15)）/ customerConditions /
//   customerSummary / noEmoji / pendingScheduledMessages / staffMessagedToday /
//   pickupType / lastAixCheckPattern / sentMessage
//
// ■ 見ること
//   ① 文が生成されるか（失敗・空・エラーが無いか）
//   ② **判断が合っているか**（CTA の有無・お客様の反応の分類）— サーバーのログ tag=aix-template-generate:cta
//   ③ 生成文にあってはいけない形が無いか
//
// ⚠ 生成のみ。LINE へは送らない。
import { createClient } from "@supabase/supabase-js";
import { resolveCtaGuidance } from "../app/lib/cta-guidance";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// 2026-09-21: 最初は狭すぎて「内覧日程調整させて頂きます」「お申込みさせて頂きます」を拾えず誤検知した。
//   実送信の言い回しに合わせて広げる（誘っているかどうかを見る物なので、形は広めに取る）
const CTA_RE = /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧(?:頂|いただ)け|内覧[^\n。！!]{0,10}(?:日程)?(?:調整|承り|お取り)|ご都合[^\n。！!]{0,12}(?:お日にち|日程|タイミング)|お?申(?:し)?込[^\n。！!]{0,18}(?:押さえ|抑え|完了|進め|手続|させて(?:頂|いただ)き|頂け)/;
/** 実送信0通の形（出たら不具合） */
const DEFECTS: Array<[string, RegExp]> = [
  ["プロンプトの見出しの写し", /【(?:お客様に送る文|お客様の現在の状況|お客様名|今回生成する)/],
  ["伏せ字（〇〇さん）", /[〇○]{1,2}さん/],
  ["AI の作業メモ", /^[^\n]{0,24}(?:確認します|出力します|作成します|整理します)[。\s]*$/m],
  ["できない宣言", /出力(?:は|を)?行(?:い|え)ま?せん|情報が(?:不足|足りません)|特定できません/],
  ["お待たせ致しました", /お待たせ(?:致|いた)?しました/],
  ["承知いたしました", /承知(?:いた|致)?しました/],
  ["夜分に失礼", /夜(?:分)?遅くに失礼|夜分に失礼/],
  ["希少性の煽り", /埋まって(?:しまい|しまう)|残り\s*[0-9０-９]\s*(?:部屋|室)|他のお客様[^\n。！!]{0,12}(?:申込|お申込)/],
  ["共感フレーズ", /(?:ます|です)よね|お気持ち[^\n。！!]{0,8}わかり|気になりますね/],
  ["マークダウン太字", /\*\*/],
  ["会社名の名乗り", /(?:スモラ|イエヤス|ギガ賃貸)です[。！!]/],
  ["箇条書き2行以上", /^[・･][^\n]*\n[\s\S]*^[・･]/m],
];

/** 1通目（AIX が送った本文）と、その後にお客様が返した反応 */
const CASES: Array<{ id: string; action: string; category: string; first: string; reply: string | null; want: "誘う" | "誘わない" }> = [
  { id: "① ピックアップ後・相槌", action: "property_send", category: "物件ピックアップした【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\n難波周辺全域からYUMAさんご希望の家賃10万円以内・1LDK・駅徒歩10分以内のお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！",
    reply: "ありがとうございます", want: "誘わない" },
  { id: "② ピックアップ後・内覧したい", action: "property_send", category: "物件ピックアップした【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\n難波周辺全域からYUMAさんご希望の家賃10万円以内・1LDK・駅徒歩10分以内のお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！",
    reply: "この物件内覧したいです！", want: "誘う" },
  { id: "③ 物件オススメ後・気に入った", action: "property_recommendation", category: "物件オススメ【AIX】",
    first: "🌟スプランディッド大阪EAST 204号室\n\n（オススメポイント）\n・家賃106,000円・管理費12,500円（合計118,500円）\n・間取り：2LDK（リビング11.5帖、洋室3.8帖）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・大阪環状線「玉造」徒歩5分",
    reply: "すごく良さそうですね！気に入りました", want: "誘う" },
  { id: "④ 物件オススメ後・懸念", action: "property_recommendation", category: "物件オススメ【AIX】",
    first: "🌟スプランディッド大阪EAST 204号室\n\n（オススメポイント）\n・家賃106,000円・管理費12,500円（合計118,500円）\n・間取り：2LDK（リビング11.5帖、洋室3.8帖）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・大阪環状線「玉造」徒歩5分",
    reply: "家賃が少し予算オーバーで不安です…", want: "誘わない" },
  { id: "⑤ 物件オススメ後・条件変更", action: "property_recommendation", category: "物件オススメ【AIX】",
    first: "🌟スプランディッド大阪EAST 204号室\n\n（オススメポイント）\n・家賃106,000円・管理費12,500円（合計118,500円）\n・大阪環状線「玉造」徒歩5分",
    reply: "もう少し駅近で探してもらえますか？", want: "誘わない" },
  { id: "⑥ 見積書後・申込したい", action: "estimate_sheet", category: "見積書送る【AIX】",
    first: "【スプランディッド大阪EAST 204号室】\n\n初期費用さらに\n🌟22,000円割引させて頂き\n初期費用：139,000円\n\nイエヤスなら一般的な不動産業者より90,310円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
    reply: "この内容で進めたいです", want: "誘う" },
  { id: "⑦ 物件確認した後・質問", action: "property_check_result", category: "物件確認した【AIX】",
    first: "YUMAさんお待たせ致しました！！\n\nスプランディッド大阪EAST 204号室、現在募集中で即日ご入居可能となります😊！！\n\n保証会社は日本セーフティーという比較的審査通過しやすい保証会社となっております！！",
    reply: "審査ってどれくらいかかりますか？", want: "誘わない" },
  // 2026-09-21: 1通目が「可否を確認します」なので、相槌だけの時点ではまだ誘う場面ではない
  //   （cta-guidance も ack_only は push にしないよう直した）
  { id: "⑧ 内覧日調整後・相槌", action: "viewing_invite", category: "内覧へ！【AIX】",
    first: "かしこまりました！！\nご内覧可否確認させて頂きます！！確認出来次第ご連絡させて頂きます😊！！",
    reply: "よろしくお願いします", want: "誘わない" },
];

async function main() {
  const rounds = Number(process.env.ROUNDS ?? 1);

  // ── 画面と同じ材料を集める ──
  const { data: conv } = await sb.from("conversations")
    .select("id, customer_name, status, property_customer_id").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const pcId = c.property_customer_id as string | null;
  let customerSummary: string | null = null;
  let customerConditions = "";
  if (pcId) {
    const { data: pc } = await sb.from("property_customers").select("ai_summary, conditions").eq("id", pcId).maybeSingle();
    const row = (pc ?? {}) as Record<string, unknown>;
    customerSummary = (row.ai_summary as string | null) ?? null;
    customerConditions = String(row.conditions ?? "");
  }
  const { data: ms } = await sb.from("messages")
    .select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const all = (ms ?? []) as unknown as Array<Record<string, unknown>>;
  // 画面: slice(-25) → TemplateModal: slice(-15)。形も画面と同じ（imageUrl / rawCreatedAt / isAix）
  const base25 = all.slice(-25).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));
  // 画面の staffMessagedToday（当日スタッフが送ったか）
  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const staffMessagedToday = all.some((m) => m.sender === "staff"
    && new Date(new Date(String(m.created_at)).getTime() + 9 * 3600_000).toISOString().slice(0, 10) === todayJst);
  // 直近の AIX（画面の lastAixCheckPattern）
  const { data: lastAix } = await sb.from("aix_usage_logs").select("check_pattern")
    .eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const lastAixCheckPattern = ((lastAix ?? {}) as Record<string, unknown>).check_pattern as string | null ?? null;

  console.log(`=== YUMA で本番と同じ形で生成（${CASES.length}場面 × ${rounds}回・送信しない）===`);
  console.log(`   customerName=${c.customer_name} / state=${c.status} / staffMessagedToday=${staffMessagedToday}`);
  console.log(`   customerSummary=${customerSummary ? `${customerSummary.slice(0, 40)}…` : "なし"} / conditions=${customerConditions ? `${customerConditions.slice(0, 40)}…` : "なし"}`);
  console.log(`   lastAixCheckPattern=${lastAixCheckPattern ?? "なし"}\n`);

  let okCount = 0, ngCount = 0, defectCount = 0, failCount = 0;
  for (const cs of CASES) {
    for (let r = 0; r < rounds; r++) {
      // 1通目の後にお客様の反応を足す（画面では実際の会話がここに入る）
      const recentMessages = [
        ...base25,
        { sender: "staff", text: cs.first, imageUrl: undefined, rawCreatedAt: new Date(Date.now() - 120_000).toISOString(), isAix: true },
        ...(cs.reply ? [{ sender: "customer", text: cs.reply, imageUrl: undefined, rawCreatedAt: new Date(Date.now() - 60_000).toISOString(), isAix: false }] : []),
      ].slice(-15);

      // 生成の前に「こちらが期待する判断」を出す（サーバーと同じ純関数）
      const lastCust = [...recentMessages].reverse().find((m) => m.sender === "customer" && m.text.trim());
      let expected = "（判定不能）";
      let expectedMode = "";
      if (lastCust) {
        const idx = recentMessages.lastIndexOf(lastCust);
        const prevStaff = [...recentMessages.slice(0, idx)].reverse().find((m) => m.sender === "staff" && m.text.trim());
        const st = classifyLastStaffTurn(prevStaff?.text ?? "", { lastStaffAt: prevStaff?.rawCreatedAt ?? null });
        const sub = analyzeSubstance(lastCust.text, undefined, { staffAskedQuestion: st.kind === "question_to_customer" });
        const cr = classifyCustomerResponse(sub, st);
        const g = resolveCtaGuidance({ customerKind: cr.kind, positiveKind: cr.positive?.kind ?? null, action: cs.action });
        expected = `${cr.kind}${cr.positive?.kind ? `/${cr.positive.kind}` : ""} → ${g.mode}${g.kind ? `(${g.kind})` : ""}`;
        expectedMode = g.mode;
      }

      let text = "";
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/api/aix-template-generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: cs.action,
            actionCategory: cs.category,
            conversationId: YUMA,
            customerName: String(c.customer_name ?? "YUMA"),
            conversationState: String(c.status ?? "proposing"),
            recentMessages,
            customerConditions,
            customerSummary,
            noEmoji: false,
            pendingScheduledMessages: [],
            staffMessagedToday,
            pickupType: null,
            lastAixCheckPattern,
            sentMessage: cs.first,
          }),
        });
        const raw = await res.text();
        try { const j = JSON.parse(raw) as Record<string, unknown>; text = String(j.text ?? j.error ?? raw.slice(0, 200)); }
        catch { text = raw.slice(0, 200); }
      } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
      const sec = ((Date.now() - t0) / 1000).toFixed(1);

      const failed = text.length <= 10 || text.startsWith("【エラー】") || text.startsWith("お客様への返信になっていません");
      if (failed) failCount++;
      const hasCta = CTA_RE.test(text);
      const judged = (cs.want === "誘う") === hasCta;
      if (!failed) { if (judged) okCount++; else ngCount++; }
      const defects = DEFECTS.filter(([, re]) => re.test(text)).map(([k]) => k);
      defectCount += defects.length;

      console.log(`${"─".repeat(72)}`);
      console.log(`【${cs.id}】${rounds > 1 ? `${r + 1}回目 ` : ""}(${sec}s ・ ${text.length}字 ・ ${text.split("\n").filter((x) => x.trim()).length}行)`);
      console.log(`   客「${cs.reply ?? "（返信なし）"}」`);
      console.log(`   判断: ${expected}  ／ 期待「${cs.want}」 → 実際「${hasCta ? "誘った" : "誘わなかった"}」 ${judged ? "✅" : "❌"}`);
      if (defects.length) console.log(`   ⛔ ${defects.join(" / ")}`);
      console.log(`\n${text || "（本文なし）"}\n`);
    }
  }

  console.log(`${"─".repeat(72)}`);
  console.log(`=== まとめ ===`);
  console.log(`   生成できた: ${CASES.length * rounds - failCount} / ${CASES.length * rounds}（失敗 ${failCount}）`);
  console.log(`   判断が合った: ${okCount} / ${okCount + ngCount}`);
  console.log(`   あってはいけない形: ${defectCount}件`);
  console.log(`\n   ※ サーバー側の判断ログは tag="aix-template-generate:cta"（customerKind / mode / ctaKind / reason）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
