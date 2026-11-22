# skill-manager

**给 DSH 的 agent 装一个"挑技能"的脑子，再加一本"谁真的被用过"的账本。**

这是一个 DeepSeek Harness (DSH) 的 Host 插件。模型每次调 `skill({ name })` 之前，插件先拿**当前这条用户请求**把已装的所有技能打分：如果被请求的技明显不如另一个候选贴合，这次加载被拦下，拒绝信息里带着排行前三的候选和得分。同时它记一本账，把"每个技能到底被用了几次"变成数字。

零依赖、纯 ES 模块、无构建步骤。

[English](README.md) · [实现细节](docs/HOW-IT-WORKS.md) · [更新记录](CHANGELOG.md)

---

## 要解决什么

装了四十个技能的 profile，模型手里只有四十行一句话描述和一个 `skill({ name })` 工具。选技能靠猜，而猜错的代价是单向的：

- 选错 → 一整份说明书落进上下文窗口。真金白银，零相关。
- 不选 → 该有的规矩没读到，活儿做歪。

而且这个循环不会自己学乖：一个从来没人用的技能永远躺在目录里，看起来和那个正好能解决问题的技能一样诱人。

## 它做三件事

| 机制 | 行为 |
| --- | --- |
| **拦截** | `skill({ name })` 触发时，用当前请求给全部技能排序。被请求的技能相关度远低于最佳候选时拒绝这次加载，并给出排行前三的替代项和分数。 |
| **搜索** | 新工具 `skill_search({ query })`：按得分返回候选、命中的关键词、一句话说明，以及每个技能的历史使用率。先搜，再对第一名调 `skill`。 |
| **账本** | 新工具 `skill_usage()`：加载次数、占全部加载的比例、被拦次数、被搜索选中次数、平均相关度。落在 profile 下的 `skill-manager/usage.json`。 |

拦截在构造上就是保守的：**只有另一个技能明显更贴合时才拦**，中等贴合从不被惩罚。以下任一条直接放行：

- 请求原文里出现了这个技能名（用户点名要的）；
- 同一个技能在**同一条请求**里已经被拒过一次（不陷入拒绝循环）；
- 装的技能少于两个，或最佳候选本身分数太弱，不值得坚持；
- 模型带了 `force: true`，或该技能在 `alwaysAllow` 名单里。

## 快速上手

```bash
git clone https://github.com/aranmingzi/skill-manager.git
```

1. **装** —— DSH → 设置 → 插件 → 安装本地插件，指向 clone 下来的目录（含 `package.json` 那层）。
2. **重启 DSH** —— 工具列表里出现 `skill_search` 和 `skill_usage`。
3. **用** —— 加载技能前先让模型调 `skill_search({ query })`；`skill_usage()` 看这套 profile 到底在用哪些技能。
4. **调** —— 误拦八成是词没对上，先改 `aliases.js`，别急着动阈值。

## 安装

需要暴露 `ctx.skills` 与 `ctx.tools` 的 DSH 版本。

```bash
git clone https://github.com/aranmingzi/skill-manager.git
```

在 DSH 里打开 **设置 → 插件 → 安装本地插件**，指向 clone 下来的目录（就是含 `package.json` 和 `cordis.patch.yml` 的那一层）。插件管理器会把包装进你的 profile、加上 `skill-manager` 这一行，并显示 `enabled: true`。

重启 DSH。工具列表里应该多出 `skill_search` 和 `skill_usage`，插件列表里多出一个 *Skill Manager*。

不想点鼠标，让 agent 自己装也可以，走同一个入口：

```text
plugin_manager { action: "install_bundle", target: "<clone 目录的绝对路径>" }
```

### 确认真的生效

挑一个跟重型技能无关的活让 agent 干（比如"改一下插件的一个小参数"，而 profile 里装着前端设计技能），看它是不是还要去加载那个技能 —— 应该被拦下，并列出更合适的候选。或者直接调 `skill_usage()`，空账本也会回一行总计。

## 怎么用

**先搜再加载。** 拿不准该用哪个技能时，用你自己的话搜一遍：

```text
skill_search { "query": "设置页看着太像 AI 做的模板，改一下" }
→ 1. frontend-craft         0.82  used 14 (38%) · rel 0.79  页面太丑/去 AI 味/美化前端
  2. design-taste-frontend  0.41  used 2 (5%) · rel 0.55    anti-slop landing pages
  3. dsh-doc                0.12  used 9 (24%) · rel 0.61    DSH 插件 API 参考
```

**查账本。** `skill_usage({ limit })` 按加载次数排序，一行一个技能：

```text
skill_usage { "limit": 5 }
→ - frontend-craft 14 次 · 37.8% · 被拦 0 · 搜索胜出 6 · 相关度均值 0.79
  - dsh-doc         9 次 · 24.3% · 被拦 2 · 搜索胜出 3 · 相关度均值 0.61
  - embed           0 次 ·  0.0% · 被拦 0 · 搜索胜出 0 · 相关度均值 —
```

**逃生口。** 拒绝是带牙齿的建议，不是墙。拒绝信息里写明：真确定要那个技能，就带 `force: true` 再调一次 —— 会放行，也会照记账。

## 账本记什么

三种事件，按技能名累加：

| 事件 | 什么时候记 |
| --- | --- |
| `load` | `skill` 调用真正被放行时（含 `force`、点名、`alwaysAllow`） |
| `block` | 被路由拦下，或被 `disabled` 名单拒绝时 |
| `pick` | `skill_search` 把某个技能排在第一名时 |

派生两个数：

- **占比** `share = 该技能加载次数 / 全部加载次数` —— 这就是"使用率"，回答"我的技能里哪些其实没人用"。
- **平均相关度** —— 该技能每次被放行时和当次请求的相关度平均值。长期很低说明它被错加载，或者描述写得让人误判。

`usageHint` 打开时（默认），数字变化后往当前这一步追一条紧凑注解（`<skill_usage>` 段落，按加载次数排序，最多 12 行），结尾固定一句：**相关度仍是选技能的唯一依据，用得少不代表不该用**。使用率不进打分、不进拦截，避免"越用越容易被选中"的马太效应。

## 配置

配置写在 profile 里这个插件行的 `config:` 段；插件在 `apply()` 里就地归一化，非法值退回默认。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `block` | `off` 只保留搜索和账本，不做拦截 |
| `gapRatio` | `0.45` | 被请求技能的相关度要达到最佳候选的这个比例才放行 |
| `minTopScore` | `1.2` | 最佳候选绝对得分低于此值时一律放行 |
| `minTopHits` | `2` | 最佳候选至少命中几个不同关键词才算数 |
| `alwaysAllow` | `[]` | 永不拦截的技能名 |
| `disabled` | `[]` | 直接拒绝的技能名 |
| `searchLimit` | `5` | `skill_search` 默认返回几个候选 |
| `usageHint` | `true` | 是否把使用率注解追加到每一步 |
| `usagePath` | `''` | 账本路径；空表示 `<profile>/skill-manager/usage.json` |
| `usageKeep` | `200` | 账本最多保留多少条，超了按最近使用淘汰 |

## 调不准的时候

| 症状 | 改法 |
| --- | --- |
| 该拦的没拦 | `gapRatio` 调高（0.6）或 `minTopScore` 调低（0.8） |
| 拦错了（明明该用这个） | 把技能加进 `alwaysAllow`，或往 `aliases.js` 里补用户真实会打的词 —— 大多数误拦是"用户这么说，描述里没这个词" |
| 候选都不对 | 描述太笼统，补 `whenToUse` 比调参数有用 |
| 注解太吵 | `usageHint: false` 关掉，账本照记，`skill_usage` 照样能查 |
| 想清空历史 | 删掉 `usage.json` |

改完 `aliases.js` / 参数后重载插件生效，然后跑一遍测试 —— 里面钉着"不许弄坏"的用例。

## 成本

- 被拦的 `skill` 调用多一次技能目录读取（`ctx.skills.list`），不额外请求模型。
- 放行的调用只多一次内存打分，无 I/O。
- 账本写入是几百字节的小文件覆写，同一轮里合并。
- 使用率注解只在数字变化时追加一次。
- 每次拒绝 = 一轮多出来的模型往返。所以默认阈值偏宽松：宁可漏拦，不乱拦。

## 卸载

在 **设置 → 插件** 里移除。`skill` 工具恢复原生行为，`skill_search` / `skill_usage` 消失，账本停止记录（已存在的 `usage.json` 不删）。

## 开发

```bash
npm test          # 等价于 node test/router.test.mjs && node test/usage.test.mjs && node test/plugin.test.mjs
```

36 项检查：13 条路由夹具、12 条账本断言、11 条拿假 ctx 驱动真 `apply()` 的端到端检查。

`router.js`（打分与裁决）和 `usage.js`（账本）不 import 任何东西 —— DSH 自己的包在 harness 加载器外面解析不到，所以全部逻辑都放在零依赖模块里，普通 `node` 就能测；`index.js` 只负责把三个机制接到 DSH 的事件和工具上。

打分模型、裁决规则表、事件流见 [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)。

## 许可

[MIT](LICENSE)