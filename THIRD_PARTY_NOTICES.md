# 第三方素材与组件

## 史尔特尔泳装模型

- 来源：[isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models)
- 固定提交：`3745e5c6e10b5252b2a5e1f1841ebef62b7ef15b`
- 目录：[models/350_surtr_summer#9](https://github.com/isHarryh/Ark-Models/tree/3745e5c6e10b5252b2a5e1f1841ebef62b7ef15b/models/350_surtr_summer%239)
- 干员：史尔特尔 / Surtr；时装系列：珊瑚海岸/IX。
- 原始骨骼版本：3.8.99；贴图由上游预乘透明度（PMA）。本项目保留下载文件原样，文件 SHA-256 记录于 `assets/surtr/source.json`。

上游版权声明：所有素材版权归属上海鹰角网络有限公司所有，不得用于商业用途，不得损害版权方的利益。参见[上游说明](https://github.com/isHarryh/Ark-Models/blob/3745e5c6e10b5252b2a5e1f1841ebef62b7ef15b/README.md)。本项目为非官方桌宠，不主张对角色素材的所有权。

## 人物语音与文本

- 来源：[PRTS Wiki](https://prts.wiki/) 各干员的“语音记录”页面，例如[史尔特尔/语音记录](https://prts.wiki/w/史尔特尔/语音记录)。感谢 PRTS 编辑者的整理。
- 应用按需读取页面，从同一条页面记录取得片段名称、音频路径和中文文本，并在用户数据目录缓存。设置中的“查看原文”提供对应来源链接；缓存记录保存页面版本、资源地址、文件大小和 SHA-256。
- 仓库不内置人物语音、批量抓取的台词文本或 PRTS 语音目录。获取失败或记录不完整时不播放该条语音，也不生成、改写或仿制角色台词及声优语音。
- PRTS 声明，站内游戏音频与文本原文的版权属于上海鹰角网络科技有限公司及其关联公司；其余网站内容除另有声明外采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 授权。具体条件以 [PRTS 页面声明](https://prts.wiki/w/PRTS:使用帮助) 为准。

### 软件组件

`assets/operators.json` 的干员与时装目录来自 [isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models) 提交 `3745e5c6e10b5252b2a5e1f1841ebef62b7ef15b` 的 `models_data.json`。用户选中其他干员后，程序从该仓库的 `models/` 目录按需下载对应模型，其版权归属和使用限制与内置素材相同。下载来源、上游提交与文件校验值保存在本地模型缓存的 `source.json` 中。

- [Electron](https://github.com/electron/electron)：MIT；其发行包另附 Chromium 等组件声明。
- [PixiJS](https://github.com/pixijs/pixijs)：MIT。
- [pixi-spine](https://github.com/pixijs-userland/spine)：集成代码为 MIT，所含 Spine 运行时代码同时适用 Spine Runtimes License。
- [electron-builder](https://github.com/electron-userland/electron-builder)：MIT，作为开发和打包依赖。
- [Koromix/Koffi](https://github.com/Koromix/koffi)：MIT，使用预编译 Node-API 模块调用 Windows 窗口几何接口。许可见 `assets/licenses/KOFFI-LICENSE`。

Spine 运行时许可原文保存在 [assets/licenses/SPINE-LICENSE](assets/licenses/SPINE-LICENSE)。Spine 运行时不等同于 pixi-spine 集成代码的 MIT 授权，集成及分发应按该许可执行。本项目的打包配置不授予任何模型或运行时的额外权利。
