# feishu-html

把飞书知识库的一个子树或整个空间发布到自己的服务器。读者通过浏览器打开带正文的静态 HTML，可以查目录、搜索文章、复制代码、下载附件。服务器按计划从飞书同步，作者继续在飞书编辑。

## 先看一篇示例

安装 **Node.js 24** 和 npm，在 Windows、macOS 或 Linux 上运行以下命令。示例使用仓库自带的虚构 UART 文档。

```sh
git clone https://github.com/cyccr/feishu-html.git
cd feishu-html
npm ci
npm test
npm run preview:build
npm run preview
```

打开终端显示的本地地址，默认是 <http://localhost:4173>，进入“串口配置示例”。预览输出位于 `.preview/.vitepress/dist/`，可直接检查 HTML、搜索资源和附件。预览使用独立目录，无需配置飞书账号。

## 接入自己的知识库

1. 在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，启用机器人并发布。按使用内容申请只读权限，如 `wiki:wiki:readonly`、`docx:document:readonly`、`drive:drive:readonly`。使用电子表格或画板时，按开放平台要求添加对应读取权限。
2. 在目标知识库授予应用读取待发布内容的权限。应用拥有接口权限后，仍需获得具体空间、页面及附件的访问权。[上游接入说明](https://github.com/longbridge/feishu-pages#prepare)
3. 在 Linux 服务器填写 [环境变量模板](deploy/feishu-publisher.env.example)。首次使用建议设 `PUBLISH_SCOPE=subtree`，从一篇确定可以公开的文档开始。构建结果是公开副本，网站访客不会按飞书成员身份鉴权。仅发布由受信任作者维护、适合公开的内容。
4. 安装发布服务，手动完成首次同步，再启用定时器。[Linux 部署与回退](DEPLOYMENT.md)

| 配置 | 用途 |
| --- | --- |
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 自建应用身份，保存在服务器私密配置中 |
| `FEISHU_SPACE_ID` | 目标知识空间 ID |
| `PUBLISH_SCOPE`、`ROOT_NODE_TOKEN` | `subtree` 发布指定节点及后代，必须提供根节点标识；`space` 发布整库 |
| `SPACE_HOME_NODE_TOKEN` | 整库模式下，可选地补充单独返回的知识库首页 |
| `SITE_URL`、`SITE_NAME` | 站点公开根地址与显示名称 |
| `PUBLISH_ROOT` | 正式发布目录，默认 `/var/www/feishu-docs`；自定义时同步调整服务写入权限与 Nginx 根目录 |

## 哪些内容可以发布

| 飞书内容 | 网页效果 |
| --- | --- |
| 常用标题、列表、引用、链接、代码块 | 生成静态正文；页内目录默认显示二、三级标题。代码支持高亮与复制 |
| 普通文档表格 | 保留行列、表头和矩形合并，支持含竖线的参数说明 |
| 独立或文内嵌入的电子表格 | 发布工作表显示值，内嵌表格保留原位置。工作表的合并、图表、筛选等交互未还原 |
| 图片、附件和独立 PDF | 镜像图片与原文件。独立 PDF 生成封面和可提取的文字；扫描页没有 OCR |
| 飞书多维表格、幻灯片、思维笔记 | 可识别的文内多维表格显示提示。遇到未支持的独立节点会中止本轮发布，网站继续提供上一版 |
| 深层标题、公式和协作组件 | 七至九级标题、数学排版、评论、成员权限及协作交互尚未完整转换 |

页首 YAML 默认作为代码示例展示。若要设置页面元数据，请在首个顶层 YAML 代码块的第一行写 `# feishu-page-meta`。项目使用 Feishu Pages 获取文档块，补全工作表与独立文件，再由 VitePress 输出 HTML。文章地址采用 `/articles/节点标识.html`。

## 版本与反馈

首个公开版本为 **v1.0.0**。[版本记录](CHANGELOG.md) · [提交问题](https://github.com/cyccr/feishu-html/issues) · [MIT 许可证](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)

报告转换问题时，附上最小脱敏样例、预期与实际效果、程序版本即可。
