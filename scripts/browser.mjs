// Playwright 공통: explore.mjs(planner의 사이트 둘러보기)와 record.mjs(녹화)가 같은 대상 확인·언어·쓰기 차단을 쓴다.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 시작 전 검사: 주소가 응답하고 <title>이 등록한 값과 같은가 (다른 프로젝트 서버가 같은 포트에 떠 있으면 엉뚱한 앱이 녹화된다)
// title을 적지 않았으면 배포 사이트는 검사하지 않고 넘어간다. 로컬 개발 서버(target: local)는 포트를 헷갈리기 쉬워 title이 꼭 있어야 한다
export async function assertTarget(conf) {
  let html;
  try {
    const res = await fetch(`${conf.url}/`, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    const hint = conf.target === 'local' ? ' — dev 서버를 먼저 띄운다' : '';
    throw new Error(`대상이 응답하지 않는다: ${conf.url} (${e.message})${hint}`);
  }
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim();
  if (conf.title == null) {
    if (conf.target === 'local') throw new Error(`로컬 개발 서버는 projects.yaml에 title을 적어야 한다 — 지금 페이지의 <title>은 "${title}"`);
    return title;
  }
  if (title !== String(conf.title)) throw new Error(`대상 앱이 다르다: <title>이 "${title}" — projects.yaml에는 "${conf.title}"`);
  return title;
}

// 시나리오가 녹화 중에 오류로 끝나면 엔진이 브라우저를 닫고, 아직 돌던 캡처 루프의 page.waitForTimeout이 처리되지 않은 거부로 프로세스를 죽인다.
// 그러면 시나리오의 진짜 오류(record()가 던진다)와 manifest가 남지 않는다 — 이 거부만 무시한다 (kyobobookdamgi — 2026-10-04)
export function ignoreClosedCapture() {
  process.on('unhandledRejection', (e) => {
    if (/Target page, context or browser has been closed/.test(e?.message ?? '')) return;
    throw e;
  });
}

// 컨텍스트에 언어와 쓰기 차단을 건다. counts: { seen, blocked }에 쓰기 요청 수를 센다.
// 녹화 엔진은 컨텍스트를 직접 만들기 때문에 locale 옵션 대신 헤더와 navigator 값을 덮어쓴다
export async function applyContext(context, rules, conf, counts = { seen: 0, blocked: 0 }) {
  const locale = rules.record.locale;
  await context.setExtraHTTPHeaders({ 'Accept-Language': `${locale},${locale.split('-')[0]};q=0.9` });
  await context.addInitScript((l) => {
    Object.defineProperty(navigator, 'language', { get: () => l });
    Object.defineProperty(navigator, 'languages', { get: () => [l, l.split('-')[0]] });
  }, locale);
  const reads = (rules.record.read_post ?? []).map((s) => new RegExp(s));   // 읽기 전용 POST: 세지 않고 통과
  const passes = (conf.allow_post ?? []).map((s) => new RegExp(s));
  if (conf.allow_writes) {
    context.on('request', (req) => { if (WRITE_METHODS.has(req.method())) counts.seen++; });
  } else {
    await context.route('**/*', (route) => {
      const req = route.request();
      if (!WRITE_METHODS.has(req.method())) return route.continue();
      const url = req.url().split('?')[0];
      if (req.method() === 'POST' && reads.some((re) => re.test(url))) return route.continue();
      if (passes.some((re) => re.test(req.url()))) { counts.seen++; return route.continue(); }
      counts.blocked++;
      (counts.blocked_urls ??= new Set()).add(`${req.method()} ${req.url().split('?')[0].slice(0, 120)}`);
      return route.abort();
    });
  }
  return counts;
}

// 페이지 열기: load 뒤 네트워크가 잠잠해질 때까지 최대 5초 기다린다.
// Firestore 실시간 연결처럼 요청이 계속 열려 있는 사이트는 networkidle이 오지 않는다 (stuckyi.studio — 2026-10-03)
export async function open(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

// steps: goto(경로) · click(선택자) · fill([선택자, 글자]) · press(키) · wait(ms) · waitFor(선택자) · scroll(px) · scrollTo(선택자) · hover(선택자)
export async function runSteps(page, steps, baseUrl) {
  for (const s of steps ?? []) {
    const [op, arg] = Object.entries(s)[0];
    if (op === 'goto') await open(page, baseUrl + arg);
    else if (op === 'click') await page.click(arg);
    else if (op === 'fill') await page.fill(arg[0], arg[1]);
    else if (op === 'press') await page.keyboard.press(arg);
    else if (op === 'wait') await page.waitForTimeout(Number(arg));
    else if (op === 'waitFor') await page.waitForSelector(arg);
    else if (op === 'scroll') await page.mouse.wheel(0, Number(arg));
    else if (op === 'scrollTo') await page.locator(arg).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    else if (op === 'hover') await page.hover(arg);
    else throw new Error(`모르는 단계: ${op}`);
  }
}
