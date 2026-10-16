---
name: legal-statute-lookup
description: 在本地法律法规库检索并原文引用法律条文（先查 legal-index.md 定位文件，再 read_file 具体 .md 的某条）。库内无则默认直接联网（免问；涉密/意图不明才 ask_user）：legal_npc_search 纯接口检索拿法规 ID(bbbs) → download_url 下载 flk law-search/download/pc?format=docx 文字版；未收录再 search_web 找 .gov.cn 官方原文；浏览器站内搜索仅兜底。
---
# legal-statute-lookup（法律法规检索）

用户问"某法条怎么规定 / 第X条内容 / 某事项适用哪条法律"时启用。核心原则：**先本地、后官网、必引条号**。

## 流程

1. **先读索引定位文件**：`read_file` `{{CODE_REPO_DIR}}/legal-index.md`，按"法律名 / 修正日期 / 类别 / 相对路径"找到目标 `.md`（如 `法律/中华人民共和国专利法_20201017.md`）。
2. **读具体文件定位条文**：`read_file` 该 `.md`，或直接 `grep_code` 在 `{{CODE_REPO_DIR}}` 内按关键词 / 条号搜（`### 第一条` 等标题层级已规范为 `# 法律名 → ## 第X章 → ### 第X条`）。
3. **原文引用**：给出「文件名 + 条号 + 原文片段」，便于溯源。
4. **时效核查**：留意命中条目的修正 / 公布日期（索引日期列或文件名 `_YYYYMMDD` 后缀）。若用户问的是"现行有效 / 最新修订版"，而库内版本日期明显偏旧（如库内为 2021 版、用户暗示 2023 已修正），提示「本地库版本为 YYYY-MM-DD，可能未同步到最新修订，建议去官网核对」，**不得把库内旧版直接当成现行版引用**；库内同名存在多版本文件时，默认引用修正日期最新者并注明版本日期，用户指定旧版时按指定引用。
5. **库内缺失 → 默认直接联网（免问）**：标注「未在本地法律法规库检索到」，然后**直接进入下方「联网检索」**，不再反问——前提是用户查询的是**明确公开法规**（名称 / 发文字号 / 意图清晰）；检索词是公开法规名，不涉密，与通用身份直查一致。仅当查询对象疑似涉密 / 用户只丢来内部材料意图不明 / 检索目标明显歧义需拍板时，才**调用 `ask_user` 工具**（≤6 选项，严禁纯文字列项）。**严禁凭记忆补全条号或措辞**。

## 联网检索：官方直链为主，浏览器仅兜底

> 国家法律法规数据库（flk.npc.gov.cn）收录宪法、法律、行政法规、监察法规及**地方性法规**（含设区的市）。检索接口与下载接口均可纯 HTTP 直连、无需验证码——**多数情况下不需要打开内置浏览器**。

1. **`legal_npc_search` 接口检索（主路径，秒级）**：传法规全称/关键词，工具经官网 `search/list` 接口返回命中列表，每条含 标题 / 公布与施行日期 / 制定机关 / 位阶 / **法规 ID（bbbs）**。同名多版本命中时优先「现行有效 + 公布日期最新」。
2. **`download_url` 下载 flk 文字版 docx**：url 填 `https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=<法规ID>`，name 填「<法规名>.docx」。该接口返回 JSON（内含 OSS 签名直链），工具会自动解析下载；docx 是 WPS 文字版，最易提取全文。
3. **接口无命中 → `search_web` 找官方原文**：flk 未收录（多为更冷门的地方性法规）时，搜「法规全称 + 人大常委会 / 公报 / site:*.gov.cn」，命中当地人大（如 hzrd.gov.cn）或政府公报 `.gov.cn` 的 pdf/docx 直链 → 同样交给 `download_url`；若只有 flk 详情链接，从其 URL 的 `id=` 提取法规 ID 后回到第 2 步。
4. **解析核对**：拿到本地路径后用 `execute_command` / `read_file` 转文本：
   - **docx**（zip 容器）：写 python 脚本解包读 `word/document.xml` 提取文本，或 python-docx；Linux/Win 也可 `unzip -p file.docx word/document.xml`。
   - **doc**（老式 OLE 二进制，read_file 会乱码）：优先 `where soffice` 探测 LibreOffice，命中则 `<programDir>/soffice.exe --headless --convert-to txt --outdir <输出目录> <doc路径>`；其次按文件魔数（HTML/RTF/zip-docx）尝试提取。
   - **pdf**：转文本（如 pypdf/pdfplumber）或按需截图。
   - 最后以「文件名 + 条号 + 原文片段」引用，标注「以官网原文及执业律师意见为准」。
5. **浏览器仅兜底**：仅当 `legal_npc_search` 接口被网络/WAF 拦截（罕见，工具内部自动回退浏览器站内搜索并返回「输入诊断」）、或只能靠网页交互拿附件时，才用 `browser_*` 在 `.gov.cn` 页面点「下载」+ `browser_wait_download` 拿本地路径。勿手动 `browser_open` 官网空找。
6. **纪律**：官网检索不到 ≠ 法规不存在/未收录——先换全称/发文字号重试，再走当地人大/政府公报官方渠道；**不得**只凭模型记忆作答或只列推荐网站。仍无权威文本才如实说明并建议向制定机关/执业律师核实。**内部 / 涉密材料禁止联网**（见 `{{HARNESS_CONVENTIONS_DIR}}/legal/confidentiality.md`）。

## 输出

- 给结论 + 引用条文（带条号原文）+ 来源文件路径。必要时附「建议下一步」（如"如需逐条比对，可切入合同审查"）。
