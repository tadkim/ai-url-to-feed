#!/usr/bin/env node
// planner가 사이트를 둘러볼 때 쓴다. record.mjs와 같은 viewport·언어·쓰기 차단으로 연다 (배율만 1).
// 사용: node scripts/explore.mjs <project> [--steps '<JSON 단계 배열>'] [--name <이름>] [--eval '<브라우저에서 실행할 JS 식>']
//   --eval: 단계를 실행한 뒤 page.evaluate로 식을 실행해 결과를 `eval`에 담는다. 시나리오의 waitForFunction 조건이 true가 되는지,
//           요소의 opacity·위치·스크롤 컨테이너가 무엇인지 확인할 때 쓴다. 예: --eval "getComputedStyle(document.querySelector('.card img')).opacity"
//   단계: goto(경로) · click(선택자) · fill([선택자, 글자]) · press(키) · wait(ms) · waitFor(선택자) · scroll(px) · scrollTo(선택자) · hover(선택자)
//   매번 첫 화면부터 단계를 다시 실행한다.
// 출력(JSON): 주소·제목, 스크린샷 경로, 누를 수 있는 요소(글자, 역할, 바로 쓸 수 있는 선택자),
//   돌고 있는 애니메이션(이름·주기 — 루프 길이를 정할 때 쓴다), GIF 이미지, 막힌 쓰기 요청 수
//   스크린샷은 .cache/explore/<project>/에 둔다 (git·편집 범위 검사에서 빠진다). Read로 열어 본다.
// 종료 코드: 0 정상, 1 단계 오류(step_error), 2 실행 오류
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, loadRules, assertProject, projectConf } from './lib.mjs';
import { assertTarget, applyContext, runSteps, open } from './browser.mjs';

async function main() {
  const [project, ...args] = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
  const rules = loadRules();
  assertProject(rules, project);
  const conf = projectConf(rules, project);
  const steps = opt('--steps') ? JSON.parse(opt('--steps')) : [];
  const name = (opt('--name') ?? `step-${steps.length}`).replace(/[^\w-]/g, '_');
  const outDir = path.join(ROOT, '.cache', 'explore', project);   // 저장소 안이어야 Claude가 Read로 열 수 있다. .cache/는 git·편집 범위 검사에서 빠진다
  fs.mkdirSync(outDir, { recursive: true });
  await assertTarget(conf);

  const browser = await chromium.launch();
  const out = { project, steps: steps.length };
  try {
    const ctx = await browser.newContext({ viewport: rules.record.viewport, deviceScaleFactor: 1, locale: rules.record.locale });
    const counts = await applyContext(ctx, rules, conf);
    const page = await ctx.newPage();
    await open(page, `${conf.url}/`);
    try {
      await runSteps(page, steps, conf.url);
    } catch (e) {
      out.step_error = e.message.split('\n')[0].slice(0, 300);
    }
    await page.waitForTimeout(800);
    if (opt('--eval')) { try { out.eval = await page.evaluate(opt('--eval')); } catch (e) { out.eval_error = e.message.split('\n')[0].slice(0, 300); } }
    out.url = page.url();
    out.title = await page.title();
    out.screenshot = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: out.screenshot });
    out.scroll_height = await page.evaluate(() => document.documentElement.scrollHeight);
    out.writes_blocked = counts.blocked;
    out.writes_seen = counts.seen;
    out.blocked_urls = [...(counts.blocked_urls ?? [])].slice(0, 10);   // 읽기인데 POST인 주소면 projects.yaml의 <p>.allow_post에 넣을 후보

    // 돌고 있는 애니메이션과 GIF — 루프 클립 길이(주기의 최소공배수)를 정할 때 쓴다
    out.animations = await page.evaluate(() => {
      const seen = new Map();
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running') continue;
        const t = a.effect?.getComputedTiming?.() ?? {};
        const key = `${a.animationName ?? a.transitionProperty ?? 'animation'}|${t.duration}|${t.iterations}`;
        if (!seen.has(key)) seen.set(key, { name: a.animationName ?? a.transitionProperty ?? null, seconds: Number(t.duration) / 1000, iterations: t.iterations === Infinity ? 'infinite' : t.iterations, direction: t.direction, count: 0 });
        seen.get(key).count++;
      }
      return [...seen.values()].slice(0, 30);
    });
    out.gifs = await page.evaluate(() => [...document.images].map((i) => i.currentSrc || i.src).filter((s) => /\.gif(\?|$)/i.test(s)).slice(0, 20));

    // 누를 수 있는 요소 후보
    const found = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const cand = [...document.querySelectorAll('a, button, input, select, textarea, [role=button], [role=tab], [role=radio], [role=checkbox], [onclick], [tabindex]')]
        .concat([...document.querySelectorAll('div, span, img, li, label, svg')].filter((el) => getComputedStyle(el).cursor === 'pointer'));
      const seen = new Set();
      return cand.filter((el) => { if (seen.has(el) || !vis(el)) return false; seen.add(el); return true; }).slice(0, 80).map((el, i) => {
        el.setAttribute('data-explore-id', String(i));
        const r = el.getBoundingClientRect();
        return {
          i, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
          label: el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || null,
          id: el.id || null, cls: typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : null,
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], in_view: r.top < innerHeight && r.bottom > 0,
        };
      });
    });
    // 선택자 제안: 한 개만 가리키는 것부터 (aria-label → text → id → class+순번)
    const unique = async (sel) => { try { return (await page.locator(sel).count()) === 1; } catch { return false; } };
    for (const el of found) {
      const tries = [
        el.label && `[aria-label="${el.label}"]`,
        el.text && `text="${el.text}"`,
        el.id && `#${el.id}`,
        el.cls && `${el.tag}.${el.cls}`,
      ].filter(Boolean);
      el.selector = null;
      for (const t of tries) if (await unique(t)) { el.selector = t; break; }
      if (!el.selector && el.cls) el.selector = `${el.tag}.${el.cls} >> nth=${await page.locator(`${el.tag}.${el.cls}`).evaluateAll((els, i) => els.findIndex((x) => x.getAttribute('data-explore-id') === i), String(el.i))}`;
      delete el.i;
    }
    out.elements = found;
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.step_error ? 1 : 0);
}

main().catch((e) => { console.error(`explore 오류: ${e.message}`); process.exit(2); });
