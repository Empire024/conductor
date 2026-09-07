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

Implementation and validation: [backlog delivery record](docs/conductor-backlog-delivery.md).
