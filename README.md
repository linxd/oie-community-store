# OIE 社区商店

面向 [Open Integration Engine](https://openintegrationengine.org) 的社区包商店，无需项目托管的基础设施。它分发**扩展**（插件、连接器、数据类型——构建好的 `.zip`，通过引擎的扩展安装器安装）和**内容**（通道、代码模板、代码模板库——XML 导出，或纯 `.js` 文件用于代码模板，通过引擎的 API 导入，无需重启）。包来自两种来源：精选的[社区目录](https://github.com/gibson9583/oie-community-catalog)——一个静态的、经 PR 审核的索引，其条目携带位于**任何** https 主机上的构建产物 URL 及其 sha256——以及直接 GitHub 仓库/组织爬取（HACS 风格：每个仓库一个 `oie.json` 清单，构建产物在 GitHub Releases 上）作为零配置的发布者入门通道。无论哪种方式，引擎都会自行下载、sha256 验证并安装一切。

## 管理员体验

Web 商店使用全宽包表格，带有可折叠的状态或类型分组、类型过滤，以及按名称、类型或状态排序。点击包会打开一个宽详情模态框，包含文档和操作按钮。标题和搜索控件保持固定，表格可滚动。颜色、字体、控件和包图标跟随管理器主题。发现、已安装、更新和设置保持为独立视图；暂存的扩展在当前视图会话中显示待重启状态。

## 截图（上一版布局）

**浏览** — 从社区目录和 GitHub 发布中发现连接器、插件、数据类型、通道和代码模板：

![浏览目录](docs/images/browse.png)

**已安装** — 跟踪已安装内容并查看可用更新（包括商店自身的更新）：

![已安装扩展及更新](docs/images/installed.png)

**设置** — 内置和自定义来源、本地屏蔽列表、测试通道以及可选的加密 GitHub 令牌：

![设置：来源、屏蔽列表、GitHub 访问](docs/images/settings.png)

## 架构

这是一个标准引擎扩展（Java 后端）配合 Web 管理器插件（React 前端），一起打包在一个扩展 zip 中。

* **引擎侧**（`src/main/java`）：一个 `ServicePlugin` 加上位于 `/api/extensions/communitystore` 的 JAX-RS Servlet。它负责所有出站通信（目录索引获取、按主题枚举 GitHub 组织、发布解析、ETag 缓存条件请求、可选的 PAT 仅发送至 GitHub 主机）、验证构建产物（内联目录 `sha256` 或 `.sha256` 伴随文件）、预检扩展 zip 并安装：扩展通过 `ExtensionController.extractExtension`（与手动安装相同的代码路径），内容通过引擎的通道/代码模板控制器。
* **Web 侧**（`webadmin/`）：一个用于 OIE Web 管理器的 React 模块，包含浏览、已安装和设置视图。浏览器从不直接与 GitHub 或构建产物主机通信，也不处理构建产物；它只调用 Servlet。

商店声明了两个自有权限（由 RBAC 等授权插件在角色编辑器的"社区商店"标题下显示）：**查看社区商店**控制目录和文档读取；**管理社区商店**控制安装、更新、内容移除和商店设置。没有授权插件时，引擎默认控制器允许所有操作，行为不变。注意：内容安装（通道、代码模板）通过引擎控制器在服务端运行，因此仅需"管理社区商店"权限即可授权——请据此授予。安装会向引擎事件日志发送服务器事件（用户、扩展、仓库、标签、校验和）；卸载从引擎自身的扩展页面完成。

Servlet 刻意交换原始 JSON 字符串而非类型化模型类。这使第三方类不会进入引擎的 XStream 序列化管道及其安全允许列表，并为前端提供干净的 JSON，而没有单元素列表转换的怪癖。

## 构建

需要 JDK 17+、Maven 和 OIE 安装（或已构建的引擎树）进行编译：

```
OIE_HOME=/path/to/oie mvn package
```

构建编译 jar，构建 Web 前端（通过 `frontend-maven-plugin` 使用 esbuild 将 `webadmin/web/plugin.jsx` 编译为 `plugin.js`），并在 `target/communitystore-<version>.zip` 组装可安装的扩展，布局如下：

```
communitystore/
├── plugin.xml
├── communitystore-shared.jar
└── webadmin/
    ├── plugin.json
    └── web/plugin.js
```

`plugin.xml` 中的 `mirthVersion` 必须匹配您的引擎版本（逗号分隔的值可被引擎兼容性检查接受）。

## 验证

将 `OIE_HOME` 指向引擎发行版或 `server/setup` 树：

```sh
mvn package
scripts/test-engine-api.sh
npm --prefix webadmin test
```

Maven 运行内容指纹、操作守卫和 ZIP 预检回归测试。引擎 API 检查使用受控控制器 I/O 测试实际安装服务和引擎 XML 序列化器，包括同意令牌往返、过期编辑、原生写入监视器、复制保留、校验和/预检拒绝和扩展暂存。它们不启动引擎或数据库。Web 测试渲染真实的 React 组件并点击其控件。构建和发布工作流都运行这些检查，包括 Swing markdown 测试。

内容更新现在需要目录中用户审核条目的 `mode: "upgrade"` 和 `expectedContentHash`。已修改或遗留/未跟踪的内容还需要明确的 `overwrite: true`。服务器在下载后比较令牌，并在验证和变更期间保持原生控制器写入监视器。缺失/过期的令牌默认拒绝；旧客户端必须刷新/重新加载以使用新的确认契约。默认 `install` 仅创建不存在的内容；已安装的通道必须使用 `copy`。

指纹格式 2 保留代码文本并对模板元数据和库成员关系进行哈希处理。旧的账本哈希被视为未知的本地更改，直到经明确确认的替换建立新基线。扩展 ZIP 必须恰好包含一个与目录 ID 匹配的包根；每个根描述符必须匹配 ID 和提供的版本。嵌套/重复描述符、路径别名、超大描述符和过多解压内容会被拒绝。

多步引擎内容写入仍然不提供数据库回滚或复制的重试幂等性。写入后的数据库/API 失败可能需要手动恢复；控制器监视器防止并发编辑，而非部分存储失败。

## 持续集成与发布

两个 GitHub Actions 工作流无需本地 OIE 安装即可构建扩展——它们下载已发布的 OIE 发行版并将 `OIE_HOME` 指向其 `server-lib` jar：

* **`build.yml`** 在每次推送和 PR 上运行：编译 jar、构建前端、运行 Web 插件测试，并上传扩展 zip 作为构建产物。
* **`release.yml`** 在 semver 标签（`v*`）上运行：将标签版本写入 pom、`plugin.xml`（`pluginVersion`）和 `webadmin/plugin.json`，验证 `oie.json` 匹配，构建并发布 `communitystore-<version>.zip` 及其 `.sha256` 伴随文件。

提供编译时 jar 的 OIE 版本通过每个工作流顶部的 `OIE_TAG` / `OIE_TARBALL` 环境变量固定；当您构建所依赖的引擎 API 变更时更新它们。

发布新版本：将 `oie.json` 中的 `version` 设为新值（与 pom 保持同步），提交，然后 `git tag vX.Y.Z && git push origin vX.Y.Z`。将版本写入 `plugin.xml` 很重要——引擎将其报告为*已安装*版本，因此如果它落后于 `oie.json`，商店会显示永久的自更新。

## 安装

在任一管理器的扩展中安装 `communitystore-<version>.zip`，重启引擎，社区商店将出现在 Web 管理器导航中。Web 侧由引擎提供服务（`/api/webplugins/communitystore/...`），因此它跟随其安装的引擎。

商店列在社区目录中，因此它是**自更新的**：一旦有更新的发布版本，商店会在"已安装"标签页中标记其为可用更新（并使用与其他扩展相同的验证流程进行安装）。

## 来源

商店读取三种来源；内置默认值位于 `src/main/resources/sources.json`，通过向本仓库提交 PR 更新：

```json
{
    "schemaVersion": 1,
    "sources": [
        { "kind": "catalog", "url": "https://raw.githubusercontent.com/gibson9583/oie-community-catalog/main/index.json" },
        { "kind": "org", "org": "OpenIntegrationEngine", "topic": "oie-plugin" }
    ],
    "blocklist": []
}
```

* **`catalog` — 主要分发渠道。** 一个预构建的 `index.json`（参见[社区目录](https://github.com/gibson9583/oie-community-catalog)），每次同步使用一个条件请求获取。每个包条目携带绝对 `installerUrl` 加上构建产物的 `sha256`，因此构建产物可以位于**任何** https 主机（GitHub Releases、GitLab、S3、普通 Web 服务器），索引本身可以镜像到任何地方——此来源类型完全与平台无关。目录索引还可以携带屏蔽列表，适用于所有来源的每次同步，因此撤除在一个同步 TTL 内传播。
* **`repo` / `org` — 零基础设施发布者入门通道。** 这些实时爬取 GitHub 发布：`repo` 指向一个仓库；`org` 包含 GitHub 组织**或个人用户**下所有携带该主题（默认 `oie-plugin`）的公共仓库。给仓库打标签，创建发布，出现在商店中——无需注册表变更。

当两个来源定义相同的包 id 时，**优先者胜出**（内置优先于自定义，目录优先于爬取的仓库），因此仓库无法抢占目录已定义的 id。管理员可以在运行时的设置中添加自定义来源和本地屏蔽列表条目；这些持久化在引擎上。内置屏蔽列表始终适用。配置的 GitHub 令牌仅发送至 GitHub 系列主机——从不发送至第三方目录或构建产物主机。

## 发布者契约

> **发布扩展？** 请参阅完整的**[发布指南](docs/PUBLISHING.md)**
> 了解逐步演练、[`oie.json` 架构](docs/oie.schema.json)和
> 可复制粘贴的[示例](examples/)（清单、商店文档和 GitHub Actions 发布
> 工作流）。以下摘要是简要的契约说明。

已列出的仓库必须提供：

1. **仓库根目录的 `oie.json`**，在发布标签处读取，因此元数据按版本区分：

```json
{
    "schemaVersion": 1,
    "id": "sqs-connector",
    "name": "SQS Source Connector",
    "description": "Consume messages from Amazon SQS queues as a channel source.",
    "type": "connector",
    "version": "1.4.0",
    "minEngineVersion": "4.5.0",
    "maxEngineVersion": null,
    "filename": "sqs-connector-{version}.zip",
    "restartRequired": true,
    "homepage": "https://github.com/acme-health/oie-sqs-connector",
    "documentation": "https://github.com/acme-health/oie-sqs-connector/wiki",
    "license": "MPL-2.0",
    "authors": ["Acme Health Integration Team"],
    "keywords": ["aws", "sqs", "queue", "source"],
    "storeDocs": "docs/store.md",
    "deprecated": false
}
```

`id` 必须等于扩展 `plugin.xml` 的 `path` 属性；商店拒绝不匹配的构建产物，匹配关系是将商店记录与引擎已安装清单关联以进行更新检测的关键。`version` 必须等于发布标签（取掉前导 `v`）。`type` 为 `connector`、`plugin`、`datatype`、`code-template-library`、`channel` 之一。`filename` 可选；默认规则是发布中的单个 `.zip` 资产，支持 `{version}` 替换。

2. **商店文档（可选）。** 详情视图渲染发布者 markdown，在发布标签处读取，因此文档与版本绑定。解析顺序：清单的 `storeDocs` 路径，然后 `store.md`、`docs/store.md` 和 `README.md`。相对链接在标签处解析到仓库；相对光栅图片（png/jpg/gif/webp）在服务端获取并内联为 data URL，使其在管理器的 CSP 下渲染而浏览器不接触 GitHub。markdown 中的原始 HTML 被转义，链接协议被允许列表限制，因此发布者文档无法脚本化管理器会话。

3. **带 semver 标签的 GitHub Releases。** 每个发布附带扩展 `.zip` 加上 `<asset>.zip.sha256` 伴随文件（纯十六进制、`sha256sum` 输出或 BSD 格式均可解析）。缺失或不匹配的校验和会在触及扩展目录之前中止安装。

发布解析为最新兼容版本：商店从新到旧遍历发布，提供第一个 `minEngineVersion`/`maxEngineVersion` 窗口包含运行引擎版本的发布。除非在设置中启用了测试通道，预发布会被跳过。

## 安全说明

* 构建产物在安装前在服务端根据发布的 sha256 进行验证。这证明了传输完整性，而非发布者身份；伴随文件来自同一发布。社区商店自身的发布 JAR 使用 SSL.com 代码签名证书签名，但商店安装不对下载的包强制执行发布者签名。
* 安装确认明确声明社区内容未经 OIE 项目审核。安装扩展会在引擎中运行其代码；信任模型与手动扩展安装完全相同。
* 可选的 GitHub PAT 通过引擎的配置加密器加密存储，从不返回给浏览器（仅写入设置）。它仅附加到 GitHub 系列主机——从不发送至第三方目录或构建产物主机。
* 预检拒绝包含路径遍历条目和描述符/id 不匹配的 zip。
* 发布者文档通过消毒的 markdown 管道渲染：原始 HTML 被转义而非直通，仅允许 http、https、mailto 和片段链接目标。文档缓存在引擎侧，上限为 512 KB。
* 当两个来源定义相同的包 id 时，优先来源胜出（内置目录优先于爬取的仓库），因此仓库无法抢占目录定义的 id。
* **撤销：** 商店维护安装记录。如果已安装的包后来从所有配置来源中被移除或屏蔽，"已安装"标签页会用红色标记它（"已从来源移除"/"被来源屏蔽"），并指示管理员从扩展页面卸载它，而非包在继续运行时悄悄从视图中消失。当任何来源同步失败时，标记被隐藏，因此故障不会被误读为撤除。

## 当前限制

* 插件之间无依赖解析。
* 扩展的更新检测依赖 `id` 匹配扩展路径和版本可比较的 semver。已安装的内容是用户拥有的快照：代码模板和库提供就地升级（带有警告和在本地副本已修改时的作为副本安装选项），而通道是快照画廊——导入一次，之后作为单独副本安装，从通道视图删除（商店从不删除通道）。
* 从 GitHub 爬取（而非目录）解析的内容仅通过 TLS 验证，除非清单提供了校验和；目录包始终经过 sha256 验证。
* 包安装期间不强制执行发布者签名验证；商店目前检查已发布的 sha256 摘要。

## 许可证

MPL-2.0，与引擎一致。

### 社区统计

目录来源每小时发布可选的仓库星标和所有版本安装下载总量。Web 表格和详情直接从目录读取两者；浏览不会按引擎或包发起 GitHub 统计请求。缺失的统计显示 `—`，真正的零显示 `0`，过期的值标注其上次成功时间戳。详情显示两个指标的新鲜度。

下载总量涵盖保留的非草稿 GitHub 发布中匹配的 installer ZIP，包括预发布。它们排除无关资产、校验和、已删除发布和不支持的历史命名。星标属于仓库，因此共享仓库的包共享计数。两个指标都不衡量已安装用户数。旧版下载端点返回目录条目的已发布统计；直接 repo/org 来源保留现有缓存查找以供旧客户端使用。
