// scripts/audit-condition-source-gate.ts — 入口の見分け（condition-source-gate）を過去のお客様の発言・条件の履歴・今の条件の欄・成約の会話に当てる（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-source-gate.ts [--days=180] [--show=8]
//
// 2026-09-30 竹内（黒明様の事例）「お客さんの条件か、ただ物件 SUUMO 等のサイト送ってきているだけか」「実際の LINE や成約データもみて、ずれがないように」
// 見る物（お客様の名前・電話は出さない。お客様 ID は先頭8文字・発言は70字まで・申込の書類は本文を出さない）:
//   A. 180日のお客様の発言の種類（条件／同居／物件の問い合わせ／書類／画像）
//   B. 止めてはいけない側: 本物の階の条件・URL の無い駅徒歩・地域の指定の形（Path C が動く形）の条件の発言・条件のフォームで、
//      条件の語が conditionText から落ちた物（＝誤って止める）。0 であること
//   C. 落とした節のうち条件の語・地名を含む物（目で読む・同居の文の分け方の誤り）
//   D. 条件の変更履歴（desired_area・move_in_time・other_requests…）を当て直す: 直前のお客様の発言で、今の関所ならその値を書いたか
//      （止まる行＝混入の行・通る行＝本物）。止まる行を全部目で読む
//   E. 今の希望エリアの語の根拠（condition-grounding）: 物件の話にだけある語（inquiry_only）を全部
//   F. 成約（申込以降に進んだ会話）の物差し: 決まった物件（申込の直前にスタッフが送った物件の文の駅）が希望エリアに入っているか・
//      入っていなければお客様が条件として言ったか（反映の抜け）／物件の話でだけ出たか（持ち込み）／どこにも無いか（スタッフの提案）
//      ＋希望エリアの根拠の無い語（混入の疑い）。申込以降の発言は読むだけ（学習・送信には使わない）
import { createClient } from "@supabase/supabase-js";
import { classifyConditionTurn, gateExtractedConditions, areaTokenCore, splitAreaTokens, areaTokenGroundedIn, isApplyPaperText } from "../app/lib/condition-source-gate";
import { groundAreaTokens } from "../app/lib/condition-grounding";
import { stationsInText, wardOfStation, normWard } from "../app/lib/osaka-geo";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "180"));
const SHOW = Number(arg("show", "8"));
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const YUMA_PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const nf = (s: unknown) => String(s ?? "").normalize("NFKC");
const APPLY_RE = /勤務先|勤続|年収|緊急連絡先|現住所|生年月日|雇用形態|保険種類|連帯保証人|続柄|氏名|フリガナ/;
/** 個人情報の形（生年月日・郵便番号・番地・電話）。当たれば本文を出さない（書類の判定に当たらない貼り付けもある） */
const PII_RE = /(?:19|20)[0-9]{2}\s*[./年-]\s*[0-9]{1,2}|[0-9]{4}\.[0-9]{3,4}|〒|[0-9]{3}-[0-9]{4}|[0-9]+-[0-9]+-[0-9]+|丁目\s*[0-9]|生年月日|現住所/;
const safe = (s: string, n = 70) => {
  const t = nf(s).replace(/\s+/g, " ").trim();
  if ((t.match(new RegExp(APPLY_RE.source, "g")) ?? []).length >= 2 || isApplyPaperText(s) || PII_RE.test(t)) return "〔申込・審査の書類／個人情報の形（本文は出さない）〕";
  const u = t.replace(/\d{2,5}-?\d{2,4}-?\d{3,4}/g, "＊＊＊").replace(/https?:\/\/\S+/g, "<URL>");
  return u.length > n ? u.slice(0, n) + "…" : u;
};
const id8 = (s: string | null | undefined) => String(s ?? "").slice(0, 8);

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await all<{ id: string; property_customer_id: string | null; status: string | null }>((a, b) => sb.from("conversations").select("id, property_customer_id, status").range(a, b));
  const convOfPc = new Map<string, string[]>();
  for (const c of convs) if (c.property_customer_id && c.id !== YUMA_CONV) convOfPc.set(c.property_customer_id, [...(convOfPc.get(c.property_customer_id) ?? []), c.id]);
  const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at").gte("created_at", since).neq("conversation_id", YUMA_CONV).not("text", "is", null).order("created_at").range(a, b));
  const cust = msgs.filter((m) => m.sender === "customer");
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m]);
  const turns = new Map(cust.map((m) => [m.id, classifyConditionTurn(m.text)]));

  // ── A ──
  console.log(`=== A. 180日のお客様の発言 ${cust.length}通の種類 ===`);
  const cnt: Record<string, number> = {};
  for (const m of cust) { const k = turns.get(m.id)!.kind; cnt[k] = (cnt[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(cnt).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

  // ── B ── 止めてはいけない側
  console.log(`\n=== B. 止めてはいけない側（条件の語が条件の部分から落ちた＝誤って止める）===`);
  const MUST: Array<[string, RegExp]> = [
    ["本物の階の条件", /[0-9一二三四五六七八九十]+階以上|[0-9一二三四五六七八九十]+階より上|高層階|最上階|1階(?:は)?(?:NG|嫌|不可|避け|以外)|一階以外|2階以上|二階以上/],
    ["駅＋徒歩N分（URL なし）", /駅\s*徒歩\s*[0-9０-９]+|徒歩\s*[0-9０-９]+\s*分以内/],
    ["地域の指定の形", /[一-鿿ァ-ヶ]{1,8}(?:周辺|エリア|沿線|辺り|あたり)(?:で|も|でも|を|に)|[一-鿿]{1,6}[区市](?:も|で|でも)(?:探|お願い|大丈夫|OK|いい)|[一-鿿ァ-ヶ]{2,8}駅(?:周辺|付近|近く|近辺|まで)/],
    ["家賃の言い直し", /家賃(?:を|も)?(?:もう少し|少し)?(?:上げ|あげ|下げ|さげ)|[0-9.]+万(?:円)?(?:まで|以内|以下|前後|くらい)/],
  ];
  let bFalse = 0, bTotal = 0;
  const bShow: string[] = [];
  for (const m of cust) {
    const t = nf(m.text);
    if (/^\s*\[画像\]/.test(t)) continue;
    const turn = turns.get(m.id)!;
    for (const [name, re] of MUST) {
      const hit = t.match(re);
      if (!hit) continue;
      bTotal++;
      if (!nf(turn.conditionText).includes(hit[0])) {
        bFalse++;
        if (bShow.length < 200) bShow.push(`   [${name}] ${m.created_at.slice(0, 10)} ${id8(m.id)} kind=${turn.kind}「${safe(t, 110)}」 → 落とした理由: ${turn.dropped.filter((d) => nf(d.text).includes(hit[0])).map((d) => d.reason).join("／") || "（条件の部分に無い）"}`);
      }
    }
  }
  console.log(`  当たった ${bTotal} 件のうち条件の部分から落ちた ${bFalse} 件（下を全部目で読む。物件の話の中の語なら正しく落ちている）`);
  for (const s of bShow) console.log(s);

  // ── C ── 落とした節で条件の語・地名を含む物
  console.log(`\n=== C. 落とした節のうち条件の語・地名を含む物（同居の文の分け方）===`);
  const COND = /家賃|万|間取り|[1-4](?:K|DK|LDK|R)|帖|畳|㎡|徒歩|築|階以上|ペット|オートロック|エリア|周辺|区|市|駅|沿線/;
  const cRows: string[] = [];
  const cByReason: Record<string, number> = {};
  for (const m of cust) {
    const turn = turns.get(m.id)!;
    if (!["mixed", "property_inquiry"].includes(turn.kind)) continue;
    for (const d of turn.dropped) {
      if (d.kind === "request") continue;
      if (!COND.test(nf(d.text)) && !stationsInText(d.text).length) continue;
      cByReason[d.reason] = (cByReason[d.reason] ?? 0) + 1;
      cRows.push(`   ${m.created_at.slice(0, 10)} ${id8(m.id)} [${d.reason}]「${safe(d.text, 90)}」${turn.conditionText ? ` ／残した「${safe(turn.conditionText, 50)}」` : ""}`);
    }
  }
  console.log(`  ${cRows.length}節。理由別: ${Object.entries(cByReason).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${n}`).join("・")}`);
  for (const s of cRows.filter((_, i) => i % Math.max(1, Math.floor(cRows.length / (SHOW * 4))) === 0).slice(0, SHOW * 4)) console.log(s);

  // ── D ── 条件の変更履歴を当て直す
  console.log(`\n=== D. 条件の変更履歴（自動の書き手）を当て直す: 直前のお客様の発言で今の関所ならその値を書いたか ===`);
  const hist = await all<{ id: string; property_customer_id: string; changed_field: string; old_value: string | null; new_value: string | null; source_message_id: string | null; created_at: string }>((a, b) =>
    sb.from("property_condition_history").select("id, property_customer_id, changed_field, old_value, new_value, source_message_id, created_at").neq("property_customer_id", YUMA_PC).order("created_at").range(a, b));
  let dTotal = 0, dBlocked = 0, dNoMsg = 0;
  const dRows: string[] = [];
  for (const h of hist) {
    if (/一時|temporary|screen_edit/i.test(h.source_message_id ?? "")) continue;
    const convIds = convOfPc.get(h.property_customer_id) ?? [];
    const at = Date.parse(h.created_at);
    // 直前 90 秒のお客様の発言（P4・条件ブレイン・画面の編集の区別はつかない＝画面の編集は発言が無いので数えない）
    const prev = convIds.flatMap((c) => byConv.get(c) ?? []).filter((m) => m.sender === "customer" && Date.parse(m.created_at) <= at && at - Date.parse(m.created_at) < 90_000);
    if (!prev.length) { dNoMsg++; continue; }
    dTotal++;
    const text = prev.map((m) => m.text).join("\n⁣\n");
    const turn = classifyConditionTurn(text);
    // 新しく足した部分だけ（desired_area・自由文は差分の語／節、それ以外は値）
    let extracted: Record<string, unknown>;
    if (h.changed_field === "desired_area") {
      const olds = new Set(splitAreaTokens(h.old_value).map(areaTokenCore));
      const add = splitAreaTokens(h.new_value).filter((x) => !olds.has(areaTokenCore(x)));
      if (!add.length) { dTotal--; continue; }
      extracted = { desired_area: add.join("・") };
    } else if (["preferences", "ng_points", "other_requests"].includes(h.changed_field)) {
      const olds = new Set(nf(h.old_value).split(/[・、,\n]/).map((s) => s.trim()));
      const add = nf(h.new_value).split(/[・、,\n]/).map((s) => s.trim()).filter((s) => s && !olds.has(s));
      if (!add.length) { dTotal--; continue; }
      extracted = { [h.changed_field]: add.join("・") };
    } else {
      const num = Number(h.new_value);
      extracted = { [h.changed_field]: h.new_value != null && h.new_value !== "" && Number.isFinite(num) && /^[0-9.]+$/.test(h.new_value) ? num : h.new_value };
    }
    const blockedWhole = !turn.conditionText;
    const g = blockedWhole ? null : gateExtractedConditions(extracted, turn, null);
    const droppedVals = blockedWhole ? Object.entries(extracted).map(([f, v]) => `${f}=${v}`) : g!.dropped.map((d) => `${d.field}=${d.value}（${d.reason}）`);
    if (droppedVals.length) {
      dBlocked++;
      dRows.push(`   ${h.created_at.slice(0, 16)} [${id8(h.property_customer_id)}] ${h.changed_field}: 止める ${droppedVals.join("／")} ← kind=${turn.kind}「${safe(text, 100)}」`);
    }
  }
  console.log(`  履歴 ${hist.length}行（直前90秒にお客様の発言が無い＝画面の編集等 ${dNoMsg}行）。発言の直後の書き込み ${dTotal}件のうち、今の関所で止まる ${dBlocked}件（全部目で読む）:`);
  for (const s of dRows) console.log(s);

  // ── E ── 今の希望エリアの語の根拠
  console.log(`\n=== E. 今の希望エリアの語の根拠（condition-grounding）===`);
  const pcs = await all<{ id: string; desired_area: string | null; raw_format_text: string | null; area_mode: string | null; status: string | null }>((a, b) => sb.from("property_customers").select("id, desired_area, raw_format_text, area_mode, status").neq("id", YUMA_PC).not("desired_area", "is", null).range(a, b));
  const histByPc = new Map<string, typeof hist>();
  for (const h of hist) histByPc.set(h.property_customer_id, [...(histByPc.get(h.property_customer_id) ?? []), h]);
  const eCount: Record<string, number> = {};
  const eInq: string[] = [];
  for (const pc of pcs) {
    const convIds = convOfPc.get(pc.id) ?? [];
    const cm = convIds.flatMap((c) => byConv.get(c) ?? []).filter((m) => m.sender === "customer").map((m) => ({ id: m.id, text: m.text, created_at: m.created_at }));
    const g = groundAreaTokens({ desiredArea: pc.desired_area, rawFormatText: pc.raw_format_text, customerMessages: cm, history: histByPc.get(pc.id) ?? [] });
    for (const x of g) {
      eCount[x.via] = (eCount[x.via] ?? 0) + 1;
      if (x.via === "inquiry_only") eInq.push(`   [${id8(pc.id)}] 「${x.token.replace(/[0-9]/g, "＊")}」← ${x.kind}「${safe(x.excerpt ?? "", 80)}」`);
    }
  }
  console.log(`  語の根拠: ${Object.entries(eCount).map(([k, n]) => `${k} ${n}`).join("・")}`);
  console.log(`  物件の話・書類の中にだけある語（混入の疑い）${eInq.length}語:`);
  for (const s of eInq) console.log(s);

  // ── F ── 成約の物差し
  console.log(`\n=== F. 成約（申込以降に進んだ会話）の物差し: 決まった物件の駅 × 希望エリア ===`);
  const stage = await all<{ conversation_id: string; to_status: string; changed_at: string }>((a, b) => sb.from("conversation_stage_history").select("conversation_id, to_status, changed_at").in("to_status", ["applying", "screening", "contract", "closed_won"]).order("changed_at").range(a, b));
  const applyAt = new Map<string, string>();
  for (const s of stage) if (!applyAt.has(s.conversation_id)) applyAt.set(s.conversation_id, s.changed_at);
  for (const c of convs) if (["applying", "screening", "contract", "closed_won"].includes(c.status ?? "") && !applyAt.has(c.id)) {
    // 状態だけ進んでいて変遷の記録が無い会話は、最後のスタッフの「申込」の文の時刻
    const ms = byConv.get(c.id) ?? [];
    const ap = [...ms].reverse().find((m) => m.sender === "staff" && /お申込|お申し込み|申込させて|申し込みさせて/.test(m.text ?? ""));
    if (ap) applyAt.set(c.id, ap.created_at);
  }
  const pcById = new Map(pcs.map((p) => [p.id, p]));
  const fOut: Record<string, number> = {};
  const fRows: string[] = [];
  for (const c of convs) {
    const at = applyAt.get(c.id);
    if (!at || !c.property_customer_id || c.id === YUMA_CONV) continue;
    const pc = pcById.get(c.property_customer_id);
    const ms = byConv.get(c.id) ?? [];
    const before = ms.filter((m) => Date.parse(m.created_at) <= Date.parse(at) + 60_000);
    // 決まった物件: 申込の直前（7日以内）でいちばん新しい、駅の入ったスタッフの物件の文（🌟・号室・「駅」徒歩）
    const prop = [...before].reverse().find((m) => m.sender === "staff" && Date.parse(at) - Date.parse(m.created_at) < 7 * 86400_000 && /🌟|号室|」\s*駅?\s*徒歩|駅徒歩/.test(m.text ?? "") && stationsInText((m.text ?? "").replace(/[\s\S]*?(「[^」]+」\s*駅?\s*徒歩|[一-鿿ァ-ヶ]+駅\s*徒歩)/, "$1")).length > 0);
    if (!prop) { fOut["決まった物件の駅が読めない"] = (fOut["決まった物件の駅が読めない"] ?? 0) + 1; continue; }
    const walkM = (prop.text ?? "").match(/「([^」]+)」\s*駅?\s*徒歩|([一-鿿ァ-ヶ]{2,8})駅\s*徒歩/);
    const st = walkM ? stationsInText(walkM[1] ?? walkM[2] ?? "")[0]?.station : stationsInText(prop.text ?? "")[0]?.station;
    if (!st) { fOut["決まった物件の駅が読めない"] = (fOut["決まった物件の駅が読めない"] ?? 0) + 1; continue; }
    const ward = wardOfStation(st);
    const area = pc?.desired_area ?? "";
    const areaToks = splitAreaTokens(area);
    const inArea = areaTokenGroundedIn(st, area) || (!!ward && areaToks.some((t) => normWard(areaTokenCore(t)) === ward));
    const custBefore = before.filter((m) => m.sender === "customer");
    const saidMsg = custBefore.find((m) => areaTokenGroundedIn(st, classifyConditionTurn(m.text).conditionText) || (!!ward && areaTokenGroundedIn(ward, classifyConditionTurn(m.text).conditionText)));
    const saidAsCondition = !!saidMsg;
    const saidInInquiry = custBefore.some((m) => classifyConditionTurn(m.text).dropped.some((d) => areaTokenGroundedIn(st, d.text)));
    const g = groundAreaTokens({ desiredArea: area, rawFormatText: pc?.raw_format_text, customerMessages: custBefore.map((m) => ({ id: m.id, text: m.text })), history: histByPc.get(c.property_customer_id) ?? [] });
    const polluted = g.filter((x) => x.via === "inquiry_only").map((x) => x.token);
    const key = inArea ? "決まった物件が希望エリアの中" : saidAsCondition ? "希望エリアの外・お客様は条件として言っていた（反映の抜け）" : saidInInquiry ? "希望エリアの外・お客様が物件を持ち込んだ（条件ではない＝正しい）" : "希望エリアの外・お客様の発言に無い（スタッフの提案・電話）";
    fOut[key] = (fOut[key] ?? 0) + 1;
    if (!inArea || polluted.length) fRows.push(`   [${id8(c.property_customer_id)}] ${at.slice(0, 10)} 決まった駅=${st}${ward ? `(${ward})` : ""} 希望エリア=「${safe(area, 50)}」 → ${key}${saidMsg && !inArea ? ` ／言った発言 ${saidMsg.created_at.slice(0, 10)}「${safe(classifyConditionTurn(saidMsg.text).conditionText, 80)}」` : ""}${polluted.length ? ` ／物件の話にだけある語: ${polluted.join("・")}` : ""}`);
  }
  for (const [k, n] of Object.entries(fOut)) console.log(`  ${k}: ${n}`);
  for (const s of fRows) console.log(s);
}
main().catch((e) => { console.error(e); process.exit(1); });
