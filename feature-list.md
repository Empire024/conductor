Bug list:
1. [Implemented] Double clicking to copy will only work inside terminals.
2. [Implemented] Bug with long text going over parts of UI like scrollbar & cursor position
3. [Implemented] Add button to easily toggle breaking of words inside editors based on current tab/window size
4. [Implemented] Selecting 'Message codex' shows a nasty outline around the boxy textbox.
5. [Implemented] Stopping needs to be possible via hitting ESC. The stop and resume icons should replace the send icon unless another message is being queued.
6. [Implemented] Bring back CLI switcher
7. [Implemented] Clicking outside of modals needs to close them. Clicking on the same icon that opens dropdown needs to close that dropdown (such as ... icon)
8. [Implemented] Clicking attach content should automatically open the textbox that should have autocomplete capabilities
9. [Implemented] a - In explorer, clicking on down arrow on project name does nothing - should open/close it. Double clicking it opens a rename menu, which should go away when clicking away, and should be where the conductor title is, not where it's currently mispossitioned.
9. [Implemented] b - Explorer needs to also show other projects files currently loaded in session (but closed by default)
10. [Implemented] Projects need to be able to be ordered (dragged) around in the view vertically
11. [Implemented] Going from one project to another removes what we had written in our Message Codex textbox - fix
12. [Implemented] Workspaces need to be able to be closed from the left menu as well as dragged and ordered like projects.
13. [Implemented] CTRL+E arrow keys don't work properly, they should be able to immidiately list through list of files.
14. [Implemented] For models that don't have Effort, don't even display it
15. [Implemented] Trying to change into CLI view shows error
16. [Implemented] Clicking Browser then clicking it again should close it.
17. [Implemented] I dislike the '+ Add agent' button design still, text is too large compared to all other parts of the theme, make it uppercase and smaller font style at least.. fix also 18 and 19
18. [Implemented] 'Attached file' text is for some reason a part of the visible prompt.. full text of file.
19. [Implemented] Multiple messages need to be possible to be queued. Also, queuing messages seems to be broken currentrly.. Also never show just 'default' always show which model we're running - I wanna see literallly GPT 6 Astra xhigh if that's what i'm running. No random auto letting me know nothing..


20. [Implemented] Codex seems nice, but Claude repats messages, asks for permissions even when granted already during session in Conversation settings..
21. [Implemented] Bring back the 'Auto / Plan / Edit etc' modes selector for models that support it -> move it from conversation settings to the actual chatbox bottom bar
22. [Implemented] even though im scrolled all the way to the bottom, i have to click 'new messages' to see the latest messages.
23. [Implemented] the tab name plus chat/cli & stop + conversation settings bar takes up too much vertical space. minify while keeping design super clean and UX friendly.
24. [Implemented] 'Inspect exact request and scope' is annoying, it can be there maybe as a little link somewhere or icon, but not first thing we see.. Also, beautify the 'Claude needs your input' part, currently it's ugly checkboxes.
25. [Implemented] Visual line between tab windows seems useless, just takes up space, keep resize functionality while removing visual bar.
26. [Implemented] Stopping during use shows ugly '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use' message.

27. [Implemented] Huge bug -> auto-saving files when closing can over-write with old file somehow, at least it happened to me when updating - my feature-list.md was saved by me, then I click restart, and it asks to save, then restarts, and Im met with a super old version.. Fix

28. [Implemented] When typing in ctrl+e, the whole results jump hardcore with each keystroke dissapearing for a sec.

29. [Implemented] Workspaces need a 'Bring back workspace' after accidentaly closing both by ctrl shift + z and by right click on workspace title.

30. [Implemented] Restart to update bottom bar button has broken hover.

31. [Implemented] Double clicking workspace name in Workspace view should let us rename said workspace and right click menus of workspace tab and menu here should be same..

32. [Implemented] Create file needs to work the same way as other creating, i.e. no ugly popup, just create the file and text cursor will be at editing (in tab name) so we can name it while text window is already open instead of ugly popups, if we don't name it, just assign it a name and make it a .md file, whatever. Add possibility to change default type of file in settings.

33. [Implemented] Check out session.md, it contains the ouput of your session and shows the amounts of unnecessary and weirdly displayed info.

00 urgent. [Implemented] Steering still queues it for waaaay too long! Should steer same as in VScode... FIX THIS. currently I CANT STEER MODELS I CANT ADD MORE DATA TO MY ORIGINAL PROMPT


34. [x] resuming a tab from history feels like something is broken till I understood what's going on, make it a bit more nicer on the UX. <!-- conductor-task:bug-34 agent=agent_mtsnb9sd_pe77gi7 -->
35. [x] Ask/auto -> why are the titles moved left / right but no icons are visible? Also, why is the default on Codex Model not <!-- conductor-task:bug-35 agent=agent_mtsnb9sd_pe77gi7 -->
36. [x] Usage model etc., never do not reported. based on some logic, always choose a model for that window. obviously subagents can call whichever cheaper or more expensive  <!-- conductor-task:bug-36 agent=agent_mtsnb9sd_pe77gi7 -->
models they want
37. [x] the files with . are visible the same as other files. think if that should be the case, maybe they should be separated? <!-- conductor-task:bug-37 agent=agent_mtsnb9sd_pe77gi7 -->
38. [x] adding files as context is terrible, moves content around (autocomplete should be as a over-content dropdown) - spend a bit of time on it, make it like VScode (feel free to launch vscode and test how it works there) <!-- conductor-task:bug-38 agent=agent_mtsnb9sd_pe77gi7 -->
39. [x] remove cyan border around entire selected window, only cyan around textbox. <!-- conductor-task:bug-39 agent=agent_mtsnb9sd_pe77gi7 -->
40. [x] When a tab uses another tab, a visual link should be active between those tabs (unless detached, then another simple way of displaying which tab it's attached/being controlled by needs to be shown) (like a cable) - that's for when for example Codex is using Claude in another tab or so. <!-- conductor-task:bug-40 agent=agent_mtsnb9sd_pe77gi7 -->

41. [x] when claude is using codex in a tab, it all should be visual as if a user was using it. <!-- conductor-task:bug-41 agent=agent_mtsnb9sd_pe77gi7 -->

42. [x] Claude messages are still doubled.. <!-- conductor-task:bug-42 agent=agent_mtsnb9sd_pe77gi7 -->

43. [x] scrolling broken when questions appear and sometimes when new output is still going on. <!-- conductor-task:bug-43 agent=agent_mtsnb9sd_pe77gi7 -->

44. [x] removing project is broken - files stay on disk part is broken visually and we cant actually delete an item.. sometimes it appears, but its bugged <!-- conductor-task:bug-44 agent=agent_mtsnb9sd_pe77gi7 -->

45. [x] make tokens going up smooth, currently it looks laggy <!-- conductor-task:bug-45 agent=agent_mtsnb9sd_pe77gi7 -->

46. [Implemented] design the effort slider a bit more nice, to where it feels like charging something up and full effort will make it fully designed/backgrouned (you get me)

47. [x] add hover effects to tab headers everywhere (even currently active tab) and workspace, fix night/day selector atop page, make changing of colors a smooth transition somehow (currently a flashbang) <!-- conductor-task:bug-47 agent=agent_mtsnb9sd_pe77gi7 -->

49. [x] Enter does not submit an agent question/answer form - the Submit answers button has to be clicked manually. <!-- conductor-task:bug-49 agent=agent_mtsnb9sd_pe77gi7 -->

50. [Implemented] Subagent roster reported ordinary foreground tool calls as subagents. Claude sends system/task_* for every Bash call with is_backgrounded false; only backgrounded work is listed now, foreground lifecycle stays in the event inspector. Background tasks keep their launch description instead of being renamed to 'Background command ... (exit code 0)', report real status past the end of the turn, show their command, and link to the runtime's tab.

51. [x] Subagent roster still shows '0 tools / 0 activity items' for a backgrounded shell task. Its real output lives in the task's output_file, which is not surfaced anywhere - decide whether to read and attach it. <!-- conductor-task:bug-51 agent=agent_mtsnb9sd_pe77gi7 -->

52. [x] Effort must never read "Not reported" - the composer resolves the running model’s supported effort, shows it, and commits it, so every conversation runs on a concrete effort. <!-- conductor-task:bug-52 agent=agent_mtspoduk_c88in1p -->

53. [x] Middle-click autoscroll works on every scrollable surface (project tasks, menus, file lists, conversations), not only the page; tab strips keep middle-click-to-close. <!-- conductor-task:bug-53 agent=agent_mtspoduk_c88in1p -->

54. [x] A "Project tasks" tab opened through the app protocol rendered "Unavailable"; the tasks pane now renders as a real workspace tab. <!-- conductor-task:bug-54 agent=agent_mtspoduk_c88in1p -->

- [ ] Stop/play button in agent view is still nasty & not animated, work a bit on it to make it beautiful and fully animated - alsao, this bug report should come with easy image upload so I can visually share stuff as a bug (also CTRL+enter) should send the bug <!-- conductor-task:8d608499-2169-4667-ad20-17d85edcea36 -->

- [x] Messages that steer are not 'sent', but the agent is still going -> make sure this state is visually shown, i.e. we show that 'Message is sent after next tool use.' or something.. Steering should work same as in the CLI, i.e. wait for next tool use, esc to actually interupt and send immidiately, but actually next tool use, not the entire run of all tools like it used to be here ((bug))) <!-- conductor-task:aab154cf-753f-430d-9322-705aef5811e2 agent=agent_mtsqk737_52vftmy -->

- [ ] Coordination cable is currently nasty - goes through content, make another visual way of connecting tabs other than that cable, or route it another way. <!-- conductor-task:1683e42e-fad9-4114-bb08-76df967f1c4c -->

- [ ] Coordination replies are being shared the same way my messages are. They shouldn't be, my messages i.e. 'You' should really mean I sent it. <!-- conductor-task:1cf21b4b-06ff-45d9-a60d-9728358c141f -->

- [x] Stray enter gives error when adding task & (button + add task should be just add) <!-- conductor-task:af404d03-5374-42b2-ae5e-b20ac7f62608 agent=agent_mtsqk737_52vftmy -->

Feature list:

0. [Implemented] Beautify the 'send' button.
1. [Implemented] Right clicking night/day will open simple dropdown where you can choose the theme also.
2. [Implemented] Files that are currently open in the browser should have some sort of visual cue of that.
3. [Implemented] version number in bottom right corner should be clickable to try to update (hover will tooltip Check for updates (last checked xxx)) and show a (Check) Latest version already installed if the run comes back as latest.
4. [Implemented] To open files, make sure we visually see whether we've made changes or not, and if we try to close the Conductor, ask to save the files or close or cancel.
5. [Implemented] Show actual model logos to really differentiate between them
6. [Implemented] Add Spelunking, and all the other words instead of just 'Working'.
7. [Implemented] For files we get from agents, click is open in text, ctrl click is open in browser, ctrl shift click is open in external browser
8. [Implemented] Add 'tabs' to files as well i.e. make it easy to create another file from tab view also and close it the same way as other tabs.
9. [Implemented] Reduce spacing between messages in the Codex view to use space more efficiently while keeping the conversation easy to read.

10. [Implemented] Ctrl+E opens a searchable file picker across all projects loaded in Conductor, including detached windows and when no workspace is open.
11. [Implemented] Replace the downloading-update loader with a calm, thin progress indicator and readable status.

12. [Implemented] We need a way to see subagents -> How many are called, whats their status, etc.
13. [Implemented] We need to see how many tokens Working & Spelunking is taking up in real time, also add available usage breakdown findable in each tab under View usage text link

14. [Implemented] Make tabs easy to controll with keyboard like in chrome (ctrl+t, ctrl tab etc), add easy resizing of window like with windows + arrow for tabs - so ctrl+t, X will open codex, etc.

15. [x] add autocomplete of commands in chat <!-- conductor-task:feature-15 agent=agent_mtsnb9sd_pe77gi7 -->
16. [x] in workspaces, workspace should show tabs, right clicking on tab should give us all options we have till now for tabs + a new one, 'Show tab' which will show the tab detached over other content <!-- conductor-task:feature-16 agent=agent_mtsnb9sd_pe77gi7 -->
17. [x] the entire app needs to be controllable via models via mcp or other internal protocol and the models need to know about it so that links and all work beautifully and we can refer to stuff without the models having to endlessly search stuff that doesn't matter, also for memory, and internal agents, etc. - think of when we have an agent that'll pick the best model for each task when we prompt him, spawn a couple tabs and work on our task at hand. Why not create that agent via that MCP when you build it to test it out also? <!-- conductor-task:feature-17 agent=agent_mtsnb9sd_pe77gi7 -->
18. [x] to add on to 17 for example with this feature list, the agent will edit it, so the user immidiately sees edits happen in real time. It doesn't have to be MCP, but just a communication for agents with conductor that won't churn extra tokens for no reason. <!-- conductor-task:feature-18 agent=agent_mtsnb9sd_pe77gi7 -->
19. [x] Project tasks record which agent, in which workspace, moved each item and when, with one click to open that conversation. <!-- conductor-task:feature-19 agent=agent_mtspoduk_c88in1p -->
20. [x] Source control is built into project tasks: a per-project toggle, the commits and changed files recorded while a task was open, and one-click Open on GitHub. <!-- conductor-task:feature-20 agent=agent_mtspoduk_c88in1p -->
21. [x] Tasks can be Ideas as well as Bugs and Features, with their own section in feature-list.md. <!-- conductor-task:feature-21 agent=agent_mtspoduk_c88in1p -->
Implementation and validation: [backlog delivery record](docs/conductor-backlog-delivery.md).

Latest completion and validation: [remaining checklist delivery](docs/backlog-completion.md).

## Urgent bugs and permissions - 2026-09-08

Migrated from the owner-approved urgent handoff. Original evidence and acceptance criteria are preserved below; progress is tracked through Project tasks.

## Bugs

## 1. Fix agent runtime startup and filesystem access

- [~] Investigate and fix `helper_unknown_error: setup refresh had errors` preventing Codex from starting its shell and accessing workspace files. <!-- conductor-task:urgent-runtime-startup agent=agent_mtsqk737_52vftmy -->

Confirmed evidence: default-shell Get-Location and explicit Windows PowerShell pwd with login disabled both fail before command execution with `Failed to create unified exec process: helper_unknown_error: setup refresh had errors`. Node REPL fails with `windows sandbox failed: helper_unknown_error: setup refresh had errors`. An apply_patch update to feature-list.md fails while reading the file with the same sandbox helper error. A previous add-file call returned an empty result; creation of artifacts/bug-coworker-visibility-shell-startup.md was not verified. Do not assume that report exists.

Acceptance: native shell commands, workspace reads, and authorized writes work from an affected Conductor agent session. Diagnose the actual setup-refresh cause rather than disabling sandbox protection as a workaround.

## 2. Restore live coworker visibility

- [x] Verify and repair live inspection of Claude's activity in another tab of the same workspace using Conductor app control. <!-- conductor-task:urgent-coworker-visibility agent=agent_mtsqk737_52vftmy -->

Expected: discover tools.list, query app.state, identify the correct coworker tab and workspace, and inspect the available live activity/status. Distinguish live observations from the injected project-wide briefing and stale intent records. The briefing currently reaches this agent, but earlier entries lacked timestamps, tab identifiers, execution results, and running/idle status. The latest briefing identifies Claude viewing src/shared/project-backlog.ts in this workspace.

Evidence boundary: the attempted app.state request never executed because shell startup failed. The control API itself has not been shown to be broken. Verify it after restoring execution and address any remaining visibility gaps.

## 3. Make Project tasks integration work end to end

- [x] Restore direct agent access to Project tasks, migrate the urgent handoff, and verify live additions and updates in the installed Project tasks panel. <!-- conductor-task:urgent-project-tasks agent=agent_mtsqk737_52vftmy -->

The panel reads feature-list.md. A standalone report is not a project task. This session could neither call the task API nor safely update feature-list.md because of the runtime failure. Use discovered tasks.update/files APIs according to their actual schemas; preserve task markers, existing claims, and unrelated checklist content. Verify create/read/update behavior and UI refresh. Move these urgent items into the real backlog without duplicates, then remove this temporary file as instructed above.

## Features

## 4. Add both Claude permission actions

- [x] Add an explicit `Allow for this session` option when Claude requests permission. Honor the permitted action's scope for the current session and avoid repeatedly asking for the same covered permission. Make the scope clear and ensure session approval does not silently become permanent. <!-- conductor-task:urgent-claude-session-permission agent=agent_mtsqk737_52vftmy -->
- [x] Add an explicit `Switch to auto-mode` option on Claude permission requests. Wire it to the provider's supported automatic approval mode, update the visible mode state, and handle the pending request consistently. Both actions must be available as distinct choices; use actual provider capabilities and do not silently bypass mandatory approval boundaries. <!-- conductor-task:urgent-claude-auto-mode agent=agent_mtsqk737_52vftmy -->

Acceptance: exercise a real Claude permission request in a visible tab; verify both buttons, session-scoped repeated requests, mode switching, pending-request resolution, and existing allow/deny behavior. Add meaningful regression coverage for permission handling and UI state.

## Delivery

Run relevant tests and npm.cmd run build. Preserve unrelated shared work, commit the coherent finished change, and push main to origin. Let the release workflow create the patch release; do not manually change the version or tag. Verify workflow success and release assets: installer, blockmap, and latest.yml. The installed app must receive the fixes through its updater. Do not claim delivery while publishing or verification remains blocked.


## Ideas

- [ ] Probe idea from the tasks pane <!-- conductor-task:ec3529fb-6ae7-45f9-b476-4efa01dfa5b0 -->
- [ ] Probe idea from the tasks pane <!-- conductor-task:b79d0ab6-655a-41cb-87a3-8a68ee6e2507 -->

- [ ] Probe idea from the tasks pane <!-- conductor-task:021d8f33-fe6d-4430-9326-311e5faffb18 -->

## Bugs

- [x] Project tasks in 0.1.18 cannot add or edit reports containing line breaks. Preserve multi-line text and support Ctrl+Enter to save while Enter inserts a newline. <!-- conductor-task:task-multiline-reports agent=agent_mtsqk737_52vftmy -->

- [ ] Closing a tab briefly flashes the remaining tab(s). Animate the pane resize so neighbours grow smoothly, without re-rendering or flashing their content during the transition. <!-- conductor-task:bug-tab-close-resize-flash -->

- [ ] Ctrl+Shift+Alt+Arrow does not move a tab/window - it resizes exactly like Ctrl+Shift+Arrow. Make the move shortcut actually relocate the tab in the layout, distinct from resizing. <!-- conductor-task:bug-move-tab-shortcut -->

- [ ] Switching the theme from day to night and back is extremely laggy. Make the theme swap fast and smooth. <!-- conductor-task:bug-theme-switch-lag -->

## Features

- [x] Task circles select one or multiple tasks; completing a task uses its status selector and moves it to Done. Selected tasks can be assigned to an open native agent tab or a new tab with model and effort choices. Auto opens a main Fixer that chooses suitable models and efforts per task and delegates to visible native coworkers. <!-- conductor-task:task-selection-dispatch agent=agent_mtsqk737_52vftmy -->

- [ ] Match VS Code file type colors/icons for every language and extension (.mjs, .cjs, .ts, .tsx, .json, .css, .md, .ps1, .yml, dotfiles, ...), applied consistently in the explorer, file tabs, Ctrl+E picker and agent file links. <!-- conductor-task:feature-file-type-colors -->

- [ ] Subagents view currently shows almost nothing. Per subagent, show the model/provider it runs on (with effort), which tab and workspace it belongs to when that differs from the calling tab or is another company's model, live status, token usage, and a click-through to open it. <!-- conductor-task:feature-subagents-view-detail -->