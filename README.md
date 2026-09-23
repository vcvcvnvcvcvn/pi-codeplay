# Codeplay — pi 的 DAG 可视化插件

通过有向无环图（DAG）在人与 agent 之间建立一个可视化的沟通媒介：agent 在编码的同时维护一张图（任务计划 / 项目架构 / 依赖 / 数据流），用户通过浏览器面板实时查看进度与结构。

## 组成

- `index.ts` — pi 扩展：注册 9 个 `dag_*` 工具、注入 system prompt、作为 hub 客户端推送状态
- `hub.mjs` — 独立 hub 守护进程：**独占一个端口（默认 7700）**，托管所有项目的画布与 SSE
- `public/` — 前端面板（Cytoscape.js + dagre 自动布局，无构建步骤，vendor 已本地化）
- 图数据按 **pi 启动目录** 持久化在 `<cwd>/.codeplay/graph.json`（hub 不存数据，会话才是数据源）——同一目录的多个会话共享一块画布；建议在各自项目目录里启动 pi，同目录开新项目时用 `dag_clear` 重置

## 安装

作为 pi 包安装（推荐）：

```bash
# 从 GitHub 安装（全局）
pi install git:github.com/vcvcvnvcvcvn/pi-codeplay
# 或指定版本 tag
pi install git:github.com/vcvcvnvcvcvn/pi-codeplay@v0.1.0
# 只装到某个项目
pi install -l git:github.com/vcvcvnvcvcvn/pi-codeplay
```

安装后启动任意会话即自动生效；`/dag` 命令随时打开画布。卸载：`pi remove git:github.com/vcvcvnvcvcvn/pi-codeplay`。

本地开发调试：

```bash
git clone <repo> && cd pi-codeplay
npm install
mkdir -p ~/.pi/agent/extensions && ln -s "$PWD/index.ts" ~/.pi/agent/extensions/codeplay.ts
# 改代码后在会话里 /reload 热重载；不开发时删掉该软链，避免和包安装重复加载
```

## 使用

- 会话启动后自动把图状态推给 hub（hub 没在跑则由第一个会话自动拉起，detached）；**第一次调用任意 `dag_*` 工具时**才自动打开浏览器面板（`/reload` 后复用已有标签页，不重复开）
- `/dag` 命令：随时手动打开本项目的画布
- 前端交互：点节点看简介与囊括文件，点边看备注；结构变化自动重新布局，状态变化只更新颜色；SSE 断线自动降级为轮询
- 顶栏显示项目名（**就是 pi 启动目录的文件夹名**，不可改）；浏览器标签页标题同步
- 顶栏「公告」按钮展开公告栏：agent 通过 `dag_announce` 推送的阶段性进度消息逐条展示，未读数显示为角标（已读状态记在浏览器 localStorage）

## 多项目并行（单端口架构）

**只有一个进程占用端口**：hub 守护进程（7700）。pi 会话本身不监听任何端口，只作为客户端向 hub 推送状态（每次变更 + 5 秒心跳）。

```
http://127.0.0.1:7700/                项目索引（所有进行中的项目，3 秒自动刷新）
http://127.0.0.1:7700/tetris/         项目 tetris 的画布
http://127.0.0.1:7700/codeplay-dag/   项目 codeplay-dag 的画布
```

- 画布 slug 由文件夹名 slug 化而来（非 ASCII 名回退为 `project`/`project-2`…）；冲突自动加后缀（`game`、`game-2`）
- 会话正常退出立即从索引消失；进程被杀（心跳停止）15 秒后自动摘除——不会有残留卡片
- hub 空闲 5 分钟（零项目）自动退出；下次会话需要时重新拉起
- 环境变量：`CODEPLAY_HUB_PORT`（默认 7700）、`CODEPLAY_HUB_TTL`（默认 15000ms）、`CODEPLAY_HUB_IDLE_EXIT`（默认 300000ms）

## 工具（LLM 调用）

| 工具 | 参数 | 说明 |
|---|---|---|
| `dag_view` | — | 以紧凑文本查看整体图 |
| `dag_announce` | message | 推送阶段性进度消息到画布公告栏（保留最近 50 条） |
| `dag_clear` | confirm=true | 清空整块画布（节点/边/消息）；同一目录开新项目时用 |
| `dag_add_node` | name, brief?, files?, status? | 新增节点，返回短 ID（n1…） |
| `dag_update_node` | id, field, value | 单字段更新；field ∈ name/brief/status/files |
| `dag_remove_node` | id | 删除节点并级联删除相关边 |
| `dag_add_edge` | source, target, note? | 新增有向边（拒绝成环/自环） |
| `dag_update_edge` | id, field, value | 单字段更新；field ∈ source/target/note |
| `dag_remove_edge` | id | 删除边 |

- 节点状态：`pending`（未开始）/ `active`（进行中）/ `done`（已完成），工具同时接受中文别名
- ID 均为短形式（`n1`、`e1`），节省上下文
- `files` 字段用逗号分隔传值，前端展示为文件清单

## 开发

```bash
npm install
npm run check                # 类型检查
node test/smoke.mjs          # 冒烟测试（mock pi + 真实 hub：工具/API/SSE/持久化/重命名）
node test/symlink-jiti.mjs   # 回归：pi 真实加载路径（jiti + 全局软链）
node test/multi-project.mjs  # 多实例：slug 冲突、下线消失、TTL 清除、slug 复用
node test/demo-server.mjs    # 本地演示数据（配合浏览器查看效果）
```

## 已知取舍（v1）

1. **图状态按项目存文件，不随会话分支回溯**——浏览器面板需要稳定数据源；如后续需要分支级一致性，可改为把状态放进 tool result details（参考 pi 的 todo 示例）。
2. **前端只读**——编辑全部经由 agent 工具完成，这是“图作为人机沟通媒介”定位的有意选择；后续可加人的反向编辑通道。
3. 同一项目目录被多个 pi 会话同时打开时，它们共享同一个 slug 与图文件，最后写入者胜出（无跨进程锁）。
4. 会话被 `kill -9` 时画布最多残留一个 TTL（15 秒）；hub 被杀后由下一次推送自动重启，但 hub 重启会丢失未持久化的展示状态（图数据本无损，在各项目的 graph.json 里）。
