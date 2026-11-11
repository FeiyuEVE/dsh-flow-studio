# 13 · 实例业务证据（0.13.12）

本分册是实例域「业务证据」语义的唯一来源：什么算 `verified`、什么不算、来源与可信级别怎么定。路由、参数与响应字段的契约在 [reference/instance-api.md](../reference/instance-api.md#证据)，本分册只解释语义与边界。

## 1 证据从哪来

证据不是新工具参数，也不进实例变量。它沿用 `flow_finish_node.documents[]` 的登记方式：节点完成时把一份文件写进工作区，用 `kind:"evidence-report"` 登记；宿主按同一套文档校验（相对路径、≤5 MiB、sha256、快照）保存引用。报告正文始终在文件里，`instance.json.artifacts[]` 只保存路径与 hash。

报告格式固定为 `flow-evidence/v1`：

```json
{
  "schema": "flow-evidence/v1",
  "executionId": "review_execution_7",
  "claims": [
    { "id": "tests", "type": "test-result", "value": "passed", "refs": [{ "path": "reports/tests.txt", "sha256": "…" }] }
  ],
  "findings": [
    { "id": "F-12", "status": "fixed", "refs": [] }
  ]
}
```

报告里的 `claims` / `findings` 是**报告自述**，不是宿主裁决。宿主只登记两件事：这份报告文件确实由某个 execution 的完成节点登记过；报告引用的文件 hash 是否与宿主保存的快照一致。

## 2 两类事实：引用核对与结论成立

证据视图把「引用已核对」和「结论成立」严格分开：

- `verifiedRefs`：引用内容的 sha256 与宿主快照一致。它只证明**内容一致**——报告引用的确实就是登记过的那份文件，不证明文件内容正确，也不证明报告结论正确。
- `claims[].value`：永远是 `source:"report-claim"`；`refsChecked` 只说明该 claim 的引用是否全部核对通过。
- `findings[].verified`：仅表示「这条 finding 的复验引用已全部核对通过」；`conclusion` 恒为 `report-claim`，`conclusionVerified` 恒为 `false`。

因此下面这些都不是 verified：

- 引用不存在、路径非法、sha256 非法；
- 引用内容与声明 hash 不一致（快照或工作区任一路径）；
- `fixed` 没有任何引用；
- `fixed` 有引用但未全部核对通过；
- 报告自述 `producer:"host"` / `authority:"host"` / `trust:"host"`；
- 报告直接把 finding 写成 `status:"verified"`（只显示 `claimed-verified`，不算核对结果）。

`fixed` 只有在**带复验引用、引用全部命中归档快照并核对通过**时才显示为 `verified`；只靠工作区回落不算复验。即使如此，`verified` 也只表示复验引用已核对，不表示「修复结论成立」。

## 3 来源与可信级别由宿主登记决定

来源不取报告自述，取宿主侧的登记事实：

- 报告必须由 `flow_finish_node.documents[]` 以 `kind:"evidence-report"` 登记，宿主才把它算作一份证据报告；
- `executionId` / `nodeId` / `attempt` 以宿主登记与 `activity/end.artifacts[]` 的关联为准；报告自称的 `executionId` 只作对照，不一致时写 `conflicts`（`report-execution-mismatch`）；
- 报告里的 `producer` / `authority` / `trust` 字段一律忽略，并记为 `dataQuality.producerSelfClaims`；报告不会因为自称 `host` 而获得宿主身份；
- 报告自报 `stub:true` / `synthetic:true` 时，`dataQuality.stub=true`，界面必须标成桩报告。桩报告可以读，但不能显示成真实质量通过。

所有 claim / finding 的 `source` 与 `trust` 都是 `report-claim`。宿主登记只决定「这份报告属于哪个 execution」，不把报告内容升级成宿主结论。

## 4 引用解析顺序

解析一条 `refs[]` 时：

1. 先按 `sha256` 查 `artifacts/<sha256>` 快照；命中且重算 hash 一致 → `resolvedFrom:"artifact-snapshot"`。
2. 快照缺失才回落到工作区相对路径；命中且 hash 一致 → `resolvedFrom:"workspace"`，并在 `dataQuality.reasons` 记 `artifact-snapshot-missing` 与 `workspace-fallback`。
3. 两处都读不到 → 进 `missing`，原因区分 `workspace-unavailable` / `workspace-unreadable`。
4. hash 不一致 → 进 `conflicts`（`ref-hash-mismatch`），且该引用不进 `verifiedRefs`。

worktree / 工作区被清理不影响已登记快照：第 1 步仍能读回正文并核对 hash；只有从未登记过快照的引用才会因为工作区消失而变成 `missing`。

## 5 缺失、冲突、来源 execution

- **缺报告** = `dataQuality.evidenceStatus:"missing"`、`unknown:true`，并有一条 `no-evidence-report` 的 `missing`。空 claims 不是「全部通过」。
- **报告不可读 / schema 不对 / 空报告** = `invalid` 或 `partial`，并写具体 `missing` 原因；不会静默丢弃。
- **缺引用**：claim 没有 refs 记 `claim-without-refs`；`fixed` 没有 refs 记 `fixed-without-verification-refs`。
- **同 ID 冲突**：同一 execution 内同 ID 不同 value / status 进 `conflicts`；同 ID 同值重复也保留一条冲突记录，不静默覆盖。
- **不同循环**：不同 execution 的证据各留各的来源，`sourceExecutions` 全部列出；同一 ID 跨 execution 出现不同 value / status 时记录跨执行分歧，但**不**套用「打回使前次通过全部失效」——两条来源都保留。

## 6 不做什么

- 不产出「优 / 良 / 差」或统一 pass / warn / fail 总评级；`dataQuality.evidenceStatus` 只有 `missing` / `invalid` / `partial` / `present` 四个事实状态。
- 不把 findings 注入实例状态、变量或 `result`。
- 不参与 admission，不因为证据缺失阻止实例启动，也不自动触发节点完成。
- `activity/end` 只负责把本 execution 的 artifacts 关联到报告；它不替报告做业务裁决，也不把「活动结束」当成「结论通过」。
- 业务希望质量影响路由时，显式写短变量，由 FEEL 条件决定；证据视图只提供可复核事实。
