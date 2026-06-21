Start a new session by reading the .md files in tools, they are hard-fought lesson.

How to use this repo:

1. check package.json on how to build this userscript. also use npx tsc --noEmit 2>&1 to check.
2. do a sanity check with the browser you control along with javascript injection there to test what you just changed on the userscript

Meta usage:
I'm trying to extract knowledge on how to best use oh-my-pi while working on this repo.

For EVERY failed tool call:
1. check the folder tools to see if there is an md with the failure mode
2. write the failure mode in that file as the first item (unordered list)
3. check if there is a pass and use that. if that fails, change it to a failure and put it as first item
4. if there is no pass, continue the tool calls to try to pass it. Return here to either write the failure or pass mode

So basically the loop is writing down failure modes of tool usages until they pass.

For EVERY investigation request:
1. check the folder investigation to see if there is an md with the investigation process
2. if there is already one, read it and get inspiration from it for this new request and update the file if better practices are found
3. if there is none, create a new file and periodically update the file with the best practices of the process during the investigation

So basically the loop is doing an investigation and noting down best practices.
