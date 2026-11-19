# 部署到 Linux

以下以 Ubuntu、Node.js 24、systemd 和 Nginx 为例。先将域名解析到服务器，准备好域名的 TLS 证书及续期方式。命令中的 `docs.example.com` 代表你自己的域名。

## 安装程序

确认 `/usr/bin/env node --version` 能在服务的系统 PATH 下找到 Node.js 24。安装系统工具并创建专用账号。以下命令在具有 sudo 权限的终端执行。

```sh
sudo apt-get update
sudo apt-get install -y git nginx poppler-utils util-linux
id feishu-publisher >/dev/null 2>&1 || sudo useradd --system --home-dir /opt/feishu-publisher --shell /usr/sbin/nologin feishu-publisher
sudo git clone --branch v1.1.0 https://github.com/cyccr/feishu-html.git /opt/feishu-publisher
cd /opt/feishu-publisher
sudo npm ci
sudo install -d -o feishu-publisher -g feishu-publisher /opt/feishu-publisher/work /var/www/feishu-docs
sudo touch /opt/feishu-publisher/.state.json /opt/feishu-publisher/sync.lock-runtime
sudo chown feishu-publisher:feishu-publisher /opt/feishu-publisher/.state.json /opt/feishu-publisher/sync.lock-runtime
sudo -u feishu-publisher npm test
```

首次安装时创建私密配置并填写真实参数。已有配置的服务器请直接编辑现有文件。

```sh
sudo install -m 600 -o root -g root deploy/feishu-publisher.env.example /etc/feishu-publisher.env
sudoedit /etc/feishu-publisher.env
sudo install -m 644 deploy/feishu-publisher.service deploy/feishu-publisher.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start feishu-publisher.service
sudo systemctl show feishu-publisher.service -p Result -p ExecMainStatus
readlink -f /var/www/feishu-docs/current
```

成功时应看到 `Result=success`、`ExecMainStatus=0`，且 `current/index.html` 存在。若失败，通过 `journalctl -u feishu-publisher.service -n 50 --no-pager` 检查配置、飞书读取权限、Node.js 路径及 PDF 工具。发布服务按一次性任务运行，完成后状态通常为 inactive。

需要保留电子表格颜色和格式时，为应用开通 `drive:export:readonly` 或 `docs:document:export`，并授予工作簿导出权限，在私密配置中设置 `FEISHU_SHEET_STYLES=1`。未启用该配置时继续发布单元格显示值。样式模式依赖锁文件中的 ExcelJS 4.4.0，更新源码后通过 `npm ci` 安装。

## 配置 Nginx 和定时同步

将 [Nginx 示例](deploy/nginx.conf) 中的 `docs.example.com` 替换为你的域名，并校对 `ssl_certificate` 和 `ssl_certificate_key`，确认证书已经存在。HTTP 段为证书续期保留了 ACME 验证路径。下面使用 Ubuntu 的 sites-enabled 布局。

```sh
sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/feishu-html
sudoedit /etc/nginx/sites-available/feishu-html
sudo ln -s /etc/nginx/sites-available/feishu-html /etc/nginx/sites-enabled/feishu-html
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable --now feishu-publisher.timer
systemctl list-timers feishu-publisher.timer --no-pager
```

访问首页、一篇文章及 `/sitemap.xml`，再验证图片、附件和关键词搜索。定时器每 10 分钟检查一次。导出为空、遇到未支持的独立节点或构建失败时，已有网页继续在线。常规更新会比较内容摘要，变化后才构建并切换 `current` 软链接。

## 暂停和回退

先暂停定时器，等待正在运行的发布任务结束。用 `ls -lt /var/www/feishu-docs/releases` 选择仍保留的已知正常版本，核对其 `index.html`。下面的变量请填写实际目录：

```sh
sudo systemctl stop feishu-publisher.timer
previous=/var/www/feishu-docs/releases/release-REPLACE_ME
test -f "$previous/index.html" && sudo ln -s "$previous" /var/www/feishu-docs/.current-rollback && sudo mv -Tf /var/www/feishu-docs/.current-rollback /var/www/feishu-docs/current
```

排除问题后，清空 `.state.json` 中的旧摘要以强制重建，再手动同步并核对结果，最后启用定时器。程序升级或回退应同时核对源码版本和 `package-lock.json`，并重新执行 `npm ci`。每次成功发布后默认保留最近三份静态结果。
