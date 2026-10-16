---
name: dev-git-discipline
description: 开发角色的 git 纪律——改前看 status、改后 diff 复核、不主动 commit/push、存量问题用 HEAD 对照、危险操作先确认。
---
# dev-git-discipline（git 纪律）

改代码任务的配套纪律。全量文件权限 + git 写权限意味着一次手滑就能毁掉别人没提交的工作，规则不是仪式，是保险丝。

## 改前

- `git status` 确认工作区状态：已有未提交改动的文件要格外小心——你的编辑会混进别人的工作里，汇报时必须指出。
- `git branch --show-current` 确认当前分支；用户要求「改某某分支」而当前不在时，先问（`git checkout` 会带着未提交改动走）。

## 改后

- `git diff <文件>` 逐文件复核，确认没有误改、没有把无关行重排（prettier/缩进漂移会造成巨型假 diff，要发现并回退无关重排）。
- **不主动 commit / push**——除非用户明确要求。commit message 按该仓库既有风格写。

### 写 commit message（被要求 commit 时才用）

参照 opencode 的 `/commit` 口径：

- **写 WHY，不写 WHAT**。从**最终用户视角**说清「这次改动解决了什么问题」，
  而不是复述「我改了哪几行」。
- 不许写空泛动词：「优化体验」「improve agent experience」这类等于没写 ——
  要具体到用户能感知的变化。
- 沿用该仓库的前缀习惯（若有）：`feat:` / `fix:` / `docs:` / `refactor:` / `style:` / `chore:`。
- 拿不准改动风格时先 `git log -10 --oneline` 看这个仓库怎么写的，跟着它走。
- 有合并冲突**不要自己修** —— 停下告诉用户，让他决定。

## 存量问题对照

- 批量测试/检查里有失败项、且怀疑是改动前就有的问题：**单独重跑一次**确认稳定复现，再用 HEAD 版本（`git stash` 或 `git show HEAD:<file>` 取旧文件）跑同一检查对照，拿证据说话——不许只说「应该与我无关」。
- 负载敏感的用例可能偶发失败，判定归属前必须单独重跑。

## 危险操作（一律先 ask_user 确认）

`git reset --hard`、`git checkout -- <file>`、`git checkout .`、`git clean`、`git push --force` / `--delete`、`git rebase`、`git branch -D`、`git stash drop/clear`、`git config --global`、`git update-ref -d`、删除分支/标签、`git checkout` 会覆盖未提交改动时。

- 这些命令**应用侧也会弹确认框**（`tools/guard.js`），两者不冲突：你先问、用户同意后再执行，执行时那次弹框是最后一道确认；用户拒绝就停下，不要换写法绕。
- 它们丢掉的恰恰是 git 兜不住的东西——**未提交的改动、未被跟踪的文件**。所以「项目有 git 就能随便来」不适用于这一组命令，规矩照旧。
