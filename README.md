# 夏鸣 · 竹蝉互动声景

一个适合部署到 GitHub Pages 的纯前端互动页面。

## 技术

- HTML、CSS、原生 JavaScript
- Canvas 2D 物理与绘制
- Web Audio API 原创程序化声音
- 无构建步骤、无服务端、无第三方运行时依赖

## 本地运行

直接打开 `index.html` 可以运行。为了获得和 GitHub Pages 一致的行为，建议启动静态服务器：

```bash
python -m http.server 8123
```

然后访问 <http://localhost:8123/>。

## GitHub Pages 部署

1. 将本目录中的文件放到 GitHub 仓库根目录。
2. 打开仓库 `Settings` → `Pages`。
3. 在 `Build and deployment` 中选择 `Deploy from a branch`。
4. 选择 `main` 分支和 `/ (root)` 目录。
5. 保存并等待 Pages 地址生成。

所有资源均使用相对路径，支持部署在 `https://用户名.github.io/仓库名/` 子路径。

## 声音说明

声音不是复制的录音文件，而是浏览器实时生成：低频簧片脉冲模拟松香线的黏滑摩擦，三个带通共振峰模拟竹膜与筒腔，短混响提供空腔余韵。播放速率、共振频率、响度和声像会随竹蝉转速变化。
