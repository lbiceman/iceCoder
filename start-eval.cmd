@echo off
set ICE_DISABLE_TOOLS=1
set ICE_EVAL_MODE=1
set PORT=3001
npx tsx src/cli/index.ts web --port 3001 > output.log 2>&1
echo EXIT_CODE=%ERRORLEVEL%
