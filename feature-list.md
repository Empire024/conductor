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

- [x] Stop/play button in agent view is still nasty & not animated, work a bit on it to make it beautiful and fully animated - alsao, this bug report should come with easy image upload so I can visually share stuff as a bug (also CTRL+enter) should send the bug <!-- conductor-task:8d608499-2169-4667-ad20-17d85edcea36 agent=agent_mtu035p5_ezlg01o -->

- [x] Messages that steer are not 'sent', but the agent is still going -> make sure this state is visually shown, i.e. we show that 'Message is sent after next tool use.' or something.. Steering should work same as in the CLI, i.e. wait for next tool use, esc to actually interupt and send immidiately, but actually next tool use, not the entire run of all tools like it used to be here ((bug))) <!-- conductor-task:aab154cf-753f-430d-9322-705aef5811e2 agent=agent_mtsqk737_52vftmy -->

- [x] TAB + TAB Coordination cable is currently nasty - goes through content, make another visual way of connecting tabs other than that cable, or route it another way. <!-- conductor-task:1683e42e-fad9-4114-bb08-76df967f1c4c agent=agent_mttcsu1i_3zvkeu1 -->

- [x] Coordination replies are being shared the same way my messages are. They shouldn't be, my messages i.e. 'You' should really mean I sent it. <!-- conductor-task:1cf21b4b-06ff-45d9-a60d-9728358c141f -->

- [x] Stray enter gives error when adding task & (button + add task should be just add) <!-- conductor-task:af404d03-5374-42b2-ae5e-b20ac7f62608 agent=agent_mtsqk737_52vftmy -->

- [x] CTRL+T with a new tab open doesn't open another new tab, should do that <!-- conductor-task:d38cfabb-a246-4fa7-8e20-68f391a9d557 -->

- [x] When CTRL+T is open and tab is focused, the C / X / Q key binds to open agent windows need to work. currently they only work if pressed immidiately after ctrl+t <!-- conductor-task:238d9c49-d5d9-480c-9b62-6ce2a677dca6 -->

- [x] Make sure when ctrl+e - ing, recently opened folders, or folders in the currently opened workspace are shown first, i.e., now that i'm writing here in this project tasks feature-list.md, ctrl+e feature-list shows some . folder's feature-list, not this feature-list as first.. fix that, . files shouldn't even be ctrl+e unless we click an icon that adds this exemption in ctrl+e or set it  globally in settings <!-- conductor-task:9c001aa5-d476-4b8b-b984-dd3029d1a65b agent=agent_mtt8r78u_bfzsv3d -->

- [x] Workspace and explorer should act as different menu items than ones that can be moved left & right such as project tasks. currently, clicking on files closes project tasks for no reason. <!-- conductor-task:828e9195-e5a2-4033-b1a6-655acaf7dddd -->

- [x] Closing project tasks removes what we've had written there. Make sure that doesn't happen, same to other parts like project tasks <!-- conductor-task:c17c6c3c-5c82-4c03-b3d5-9bae9d1ff925 -->

- [x] BREAKING BUG, TOP PRIORITY: <!-- conductor-task:1a1038af-b33f-4dd1-a708-a88eafa62c79 -->
  
  Can't use Claude. I get error: Claude Code 2.1.265 is outside the tested 2.1.263 bridge baseline -> it gets paused, and I can't unpause it.

- [x] Explorer name needs to be atop, currently project contain the explorer tab name, that should be global. <!-- conductor-task:43792807-720b-465d-8ce4-76d97e9c1b23 agent=agent_mttzctg0_9d47sn3 -->

- [x] After using ctrl shift alt downarrow on [1] over [2] verically, then up again, i can't do the same thing (repeating) there must be a bug - make this entire system just a bit nicer to use. <!-- conductor-task:e1944766-e712-4557-be92-6c1c645216da agent=agent_mtt8r78u_bfzsv3d -->

- [x] Rework dragging of tabs, currently intuitive, but ugly. Make joining tabs like in chrome, i.e. if we drag it to the tab bar, it joins. <!-- conductor-task:2dc5f9b0-b091-458b-8812-979fed7209a0 agent=agent_mttcsu1i_3zvkeu1 -->

- [x] If we don't do anything in a New conversation, literally nothing, just start it, don't save it in history for no reason.. <!-- conductor-task:951e6ca7-f503-4096-a572-0fe57d259fb6 agent=agent_mtt8r78u_bfzsv3d -->

- [x] Animations inside the agent coding text window are slow - when agent is generating text, it's laggy, make it all really smooth & nicely animated, so it doesn't look like it's so choppy.. fast animations so we don't slow nothing down obviously, especially when the agent is giving us a reply, currently it's choppy sometimes. <!-- conductor-task:570d94d7-2dc1-46cb-a5cc-2c6cee0bbd35 agent=agent_mttcsu1i_3zvkeu1 -->

- [x] I think I wrote it here already (if so merge it with other task): Workspace view workspaces need to show alert same as tab & workspace tab does.. They should also show when there is active work in them, or when they're done working, all that jazz, so we can essentially see status easily on projects from that view. <!-- conductor-task:ea118d5a-abcc-4517-9fb3-f136e6d64346 agent=agent_mttzctg0_9d47sn3 -->

- [x] Usage % and 'view usage' should be in the same line as effort and all that is. <!-- conductor-task:5ffb5869-37cd-4a5a-8fa6-82562e268e3b agent=agent_mttcsu1i_3zvkeu1 -->

- [x] After opening a claude tab, we're met with the model name, but not effort, we need to click on model to gain access to effort -> should automatically be there. <!-- conductor-task:f7535768-a1b8-4927-8259-7e14146c7714 agent=agent_mttcsu1i_3zvkeu1 -->

- [x] Opening a file never guesses text: clicking a video, archive or other binary opened it in the editor and froze the window (no typing, no sending). Files now route by type, the main process refuses binary and oversized text reads, and "open as text" stays available from the right-click menu and the preview. Also fixed the two unhandled rejections it surfaced: clipboard copies failing with NotAllowedError when the document is unfocused, and Monaco's benign "Canceled" view-state rejection being logged as an error. <!-- conductor-task:2f1c8d64-9b3e-4c07-9a5f-1d0e7b2a4c58 agent=agent_mttdfjc1_e29wp4n -->

- [x] Clicking right on a file sent to us by an agent should give all options (like ctrl click, ctrl right click etc) explained, also add another option to open the file in explorer (opens explorer and highlights the file even more if it was open [add highlightign when open]) and another one to view in Windows Explorer. <!-- conductor-task:e2bfac55-af04-4111-a9dc-6367bc14d97b agent=agent_mtu035p5_ezlg01o -->

- [x] Workspace tabs shouldnt say '3 tabs' but just show the chevron next to the workspace and let that hide all its tabs <!-- conductor-task:1e8e0059-2d59-482c-b06b-ebcad8e7d82d agent=agent_mtu035p5_ezlg01o -->

- [x] When all the way to the bottom and new content is being actively generated, scrolling up stutters and doesn't let us leave bottom. <!-- conductor-task:77d9a4c4-1baf-41a5-8ff1-c091b71b1e1d agent=agent_mttz8sgn_wjeiuco -->

- [x] conductor/screenshot.png shows issue -> we get a check on the tab, yet multiple subagents are running and the main thread is also running. remove screenshot after fixing task. <!-- conductor-task:7a09125f-f1fb-48c1-bd7e-cd3fcf214920 agent=agent_mtu035p5_ezlg01o -->

- [x] Dont show 'Output tokens pending', instead, show a small dots 'loader' animation <!-- conductor-task:c9cbfe5c-416d-4067-980b-e050272ca822 agent=agent_mttz8sgn_wjeiuco -->

- [x] File diffs, commands, etc should at least view a bit of the 'In' and 'Out' like in VSCode Claude integration so we get at least a bit of an idea whats going on without having to click into each one. <!-- conductor-task:1117bd1d-9066-48c4-be5e-25a254357212 agent=agent_mtu035p5_ezlg01o -->
  
  Multiple file edits by an agent show up all the time, even small character edits - four in succession, make sure if in succession without any commentary from agent, the prev one just gets inflated to show the entire edit in one go.

- [x] Getting 'Within agents' spams without any context -> show which agent it is, make it way more informative, color-code agents -> if we show info, we want it to be thorough and helpful, not clutterful and useless. <!-- conductor-task:30bc6855-f8ee-44e4-a660-d8b6f2a40946 agent=agent_mtu035p5_ezlg01o -->

- [x] Currently, resume conversation is hidden behind Conversation settings. Should be visible in the error that says the conversation has been stopped, so it's UX friendly.. <!-- conductor-task:52ae4ebf-396d-4bf3-9fe6-c406cf8899de agent=agent_mtu035p5_ezlg01o -->

- [x] Sending a task to a tab via Project tasks shows it as 'Queued' but i can't see it actually send it.. Broken! <!-- conductor-task:b54caf0b-551b-49fe-8146-e587b025e1f2 agent=agent_mtu035p5_ezlg01o -->

- [x] In Project Tasks, clicking on 'completed' to see the tab that works it closes project tasks for no reason, and doesn't even highlight the tab that's working on it properly. <!-- conductor-task:f43ea848-da29-4553-b872-5eec46c1890c agent=agent_mtu035p5_ezlg01o -->

- [x] Project 'file' in Workspaces still doesn't show the project is churning, needs attention, or is done.. <!-- conductor-task:7b965f0f-36cf-40c2-8ee7-e733427dbfbf agent=agent_mtu035p5_ezlg01o -->

- [x] Fix how tasks are ordered in Project tasks (currently latest is last), also let us move them based on priority (add priority scale agents and us can set) <!-- conductor-task:71d97bf1-b4b0-4c7b-af24-c0985a5f3cea agent=agent_mtu035p5_ezlg01o -->

- [x] All spinners should be synced (stop button spinner, tab spinners (top tap spinner, left side tab spinner) <!-- conductor-task:ebc30a38-8930-404d-b9c2-fdf31371e900 agent=agent_mtu035p5_ezlg01o -->

- [x] This is still ugly, let's make it more UX friendly. <!-- conductor-task:8dbf1e2b-299e-4236-9ac2-45d74540e97e agent=agent_mtu035p5_ezlg01o -->
  
  ![image.png](.conductor/prompt-images/7e6bc8b3-6fe6-4b4e-8359-e9f47f45406b.png)

- [x] Stop button is amazing, but send button is still nasty.. [update: this was marked done, not done, it hasn't been re-designed] <!-- conductor-task:46f70c53-7942-4489-90f0-2f4a4584fdea agent=agent_mtunlyoz_mm2k2ey agent=agent_mtu035p5_ezlg01o -->

- [x] Chevron to minify tabs should be next to 01 Workspace 1 not in between workspace and tabs.. <!-- conductor-task:a9dd0370-5280-4d12-9ea9-cee8c7821bf4 agent=agent_mtu035p5_ezlg01o -->

- [x] Fix this view.. that's just spam of no info for us <!-- conductor-task:d071798e-7236-49cb-b4db-763e209eaf0d agent=agent_mtu3stcq_t5batz4 -->
  
  ![image.png](.conductor/prompt-images/e3707b26-dcda-4df4-a331-bad0d529ff78.png)

- [x] changing effort, then going to another project and back makes that effort go back.. fix, should stay where we put it <!-- conductor-task:29eb4e9b-956b-42bb-89d5-dcf01fb0605e agent=agent_mtu407kx_pn3me59 -->

- [x] Resuming conversation doubles all the ask, model, effort in UI.. <!-- conductor-task:243c62d4-f853-447b-885c-99d7aec33b39 agent=agent_mtu407kx_pn3me59 -->

- [x] Dragging tabs is fully broken. <!-- conductor-task:64352192-e182-4d66-8b5e-eecce2901a2c agent=agent_mtu404o5_zhiclam priority=high -->

- [x] Still see the broken chevron, please fix <!-- conductor-task:ea09f946-5ebd-494c-9eba-8dad432bb3c4 agent=agent_mtunlyoz_mm2k2ey agent=agent_mtu406m9_t5a1uqd -->

- [x] Redesign priority selector, currently broken (colors all red when high selected) <!-- conductor-task:a2c8c28b-8950-47a4-aa10-1b5943d1ec8b agent=agent_mtu405ms_r25z7jc priority=high -->
  
  ![image.png](.conductor/prompt-images/2a03e780-c2b8-4b72-b15c-50a8f68e78e7.png)

- [x] Let's design this even further, having many tabs open by an agent gets cluttered now, and we don't know which tab is which.. Let's add tab groups just like in Chrome. Also, currently open tab needs to be way more visible, I can barely see which I have open when it's open (in top tab view) <!-- conductor-task:ea0c7e46-5f3c-4f18-8344-610fb1e3c628 agent=agent_mtu5dqrg_osly1zf priority=low -->
  
  ![image.png](.conductor/prompt-images/89582f31-d1e0-436d-94bf-fe71b95c22c5.png)

- [x] Workspace projects view should also show which tabs are currently directly linked. <!-- conductor-task:7521b5cf-ed36-479b-a4f1-1b9a8421dec6 agent=agent_mtu4uptk_htoeh1o priority=low -->

- [x] Let's change the weird red dot for something that really shows state - disconnected? Stopped? what happened? nasty red dot just makes me angry, it's not even round.. <!-- conductor-task:f296635e-ea63-4b7f-8650-8692acd2cbd1 agent=agent_mtu5dqrg_osly1zf -->

- [x] Smoke tests are INCREDIBELY annoying. They -> appear over my screen, often taking my mouse over, and keyboard over.. That's FUCKING rampandly annoying, especialyl coming out of nowhere!!!!! <!-- conductor-task:bf25ae18-1e21-4a1e-9c94-e7742e305129 agent=agent_mtu3stcq_t5batz4 priority=high -->
  
  Don't destroy smoke tests, but fuck,, there must be a better way.. LIKE BRO I AM TRYING TO WORK HERE!!

- [x] This is too much, let's somehow compact it, or find another way to show this control.. <!-- conductor-task:7873476c-35b8-477c-bc50-f7e320fd7d63 agent=agent_mtu3stcq_t5batz4 -->
  
  ![image.png](.conductor/prompt-images/bb164458-1aa4-4464-b2f0-b697f209ba36.png)

- [x] Updater should be one click -> if a user clicks it, we go all the way to restarting. BUT: if there's any tab still running, ask the user if he really wants to quit, since that tab is running still.. <!-- conductor-task:39a207c9-b656-4b36-8ea1-52627b466913 agent=agent_mtunlyoz_mm2k2ey -->

- [x] need to be able to remove queued messages <!-- conductor-task:c5d6d189-ff27-430e-ad30-0404f168ee1a agent=agent_mtunlyoz_mm2k2ey -->

- [x] projects that have disconnected tabs show yellow even if they were done before, so all projects are just yellow all the time.. should be only if they were actually stopped during output, not if they were done in the first place. plus, there can be multiple states, currently, yellow takes over all.. <!-- conductor-task:0d76c319-42df-4c63-8628-fc74b8e5afdc agent=agent_mtunlyoz_mm2k2ey -->

- [x] tasks should also just have a default 'Task' one, not just bug/feature.. <!-- conductor-task:2336b162-6bd5-41bd-b446-bbedbfe0e1aa agent=agent_mtunlyoz_mm2k2ey -->

- [x] Agent creating new tab took my focus out of my current project and plopped me into said tab in another project. Maybe a notification'd be good, but not this. <!-- conductor-task:f379a89b-d3a5-457e-a511-ccc6e2d7fcb3 agent=agent_mtunlyoz_mm2k2ey -->

- [x] 'CONDUCTOR_MEMORY[semantic]:' we get these messages in chat.. fix <!-- conductor-task:2c9f312e-a520-4bcd-aa86-1fae776ba1e0 agent=agent_mtunlyoz_mm2k2ey -->

- [x] can't remove project tasks, add delete icon (ask if you really wanna delete it by icons only) available also via select multiple <!-- conductor-task:ae534926-469d-4e37-ae60-e149cdc72a10 agent=agent_mtunlyoz_mm2k2ey -->

- [x] can't undetach a detached tab by bringing it back to workspace, it just leaves more ghost conductors behind and is always detached.. also drag cursor is just 'block' icon - fix <!-- conductor-task:4e23b5c0-afd9-4fc7-b73e-5df4f969551c agent=agent_mtunlyoz_mm2k2ey -->

- [x] When selecting tasks and sending them off to an agent, we should be able to add a prompt to it also if we want. <!-- conductor-task:758c424a-d177-4460-9bef-7dab1790b37e agent=agent_mtunlyoz_mm2k2ey -->

- [x] Work more on 'agent wants to forget memory' - currently, a nasty windows popup.. <!-- conductor-task:ef91741d-7368-4083-b923-e96dbf3e633e agent=agent_mtunlyoz_mm2k2ey -->

- [x] this shouldn't happen, i.e. askuserquestions and then claude needs your input? that's weird.. (that's after I answered questions) - should just be one nice output. <!-- conductor-task:a818b8ca-1104-4186-9b67-7ceaea1b888f agent=agent_mtunlyoz_mm2k2ey -->
  
  ![image.png](.conductor/prompt-images/b3693788-bd70-4116-b983-a4760b825411.png)

- [x] make sure effort is always displayed.. sometimes, we just don't see it, like this one tab has claude-opus-5, on hover i see effort 'low' but I don't see the changer anywhere.. <!-- conductor-task:c392beab-56dc-4c33-a0cb-04ff74662897 agent=agent_mtunlyoz_mm2k2ey -->

- [x] tasks need another selector next to urgency - weight - to set which models should be used for it, i.e. if we think task is heavy, we'll use smarter, more costly models, if we think it's a itty bitty task, some smaller models could do it - same for effort. <!-- conductor-task:a547f4a6-6226-41cb-84ab-3c4be1a672d0 agent=agent_mtunlyoz_mm2k2ey -->

- [x] @browser should call browser like it does in vscode claude integration. <!-- conductor-task:05adbbcf-2534-4fe7-af43-b4b6ede981b8 agent=agent_mtunlyoz_mm2k2ey -->

- [x] INSANE BUG 'Snapshot unavailable: File is outside the session workspace' <!-- conductor-task:241cda0c-105f-4de8-a16b-2f064b235717 agent=agent_mtums6qy_vdgtdde priority=high -->
  SPAMS THE FUCK OUT OF WORKSPACE
  should ask for permission or something FIX FIX FIX

- [x] Memories are being recalled with every one of my messages sent - is that correct? It's at least annoying for me  to see. <!-- conductor-task:e5b29430-909e-41c6-961a-65c2f2e01422 agent=agent_mtunlyoz_mm2k2ey -->

- [x] Currently, when asking questions, selecting an option, we can still write in the textbox custom option. Should be a selectable option therefore.. <!-- conductor-task:2a82a315-c06e-45ae-8fea-196051840b3e agent=agent_mtunlyoz_mm2k2ey -->

- [x] When giving a project task to an agent, we should be able to select permission mode also not just model. <!-- conductor-task:311d3613-32ba-461f-8d67-7ccc1e833911 agent=agent_mtunlyoz_mm2k2ey -->

- [x] Processes - In Progress claude tasks show 'Choose model' instead of correct model. <!-- conductor-task:9dafbe07-0b7b-4f8b-8551-3c71cdd809f4 agent=agent_mtunlyoz_mm2k2ey -->

- [x] Instead of the Local Status BS with Local Workspcae in bottom left corner, add an ultra minified 'Processes' that just shows us whats going on (mostly to track token usage amongst multiple projects and theri workspaces. <!-- conductor-task:23983160-8163-4587-82c7-eacaff9cdd79 agent=agent_mtunlyoz_mm2k2ey -->

- [x] Dragging works, but there are no 'ghost previews' showing where the window would land + resizing of the existing windows is naaasty! <!-- conductor-task:6bdabd01-fdcc-473e-82ef-9b9b9bd7066f agent=agent_mtunlyoz_mm2k2ey -->

- [x] INSANE FUCKING BUG - PROMPT MUST CONTAIN 1-600000 CHARACTERS - FIX <!-- conductor-task:2153a831-299d-425d-a430-8e86d121920d agent=agent_mtunlyoz_mm2k2ey -->

- [~] Workspace can get flagged green even though an agent is actively churning - this seems to happen when it's controling other tabs and then they finish and it works, it doesn't even have a loader. <!-- conductor-task:038c7a04-7e22-4821-be7e-cc7f82f2a094 agent=agent_mturhxcc_t1p06lm -->

- [~] right click to open and the other context menu in windows explorer should be available straight in chat for files / links to files from agents <!-- conductor-task:3c742022-1449-4898-97be-d574808db6e3 agent=agent_mturhxcc_t1p06lm -->

- [~] Fix broken Windows file links in Conductor assistant messages: the CR5 "Before/after comparison" and "Updated Blender model" links used `/C:/Claude/miron/...` and did not open despite both files existing. Handle or normalize Windows drive paths and spaces, and verify PNG preview and Blender-file opening. Also make sure other projects can work with other project tasks open in the same session. <!-- conductor-task:edbcfcb8-c338-4434-b12a-6be5b1b69c46 agent=agent_mturhxcc_t1p06lm -->

- [~] If I open a tab with Claude, switch to Auto mode, it needs to be remembered for future tabs open with Claude. Same for tabs that agents auto open (unless they specifically set another mode by force) <!-- conductor-task:39a3d0fa-b6c7-4c55-a3ef-d4122d59e146 agent=agent_mturhxcc_t1p06lm -->

- [~] Tabs should get auto named when first message is sent <!-- conductor-task:26d660cd-b2ff-4f27-ace2-acff9b1280ab agent=agent_mturhxcc_t1p06lm -->

- [x] Add right click menu.. copy, all that jazz.. curreently I select text and i can't do nothing <!-- conductor-task:05579479-d437-41de-853e-908c4834db6d agent=agent_mtusoeta_9h639l8 -->

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

- [x] add real usage tracking, by real i mean: 'Codex GPT 6 Astra in this 1 session MUNCHED 60% of your weekly. Here's what happened in numbers:'. Add that for both Claude AND Codex. <!-- conductor-task:48c04f62-1f03-4bd9-827c-5a8ad5dd078e agent=agent_mtu4f3k6_yiau9kg -->

- [x] When we select a permission status in a model (auto/ask/etc), remember it and set that as pre-selected default for other sessions as well. <!-- conductor-task:8f31532b-caad-43e4-8604-56e55a3da8a1 agent=agent_mttezr6c_doodr76 -->

- [x] A tab an agent opens through app control still started on 'ask' permissions, so every delegated coworker stalled on approvals. A controlled tab now inherits its controller's permission mode, clamped to what the target provider supports and never above the controller's own level. <!-- conductor-task:control-tab-inherits-permission agent=agent_mtu035p5_ezlg01o -->

- [x] Add a usage cap (we can cap a tab / workspace to stop when a certain amount of weekly / daily session percentage is used, or possibly even token amount <!-- conductor-task:6c263544-4e62-442c-b65f-8b1f0b439749 agent=agent_mtu4f3k6_yiau9kg -->

- [x] Maybe a local diff 'git' setup would be nice so if one agent breaks something when fixing a bug or doesn't do it justice we can revert / see his changes even before gitting stuff.. <!-- conductor-task:eced4219-15bd-4cd3-a1e1-34f946d6c79b agent=agent_mtu4iljr_5gdjfag -->

- [x] Turn ask questions into multiple steps, don't just bash them 1 under the other. Place the window sticky on the bottom if tab size allows it (if not, just place it in content), so we can scroll content with it, reading stuff while reading the questions at the same time. <!-- conductor-task:b04379de-ad8c-499b-842d-6f6841515577 agent=agent_mtu3stcq_t5batz4 -->

- [x] Visually separate the other menus from workspace and explorer, menus that are not finished yet go to the bottom and look disabled. <!-- conductor-task:7b979a1a-2f6a-40be-99ca-b9f2964a1f5d agent=agent_mtu4f8jp_7sy8rpg -->

- [x] Just like in VScode, ctrl+e should show recently opened files (that we chose to open in conductor) <!-- conductor-task:c978a680-b006-4a86-b758-004fb427aafc agent=agent_mtu035p5_ezlg01o -->

- [x] last sent prompt by me should be stuck to the top of tab, should be trunctuated after amount of characters & should scroll me to the message on click (on hover it lets me know this is possible) <!-- conductor-task:82898f2c-fc9b-4911-b02d-a42421a782e9 agent=agent_mtu4zth1_z29k4e4 -->

- [x] Project row status only resolves for the project you are currently in. The Workspaces project row shows working / needs attention / done via getProjectActivityStatuses, but App's `sessions` state only ever holds the active project's workspaces, and the `conductor:agent-activity` events it rolls up are only dispatched by mounted panes. So every other project's row stays idle no matter what its agents are doing. Making it real needs activity for all projects from the backend (sessions and phases for non-active projects), not another renderer roll-up. <!-- conductor-task:feature-all-project-activity agent=agent_mtu4ioiz_385huku -->

- [x] Project memory is a closed loop rather than storage alone. Recall renders through formatRecalledMemories and its token budget; agents get MEMORY_PROTOCOL once per session so they can write memories; their CONDUCTOR_MEMORY sentinels are read back out of assistant replies and banked as agent-source memories, deduplicated per message so a growing snapshot cannot inflate a memory's strength; and faded, unrehearsed agent episodes are pruned once per session by database.forgetStaleMemories, while knowledge, policy, human-written and reinforced memories are kept. <!-- conductor-task:feature-memory-loop agent=agent_mtu035p5_ezlg01o -->

- [x] Build project memory out past the loop. Three concrete gaps remain. <!-- conductor-task:feature-memory-curation agent=agent_mtu49nhv_tcg2raw -->
  
  1. You cannot tell your memories from an agent's. Agents can now write to project memory on their own initiative, but MemoryPane shows only gist, cues, strength and recall count - not `source`, salience or confidence. Show provenance, and show which conversation wrote a memory and when.
  
  2. There is no way to curate memory by hand. `database.removeMemory` exists and the `memory.forget` RPC is agent-only, so the pane can't delete, correct, or re-weight anything. Add editing and deletion for human-owned and agent-written memories, and a visible prune that uses `standingMemoryScore` (written, still no caller) to rank what is decaying, instead of only the automatic once-per-session pass.
  
  3. Recall is invisible. Memories are injected into a turn's prompt with no indication in the conversation of which ones were used, so a wrong memory silently steers an agent with nothing to point at. Surface what was recalled for a turn, and make it correctable from there.
  
  Also fold up the last loose end: `MEMORY_KINDS` is the canonical kind list and still has no caller, while MemoryPane's `kindMeta` and the `memory.remember` RPC each hardcode their own copy of the same three kinds.

- [x] Add the Check icon somewhere to done tasks i.e. make a done task more visible, currently, it's not immidiately visible which are in fact done and which are not. <!-- conductor-task:663db862-e082-436a-9826-c385c232ae2d agent=agent_mtu035p5_ezlg01o -->

- [~] Add logging in via github for credentials. Then, add a system which can launch a server for remote control of this machines Conductor project and Conductor filespace by another Conductor logged in with the same github credentials. Orcherstrate this via the highest, latest model available, but that model will use lower class workers for the churning. The finished integration needs to let the user select a machine that actually runs that window, that way, for example, I'll be able to run a heavy render from the comfort of my conductor window, while the render runs on a PC, I run it off my laptop. The agents need to be aware of this fact, because when they'll be creating another linked tab or something similiar, those tabs need to run on that same machine as previously selected unless prompted differently.. <!-- conductor-task:a17381dc-57e2-4232-9e3c-85bfdbb32455 agent=agent_mtuf49my_96vnd6a priority=low -->

- [~] Add CTRL+F To chats (searches entire workspace for messages sent with agents and canhighlight it) <!-- conductor-task:3439f02b-608f-4bd6-9ded-97ed51ec573a agent=agent_mturhxcc_t1p06lm -->

- [~] To usage - give me visible warnings in a tab when it starts becoming expensive. Show it in processes also. <!-- conductor-task:2aa42f5b-c9d6-45a4-b71e-c75776557094 agent=agent_mturhxcc_t1p06lm -->

- [ ] Add 'Open session' 'Save session' to menu - this will save/open an entire session with all projects loaded, agents, all that jazz. Also show session name on top bar. <!-- conductor-task:9a048670-02d1-4315-85b9-28356a06f42e -->

## Urgent bugs and permissions - 2026-09-08

Migrated from the owner-approved urgent handoff. Original evidence and acceptance criteria are preserved below; progress is tracked through Project tasks.

## Bugs

## 1. Fix agent runtime startup and filesystem access

- [x] Investigate and fix `helper_unknown_error: setup refresh had errors` preventing Codex from starting its shell and accessing workspace files. <!-- conductor-task:urgent-runtime-startup agent=agent_mtt8r78u_bfzsv3d -->

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

## Bugs

- [x] Project tasks in 0.1.18 cannot add or edit reports containing line breaks. Preserve multi-line text and support Ctrl+Enter to save while Enter inserts a newline. <!-- conductor-task:task-multiline-reports agent=agent_mtsqk737_52vftmy -->

- [x] Closing a tab briefly flashes the remaining tab(s). Animate the pane resize so neighbours grow smoothly, without re-rendering or flashing their content during the transition. <!-- conductor-task:bug-tab-close-resize-flash agent=agent_mttcsu1i_3zvkeu1 -->

- [x] Ctrl+Shift+Alt+Arrow does not move a tab/window - it resizes exactly like Ctrl+Shift+Arrow. Make the move shortcut actually relocate the tab in the layout, distinct from resizing. <!-- conductor-task:bug-move-tab-shortcut -->

- [x] Switching the theme from day to night and back is extremely laggy. Make the theme swap fast and smooth. <!-- conductor-task:bug-theme-switch-lag agent=agent_mtt8r78u_bfzsv3d -->

- [x] An agent in one open project could not see, read or hand work to another project open in the same window: app.state showed only its own project and there was no way to enumerate or target a sibling. projects.list now names every co-open project, files.list/files.read/files.open, tabs.list and tasks.list accept a sibling projectId, and tabs.open/router.dispatch hand a visible worker tab to a sibling project that its controller can then steer. Writes into a sibling still go through a tab opened there, and a conversation a paired machine is driving stays inside the project shared with it. <!-- conductor-task:bug-cross-project-access agent=agent_mtulo6oo_08ud6sk -->

- [ ] The GitHub release workflow fails on every push to main, so installed updates only come from local builds. One cause is fixed already (Get-Acl needed the on-demand Microsoft.PowerShell.Security module, which the runner offers but cannot load); what remains is that scripts/repair-codex-workspace-owner.test.mjs compares paths from os.tmpdir() (C:\Users\RUNNER~1\...) against the long names PowerShell resolves (C:\Users\runneradmin\...), failing 'diagnostic mode reads both directory owners', 'a worktree .git pointer is left untouched' and 'reads owners where the Security module cannot be loaded'. Compare real paths on both sides, then confirm the workflow publishes an installer, blockmap and latest.yml again. <!-- conductor-task:bug-release-workflow-short-paths -->

## Features

- [x] Task circles select one or multiple tasks; completing a task uses its status selector and moves it to Done. Selected tasks can be assigned to an open native agent tab or a new tab with model and effort choices. Auto opens a main Fixer that chooses suitable models and efforts per task and delegates to visible native coworkers. <!-- conductor-task:task-selection-dispatch agent=agent_mtsqk737_52vftmy -->

- [x] Match VS Code file type colors/icons for every language and extension (.mjs, .cjs, .ts, .tsx, .json, .css, .md, .ps1, .yml, dotfiles, ...), applied consistently in the explorer, file tabs, Ctrl+E picker and agent file links. <!-- conductor-task:feature-file-type-colors agent=agent_mtu4f5v5_4ia8e4w -->

- [x] Subagents view currently shows almost nothing. Per subagent, show the model/provider it runs on (with effort), which tab and workspace it belongs to when that differs from the calling tab or is another company's model, live status, token usage, and a click-through to open it. It should render like the real agent view, with real designed steps rather than plain text. <!-- conductor-task:feature-subagents-view-detail agent=agent_mtu49or3_7l3m8st -->