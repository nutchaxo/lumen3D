# Changelog 1.73.6

## [FIXED]
- **Data updates status no longer lowers the PHP time limit**: the bounded status of 1.73.3 called `set_time_limit(60)` unconditionally, which cut a host that allowed more time down to 60 s and, in the command-line test run, imposed a 60 s limit on the whole process (the PHP executor test failed whenever the runner was slow). The limit is now only raised, only when the host's own is shorter than 60 s, and never in the CLI.
