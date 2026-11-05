# ArtPet Windows 发布

发行目标为 Windows 10／11 x64。安装版面向日常使用，便携版面向免安装使用；两者包含 Electron 运行环境。程序版本由根目录 `package.json` 维护。

## 本地打包

使用 Windows x64、Node.js 22.12.0 或更新版本及 npm。CI 使用 `.node-version` 指定的 Node.js 22 系列。首次安装与打包需要下载 npm 依赖、Electron 和 NSIS 工具。

```powershell
npm ci --include=dev --include=optional
npm run package:win
```

| 命令 | 用途 |
| --- | --- |
| `npm run package:win` | 同时生成安装版和便携版 |
| `npm run package:win:installer` | 只生成安装版 |
| `npm run package:win:portable` | 只生成便携版 |
| `npm run release:check` | 检查发布元数据和所需文件，不打包 |
| `npm run release:check -- v1.0.0` | 额外检查指定标签与项目版本一致 |

打包前检查名称、版本、锁文件和必需资源；构建失败时返回非零状态并保留 electron-builder 错误。脚本只清理本次目标的旧 EXE 和校验文件，不递归删除输出目录。

以 `1.0.0` 为例，发行文件是：

```text
release/1.0.0/
  ArtPet-1.0.0-win-x64-setup.exe
  ArtPet-1.0.0-win-x64-portable.exe
  SHA256SUMS.txt
```

`SHA256SUMS.txt` 只列出本次命令生成的发行包。完整发布应执行 `package:win`；`win-unpacked`、builder 调试信息等中间文件不上传到 Release。可使用 `Get-FileHash <文件路径> -Algorithm SHA256` 对照校验。

打包脚本固定使用 `--publish never`，本地打包不会上传文件。命令只使用本仓库锁定的 electron-builder，不通过 npx 临时下载其他版本。

## GitHub Release 流程

1. 修改完成后，用 `npm version <版本号> --no-git-tag-version` 同步 `package.json` 和 `package-lock.json`，例如 `npm version 1.1.0 --no-git-tag-version`。首次发布当前版本可跳过版本变更。
2. 按仓库惯例提交并上传版本改动。
3. 创建并推送对应的版本标签，例如：

   ```powershell
   git tag -a v1.1.0 -m "ArtPet 1.1.0"
   git push origin v1.1.0
   ```

4. `Windows Release` 工作流检查标签、安装锁定依赖、生成两个发行包和校验文件，然后上传到 Release 草稿。
5. 下载草稿附件，完成下方安装检查，补充更新说明后在 GitHub 发布。

普通分支推送不会构建或发布。在 Actions 页面手动运行 `Windows Release` 会生成保留 14 天的构建附件，不创建 Release；也可以用该方式在打标签前检查候选版本。

工作流使用仓库提供的 `GITHUB_TOKEN`，不需要额外设置个人令牌；仓库必须允许 GitHub Actions 运行，并允许工作流申请 `contents: write` 权限。代码签名证书与个人凭据不写入仓库。

## 失败和重试

版本与标签不一致时，工作流在安装依赖前停止。修正后发布新的版本提交和标签，不移动已发布版本的标签。

依赖下载或构建失败时，可查看失败步骤的日志，在问题解决后重跑同一工作流。若草稿已经建立，重跑会更新草稿附件；如果 Release 已发布，工作流会拒绝覆盖附件，应发布新版本。

`1.1.0-beta.1` 等预发布版本使用 `v1.1.0-beta.1` 标签，草稿自动标记为预发布。构建只负责打包和上传草稿，不运行应用或回归测试。

## 发布前检查

- 在没有 Node.js 的 Windows x64 环境安装并启动，检查开始菜单、桌面快捷方式和卸载入口。
- 检查桌宠加载、设置保存、拖动、语音、窗口停靠与全屏恢复。
- 在安装目录和便携路径含中文或空格时启动，检查内置模型、预加载脚本和原生模块加载。
- 覆盖升级后检查设置、已下载模型、语音与 AI 配置仍可读取；卸载默认保留用户数据。
- 移动整个便携目录后检查配置和缓存可用；便携目录不可写时检查回退提示与保存位置。
- 对照 Release 版本、文件名称和 SHA-256，确认上传的是本次构建产物。

安装版和开发运行保留 `%APPDATA%\ArkPet Surtr`，便携版保留程序旁的 `ArkPet-data`。不要把这些用户数据目录放入发行包。

## 软件标识、签名与许可

打包配置独立放在 `electron-builder.config.cjs`。公开名称为 ArtPet，应用 ID 保持 `local.arkpet.surtr`。EXE 写入软件图标、名称和版本；`signExecutable: false` 表示当前生成未签名包。后续接入代码签名时应单独配置签名方式和凭据，并恢复签名选项。

本流程不提供应用内自动更新。用户从 Release 下载新安装包进行升级，便携版退出后更换程序文件并保留旁边的数据目录。

项目自身仍标记为 `UNLICENSED`，发布前需由维护者确定代码许可证；第三方模型、语音、Spine 运行时及其他组件的许可继续以 `THIRD_PARTY_NOTICES.md` 和 `assets/licenses/` 为准。

配置依据：[electron-builder Windows](https://www.electron.build/v26/docs/win/)、[NSIS](https://www.electron.build/v26/docs/nsis/)、[GitHub CLI Release](https://cli.github.com/manual/gh_release_create)。
