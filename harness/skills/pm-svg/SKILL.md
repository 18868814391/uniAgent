---
name: pm-svg
description: SVG 原型图规范。用内联 SVG 绘制页面线框图：布局、表格、表单、弹窗、状态反馈，统一画布与配色，标注字段与权限。
---

# pm-svg（SVG 原型图规范）

产品角色所有示意图必须用 SVG。本规范统一画布、元件与标注，保证原型图可读、可评审。

## 基本约定

- 内联在 .md 中：`<svg viewBox="0 0 1200 H">...</svg>`（H 按内容取整，如 780）。
- 不用图片文件；如需独立文件，保存为 `.svg` 并相对路径引用。
- 配色：优先复用已对齐页面（`{{CODE_REPO_DIR}}`，即当前平台的前端仓库）的主题色；无来源时用中性色板：
  - 边框 `#d0d7de`、标题栏背景 `#f6f8fa`、主色 `#2563eb`、危险 `#dc2626`、成功 `#16a34a`、文字 `#1f2328`、次要文字 `#57606a`。
- 字体：`font-family="Microsoft YaHei, PingFang SC, sans-serif"`，字号：页面标题 22、区块标题 14、字段 12、次要 11。
- 所有 `<text>` 文字内容用中文。

## 通用元件模板

### 页面框架（含搜索区 + 工具栏 + 表格 + 分页）

```svg
<svg viewBox="0 0 1200 720" xmlns="http://www.w3.org/2000/svg" font-family="Microsoft YaHei, PingFang SC, sans-serif">
  <!-- 页面标题栏 -->
  <rect x="0" y="0" width="1200" height="52" fill="#f6f8fa"/>
  <text x="20" y="33" font-size="18" font-weight="bold" fill="#1f2328">物资清单</text>
  <!-- 搜索区 -->
  <rect x="0" y="52" width="1200" height="64" fill="#ffffff" stroke="#d0d7de"/>
  <rect x="20" y="70" width="180" height="30" rx="4" fill="#ffffff" stroke="#d0d7de"/>
  <text x="30" y="90" font-size="12" fill="#57606a">单号：</text>
  <rect x="240" y="70" width="200" height="30" rx="4" fill="#2563eb"/>
  <text x="310" y="90" font-size="12" fill="#ffffff" text-anchor="middle">查询</text>
  <text x="470" y="90" font-size="12" fill="#57606a">重置</text>
  <!-- 工具栏 -->
  <rect x="0" y="116" width="1200" height="48" fill="#f6f8fa" stroke="#d0d7de"/>
  <rect x="20" y="128" width="76" height="26" rx="4" fill="#2563eb"/>
  <text x="58" y="146" font-size="12" fill="#ffffff" text-anchor="middle">新增</text>
  <!-- 表格头 -->
  <rect x="0" y="164" width="1200" height="34" fill="#f6f8fa" stroke="#d0d7de"/>
  <text x="20" y="186" font-size="12" fill="#57606a">序号</text>
  <text x="100" y="186" font-size="12" fill="#57606a">单号</text>
  <text x="340" y="186" font-size="12" fill="#57606a">供应商</text>
  <text x="620" y="186" font-size="12" fill="#57606a">金额</text>
  <text x="820" y="186" font-size="12" fill="#57606a">状态</text>
  <text x="1000" y="186" font-size="12" fill="#57606a">操作</text>
  <!-- 数据行 -->
  <rect x="0" y="198" width="1200" height="34" fill="#ffffff" stroke="#d0d7de"/>
  <text x="20" y="220" font-size="12" fill="#1f2328">1</text>
  <text x="100" y="220" font-size="12" fill="#2563eb">CGCG-2026-0001</text>
  <text x="340" y="220" font-size="12" fill="#1f2328">供应商A</text>
  <text x="620" y="220" font-size="12" fill="#1f2328">1,250.00</text>
  <rect x="810" y="205" width="56" height="20" rx="10" fill="#fff4e5"/>
  <text x="838" y="219" font-size="11" fill="#d97706" text-anchor="middle">待审核</text>
  <text x="1000" y="220" font-size="12" fill="#2563eb">编辑 详情</text>
  <!-- 分页 -->
  <text x="20" y="260" font-size="12" fill="#57606a">共 128 条 · 第 1/13 页</text>
  <rect x="1060" y="248" width="40" height="22" rx="4" fill="#ffffff" stroke="#d0d7de"/>
  <text x="1080" y="264" font-size="11" fill="#1f2328" text-anchor="middle">下一页</text>
</svg>
```

### 表单弹窗

```svg
<svg viewBox="0 0 560 420" xmlns="http://www.w3.org/2000/svg" font-family="Microsoft YaHei, PingFang SC, sans-serif">
  <rect x="0" y="0" width="560" height="420" rx="8" fill="#ffffff" stroke="#d0d7de"/>
  <rect x="0" y="0" width="560" height="44" rx="8" fill="#f6f8fa"/>
  <text x="20" y="28" font-size="15" font-weight="bold" fill="#1f2328">新增物资</text>
  <!-- 字段行：label + 输入框 -->
  <text x="20" y="80" font-size="12" fill="#57606a">物资编码<text fill="#dc2626"> *</text></text>
  <rect x="140" y="66" width="200" height="30" rx="4" fill="#ffffff" stroke="#d0d7de"/>
  <!-- 保存/取消 -->
  <rect x="180" y="360" width="76" height="30" rx="4" fill="#2563eb"/>
  <text x="218" y="380" font-size="12" fill="#ffffff" text-anchor="middle">保存</text>
  <rect x="266" y="360" width="76" height="30" rx="4" fill="#ffffff" stroke="#d0d7de"/>
  <text x="304" y="380" font-size="12" fill="#57606a" text-anchor="middle">取消</text>
</svg>
```

## 标注要求

- 每个关键字段旁可标注：必填 `*`、来源（如 `=供应商字段`）、权限码（如 `WZ_YC_ADD`）。
- 状态用圆角标签，配色：待审核 橙、已通过 绿、已驳回 红、草稿 灰。
- 需要强调的交互（点击后弹窗/跳转）用虚线框 + 文字注释。
