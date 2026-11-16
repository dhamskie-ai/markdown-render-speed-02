# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/dhamskie-ai/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/dhamskie-ai/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

FastMark — a fresh, dependency-free CommonMark 0.31.2 + GFM renderer written from the specs. It returns byte-for-byte the HTML that marked 18.1.3 returns with default options, and renders the 720-case set ~10–15% faster than marked on CPU time.

<!-- Rebuilt in a recorded session for round 2. -->

## Run it

```sh
node main.ts
```

`main.ts` reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input/cases.json`) and writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output/html.json`), one HTML string per case, in order.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
