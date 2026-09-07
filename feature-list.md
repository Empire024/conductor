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

Implementation and validation: [backlog delivery record](docs/conductor-backlog-delivery.md).
