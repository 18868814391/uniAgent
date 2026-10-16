---
name: webapp-testing
description: Toolkit for interacting with and testing web applications. Prefer the built-in browser_* tools (native Electron window, no Python needed); fall back to Python Playwright scripts for headless/batch flows.
license: Complete terms in LICENSE.txt
---

# Web Application Testing

**First choice: use the native `browser_*` tools directly** — you have a visible, interactive test browser window built into the app. No Python/Playwright needed:

1. `browser_open(url)` — open/reuse the test browser and navigate. Returns `{ url, title, text, links }`.
2. `browser_snapshot(max)` — **do this once after navigating**: returns a compact list of interactive elements (buttons / inputs / links / selects / checkboxes), each with a stable `ref` and no CSS selector noise (which is what makes it cheap). It also reports `total` (all matching elements, so a truncated list is never a silent surprise) and `duplicates` (names appearing more than once, e.g. `{"编辑":400}`). Pass a `ref` to `browser_click` / `browser_type`.
3. `browser_flow(steps)` — **the fastest way to run a known flow**: pass the whole sequence in ONE call as `[{ action, target, value }]`; it executes them in order with optional assertions, stops at the first failure, and returns a per-step pass/fail summary plus the page snapshot AT the point of failure. 20 steps cost 1 roundtrip instead of 40+. Actions: `click` / `type` / `press` / `wait` / `goto` / `sleep` / `assertText` / `assertValue` / `assertVisible` / `assertUrl` / `assertEval`. Add `saveAs: "name"` to persist the flow as YAML, then replay it with `flow: "name"` — zero model calls, ideal for regression runs.
4. `browser_get_page()` — read the page's URL/title/body text/links. Use it only when you need the actual text content / data / results, not for discovering controls.
5. `browser_wait_for(selector)` — wait for an element (`selector`) or a JS `condition` before interacting.
6. `browser_click(selector)` / `browser_type(selector, text)` / `browser_press(key)` — interact one step at a time (prefer `browser_flow` when the sequence is already known). Targets: the `ref` from `browser_snapshot` (preferred), CSS, or `text=ExactText`. **For a repeated name always use the `ref`, or `text=编辑 >> nth=57` (0-based) — a bare `text=编辑` always hits the FIRST match.**
7. `browser_eval(js, arg)` — execute page JS for complex reads/waits.
8. `browser_console_logs()` — check the page's console for errors.
9. `browser_screenshot(name)` — **disabled by default**: you cannot see images, so a screenshot never helps your reasoning and costs a full roundtrip. It is only available when the user explicitly asks for a screenshot / visual evidence; take at most one then.
10. `browser_close()` — close the test window.

Use `execute_command` to start any local dev server first, then `browser_open('http://localhost:PORT')` to test it. This works without installing Python/Playwright and shows the user what you're doing.

**Fall back to Python Playwright scripts** only when you need headless / batch / unattended flows (many pages, CI-style runs, cross-site scraping). If you go that route:

**Helper Scripts Available**:
- `scripts/with_server.py` - Manages server lifecycle (supports multiple servers)

**Always run scripts with `--help` first** to see usage. DO NOT read the source until you try running the script first and find that a customized solution is abslutely necessary. These scripts can be very large and thus pollute your context window. They exist to be called directly as black-box scripts rather than ingested into your context window.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: python scripts/with_server.py --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Using with_server.py

To start a server, run `--help` first, then use the helper:

**Single server:**
```bash
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

**Multiple servers (e.g., backend + frontend):**
```bash
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True) # Always launch chromium in headless mode
    page = browser.new_page()
    page.goto('http://localhost:5173') # Server already running and ready
    page.wait_for_load_state('networkidle') # CRITICAL: Wait for JS to execute
    # ... your automation logic
    browser.close()
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```python
   page.screenshot(path='/tmp/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

❌ **Don't** inspect the DOM before waiting for `networkidle` on dynamic apps
✅ **Do** wait for `page.wait_for_load_state('networkidle')` before inspection

## Best Practices

- **With native tools, discover controls via `browser_snapshot` ONCE, then run the known sequence with `browser_flow`** — re-snapshotting before every action is what makes each roundtrip slower and inflates the context. Batch a stable sequence into a single `browser_flow` call (with `assert*` steps) instead of one tool call per action, and prefer the `ref` from the snapshot over a `text=` selector whenever a name repeats. Never take a `browser_screenshot` unless the user asks.
- **Use bundled scripts as black boxes** - To accomplish a task, consider whether one of the scripts available in `scripts/` can help. These scripts handle common, complex workflows reliably without cluttering the context window. Use `--help` to see usage, then invoke directly. 
- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` or `page.wait_for_timeout()`

## Reference Files

- **examples/** - Examples showing common patterns:
  - `element_discovery.py` - Discovering buttons, links, and inputs on a page
  - `static_html_automation.py` - Using file:// URLs for local HTML
  - `console_logging.py` - Capturing console logs during automation