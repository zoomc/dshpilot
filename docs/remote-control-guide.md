# DSHPilot 手机远程控制 · 完整使用文档

> 本文档对应「设置 → 远程控制」中的一键配置流程。读完应能在 3 分钟内让手机通过公网连上你本机的 DSHPilot 控制面。

---

## 1. 它是什么

DSHPilot 远程控制让你用手机（或任意带浏览器的设备）随时连上**本机**正在运行的 Harness 控制面：在地铁上补一句 prompt、在沙发上 approve 一个权限、出门后查看任务进度。

核心原则：**本机 Harness 进程与你系统的凭据永不离开这台电脑。** 所有跨网络的请求都经过端到端加密，中转节点（Cloudflare 隧道 / 盲中继）只能看到密文，看不到内容。

---

## 2. 工作原理

有三种连入方式，按"是否需要公网"自动区分：

### ① 局域网直连（最快、零中转）
手机与桌面在同一 WiFi 时，直接连桌面的控制面地址（`http://<电脑内网IP>:<端口>`）。
- 优点：最快、最省电、不依赖任何外部服务。
- 限制：手机必须在同一局域网。

### ② Cloudflare 免费隧道（外网，本文重点）
桌面运行 `cloudflared` 把本地控制面"打洞"成一个公网 HTTPS 地址（`https://xxxx.trycloudflare.com`），手机走 WSS 连入。
- **无需域名、无需付费、无需绑定信用卡。**
- 每次启动生成的隧道地址是随机子域名（quick tunnel），适合个人临时/日常使用。
- 所有请求端到端加密，隧道只转发密文。

### ③ 盲中继 Relay（更高可控性，需自备 Relay 服务）
通过 `RestrictedRelayTunnel` 连接一个你信任的 Relay 服务（`DSHPILOT_REMOTE_RELAY_URL` 等环境变量配置）。适合需要固定地址、团队协作、或自建 Relay 的场景。普通用户用 ② 即可，无需关心这一层。

> 一键配置走的是 **② Cloudflare 免费隧道**。它不需要你拥有域名或 Cloudflare 账号也能跑（quick tunnel 不强制登录）；但首次使用建议按下面「环境配置」完成安装与登录，体验更顺。

---

## 3. 安全与隐私

- **凭据不出本机**：Claude/DeepSeek 的 API Key、文件系统访问、shell 执行都只发生在本机 Harness 进程内。
- **端到端加密**：手机 ↔ 控制面之间的通道加密，中转方只转发密文。
- **配对码一次性**：每次「开始配置」生成的配对码有效期约 2 分钟，且绑定本机服务身份（serverId / 公钥）。过期或重配需重新生成。
- **设备授权**：配对后手机会获得 `read` / `control` 作用域的令牌；可在控制面吊销设备。
- **最小暴露面**：隧道只转发控制面流量；不开放任何额外端口到公网。

---

<a id="env-setup"></a>

## 4. 环境配置（安装 + 登录 Cloudflared）

「开始配置」按钮会先检测本机环境。若未通过，会弹窗提示你去配置；点弹窗里的按钮会跳到这里。

### 4.1 安装 cloudflared

选择你的系统：

**macOS（推荐 Homebrew）**
```bash
brew install cloudflared
```

**Linux**
```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y cloudflared
# 或下载二进制：见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

**Windows（PowerShell，管理员）**
```powershell
winget install --id Cloudflare.cloudflared
```

安装后验证：
```bash
cloudflared version
```

### 4.2 登录（可选但建议）

> Quick tunnel（`cloudflared tunnel --url ...`）**本身不强制登录**也能用。但登录后可避免部分环境限制、便于后续用命名隧道固定地址。建议执行一次。

```bash
cloudflared login
```

它会打开浏览器让你用 Cloudflare 账号授权（没有账号则顺带注册一个免费账号）。登录成功后会在 `~/.cloudflared/cert.pem` 写入证书。

「开始配置」检测的"已登录"即判断该证书是否存在。

### 4.3 常见问题
- **`command not found: cloudflared`**：安装未生效，重开终端或确认 PATH。
- **没有 Cloudflare 账号**：`cloudflared login` 过程中按提示注册免费账号即可，无需付费。
- **公司网络拦截**：若在受限网络，`cloudflared` 可能连不上 Cloudflare 边缘；换网络或改用 ③ 自建 Relay。

---

## 5. 一键配置流程（手机端配对）

在桌面端「设置 → 远程控制」：

1. 点击 **开始配置**。
2. 若环境就绪，页面进入「配置中」状态：依次执行
   `检查环境 → 获取控制面地址 → 启动 Cloudflare 隧道 → 自检连通性 → 生成配对码`。
   每一步完成会打勾，过程约几秒到十几秒。
3. 配置完成后显示**配对信息**：
   - 一段配对 JSON（含 `serverId` / 公钥 / `code` / 隧道地址 `lanEndpoint` 等）。
   - 一张二维码（即该 JSON 的可扫码形式）。
4. 在手机端打开 DSHPilot PWA → 「完成配对」：
   - 方式 A：直接**扫描**桌面上的二维码。
   - 方式 B：把配对 JSON（或其 `code`）粘贴到手机输入框。
5. 配对成功，手机即出现在已授权设备列表，可随时连入。

> 隧道地址（`*.trycloudflare.com`）是临时的：桌面 App 重启或点「停止」后会失效，需重新「开始配置」生成新地址。这是 quick tunnel 的特性，非 bug。若需固定地址，见 ③ 自建 Relay 或 Cloudflare 命名隧道。

---

## 6. 手机端操作

- **扫码配对**：手机相机/扫码进入 PWA 配对页，对准桌面二维码。
- **粘贴配对**：复制桌面「配对信息」里的 JSON，或只复制其中的 `code` 字段，粘贴到手机「完成配对」。
- **连接**：配对后手机自动/手动连接隧道地址；本机 Harness 与系统凭据全程不离开桌面。
- **断开 / 吊销**：桌面「停止」会关闭隧道；在控制面「设备」里可吊销某台手机。

---

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 点「开始配置」弹"需配置 Cloudflare" | cloudflared 未安装或未登录 | 见 [环境配置](#env-setup) |
| 隧道启动超时 | 网络无法连 Cloudflare 边缘 / cloudflared 被杀 | 检查网络；重试；换网络 |
| 自检连通性失败 | 控制面未启动或端口被占 | 确认桌面 App 正常运行；重启 App |
| 手机扫码后配对失败 | 配对码过期（约 2 分钟） | 重新点「开始配置」生成新码 |
| 手机连上但无权限 | 设备作用域不足 | 在控制面设备列表重新配对/调整作用域 |
| 隧道地址失效 | quick tunnel 临时特性 | 重新「开始配置」 |

---

## 8. 常见问题（FAQ）

**Q：一定要 Cloudflare 账号吗？**
A：用 quick tunnel 不需要；但登录体验更顺，建议登录。

**Q：要花钱吗？**
A：Cloudflare quick tunnel 免费，无需信用卡。

**Q：我的代码/文件会不会被上传？**
A：不会。只有控制面流量经加密隧道中转，Harness 进程与系统凭据始终在本机。

**Q：为什么每次地址都变？**
A：quick tunnel 的子域名是随机的（临时）。需要固定地址请用命名隧道或自建 Relay。

**Q：能多人/多手机同时连吗？**
A：可以，每台手机独立配对，各自持有令牌。

**Q：断网了手机还能用吗？**
A：不能——远程控制依赖桌面端在线且隧道存活。局域网直连同理需同 WiFi。
