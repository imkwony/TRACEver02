// 원래 서버(app.py)가 하던 일을 브라우저에서 한다. 화면은 예전처럼 api(경로, 본문)를 부르고, 여기서 처리한다.
// 설정·강의·채점기준표는 localStorage, 평가 기록과 음성·pdf 원본은 IndexedDB에 저장한다(이 브라우저에만 남는다).
(function (root) {
  const C = root.Core, L = root.LLM;
  const MATERIAL_LIMIT = 60000;  // LLM에 넘기는 자료 글자 수 상한
  const SAMPLES = "자료/샘플 발표 자료/", SAMPLE_SUFFIX = "_대본.txt";
  const DEFAULT_COURSES = [{id: "ai-ethics-01", name: "인공지능 윤리 01반", rubric_id: "default"}];
  let DEFAULT_RUBRIC = null, SAMPLE_NAMES = [];

  const fail = msg => { throw new Error(msg); };

  // ---- 저장 ----
  const ls = {
    get(key, fallback) { try { const v = localStorage.getItem("trace." + key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    set(key, value) { localStorage.setItem("trace." + key, JSON.stringify(value)); },
  };
  let dbPromise;
  function db() {
    return dbPromise ||= new Promise((ok, no) => {
      const r = indexedDB.open("trace", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("records"); r.result.createObjectStore("files"); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
  }
  async function idb(store, mode, fn) {
    const d = await db();
    return new Promise((ok, no) => {
      const t = d.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => ok(req.result);
      t.onerror = () => no(t.error);
    });
  }
  const pad = n => String(n).padStart(2, "0");
  function now() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("").slice(0, n);

  function settings() {
    const s = ls.get("settings", {});
    return {api_key: s.api_key || "", model: s.model || L.DEFAULT_MODEL, model2: s.model2 || L.DEFAULT_MODEL2, stt_model: s.stt_model || L.DEFAULT_STT_MODEL};
  }
  function publicSettings() {
    const {api_key: key, ...s} = settings();
    return {...s, has_key: Boolean(key), key_hint: key ? key.slice(-4) : ""};
  }
  const savedRubrics = () => ls.get("rubrics", {});
  function loadRubric(id) {
    if (id === "default") return DEFAULT_RUBRIC;
    return savedRubrics()[id] || fail("채점기준표를 찾을 수 없습니다.");
  }
  const courses = () => ls.get("courses", DEFAULT_COURSES);
  async function loadSession(sid) { return (await idb("records", "readonly", o => o.get(sid))) || fail("기록을 찾을 수 없습니다."); }
  async function saveSession(s, event, detail) {
    s.updated_at = now();
    if (event) s.log.push({time: s.updated_at, event, detail: detail ?? null});
    s = JSON.parse(JSON.stringify(s));  // 기록에는 순수 데이터만 둔다.
    await idb("records", "readwrite", o => o.put(s, s.id));
    return s;
  }
  // 받은 음성이나 pdf 원본을 기록과 함께 보관한다. 저장한 파일 이름을 돌려준다.
  async function saveFile(sid, label, [name, blob]) {
    const file = label + "." + (L.extOf(name) || "wav");
    await idb("files", "readwrite", o => o.put(blob, `${sid}/${file}`));
    return file;
  }

  // ---- 글자 뽑기 ----
  async function extractText(name, blob) {
    const ext = L.extOf(name);
    if (ext === "txt" || ext === "md") return blob.text();
    if (ext === "pdf") {
      const pdf = await root.pdfjsLib.getDocument({data: new Uint8Array(await blob.arrayBuffer())}).promise, out = [];
      for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map(t => t.str + (t.hasEOL ? "\n" : "")).join(""));
      return out.join("\n");
    }
    if (ext === "pptx") {
      const zip = await root.JSZip.loadAsync(blob), num = n => parseInt(n.match(/(\d+)\.xml$/)[1], 10);
      const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
      const out = [];
      for (const n of slides) {
        const xml = new DOMParser().parseFromString(await zip.file(n).async("string"), "application/xml");
        for (const p of xml.getElementsByTagNameNS("*", "p")) {
          const t = [...p.getElementsByTagNameNS("*", "t")].map(x => x.textContent).join("");
          if (t) out.push(t);
        }
      }
      return out.join("\n");
    }
    return null;
  }

  const fileOf = v => (v instanceof Blob ? [v.name || "audio.wav", v] : null);

  // ---- 경로별 처리 ----
  const routes = [
    ["GET", /^\/api\/settings$/, () => publicSettings()],
    ["POST", /^\/api\/settings$/, (_, body) => {
      const s = settings();
      for (const k of ["model", "model2", "stt_model"]) if (body[k]) s[k] = body[k].trim();
      if (body.api_key) s.api_key = body.api_key.trim();
      ls.set("settings", s);
      return publicSettings();
    }],
    ["POST", /^\/api\/settings\/test$/, async () => ({ok: true, reply: (await L.chat(settings(), "한 단어로만 답한다.", "'연결됨'이라고 답하세요.")).slice(0, 100)})],
    ["GET", /^\/api\/models$/, () => L.listModels(settings())],

    ["GET", /^\/api\/rubrics$/, () => [DEFAULT_RUBRIC, ...Object.values(savedRubrics())].map(r => ({id: r.id, name: r.name}))],
    ["GET", /^\/api\/rubrics\/([\w-]+)$/, ([id]) => loadRubric(id)],
    ["POST", /^\/api\/rubrics$/, (_, body) => {
      const name = (body.name || "").trim();
      if (!name) fail("채점기준표 이름을 입력하세요.");
      const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
      if (!same(Object.keys(body.concepts || {}), C.CONCEPTS) || !same(Object.keys(body.relations || {}), C.PAIRS)) fail("개념 7개와 관계 10개가 모두 있어야 합니다.");
      const id = body.id && body.id !== "default" ? body.id : hex(8);
      const rubric = {id, name, competency: body.competency || "", saved_at: now(), concepts: body.concepts, relations: body.relations};
      ls.set("rubrics", {...savedRubrics(), [id]: rubric});
      return rubric;
    }],
    ["POST", /^\/api\/rubrics\/generate$/, async (_, body) => {
      const competency = (body.competency || "").trim();
      if (!competency) fail("목표 역량을 입력하세요.");
      const files = [], parts = [];
      let total = 0;
      for (const f of [...(body.files || [])].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name))) {
        if (total >= MATERIAL_LIMIT) break;
        let text = await extractText(f.name, f).catch(() => null);
        if (text && text.trim()) {
          text = text.slice(0, MATERIAL_LIMIT - total);
          total += text.length;
          files.push(f.name);
          parts.push(`[${f.name}]\n${text}`);
        }
      }
      const draft = await L.generateRubric(settings(), competency, parts.join("\n\n"));
      // 모델이 빠뜨린 항목은 기본 기준표로 채우고 어떤 항목인지 알려준다.
      const filled = [], result = {concepts: {}, relations: {}};
      for (const [group, names] of [["concepts", C.CONCEPTS], ["relations", C.PAIRS]]) {
        const got = {};
        for (const [k, v] of Object.entries(draft[group] || {})) got[C.normalizeUnit(k)] = v;
        for (const name of names) {
          let e = got[name];
          if (!e || typeof e !== "object" || !e.understand) { e = DEFAULT_RUBRIC[group][name]; filled.push(name); }
          result[group][name] = {definition: String(e.definition ?? ""), understand: String(e.understand ?? ""), apply: String(e.apply ?? ""),
            misconceptions: Array.isArray(e.misconceptions) ? e.misconceptions.map(String) : []};
        }
      }
      return {...result, competency, files, filled_from_default: filled};
    }],

    ["GET", /^\/api\/courses$/, () => courses()],
    ["POST", /^\/api\/courses$/, (_, body) => {
      const name = (body.name || "").trim();
      if (!name) fail("강의 이름을 입력하세요.");
      loadRubric(body.rubric_id);
      const list = courses();
      let c = list.find(x => x.id === body.id);
      if (!c) { c = {id: hex(8)}; list.push(c); }
      Object.assign(c, {name, rubric_id: body.rubric_id});
      ls.set("courses", list);
      return list;
    }],

    ["POST", /^\/api\/extract-text$/, async (_, fd) => {
      const file = fd.get("file"), text = await extractText(file.name, file);
      if (text === null) fail("지원하는 발표자료 형식은 pdf, pptx, txt, md입니다.");
      return {name: file.name, text: text.slice(0, MATERIAL_LIMIT)};
    }],
    ["GET", /^\/api\/units$/, () => ({concepts: C.CONCEPTS, principles: C.PRINCIPLES, elements: C.ELEMENTS, pairs: C.PAIRS})],

    ["GET", /^\/api\/samples$/, () => SAMPLE_NAMES],
    ["GET", /^\/api\/samples\/(.+)$/, async ([name]) => {
      name = decodeURIComponent(name);
      if (!SAMPLE_NAMES.includes(name)) fail("샘플을 찾을 수 없습니다.");
      const raw = new Uint8Array(await (await fetch(encodeURI(SAMPLES + name + SAMPLE_SUFFIX))).arrayBuffer());
      let transcript;
      try { transcript = new TextDecoder("utf-8", {fatal: true}).decode(raw); } catch (e) { transcript = new TextDecoder("euc-kr").decode(raw); }
      const pdf = await samplePdf(name);
      return {name, transcript, materials_name: pdf ? pdf.name : "",
        materials_text: pdf ? ((await extractText(pdf.name, pdf)) || "").slice(0, MATERIAL_LIMIT) : ""};
    }],

    ["GET", /^\/api\/sessions$/, async () => {
      const all = await idb("records", "readonly", o => o.getAll());
      return all.sort((a, b) => (a.id < b.id ? 1 : -1)).map(s => ({
        id: s.id, created_at: s.created_at, course_name: s.course_name, student: s.student, topic: s.analysis.topic || "",
        finished: s.finished, turns: s.turns.length, needs_instructor: Object.values(s.state).filter(u => u.needs_instructor).length}));
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)$/, ([sid]) => loadSession(sid)],
    // 탭 3: 발표를 분석해 주제와 개념을 파악하고 초기 상태를 만든다.
    ["POST", /^\/api\/sessions$/, async (_, fd) => {
      const v = k => String(fd.get(k) ?? "");
      const course = courses().find(c => c.id === v("course_id")) || fail("탭 2에서 강의를 먼저 선택하세요.");
      const rubric = loadRubric(course.rubric_id);
      const clip = fileOf(fd.get("audio"));
      let transcript = v("transcript");
      if (clip) transcript = await L.transcribe(settings(), ...clip);
      transcript = transcript.trim();
      if (!transcript) fail(clip ? "음성에서 말소리를 찾지 못했습니다." : "발표 전사문을 입력하세요.");
      // 발표자료가 pdf면 원본을 모델에 그대로 넘긴다. 샘플은 샘플 폴더의 pdf를 쓴다.
      let pdf = null;
      const materials = fileOf(fd.get("materials"));
      if (materials && L.extOf(materials[0]) === "pdf") pdf = materials;
      else if (SAMPLE_NAMES.includes(v("sample"))) { const f = await samplePdf(v("sample")); if (f) pdf = [f.name, f]; }
      const [analysis, audioInfo, pdfInfo] = await L.analyzePresentation(settings(), transcript, v("materials_text"), clip, pdf);
      const said = (analysis.mentioned_concepts || []).map(String), saidP = said.map(x => C.ALIASES[x] || x);
      // 원칙 이름('투명성과 설명가능성')으로 적었으면 그 원칙의 요소를 모두 다룬 것으로 본다.
      const mentioned = C.CONCEPTS.filter(c => said.includes(c) || saidP.includes(C.principleOf(c)));
      analysis.mentioned_concepts = mentioned;
      const d = new Date();
      const sid = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex(4)}`;
      if (clip) audioInfo.file = await saveFile(sid, "presentation", clip);
      if (pdf) pdfInfo.file = await saveFile(sid, "materials", pdf);
      const s = {
        id: sid, created_at: now(), course_id: course.id, course_name: course.name,
        student: {name: v("student_name"), number: v("student_number")},
        rubric,  // 기준표를 나중에 고쳐도 기록이 바뀌지 않게 사본을 둔다.
        presentation: {transcript, audio: audioInfo, materials_file: pdfInfo, materials_name: v("materials_name"), materials_text: v("materials_text")},
        analysis, state: C.initialState(mentioned, analysis.most_related_concept),
        turns: [], finished: false, feedback: null, log: [],
      };
      return saveSession(s, "발표 분석", analysis);
    }],
    // 탭 4: 다음 턴의 질문을 만든다.
    ["POST", /^\/api\/sessions\/([\w-]+)\/questions$/, async ([sid]) => {
      const s = await loadSession(sid);
      if (s.finished || s.turns.length >= C.MAX_TURNS) fail("질의응답이 이미 끝났습니다.");
      if (s.turns.length && s.turns[s.turns.length - 1].answers === null) fail("이전 턴의 답변을 먼저 제출하세요.");
      const turnNo = s.turns.length + 1, statuses = {};
      for (const [n, u] of Object.entries(s.state)) {
        statuses[n] = u.status + (u.certain ? "" : "(불확실)");
        if (u.status === C.UNKNOWN && u.disagreement) statuses[n] += "(채점자 의견 갈림: " + u.disagreement.map(o => o.status).join(" / ") + ")";
      }
      const result = await L.generateQuestions(settings(), s.analysis, statuses, s.rubric, s.turns, turnNo);
      const questions = [];
      for (const q of (result.questions || []).slice(0, C.MAX_QUESTIONS)) {
        if (!q || typeof q !== "object" || !String(q.text ?? "").trim()) continue;
        const targets = [...new Set((q.targets || []).flatMap(t => C.expandUnit(t)))];
        questions.push({text: String(q.text).trim(), targets, intent: String(q.intent ?? "")});
      }
      if (!questions.length) fail("모델이 질문을 만들지 못했습니다. 다시 시도하세요.");
      C.markAsked(s.state, questions);
      s.turns.push({turn: turnNo, questions, answers: null, judgments: [], discarded: []});
      return saveSession(s, `${turnNo}턴 질문 생성`, questions);
    }],
    // 탭 4: 답변을 받아 판정하고, 종료 규칙을 적용한다.
    ["POST", /^\/api\/sessions\/([\w-]+)\/answers$/, async ([sid], fd) => {
      const s = await loadSession(sid);
      if (!s.turns.length || s.turns[s.turns.length - 1].answers !== null) fail("답변을 받을 질문이 없습니다.");
      const turn = s.turns[s.turns.length - 1], n = turn.questions.length;
      const answers = JSON.parse(fd.get("answers") || "[]").map(a => String(a ?? "").trim()).concat(Array(n).fill("")).slice(0, n);
      const clips = {};
      for (let i = 0; i < Math.min(n, 3); i++) { const c = fileOf(fd.get("audio" + i)); if (c) clips[i] = c; }
      for (const [i, clip] of Object.entries(clips)) answers[i] = (await L.transcribe(settings(), ...clip)).trim();
      if (!answers.some(Boolean)) fail("답변을 입력하세요.");
      // 두 채점자(모델)가 따로 판정한다. 두 채점자의 상태가 같은 항목만 확정된다.
      const st = settings(), models = [st.model, st.model2];
      const graders = models.map((m, i) => `채점자 ${i + 1} (${m})`), units = Object.keys(s.state);
      const results = await Promise.all(models.map(model =>
        L.judgeAnswers({...st, model}, s.analysis.topic || "", turn.questions, answers, s.rubric, clips, units)));
      const byGrader = [], discarded = [];
      results.forEach(([result], i) => {
        const [valid, bad] = C.validJudgments(result.judgments, turn.turn, turn.questions, answers, s.rubric, graders[i]);
        byGrader.push(valid); discarded.push(...bad);
      });
      const infos = results.map(r => r[1]);
      const audioInfo = infos.find(i => i && !i.passed) || infos[0];  // 못 보낸 채점자가 있으면 그 이유
      if (Object.keys(clips).length) {
        audioInfo.files = [];
        for (let i = 0; i < n; i++) audioInfo.files.push(clips[i] ? await saveFile(sid, `turn${turn.turn}_q${i + 1}`, clips[i]) : null);
      }
      turn.audio = audioInfo; turn.answers = answers;
      turn.graders = graders; turn.discarded = discarded;
      // 화면에서 채점자별 판정을 나란히 보여 주려고 남긴다. by_grader: 인정된 판정, grader_raw: 모델이 낸 판정 그대로(미확인 이유 포함)
      turn.by_grader = byGrader;
      turn.grader_raw = results.map(([result]) => (Array.isArray(result.judgments) ? result.judgments : []));
      [turn.judgments, turn.disagreements] = C.applyJudgments(s.state, byGrader, graders, turn.turn);
      if (turn.turn >= C.MAX_TURNS || !C.needsSecondTurn(s.state)) {
        C.finalize(s.state, s.turns);
        s.finished = true;
      }
      let saved = await saveSession(s, `${turn.turn}턴 답변 판정`,
        {answers, audio: audioInfo, graders, by_grader: byGrader, confirmed: turn.judgments, disagreements: turn.disagreements, discarded});
      if (saved.finished) {
        try { saved = await writeFeedback(saved); } catch (e) { /* 판정은 이미 저장됐다. 피드백은 탭 5에서 다시 만들 수 있다. */ }
      }
      return saved;
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/feedback$/, async ([sid]) => {
      const s = await loadSession(sid);
      if (!s.finished) fail("질의응답이 끝난 뒤에 피드백을 만들 수 있습니다.");
      return writeFeedback(s);
    }],
    // 탭 5: 교수자 직접 판정.
    ["POST", /^\/api\/sessions\/([\w-]+)\/override$/, async ([sid], body) => {
      const s = await loadSession(sid), {unit, status} = body, note = (body.note || "").trim();
      if (!C.UNITS.includes(unit) || !C.STATUSES.includes(status)) fail("항목 또는 상태가 잘못되었습니다.");
      if (!note) fail("판정 사유를 적어 주세요.");
      C.instructorOverride(s.state, unit, status, note);
      return saveSession(s, "교수자 판정", {unit, status, note});
    }],
  ];

  async function writeFeedback(s) {
    const fb = await L.writeFeedback(settings(), s.analysis.topic || "", s.state, s.rubric);
    const items = (fb.items || []).filter(i => i && typeof i === "object").map(i => ({unit: C.normalizeUnit(i.unit), text: String(i.text ?? "")}));
    s.feedback = {overall: String(fb.overall ?? ""), items: items.filter(i => i.unit)};
    return saveSession(s, "피드백 작성", s.feedback);
  }

  async function samplePdf(name) {
    const r = await fetch(encodeURI(SAMPLES + name + ".pdf"));
    return r.ok ? new File([await r.blob()], name + ".pdf", {type: "application/pdf"}) : null;
  }

  // 화면이 부르는 함수. 예전 서버의 fetch(path)와 같은 자리에 쓴다.
  async function api(path, body) {
    const method = body === undefined ? "GET" : "POST";
    for (const [m, re, fn] of routes) {
      const hit = m === method && path.match(re);
      if (hit) return fn(hit.slice(1), body);
    }
    fail("알 수 없는 요청: " + path);
  }

  async function init() {
    if (root.pdfjsLib) root.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const [rubric, samples] = await Promise.all([
      fetch(encodeURI("채점기준표/rubric_default.json")).then(r => r.json()),
      fetch(encodeURI(SAMPLES + "samples.json")).then(r => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    DEFAULT_RUBRIC = rubric; SAMPLE_NAMES = samples;
  }

  // 실시간 받아쓰기 소켓(키는 이 브라우저의 설정에서 읽는다).
  const openLiveSocket = rate => L.openLiveSocket(settings(), rate);
  async function exportSession(sid) { return new Blob([JSON.stringify(await loadSession(sid), null, 2)], {type: "application/json"}); }

  root.Engine = {api, init, openLiveSocket, exportSession};
})(window);
