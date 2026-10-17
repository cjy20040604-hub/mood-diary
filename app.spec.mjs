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
  await page.waitForFunction(() => window.qyReady === true);
  return errors;
}
// 直接写入记录（时间都在最近 7 天内），用于需要精确数据的场景
async function seed(page, list) {
  await page.evaluate(({ list, HOUR }) => {
    entries = list.map((e, i) => ({ id: "s" + i, t: Date.now() - (e.h ?? i) * HOUR, mood: e.mood, emos: e.emos || [], trigs: e.trigs || [], note: e.note || "" }));
    save(); render();
  }, { list, HOUR });
}
// 写入是异步排队的；需要重新加载页面前，先等排队中的写入完成
const flush = (page) => page.evaluate(() => chain);
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
    await page.waitForFunction(() => window.qyReady === true);
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
    const del = page.locator(".entry").first().locator("button").nth(1); // 第二个按钮是“删除”
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
    await page.evaluate(() => { localStorage.setItem("qy_ai", JSON.stringify({ base: "https://mock-ai.test/v1", model: "m", ok: true, okv: 4 })); memKey = "sk-test"; initAIUI(); });
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
    expect(await page.evaluate(() => Store.dump())).not.toContain("只属于我的秘密");
    expect(await page.evaluate(() => Store.keys())).not.toContain("qy_entries");
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
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
    expect(await page.evaluate(() => Store.keys())).toEqual([]);
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
    await page.getByRole("button", { name: "跳过评分，直接开始" }).click();
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

test.describe("第二周：练习效果、首次引导、音频与计时", () => {
  test("练习前后评分，并显示变化 @mobile", async ({ page }) => {
    const errors = await boot(page);
    await tab(page, "care");
    await page.uncheck("#voice");
    await page.locator("#meds .rec", { hasText: "1 分钟呼吸" }).getByRole("button", { name: "开始" }).click();
    await expect(page.locator("#now")).toContainText("开始前，此刻感觉怎么样");
    await page.locator("#now .rate button").nth(1).click(); // 低落 = 2
    await expect(page.locator("#now")).toContainText("第 1/");
    await page.evaluate(() => { while (Guide.g) Guide.next(); });
    await expect(page.locator("#now")).toContainText("现在感觉怎么样");
    await page.locator("#now .rate button").nth(3).click(); // 不错 = 4
    await expect(page.locator("#now")).toContainText("比开始前好了 2 档");
    const p = await page.evaluate(() => practice[0]);
    expect([p.gid, p.pre, p.post]).toEqual(["breath1", 2, 4]);
    expect(errors).toEqual([]);
  });

  test("某个练习对你有效时，推荐会优先选它并说明依据", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      practice = [
        { id: "a", t: Date.now() - 3e5, g: "颈肩放松", gid: "neck", pre: 2, post: 4 },
        { id: "b", t: Date.now() - 2e5, g: "颈肩放松", gid: "neck", pre: 2, post: 3 },
        { id: "c", t: Date.now() - 1e5, g: "身体扫描", gid: "scan", pre: 2, post: 2 },
      ];
      entries = [{ id: "e", t: Date.now(), mood: 2, emos: ["焦虑"], trigs: [], pos: [], note: "" }];
      save(); render();
    });
    await tab(page, "care");
    const ex = page.locator("#recs .rec", { hasText: "运动" });
    await expect(ex).toContainText("颈肩放松");
    await expect(ex).toContainText("你做过 2 次，平均让心情好了 1.5 档");
    await expect(page.locator("#exs .rec", { hasText: "颈肩放松" })).toContainText("你的效果 +1.5 档（2 次）");
    await tab(page, "insight");
    await expect(page.locator("#effbars")).toContainText("颈肩放松");
  });

  test("首次引导：同意后出现，可直接开始 1 分钟呼吸，之后不再出现", async ({ page }) => {
    await boot(page, { consent: false });
    await page.check("#cAgree"); await page.check("#cAge"); await page.click("#cOk");
    await expect(page.locator("#onboard")).toBeVisible();
    await page.click("#obBreath");
    await expect(page.locator("#now")).toContainText("1 分钟呼吸");
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    await expect(page.locator("#onboard")).toBeHidden();
  });

  test("记录不足 3 条时提示还差几条", async ({ page }) => {
    await boot(page);
    await page.locator(".moods button").nth(2).click();
    await page.click("#save");
    await expect(page.locator("#after")).toContainText("再记 2 条");
  });

  test("白噪音是首尾无缝的循环音频，定时到点会停止", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
      const x = new Float32Array(10 * 33).map((_, i) => i); // 用递增序列检验拼接位置
      const o = loopify(x, 10, 30, 3);
      const url = await Snd.render("ocean");
      const blob = await fetch(url).then((r) => r.blob());
      return { len: o.length, first: o[0], tailNext: x[300], last: o[299], type: blob.type, kb: Math.round(blob.size / 1024) };
    });
    expect(r.len).toBe(300);
    expect(r.first).toBeCloseTo(r.tailNext, 5); // 循环回到开头时，正好接在结尾的下一个采样
    expect(r.last).toBe(299);
    expect(r.type).toBe("audio/wav");
    expect(r.kb).toBeGreaterThan(1000);
    await tab(page, "care");
    await page.locator("#scenes .chip").first().click();
    await expect(page.locator("#now")).toContainText("正在播放");
    await page.evaluate(() => { Snd.endAt = Date.now() - 1; Snd.tick(); });
    await expect(page.locator("#now")).toBeHidden();
    expect(await page.evaluate(() => Snd.cur)).toBe(null);
  });

  test("引导按时间戳计时：页面被挂起后能追上正确的步骤", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { $("#voice").checked = false; Guide.start(MEDS.find((x) => x.id === "breath1")); Guide.begin(null); });
    // 模拟后台挂起 15 秒：把开始时间往前拨
    const step = await page.evaluate(() => { const shift = 15000; Guide.stepEnd -= shift; Guide.tick(); return Guide.i; });
    expect(step).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => Guide.stop());
  });
});

test.describe("存储：IndexedDB 与迁移", () => {
  test("旧版 localStorage 数据会迁移到 IndexedDB，核对后才删除旧数据", async ({ page }) => {
    await page.route(/fonts\.|supabase\.co/, (r) => r.fulfill({ status: 200, body: "" }));
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("qy_prefs", JSON.stringify({ consent: { v: 1, t: 1 } }));
      localStorage.setItem("qy_entries", JSON.stringify([{ id: "old1", t: Date.now() - 5e6, mood: 2, emos: ["焦虑"], trigs: ["学业/考试"], note: "旧版本写下的记录" }]));
      localStorage.setItem("qy_practice", JSON.stringify([{ id: "p1", t: Date.now() - 4e6, g: "身体扫描" }]));
      localStorage.setItem("qy_tomb", JSON.stringify({ gone: 1 }));
    });
    await page.goto("/index.html");
    await page.waitForFunction(() => window.qyReady === true);
    await expect(page.locator(".entry")).toContainText("旧版本写下的记录");
    const r = await page.evaluate(async () => ({ mode: Store.mode, schema: await Store.get("qy_schema"), idb: (await Store.get("qy_entries")).length, ls: ["qy_entries", "qy_practice", "qy_tomb"].filter((k) => localStorage.getItem(k) != null) }));
    expect(r).toEqual({ mode: "idb", schema: 2, idb: 1, ls: [] });
    // 再次打开不会重复迁移，数据仍在
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    await expect(page.locator(".entry")).toContainText("旧版本写下的记录");
  });

  test("旧版的加密保险箱也会迁移，迁移后用原口令可以解锁", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 3, note: "加密的旧记录" }]);
    await tab(page, "me");
    await page.fill("#vpass", "old vault passphrase");
    await page.click("#vOn");
    await expect(page.locator("#vState")).toContainText("已加密");
    // 把保险箱挪回 localStorage，模拟旧版本
    await page.evaluate(async () => { localStorage.setItem("qy_vault", JSON.stringify(await Store.get("qy_vault"))); await Store.clear(); });
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    expect(await page.evaluate(() => localStorage.getItem("qy_vault"))).toBe(null);
    await expect(page.locator("#lock")).toBeVisible();
    await page.fill("#lockIn", "old vault passphrase");
    await page.click("#lockGo");
    await expect(page.locator(".entry")).toContainText("加密的旧记录");
  });

  test("浏览器不支持 IndexedDB 时自动退回 localStorage，功能照常", async ({ page }) => {
    await page.addInitScript(() => { try { Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true }); } catch (e) {} });
    await boot(page);
    expect(await page.evaluate(() => Store.mode)).toBe("ls");
    await page.locator(".moods button").nth(3).click();
    await page.fill("#note", "没有数据库也能记");
    await page.click("#save");
    await flush(page);
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    await expect(page.locator(".entry")).toContainText("没有数据库也能记");
  });

  test("数据读完之前不会写入，不会用空数据覆盖已有记录", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 4, note: "不能被覆盖" }]);
    await page.evaluate(() => chain);
    const r = await page.evaluate(async () => { ready = false; entries = []; save(); await chain; ready = true; return (await Store.get("qy_entries")).length; });
    expect(r).toBe(1);
  });
});

test.describe("云端恢复码与找回密码", () => {
  // 用内存模拟云端 vaults 表
  async function mockCloud(page) {
    const cloud = { blob: null };
    await page.route(/rest\/v1\/vaults/, async (r) => {
      const m = r.request().method();
      if (m === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cloud.blob ? [{ blob: cloud.blob }] : []) });
      if (m === "POST") { cloud.blob = r.request().postDataJSON()[0].blob; return r.fulfill({ status: 201, body: "" }); }
      return r.fulfill({ status: 204, body: "" });
    });
    await page.evaluate(() => { sess = { at: "t", rt: "r", exp: Date.now() + 1e6, email: "a@b.c", uid: "u1" }; sbUI(); const p = JSON.parse(localStorage.getItem("qy_prefs")); p.agree = { sb: 1 }; localStorage.setItem("qy_prefs", JSON.stringify(p)); $("#sbAgree").checked = true; });
    return cloud;
  }

  test("首次同步生成恢复码；忘记口令后可用恢复码重设，数据完好", async ({ page }) => {
    await boot(page);
    const cloud = await mockCloud(page);
    await seed(page, [{ mood: 3, note: "云端里的记录" }]);
    await tab(page, "me");
    await page.fill("#sbPass", "first-pass");
    await page.click("#sbNow");
    await expect(page.locator("#sbCodeBox")).toBeVisible();
    const code = await page.locator("#sbCode").innerText();
    expect(code).toMatch(/^([A-Z0-9]{4}-){7}[A-Z0-9]{4}$/);
    const j = JSON.parse(cloud.blob);
    expect(j.v).toBe(2);
    expect(cloud.blob).not.toContain("云端里的记录");
    await page.click("#sbCodeOk");
    // 换一台“设备”：本机清空，口令忘了
    await page.evaluate(() => { entries = []; cloudKeys = null; save(); render(); });
    await page.fill("#sbPass", "wrong-pass");
    await page.click("#sbNow");
    await expect(page.locator("#sbMsg")).toContainText("恢复码");
    await page.locator("#sbRecArea summary").click();
    await page.fill("#sbRecIn", code.toLowerCase());
    await page.fill("#sbNewPass", "brand-new-pass");
    await page.click("#sbRecGo");
    await expect(page.locator("#sbMsg")).toContainText("已用恢复码重设");
    await page.click("#sbNow");
    await expect(page.locator("#sbMsg")).toContainText("同步完成");
    await expect(page.locator(".entry")).toContainText("云端里的记录");
  });

  test("重新生成恢复码后，旧的恢复码失效", async ({ page }) => {
    await boot(page);
    await mockCloud(page);
    await tab(page, "me");
    await page.fill("#sbPass", "pass-one");
    await page.click("#sbNow");
    await expect(page.locator("#sbCodeBox")).toBeVisible();
    const oldCode = await page.locator("#sbCode").innerText();
    await page.click("#sbCodeOk");
    await page.click("#sbRecNew");
    await expect(page.locator("#sbCodeBox")).toBeVisible();
    const newCode = await page.locator("#sbCode").innerText();
    expect(newCode).not.toBe(oldCode);
    await page.locator("#sbRecArea summary").click();
    await page.fill("#sbRecIn", oldCode);
    await page.fill("#sbNewPass", "pass-two");
    await page.click("#sbRecGo");
    await expect(page.locator("#sbMsg")).toHaveText("恢复码不对，云端数据没有改动。");
  });

  test("旧格式的云端数据会在同步时自动升级并生成恢复码", async ({ page }) => {
    await boot(page);
    const cloud = await mockCloud(page);
    cloud.blob = await page.evaluate(() => encrypt({ entries: [{ id: "v1e", t: Date.now() - 1e6, mood: 4, emos: [], trigs: [], note: "旧格式的记录" }], thoughts: [], practice: [], tomb: {} }, "legacy-pass"));
    await tab(page, "me");
    await page.fill("#sbPass", "legacy-pass");
    await page.click("#sbNow");
    await expect(page.locator("#sbMsg")).toContainText("同步完成");
    await expect(page.locator("#sbCodeBox")).toBeVisible();
    expect(JSON.parse(cloud.blob).v).toBe(2);
    await expect(page.locator(".entry")).toContainText("旧格式的记录");
  });

  test("找回账号密码：发送重置邮件；从邮件链接回来可设置新密码", async ({ page }) => {
    await boot(page);
    let recover = null, update = null;
    await page.route(/auth\/v1\/recover/, async (r) => { recover = r.request().postDataJSON(); await r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await page.route(/auth\/v1\/user/, async (r) => { update = { method: r.request().method(), auth: r.request().headers()["authorization"], body: r.request().postDataJSON() }; await r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await tab(page, "me");
    await page.fill("#sbEmail", "me@example.com");
    await page.click("#sbForgot");
    await expect(page.locator("#sbMsg")).toContainText("会收到一封重置密码的邮件");
    expect(recover.email).toBe("me@example.com");
    await page.goto("/index.html?from=email#access_token=reset-token&type=recovery");
    await page.waitForFunction(() => window.qyReady === true);
    await expect(page.locator("#pwReset")).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe("");
    await page.fill("#pwNew", "new-password-123");
    await page.click("#pwGo");
    await expect(page.locator("#pwMsg")).toContainText("密码已更新");
    expect(update).toEqual({ method: "PUT", auth: "Bearer reset-token", body: { password: "new-password-123" } });
  });
});

test("声音名称不带多余空格（推荐卡片与锁屏媒体信息）", async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(() => Object.keys(SCENES).map(sceneName))).toEqual(["雨声", "海浪", "风声", "夜晚氛围", "白噪音"]);
  await tab(page, "care");
  await expect(page.locator("#recs .rec", { hasText: "音乐" }).locator("b")).toHaveText(/^\S/);
});

test.describe("一句话记录", () => {
  const chip = (page, box, t) => page.locator(box + " .chip", { hasText: t }).first();
  async function useAI(page, okv = 4) {
    await page.evaluate((okv) => { localStorage.setItem("qy_ai", JSON.stringify({ base: "https://mock-ai.test/v1", model: "m", ok: true, okv })); memKey = "sk-test"; initAIUI(); }, okv);
  }
  const aiReply = (obj) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: typeof obj === "string" ? obj : JSON.stringify(obj) } }] }) });

  test("没配置 AI 时用本机规则预填，不联网；确认保存后记下没有改动 @mobile", async ({ page }) => {
    const errors = await boot(page);
    const calls = [];
    page.on("request", (r) => { if (/chat\/completions/.test(r.url())) calls.push(r.url()); });
    await expect(page.locator("#qlSrc")).toContainText("本机规则识别");
    await page.fill("#qlIn", "明天考试好紧张，昨晚只睡了5小时");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("本机规则识别");
    await expect(page.locator("#moods button").nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page, "#emos", "焦虑")).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page, "#trigs", "学业/考试")).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page, "#trigs", "睡眠不足")).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page, "#sleepChips", "5–6 小时")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#note")).toHaveValue("明天考试好紧张，昨晚只睡了5小时");
    await page.click("#save");
    expect(await page.evaluate(() => entries[0].ql)).toEqual({ s: "rule", fix: 0 });
    await expect(page.locator("#qlIn")).toHaveValue("");
    await expect(page.locator("#qlMsg")).toBeHidden();
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("用户改了预填结果，保存时记下改了几处；撤销能恢复原样", async ({ page }) => {
    await boot(page);
    await page.fill("#qlIn", "和室友吵架了，很烦");
    await page.click("#qlGo");
    await expect(chip(page, "#emos", "烦躁")).toHaveAttribute("aria-pressed", "true");
    await page.click("#qlUndo");
    await expect(chip(page, "#emos", "烦躁")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#note")).toHaveValue("");
    expect(await page.evaluate(() => S.mood)).toBe(0);
    await page.click("#qlGo");
    await chip(page, "#emos", "委屈").click();
    await chip(page, "#trigs", "人际社交").click();
    await page.click("#save");
    expect(await page.evaluate(() => entries[0].ql)).toEqual({ s: "rule", fix: 2 });
  });

  test("危机表达：不识别、不发送，直接给出求助方式", async ({ page }) => {
    await boot(page);
    let calls = 0;
    await page.route("https://mock-ai.test/**", (r) => { calls++; r.fulfill(aiReply({ mood: 1 })); });
    await useAI(page);
    await page.fill("#qlIn", "真的不想活了");
    await page.click("#qlGo");
    await expect(page.locator("#support")).toBeVisible();
    await expect(page.locator("#supTitle")).toHaveText("你现在安全吗？");
    await page.click("#supOk");
    await expect(page.locator("#qlMsg")).toContainText("12356");
    expect(await page.evaluate(() => ({ m: S.mood, e: S.emos.size, n: $("#note").value }))).toEqual({ m: 0, e: 0, n: "" });
    expect(calls).toBe(0);
  });

  test("AI 模式：只能从已有标签里选，无效标签被丢弃，结果由用户确认", async ({ page }) => {
    await boot(page);
    let body = null;
    await page.route("https://mock-ai.test/**", async (r) => {
      body = r.request().postDataJSON();
      await r.fulfill(aiReply("```json\n" + JSON.stringify({ mood: 2, emotions: ["焦虑", "难过"], stress: ["学业/考试", "导师"], good: [], sleep_hours: null, risk: false }) + "\n```"));
    });
    await useAI(page);
    await expect(page.locator("#qlSrc")).toContainText("AI 模型识别");
    await page.fill("#qlIn", "组会被点名，脑子一片空白");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("AI 识别");
    await expect(chip(page, "#emos", "焦虑")).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page, "#trigs", "学业/考试")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => [...S.emos, ...S.trigs])).toEqual(["焦虑", "学业/考试"]);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toContain("只输出一个 JSON");
    expect(body.messages[0].content).toContain("risk");
    expect(body.messages[1].content).toContain("组会被点名");
    await page.click("#save");
    expect(await page.evaluate(() => entries[0].ql)).toEqual({ s: "ai", fix: 0 });
  });

  test("AI 判断有风险时停止填表；这句话写进记录后也会标记为需要关注", async ({ page }) => {
    await boot(page);
    await page.route("https://mock-ai.test/**", (r) => r.fulfill(aiReply({ mood: 1, emotions: [], stress: [], good: [], sleep_hours: null, risk: true })));
    await useAI(page);
    const t = "好想睡一觉再也不醒来";
    await page.fill("#qlIn", t);
    await page.click("#qlGo");
    await expect(page.locator("#support")).toBeVisible();
    await page.click("#supOk");
    expect(await page.evaluate(() => S.mood)).toBe(0);
    await page.locator("#moods button").first().click();
    await page.fill("#note", t);
    await page.click("#save");
    expect(await page.evaluate(() => entries[0].risk)).toBe(true);
  });

  test("AI 接口出错或返回格式不对时，自动退回本机规则", async ({ page }) => {
    await boot(page);
    let n = 0;
    await page.route("https://mock-ai.test/**", (r) => (++n === 1 ? r.fulfill({ status: 500, body: "{}" }) : r.fulfill(aiReply("好的，我来帮你分析一下"))));
    await useAI(page);
    await page.fill("#qlIn", "和室友吵架了，很烦");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("AI 暂时不可用（接口返回 500）");
    await expect(page.locator("#qlMsg")).toContainText("本机规则识别");
    await expect(chip(page, "#emos", "烦躁")).toHaveAttribute("aria-pressed", "true");
    await page.click("#qlUndo");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("没有返回 JSON");
    await expect(page.locator("#qlGo")).toBeEnabled();
  });

  test("旧版 AI 同意不覆盖一句话记录，需要重新勾选", async ({ page }) => {
    await boot(page);
    let calls = 0;
    await page.route("https://mock-ai.test/**", (r) => { calls++; r.fulfill(aiReply({})); });
    await useAI(page, 3);
    await expect(page.locator("#qlSrc")).toContainText("勾选同意后");
    await page.fill("#qlIn", "和室友吵架了，很烦");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("本机规则识别");
    expect(calls).toBe(0);
  });

  test("看不出心情的句子不乱填，只放进备注", async ({ page }) => {
    await boot(page);
    await page.fill("#qlIn", "今天吃了饭");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("没有识别出明确的心情或原因");
    expect(await page.evaluate(() => S.mood)).toBe(0);
    await expect(page.locator("#note")).toHaveValue("今天吃了饭");
  });
});

test.describe("AI 试用码与危险信号检查", () => {
  const FN = /functions\/v1\/ai$/;
  const chip = (page, box, t) => page.locator(box + " .chip", { hasText: t }).first();
  async function trial(page, handler) {
    const calls = [];
    await page.route(FN, async (r) => { const b = r.request().postDataJSON(); calls.push(b); await handler(b, r); });
    return calls;
  }
  const ok = (r, obj) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });
  async function enableTrial(page, { risk = false } = {}) {
    await tab(page, "me");
    await page.fill("#aiCode", "qy-test1234");
    await page.click("#aiCodeGo");
    await expect(page.locator("#aiMsg")).toContainText("试用码有效");
    await page.check("#aiOk");
    if (risk) await page.check("#aiRiskOk");
    await page.click("#aiSave");
    await tab(page, "log");
  }

  test("填写试用码并同意后，一句话记录走服务端；请求里只有文字和标签，没有提示词", async ({ page }) => {
    const errors = await boot(page);
    const calls = await trial(page, (b, r) => b.action === "check" ? ok(r, { ok: true })
      : ok(r, { content: JSON.stringify({ mood: 2, emotions: ["焦虑"], stress: ["学业/考试"], good: [], sleep_hours: null, risk: false }) }));
    await enableTrial(page);
    await expect(page.locator("#qlSrc")).toContainText("试用码");
    await page.fill("#qlIn", "组会被点名，脑子一片空白");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("AI 识别");
    await expect(chip(page, "#emos", "焦虑")).toHaveAttribute("aria-pressed", "true");
    const q = calls.find((c) => c.action === "ql");
    expect(q.code).toBe("QY-TEST1234");
    expect(q.install).toMatch(/^[0-9a-f-]{36}$/);
    expect(q.text).toBe("组会被点名，脑子一片空白");
    expect(q.labels.emos).toContain("焦虑");
    expect(q.messages).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("试用码无效时提示，不开启 AI", async ({ page }) => {
    await boot(page);
    await trial(page, (b, r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"invalid code"}' }));
    await tab(page, "me");
    await page.fill("#aiCode", "QY-WRONG000");
    await page.click("#aiCodeGo");
    await expect(page.locator("#aiMsg")).toContainText("试用码无效或已停用");
    expect(await page.evaluate(() => aiProvider())).toBeNull();
  });

  test("当天次数用完时，退回本机规则并说明原因", async ({ page }) => {
    await boot(page);
    await trial(page, (b, r) => b.action === "check" ? ok(r, { ok: true }) : r.fulfill({ status: 429, contentType: "application/json", body: "{}" }));
    await enableTrial(page);
    await page.fill("#qlIn", "和室友吵架了，很烦");
    await page.click("#qlGo");
    await expect(page.locator("#qlMsg")).toContainText("今天的 AI 次数用完了");
    await expect(page.locator("#qlMsg")).toContainText("本机规则识别");
    await expect(chip(page, "#emos", "烦躁")).toHaveAttribute("aria-pressed", "true");
  });

  test("危险信号检查默认关闭：保存日记不会把文字发给 AI", async ({ page }) => {
    await boot(page);
    const calls = await trial(page, (b, r) => ok(r, b.action === "check" ? { ok: true } : { content: '{"risk":true}' }));
    await enableTrial(page);
    await expect(page.locator("#aiRiskOk")).not.toBeChecked();
    await page.locator("#moods button").nth(1).click();
    await page.fill("#note", "我是所有人的负担");
    await page.click("#save");
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.action === "risk")).toEqual([]);
    await expect(page.locator("#support")).toBeHidden();
  });

  test("开启后：关键词没拦住的隐晦表达，由 AI 识别出来并给出求助方式", async ({ page }) => {
    await boot(page);
    const calls = await trial(page, (b, r) => ok(r, b.action === "check" ? { ok: true } : { content: '{"risk":true}' }));
    await enableTrial(page, { risk: true });
    await page.locator("#moods button").nth(1).click();
    await page.fill("#note", "我是所有人的负担");
    await page.click("#save");
    await expect(page.locator("#support")).toBeVisible();
    await page.click("#supOk");
    expect(await page.evaluate(() => ({ risk: entries[0].risk, rk: entries[0].rk }))).toEqual({ risk: true, rk: "ai" });
    await expect(page.locator("#after")).toContainText("12356");
    await expect(page.locator("#lowAlert")).toBeVisible();
    const rc = calls.filter((c) => c.action === "risk");
    expect(rc.length).toBe(1);
    expect(rc[0].text).toBe("我是所有人的负担");
  });

  test("开启后：关键词已命中的不再发给 AI；AI 说没有风险或出错时不打扰", async ({ page }) => {
    await boot(page);
    let reply = '{"risk":false}';
    const calls = await trial(page, (b, r) => b.action === "check" ? ok(r, { ok: true }) : (reply === "500" ? r.fulfill({ status: 500, body: "{}" }) : ok(r, { content: reply })));
    await enableTrial(page, { risk: true });
    await page.locator("#moods button").nth(0).click();
    await page.fill("#note", "真的不想活了");
    await page.click("#save");
    await expect(page.locator("#support")).toBeVisible();
    await page.click("#supOk");
    expect(calls.filter((c) => c.action === "risk")).toEqual([]);
    for (const r of ['{"risk":false}', "500"]) {
      reply = r;
      await page.locator("#moods button").nth(2).click();
      await page.fill("#note", "今天有点累，早点睡");
      await page.click("#save");
      await page.waitForTimeout(300);
      await expect(page.locator("#support")).toBeHidden();
      expect(await page.evaluate(() => !!entries[0].risk)).toBe(false);
    }
  });

  test("想法整理保存后同样检查", async ({ page }) => {
    await boot(page);
    await trial(page, (b, r) => ok(r, b.action === "check" ? { ok: true } : { content: '{"risk":true}' }));
    await enableTrial(page, { risk: true });
    await tab(page, "care");
    await page.click("#cbtOpen");
    await page.fill("#cbtThought", "要是我消失了，大家应该会轻松很多");
    await page.click("#cbtSave");
    await expect(page.locator("#support")).toBeVisible();
    expect(await page.evaluate(() => thoughts[0].risk)).toBe(true);
  });

  test("上一版同意（v3）不覆盖试用码和危险信号检查", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { localStorage.setItem("qy_ai", JSON.stringify({ code: "QY-TEST1234", ok: true, okv: 3, risk: true, rv: 1 })); initAIUI(); });
    expect(await page.evaluate(() => [aiProvider(), getAI().riskOk])).toEqual([null, false]);
    await expect(page.locator("#qlSrc")).toContainText("勾选同意后");
  });
});

test("没有试用码的访客可以从设置页直接去意见反馈申请", async ({ page }) => {
  await boot(page);
  await tab(page, "me");
  await expect(page.locator("#aiApply")).toBeVisible();
  await page.click("#aiApply");
  await expect(page.locator("#fbBody")).toHaveValue(/申请一个 AI 试用码/);
  await expect(page.locator("#fbContact")).toBeFocused();
});

test("服务端函数和 core.js 生成的提示词完全相同", async () => {
  const fs = await import("node:fs"), vm = await import("node:vm");
  const core = fs.readFileSync("core.js", "utf8"), fn = fs.readFileSync("supabase-ai-function.ts", "utf8");
  const block = (s) => s.slice(s.indexOf("// PROMPT-BEGIN"), s.indexOf("// PROMPT-END"));
  const a = vm.createContext({}); vm.runInContext(core + ";globalThis.X={QL};", a);
  const b = vm.createContext({}); vm.runInContext(block(fn) + ";globalThis.X={qlMessages,riskMessages,QL_PROMPT_V,RISK_PROMPT_V};", b);
  const QL = a.X.QL, S = b.X;
  const labels = { emos: ["焦虑", "开心"], trigs: ["学业/考试", "自定义"], goods: ["运动/户外"] };
  expect(JSON.stringify(S.qlMessages("组会被点名", QL.joinLabels(labels)))).toBe(JSON.stringify(QL.messages("组会被点名", labels)));
  expect(JSON.stringify(S.riskMessages("我是所有人的负担"))).toBe(JSON.stringify(QL.riskMessages("我是所有人的负担")));
  expect([S.QL_PROMPT_V, S.RISK_PROMPT_V]).toEqual([QL.PROMPT_V, QL.RISK_PROMPT_V]);
  expect(fn).not.toMatch(/sk-[A-Za-z0-9]{8}/);
});

test.describe("AI 复盘只用你自己的接口", () => {
  test("没填写自己的接口时不显示 AI 按钮，也不会发出任何请求", async ({ page }) => {
    await boot(page);
    const calls = [];
    page.on("request", (r) => { if (/functions\/v1\/ai|chat\/completions/.test(r.url())) calls.push(r.url()); });
    await seed(page, [{ mood: 2 }, { mood: 3 }, { mood: 4 }]);
    await tab(page, "insight");
    await expect(page.locator("#rpAI")).toBeHidden();
    await expect(page.locator("#rpBody")).toContainText("小建议");
    expect(calls).toEqual([]);
  });

  test("填写并保存自己的接口后出现按钮，同意后才发送", async ({ page }) => {
    await boot(page);
    let calls = 0;
    await page.route("https://mock-ai.test/**", (r) => { calls++; r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "复盘内容" } }] }) }); });
    await seed(page, [{ mood: 2 }, { mood: 3 }, { mood: 4 }]);
    await tab(page, "me");
    await page.fill("#aiBase", "https://mock-ai.test/v1");
    await page.fill("#aiModel", "m");
    await page.fill("#aiKey", "sk-mine");
    await page.click("#aiSave");
    await tab(page, "insight");
    await expect(page.locator("#rpAI")).toBeVisible();
    await page.click("#rpAI");
    await expect(page.locator("#aiHint")).toContainText("勾选数据发送同意");
    expect(calls).toBe(0);
    await tab(page, "me");
    await page.check("#aiOk");
    await page.click("#aiSave");
    await tab(page, "insight");
    await page.click("#rpAI");
    await expect(page.locator("#aiOut")).toContainText("复盘内容");
    expect(calls).toBe(1);
  });

  test("旧版本留下的同意（没有版本号）不会被沿用", async ({ page }) => {
    await boot(page);
    let calls = 0;
    await page.route("https://mock-ai.test/**", (r) => { calls++; r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await page.evaluate(() => { localStorage.setItem("qy_ai", JSON.stringify({ base: "https://mock-ai.test/v1", model: "m", ok: true })); memKey = "sk-old"; initAIUI(); });
    await seed(page, [{ mood: 2 }, { mood: 3 }, { mood: 4 }]);
    await tab(page, "insight");
    await page.click("#rpAI");
    await expect(page.locator("#aiHint")).toContainText("勾选数据发送同意");
    expect(calls).toBe(0);
    await tab(page, "me");
    await expect(page.locator("#aiOk")).not.toBeChecked();
  });
});

import AxeBuilder from "@axe-core/playwright";
test.describe("无障碍", () => {
  async function scan(page, label) {
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    return r.violations.map((v) => label + " · " + v.id + " · " + v.nodes.length + " 处 · " + v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | "));
  }
  for (const scheme of ["light", "dark"]) {
    test("四个页面与主要弹窗没有 WCAG AA 违规（" + scheme + "）", async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await boot(page);
      await tab(page, "insight");
      await page.click("#demo");
      const out = [];
      for (const t of ["log", "insight", "care", "me"]) { await tab(page, t); out.push(...(await scan(page, t))); }
      await page.click("#helpBtn"); out.push(...(await scan(page, "求助弹窗"))); await page.keyboard.press("Escape");
      await tab(page, "log");
      await page.locator(".moods button").nth(1).click();
      await page.locator("#emos .chip", { hasText: "焦虑" }).click();
      out.push(...(await scan(page, "已选中状态")));
      expect(out).toEqual([]);
    });
  }
  test("首次同意弹窗没有 WCAG AA 违规", async ({ page }) => {
    await boot(page, { consent: false });
    expect(await scan(page, "同意弹窗")).toEqual([]);
  });

  test("标签页可用方向键切换；弹窗内 Tab 不会跑出去", async ({ page }) => {
    await boot(page);
    await page.locator("#tab-log").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#tab-insight")).toBeFocused();
    await expect(page.locator("#insight")).toBeVisible();
    await page.keyboard.press("End");
    await expect(page.locator("#me")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#log")).toBeVisible();
    expect(await page.locator("nav button[tabindex='0']").count()).toBe(1);
    await page.click("#helpBtn");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.querySelector("#support").contains(document.activeElement))).toBe(true);
    }
  });
});

test.describe("编辑、合并与多标签页", () => {
  test("编辑一条记录：覆盖原记录、保留原时间、标注已修改", async ({ page }) => {
    const errors = await boot(page);
    await page.locator(".moods button").nth(1).click();
    await page.locator("#emos .chip", { hasText: "焦虑" }).click();
    await page.fill("#note", "写错了的内容");
    await page.click("#save");
    const t0 = await page.evaluate(() => entries[0].t);
    await page.evaluate((t) => { entries[0].t = t - 3e5; entries[0].u = t - 3e5; save(); render(); }, t0);
    await page.locator(".entry").getByRole("button", { name: /^编辑/ }).click();
    await expect(page.locator("#editBar")).toBeVisible();
    await expect(page.locator("#save")).toHaveText("保存修改");
    await expect(page.locator("#note")).toHaveValue("写错了的内容");
    await expect(page.locator("#emos .chip", { hasText: "焦虑" })).toHaveAttribute("aria-pressed", "true");
    await page.locator(".moods button").nth(3).click();
    await page.locator("#emos .chip", { hasText: "焦虑" }).click();
    await page.locator("#emos .chip", { hasText: "平静" }).click();
    await page.fill("#note", "改好了的内容");
    await page.click("#save");
    const e = await page.evaluate(() => ({ n: entries.length, ...entries[0] }));
    expect(e.n).toBe(1);
    expect(e.t).toBe(t0 - 3e5);
    expect(e.u).toBeGreaterThan(e.t);
    expect([e.mood, e.emos, e.note]).toEqual([4, ["平静"], "改好了的内容"]);
    await expect(page.locator("#after h2")).toHaveText("已保存修改 ✓");
    await expect(page.locator(".entry")).toContainText("已修改");
    await expect(page.locator("#editBar")).toBeHidden();
    await expect(page.locator("#save")).toHaveText("记录这一刻");
    expect(errors).toEqual([]);
  });

  test("取消编辑会清空表单，不改动原记录", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 2, note: "原样保留" }]);
    await page.locator(".entry").getByRole("button", { name: /^编辑/ }).click();
    await page.fill("#note", "随便改改");
    await page.click("#editCancel");
    await expect(page.locator("#note")).toHaveValue("");
    await expect(page.locator("#editBar")).toBeHidden();
    expect(await page.evaluate(() => entries[0].note)).toBe("原样保留");
  });

  test("同步合并：保留最后修改的版本；删除晚于修改才算删除", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const a = [{ id: "x", t: 1, u: 10, note: "本机较新" }], b = [{ id: "x", t: 1, u: 5, note: "云端较旧" }];
      const c = [{ id: "y", t: 1, u: 5, note: "本机较旧" }], d = [{ id: "y", t: 1, u: 20, note: "云端较新" }];
      return {
        keepLocal: mergeColl(a, b, {})[0].note,
        takeRemote: mergeColl(c, d, {})[0].note,
        deletedAfterEdit: mergeColl(a, [], { x: 11 }).length,
        editedAfterDelete: mergeColl(a, [], { x: 9 }).length,
      };
    });
    expect(r).toEqual({ keepLocal: "本机较新", takeRemote: "云端较新", deletedAfterEdit: 0, editedAfterDelete: 1 });
  });

  test("删除标记只保留 180 天", async ({ page }) => {
    await boot(page);
    const keys = await page.evaluate(async () => { tomb = { old: Date.now() - 200 * 864e5, recent: Date.now() - 10 * 864e5 }; save(); await chain; return Object.keys(await Store.get("qy_tomb")); });
    expect(keys).toEqual(["recent"]);
  });

  test("两个标签页同时打开：一边保存，另一边自动更新", async ({ page, context }) => {
    await boot(page);
    const other = await context.newPage();
    await other.goto("/index.html");
    await other.waitForFunction(() => window.qyReady === true);
    await page.locator(".moods button").nth(3).click();
    await page.fill("#note", "在第一个标签页写的");
    await page.click("#save");
    await expect(other.locator(".entry")).toContainText("在第一个标签页写的");
  });
});

test.describe("自定义标签与睡眠时长", () => {
  test("添加自定义压力来源并使用；删除标签不影响过去的记录", async ({ page }) => {
    const errors = await boot(page);
    await page.locator(".moods button").nth(1).click();
    await page.locator("#trigsCustom .chip-add").click();
    await page.locator("#trigsCustom .tagin").fill("导师催进度");
    await page.locator("#trigsCustom").getByRole("button", { name: "添加" }).click();
    const chip = page.locator("#trigsCustom .chip", { hasText: "导师催进度" });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await page.click("#save");
    expect(await page.evaluate(() => entries[0].trigs)).toEqual(["导师催进度"]);
    await flush(page);
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    await expect(page.locator("#trigsCustom .chip", { hasText: "导师催进度" })).toBeVisible();
    await page.locator("#trigsCustom").getByRole("button", { name: "删除标签「导师催进度」" }).click();
    await expect(page.locator("#trigsCustom .chip", { hasText: "导师催进度" })).toHaveCount(0);
    await expect(page.locator(".entry")).toContainText("导师催进度");
    expect(errors).toEqual([]);
  });

  test("自定义标签：重复的直接选中，超过上限会提示", async ({ page }) => {
    await boot(page);
    await page.locator(".moods button").nth(1).click();
    await page.locator("#trigsCustom .chip-add").click();
    await page.locator("#trigsCustom .tagin").fill("学业/考试");
    await page.locator("#trigsCustom .tagin").press("Enter");
    await expect(page.locator("#trigs .chip", { hasText: "学业/考试" })).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => setCustom("trigs", Array.from({ length: 12 }, (_, i) => "标签" + i)));
    await page.evaluate(() => renderCustom("trigs"));
    await page.locator("#trigsCustom .chip-add").click();
    await page.locator("#trigsCustom .tagin").fill("第十三个");
    await page.locator("#trigsCustom .tagin").press("Enter");
    await expect(page.locator("#trigsCustom .tagin")).toHaveAttribute("placeholder", "每组最多 12 个");
  });

  test("记录睡眠时长；周报在样本够时对比睡得少和睡得够的日子", async ({ page }) => {
    await boot(page);
    await page.locator(".moods button").nth(2).click();
    await page.locator("#sleepChips .chip", { hasText: "6–7 小时" }).click();
    await expect(page.locator("#sleepChips .chip", { hasText: "6–7 小时" })).toHaveAttribute("aria-checked", "true");
    await page.click("#save");
    expect(await page.evaluate(() => entries[0].sleep)).toBe(6.5);
    await expect(page.locator(".entry")).toContainText("睡 6–7 小时");
    await page.evaluate(() => { entries = [[1, 4.5], [2, 5.5], [4, 7.5], [5, 8.5], [4, 7.5]].map(([m, s], i) => ({ id: "z" + i, t: Date.now() - i * 36e5, mood: m, sleep: s, emos: [], trigs: [], pos: [], note: "" })); save(); render(); });
    await tab(page, "insight");
    await expect(page.locator("#rpBody")).toContainText("睡得少的日子心情可能更低");
    await expect(page.locator("#rpBody")).toContainText("样本还少");
  });

  test("编辑时回填睡眠时长与自定义标签", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { setCustom("goods", ["晒太阳"]); renderCustom("goods"); entries = [{ id: "k", t: Date.now() - 6e5, mood: 4, emos: ["开心"], trigs: [], pos: ["晒太阳"], sleep: 7.5, note: "" }]; save(); render(); });
    await page.locator(".entry").getByRole("button", { name: /^编辑/ }).click();
    await expect(page.locator("#goodsCustom .chip", { hasText: "晒太阳" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#sleepChips .chip", { hasText: "7–8 小时" })).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("使用情况、改进计划与反馈", () => {
  test("使用情况只在本机计算；上报预览里没有任何日记内容", async ({ page }) => {
    await boot(page);
    await seed(page, [{ mood: 2, emos: ["焦虑"], trigs: ["学业/考试"], note: "非常私密的日记" }, { mood: 4, note: "另一条" }]);
    await tab(page, "me");
    await expect(page.locator("#usage")).toContainText("记录 2 条");
    const preview = await page.locator("#rsPreview").innerText();
    expect(preview).toContain("\"records_7d\": 2");
    for (const secret of ["非常私密的日记", "焦虑", "学业/考试"]) expect(preview).not.toContain(secret);
  });

  test("加入改进计划后上报一次汇总，同一天不重复；退出会删除服务器上的数据", async ({ page }) => {
    await boot(page);
    const calls = [];
    await page.route(/rest\/v1\/rpc\/(report_day|forget_install)/, async (r) => { calls.push({ fn: r.request().url().split("/").pop(), body: r.request().postDataJSON() }); await r.fulfill({ status: 204, body: "" }); });
    await seed(page, [{ mood: 3, note: "x" }]);
    await tab(page, "me");
    await page.check("#rsOn");
    await expect(page.locator("#rsMsg")).toContainText("已加入");
    await expect.poll(() => calls.length).toBe(1);
    const b = calls[0].body;
    expect(calls[0].fn).toBe("report_day");
    expect(b.p_records).toBe(1);
    expect(Object.keys(b).sort()).toEqual(["p_active", "p_day", "p_delta", "p_first", "p_install", "p_practices", "p_rated", "p_records", "p_v"]);
    await page.waitForFunction(() => !!JSON.parse(localStorage.getItem("qy_prefs")).research.last); // 等“今天已上报”记下来
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    await page.waitForTimeout(2000);
    expect(calls.length).toBe(1);
    await tab(page, "me");
    await page.click("#rsQuit");
    await page.click("#rsQuit");
    await expect(page.locator("#rsMsg")).toContainText("已退出改进计划");
    expect(calls[1]).toEqual({ fn: "forget_install", body: { p_id: b.p_install } });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("qy_prefs")).research)).toBeUndefined();
  });

  test("没加入改进计划时不会上报", async ({ page }) => {
    await boot(page);
    let called = false;
    await page.route(/rpc\/report_day/, (r) => { called = true; r.fulfill({ status: 204, body: "" }); });
    await seed(page, [{ mood: 3 }]);
    await flush(page);
    await page.reload();
    await page.waitForFunction(() => window.qyReady === true);
    await page.waitForTimeout(2000);
    expect(called).toBe(false);
  });

  test("发送意见反馈；30 秒内不能重复发送", async ({ page }) => {
    await boot(page);
    const sent = [];
    await page.route(/rest\/v1\/feedback/, async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ status: 201, body: "" }); });
    await tab(page, "me");
    await page.fill("#fbBody", "希望能导出成图片");
    await page.fill("#fbContact", "me@example.com");
    await page.click("#fbSend");
    await expect(page.locator("#fbMsg")).toHaveText("已收到，谢谢你的反馈。");
    expect(sent[0]).toMatchObject({ body: "希望能导出成图片", contact: "me@example.com" });
    await page.fill("#fbBody", "再来一条");
    await page.click("#fbSend");
    await expect(page.locator("#fbMsg")).toContainText("刚刚已经发送过了");
    expect(sent.length).toBe(1);
  });

  test("删除全部数据时一并删除改进计划的数据", async ({ page }) => {
    await boot(page);
    const calls = [];
    await page.route(/rest\/v1\/rpc\/forget_install/, async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ status: 204, body: "" }); });
    await page.evaluate(() => { const p = JSON.parse(localStorage.getItem("qy_prefs")); p.research = { on: true, id: "11111111-1111-4111-8111-111111111111", last: "" }; localStorage.setItem("qy_prefs", JSON.stringify(p)); });
    await tab(page, "me");
    await page.click("#delOpen");
    await expect(page.locator("#delList")).toContainText("改进计划上报的数据");
    await page.fill("#delConfirm", "删除");
    await page.click("#delGo");
    await expect(page.locator("#delMsg")).toContainText("改进计划数据：已删除");
    expect(calls).toEqual([{ p_id: "11111111-1111-4111-8111-111111111111" }]);
  });
});
