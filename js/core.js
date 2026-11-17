// 상태표 규칙. LLM을 부르지 않는 순수 로직만 둔다. (원래 core.py)
(function (root) {
  // 원칙 5개. 관계(개념 쌍)는 원칙끼리 맺는다.
  const PRINCIPLES = ["신뢰성", "공정성", "윤리성", "투명성과 설명가능성", "안전성과 견고성"];
  // 두 요소로 된 원칙은 요소별로 따로 판정한다(채점기준표 C4a/C4b, C5a/C5b).
  const ELEMENTS = {"투명성과 설명가능성": ["투명성", "설명가능성"], "안전성과 견고성": ["안전성", "견고성"]};
  const CONCEPTS = PRINCIPLES.flatMap(p => ELEMENTS[p] || [p]);
  const PAIRS = PRINCIPLES.flatMap((a, i) => PRINCIPLES.slice(i + 1).map(b => `${a}|${b}`));
  const UNITS = CONCEPTS.concat(PAIRS);
  const ALIASES = {"견고성과 안전성": "안전성과 견고성", "설명가능성과 투명성": "투명성과 설명가능성"};

  // 이해 못함: 모르겠다고 하거나, 엉뚱한 대답을 하거나, 답 내용으로 보아 이해하지 못한 것이 드러남(판단 가능).
  // 미확인: 근거가 부족해 판단할 수 없음(판단 불가).
  const APPLY = "적용 수준", UNDERSTAND = "이해 수준", MISCONCEPTION = "오개념", NOT_UNDERSTOOD = "이해 못함", UNKNOWN = "미확인";
  const JUDGED = [APPLY, UNDERSTAND, MISCONCEPTION, NOT_UNDERSTOOD];
  const STATUSES = JUDGED.concat([UNKNOWN]);
  const MAX_TURNS = 2, MAX_QUESTIONS = 3, MIN_QUOTE_LEN = 6;
  const MIN_QUOTE_LEN_SHORT = 2;  // 이해 못함은 "몰라요"처럼 짧은 답도 근거가 된다.

  // 개념이나 원칙 이름이 속한 원칙. 모르는 이름이면 null.
  function principleOf(name) {
    name = ALIASES[name] || name;
    if (PRINCIPLES.includes(name)) return name;
    return Object.keys(ELEMENTS).find(p => ELEMENTS[p].includes(name)) || null;
  }

  // LLM이 준 항목 이름을 표준 이름으로 바꾼다. 알 수 없으면 null.
  function normalizeUnit(value) {
    const names = Array.isArray(value) ? value.map(v => String(v).trim())
      : String(value ?? "").split(/[|↔\-–~,/]|<->/).map(n => n.trim()).filter(Boolean);
    if (names.length === 1) return CONCEPTS.includes(names[0]) ? names[0] : null;
    if (names.length === 2) {
      let [a, b] = names.map(principleOf);
      if (a && b && a !== b) {
        [a, b] = [a, b].sort((x, y) => PRINCIPLES.indexOf(x) - PRINCIPLES.indexOf(y));
        return `${a}|${b}`;
      }
    }
    return null;
  }

  // 원칙 이름이면 그 요소 둘을 돌려준다.
  function expandUnit(value) {
    const unit = normalizeUnit(value);
    if (unit) return [unit];
    return ELEMENTS[principleOf(String(value ?? "").trim())] || [];
  }

  const newUnit = status => ({status, source: "초기", certain: true, needs_instructor: false, note: "", evidence: [], disagreement: null});

  function ensure(state, unit) {
    if (!(unit in state)) state[unit] = newUnit(UNKNOWN);
    return state[unit];
  }

  const ordered = state => Object.fromEntries(UNITS.filter(u => u in state).map(u => [u, state[u]]));

  function initialState(mentioned, mostRelated) {
    const covered = PRINCIPLES.filter(p => (mentioned || []).some(c => principleOf(c) === p));
    const state = {};
    for (const p of covered) for (const c of ELEMENTS[p] || [p]) state[c] = newUnit(UNKNOWN);
    if (covered.length === 1) {
      const other = principleOf(mostRelated);
      if (other && other !== covered[0]) state[normalizeUnit([covered[0], other])] = newUnit(UNKNOWN);
    } else {
      covered.forEach((a, i) => covered.slice(i + 1).forEach(b => { state[normalizeUnit([a, b])] = newUnit(UNKNOWN); }));
    }
    return ordered(state);
  }

  const norm = text => String(text ?? "").replace(/[\s"'“”‘’.,!?…·()\[\]]/g, "");

  // 인용문이 실제 전사문에 있는지 대조한다. 띄어쓰기와 문장부호 차이는 무시한다.
  function quoteIn(quote, text, minLen = MIN_QUOTE_LEN) {
    const q = norm(quote);
    return q.length >= minLen && norm(text).includes(q);
  }

  const rubricEntry = (rubric, unit) => (rubric.concepts || {})[unit] || (rubric.relations || {})[unit] || {};

  function rubricItem(rubric, unit, status, misconceptionIndex = 0) {
    const entry = rubricEntry(rubric, unit);
    if (status === APPLY) return `적용 수준 기준: ${entry.apply || ""}`;
    if (status === UNDERSTAND) return `이해 수준 기준: ${entry.understand || ""}`;
    if (status === NOT_UNDERSTOOD) return `이해 수준 기준에 못 미침: ${entry.understand || ""}`;
    const items = entry.misconceptions || [];
    const i = parseInt(misconceptionIndex, 10) || 0;
    if (i >= 1 && i <= items.length) return `흔한 오개념: ${items[i - 1]}`;
    return `이해 수준 기준에 어긋남: ${entry.understand || ""}`;
  }

  function markAsked(state, questions) {
    for (const q of questions) for (const u of q.targets) ensure(state, u);
  }

  // 채점자 한 명의 판정 중 인용문이 실제 답변에 있는 것만 남긴다. [{항목: 판정}, 버린 목록]
  function validJudgments(judgments, turnNo, questions, answers, rubric, grader) {
    const valid = {}, discarded = [];
    for (const j of judgments || []) {
      if (!j || typeof j !== "object" || Array.isArray(j)) continue;
      const unit = normalizeUnit(j.unit), status = j.status;
      if (status === UNKNOWN) continue;
      if (unit === null || !JUDGED.includes(status)) {
        discarded.push({...j, grader, discard_reason: "알 수 없는 항목 또는 상태"});
        continue;
      }
      const quote = String(j.quote ?? "").trim();
      const minLen = status === NOT_UNDERSTOOD ? MIN_QUOTE_LEN_SHORT : MIN_QUOTE_LEN;
      const qi = answers.findIndex(a => quoteIn(quote, a, minLen));
      if (qi < 0) {
        discarded.push({...j, grader, discard_reason: "인용문이 답변 전사문에 없음"});
        continue;
      }
      valid[unit] = {
        turn: turnNo, grader, question: questions[qi].text, quote, status,
        rubric_item: rubricItem(rubric, unit, status, j.misconception_index),
        reason: String(j.reason ?? ""), certain: j.certain === undefined ? true : Boolean(j.certain),
      };
    }
    return [valid, discarded];
  }

  // 두 채점자의 상태가 같을 때만 확정한다. [확정 목록, 불일치 목록]
  function applyJudgments(state, byGrader, graders, turnNo) {
    const accepted = [], disagreements = [];
    for (const unit of UNITS) {
      const found = byGrader.map(g => g[unit]);
      if (!found.some(Boolean)) continue;
      const opinions = found.map((o, i) => o || {turn: turnNo, grader: graders[i], status: UNKNOWN, quote: "", reason: "판정하지 않음"});
      const u = ensure(state, unit);
      if (new Set(opinions.map(o => o.status)).size === 1) {
        u.status = opinions[0].status; u.source = "답변 판정";
        u.certain = opinions.every(o => o.certain);
        u.evidence.push(...opinions);
        u.disagreement = null;
        accepted.push({unit, status: u.status, certain: u.certain});
      } else {
        u.disagreement = opinions;
        if (!(JUDGED.includes(u.status) && u.certain)) u.status = UNKNOWN;  // 이전 턴에 확정된 판정은 유지한다.
        disagreements.push({unit, opinions: opinions.map(o => ({grader: o.grader, status: o.status}))});
      }
    }
    return [accepted, disagreements];
  }

  // 미확인이 남았거나, 오개념·이해 못함 판정이 확실하지 않으면 2턴이 필요하다.
  const needsSecondTurn = state => Object.values(state).some(u => u.status === UNKNOWN
    || ((u.status === MISCONCEPTION || u.status === NOT_UNDERSTOOD) && !u.certain));

  function finalize(state, turns) {
    const asked = new Set(turns.flatMap(t => t.questions.flatMap(q => q.targets)));
    for (const name of Object.keys(state)) {
      const u = state[name];
      if (u.status !== UNKNOWN) continue;
      if (name.includes("|") && !asked.has(name) && !u.disagreement) delete state[name];
      else u.needs_instructor = true;
    }
  }

  function instructorOverride(state, unit, status, note) {
    const u = ensure(state, unit);
    Object.assign(u, {status, source: "교수자 판정", note, certain: true, needs_instructor: false});
  }

  root.Core = {PRINCIPLES, ELEMENTS, CONCEPTS, PAIRS, UNITS, ALIASES, APPLY, UNDERSTAND, MISCONCEPTION, NOT_UNDERSTOOD, UNKNOWN, JUDGED, STATUSES,
    MAX_TURNS, MAX_QUESTIONS, principleOf, normalizeUnit, expandUnit, ensure, initialState, quoteIn, rubricEntry, rubricItem,
    markAsked, validJudgments, applyJudgments, needsSecondTurn, finalize, instructorOverride};
})(typeof window !== "undefined" ? window : globalThis);
