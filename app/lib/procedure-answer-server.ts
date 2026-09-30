// app/lib/procedure-answer-server.ts（サーバー専用・DB。画面側から import しない）
// お客様の手続きの質問（審査・入居までの期間と流れ・必要書類）の時だけ、対象のお部屋（主のお部屋）の資料の入居時期を読み、
// 答え方（返信／返信か AIX【確認した→入居可能日】の2択）と材料の文を作る。決まりは純関数 procedure-question.ts に1つ。
//
// 2026-09-30 竹内「物件が退去予定か即入居可能かで入居日が変わる（物件資料から）。資料を読み取って分からなかったら AIX をそのまま送れるように。
//   逆に物件資料に記載があればそこで答えて大丈夫」
//   資料の出所（新しい LLM 呼び出しは無い・保存済みの行を読むだけ）:
//     ① 売上サポの行（property_pickups: image_lines・pdf_text の「現況/入居時期」・60日以内・号室が合う行）
//     ② 送った画像の読み取り（sent_image_properties → image_details.lines の「現況」「入居可能日」「退去予定」）
//     ③ 物件確認の結果が退去予定（customer-state の vacating）
//   質問でなければ DB も引かない。失敗・時間切れは null（呼び出し側は今まで通り）
import { supabase } from "@/app/lib/supabase";
import { getCustomerState } from "@/app/lib/customer-state-server";
import { moveInFactOfPickup } from "@/app/lib/aix-material-facts";
import { normalizePropertyName } from "@/app/lib/property-name-match";
import {
  detectProcedureQuestion, isProcedureReplyQuestion, procedureNeedsMoveIn, resolveProcedurePlan, buildProcedureAnswerNote,
  type ProcedurePlan, type ProcedureTarget,
} from "@/app/lib/procedure-question";

const PICKUP_MAX_DAYS = 60;
const roomNorm = (r: string | null | undefined) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "").trim();

export type ProcedureAnswerMaterial = {
  plan: ProcedurePlan;
  note: string;
  /** どこから読んだか（監査・ログ用） */
  source: "pickup" | "image_details" | "check_result" | "none" | "not_needed";
};

/** 対象のお部屋の資料の行（入居時期の行が入っている物を優先）。読めなければ空 */
export async function loadRoomMaterialLines(o: { conversationId: string; name: string; roomNo: string | null; vacating?: boolean }): Promise<{ lines: string[]; source: ProcedureAnswerMaterial["source"] }> {
  const rn = roomNorm(o.roomNo);
  const key = normalizePropertyName(o.name);
  // ① 売上サポの行
  const { data: picks } = await supabase.from("property_pickups")
    .select("property_name, room_no, pdf_text, image_lines, terms, created_at")
    .eq("property_name", o.name).gte("created_at", new Date(Date.now() - PICKUP_MAX_DAYS * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(10);
  const pick = ((picks ?? []) as Array<{ room_no: string | null; pdf_text: string | null; image_lines: string[] | null; terms: { moveIn?: { kind?: string | null; current?: string | null } | null } | null }>)
    .find((r) => !!rn && roomNorm(r.room_no) === rn);
  if (pick) {
    const fact = moveInFactOfPickup({ pdf_text: pick.pdf_text, image_lines: pick.image_lines, terms: null });
    const lines = [...(fact?.lines ?? []), ...((pick.image_lines ?? []).filter((l) => !(fact?.lines ?? []).includes(String(l).trim())))];
    if (lines.length) return { lines, source: "pickup" };
  }
  // ② 送った画像の読み取り（号室が分かる時は号室も合う行だけ）
  const { data: sent } = await supabase.from("sent_image_properties")
    .select("property_name, room_no, image_url, created_at")
    .eq("conversation_id", o.conversationId).order("created_at", { ascending: false }).limit(60);
  const urls = ((sent ?? []) as Array<{ property_name: string | null; room_no: string | null; image_url: string | null }>)
    .filter((s) => s.image_url && normalizePropertyName(s.property_name) === key && (!rn || !roomNorm(s.room_no) || roomNorm(s.room_no) === rn))
    .map((s) => s.image_url as string);
  if (urls.length) {
    const { data: det } = await supabase.from("image_details").select("image_url, kind, lines, read_at").in("image_url", urls).order("read_at", { ascending: false });
    const row = ((det ?? []) as Array<{ kind: string | null; lines: string[] | null }>).find((d) => d.kind === "property" && (d.lines ?? []).length > 0);
    if (row) return { lines: (row.lines ?? []).map((l) => String(l)), source: "image_details" };
  }
  // ③ 物件確認の結果が退去予定（日付は分からない＝確認が要る側に倒れる）
  if (o.vacating) return { lines: ["現況: 退去予定（物件確認の結果）"], source: "check_result" };
  return { lines: [], source: "none" };
}

/**
 * 今回のお客様の文が手続きの質問（返信で答える形）なら、答え方と材料を作る。質問でなければ null。
 * target を渡さない時は今の状況（customer-state）の主のお部屋を使う。
 */
export async function loadProcedureAnswer(o: {
  conversationId: string; customerText: string;
  target?: { name: string; roomNo: string | null; vacating?: boolean } | null;
}): Promise<ProcedureAnswerMaterial | null> {
  const question = detectProcedureQuestion(o.customerText);
  if (!isProcedureReplyQuestion(question)) return null;
  if (!procedureNeedsMoveIn(question)) {
    const plan = resolveProcedurePlan({ question, target: null, materialLines: [] });
    return { plan, note: buildProcedureAnswerNote(plan), source: "not_needed" };
  }
  let target = o.target;
  if (target === undefined) {
    const st = await getCustomerState(o.conversationId).catch(() => null);
    const room = st?.focusKey ? st.properties.find((p) => p.key === st.focusKey) ?? null : null;
    target = room && room.status !== "ended" ? { name: room.building, roomNo: room.room, vacating: room.vacating } : null;
  }
  const t: ProcedureTarget = target ? { name: target.name, roomNo: target.roomNo } : null;
  const mat = target ? await loadRoomMaterialLines({ conversationId: o.conversationId, name: target.name, roomNo: target.roomNo, vacating: target.vacating }) : { lines: [], source: "none" as const };
  const plan = resolveProcedurePlan({ question, target: t, materialLines: mat.lines });
  return { plan, note: buildProcedureAnswerNote(plan), source: mat.source };
}

/** 時間の枠つき（返信生成・ブレインは待ちすぎない）。枠を過ぎたら null＝今まで通り */
export async function loadProcedureAnswerWithin(ms: number, o: Parameters<typeof loadProcedureAnswer>[0]): Promise<ProcedureAnswerMaterial | null> {
  if (!isProcedureReplyQuestion(detectProcedureQuestion(o.customerText))) return null; // 質問でなければ DB も引かない
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      loadProcedureAnswer(o),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); }),
    ]);
  } catch (e) {
    console.warn("[procedure-answer] 失敗:", o.conversationId, e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

// ─── 「確認した」系の質問（入居可能日・ペット・駐車場）: 資料に記載あり → 資料で答える／無し → AIX【確認した】 ───
import { routeConfirmTopic, buildConfirmTopicNote, confirmTopicsAllInMaterial, type ConfirmTopic, type ConfirmRoute } from "@/app/lib/procedure-question";

export type ConfirmTopicMaterial = { target: { name: string; roomNo: string | null }; routes: ConfirmRoute[]; allInMaterial: boolean; note: string; source: ProcedureAnswerMaterial["source"] };

/** 聞かれた項目（topics）を対象のお部屋の資料に当てる。対象が無い・項目が無ければ null */
export async function loadConfirmTopicRoutes(o: {
  conversationId: string; topics: readonly ConfirmTopic[];
  target: { name: string; roomNo: string | null; vacating?: boolean } | null;
}): Promise<ConfirmTopicMaterial | null> {
  if (!o.target || o.topics.length === 0) return null;
  const mat = await loadRoomMaterialLines({ conversationId: o.conversationId, name: o.target.name, roomNo: o.target.roomNo, vacating: o.target.vacating });
  const routes = o.topics.map((t) => routeConfirmTopic(t, mat.lines));
  const target = { name: o.target.name, roomNo: o.target.roomNo };
  return { target, routes, allInMaterial: confirmTopicsAllInMaterial(routes), note: buildConfirmTopicNote(target, routes), source: mat.source };
}

export async function loadConfirmTopicRoutesWithin(ms: number, o: Parameters<typeof loadConfirmTopicRoutes>[0]): Promise<ConfirmTopicMaterial | null> {
  if (!o.target || o.topics.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([loadConfirmTopicRoutes(o), new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); })]);
  } catch (e) {
    console.warn("[confirm-topic] 失敗:", o.conversationId, e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
