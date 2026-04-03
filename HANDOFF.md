# Autonomous 314 前端重构与国际化交接说明

## 1. 已完成的工作 (Completed Work)

*   **UI 视觉重构 (Design Revamp)**:
    *   应用了全新的深色玻璃拟态 (Glassmorphism) 主题，替换了之前的后台控制台风格。
    *   新增了 Home（主页）和 Creator Dashboard（创建者面板）等路由和界面。
    *   首页增加了协议宣言卡片（Manifesto Cards）、核心数据指示条、合约搜索栏以及美化的“发射市场”列表。
    *   创建页面 (Create) 更新了 0314, b314, taxed, f314 的介绍文案排版样式。
*   **国际化 (i18n) 基础架构落地**:
    *   在 `apps/web/src/i18n.ts` 中实现了完整的双语（中/英）字典支持。
    *   顶部导航栏实现了 `中文/EN` 切换功能，状态持久化在 LocalStorage。
    *   修复了描述文案的用语问题，例如参考四姐 (four.meme) 等主流平台的习惯，将市场模式描述更准确地翻译为：“314 内盘交易 · 毕业前代币不可转账 · 卖出冷却 1 区块”。
*   **Indexer API 扩展**:
    *   在 `apps/indexer/src/server.ts` 中新增了 `/api/metadata` 的 `POST` 和 `GET` 接口。
    *   支持前端在本地预览测试时，直接将元数据 JSON 上传并保存在本地 `metadata/` 目录下（而不是必须要依赖 IPFS），极大方便了本地开发和流程跑通。
*   **部分组件字典替换**:
    *   Header、Footer、Home 主页、Creator Dashboard 创建者面板、以及 Claims & Permissions（领取代币/费用的面板）中的硬编码英文均已替换为了 `t(...)` 国际化调用。
*   **合约验证**:
    *   目前 71 个合约测试依旧全部通过。前端 TS 严格校验和 Vite 构建也已跑通。

---

## 2. 遗留任务 / Codex 的下一步工作 (Next Steps for Codex)

在目前的 `apps/web/src/App.tsx` 中，虽然 `i18n.ts` 已经包含了几乎**所有**界面的中英文字典配置，但**还有很多表单和组件里的硬编码英文尚未被替换为 `t(...)`**。你（Codex）需要接手并将替换跑完。

### 🚨 待替换的重点区域 (Areas to Replace Hardcoded English):

1.  **Launch 详情页工作台 (Launch Workspace / Token Details)**:
    *   交易面板 (Trade Panel): 例如 `Preview Buy`, `Execute Buy`, `Slippage`, `Buy amount` 等。
    *   白名单面板 (Whitelist Panel): 例如 `Commit Whitelist Seat`, `Claim Whitelist Allocation`, `Claim Refund` 等。
    *   数据属性列表 (Attributes list): 例如 `Graduation Target`, `Current Price`, `Graduation Progress`。
    *   状态提示 (States): `Bonding314`, `DEXOnly`, 警告信息等。
2.  **创建流程 (Create Form)**:
    *   代币主体信息 (Launch Identity): `Token Name`, `Symbol`, `Description`, `Atomic Buy Amount` 等输入框标签。
    *   社交链接 (Media & Socials): `Website`, `Telegram`, `Discord`, `Image URL`。
    *   税率及白名单配置区 (Tax & Whitelist Config)。
    *   左侧的 Factory 面板信息 (`Load Factory`, `Recent launches`) 等。

### 💡 提示与说明

*   **请先阅读 `apps/web/src/i18n.ts`**: 里面已经备好了供以上遗留部分使用的全部键值对（例如 `t('claimAllocation')`, `t('contractSearchPlaceholder')`, `t('metadataUriLabel')` 等），你只需把 `App.tsx` 里写死的字符串替换为 `t('对应的key')` 即可。
*   **检查遗漏**: 正如你在留言中建议的，在每一轮替换后，在本地起 `vite` 快速检查一次，特别是一些冷门模式（比如 白名单领取按扭、退款按钮、不同模式的手续费文本）是否被正确替换，是否有排版因为长中文文本而挤压。
*   **模式卡片的显示**: 创建界面的 “接下来 (Coming next)” 已经是动态根据工厂部署情况变动的了，不需要修代码，只需重新部署带有相应组件的 V2 Factory 即可变成 Live 状态。

你可以直接请 Codex 读取 `App.tsx` 的 1400 行 ～ 2200 行附近，集中清理剩余的硬编码文本。
