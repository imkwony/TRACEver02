// baze API 호출. LLM 호출 5종과 음성 전사. (원래 llm.py) 브라우저에서 baze를 직접 부른다.
(function (root) {
  const {APPLY, CONCEPTS, MAX_QUESTIONS, MISCONCEPTION, NOT_UNDERSTOOD, PAIRS, UNDERSTAND, UNKNOWN} = root.Core;

  const BASE_URL = "https://api.baze.co/v1/gateway";
  const DEFAULT_MODEL = "gemini-3.5-flash-lite";  // 채점자 1. 발표 분석, 질문 생성, 피드백 작성도 이 모델이 한다.
  const DEFAULT_MODEL2 = "gemini-3.8-flash";  // 채점자 2
  const DEFAULT_STT_MODEL = "stt-async-v5";
  const REALTIME_STT_MODEL = "stt-rt-v5";
  const ATTACH_LIMIT = 17_000_000;  // baze 요청 본문 25MB 제한. base64로 늘어나는 것을 감안한 첨부 파일(음성, pdf) 합계 상한
  const STT_LIMIT = 20_000_000;  // 전사 요청 한 건의 음성 크기 상한
  const AUDIO_NOTE = "\n\n첨부한 음성이 원본이다. 음성을 직접 듣고 판단한다. 전사문은 자동 전사라 오류가 있을 수 있다.";

  const UNIT_GUIDE = (
    `개념 항목 이름(7개): ${CONCEPTS.join(", ")}\n` +
    `관계 항목 이름(10개, 원칙 사이의 관계): ${PAIRS.join(", ")}\n` +
    "투명성·설명가능성은 한 원칙의 두 요소이고 안전성·견고성도 그렇다. 개념 항목은 요소별로 따로 다룬다.\n" +
    "항목 이름은 위 표기를 글자 그대로 쓴다."
  );
  const JSON_ONLY = "설명이나 코드블록 표시 없이 JSON 객체 하나만 출력한다.";
  // 속도: 모든 호출에 붙이는 지시와 사고 예산. baze는 Gemini·GPT 계열에 reasoning_effort를 받는다("low"가 최소, Gemini는 약 1,024토큰).
  const SPEED_RULE = "[속도 우선] 생각(추론)은 최소한으로 하고 바로 답한다. 출력은 필요한 내용만 짧게 쓴다. 문장은 짧게, 군더더기 없이 쓴다.";
  const MIN_EFFORT = model => (/^(gemini|gpt|o\d)/i.test(model) ? {reasoning_effort: "low"} : {});

  class LLMError extends Error {}

  function headers(s) {
    if (!s.api_key) throw new LLMError("API 키가 없습니다. 오른쪽 위 설정에서 baze API 키를 입력하세요.");
    return {Authorization: `Bearer ${s.api_key}`};
  }

  async function request(method, s, path, {json, form, params} = {}) {
    let url = BASE_URL + path;
    if (params) url += "?" + new URLSearchParams(params);
    const opt = {method, headers: headers(s)};
    if (json) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(json); }
    if (form) opt.body = form;
    let r;
    try { r = await fetch(url, opt); } catch (e) { throw new LLMError(`baze 연결 실패: ${e.message}`); }
    if (r.status >= 400) throw new LLMError(`baze 오류 ${r.status}: ${(await r.text()).slice(0, 500)}`);
    return r.json();
  }

  const extOf = name => (String(name).match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  const toBase64 = blob => new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(",", 2)[1] || "");
    fr.onerror = () => no(fr.error);
    fr.readAsDataURL(blob);
  });

  // 첨부 파일을 baze가 받는 모양으로 바꾼다. pdf는 문서로, 나머지는 음성으로 보낸다.
  async function filePart(name, blob) {
    const b64 = await toBase64(blob), ext = extOf(name);
    if (ext === "pdf") return {type: "image_url", image_url: {url: "data:application/pdf;base64," + b64}};
    return {type: "input_audio", input_audio: {data: b64, format: ext || "wav"}};
  }

  // files: [[파일 이름, Blob]]. 있으면 음성이나 pdf를 글과 함께 그대로 보낸다.
  async function chat(s, system, user, files) {
    let content = user;
    if (files && files.length) content = [{type: "text", text: user}].concat(await Promise.all(files.map(([n, b]) => filePart(n, b))));
    const body = {model: s.model, max_tokens: 8000, ...MIN_EFFORT(s.model),
      messages: [{role: "system", content: SPEED_RULE + "\n" + system}, {role: "user", content}]};
    let data;
    try { data = await request("POST", s, "/chat/completions/", {json: body}); }
    catch (e) {
      // 사고 예산을 받지 않는 모델이면 그 설정만 빼고 한 번 더 보낸다.
      if (!body.reasoning_effort || !String(e.message).startsWith("baze 오류 400")) throw e;
      delete body.reasoning_effort;
      data = await request("POST", s, "/chat/completions/", {json: body});
    }
    try { return data.choices[0].message.content || ""; }
    catch (e) { throw new LLMError(`baze 응답 형식이 예상과 다릅니다: ${JSON.stringify(data).slice(0, 300)}`); }
  }

  // JSON 객체를 돌려준다. 형식이 깨지면 한 번 더 시도한다.
  async function chatJson(s, system, user, files) {
    let text = "";
    for (let i = 0; i < 2; i++) {
      text = await chat(s, system + "\n" + JSON_ONLY, user, files);
      try {
        const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
      } catch (e) { /* 다시 시도 */ }
    }
    throw new LLMError(`모델이 JSON 형식으로 답하지 않았습니다: ${text.slice(0, 300)}`);
  }

  // 음성이나 pdf를 그대로 붙여 보낸다. 모델이 못 받거나 너무 크면 글자만 보낸다. [결과, 파일별 전달 정보 목록]
  async function chatJsonFiles(s, system, user, files) {
    const sent = [], infos = [];
    let total = 0;
    for (const [name, blob] of files) {
      const ok = total + blob.size <= ATTACH_LIMIT;
      if (ok) { total += blob.size; sent.push([name, blob]); }
      infos.push({passed: ok, model: s.model,
        reason: ok ? "" : `파일이 커서 한 번에 보낼 수 없음(첨부 합계 ${Math.floor(ATTACH_LIMIT / 1e6)}MB 제한)`});
    }
    if (sent.length) {
      try { return [await chatJson(s, system, user, sent), infos]; }
      catch (e) {
        if (!(e instanceof LLMError)) throw e;
        for (const info of infos) if (info.passed) Object.assign(info, {passed: false, reason: e.message.slice(0, 300)});
      }
    }
    return [await chatJson(s, system, user), infos];
  }

  async function listModels(s) {
    const data = await request("GET", s, "/models/", {params: {type: "llm"}});
    return (data.data || []).map(m => m.id).sort();
  }

  // wav 파일의 fmt, data 위치를 찾는다.
  function wavInfo(buf) {
    const v = new DataView(buf);
    let o = 12, fmt = null, data = null;
    while (o + 8 <= v.byteLength) {
      const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)), size = v.getUint32(o + 4, true);
      if (id === "fmt ") fmt = {offset: o + 8, size, rate: v.getUint32(o + 12, true), block: v.getUint16(o + 20, true)};
      if (id === "data") data = {offset: o + 8, size: Math.min(size, v.byteLength - o - 8)};
      o += 8 + size + (size % 2);
    }
    return fmt && data ? {fmt, data} : null;
  }

  // 음성 파일을 전사한다. 큰 wav(긴 녹음)는 10분 단위로 나눠 전사한다.
  async function transcribe(s, filename, blob) {
    if (blob.size <= STT_LIMIT || extOf(filename) !== "wav") return transcribeOne(s, filename, blob);
    const buf = await blob.arrayBuffer(), info = wavInfo(buf);
    if (!info) return transcribeOne(s, filename, blob);
    const fmtBytes = new Uint8Array(buf, info.fmt.offset, info.fmt.size);
    const step = info.fmt.rate * info.fmt.block * 600, texts = [];
    for (let start = 0; start < info.data.size; start += step) {
      const n = Math.min(step, info.data.size - start), part = new ArrayBuffer(20 + fmtBytes.length + 8 + n), v = new DataView(part);
      const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
      str(0, "RIFF"); v.setUint32(4, part.byteLength - 8, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, fmtBytes.length, true);
      new Uint8Array(part, 20, fmtBytes.length).set(fmtBytes);
      str(20 + fmtBytes.length, "data"); v.setUint32(24 + fmtBytes.length, n, true);
      new Uint8Array(part, 28 + fmtBytes.length).set(new Uint8Array(buf, info.data.offset + start, n));
      texts.push(await transcribeOne(s, filename, new Blob([part], {type: "audio/wav"})));
    }
    return texts.join("\n");
  }

  const sleep = ms => new Promise(ok => setTimeout(ok, ms));

  // baze 전사 API는 접수 후 상태를 조회하는 방식이다.
  async function transcribeOne(s, filename, blob) {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", s.stt_model);
    form.append("language_hints", "ko");
    form.append("enable_speaker_diarization", "false");
    let op = await request("POST", s, "/audio/transcriptions/", {form});
    for (let i = 0; i < 240; i++) {  // 최대 20분
      if (op.status === "completed") return op.text || "";
      if (op.status === "failed") throw new LLMError(`전사 실패: ${op.error}`);
      await sleep(5000);
      op = await request("GET", s, `/audio/transcriptions/${op.operation_id}/`);
    }
    throw new LLMError("전사가 20분 안에 끝나지 않았습니다.");
  }

  // 실시간 받아쓰기 소켓을 연다. 브라우저는 헤더를 실을 수 없어 일회용 토큰을 받아 주소에 붙인다.
  async function openLiveSocket(s, sampleRate) {
    const t = await request("POST", s, "/realtime/sessions/", {json: {model: REALTIME_STT_MODEL}});
    const url = new URL(t.url, BASE_URL.replace(/^http/, "ws"));
    url.searchParams.set("token", t.token);
    const ws = new WebSocket(url);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("baze 실시간 받아쓰기에 연결하지 못했습니다.")); });
    ws.send(JSON.stringify({model: REALTIME_STT_MODEL, audio_format: "pcm_s16le", sample_rate: sampleRate, num_channels: 1, language_hints: ["ko"]}));
    return ws;
  }

  const j = obj => JSON.stringify(obj, null, 1);

  // 모델에 넘길 채점기준표. units를 주면 그 항목의 기준만 넘긴다.
  function rubricView(rubric, units) {
    const keep = group => Object.fromEntries(Object.entries(rubric[group]).filter(([k]) => !units || units.includes(k)));
    return {common: rubric.common || "", concepts: keep("concepts"), relations: keep("relations")};
  }

  // ---- 1. 채점기준표 생성 ----
  function generateRubric(s, competency, materials) {
    const system = (
      "[작업: 채점기준표 생성]\n" +
      "대학 '인공지능 윤리' 수업의 구술 질의응답 평가에 쓸 채점기준표를 만든다.\n" +
      "평가 항목은 7개 개념과 10개 관계다.\n" + UNIT_GUIDE + "\n" +
      "수업 자료의 정의와 용어를 따른다. 자료에 없는 내용은 일반적인 인공지능 윤리 논의에 맞춰 쓴다.\n" +
      "출력 형식:\n" +
      '{"concepts": {"<개념>": {"definition": "수업에서의 정의", "understand": "이해 수준으로 인정하는 답변의 기준", ' +
      '"apply": "적용 수준으로 인정하는 답변의 기준(전공이나 삶의 구체적 사례)", "misconceptions": ["흔한 오개념", ...]}}, ' +
      '"relations": {"<개념A|개념B>": {"definition": "두 개념의 차이와 관계", "understand": "...", "apply": "...", "misconceptions": ["..."]}}}\n' +
      "concepts에는 7개, relations에는 10개 항목을 모두 넣는다. 각 기준은 한두 문장으로 쓴다."
    );
    return chatJson(s, system, `목표 역량:\n${competency}\n\n수업 자료:\n${materials || "(없음)"}`);
  }

  // ---- 2. 발표 분석 ---- clip: 발표 음성, pdf: 발표자료 원본. [분석, 음성 전달 정보, pdf 전달 정보]
  async function analyzePresentation(s, transcript, materials, clip, pdf) {
    let system = (
      "[작업: 발표 분석]\n" +
      "학생 발표를 읽고 질문을 준비하기 위한 정보를 뽑는다. 발표를 채점하거나 이해 수준을 판정하지 않는다.\n" +
      `대상 개념: ${CONCEPTS.join(", ")}\n` +
      "출력 형식:\n" +
      '{"topic": "발표 주제 한 줄", "summary": "발표 요약 두 문장", ' +
      '"mentioned_concepts": ["발표에서 실제로 다룬 개념"], ' +
      '"most_related_concept": "발표에서 다루지 않은 개념 중 주제와 가장 관련 깊은 개념 하나", ' +
      '"concept_notes": {"<개념>": "발표에서 이 개념을 어떻게 말했는지 한 문장"}, ' +
      '"suspected_misconceptions": [{"unit": "<개념 또는 개념A|개념B>", "quote": "발표 원문 그대로", "why": "왜 오개념으로 의심되는지"}]}\n' +
      "개념 이름을 직접 말하지 않았더라도 내용상 분명히 다뤘으면 mentioned_concepts에 넣는다. " +
      "개념 이름은 위 대상 개념의 표기를 그대로 쓴다('견고성과 안전성'처럼 묶어 말했으면 안전성, 견고성을 각각 넣는다)."
    );
    let user = `발표 전사문:\n${transcript}\n\n발표자료:\n${materials || "(없음)"}`;
    if (clip) {
      system += "\nsuspected_misconceptions의 quote는 전사문에서 그대로 옮긴다.";
      user += AUDIO_NOTE;
    }
    if (pdf) user += " 발표자료 원본 pdf를 첨부했다. 슬라이드의 그림과 글을 직접 보고 판단한다. 위 '발표자료'는 거기서 뽑은 글자일 뿐이다.";
    const [result, infos] = await chatJsonFiles(s, system, user, [clip, pdf].filter(Boolean));
    return [result, clip ? infos[0] : null, pdf ? infos[clip ? 1 : 0] : null];
  }

  // ---- 3. 질문 생성 ----
  function generateQuestions(s, analysis, statuses, rubric, turns, turnNo) {
    const system = (
      "[작업: 질문 생성]\n" +
      "학생 발표 뒤 구술 질의응답에서 교수자가 물을 질문을 만든다. 질문의 목적은 학생이 개념을 실제로 이해하는지 답변으로 확인하는 것이다.\n" +
      UNIT_GUIDE + "\n" +
      "규칙:\n" +
      `- 질문은 최대 ${MAX_QUESTIONS}개. 학생의 발표 주제와 발표한 내용에 맞춰 구체적으로 묻는다.\n` +
      "- 현재 상태가 '미확인'인 항목과 발표에서 오개념이 의심되는 지점을 먼저 묻는다.\n" +
      "- 현재 상태에 없는 항목은 학생이 아직 말하지 않은 것이다. 확인이 필요하면 targets에 넣어 물어도 된다.\n" +
      "- 개별 개념을 주제 맥락에서 정확히 아는지, 헷갈리기 쉬운 개념을 구분하는지, 개념 간 관계를 아는지 확인한다.\n" +
      "- 이미 '적용 수준', '이해 수준'인 항목은 다시 묻지 않는다. 오개념이나 이해 못함 판정이 확실하지 않은 항목은 다시 확인한다.\n" +
      "- '이해 못함'인 항목을 다시 물을 때는 같은 질문을 되풀이하지 않고, 더 쉽게 또는 구체적 장면을 주며 묻는다.\n" +
      "- 두 채점자의 의견이 갈린 항목은 어느 쪽이 맞는지 가릴 수 있는 질문으로 먼저 묻는다.\n" +
      "- 관계 항목은 채점기준표의 confusion(혼동 지점)과 question(가르는 질문)을 학생의 주제에 맞게 바꿔 묻는다.\n" +
      "- 투명성과 설명가능성, 안전성과 견고성은 요소별로 따로 판정하므로, 두 요소를 나누어 답하게 묻는다. 기준표 reask의 재질문 예시를 주제에 맞게 바꿔 쓸 수 있다.\n" +
      "- 신뢰성과 윤리성은 좁은 의미로 판정한다. 넓은 의미로만 말한 학생에게는 reask의 재질문 예시처럼 좁은 의미를 묻는다.\n" +
      "- 2턴에서는 1턴 질문을 되풀이하지 않고, 1턴 답변에서 드러나지 않은 부분을 다른 각도로 묻는다.\n" +
      "- 정답을 암시하지 않는다.\n" +
      "- 질문은 간결하게 쓴다. 한 문장으로, 한 번에 한 가지만 묻고, 50자 안팎으로 쓴다. 조건이나 배경 설명을 길게 붙이지 않고, 여러 질문을 한 문장에 묶지 않는다.\n" +
      "- 전공이나 삶의 사례를 말할 기회를 주는 질문을 하나 이상 넣는다.\n" +
      "- questions는 추천 순서로 정렬한다. 답변으로 가장 많은 것을 확인할 수 있을 것으로 기대되는 질문(미확인·의견 갈림 항목을 많이 또는 확실하게 가를 수 있는 질문)을 맨 앞에 둔다.\n" +
      "출력 형식:\n" +
      '{"questions": [{"text": "질문", "targets": ["이 질문으로 확인하려는 항목 이름"], "intent": "확인하려는 내용과 이 순서로 추천하는 이유 한 줄"}]}'
    );
    const history = turns.map((t, i) => ({turn: i + 1, questions: t.questions.map(q => q.text), answers: t.answers ?? null}));
    const user = `이번 턴: ${turnNo}턴\n\n발표 분석:\n${j(analysis)}\n\n현재 상태:\n${j(statuses)}\n\n` +
      `이전 질의응답:\n${history.length ? j(history) : "(없음)"}\n\n` +
      `채점기준표(확인 대상 항목만):\n${j(rubricView(rubric, Object.keys(statuses)))}`;
    return chatJson(s, system, user);
  }

  // ---- 4. 답변 판정 ---- clips: {질문 번호(0부터): [파일 이름, Blob]}. units: 기준을 넘길 항목.
  async function judgeAnswers(s, topic, questions, answers, rubric, clips, units) {
    const system = (
      "[작업: 답변 판정]\n" +
      "학생의 답변 전사문만을 근거로 항목별 이해 수준을 판정한다. 발표 내용이나 추측은 근거가 될 수 없다.\n" +
      UNIT_GUIDE + "\n" +
      "상태:\n" +
      `- '${APPLY}': 답변에서 전공이나 삶의 구체적 사례로 설명했고 채점기준표의 apply 기준을 충족한다.\n` +
      `- '${UNDERSTAND}': 답변에서 채점기준표의 understand 기준을 충족하는 이해가 확인된다.\n` +
      `- '${MISCONCEPTION}': 답변에서 틀린 내용을 맞다고 알고 있음이 확인된다(특정한 잘못된 믿음).\n` +
      `- '${NOT_UNDERSTOOD}': 답변으로 보아 이해하지 못했다고 판단된다. "잘 모르겠습니다", "몰라요"처럼 모른다고 말한 경우, 질문과 동떨어진 엉뚱한 대답을 한 경우, 대답 내용으로 보아 개념을 잘 모르는 것이 드러나는 경우가 여기에 든다. 특정한 잘못된 믿음을 말했으면 '${MISCONCEPTION}'이다.\n` +
      `- '${UNKNOWN}': 근거가 정말 부족해 판단할 수 없을 때만 쓴다. 예: 답변이 그 항목을 전혀 다루지 않음, 전사가 끊기거나 들리지 않아 내용을 알 수 없음, 기준표 reask에 해당해 재질문이 필요함. 모르겠다고 하거나 엉뚱한 대답을 한 것은 '${UNKNOWN}'이 아니라 '${NOT_UNDERSTOOD}'이다.\n` +
      `- 위 상태 정의는 채점기준표 common의 '미확인' 설명보다 우선한다.\n` +
      "규칙:\n" +
      "- 질문의 targets에 있는 항목은 모두 판정한다. 답변에서 다른 항목의 이해나 오개념이 분명히 드러나면 그 항목도 판정한다.\n" +
      `- '${UNKNOWN}'이 아닌 판정에는 quote가 반드시 있어야 한다. quote는 답변 전사문에서 한 글자도 바꾸지 않고 그대로 옮긴 연속된 구절이다. 줄임표로 잇거나 요약하지 않는다.\n` +
      `- '${MISCONCEPTION}'이면 채점기준표의 misconceptions 중 해당하는 것의 번호(1부터)를 misconception_index에 쓴다. 해당하는 것이 없으면 0.\n` +
      "- 수준의 경계는 채점기준표의 common(수준 틀과 공통 경계)과 각 항목의 understand, apply, wrong 칸을 따른다.\n" +
      "- 학생이 드는 사례는 수업 자료에 없어도 된다. 그 사례에 대해 한 말이 기준표의 정의·핵심 요소와 맞는지를 본다.\n" +
      `- 항목의 reask(재질문이 필요한 답변)에 해당하면 수준을 정하지 않고 '${UNKNOWN}'으로 두며, reason에 재질문이 필요한 이유를 쓴다.\n` +
      "- 투명성과 설명가능성, 안전성과 견고성은 요소별로 따로 판정한다. 한 요소만 말한 답변으로 다른 요소를 판정하지 않는다.\n" +
      `- "잘 모르겠지만 ~인 것 같아요"처럼 자신 없는 말 뒤에 내용이 있으면 그 내용으로 판정한다. 자신 없는 말투만으로 '${NOT_UNDERSTOOD}'로 정하지 않는다.\n` +
      `- '${NOT_UNDERSTOOD}'의 quote는 모른다고 한 말이나 엉뚱한 대답 부분을 그대로 옮긴다("몰라요"처럼 짧아도 된다).\n` +
      "- certain은 판정이 분명하면 true, 답변이 짧거나 모호해 확신하기 어려우면 false.\n" +
      "출력 형식:\n" +
      '{"judgments": [{"unit": "항목 이름", "status": "상태", "quote": "답변 원문 인용", "misconception_index": 0, "reason": "판정 이유 한 문장", "certain": true}]}'
    );
    const qa = questions.map((q, i) => ({question: q.text, targets: q.targets, answer: answers[i]}));
    let user = `발표 주제: ${topic}\n\n질문과 답변 전사문:\n${j(qa)}\n\n채점기준표:\n${j(rubricView(rubric, units))}`;
    const order = Object.keys(clips || {}).map(Number).sort((a, b) => a - b);
    if (order.length) {
      user += AUDIO_NOTE + ` 첨부한 음성은 순서대로 ${order.map(i => `${i + 1}번째`).join(", ")} 질문의 답변이다.` +
        " 단, quote는 반드시 위 답변 전사문에 적힌 글자 그대로 옮긴다.";
    }
    const [result, infos] = await chatJsonFiles(s, system, user, order.map(i => clips[i]));
    const failed = infos.find(i => !i.passed);  // 하나라도 못 보냈으면 그 이유를 알린다.
    return [result, infos.length ? failed || infos[0] : null];
  }

  // ---- 5. 피드백 작성 ----
  function writeFeedback(s, topic, state, rubric) {
    const system = (
      "[작업: 피드백 작성]\n" +
      "구술 질의응답의 최종 판정과 근거를 보고 학생에게 줄 피드백을 쓴다.\n" +
      "주어진 판정과 근거에 있는 내용만 쓴다. 판정을 바꾸거나 새로 판단하지 않는다.\n" +
      "'오개념', '이해 못함', '미확인' 항목은 무엇을 다시 공부해야 하는지 구체적으로 쓰고('이해 못함'은 잘못 알았다고 쓰지 말고 아직 이해하지 못한 부분으로 쓴다), '이해 수준' 항목은 적용 수준으로 가려면 무엇이 필요한지 쓴다. 최종 상태에 없는 항목은 다루지 않는다.\n" +
      "학생에게 직접 말하는 정중한 문체로, 항목마다 한두 문장으로 짧게 쓴다.\n" +
      "출력 형식:\n" +
      '{"overall": "전체 총평 한두 문장", "items": [{"unit": "항목 이름", "text": "더 공부할 부분"}]}'
    );
    const final = Object.fromEntries(Object.entries(state).map(([name, u]) => [name, {
      status: u.status, source: u.source, note: u.note,
      evidence: u.evidence.map(e => ({quote: e.quote, rubric_item: e.rubric_item, reason: e.reason})),
    }]));
    const user = `발표 주제: ${topic}\n\n최종 상태와 근거:\n${j(final)}\n\n채점기준표:\n${j(rubricView(rubric, Object.keys(final)))}`;
    return chatJson(s, system, user);
  }

  root.LLM = {BASE_URL, DEFAULT_MODEL, DEFAULT_MODEL2, DEFAULT_STT_MODEL, LLMError, chat, listModels, transcribe, openLiveSocket,
    generateRubric, analyzePresentation, generateQuestions, judgeAnswers, writeFeedback, extOf};
})(typeof window !== "undefined" ? window : globalThis);
