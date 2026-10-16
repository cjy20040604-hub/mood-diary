// 晴一日记 端到端测试（Playwright）
// 运行：npm install && npx playwright install chromium && npm test
// 本地用已安装的 Chrome：PW_CHANNEL=chrome npm test
// 所有外部网络（Supabase、GitHub、字体、AI 服务）都被拦截或模拟，测试不会触达线上服务。
import { test, expect } from "@playwright/test";

const CONSENTED = JSON.stringify({ consent: { v: 1, t: 1 } });
const HOUR = 3600e3;

async function boot(page, { consent = true } = {}) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route(/supabase\.co|api\.github\.com|mock-ai\.test/, (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  if (consent) await page.addInitScript((p) => { if (!localStorage.getItem("qy_prefs")) localStorage.setItem("qy_prefs", p); }, CONSENTED);
  await page.goto("/index.html");
  return errors;
}
// 直接写入记录（时间都在最近 7 天内），用于需要精确数据的场景
async function seed(page, list) {
  await page.evaluate(({ list, HOUR }) => {
    entries = list.map((e, i) => ({ id: "s" + i, t: Date.now() - (e.h ?? i) * HOUR, mood: e.mood, emos: e.emos || [], trigs: e.trigs || [], note: e.note || "" }));
    save(); render();
  }, { list, HOUR });
}
const tab = (page, t) => page.locator('nav button[data-t="' + t + '"]').click();

test.describe("首次使用与隐私", () => {
  test("首次打开必须同意隐私政策才能使用 @mobile", async ({ page }) => {
    const errors = await boot(page, { consent: false });
    const dlg = page.locator("#consent");
    await expect(dlg).toBeVisible();
    await expect(page.locator("#cOk")).toBeDisabled();
    await page.click("#cNo");
    await expect(page.locator("#cMsg")).toContainText("不会保存任何内容");
    await page.check("#cAgree");
    await expect(page.locator("#cOk")).toBeDisabled();
    await page.check("#cAge");
    await page.click("#cOk");
    await expect(dlg).toBeHidden();
    await page.reload();
    await expect(dlg).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("隐私政策页面包含关键章节，应用内有入口", async ({ page }) => {
    await boot(page);
    await expect(page.locator('footer a[href="privacy.html"]')).toBeVisible();
    await page.goto("/privacy.html");
    for (const t of ["敏感个人信息", "存储位置与跨境说明", "你的权利", "未成年人", "不是医疗服务", "12356", "删除我的全部数据"]) {
      await expect(page.locator("main")).toContainText(t);
    }
  });

  test("联网功能需要单独勾选同意", async ({ page }) => {
    const errors = await boot(page);
    await page.route(/auth\/v1\/token/, (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error_description: "Invalid login credentials" }) }));
    await tab(page, "me");
    await page.fill("#sbEmail", "someone@example.com");
    await page.fill("#sbPw", "password-123");
    await page.click("#sbIn");
    await expect(page.locator("#sbMsg")).toContainText("请先勾选");
    await page.check("#sbAgree");
    await page.click("#sbIn");
    await expect(page.locator("#sbMsg")).toHaveText("登录失败：邮箱或密码不对");
    expect(await page.evaluate(() => !!JSON.parse(localStorage.getItem("qy_prefs")).agree.sb)).toBe(true);
    await page.click("#pushOn");
    await expect(page.locator("#pushState")).toContainText("请先勾选");
    expect(errors).toEqual([]);
  });
});

test.describe("记录", () => {
  test("记录一条心情，可筛选、搜索、二次确认删除", async ({ page }) => {
    const errors = await boot(page);
    await page.locator(".moods button").nth(1).click();
    await page.locator("#emos .chip", { hasText: "焦虑" }).click();
    await page.locator("#trigs .chip", { hasText: "学业/考试" }).click();
    await page.fill("#note", "组会被点名，脑子一片空白");
    await page.click("#save");
    await expect(page.locator(".entry")).toHaveCount(1);
    await expect(page.locator("#after")).toContainText("已记录");
    await expect(page.locator("#support")).toBeHidden();
    await page.locator(".moods button").nth(4).click();
    await page.fill("#note", "跑步之后心情不错");
    await page.click("#save");
    await expect(page.locator(".entry")).toHaveCount(2);
    await page.selectOption("#filter", "low");
    await expect(page.locator(".entry")).toHaveCount(1);
    await page.selectOption("#filter", "0");
    await page.fill("#search", "跑步");
    await expect(page.locator(".entry")).toHaveCount(1);
    await page.fill("#search", "");
    const del = page.locator(".entry button").first();
    await del.click();
    await expect(del).toHaveText("确认删除");
    await expect(page.locator(".entry")).toHaveCount(2);
    await del.click();
    await expect(page.locator(".entry")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("导出与导入备份", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 3, note: "第一条" }, { mood: 4, note: "第二条" }]);
    await tab(page, "me");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exp")]);
    const data = JSON.parse(await (await dl.createReadStream()).toArray().then((b) => Buffer.concat(b).toString()));
    expect(data.entries).toHaveLength(2);
    await page.setInputFiles("#imp", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ entries: [{ id: "imp1", t: Date.now() - 5e8, mood: 3, emos: [], trigs: [], note: "导入的一条" }] })) });
    await expect(page.locator("#meMsg")).toContainText("新增 1 条");
  });
});

test.describe("安全：危机识别", () => {
  test("识别规则：高风险说法命中，日常夸张说法不误报", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const yes = ["我真的不想活了", "活着没有意义", "想自杀", "想结束自己的生命", "昨晚割腕了", "我想死", "攒了很多安眠药", "I want to die"];
      const no = ["笑死我了", "今天累死了", "饿死了", "想死你了", "商场跳楼价", "这题难死了", "安眠药吃了一片才睡着", ""];
      return { missed: yes.filter((t) => !isRisk(t)), wrong: no.filter((t) => isRisk(t)) };
    });
    expect(r.missed).toEqual([]);
    expect(r.wrong).toEqual([]);
  });

  test("写下危机内容时立刻给出求助方式，并持续提醒 @mobile", async ({ page }) => {
    const errors = await boot(page);
    await page.locator(".moods button").nth(0).click();
    await page.fill("#note", "我真的不想活了");
    await page.click("#save");
    const sup = page.locator("#support");
    await expect(sup).toBeVisible();
    await expect(page.locator("#supTitle")).toHaveText("你现在安全吗？");
    await expect(sup).toContainText("12356");
    await expect(sup.locator('a[href="tel:12356"]')).toBeVisible();
    expect(await page.evaluate(() => entries[0].risk)).toBe(true);
    await page.click("#supOk");
    await expect(sup).toBeHidden();
    await expect(page.locator("#lowAlert")).toContainText("12356");
    await expect(page.locator("#after")).toContainText("查看求助方式");
    expect(errors).toEqual([]);
  });

  test("想法整理里的危机内容同样会被识别", async ({ page }) => {
    await boot(page);
    await tab(page, "care");
    await page.click("#cbtOpen");
    await page.fill("#cbtThought", "活着没有意义");
    await page.click("#cbtSave");
    await expect(page.locator("#support")).toBeVisible();
    expect(await page.evaluate(() => thoughts[0].risk)).toBe(true);
  });

  test("顶部“需要帮助”随时可用，按 Esc 关闭", async ({ page }) => {
    await boot(page);
    await page.click("#helpBtn");
    await expect(page.locator("#support")).toBeVisible();
    await expect(page.locator("#supTitle")).toHaveText("需要帮助的时候");
    await page.keyboard.press("Escape");
    await expect(page.locator("#support")).toBeHidden();
  });
});

test.describe("AI 复盘", () => {
  async function setupAI(page) {
    await page.evaluate(() => { localStorage.setItem("qy_ai", JSON.stringify({ base: "https://mock-ai.test/v1", model: "m", ok: true })); memKey = "sk-test"; });
  }

  test("本周有危机内容时，AI 复盘暂停且不发送任何文字", async ({ page }) => {
    await boot(page);
    let calls = 0;
    await page.route("https://mock-ai.test/**", (r) => { calls++; r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await setupAI(page);
    await seed(page, [{ mood: 1, note: "不如死了算了" }, { mood: 3, note: "还行" }, { mood: 3 }]);
    await tab(page, "insight");
    await page.click("#rpAI");
    await expect(page.locator("#aiOut")).toContainText("暂停");
    await expect(page.locator("#support")).toBeVisible();
    expect(calls).toBe(0);
  });

  test("正常情况下调用 AI，并带上安全约束", async ({ page }) => {
    await boot(page);
    let body = null;
    await page.route("https://mock-ai.test/**", async (r) => {
      body = r.request().postDataJSON();
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "这周你像在爬坡，先照顾好睡眠。" } }] }) });
    });
    await setupAI(page);
    await seed(page, [{ mood: 2, note: "考试周" }, { mood: 3, note: "还行" }, { mood: 4, note: "跑步了" }]);
    await tab(page, "insight");
    await page.click("#rpAI");
    await expect(page.locator("#aiOut")).toContainText("爬坡");
    expect(body.messages[0].content).toContain("12356");
    expect(body.messages[0].content).toContain("不做诊断");
  });
});

test.describe("周报：样本量与措辞", () => {
  test("记录少于 3 条时不下结论", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 1, trigs: ["睡眠不足"], note: "没睡好" }]);
    await tab(page, "insight");
    const rp = page.locator("#rpBody");
    await expect(rp).toContainText("再记 2 条");
    await expect(rp).not.toContainText("睡眠不足时");
    await expect(rp).not.toContainText("可能在拉低");
  });

  test("只有 1 条睡眠不足时，不说睡眠和心情有关", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 1, trigs: ["睡眠不足"] }, { mood: 4 }, { mood: 4 }, { mood: 5 }]);
    await tab(page, "insight");
    await expect(page.locator("#rpBody")).not.toContainText("睡眠不足时");
    await expect(page.locator("#rpBody")).toContainText("不是诊断");
  });

  test("证据足够时才给出“可能”的发现，并提示样本少", async ({ page }) => {
    await boot(page);
    await seed(page, [
      { mood: 1, trigs: ["睡眠不足", "学业/考试"] }, { mood: 2, trigs: ["睡眠不足", "学业/考试"] },
      { mood: 4 }, { mood: 4 }, { mood: 5 },
    ]);
    await tab(page, "insight");
    const rp = page.locator("#rpBody");
    await expect(rp).toContainText("睡眠不足时心情可能更低");
    await expect(rp).toContainText("样本还少");
    await expect(rp).toContainText("可能在拉低你的心情");
    await expect(rp).not.toContainText("明显关联");
  });

  test("示例数据下洞察页完整渲染", async ({ page }) => {
    const errors = await boot(page);
    await tab(page, "insight");
    await page.click("#demo");
    await expect(page.locator("#chart svg")).toBeVisible();
    await expect(page.locator("#trigbars .bar").first()).toBeVisible();
    await expect(page.locator("#rpBody")).toContainText("小建议");
    expect(errors).toEqual([]);
  });
});

test.describe("数据安全", () => {
  test("启用本机加密后磁盘无明文，重新打开需要口令", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 2, note: "只属于我的秘密" }]);
    await tab(page, "me");
    await page.fill("#vpass", "a long test passphrase");
    await page.click("#vOn");
    await expect(page.locator("#vState")).toContainText("已加密");
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("只属于我的秘密");
    await page.reload();
    await expect(page.locator("#lock")).toBeVisible();
    await page.fill("#lockIn", "wrong passphrase");
    await page.click("#lockGo");
    await expect(page.locator("#lockMsg")).toHaveText("口令不对");
    await page.fill("#lockIn", "a long test passphrase");
    await page.click("#lockGo");
    await expect(page.locator("#lock")).toBeHidden();
    await expect(page.locator(".entry")).toContainText("只属于我的秘密");
  });

  test("删除我的全部数据：输入确认后清除本机、云端账号与推送订阅", async ({ page }) => {
    await boot(page);
    const calls = [];
    await page.route(/functions\/v1\/push/, async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); });
    await seed(page, [{ mood: 3, note: "要被删掉的记录" }]);
    await page.evaluate(() => { sess = { at: "user-access-token", rt: "r", exp: Date.now() + 1e6, email: "a@b.c", uid: "u1" }; sbUI(); });
    await tab(page, "me");
    await page.click("#delOpen");
    await expect(page.locator("#delList")).toContainText("本机的全部记录");
    await expect(page.locator("#delList")).toContainText("a@b.c");
    await expect(page.locator("#delGo")).toBeDisabled();
    await page.fill("#delConfirm", "删");
    await expect(page.locator("#delGo")).toBeDisabled();
    await page.fill("#delConfirm", "删除");
    await page.click("#delGo");
    await expect(page.locator("#delMsg")).toContainText("本机数据：已全部清除");
    await expect(page.locator("#delMsg")).toContainText("云端账号和云端数据：已删除");
    expect(calls.find((c) => c.action === "delete_account").token).toBe("user-access-token");
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });

  test("“仅删除云端数据”只删数据、保留账号，并说明清楚", async ({ page }) => {
    await boot(page);
    const calls = [];
    await page.route(/rest\/v1\/vaults/, async (r) => { calls.push(r.request().method() + " " + r.request().url()); await r.fulfill({ status: 204, body: "" }); });
    await page.route(/functions\/v1\/push/, async (r) => { calls.push("FN " + r.request().postData()); await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); });
    await page.evaluate(() => { sess = { at: "user-access-token", rt: "r", exp: Date.now() + 1e6, email: "a@b.c", uid: "u1" }; sbUI(); });
    await tab(page, "me");
    const btn = page.locator("#sbDel");
    await expect(btn).toHaveText("仅删除云端数据（保留账号）");
    await btn.click();
    await expect(btn).toHaveText("再点一次：只删数据，账号保留");
    expect(calls).toEqual([]);
    await btn.click();
    await expect(page.locator("#sbMsg")).toContainText("账号仍然保留");
    await expect(page.locator("#sbMsg")).toContainText("删除我的全部数据");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^DELETE .*vaults\?user_id=eq\.u1$/);
    await expect(btn).toHaveText("仅删除云端数据（保留账号）");
  });

  test("推送接口被限流时给出明确提示", async ({ page }) => {
    await boot(page);
    await page.route(/functions\/v1\/push/, (r) => r.fulfill({ status: 429, contentType: "application/json", body: '{"error":"rate limited"}' }));
    const msg = await page.evaluate(() => pushCall({ action: "test", endpoint: "https://x" }).then(() => "ok", (e) => e.message));
    expect(msg).toBe("操作太频繁，请稍后再试");
  });
});

test.describe("疗愈", () => {
  test("白噪音可以播放和停止，引导练习完成后记入练习日志", async ({ page }) => {
    const errors = await boot(page);
    await tab(page, "care");
    await page.locator("#scenes .chip").first().click();
    await expect(page.locator("#now")).toContainText("正在播放");
    await page.locator("#now button").first().click();
    await expect(page.locator("#now")).toBeHidden();
    await page.uncheck("#voice");
    await page.locator("#meds .rec button").first().click();
    await expect(page.locator("#now")).toContainText("第 1/");
    await page.evaluate(() => { while (Guide.g) Guide.next(); });
    await expect(page.locator("#now")).toContainText("完成了");
    expect(await page.evaluate(() => practice.length)).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe("布局", () => {
  test("手机宽度下各页面没有横向滚动 @mobile", async ({ page }) => {
    await boot(page);
    await tab(page, "insight");
    await page.click("#demo");
    for (const t of ["log", "insight", "care", "me"]) {
      await tab(page, t);
      const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      expect(sw, t).toBeLessThanOrEqual(iw);
    }
  });
});

test.describe("情绪与原因的对应", () => {
  test("选“很好 + 感恩”时只问让你感觉不错的原因，并按正面来源保存 @mobile", async ({ page }) => {
    const errors = await boot(page);
    await page.locator(".moods button").nth(4).click();
    await page.locator("#emos .chip", { hasText: "感恩" }).click();
    await expect(page.locator("#trigNegBox")).toBeHidden();
    await expect(page.locator("#trigPosBox")).toBeVisible();
    await expect(page.locator("#trigPosBox")).toContainText("是什么让你感觉不错");
    await page.locator("#goods .chip", { hasText: "运动/户外" }).click();
    await page.click("#save");
    const e = await page.evaluate(() => entries[0]);
    expect(e.trigs).toEqual([]);
    expect(e.pos).toEqual(["运动/户外"]);
    await expect(page.locator("#after")).toContainText("「运动/户外」让你感觉不错");
    await expect(page.locator("#after")).not.toContainText("对你有影响");
    await expect(page.locator(".entry .tag.g")).toHaveText("运动/户外");
    expect(errors).toEqual([]);
  });

  test("选负面情绪时只问压力来源；两种都选时两组都显示", async ({ page }) => {
    await boot(page);
    await page.locator(".moods button").nth(1).click();
    await expect(page.locator("#trigNegBox")).toBeVisible();
    await expect(page.locator("#trigPosBox")).toBeHidden();
    await page.locator("#emos .chip", { hasText: "焦虑" }).click();
    await expect(page.locator("#trigPosBox")).toBeHidden();
    await page.locator("#emos .chip", { hasText: "期待" }).click();
    await expect(page.locator("#trigNegBox")).toBeVisible();
    await expect(page.locator("#trigPosBox")).toBeVisible();
  });

  test("切换情绪后，被隐藏的那组原因不会被存进去", async ({ page }) => {
    await boot(page);
    await page.locator(".moods button").nth(1).click();
    await page.locator("#emos .chip", { hasText: "焦虑" }).click();
    await page.locator("#trigs .chip", { hasText: "学业/考试" }).click();
    await page.locator("#emos .chip", { hasText: "焦虑" }).click();
    await page.locator("#emos .chip", { hasText: "开心" }).click();
    await expect(page.locator("#trigNegBox")).toBeHidden();
    await page.click("#save");
    const e = await page.evaluate(() => entries[0]);
    expect(e.emos).toEqual(["开心"]);
    expect(e.trigs).toEqual([]);
  });

  test("写作提示跟着心情变化", async ({ page }) => {
    await boot(page);
    const ph = () => page.locator("#note").getAttribute("placeholder");
    await page.locator(".moods button").nth(4).click();
    const high = await page.evaluate(() => PROMPTS.high);
    expect(high).toContain(await ph());
    await page.locator(".moods button").nth(0).click();
    const low = await page.evaluate(() => PROMPTS.low);
    expect(low).toContain(await ph());
  });

  test("示例数据里，情绪、原因、备注和心情彼此一致", async ({ page }) => {
    await boot(page);
    await tab(page, "insight");
    await page.click("#demo");
    const bad = await page.evaluate(() => entries.filter((e) => {
      const neg = e.emos.some((x) => NEG.includes(x)), pos = e.emos.some((x) => !NEG.includes(x));
      return (pos && e.trigs.length) || (neg && e.pos.length) || (pos && e.mood <= 2) || (neg && e.mood >= 4) ||
        (/不错|轻松|终于/.test(e.note) && e.mood <= 2) || (/空白|飘|担心|慌/.test(e.note) && e.mood >= 4);
    }).map((e) => e.note));
    expect(bad).toEqual([]);
    await expect(page.locator("#goodbars .bar").first()).toBeVisible();
    await expect(page.locator("#trigbars .bar").first()).toBeVisible();
  });
});
