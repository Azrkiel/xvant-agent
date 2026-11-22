# First A08 focused snapshot check

Source `ec63cb0e21c3d88f38e0153c9d2c930e262062ca` on prerequisite base
`e97d719fef88eeea19c49f8d67124105063d3de4`. The initial focus run passed
169 tests and failed 20. The snapshot validator was missing the inbox's
empty foreign-key roster. The follow-up adds the roster entry and a
verified inbox snapshot/replay test. The test's first version tried to
reopen a snapshot during the copied lease. It now uses the same expired
lease fixture as the existing workflow snapshot test.

[Focused output](focused.log) · [Exact invocation](focused.command)
