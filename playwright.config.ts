import { defineConfig } from '@playwright/test';

// vedit web/ e2e 回帰スイート(docs/HANDOFF.md §5/§6 参照)。
//
// テスト対象は毎回それぞれのテストファイルが自前で起動する daemon
// (e2e/fixtures.ts の setupVedit — 空きポート+vedit専用状態+隔離プロジェクト)
// であり、ユーザーの実 daemon(port 7799)には一切触れない。webServer は
// 使わない — 固定ポート/固定プロジェクトの前提に合わないため。
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // 複数のテストファイルが同時に daemon/一時プロジェクトを立てると
  // ffmpeg 生成やポート割当のリソース競合でフレークの原因になる —
  // ファイル間も直列に倒しておく(ファイル内は describe.serial で直列)。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
});
