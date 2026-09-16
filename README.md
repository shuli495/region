# 全球行政区划

全球行政区划查询服务。国内数据来自民政部，海外数据来自 GeoNames 和 OpenStreetMap。

## 数据结构

运行时使用统一行政区表，不再按国内、国外和行政层级拆表：

| 表 | 用途 |
| --- | --- |
| `region` | 父子关系和列表查询所需的核心字段 |
| `region_detail` | 经纬度、区号、时区和外部数据源字段 |
| `region_search` | 父节点范围搜索 |
| `data_version` | 当前发布的数据版本 |

建表文件：[`data/schema/region.sql`](data/schema/region.sql)

设计要点：

- `region.id` 是内部连续 `INT UNSIGNED` 主键。
- 原始行政编码保存在字符串字段 `region.code`，不会产生 JavaScript 大整数精度问题。
- 子节点查询只依赖 `(parent_id, id)` 索引。
- `region_search` 增加 `parent_id`，父节点范围搜索不访问主表。
- 旧版 SQL 保留在 `data/full`，仅作为转换源。

## 生成导入数据

转换器使用 Node.js 标准库，不需要额外依赖：

```shell
yarn data:build
```

默认读取 `data/full`，输出到被 Git 忽略的 `tmp/region-data`。每个 TSV 文件最大约 45MB：

```shell
node scripts/build-region-data.js \
  --input data/full \
  --output tmp/region-data \
  --chunk-mb 45
```

转换器会：

- 合并 12 张旧行政区表。
- 删除重复的行政区编码。
- 生成连续内部 ID，并重建 `parent_id`。
- 生成 `has_children`、搜索文本和详情数据。
- 校验所有父节点都存在。
- 输出 `manifest.json`，记录行数和分片文件。

`data/patches` 保存已核验的增量修正。转换器会自动按文件名顺序应用补丁。已部署的统一表可以事务更新：

```shell
yarn data:patch --patch data/patches/20260916.json
```

当前中国数据版本为 `2026091602`，变更范围和暂缓事项见 [`data/patches/20260916.md`](data/patches/20260916.md)。

生产发布时可以把 TSV 分片放入 Git、Git LFS、Release 或对象存储；数据库合表与文件分片互不影响。

## 导入 MySQL

先创建表：

```shell
mysql --local-infile=1 -u region_app -p region < data/schema/region.sql
```

再通过 `LOAD DATA LOCAL INFILE` 依次导入 `manifest.json` 中的文件。例如：

```shell
yarn data:load --input tmp/region-data
```

导入器只接受空表，避免误覆盖已有数据。也可以手工执行：

```sql
LOAD DATA LOCAL INFILE '/absolute/path/region-001.tsv'
INTO TABLE region
CHARACTER SET utf8mb4
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(id, parent_id, code, level_type, depth, has_children,
 name_cn, name_en, name_local, name_pinyin, name_jianpin);
```

`region-detail-*.tsv` 和 `region-search-*.tsv` 使用相同方式分别导入对应表。全量更新建议导入影子表，校验后通过 `RENAME TABLE` 原子切换。

## 查询接口

### 子节点列表

```text
GET /region?parent_id=1&size=200&after_id=0
```

不传 `parent_id` 查询根节点。分页使用 `after_id` 游标，不执行 `COUNT(*)` 和深度 `OFFSET`。

可通过 `columns` 追加字段。详情字段会按需关联 `region_detail`：

```text
GET /region?parent_id=1&columns=lat&columns=lng
```

响应：

```json
{
  "code": 200,
  "data": {
    "records": [],
    "has_more": false,
    "next_after_id": null
  }
}
```

### 搜索

父节点范围搜索：

```text
GET /region/search?parent_id=<北京的内部ID>&keyword=朝阳
```

搜索必须传 `parent_id`。接口只返回匹配的 `region_id`，不访问 `region` 主表，也不维护高成本的全局全文索引。

## 配置

数据库配置只通过环境变量注入：

```shell
export MINE_MYSQL_HOST=127.0.0.1
export MINE_MYSQL_PORT=3306
export MINE_MYSQL_DATABASE=region
export MINE_MYSQL_USER=region_app
export MINE_MYSQL_PASSWORD='replace-with-a-strong-password'
```

启动：

```shell
yarn build
yarn dev
```

测试：

```shell
yarn test:security
```

## 年度行政区划同步计划

使用 Node.js 18+。同步直接调用民政部 `GET /9095/xzqh/getList`，更新中国大陆省、地、县、乡四级，不使用旧 `version` 表、Git 拉取或 AI 生成 SQL。

### 调度与版本

- 北京时间 **每年 1 月 10 日 02:00** 启动，指定 `year=上一年`，如 2027-01-10 查询 2026 年版。
- 复用 `data_version.scope=2`，发布版本为当年 `YYYY011000`（兼容现有日期加两位序号），`checksum` 记录规范化数据的 SHA-256。请求年版单独存于任务 `source_year`。
- 每小时检查失败任务；应用启动时检查中断任务和当年到期任务。没有到期任务或版本已发布时不请求远端。
- 默认启用；设置 `REGION_VERSION_CHECK_ENABLED=false` 可关闭后台调度，手动续跑仍可用。应用需要持续运行，不能仅构建后退出。
- 多实例与现有补丁执行器共用 MySQL `region-data-patch` 命名锁，同一时间只执行一轮。

### 一轮任务的执行顺序

1. 创建 `region_sync_job` 记录。成功取得全国树后，保存根响应并动态计算分支数。当前约 452 次请求，不硬编码数量。
2. 按地级节点和省直属县级节点请求 `maxLevel=2`。串行请求，开始时间至少间隔 2 秒，单次超时 20 秒。该速率是项目策略，不是官方额度。
3. 每个成功响应和进度计数在同一个事务中写入 `region_sync_branch`、`region_sync_job`。失败后标记 `failed`，记录代码及错误；下次只获取未保存的分支。
4. 全部分支齐全后校验：大陆31个省级分支、节点类型、代码后缀、重复代码、父子层级，以及返回结构。类型不识别、结构错误会停止；合法的 `children: []` 统一视为来源未提供下级，保留本地全部后代，不继续下钻，不再维护特殊地区白名单。
5. 按层级将12位代码转换为项目的6位省市县代码、9位乡镇代码，按父子顺序新增/更新。代码相同的节点保留内部ID，维护搜索记录、深度和 `has_children`。
6. 在写业务数据前汇总本地存在但快照缺失的节点，按子树生成冲突，等待通过管理接口选择保留或删除。全部解决后再次核对指纹并应用决定，不根据名称或前缀猜测换码、合并。
7. 区划变更、`data_version` 和任务完成状态在**同一事务**提交。发布阶段中断会从已保存的快照重新应用，不重新抓取；读接口不会看到半轮数据。

### 进度与恢复

应用连接数据库后自动创建两张进度表（数据库账号需要建表权限）：

| 表 | 用途 |
| --- | --- |
| `region_sync_job` | 年版、阶段、总分支、完成数、当前代码、尝试轮数、最后错误及新增/修改/删除统计 |
| `region_sync_branch` | 按任务版本、区划代码保存成功响应；保留用于断点恢复和追溯 |

任务状态为 `fetching → applying → completed`；需人工处理时为 `conflicts`，运行错误为 `failed`。`completed/total` 是抓取进度，应用阶段为单事务，完成后提供统计，不逐条提交业务数据。不要清理失败任务的分支记录，否则会丢失断点。

配置 MySQL 环境变量后：

```shell
# 构建一次
./node_modules/.bin/tsc
# 查看进度，不抓取、不更新业务数据
yarn data:sync --status
# 手动检查到期任务，或立即恢复失败/中断任务
yarn data:sync
# 立即发起当年年版同步（即使本年度计划已发布）；已有失败任务优先续跑
yarn data:sync --now
```

HTTP 管理接口需要 `REGION_ADMIN_TOKEN`（至少32字符），使用 `Authorization: Bearer <token>`：

- `GET /version`：最近10轮任务及现有数据版本。
- `POST /version`：异步检查到期任务/恢复任务。返回接收状态，最终结果通过 GET 查询；不再接受指定旧版本切换。

网络故障自动按小时续跑。未知类型或数据结构错误需要先根据官方资料修正后续跑；本地缺失于快照的冲突通过下方冲突接口处理。期间旧版本保持可查询。已有英文、拼音、详情字段保留；新增节点这些字段为空，接口未提供的字段不推测生成。

### 范围及验证限制

港澳台下级、村/社区不由此接口同步。调用时固定 `year`，避免主动请求不同年版；文档未提供响应年版确认字段，因此无法独立证明服务端严格遵循 `year`，也无法发现只在服务端改变、且不提供历史快照的年版语义。此实现不做旧表迁移和旧数据兼容。

测试：`yarn test:security`。MySQL 集成测试需将 `MCA_TEST_SOCKET` 指向独立本地测试 MySQL（root，无密码）；测试自行创建并删除专用随机名称数据库，不使用项目数据库配置：

```shell
MCA_TEST_SOCKET=/absolute/path/to/test-mysql.sock yarn test:security
```

覆盖调度时区、残缺响应拒绝、分支续跑、发布回滚、村级保护、内部ID保留、搜索更新、版本原子发布与并发锁。

### 冲突处理接口

同步在应用业务数据前一次性分析所有“本地代码存在、远端快照缺失”的节点，按最上层缺失节点分组。即使节点没有子节点，也需要明确选择，不自动删除。冲突阶段记为 `conflicts`；定时任务不会反复执行发布，全部决定完成后才恢复。

`region_sync_job.summary` 保存冲突总数及待处理数；`region_sync_conflict` 按版本、代码保存说明、影响数量、本地节点、同名异码候选、可选方案、数据指纹、处理决定和处理时间。已不再出现的冲突记录保留用于追溯，不计入当前待办；同一冲突数据变化时清除旧决定，要求重新选择。

以下接口与版本接口共用 `Authorization: Bearer <REGION_ADMIN_TOKEN>`：

```http
GET /version/conflicts?version=2026091603
```

返回数组，每项包含 `code`、`kind`、`detail`、`fingerprint`、`resolution`、`resolved_at`。`detail.options` 提供两个方案：

- `keep_local`：保留整棵本地子树。已有节点保持本地名称、类型、隶属关系；远端新增节点正常导入。同名新代码仍是另一节点，不自动合并身份。
- `delete_local`：删除本节点及仍挂在其下的全部后代，包括村/社区、搜索和详情。远端仍存在且已迁到新父级的节点保留。该删除会进入修改日志，发布后可按下方版本回退规则恢复；调用前仍应核对影响数量。

单个或批量处理使用同一接口（每批1–1000项），`fingerprint` 原样取自查询结果：

```http
POST /version/conflicts/resolve
Content-Type: application/json

{
  "version": 2026091603,
  "resolutions": [
    {"code": "620201", "action": "keep_local", "fingerprint": "从查询结果复制的64位指纹"}
  ]
}
```

示例代码仅展示格式，使用查询结果中的实际冲突根代码。数组中可以混合保留/删除。整批验证通过才保存；不存在的冲突、重复代码、过期指纹、非法动作都会拒绝整批。相同决定可重复提交；已选方案不能静默改成相反方案。

还有未解决项时返回 `pending > 0`，业务数据与版本保持不变。最后一批解决后返回 `ready: true`、HTTP 202，并自动恢复应用；通过 `GET /version` 查询最终状态。应用前重新核对本地子树指纹，结构或名称等相关数据发生变化时撤销该条过期决定并重新进入 `conflicts`。

其他情况的处理规则：

| 情况 | 处理 |
| --- | --- |
| `children: []`、但本地有后代 | 保留本地下级，不继续下钻，不产生缺失冲突 |
| 本地有代码、远端缺失 | 生成冲突，选择保留或删除；不将缺失直接判为撤销 |
| 同名但代码不同 | 冲突详情列出同名候选；不自动当作换码或合并 |
| 同代码名称、类型、父级变化 | 按官方数据更新；位于已选择保留的子树中则保留本地 |
| 本地缺失、远端新增 | 按父子顺序新增，保留已有节点内部ID |
| 删除范围与远端保留节点重叠 | 阻止提交，不级联误删 |
| 响应错误、未知类型、重复代码、缺少分支 | 记录失败原因，不提供“强行忽略”方案 |
| 处理决定后本地数据变化 | 指纹失效，重新选择 |
| 数据库错误或更新中断 | 事务回滚，已保存的响应与有效决定继续复用 |

“同名换码后迁移村级数据/合并两个节点”不是当前两个动作的含义；需要先核实映射关系后单独修正，不能由同名推断。

## 修改日志、手动版本和回退

当前实现覆盖国内数据（`scope=2`）。新增两张表，应用启动或 `yarn data:sync --status` 自动建表：

| 表 | 用途 |
| --- | --- |
| `region_data_release` | 自动/补丁/手动版本历史，草稿/已应用/已回退状态，父版本及校验值、应用和回退时间 |
| `region_change_log` | 逐行保存 `region`、`region_detail`、`region_search` 的修改前后完整JSON；NULL表示该行不存在 |

同一次接口操作的记录共用 `operation_id`。记录与业务修改在同一事务中提交，不记录失败或回滚的修改。自动同步、`data:patch` 和下方数据修改接口均接入日志；直接在数据库执行SQL不会自动捕获。

自动同步在成功发布时直接关联新版本。同步任务的编号和最终发布版本可以不同（期间人工发布过更高版本时会自动分配新的发布号），最终版本见任务 `summary.published_version`。

**手动修改立即生效，但最初未归档到版本；创建草稿、关联操作、发布草稿后才更新当前版本号。** 为保证版本边界完整，同一时间只允许一个手动草稿；发布时必须关联全部尚未归档的修改。草稿发布不会再次执行这些已经生效的修改。

以下接口均需要 `Authorization: Bearer <REGION_ADMIN_TOKEN>`，使用新构建启动/重启服务后生效。

### 1. 通过接口修改并留痕

```http
POST /version/changes
Content-Type: application/json

{
  "action": "update",
  "id": 123,
  "fields": {"name_cn": "新名称"},
  "detail": {"lng": 120.5, "lat": 30.2},
  "reason": "按官方公告修正名称和坐标"
}
```

`id` 是项目内部ID，不是行政区划代码；示例ID仅展示格式。返回 `id`、`operation_id` 和日志条数 `changes`。

- `create`：`fields` 必须包含 `parent_id`、`code`、`name_cn`、`level_type`。ID由数据库分配。
- `update`：可修改代码、名称字段、类型、父级及详情；自动维护深度、后代深度、搜索和 `has_children`。不自动替换村级代码前缀，禁止父子循环。
- `delete`：删除一个节点；有后代时必须明确传 `"cascade": true`，才会删除整棵子树及详情/搜索记录。
- `detail` 省略时保持原样；传null表示删除详情；传对象只修改指定详情字段。

### 2. 查询修改记录

```http
GET /version/changes?unassigned=true&limit=100
GET /version/changes?version=2026091700&after_id=0&limit=100
GET /version/changes?operation_id=实际操作UUID
```

按日志ID游标分页，响应包含 `records`、`has_more`、`next_after_id`。每条有修改前后的JSON、表名、行ID、来源、原因、操作UUID和所属版本。

### 3. 创建手动版本并关联

```http
POST /version/releases
Content-Type: application/json

{"title":"人工修订行政区划","operation_ids":["实际操作UUID"]}
```

版本号自动分配，返回 `version`、`status: "draft"`。也可先只传标题建草稿，再关联操作：

```http
POST /version/releases/attach
Content-Type: application/json

{"version":2026091700,"operation_ids":["另一操作UUID"]}
```

每批最多100个操作UUID；同一操作涉及的多张表、多行记录整体关联，不能只选半次操作。已归入其他版本的记录不能抢占；相同关联可重复提交。

### 4. 发布、回退、重新应用

```http
GET /version/releases
POST /version/releases/publish
POST /version/releases/rollback
POST /version/releases/apply
```

三个POST均传 `{"version": 实际版本号}`。

- 发布：校验当前数据仍等于这些修改记录的最终状态，全部修改已关联后，更新版本指针。
- 回退：仅允许回退当前已应用版本；按日志恢复修改前的三张表及内部ID，并切回父版本。
- 重新应用：只能从对应父版本应用已回退版本；读取修改后快照恢复，不重新抓官网或再次生成SQL。
- 每次回放先检查受影响数据是否仍与预期快照一致；外部SQL修改、唯一代码冲突、缺失父节点等情况会拒绝或整笔回滚，不覆盖意外变化。
- 存在未归档操作或草稿时，自动升级和版本回退/重放都会被阻止，需先完成手动归档发布。
- 多层版本需逐层回退；已回退的年度任务不会被定时补跑自动再次发布。

旧版本未保存修改前数据，无法补造回退历史。当前数据作为基线；只有启用本机制后产生的版本支持回退和重新应用。日志和版本历史不要手工清理。`data:patch` 运行前需要先编译，且已存在历史的补丁应使用重新应用接口，不再重跑原始补丁。

自动升级的临时快照存储在数据库会话内，仅实际差异进入永久日志；人工接口只快照受影响子树和相关父节点。回放校验及写入与数据版本切换共用更新锁和事务。

换码处理增加 `replace_code` 方案：在 `/version/conflicts/resolve` 的单条决定中传 `target_code`（必须是同父级的同名接口候选）。仅目标代码尚未被其他本地节点占用时接受。发布时修改该节点代码，保留内部ID和后代原代码，并与其他变更一起记录到修改日志，支持回退/重放。不会通过替换前缀推测村级新编码。

目标被占用、跨父级同名、区县调整涉及下级重新匹配时，不能直接覆盖；这些情况需要核实后另行处理。换码决定存于 `region_sync_code_map` 并与冲突版本关联。

### 整版采用接口编号

明确选择整版接口编号优先时，可调用管理员接口 `POST /version/prefer-remote`，请求体 `{"version": 2026091603}`；或执行：

```shell
node scripts/sync-mca.js --prefer-remote --version 2026091603
```

该选择保存在 `region_sync_policy`，覆盖该任务此前逐条选择的策略。处理整版数据而非仅缺失代码：先以同父级名称和层级匹配，再采用地市/省内双向唯一名称；同父级乡镇名称后缀变化采用双向唯一匹配；最后处理同编号同父级同层级的更名。无法明确对应的节点不强行合并。

整批临时换码后再写正式代码，支持目标占用、互换和连续编号调整；原内部ID与后代关系保留，村级代码不猜测重编。接口无对应项的本地节点继续保留；如果其旧代码已经分配给接口中的另一节点，则使用 `local:内部ID:旧代码` 作为本地扩展标识，正式数字代码始终留给接口节点。扩展标识不是官方行政区划代码。

更新与修改日志、版本指针在同一事务中提交；所有原ID、代码、详情与搜索变化均可回退、重放。任务汇总提供 `code_policy`、`remapped_codes`、`local_extension_codes` 等统计。

冲突展示保留原始冲突总数（`summary.conflicts`）及待处理数（`summary.pending`）。整版接口优先发布后，冲突查询的 `target_code` 从该版本修改日志读取最终编号；即使以后回退，也不会误显示旧的逐条选择或当前实时编号。整版策略仅对选定任务版本生效，后续年度任务仍先检查冲突。
