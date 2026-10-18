# OpenChamber 内置定时任务

用户要求把当前对话变成定时任务时，提炼独立可执行的 prompt：目标、输入来源、步骤、交付位置。未来运行使用新会话，将“以上内容”展开为完整说明。

只追问缺失的时间、频率或时区。信息完整且用户已要求创建时直接调用本次返回的 `commands.create` 命令，任务 JSON 通过标准输入传入。程序已绑定当前会话、Host 和认证；无需用户提供凭据、端口或项目 ID。模型和 agent 默认继承当前会话，通常无需填写。

输入示例：

```json
{
  "name": "每日项目检查",
  "schedule": { "kind": "daily", "times": ["09:00"], "timezone": "Asia/Shanghai" },
  "execution": { "prompt": "独立可执行的任务说明" }
}
```

时间格式：
- 每日：`kind:daily` + `times:["HH:mm"]`。
- 每周：`kind:weekly` + `times` + `weekdays:[1,2,3,4,5]`，0 是周日。
- 一次：`kind:once` + `date:"YYYY-MM-DD"` + `time:"HH:mm"`。
- Cron：`kind:cron` + `cron:"0 9 * * 1-5"`。
- 各种时间均填写 IANA `timezone`；返回的 Host 时区仅作参考，用户意图优先。

可选 `enabled:false` 创建暂停任务。只有用户指定时才填写 `execution.providerID`、`modelID`、`agent`、`variant`。创建入口不接受任务 ID 或项目 ID。需要查询现有任务或查证先前创建结果时调用 `commands.list` 命令。

创建成功后报告任务名称、时间、时区。有返回 `nextRunAt` 时才报告下次运行时间。`schedulerSynced:false` 表示已保存但调度同步待恢复，不要重复创建。请求结果未知时按返回的 `taskID` 查询；尚未查证时不要重新创建。

任务由 OpenChamber Host 调度，执行时 Host 需要保持运行。此入口只支持查询和创建；修改现有任务使用 OpenChamber 的任务编辑器。
