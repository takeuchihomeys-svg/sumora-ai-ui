// LINE の宛先（個人／グループ）の見分けと、送る直前の関門（2026-09-21 竹内・黒明様お部屋探し）
// 実行: npx tsx app/lib/__tests__/line-target.test.ts（全 PASS で exit 0）
import {
  lineTargetKind, isMultiPersonTarget, resolveEventTarget, groupConversationName, isGroupConversationName,
  checkSendTarget, GROUP_NAME_PREFIX,
} from "../line-target";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} in ${JSON.stringify(actual)}`); },
  };
}

// 実物の形（黒明さん個人の ID はスクショの会話の物。グループ ID は形だけ合わせた架空）
const USER = "Ud274906f2331fd21bc3d71e2a795318b";
const GROUP = "C0123456789abcdef0123456789abcdef";
const ROOM = "R0123456789abcdef0123456789abcdef";

describe("★★ ID の種類", () => {
  it("★★ K1 U は個人・C はグループ・R はトークルーム", () => {
    expect(lineTargetKind(USER)).toBe("user");
    expect(lineTargetKind(GROUP)).toBe("group");
    expect(lineTargetKind(ROOM)).toBe("room");
  });
  it("K2 形が違う ID は null（空・短い・別の文字で始まる）", () => {
    for (const s of ["", null, undefined, "U123", "X0123456789abcdef0123456789abcdef", `${USER}0`]) expect(lineTargetKind(s)).toBe(null);
  });
  it("K3 グループとトークルームは複数人の宛先", () => {
    expect(isMultiPersonTarget(GROUP)).toBe(true);
    expect(isMultiPersonTarget(ROOM)).toBe(true);
    expect(isMultiPersonTarget(USER)).toBe(false);
  });
});

describe("★★ webhook の宛先と発言者を分ける（resolveEventTarget）", () => {
  it("★★ E1 グループの発言は**グループ ID** を宛先にする（発言者の個人 ID にしない）← 黒明様の事故", () => {
    const t = resolveEventTarget({ type: "group", groupId: GROUP, userId: USER });
    expect(t?.targetId).toBe(GROUP);
    expect(t?.kind).toBe("group");
    expect(t?.speakerUserId).toBe(USER);
  });
  it("★ E2 個人の発言は従来どおり userId", () => {
    const t = resolveEventTarget({ type: "user", userId: USER });
    expect(t?.targetId).toBe(USER);
    expect(t?.kind).toBe("user");
  });
  it("E3 type が無くても userId があれば個人（従来の動きを変えない）", () => {
    expect(resolveEventTarget({ userId: USER })?.targetId).toBe(USER);
  });
  it("E4 トークルームは roomId", () => {
    expect(resolveEventTarget({ type: "room", roomId: ROOM, userId: USER })?.targetId).toBe(ROOM);
  });
  it("★ E5 グループで発言者が分からなくても（userId なし）グループの会話にはなる", () => {
    const t = resolveEventTarget({ type: "group", groupId: GROUP });
    expect(t?.targetId).toBe(GROUP);
    expect(t?.speakerUserId).toBe(null);
  });
  it("★ E6 グループなのに groupId が無い時は**個人にしない**（null＝保存しない）", () => {
    expect(resolveEventTarget({ type: "group", userId: USER })).toBe(null);
  });
});

describe("★★ グループと分かる名前", () => {
  it("★★ N1 グループ名に【グループ】を付ける", () => {
    expect(groupConversationName("黒明様お部屋探し")).toBe(`${GROUP_NAME_PREFIX}黒明様お部屋探し`);
  });
  it("★ N2 名前が取れない時も【グループ】と分かる", () => {
    expect(groupConversationName("")).toContain(GROUP_NAME_PREFIX);
    expect(groupConversationName(null)).toContain("グループ");
  });
  it("N3 印付きの名前はグループと判定（呼び名に使わない入口）", () => {
    expect(isGroupConversationName(groupConversationName("黒明様お部屋探し"))).toBe(true);
    expect(isGroupConversationName("黒明 基揮")).toBe(false);
  });
});

describe("★★ 送る直前の関門（checkSendTarget）", () => {
  it("★★ S1 グループの会話からグループへ → 送る", () => {
    expect(checkSendTarget(GROUP, { line_user_id: GROUP }).ok).toBe(true);
  });
  it("★★ S2 グループの会話なのに個人へ送ろうとした → 止める", () => {
    const r = checkSendTarget(USER, { line_user_id: GROUP });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("target_mismatch"); expect(r.message).toContain("グループ"); }
  });
  it("★★ S3 個人の会話なのにグループへ送ろうとした → 止める", () => {
    const r = checkSendTarget(GROUP, { line_user_id: USER });
    expect(r.ok).toBe(false);
  });
  it("★★ S4 グループから誤って作られた個人の会話 → 止める（黒明さん個人の会話）", () => {
    const r = checkSendTarget(USER, { line_user_id: USER, send_blocked_reason: "created_from_group" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("send_blocked"); expect(r.message).toContain("グループ"); }
  });
  it("★ S5 ふつうの個人の会話 → 送る（今までの動きを変えない）", () => {
    expect(checkSendTarget(USER, { line_user_id: USER, send_blocked_reason: null }).ok).toBe(true);
  });
  it("S6 宛先の形が違う → 止める", () => {
    expect(checkSendTarget("abc", null).ok).toBe(false);
  });
  it("S7 会話が分からない呼び出しは形だけ見る", () => {
    expect(checkSendTarget(GROUP, null).ok).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
