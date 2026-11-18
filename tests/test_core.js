// 규칙 테스트. 실행: node tests/test_core.js
const ROOT = require("path").join(__dirname, "..");
const assert = require("assert");
require(ROOT + "/js/core.js");
const C = globalThis.Core;
const R = JSON.parse(require("fs").readFileSync(ROOT + "/채점기준표/rubric_default.json", "utf8"));
const TR = "투명성과 설명가능성", SAFE = "안전성과 견고성";
const Q = [{text: "질문1", targets: ["공정성"]}, {text: "질문2", targets: [`공정성|${TR}`]}];
const A = ["공정성은 특정 집단이 부당하게 불이익을 받지 않게 하는 것입니다.", "잘 모르겠습니다."];
const eq = assert.deepStrictEqual, ok = assert.ok;
const valid0 = () => ({turn: 1, grader: "g", question: "q", quote: "몰라요", status: "", rubric_item: "", reason: "", certain: true});
const tests = {
  units() {
    eq(C.CONCEPTS, ["신뢰성", "공정성", "윤리성", "투명성", "설명가능성", "안전성", "견고성"]);
    ok(C.PAIRS.length === 10 && C.UNITS.length === 17);
    eq(C.normalizeUnit("투명성"), "투명성"); eq(C.normalizeUnit(TR), null);
    eq(C.expandUnit(TR), ["투명성", "설명가능성"]);
    eq(C.normalizeUnit(`${TR}|공정성`), `공정성|${TR}`);
    eq(C.normalizeUnit("공정성 ↔ 설명가능성"), `공정성|${TR}`);
    eq(C.normalizeUnit(["견고성과 안전성", "신뢰성"]), `신뢰성|${SAFE}`);
    eq(C.normalizeUnit("투명성|설명가능성"), null); eq(C.normalizeUnit("효율성"), null);
    eq(Object.keys(R.concepts), C.CONCEPTS);
    eq(new Set(Object.keys(R.relations)), new Set(C.PAIRS));
  },
  initialState() {
    let s = C.initialState(["공정성"], "투명성");
    eq(s["공정성"].status, C.UNKNOWN); eq(s[`공정성|${TR}`].status, C.UNKNOWN); ok(!("투명성" in s));
    s = C.initialState(["견고성", "신뢰성"]);
    ok(s["안전성"].status === C.UNKNOWN && s["견고성"].status === C.UNKNOWN);
    eq(s[`신뢰성|${SAFE}`].status, C.UNKNOWN);
    ok(Object.keys(s).length === 4);
    eq(Object.keys(s), C.UNITS.filter(u => u in s));
  },
  quote() {
    ok(C.quoteIn("특정 집단이  부당하게 불이익을", A[0]));
    ok(!C.quoteIn("모두에게 똑같이 대하는 것", A[0])); ok(!C.quoteIn("것", A[0]));
  },
  judgments() {
    const [valid, discarded] = C.validJudgments([
      {unit: "공정성", status: C.UNDERSTAND, quote: "부당하게 불이익을 받지 않게", certain: true},
      {unit: `공정성|${TR}`, status: C.MISCONCEPTION, quote: "투명하면 공정해집니다"},
      {unit: "투명성", status: "훌륭함", quote: "잘 모르겠습니다"}], 1, Q, A, R, "채점자 1");
    eq(Object.keys(valid), ["공정성"]); eq(discarded.length, 2);
    eq(valid["공정성"].question, "질문1"); ok(valid["공정성"].rubric_item.startsWith("이해 수준 기준: C2.LU"));
  },
  twoGraders() {
    const names = ["채점자 1", "채점자 2"];
    const same = C.validJudgments([{unit: "공정성", status: C.UNDERSTAND, quote: "부당하게 불이익을 받지 않게"}], 1, Q, A, R, names[0])[0];
    const other = C.validJudgments([{unit: "공정성", status: C.APPLY, quote: "특정 집단이 부당하게 불이익을"}], 1, Q, A, R, names[1])[0];
    let s = C.initialState(["공정성"], "투명성");
    let [acc, dis] = C.applyJudgments(s, [same, {...same}], names, 1);
    ok(s["공정성"].status === C.UNDERSTAND && s["공정성"].evidence.length === 2 && acc.length === 1 && !dis.length);
    s = C.initialState(["공정성"], "투명성");
    [acc, dis] = C.applyJudgments(s, [same, other], names, 1);
    ok(s["공정성"].status === C.UNKNOWN && !s["공정성"].evidence.length);
    eq(s["공정성"].disagreement.map(o => o.status), [C.UNDERSTAND, C.APPLY]);
    ok(!acc.length && dis.length === 1 && C.needsSecondTurn(s));
    s = C.initialState(["공정성"], "투명성");
    C.applyJudgments(s, [same, {}], names, 1);
    ok(s["공정성"].status === C.UNKNOWN && s["공정성"].disagreement[1].status === C.UNKNOWN);
    C.applyJudgments(s, [same, {...same}], names, 2);
    ok(s["공정성"].status === C.UNDERSTAND && s["공정성"].disagreement === null);
    s = C.initialState(["신뢰성"]);
    C.applyJudgments(s, [same, {...same}], names, 1);
    eq(s["공정성"].status, C.UNDERSTAND);
  },
  markAsked() { const s = C.initialState(["공정성"]); C.markAsked(s, [{text: "q", targets: ["윤리성"]}]); eq(s["윤리성"].status, C.UNKNOWN); },
  finalizeOverride() {
    const s = C.initialState(["공정성", "신뢰성"]);
    C.finalize(s, [{questions: [{text: "q", targets: ["공정성"]}]}]);
    ok(s["공정성"].needs_instructor && s["신뢰성"].needs_instructor && !("신뢰성|공정성" in s));
    C.instructorOverride(s, "공정성", C.UNDERSTAND, "구두로 확인");
    ok(s["공정성"].source === "교수자 판정" && !s["공정성"].needs_instructor);
  },
  notUnderstood() {
    ok(C.STATUSES.includes("이해 못함") && C.JUDGED.includes("이해 못함"));
    const ans = ["몰라요", "공정성은 특정 집단이 부당하게 불이익을 받지 않게 하는 것입니다."];
    const q = [{text: "질문1", targets: ["공정성"]}, {text: "질문2", targets: ["윤리성"]}];
    // 짧은 "몰라요"도 이해 못함의 근거가 된다. 다른 상태는 여전히 6자 이상이어야 한다.
    let [valid, bad] = C.validJudgments([{unit: "공정성", status: C.NOT_UNDERSTOOD, quote: "몰라요"}], 1, q, ans, R, "채점자 1");
    eq(valid["공정성"].status, C.NOT_UNDERSTOOD); ok(valid["공정성"].rubric_item.startsWith("이해 수준 기준에 못 미침"));
    [valid, bad] = C.validJudgments([{unit: "공정성", status: C.UNDERSTAND, quote: "몰라요"}], 1, q, ans, R, "채점자 1");
    ok(!Object.keys(valid).length && bad.length === 1);
    // 확실한 이해 못함은 2턴을 강제하지 않고, 종료 뒤 교수자 판단 필요로 가지 않는다.
    const s = C.initialState(["공정성"]);
    C.applyJudgments(s, [{"공정성": {...valid0(), status: C.NOT_UNDERSTOOD}}, {"공정성": {...valid0(), status: C.NOT_UNDERSTOOD}}], ["1", "2"], 1);
    eq(s["공정성"].status, C.NOT_UNDERSTOOD);
    delete s["공정성|투명성과 설명가능성"];
    ok(!C.needsSecondTurn(s));
    C.finalize(s, []); ok(!s["공정성"].needs_instructor);
    s["공정성"].certain = false; ok(C.needsSecondTurn(s));
  },
  secondTurn() {
    const s = C.initialState(["공정성"]);
    Object.assign(s["공정성"], {status: C.MISCONCEPTION, certain: true}); ok(!C.needsSecondTurn(s));
    s["공정성"].certain = false; ok(C.needsSecondTurn(s));
  },
  presentationStage() {
    // 발표에서 확정한 판정은 질의응답으로 확인하기 전까지 2턴을 요구하고, 답변 판정이 일치하면 바뀐다.
    const s = C.initialState(["공정성"]);
    delete s[`공정성|${TR}`];
    const mis = {...valid0(), turn: 0, status: C.MISCONCEPTION};
    C.applyJudgments(s, [{"공정성": mis}, {"공정성": mis}], ["1", "2"], 0, "발표 판정");
    eq([s["공정성"].status, s["공정성"].source], [C.MISCONCEPTION, "발표 판정"]);
    ok(C.needsSecondTurn(s));
    const und = {...valid0(), status: C.UNDERSTAND};
    C.applyJudgments(s, [{"공정성": und}, {}], ["1", "2"], 1);  // 질의응답에서 갈리면 발표 판정을 유지한다.
    eq(s["공정성"].status, C.MISCONCEPTION);
    C.applyJudgments(s, [{"공정성": und}, {"공정성": und}], ["1", "2"], 1);
    eq([s["공정성"].status, s["공정성"].source], [C.UNDERSTAND, "답변 판정"]);
    ok(!C.needsSecondTurn(s));
  },
};
for (const [n, f] of Object.entries(tests)) { f(); console.log("통과:", n); }
