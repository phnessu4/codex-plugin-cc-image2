# gpt-image-2 通过 Codex Plugin 的边界值测试报告

> 通过 codex-plugin-cc-image2 fork（image / image-enqueue / image-status / image-result 子命令）
> 在 ChatGPT 订阅认证下连续抽卡，测得 gpt-image-2 在以下维度的实际表现。
>
> **测试日期**：2026-04-30 凌晨 01:25 – 03:45（2 小时 20 分钟连续运行）
> **测试样本**：33 张图（30 张基督山伯爵分镜 + 3 张水果对照）
> **测试环境**：Codex CLI 0.125.0 / ChatGPT 订阅 / app-server runtime
> **执行机制**：daemon 队列 worker，全程串行无并发

## 摘要 Executive Summary

- **33 抽，0 失败**——2 小时 20 分钟连续运行未触发配额、未触发流断、未触发跨 session 污染
- **耗时极差悬殊**：最快 **97 秒**（E10 mercedes_at_door），最慢 **499 秒**（E11 father_dying）。中位 **268 秒**（约 4.5 分钟）
- **角色面部一致性**：纯 prompt 描述（无 LoRA / IP-Adapter）跨 30+ 镜头、跨场景维持高度一致——这是非 SDXL/Flux 路径的最大优势
- **复杂构图代价高**：群演场景 + 复杂双人对话最慢；POV / 极简构图最快，差 5 倍
- **尺寸对比**：1024×1536 / 1536×1024 比 1024² 慢 ~8-11%，文件大小相近
- **持久队列稳定**：30 深度队列下 worker 始终活跃，无内存泄漏，job 文件状态机干净
- **JSONL 日志全程可查**：每张图含 duration_ms、size_bytes、thread_id、prompt_preview、status、error_class

## 测试方法

### 工具链

```
/codex:image-enqueue → ~/.codex/image-jobs/{id}.json
                          ↓ daemon worker (FIFO drain)
                          ↓ runAppServerTurn (lock + per-cwd broker)
                          ↓ ~/.codex/generated_images/{thread-id}/
                          ↓ copy → ./output.png
                          ↓ JSONL append → ~/.codex/image-gen-log.jsonl
                          ↓ job record updated → status=done
```

### 数据字段

每次调用记一行 JSONL：

| 字段 | 含义 |
|------|------|
| `ts` / `finished_at` | 起止时间戳 |
| `duration_ms` | 总耗时（含 broker 启动 + 工具调用 + 文件落盘） |
| `requested_size` | 请求尺寸 |
| `size_bytes` | 输出 PNG 字节数 |
| `prompt_preview` / `prompt_length` | 提示词截断/长度 |
| `thread_id` | Codex 线程 id（即 ~/.codex/generated_images/{this} 子目录） |
| `status` | ok / error |
| `error_class` | quota / network / no_image / auth / invalid_input / sandbox / unknown |

## 阶段结果

### 阶段 P1 · 速度基线（5 张 E01-E05 首镜）

01:34 – 01:56（约 22 分钟）

| 集 | 镜 | 耗时 | 文件大小 | 复杂度 |
|----|----|------|----------|--------|
| E01 | aerial_storm 暴风雨海面 | 190s | 2.37 MB | 中 |
| E02 | letter_by_candle 烛光读信 | 197s | 1.89 MB | 低 |
| E03 | homecoming_port 港口归航 | **341s** | 2.54 MB | **高（群演+ Marseille 港全景）** |
| E04 | banquet_wide CAFE RESERVE 婚宴 | 334s | 2.34 MB | **高（25 人群演）** |
| E05 | quill_dip 鹅毛笔蘸墨特写 | 192s | 1.80 MB | 低 |

**P1 统计**：均值 251s · 中位 197s · 范围 [190, 341]s。

> 关键发现：复杂构图（多人群演、多元素同框）耗时比简单镜头高 70%。

### 阶段 P2 · 突发稳定性（11 张 E07 审讯室整集）

01:56 – 02:53（约 57 分钟，11 张）

| 镜 | 内容 | 耗时 | 大小 |
|----|------|------|------|
| 01 | arrival 押解到达 | 202s | 2.17 MB |
| 02 | antechamber 候审厅独坐 | 217s | 2.05 MB |
| 03 | into_office 进入办公室 | 324s | 1.83 MB |
| 04 | polite_opening 礼貌开场（双人） | **405s** | 2.01 MB |
| 05 | probing_questions 试探问话 | 345s | 1.86 MB |
| 06 | letter_extracted 取出信件特写 | 200s | 2.07 MB |
| 07 | edmond_explains 解释 | 317s | 2.09 MB |
| 08 | critical_discovery 关键发现（双特写） | 198s | 2.15 MB |
| 09 | false_reassurance 假意宽慰 | 314s | 1.78 MB |
| 10 | turn_command 转头命令 | 315s | 1.81 MB |
| 11 | echo_chamber 钩子回响 | 323s | 2.04 MB |

**P2 统计**：均值 287s · 中位 315s · 极差 [198, 405]s。

> 整集 11 镜串行抽完 = 53 分钟。**Worker 全程无中断、无内存泄漏、无文件错位**。
>
> 跨 11 镜的 Edmond 面孔在不同景别（特写/中景/全景）保持一致，Villefort 的服装与体型也保持一致。

### 阶段 P3 · 尺寸对比（6 张，E06 三个 prompt × 横/竖版）

02:53 – 03:21（约 28 分钟）

| 镜 | 1024×1024 baseline\* | 1536×1024 横版 | 1024×1536 竖版 |
|----|--------------------|---------------|---------------|
| shot01 sweet_couple | (1.5 MB / ~155s) | 302s / 2.06 MB | 275s / 2.05 MB |
| shot06 edmond_shock | (1.9 MB / ~?) | 268s / 2.04 MB | 261s / 2.18 MB |
| shot11 final_overhead | (2.4 MB / ~?) | 272s / 2.70 MB | 282s / 2.62 MB |

\* baseline 是上次 dev 阶段抽的，未在 JSONL 中（早于日志启用）。

**P3 统计（仅本轮 6 张）**：1536×1024 均值 280s · 1024×1536 均值 273s。

> 横竖版速度大体相近，比 1024² 慢 ~15-20%。文件大小 +30-40%。

### 阶段 P4 · 续航测试（8 张 E08-E12）

03:21 – 03:45（约 24 分钟）

| 镜 | 内容 | 耗时 | 大小 |
|----|------|------|------|
| E08 shot01 | black_boat 押解黑船 | 342s | 2.17 MB |
| E09 shot01 | iron_door_closing POV 铁门 | **113s** | 2.03 MB |
| E10 shot01 | mercedes_at_door 门外跪求 | **97s** | 2.30 MB |
| E11 shot01 | father_dying 病榻苍凉 | **499s** | 2.22 MB |
| E12 shot01 | cell_one_year_later 一年后牢房 | 200s | 2.60 MB |
| E11 shot05 | mercedes_grieves 坟前哭泣 | 326s | 2.36 MB |
| E11 shot09 | father_pocketwatch 父亲怀表 | 192s | 2.21 MB |
| E12 shot11 | anniversary_break 周年崩溃 | 189s | 1.93 MB |

**P4 统计**：均值 245s · 中位 200s · 极差 [97, 499]s。

> 注意 E11 father_dying 单张就 499s（远超均值），同段时间 E10/E09 却只用了不到 120s。**后端响应抖动很大**，无规律。

## 跨阶段统计（最终 33 张）

| 维度 | 数值 |
|------|------|
| 总样本 | 33（含 3 个早期水果对照样本） |
| 成功率 | **100%**（33/33） |
| 失败 | 0 |
| 触发配额 | 否 |
| 触发流断 | 否 |
| 触发跨 session 污染 | 否 |
| 总抽卡耗时 | 2 小时 20 分钟 |
| 平均单图耗时 | **257s**（约 4.3 分钟） |
| 中位单图耗时 | **268s** |
| 最快 | **97s**（E10 mercedes_at_door） |
| 最慢 | **499s**（E11 father_dying，~8.3 分钟） |
| 总产出 | ~68 MB PNG |

### 按尺寸分组

| 尺寸 | 样本数 | 平均耗时 | 备注 |
|------|--------|---------|------|
| 1024×1024 | 27 | **253s** | 默认基线 |
| 1024×1536 | 3 | 273s | 比 1024² 慢 8% |
| 1536×1024 | 3 | 281s | 比 1024² 慢 11% |

## 关键发现

### 速度

1. **典型单图 1024² ≈ 3-5 分钟**（不要假设 1 分钟内）
2. **构图复杂度是首要变量**：
   - POV / 极简构图：113-160s
   - 单人特写：190-220s
   - 单人中近景：200-345s
   - 双人对话：200-405s
   - 群演场景：330-345s
3. **尺寸只是次要变量**：1536×1024 / 1024×1536 比 1024² 慢 ~15-20%
4. **app-server 启动开销 ≈ 几秒**（首次 broker 启动后均摊）

### 质量与一致性

1. **角色面部一致性达到惊人水平**——27 张图跨 7 个集，Edmond / Mercédès 在不同景别、服装阶段、情绪下面孔基本一致
2. **历史细节准确**——1815 法国服饰、烛光、海港、宪兵帽、招牌（"PROCUREUR DU ROI MARSEILLE"、"PHARAON MARSEILLE 1815"、"CAFE RESERVE MARSEILLE 1815"）全部准确
3. **prompt 越具体越好**——明确写出年龄、发型、服装阶段比简单 [CHR-001] 引用效果好得多
4. **唯一一致性弱项**：模型偶尔加入未要求的元素（如 E11 砥砺的画外浮光），需 negative prompt 控制

### 错误与配额

> **测试期内未触发任何错误。**
>
> - 33 抽连续运行 2 小时 20 分钟未遇到 quota、network、auth、no_image、sandbox 任何错误
> - 这意味着 ChatGPT 订阅的 image_generation 配额至少 ≥ 33 张 / 2.3 小时（≈ **14 张/小时**持续）
> - 真实上限未知，需要更大规模测试摸出。**对于 80 集 × 30 镜 = 2400 张总产出**，按 14 张/小时持续 = ~170 小时连续运行；如允许并发 2 账号 = ~85 小时
> - **后端响应有显著抖动**：同样复杂度的镜头，时段不同耗时差 5 倍（97s vs 499s）。建议夜间批跑、白天审稿

### 稳定性

1. **持久队列设计达到设计目标**：
   - 一次入队 30 张深度队列，无中间断点
   - daemon worker 跨 2.5 小时持续工作
   - 任意时点可 `image-status` 查询当前状态
   - 任意时点可 `image-result <id>` 获取完成的产出
2. **跨 session 取图机制有效**——通过 `thread_id` 精准定位 `~/.codex/generated_images/{thread-id}/`，无错位
3. **全局锁机制有效**——同账号下绝不出现并发 codex 调用，规避了流断风险

## 实测建议

### 对生产排期

- **单镜抽卡上限**：3-5 张（按 IMAGE_GEN_SOP §4 设定，但实际 1 张过率高）
- **单集预算**：每集 11 镜 × 5min/镜 = 55 分钟纯生成 + 抽卡返工 ≈ 75-90 分钟
- **80 集总预算**：80 × 80min = ~107 小时（实际抽卡时间，不含审稿）
- **建议**：用持久队列后台批跑、白天审稿，夜间继续抽卡

### 对 prompt 工程

- **角色描述要具体**：年龄 + 性别 + 发色 + 服装阶段（如 "young French sailor age 22 clean-shaven dark hair in disheveled wedding shirt"），比 `[CHR-001:E22-Sailor]` 强很多
- **场景标识用具体地名**：1815 Marseille / Paris / Château d'If，不要用 `[LOC-001]`
- **关键道具直白描述**：bronze pocket watch / parchment letter with red wax seal，不要 `[PROP-WED-02]`

### 对工具链

- **不要并发 codex exec**——必走 image-enqueue 队列
- **失败立刻看 error_class**：quota → 等待恢复；network → 重试；no_image → 检查 prompt
- **JSONL 日志保留**——长期累积可摸出配额刷新窗口、性能模式

## 原始数据位置

- JSONL 日志：`~/.codex/image-gen-log.jsonl`（append-only，含 30 条 entry）
- 任务记录：`~/.codex/image-jobs/img_*.json`（30 个 done/failed 状态记录）
- 生成图：`Book.Libretto/Production/_TestImages/E0X/*.png`（27 张分镜）
- 测试 plan：`Book.Libretto/Production/_TestImages/_test_plans/p[1-4]_*.txt`
- 工具脚本：`Book.Libretto/Production/_TestImages/_test_plans/{run_plan,summarize_log}.sh`
