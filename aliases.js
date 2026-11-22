/**
 * User vocabulary per skill: the words people actually type, folded into that
 * skill's routing document so a skill is reachable by what it does rather than
 * by how its author happened to phrase the description.
 *
 * Keys must match installed skill names exactly; unknown keys are ignored.
 * Add an entry here (or in user settings) when a skill keeps losing a match.
 */

export const ALIASES = {
  'skill-manager': ['省额度', '技能太多', '选技能', '加载技能', '技能管理器', '该用哪个技能', '别乱加载'],
  'frontend-craft': [
    '页面太丑', '美化', '样式难看', '改ui', '排版', '配色', '动效', '高级感', '去ai味',
    '模板感', '看着像ai做的', 'ui 好看', '前端好看',
  ],
  'design-taste-frontend': ['落地页', '首页设计', '品牌站', '作品集', 'redesign', '设计方向', '营销页'],
  'dsh-doc': [
    'dsh', '写插件', '安装插件', '插件', 'plugin', 'bundle', 'mcp', 'agent preset', '升级插件',
    '技能怎么用', '工具定义', '管理插件', '插件管理', '写个插件', '写一个插件', '做一个插件',
    '插件开发', '自定义工具', '自定义插件',
  ],
  'diagnose-windows-sandbox-acl': ['权限不足', '拒绝访问', '沙箱', 'acl', '写不进去', '读不到文件'],
  'ego-browser': ['浏览器', '打开网页', '截图', '填表', '登录网站', '网页自动化', '点按钮'],
  embed: ['stm32', '单片机', '嵌入式', 'freertos', 'hal', 'cubemx', '外设', 'pwm', 'adc', '串口', '点灯'],
  'qqagent-ship': ['出包', '安装包', '打包', '发版', '补丁', '升级包', '增量更新', 'qqagent'],
  hyperframes: ['视频', '渲染视频', '动画', '字幕', '片头', '剪辑', '解说视频'],
  'hyperframes-cli': ['脚手架', 'timeline', '预览', '渲染命令', '项目历史'],
  'hyperframes-registry': ['素材块', '组件库', '过渡', '转场', '模板块', 'registry'],
  'media-use': ['配乐', '音效', '素材', '配音', '调色', '抠图', '找音乐', '找图'],
  'jiangwen-screenwriting': ['姜文', '剧本', '台词', '分镜', '写戏', '短剧', '非线性结构'],
  office: ['word', 'excel', 'ppt', 'pdf', '表格', '文档', '演示', '渲染文档'],
  'office-docx': ['docx', 'word 文档', '合同', '报告文档'],
  'office-pptx': ['pptx', '幻灯片', '演示文稿', '做ppt'],
  'office-xlsx': ['xlsx', '工作簿', '单元格', '公式', '做表格'],
  'qianwen-audio-tts': ['配音', '朗读', '语音合成', 'tts', '旁白', '念出来'],
  'qianwen-image-generation': ['生图', '绘图', '文生图', '海报', '插画', '生成图片', 'wan'],
  'qianwen-vision': ['看图', '识别图片', 'ocr', '读图', '视频理解', '图里写了什么'],
  'qianwen-ops-auth': ['api key', '密钥', '鉴权', '401', 'qianwen_api_key', '认证失败'],
}