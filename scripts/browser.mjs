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

// 지연 로딩 이미지를 화면에 들어오기 전에(margin px 앞에서) 불러오게 한다.
// 화면에 들어온 뒤에야 불러오는 사이트는 스크롤 직후 흐린 자리표시가 1~2초 보여 녹화가 버벅여 보인다 (stuckyi.studio 상세 — 2026-10-05).
// 이미지·영상·배경 이미지 요소를 지켜보는 IntersectionObserver만 넓힌다. 글·카드가 화면에 들어올 때 나타나는 애니메이션은 그대로 둔다
export function eagerImages(margin) {
  const IO = window.IntersectionObserver;
  if (!IO || IO.__eager) return;
  const media = (el) => el instanceof Element && (/^(IMG|PICTURE|VIDEO|IFRAME|SOURCE)$/.test(el.tagName)
    || [...el.attributes].some((a) => /^data-(src|srcset|bg|background|lazy|original)/.test(a.name)));
  // class 문법을 쓰지 않는다: zone.js(Angular)가 for…in으로 메서드를 옮겨 감싸는데, class 메서드는 열거되지 않아 observe가 사라진다
  function Eager(cb, opts = {}) {
    const call = (entries) => cb(entries, this);
    this.normal = new IO(call, opts);
    this.wide = new IO(call, { ...opts, rootMargin: `${margin}px 0px` });
    Object.assign(this, { root: this.normal.root, rootMargin: this.normal.rootMargin, thresholds: this.normal.thresholds });
  }
  Eager.prototype.observe = function (el) { (media(el) ? this.wide : this.normal).observe(el); };
  Eager.prototype.unobserve = function (el) { this.normal.unobserve(el); this.wide.unobserve(el); };
  Eager.prototype.disconnect = function () { this.normal.disconnect(); this.wide.disconnect(); };
  Eager.prototype.takeRecords = function () { return [...this.normal.takeRecords(), ...this.wide.takeRecords()]; };
  Eager.__eager = true;
  window.IntersectionObserver = Eager;
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
  if (rules.record.eager_images_px) await context.addInitScript(eagerImages, rules.record.eager_images_px);
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

// ---- 녹화 중 스크롤 (시나리오에 flick·flickTo로 넘긴다) ----
// 헤드리스 브라우저는 스크롤 애니메이션(휠, behavior: 'smooth')이 화면 캡처와 겹치면 고정 헤더(position: fixed·sticky)를
// 스크롤 양만큼 어긋난 자리로 찍는다 (실측: 고정 헤더만 있는 시험 페이지도 프레임의 30~51%가 흔들림 — 2026-10-05).
// 그래서 캡처가 끝난 뒤에만, 애니메이션 없이 즉시 옮기고, 화면에 반영된 다음 캡처가 찍히게 한다 (실측: 0~1%).
// 걸음마다 옮기는 거리는 빠르게 시작해 느려지며 멈추는 관성 곡선을 따른다.
const SYNC = Symbol('flick');
export function scrollHelpers(page) {
  if (!page[SYNC]) {
    const state = { busy: null };
    const orig = page.screenshot.bind(page);
    page.screenshot = (...a) => { const p = orig(...a); state.busy = p.catch(() => {}); return p; };   // 녹화 엔진의 캡처를 감싸 진행 중인지 안다
    page[SYNC] = state;
  }
  const state = page[SYNC];
  // 스크롤할 대상: at(화면 좌표) 아래에서 실제로 스크롤되는 영역, 없으면 문서. 대상을 window.__flickBox에 둔다
  const pick = ([x, y]) => {
    let el = document.elementFromPoint(x, y);
    const scrolls = (e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY);
    while (el && el !== document.body && el !== document.documentElement && !scrolls(el)) el = el.parentElement;
    window.__flickBox = el && el !== document.body && el !== document.documentElement ? el : document.scrollingElement;
  };
  async function steps(total, ms) {
    const n = Math.max(6, Math.round(ms / 40));   // 캡처 간격(약 40ms)마다 한 걸음
    const w = Array.from({ length: n }, (_, i) => (i < 2 ? (i + 1) / 2 : ((n - i) / (n - 2)) ** 2));
    const sum = w.reduce((a, b) => a + b, 0);
    let sent = 0;
    for (let i = 0; i < n; i++) {
      if (state.busy) await state.busy;   // 캡처가 끝난 뒤에만 옮긴다
      const d = Math.round((total * w.slice(0, i + 1).reduce((a, b) => a + b, 0)) / sum) - sent;
      sent += d;
      await page.evaluate((dy) => { window.__flickBox.scrollBy({ top: dy, behavior: 'instant' }); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, d);
    }
  }
  return {
    // px만큼 관성처럼 스크롤한다. at: 스크롤할 영역 위의 한 점 (안쪽 컨테이너가 스크롤되는 사이트), ms: 걸리는 시간
    async flick(px, { at = [180, 420], ms = 520 } = {}) {
      await page.evaluate(pick, at);
      await steps(px, ms);
    },
    // 대상(선택자 문자열 또는 locator)을 화면(또는 그 스크롤 영역) 가운데로 관성 스크롤해 가져온다
    async flickTo(target, { ms = 520, block = 'center' } = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      const dy = await loc.evaluate((el, blk) => {
        const scrolls = (e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY);
        let box = el.parentElement;
        while (box && box !== document.body && box !== document.documentElement && !scrolls(box)) box = box.parentElement;
        window.__flickBox = box && box !== document.body && box !== document.documentElement ? box : document.scrollingElement;
        const r = el.getBoundingClientRect();
        const view = window.__flickBox === document.scrollingElement ? { top: 0, height: innerHeight } : window.__flickBox.getBoundingClientRect();
        const want = blk === 'start' ? view.top + 80 : view.top + view.height / 2 - r.height / 2;
        return Math.round(r.top - want);
      }, block);
      if (Math.abs(dy) > 2) await steps(dy, ms);
    },
  };
}
