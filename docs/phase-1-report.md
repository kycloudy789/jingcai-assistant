# 阶段 1 报告：工程骨架与单用户鉴权

- 日期：2026-11-04
- 范围：阶段 0 文档基线 + 阶段 1 工程骨架、共享层、鉴权、测试
- 结论：**本地可验证部分全部通过；微信运行时部分未验证**（开发者工具未安装、CloudBase 未开通）

## 1. 交付物

| 类别 | 文件 | 说明 |
|---|---|---|
| 文档 | `docs/environment-report.md` | 环境检查、限制、用户待办 U1–U6 |
| 文档 | `docs/implementation-plan.md` | 阶段 0–7 全量计划与验收标准 |
| 文档 | `docs/decisions.md` | D1–D9 决策 + O1–O5 待决 |
| 文档 | `docs/compliance-checklist.md` | 合规闸门、待核实 C1–C6、提问模板 |
| 文档 | `docs/data-source-plan.md` | 官方来源、字段映射、状态机、兜底 |
| 前端 | `miniprogram/` | 4 tab（首页/开奖/我的号码/AI 助手）+ 设置 + 拒绝页 |
| 共享层 | `shared/` | 彩种常量、号码校验、访问控制、统一返回结构 |
| 云函数 | `cloudfunctions/authCheck/` | 单用户鉴权 + 合规开关下发 |
| 工具 | `scripts/sync-shared.js`、`scripts/check-copy.js` | 共享码同步、禁用词扫描 |
| 测试 | `tests/*.test.js` | 31 个用例 |
| 模板 | `data/samples/draws_template.csv` | 开奖导入模板（含官方公开数据样例） |

## 2. 关键实现说明

1. **鉴权 fail-closed**：白名单非空只认白名单；白名单为空回退 `OWNER_OPENID`；两者皆空一律拒绝。白名单优先于环境变量，环境变量不能绕过白名单。
2. **OpenID 只从 `cloud.getWXContext()` 读取**，云函数不接受前端传入的用户标识，避免越权。
3. **合规开关服务端判定**：`resolveCandidateGate` 要求 `wxComplianceStatus === 'approved'` 且开关为 `true`，缺一即关闭；前端仅展示。
4. **号码校验单一实现**：前后端共用 `shared/validators/numbers.js`，用同步脚本复制并有一致性单测兜底。
5. **无占位假数据**：开奖页、号码页、AI 页均为明确的空状态与阶段说明；`services/api.js` 在未鉴权时直接拒绝调用。

## 3. 测试结果（真实输出）

```
$ npm test
[sync-shared] → miniprogram\shared
[sync-shared] → cloudfunctions\authCheck\shared
[sync-shared] 完成
1..31
# tests 31
# pass 31
# fail 0
# duration_ms 659.2814
```

覆盖内容：
- 主方案 16.1 号码输入全表（数量/重复/越界/非整数/空值/非法彩种）。
- 展示格式化（两位补零、双色球 `|` 分隔）、幂等键（顺序无关、蓝球敏感）。
- 鉴权：命中/未命中/白名单优先/环境变量回退/无配置拒绝/空 openid。
- 合规闸门：`not_checked`/`pending`/`rejected`/`approved 但开关 false`/双条件满足。
- 返回结构字段与异常不泄露堆栈。
- 共享代码同步一致性（文件清单 + 逐文件哈希）。

其它检查：
```
$ node scripts/check-copy.js
文案扫描通过（36 个文件，未发现禁用词）

$ 语法检查（miniprogram/ shared/ cloudfunctions/ scripts/ tests/ 全部 .js）
全部通过

$ 密钥扫描（sk- 前缀）
无命中
```

## 4. 未验证项（不得视为已通过）

| 项 | 原因 | 何时验证 |
|---|---|---|
| 开发者工具编译、页面渲染 | 未安装开发者工具（U1） | 用户安装后 |
| `authCheck` 真实调用与白名单生效 | CloudBase 未开通（U2） | 建环境后 |
| 云端安装依赖（`wx-server-sdk`） | 同上 | 同上 |
| 小程序包内无密钥（运行时包扫描） | 需真机/预览包 | 部署后 |

## 5. 已知问题

1. `project.config.json` 使用 `touristappid` 占位，必须替换为真实 AppID 才能用云开发。
2. `app_config` 集合尚未创建，鉴权实际依赖环境变量；阶段 2 建库后应切换到白名单并移除回退（decisions.md D6 复检条件）。
3. `npm` 源不可达，`wx-server-sdk` 只能在部署时由云端安装；本地无法做云函数单测（已通过把纯逻辑抽到 `shared/` 并用 node:test 覆盖来规避）。
4. 开奖页 `queryReady=false`，阶段 2 接入 `queryDraws` 后需改为 `true`。

## 6. 下一阶段（阶段 2）计划

1. 建 `draw_records` / `draw_rules` / `sync_logs` 集合与索引（`game+issue` 唯一）。
2. 实现 `cwl_web_list` 解析器 + 解析器版本 + 样本快照测试（先离线 HTML 样本，避免联网依赖）。
3. 实现 `importDrawCsv` 脚本与 `syncDraws` / `queryDraws` 云函数。
4. 开奖列表/详情页接入真实数据，展示来源 URL、抓取时间、核验状态。
5. 用 1 个真实期次（如双色球 2026126）做端到端验证，并构造异常样本覆盖 16.5。

预估：解析器与校验 1 个工作单元，页面与云函数 1 个工作单元，测试与异常样本 1 个工作单元。
