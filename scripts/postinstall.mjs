#!/usr/bin/env node
// npm install 뒤에 한 번: 녹화용 브라우저(chromium)를 받고 ffmpeg가 있는지 알려 준다.
// 실패해도 설치를 막지 않는다. 빠진 것은 명령줄(npx ai-url-to-feed)과 시작 화면이 다시 알려 준다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.HARNESS_SKIP_BROWSER) process.exit(0);   // CI 등에서 브라우저를 받지 않을 때
try {
  const { chromium } = await import('playwright');
  if (!fs.existsSync(chromium.executablePath())) {
    console.log('녹화용 브라우저(chromium)를 받아요…');
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    if (r.status !== 0) console.log('브라우저를 받지 못했어요. 나중에 직접: npx playwright install chromium');
  }
} catch (e) { console.log(`playwright 확인을 건너뛰었어요: ${e.message.split('\n')[0]}`); }
if (spawnSync('ffmpeg', ['-version']).error) console.log('ffmpeg가 없어요. 설치: brew install ffmpeg (macOS) — 없으면 영상을 만들 수 없어요');
