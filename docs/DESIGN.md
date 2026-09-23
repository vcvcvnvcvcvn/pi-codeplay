# Codeplay 设计文档（Agent 侧）

> v0.1.0 · [github.com/vcvcvnvcvcvn/pi-codeplay](https://github.com/vcvcvnvcvcvn/pi-codeplay)

Codeplay 是 pi 的扩展：agent 通过一组 `dag_*` 工具维护一张有向无环图（DAG），用户在浏览器实时观看。**DAG 是人与 agent 之间的中间沟通媒介**——可表达任务进度、项目架构、依赖关系、数据流。本文讲它的数据结构和工具设计。

## 1. DAG 数据结构

```typescript
type NodeStatus = "pending" | "active" | "done";   // 未开始 / 进行中 / 已完成

interface DagNode {
  id: string;          // 短 ID：n1、n2…
  name: string;        // 名称
  brief: string;       // 一句话简介
  files: string[];     // 囊括的文件
  status: NodeStatus;
}

interface DagEdge {
  id: string;          // 短 ID：e1、e2…
  source: string;      // 出节点
  target: string;      // 入节点
  note: string;        // 备注（"依赖"、"数据流"…）
}

interface DagMessage { id: string; text: string; ts: number }  // 公告栏消息（≤50 条）

interface DagGraph { nodes: DagNode[]; edges: DagEdge[]; messages: DagMessage[] }
```

**三条核心约束**（工具层强制）：
1. **无环**——加边/改边时 DFS 检测，保证永远是可分层布局的 DAG
2. **短 ID**——`n1`/`e1`/`m1` 递增分配最小号；LLM 全程高频引用，每处省 ~30 token
3. **按目录持久化**——真相存于 `<cwd>/.codeplay/graph.json`；浏览器面板（hub）只是展示缓存

同步模型：工具调用 → 文件锁队列串行化（pi 工具默认并行）→ 落盘 → fire-and-forget 推送 hub → SSE 广播。**面板同步永不阻塞 agent**。

## 2. 工具集（9 个，四类）

| 类别 | 工具 | 语义 |
|---|---|---|
| **查询** | `dag_view` | 紧凑文本看全图（状态用 ○▶✓，files 只给数量） |
| **节点** | `dag_add_node` / `dag_update_node` / `dag_remove_node` | 增 / 改（name·brief·status·files 单字段更新）/ 删（级联删边） |
| **边** | `dag_add_edge` / `dag_update_edge` / `dag_remove_edge` | 增（拒成环/自环/悬空）/ 改（source·target·note）/ 删 |
| **播报与管理** | `dag_announce` / `dag_clear` | 阶段性消息推到公告栏 / 清空整块画布（需 confirm） |

**设计取向**：
- **(id, field, value) 单字段更新**——比整对象 partial 更新 schema 更短、意图更明确、模型更不容易误伤其他字段
- **值一律用字符串承载**——files 传逗号分隔、status 接受中英文别名（进行中→active）——对各家模型兼容性最好
- **错误以文本返回**（`Error: node n9 not found`）而非抛异常，模型读完可自行纠正
- 破坏性操作（`dag_clear`）强制 `confirm: true`

## 3. System prompt 注入

经 `before_agent_start` 写入结构化 section（pi 做增量 diff，不冲刷前缀缓存）。四条行为约定：

1. **增量生长**：图随工作进展逐步添加/更新，不许开局画全
2. **粒度自适应**：简单任务画细（让用户看到持续推进），难任务画粗（先大阶段，需要再细分）
3. **状态同步**：开工标 active、完成标 done、文件挂节点
4. **事前播报**：加模块前、跑测试前必须 `dag_announce`；完成一步/关键决策/遇阻也发——宁可频繁短消息，不许闷头干完

## 4. 期望工作流

```
接任务 → 建当前节点(active) → [加模块/测试前播报] → 完成标 done、挂 files
       → 长出下游节点 → …… → 全部 done → 播报总结
```

一句话原则贯穿始终：**图是沟通媒介，不是交付物**——保持准确简洁，但绝不为画图拖延编码。
