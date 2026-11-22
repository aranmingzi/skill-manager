/**
 * Routing fixtures and expectations. Run with: node test/router.test.mjs
 * Plain node cannot resolve @deepseek-ai/*, which is why only router.js
 * (dependency-free) is exercised here.
 */

import assert from 'node:assert/strict'

import { ALIASES } from '../aliases.js'
import { buildIndex, decide, rank, splitTriggers, tokenize } from '../router.js'

const SKILLS = [
  {
    name: 'dsh-doc',
    description:
      'Use when a task needs facts about DeepSeek Harness (DSH) itself, or when the user asks to design, review, build, install, enable, or debug a DSH plugin, bundle, MCP connection, agent preset, tool definition or skill.',
  },
  {
    name: 'skill-manager',
    description:
      '每次开工前重新挑技能，别让用不上的技能白吃额度。用于用户说「省额度」「技能太多」「别乱加载技能」「重新选技能」时。「DO NOT TRIGGER when：用户已经点名要某个技能、任务明显只对应一个技能、或只是闲聊不需要工具。」',
  },
  {
    name: 'frontend-craft',
    description:
      '把前端做得好看、且不像 AI 生成的模板货。用于用户说「页面太丑」「优化一下 UI」「美化前端」「去 AI 味」「看着像 AI 做的」「太模板了」「排版难看」「配色不舒服」「加个动效」「改成高级感」时。DO NOT TRIGGER when：只要功能不要样式、纯后端、只调一个颜色值。',
  },
  {
    name: 'design-taste-frontend',
    description:
      'Anti-slop frontend skill for landing pages, portfolios, and redesigns. Reads the brief, infers the right design direction, ships interfaces that do not look templated.',
  },
  {
    name: 'embed',
    description:
      '嵌入式开发辅助技能：为 STM32 等单片机生成完整可编译的 C 代码，支持裸机 SPL、SPL + FreeRTOS、裸机 HAL、HAL + FreeRTOS。当用户提到 STM32、单片机、嵌入式、标准库、HAL、CubeMX、FreeRTOS、任务/队列/信号量、外设驱动、点灯、串口收发、PWM、ADC 采样时使用。',
  },
  {
    name: 'qqagent-ship',
    description:
      'QQ Agent 改完功能或修完 bug 之后，30 秒出一个 2MB 补丁安装包，让已经装过的机器双击就升级。用于用户说「快速更新安装包」「出个包」「发版」「打个补丁」「增量更新」时。DO NOT TRIGGER when：首次装机、要便携 zip、只改 docs 不发版。',
  },
  {
    name: 'hyperframes',
    description:
      'Read first to make, edit, animate or render any video with HyperFrames (HTML rendered to video), including launch films, explainers, music videos, charts, vertical clips, title cards, captions and overlays.',
  },
  {
    name: 'qianwen-image-generation',
    description:
      'Generate and edit images using Wan and Qwen Image models. TRIGGER when the user wants illustrations, product images, posters, text-to-image generation, or style transfer. DO NOT TRIGGER when the user wants speech recognition, video generation, or text-only answers.',
  },
  {
    name: 'qianwen-vision',
    description:
      'Understand images and videos with Qwen vision models. TRIGGER when the user wants to analyze or describe images, OCR text extraction, chart reading, screenshot understanding. DO NOT TRIGGER when the user wants to generate or create images, generate videos, or text-only tasks.',
  },
  {
    name: 'office',
    description:
      'Create or edit Office files; inspect Office files and PDFs. Load before rendering, conversion, or recalculation to enable office_render, office_convert and office_recalculate. 处理 word、excel、ppt、pdf、表格、文档时使用。',
  },
  {
    name: 'jiangwen-screenwriting',
    description:
      '姜文式剧本架构与写戏方法。当用户说「姜文风格」「仿写剧本」「非线性结构」「台词写不出味道」「剧本像流水账」时使用。',
  },
]

const index = buildIndex(SKILLS, ALIASES)

const CASES = [
  {
    name: 'plugin request must not pull the frontend skill',
    query: '现在skill调用有问题呀，有时候用不到这个skill就会调用，写一个管理skill的插件',
    requested: 'frontend-craft',
    allow: false,
    bestIs: 'dsh-doc',
  },
  {
    name: 'plugin request allows the DSH doc skill',
    query: '现在skill调用有问题呀，写一个管理skill的插件',
    requested: 'dsh-doc',
    allow: true,
  },
  {
    name: 'ugly page allows the frontend skill',
    query: '这个页面太丑了，配色和排版都难受，帮我美化一下',
    requested: 'frontend-craft',
    allow: true,
  },
  {
    name: 'ugly page blocks the spreadsheet skill',
    query: '这个页面太丑了，配色和排版都难受，帮我美化一下',
    requested: 'office',
    allow: false,
    bestIs: 'frontend-craft',
  },
  {
    name: 'stm32 uart allows embed',
    query: '帮我写个 STM32 串口收发，用标准库，别用 HAL',
    requested: 'embed',
    allow: true,
  },
  {
    name: 'stm32 uart blocks the video skill',
    query: '帮我写个 STM32 串口收发，用标准库，别用 HAL',
    requested: 'hyperframes',
    allow: false,
    bestIs: 'embed',
  },
  {
    name: 'captions for a clip allows hyperframes',
    query: '给这段视频加上字幕和片头',
    requested: 'hyperframes',
    allow: true,
  },
  {
    name: 'installer request allows qqagent-ship',
    query: '改完了，出个补丁安装包给已经装过的机器',
    requested: 'qqagent-ship',
    allow: true,
  },
  {
    name: 'installer request blocks the writing skill',
    query: '改完了，出个补丁安装包给已经装过的机器',
    requested: 'jiangwen-screenwriting',
    allow: false,
    bestIs: 'qqagent-ship',
  },
  {
    name: 'naming a skill in the request always allows it',
    query: '用 frontend-craft 这个技能把界面重做一遍',
    requested: 'frontend-craft',
    allow: true,
  },
  {
    name: 'vague request never blocks',
    query: '嗯，先看看再说',
    requested: 'hyperframes',
    allow: true,
  },
  {
    name: 'generating an image must not load the vision skill',
    query: '生成一张产品海报图片，风格干净一点',
    requested: 'qianwen-vision',
    allow: false,
    bestIs: 'qianwen-image-generation',
  },
  {
    name: 'describing an image allows the vision skill',
    query: '这张截图里写了什么字，帮我把表格读出来',
    requested: 'qianwen-vision',
    allow: true,
  },
]

let failed = 0
for (const testCase of CASES) {
  const verdict = decide(index, testCase.query, testCase.requested, {})
  const best = verdict.alternatives[0]
  const problems = []
  if (verdict.allow !== testCase.allow) problems.push(`allow=${verdict.allow} expected ${testCase.allow} (rule=${verdict.rule})`)
  if (testCase.bestIs !== undefined && best?.name !== testCase.bestIs) {
    problems.push(`best=${best?.name} expected ${testCase.bestIs}`)
  }
  const requestedRow = verdict.requested
  const detail = `req=${requestedRow ? `${requestedRow.coverage.toFixed(3)}/s${requestedRow.score.toFixed(2)}` : 'n/a'}`
    + ` best=${best ? `${best.name}:${best.coverage.toFixed(3)}/s${best.score.toFixed(2)}` : 'n/a'}`
  if (problems.length === 0) {
    console.log(`ok   ${testCase.name}  [${detail}]`)
  } else {
    failed += 1
    console.log(`FAIL ${testCase.name}  [${detail}]`)
    for (const problem of problems) console.log(`     ${problem}`)
  }
}

// Tokenizer sanity: bigrams must bridge Chinese without a dictionary.
assert.ok(tokenize('写一个插件').includes('插件'), 'expected the 插件 bigram')
assert.ok(splitTriggers('用于 A。DO NOT TRIGGER when：B').negative.includes('TRIGGER'))
assert.ok(splitTriggers('只有正面描述').negative === '')

const rows = rank(index, '帮我美化一下页面，去掉 AI 味', { limit: 3 })
assert.equal(rows[0].name, 'frontend-craft', 'frontend-craft must win the styling query')

console.log('')
console.log(`fixtures: ${CASES.length}, failed: ${failed}`)
if (failed > 0) process.exitCode = 1