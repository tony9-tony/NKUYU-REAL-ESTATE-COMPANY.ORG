@echo off
title MKUYU tests
cd /d "%~dp0"
rem A fresh test database: the old mkuyu_org_test has grown large enough that
rem the test server takes ~50 s to start. Nothing in the old one is touched.
set MKUYU_TEST_DB=mkuyu_org_test_fresh
echo Running MKUYU tests... results go to test-results.txt
(for %%t in (unit access frontend e2e final partial secfix backup) do (echo ===== %%t & call npm run test:%%t)) > test-results.txt 2>&1
echo Done. See test-results.txt
