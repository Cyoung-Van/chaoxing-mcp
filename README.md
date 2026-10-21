# chaoxing-mcp

通过本机 Chrome 的登录会话，查询超星学习通的课程、作业、考试、活动与学习进度。项目同时提供 MCP 服务和 JSON CLI，适合把课程待办交给支持 MCP 的客户端整理，也可以在终端中直接使用。

当前版本：**0.2.0**。需要 **Node.js 22 或更新版本**及本机 Chrome / Chromium。

这是一个独立的非官方项目，与超星没有隶属或合作关系。程序面向用户本人有权访问的课程信息；登录与验证码由用户在浏览器中完成。

## 功能与边界

- 查询课程，汇总作业、考试、活动和任务引擎中的任务包及学习计划。
- 查询平台可提供的任务点、积分、排名、AI 练习和小组任务统计。
- 将刷新结果保存在本地快照中，查询待办、进度与采集覆盖情况。
- 按明确请求打开任务或说明页，保留浏览器中的人工操作入口。

程序不会自动答题、开始考试、提交作业、签到、播放课程或解验证码。为读取课程列表或统计数据，程序可能切换课程页签；这不代表完成了对应学习任务。

**快照完整性有明确范围。** `coverage.complete` 仅表示本次选定课程、选定模块中已实现的数据源均读取成功，不保证平台上不存在其他任务入口。筛选后的刷新会替换旧快照，不能把它当作全账户历史数据的合并结果。未知状态仍会出现在待办中；读取失败、无法识别页面或无法继续的分页均不能解释为“没有任务”。

任务引擎的非空任务包与学习计划目前依据功能契约及合成数据测试实现，**尚不能据此宣称已经通过真实账户的非空任务验证**。具体检查方式见 [测试与验证](docs/TESTING.md)。

## 快速开始

```sh
git clone https://github.com/Cyoung-Van/chaoxing-mcp.git
cd chaoxing-mcp
npm ci
npm run browser
```

在启动的独立浏览器窗口中手动登录学习通，再执行：

```sh
npm run doctor
node src/cli.mjs courses
npm run sync -- --course "示例课程" --max-courses 1 --sections assignments,exams
node src/cli.mjs todo
node src/cli.mjs coverage
```

将“示例课程”替换为课程列表中的名称或能唯一匹配它的名称片段。先用一门课程和少量模块确认结果，再按需扩大范围；不带筛选的 `npm run sync` 会刷新全部可选课程与默认模块。

`doctor` 会连接浏览器并检查课程响应，`courses` 实时读取课程目录。首次查询待办前请执行刷新；`tasks`、`todo`、`progress` 和 `coverage` 查询已保存的快照，应同时查看采集时间与范围。单独查询课程目录不会刷新任务快照。

默认数据目录为 `.local/state/`，浏览器配置目录为 `.local/browser/`；`.local/` 已列入 Git 忽略规则。保留浏览器配置目录可以复用登录会话。关闭程序不会代替你退出平台账户。

## CLI

CLI 将 JSON 结果写入标准输出，刷新进度写入标准错误。`courses` 实时查询平台，`tasks`、`todo`、`progress` 和 `coverage` 读取最近的本地快照；`sync` 刷新快照。可用命令如下：

| 命令 | 用途 |
| --- | --- |
| `doctor` | 检查 CDP 连接及平台课程响应 |
| `courses` | 实时查询当前登录账户的课程列表 |
| `sync` | 刷新本地快照 |
| `tasks` | 查询快照中的任务 |
| `todo` | 查询待处理及状态未知的任务 |
| `progress` | 查询快照中的学习统计 |
| `coverage` | 检查快照范围、失败来源和截断情况 |
| `open` | 按明确请求打开任务入口 |
| `settings` | 查看或调整本地设置 |

```sh
node src/cli.mjs --help
node src/cli.mjs sync --course "示例课程" --sections assignments,exams --max-courses 2 --verify-course-lists
node src/cli.mjs todo --kind assignment --limit 20
node src/cli.mjs tasks --status unknown --offset 0 --limit 20
node src/cli.mjs coverage --all --offset 0 --limit 20
node src/cli.mjs open --id TASK_ID
node src/cli.mjs settings --delay 1800
```

将 `TASK_ID` 替换为查询结果中的任务 `id`。`todo` 展示待处理、尚未开始、进行中及状态未知的任务；已结束或已过期的任务可用 `tasks` 查询，它们不会因此被标记为本人完成。

命令名之后的参数须使用对应选项，例如 `sync --course "示例课程"`。CLI 会拒绝 `sync "示例课程"` 这样的多余位置参数，并返回 `INVALID_INPUT`，避免课程筛选被遗漏。

任务查询还支持 `--due-hours`。这个筛选只包含具有可解析截止时间且在指定时间上界之前的任务，因此可能包含逾期项，不包含截止时间未知的项；同时检查返回的 `unknownDeadlineCount`，必要时取消时间筛选。分页默认每页 50 条，最多 200 条，按返回的 `nextOffset` 读取后续结果。

`settings` 支持在同一次调用中重复传入 `--ignore-course ID:CLASS`、`--ignore-task ID`，以及用 `--clear-ignored` 清空两类忽略项。传入的列表会替换同类旧列表。`ID:CLASS` 指课程 ID 与班级 ID 的组合，不能只凭课程名称构造。查询任务时可用 `--include-ignored` 包含快照中已被忽略的项；未采集的课程仍需调整设置后重新刷新。

`sync` 还支持 `--no-detail-deadlines`，用于跳过补查截止时间；默认仅允许读取识别出的考试说明元数据页，不访问答题或开始入口。CLI 退出码为：`0` 成功，`1` 错误，`2` 刷新得到部分结果。更改采集选项后需要重新刷新，旧快照不会自动变成新范围的数据。

## 接入 MCP 客户端

在支持本地 stdio MCP 服务的客户端中添加以下配置。**将示例中的 `/ABSOLUTE/PATH/chaoxing-mcp` 全部替换为实际克隆目录的绝对路径**；不要把相对路径交给工作目录不确定的客户端。

```json
{
  "mcpServers": {
    "chaoxing": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/chaoxing-mcp/src/mcp.mjs"],
      "env": {
        "CHAOXING_CDP_URL": "http://127.0.0.1:9444",
        "CHAOXING_DATA_DIR": "/ABSOLUTE/PATH/chaoxing-mcp/.local/state"
      }
    }
  }
}
```

也可使用 `npm run mcp` 从终端启动服务。客户端必须能够找到 `node`；如果桌面客户端没有继承终端的 PATH，请将 `command` 改为本机 Node.js 可执行文件的绝对路径。

可用工具如下：

| MCP 工具 | 用途 |
| --- | --- |
| `chaoxing_doctor` | 环境与连接诊断 |
| `chaoxing_courses` | 实时查询平台课程目录 |
| `chaoxing_refresh` | 启动异步刷新，返回 `jobId` |
| `chaoxing_job` | 根据 `jobId` 查询任务状态 |
| `chaoxing_tasks` | 查询缓存任务或待办，支持筛选和分页 |
| `chaoxing_progress` | 查询缓存学习统计 |
| `chaoxing_coverage` | 查询采集范围与来源检查结果 |
| `chaoxing_settings` | 查看或调整忽略项与请求间隔 |
| `chaoxing_open_task` | 根据任务 `id` 打开入口 |

MCP 刷新采用异步任务。例如，调用 `chaoxing_refresh` 时传入 `{"course":"示例课程","sections":["assignments","exams"],"maxCourses":1}`，然后把返回的 `jobId` 传给 `chaoxing_job`。请将课程名替换为自己的课程。任务状态为 `running` 时继续适度轮询；到达 `completed`、`partial` 或 `failed` 后检查结果，再读取快照。

启动成功只表示任务已接受，不表示采集已经完成。发生验证拦截或登录失效时，应检查终止原因及保存的部分结果；若本次没有产生新快照，不应把旧快照误作本次成功结果。任务状态只保存在当前 MCP 进程中，服务重启后无法用旧 `jobId` 恢复轮询；本地快照可继续查询。轮询任务状态不会使缺失的数据自动补齐。

刷新正在运行时，再次刷新或执行实时诊断、课程查询、任务打开操作会返回 `BUSY`。此时仍可轮询任务状态，以及查询已有快照中的任务、进度和覆盖情况；缓存查询返回的可能是上一轮结果。等待刷新结束后，再执行需要浏览器的操作。

`chaoxing_refresh` 还支持 `verifyCourseLists` 和 `resolveDeadlines`。`chaoxing_tasks` 可使用 `course`、`kind`、`status`、`dueHours`、`includeIgnored`、`offset` 和 `limit` 筛选；待办查询使用 `status: "todo"`，默认分页为 `offset: 0`、`limit: 50`。客户端应结合总量与分页结果继续读取，不能只凭第一页判断任务总数。`chaoxing_coverage` 默认只列失败检查，传入 `failedOnly: false` 可查看全部检查。

适合交给客户端的请求示例：

> 刷新课程信息，等待刷新任务结束，再列出当前快照中的待办；请同时说明采集时间、课程范围以及未能读取的来源。

> 查看学习进度，将平台没有返回的指标标记为未知，不要补成零。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `CHAOXING_CDP_URL` | 连接已有浏览器的 CDP 地址，默认 `http://127.0.0.1:9444` |
| `CHAOXING_DATA_DIR` | 本地快照与设置的保存目录，默认 `.local/state/` |
| `CHAOXING_PROFILE_DIR` | 启动浏览器时使用的独立用户配置目录，默认 `.local/browser/` |
| `CHROME_PATH` | 手动指定 Chrome / Chromium 可执行文件路径 |
| `CHAOXING_CDP_PORT` | 浏览器启动脚本使用的本地调试端口；应与连接地址一致 |

请求串行执行，默认间隔为 1500 毫秒，设置范围为 1500–30000 毫秒。请使用本地设置调整节奏，避免频繁重复刷新。自定义数据目录或浏览器目录如果位于仓库中，应自行确认它们也受到 Git 忽略规则保护。

CDP 仅用于本机回环地址。不要将调试端口暴露到局域网或公网；能够连接该端口的程序可能操作已登录的浏览器会话。

## 登录、验证码与部分结果

遇到登录失效或平台验证页面时，采集会停止，并保留已取得的部分结果。请在浏览器中手动完成登录或验证，再重新发起刷新；不要把反复重试当作验证码处理方式。

常见诊断码包括：

| 诊断码 | 含义与下一步 |
| --- | --- |
| `CDP_UNAVAILABLE` | 无法连接浏览器；检查浏览器是否启动及地址、端口是否一致 |
| `AUTH_REQUIRED` | 会话需要登录；在浏览器中手动登录后重新刷新 |
| `CHALLENGE` | 遇到验证；在浏览器中人工处理后重新刷新 |
| `PAGE_UNRECOGNIZED` | 页面结构未能识别；保留为采集失败，不按空列表处理 |
| `BAD_RESPONSE` | 来源返回了异常结果；查看覆盖报告定位来源 |
| `NOT_AVAILABLE` | 当前数据或入口不可用 |
| `BUSY` | 已有实时操作占用浏览器；刷新期间可继续轮询任务状态和查询已有缓存 |

平台改版、不同学校的配置、课程权限、接口变化和分页形式都可能影响可用性。考试已结束不等于本人已完成，活动已结束也不等于本人已参与。截止时间缺少足够信息时保持未知；日期只有年月日时，不擅自补成当天某一时刻。

## 隐私与本地数据

请求通过浏览器现有登录会话发出，程序不接收密码，也不将 Cookie 导出到 Node.js 或独立 Cookie 文件。浏览器自身仍会在用户配置目录中保存登录资料。

本地快照可能包含课程名称、作业标题、成绩相关统计，以及带签名或访问参数的任务链接。MCP 客户端接收到的查询结果也可能被其使用的模型或服务处理；请按客户端的数据政策决定是否连接。

不要提交或公开 `.local/`、自定义数据目录、浏览器配置目录、真实账户导出、原始响应、截图或未经脱敏的诊断信息。报告问题时优先提供错误码、复现步骤与自行构造的最小示例，移除账号标识、课程信息及链接查询参数。

## 开发与许可

```sh
npm test
npm run check
```

测试说明见 [docs/TESTING.md](docs/TESTING.md)，实现来源与证据边界见 [docs/PROVENANCE.md](docs/PROVENANCE.md)，模块接口见 [实现契约](docs/IMPLEMENTATION_CONTRACT.md)。

本仓库原创代码以 [MIT License](LICENSE) 发布。第三方依赖保留各自的许可证；MIT 许可不授予平台服务、商标、账户或课程内容的使用权。
