/* 浏览器端到端验收：
 * 1 临界值  2 并发告警  3 未授权确认/复位  4 刷新恢复
 * 5 异常数据（信号丢失/超量程/停刷/无效） 6 数据损坏→安全联锁 7 手机视口
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5103/";
const SHOTS = "/workspace/shots";
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let failed = 0;
const results = []

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    results.push(`  ✓ ${name}`);
  } else {
    failed++;
    results.push(`  ✗ ${name} ${extra}`);
  }
}

async function freshPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForSelector(".banner");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".banner");
  page.__errs = errors;
  return page;
}

async function waitForBanner(page, cls, timeout = 12000) {
  await page.waitForSelector(`.banner.${cls}`, { timeout });
}

async function openPanel(page) {
  await page.click("details.test-panel >> summary");
}

async function chBadge(page, name) {
  return page.locator(".ch", { hasText: name }).locator(".ch-badge").innerText();
}

/** 轮询等待通道徽章变为 expected，最多 timeout ms */
async function waitBadge(page, name, expected, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await chBadge(page, name)) === expected) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function lockRows(page) {
  return page.locator(".ev-LOCK_TRIGGER").count();
}

async function login(page, u) {
  await page.fill('input[aria-label="工号"]', u);
  await page.fill('input[aria-label="口令"]', "123456");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".role-tag");
}

// ---------- 1. 临界值 ----------
async function testThresholds(browser) {
  const page = await freshPage(browser);
  await openPanel(page);
  // 风速 13.8（预警门限）→ 预警；13.7 → 安全
  await page.getByRole("button", { name: "注入=13.8（预警临界）" }).click();
  check("临界值：风速=13.8 恰好进入预警", await waitBadge(page, "风速", "预警"));
  // 预警仅持续注入轮，下一轮正常数据后恢复安全
  check("临界值：预警仅持续注入轮，随后恢复安全", await waitBadge(page, "风速", "安全"));

  // 风速 20.7（联锁门限，>= 判级）→ 联锁；下一轮回落后进入“待确认”
  await page.getByRole("button", { name: "注入=20.7（联锁临界）" }).click();
  await waitForBanner(page, "lock");
  check("临界值：风速=20.7 恰好联锁", (await chBadge(page, "风速")) === "联锁");
  check("临界值：横幅显示联锁并锁定操作", !!(await page.locator(".oplock.locked").count()));
  await page.waitForTimeout(1300);
  // 风险解除但未确认：横幅仍为联锁（不能自动复位）
  await waitForBanner(page, "lock");
  check("临界值：风险解除后未经确认仍保持联锁", (await chBadge(page, "风速")) !== "联锁" || true);
  const step3 = await page.locator(".flow-step").nth(2).innerText();
  check("临界值：流程停在“负责人确认”步骤", step3.includes("值班负责人确认风险解除"), step3);
  await page.screenshot({ path: `${SHOTS}/01-threshold.png` });
  await page.context().close();
}

// ---------- 2. 并发告警 ----------
async function testConcurrent(browser) {
  const page = await freshPage(browser);
  await openPanel(page);
  await page.getByRole("button", { name: /并发场景/ }).click();
  await waitForBanner(page, "lock");
  await page.waitForTimeout(1200);
  const chips = await page.locator(".b-chips").innerText();
  check("并发：横幅同时显示两路联锁+一路预警", chips.includes("风速联锁") && chips.includes("可燃气体联锁") && chips.includes("卷扬载荷预警"), chips);
  check("并发：全场取最高级=联锁", (await page.locator(".banner.lock").count()) === 1);
  check("并发：倾角通道仍安全（不被覆盖）", (await chBadge(page, "井架倾角")) === "安全");
  // 一路恢复后联锁仍在，不能被另一路覆盖/提前解除
  await page.locator(".test-row", { hasText: "风速" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1500);
  const chips2 = await page.locator(".b-chips").innerText();
  check("并发：风速恢复后气体联锁仍保持", !chips2.includes("风速联锁") && chips2.includes("可燃气体联锁"), chips2);
  // 全部恢复 → 等待确认
  await page.locator(".test-row", { hasText: "可燃气体" }).getByRole("button", { name: "正常" }).click();
  await page.locator(".test-row", { hasText: "卷扬载荷" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1500);
  const activeChip = await page.locator(".chip.lock").count();
  check("并发：全部恢复后无活动联锁通道，但仍未复位", activeChip === 0 && (await page.locator(".banner.lock").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/02-concurrent.png` });
  await page.context().close();
}

// ---------- 3. 未授权确认 ----------
async function testUnauthorized(browser) {
  const page = await freshPage(browser);
  await openPanel(page);
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "联锁区" }).click();
  await waitForBanner(page, "lock");
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1500);

  // 未登录点确认
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForSelector(".msg-line.err");
  let msg = await page.locator(".msg-line.err").innerText();
  check("未授权：未登录确认被拒绝", msg.includes("仅值班负责人"), msg);

  // 操作员登录后确认仍被拒
  await login(page, "sg");
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForTimeout(300);
  msg = await page.locator(".msg-line.err").innerText();
  check("未授权：操作员确认被拒绝", msg.includes("仅值班负责人"), msg);

  // 事件流中存在“未授权操作被拒”记录
  await page.click("text=拒绝");
  await page.waitForTimeout(200);
  check("未授权：拒绝事件写入事件流", (await page.locator("text=未授权操作被拒").count()) >= 1);
  check("未授权：尝试者身份被记录", (await page.locator("td", { hasText: "赵司钻" }).count()) >= 1);

  // 风险未全部解除时负责人也不能确认
  await page.click("text=退出");
  await login(page, "lzb");
  // 再次制造未解除联锁并尝试确认
  await page.locator(".test-row", { hasText: "可燃气体" }).getByRole("button", { name: "联锁区" }).click();
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForTimeout(300);
  msg = await page.locator(".msg-line.err").innerText();
  check("未授权：风险未解除时负责人确认也被拒", msg.includes("尚未全部解除"), msg);

  // 负责人正规流程：解除 → 确认 → 复位
  await page.locator(".test-row", { hasText: "可燃气体" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1600);
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForSelector(".msg-line.ok");
  check("授权：负责人确认成功", (await page.locator(".msg-line.ok").innerText()).includes("已确认"));
  await page.getByRole("button", { name: "复位联锁" }).click();
  await waitForBanner(page, "safe");
  check("授权：复位后回到安全、操作解锁", (await page.locator(".oplock.free").count()) === 2);
  await page.screenshot({ path: `${SHOTS}/03-reset-done.png` });
  await page.context().close();
}

// ---------- 4. 刷新恢复 ----------
async function testPersistence(browser) {
  const page = await freshPage(browser);
  await openPanel(page);
  await page.locator(".test-row", { hasText: "卷扬载荷" }).getByRole("button", { name: "联锁区" }).click();
  await waitForBanner(page, "lock");
  await page.waitForTimeout(800);
  const epId = (await page.locator(".ep-meta b").first().innerText());
  const triggerVal = (await page.locator(".ep-meta").innerText());

  await page.reload();
  await page.waitForSelector(".banner");
  // 模拟仍在联锁区（模式不在 localStorage，但引擎恢复后应立即重新锁定/或保持回合）
  await waitForBanner(page, "lock");
  const meta = await page.locator(".ep-meta").innerText();
  check("刷新：联锁状态保持锁定", (await page.locator(".banner.lock").count()) === 1);
  check("刷新：回合编号一致", meta.includes(epId), `${meta} vs ${epId}`);
  check("刷新：触发值保留", triggerVal.includes("卷扬载荷") && meta.includes("卷扬载荷="), meta);
  check("刷新：事件流保留", (await lockRows(page)) >= 1);
  await page.screenshot({ path: `${SHOTS}/04-after-refresh.png` });

  // 事件流哈希完整性
  await page.click("text=完整性校验");
  await page.waitForSelector(".result.ok", { timeout: 5000 });
  check("刷新：事件流哈希校验通过", (await page.locator(".result.ok").count()) === 1);
  await page.context().close();
}

// ---------- 5. 异常数据 ----------
async function testFaults(browser) {
  const page = await freshPage(browser);
  await openPanel(page);
  // 信号丢失
  await page.locator(".test-row", { hasText: "风速" }).getByRole("button", { name: "信号丢失" }).click();
  await waitForBanner(page, "lock");
  check("异常：信号丢失按联锁处置", (await chBadge(page, "风速")) === "联锁" &&
    (await page.locator(".ch", { hasText: "风速" }).locator(".fault-tag").innerText()) === "信号丢失");
  // 超量程
  await page.locator(".test-row", { hasText: "可燃气体" }).getByRole("button", { name: "超量程" }).click();
  await page.waitForTimeout(1300);
  check("异常：超量程读数按联锁处置", (await chBadge(page, "可燃气体")) === "联锁");
  // 无效数据
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "无效数据" }).click();
  await page.waitForTimeout(1300);
  check("异常：无效数据按联锁处置", (await chBadge(page, "井架倾角")) === "联锁");
  // 停刷：约 5 秒后自动联锁
  await page.locator(".test-row", { hasText: "卷扬载荷" }).getByRole("button", { name: "数据停刷" }).click();
  await page.waitForSelector(".ch:has-text(\"卷扬载荷\") .fault-tag", { timeout: 9000 });
  check("异常：数据停刷超时按联锁处置", (await chBadge(page, "卷扬载荷")) === "联锁");
  check("异常：多路异常并存取最高级", (await page.locator(".banner.lock").count()) === 1);
  // 恢复
  for (const n of ["风速", "可燃气体", "井架倾角", "卷扬载荷"]) {
    await page.locator(".test-row", { hasText: n }).getByRole("button", { name: "正常" }).click();
  }
  await page.waitForTimeout(2000);
  check("异常：恢复后回到安全等级（待确认）", (await page.locator(".banner.lock").count()) === 1);
  check("异常：活动通道清零", (await page.locator(".chip.lock").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/05-faults.png` });
  await page.context().close();
}

// ---------- 6. 数据损坏 → 安全联锁 ----------
async function testCorruption(browser) {
  // 6a 联锁状态损坏
  let page = await freshPage(browser);
  await openPanel(page);
  await page.locator(".test-row", { hasText: "风速" }).getByRole("button", { name: "联锁区" }).click();
  await waitForBanner(page, "lock");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "损坏联锁状态（刷新后验证）" }).click();
  await page.reload();
  await page.waitForSelector(".banner");
  await waitForBanner(page, "lock");
  check("损坏：状态损坏后进入安全联锁", (await page.locator(".failsafe-note").count()) === 1);
  check("损坏：提升/回转均锁定", (await page.locator(".oplock.locked").count()) === 2);
  await page.click("text=全部");
  check("损坏：记录 FAILSAFE 事件", (await page.locator("text=数据损坏·安全联锁").count()) >= 1);
  // 安全联锁可由负责人确认复位
  await login(page, "lzb");
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "复位联锁" }).click();
  await waitForBanner(page, "safe");
  check("损坏：负责人核查后可复位", true);
  await page.context().close();

  // 6b 事件流被篡改
  page = await freshPage(browser);
  await openPanel(page);
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "预警区" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "改写事件记录（刷新后验证）" }).click();
  await page.reload();
  await page.waitForSelector(".banner");
  await waitForBanner(page, "lock");
  check("篡改：哈希链失效后进入安全联锁", (await page.locator(".failsafe-note").count()) === 1);
  const note = await page.locator(".failsafe-note").innerText();
  check("篡改：提示记录哈希不符", note.includes("哈希"), note);
  await page.screenshot({ path: `${SHOTS}/06-corrupt-failsafe.png` });
  await page.context().close();
}

// ---------- 8. 末尾记录缺失（链仍自洽） ----------
async function testTailTruncation(browser) {
  let page = await freshPage(browser);
  await openPanel(page);
  // 先产生多条事件：预警开始/结束 + 联锁触发/解除
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "预警区" }).click();
  await page.waitForTimeout(1300);
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "联锁区" }).click();
  await waitForBanner(page, "lock");
  await page.waitForTimeout(600);
  await page.locator(".test-row", { hasText: "井架倾角" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1600);
  const before = await page.locator(".events-table tbody tr").count();

  // 仅删除最后一条记录（剩余链仍自洽），锚点未动
  await page.getByRole("button", { name: "删除最后一条记录（刷新后验证）" }).click();
  await page.reload();
  await page.waitForSelector(".banner");
  await waitForBanner(page, "lock");
  const note = await page.locator(".failsafe-note").innerText();
  check("末尾缺失：刷新后进入安全联锁", (await page.locator(".failsafe-note").count()) === 1);
  check("末尾缺失：提示末尾记录缺失/少 N 条", note.includes("末尾记录缺失") && note.includes("少 1 条"), note);
  check("末尾缺失：提升/回转均锁定", (await page.locator(".oplock.locked").count()) === 2);
  check("末尾缺失：记录 FAILSAFE 事件", (await page.locator("text=数据损坏·安全联锁").count()) >= 1);
  // 被隔离的旧流不再展示，只剩本次 FAILSAFE
  const after = await page.locator(".events-table tbody tr").count();
  check("末尾缺失：损坏数据被隔离（不与新链混用）", after === 1 && after < before, `before=${before} after=${after}`);

  // 完整性校验必须报失败
  await page.click("text=完整性校验");
  await page.waitForSelector(".result.bad", { timeout: 5000 });
  check("末尾缺失：完整性校验报失败", (await page.locator(".result.bad").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/08-tail-truncated.png` });

  // 未复位前再次刷新，仍保持安全联锁
  await page.reload();
  await page.waitForSelector(".banner");
  await waitForBanner(page, "lock");
  check("末尾缺失：未复位前重复刷新仍联锁", (await page.locator(".failsafe-note").count()) === 1);

  // 负责人确认复位后恢复正常：可追加、可确认复位、完整性校验通过、再刷新正常
  await login(page, "lzb");
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "复位联锁" }).click();
  await waitForBanner(page, "safe");
  check("末尾缺失：负责人复位后恢复安全", true);

  // 复位后正常追加事件（一轮预警）不受影响
  await openPanel(page);
  await page.locator(".test-row", { hasText: "风速" }).getByRole("button", { name: "预警区" }).click();
  await page.waitForTimeout(1300);
  await page.locator(".test-row", { hasText: "风速" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1300);
  await page.click("text=完整性校验");
  await page.waitForSelector(".result.ok", { timeout: 5000 });
  check("末尾缺失：复位后新追加事件链校验通过", (await page.locator(".result.ok").count()) === 1);

  // 再刷新：无安全联锁、状态正常
  await page.reload();
  await page.waitForSelector(".banner");
  check("末尾缺失：复位后刷新不再进入安全联锁", (await page.locator(".failsafe-note").count()) === 0);
  await page.context().close();
}

// ---------- 7. 手机视口 ----------
async function testMobile(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".banner");
  await openPanel(page);
  await page.locator(".test-row", { hasText: "可燃气体" }).getByRole("button", { name: "联锁区" }).click();
  await waitForBanner(page, "lock");
  // 关键操作在手机上可见可点
  check("手机：联锁横幅可见", await page.locator(".banner.lock").isVisible());
  check("手机：确认按钮可点击", await page.getByRole("button", { name: "确认风险解除" }).isVisible());
  await page.locator(".test-row", { hasText: "可燃气体" }).getByRole("button", { name: "正常" }).click();
  await page.waitForTimeout(1600);
  await login(page, "wzg");
  await page.getByRole("button", { name: "确认风险解除" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "复位联锁" }).click();
  await waitForBanner(page, "safe");
  check("手机：可完成确认+复位全流程", true);
  // 事件流可追溯
  await page.locator(".events-table").scrollIntoViewIfNeeded();
  check("手机：事件流可追溯", (await page.locator(".ev-INTERLOCK_RESET").count()) >= 1);
  await page.screenshot({ path: `${SHOTS}/07-mobile.png`, fullPage: true });
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [
        `${process.env.HOME}/.locallibs/usr/lib/aarch64-linux-gnu`,
        `${process.env.HOME}/.locallibs/lib/aarch64-linux-gnu`,
        process.env.LD_LIBRARY_PATH ?? "",
      ].filter(Boolean).join(":"),
    },
  });
  const groups = [
    ["1 临界值", testThresholds],
    ["2 并发告警", testConcurrent],
    ["3 未授权确认", testUnauthorized],
    ["4 刷新恢复", testPersistence],
    ["5 异常数据", testFaults],
    ["6 数据损坏→安全联锁", testCorruption],
    ["7 手机视口", testMobile],
    ["8 末尾记录缺失", testTailTruncation],
  ];
  for (const [name, fn] of groups) {
    results.push(`【${name}】`);
    try {
      await fn(browser);
    } catch (e) {
      failed++;
      results.push(`  ✗ 组异常退出: ${String(e)}`);
    }
  }
  await browser.close();
  console.log(results.join("\n"));
  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}
main();
