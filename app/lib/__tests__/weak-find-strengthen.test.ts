/**
 * F60 弱所横断の計画
 * npx tsx app/lib/__tests__/weak-find-strengthen.test.ts
 */
import { buildWeakFindPlan, evaluateWeakFindStamp } from "../weak-find-strengthen";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  const ok = buildWeakFindPlan({
    autoAfterBundle: true,
    playbookReflectOk: true,
    playbookSeenRecent: true,
    adSortOk: true,
    nearnessScore: 80,
    humanBandPct: 55,
    autoPointPct: 65,
    autoCursorPct: 75,
    f57Ok: true,
    extTestOk: true,
    thinPointFields: 4,
  });
  assert(ok.ok && ok.gaps.length === 0, "all clear");
  assert(/仕組み台帳✓/.test(ok.mech_line), "mech clear " + ok.mech_line);
}

{
  const p = buildWeakFindPlan({
    autoAfterBundle: false,
    playbookReflectOk: false,
    playbookReflectWhy: "自動が古い手順書",
    playbookSeenRecent: false,
    playbookSeenWhy: "rv=old ≠ コード new",
    adSortOk: false,
    nearnessScore: 66,
    humanBandPct: 23,
    autoPointPct: 52,
    autoCursorPct: 64,
    f57Ok: false,
    f57Why: "欠段",
    extTestOk: true,
    thinPointFields: 12,
  });
  assert(!p.ok, "not ok");
  assert(p.gaps[0].severity === "P0", "P0 first got " + p.gaps[0].severity);
  assert(
    p.gaps.some((g) => g.id === "auto_after_bundle") &&
      p.gaps.some((g) => g.id === "playbook_reflect") &&
      p.gaps.some((g) => g.id === "playbook_seen"),
    "reflect gaps",
  );
  assert(p.gaps.some((g) => g.id === "nearness_fold"), "nearness");
  assert(p.gaps.some((g) => g.id === "thin_points" && g.severity === "P2"), "thin P2");
  assert(/再読込|自動1回|human-like|weak-strengthen|ext-test|check-playbook/.test(p.next), "next routes " + p.next);
  // 仕組みは全部ある・本番未達は人待ちが先頭
  assert(p.gaps.every((g) => g.mech.exists), "all mechs exist");
  assert(/本番未達\(人\)/.test(p.mech_line), "mech_line human " + p.mech_line);
  assert(/人待ち/.test(p.mech_line) || /先頭人待ち=/.test(p.mech_line), "human wait " + p.mech_line);
  const seen = p.gaps.find((g) => g.id === "playbook_seen");
  assert(!!seen && /rv=/.test(seen.why), "seen why has rv " + seen?.why);
}

{
  const ev = evaluateWeakFindStamp({
    ok: false,
    gaps: [{ id: "auto_after_bundle" }],
    next: "scripts/weak-find.ts",
    mech_line: "仕組み台帳 本番未達(人)1",
  });
  assert(!ev.ok, "stamp not ok");
  assert(/仕組み台帳/.test(ev.mech_line), "stamp mech");
}

console.log("weak-find-strengthen.test OK");
