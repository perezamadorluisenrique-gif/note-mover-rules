# Note Mover Rules

Move notes into folders by ordered rules on tags, properties, titles and paths, with a preview before any bulk move.

![The preview: four notes from the inbox ready to move to Recipes, Journal and Archive, one note that stays because a note with that name is already there](https://raw.githubusercontent.com/perezamadorluisenrique-gif/note-mover-rules/main/docs/preview.png)

Write the rules once and let them file your notes. Nothing moves until you ask (or turn on automatic moving), a bulk move shows you every move first, and every move can be undone.

## Rules

A rule has a condition and a destination folder. A note goes to the folder of the **first rule that matches it**, checked from the top, so put the specific rules first.

| Condition | Matches |
|---|---|
| Tag | A tag, nested tags included: `#project` matches `#project` and `#project/alpha`, not `#projects`. Body tags and the `tags` property both count. |
| Property | A property equal to a value (ignoring case), or one item of a list property. Leave the value empty to match any note that has the property filled in. |
| Title matches | A regular expression tested against the note's name, ignoring case. `^\d{4}-\d{2}-\d{2}$` matches daily notes. |
| Path matches | A regular expression tested against the whole path, for example `^[^/]+\.md$` for notes in the vault root. |

![The settings: three rules, each with a condition and a folder](https://raw.githubusercontent.com/perezamadorluisenrique-gif/note-mover-rules/main/docs/settings.png)

Things that keep it from surprising you:

- A note **already inside** the destination folder (or one of its subfolders) stays where it is, and a rule that matches it stops later rules from moving it.
- A note is never overwritten: if a note with that name is already in the destination, it stays and the preview lists it separately.
- Two rules that would send a note back and forth (a path rule matching the new folder, say) never move it: the preview lists it as staying.
- Notes in an excluded folder (`Templates` by default, names compared ignoring case) never move, and neither does a note with `note-mover: disable` in its properties.
- A rule with a problem (an invalid regular expression, an empty tag) says so in the settings and never matches.
- The destination folder is created if it does not exist, unless you turn that off.

## Commands

| Command | What it does |
|---|---|
| Move this note by the rules | Moves the open note now, or tells you why it stays. |
| Preview moves for the notes in this folder | Lists every move for the notes in the open note's folder (subfolders included) with a checkbox for each. Nothing moves until you press the button. |
| Preview moves for every note | The same for the whole vault. |
| Undo the last move | Puts the last batch back; run it again to step back through earlier batches (the last 20). A note that was moved again or whose old place is taken stays where it is. |

There is also a **Move notes by the rules** item in the file explorer's folder menu.

Moves use Obsidian's own rename, so links to the moved notes update as usual. Turn on **Automatically update internal links** in Settings → Files and links first: otherwise Obsidian asks about links once per note that has links to it, after each move. The preview warns you when it is off.

## Moving by itself

Turn on **Move notes by themselves** and a note that is edited or renamed and now matches a rule moves two seconds later, so a half-typed tag does not send it away. It is off by default. If the destination already has a note with that name, you get one notice and the note stays. A note you put back with undo is not moved by itself again, and for five seconds after a move the plugin ignores edits (Obsidian rewriting links in other notes), so a move never sets off more moves.

## Coming from Auto Note Mover

The rules work the same way (first match wins, a tag or a title regular expression picks the folder), plus properties and paths, a preview before bulk moves and undo. Rules are not imported; they take a minute to re-enter. `note-mover: disable` in the properties replaces Auto Note Mover's `AutoNoteMover: disable`.

## Privacy

It reads your notes' tags, properties and names to match rules and moves files inside your vault. It makes no network requests and sends nothing anywhere.

## Installation

In Obsidian, open **Settings → Community plugins → Browse** and search for "Note Mover Rules".

## More plugins by Siulved54

| Plugin | What it does | Source |
| --- | --- | --- |
| [Shared Blocks](https://obsidian.md/plugins?id=shared-blocks) | Write a block of text once and reuse it in any note. Edit the source and every reference re-renders live. | [shared-blocks](https://github.com/perezamadorluisenrique-gif/shared-blocks) |
| [Text Case and Cleanup](https://obsidian.md/plugins?id=text-format) | Change case, make camelCase or slugs, sort lines and remove duplicates, and repair text pasted out of a PDF, without touching code or URLs. | [text-format](https://github.com/perezamadorluisenrique-gif/text-format) |
| [Typography as You Type](https://obsidian.md/plugins?id=typography-as-you-type) | Curly quotes, dashes and ellipses as you type, kept out of code and maths, with Backspace to take one back. | [smart-typography-plugin](https://github.com/perezamadorluisenrique-gif/smart-typography-plugin) |
| [Section Numbering](https://obsidian.md/plugins?id=section-numbering) | Number headings as an outline (1, 1.1, 1.2) and keep every link to them working when they renumber. | [section-numbering](https://github.com/perezamadorluisenrique-gif/section-numbering) |
| [Spreadsheet to Table](https://obsidian.md/plugins?id=spreadsheet-to-table) | Paste cells from Excel or Google Sheets as a Markdown table with a real header, insert CSV files, and copy tables back out. | [spreadsheet-to-table](https://github.com/perezamadorluisenrique-gif/spreadsheet-to-table) |
| [Hybrid Line Numbers](https://obsidian.md/plugins?id=hybrid-line-numbers) | Relative and hybrid line numbers for Vim-style jumps, where a folded section counts as one line. | [hybrid-line-numbers](https://github.com/perezamadorluisenrique-gif/hybrid-line-numbers) |
| [List Item Callouts](https://obsidian.md/plugins?id=list-item-callouts) | Colour a single list item as a callout by starting it with a character such as `&`, `!` or `?`. | [list-item-callouts](https://github.com/perezamadorluisenrique-gif/list-item-callouts) |
| [Folder Counts](https://obsidian.md/plugins?id=folder-counts) | See how many notes or files each folder holds, right in the file explorer, with a vault total and folder exclusions. | [folder-counts](https://github.com/perezamadorluisenrique-gif/folder-counts) |
| [Note Reading Time](https://obsidian.md/plugins?id=note-reading-time) | Reading time of the current note or your selection in the status bar, optionally saved to a property. | [note-reading-time](https://github.com/perezamadorluisenrique-gif/note-reading-time) |
| [Task Rollover](https://obsidian.md/plugins?id=task-rollover) | Roll unfinished tasks from your last daily note into today's when it is created, with a real undo. | [task-rollover](https://github.com/perezamadorluisenrique-gif/task-rollover) |
| [Zoom Into Section](https://obsidian.md/plugins?id=zoom-into-section) | Zoom into a heading or list item to see only it and its contents, with a breadcrumb bar to climb back out. | [zoom-into-section](https://github.com/perezamadorluisenrique-gif/zoom-into-section) |
| [Link Title on Paste](https://obsidian.md/plugins?id=link-title-on-paste) | Paste a web address and get a Markdown link with the page's title, fetched in the background and undone in one step. | [link-title-on-paste](https://github.com/perezamadorluisenrique-gif/link-title-on-paste) |
| [Update Radar](https://obsidian.md/plugins?id=update-radar) | Checks your installed community plugins for updates in the background, shows what changed, and flags the ones that look abandoned. | [community-update-checker](https://github.com/perezamadorluisenrique-gif/community-update-checker) |
| [Dataview to Bases](https://obsidian.md/plugins?id=dataview-to-bases) | Convert Dataview queries into Bases blocks, and see which queries in your vault can be converted. | [dataview-to-bases](https://github.com/perezamadorluisenrique-gif/dataview-to-bases) |
| [Line Editing Commands](https://obsidian.md/plugins?id=line-editing-commands) | Duplicate, join, sort and reverse lines, insert blank lines and jump to a line number, with multi-cursor support. | [line-editing-commands](https://github.com/perezamadorluisenrique-gif/line-editing-commands) |
| [Tab History](https://obsidian.md/plugins?id=tab-history) | Keeps each tab's back and forward history across restarts, and adds commands to move, maximize and close tabs. | [tab-history](https://github.com/perezamadorluisenrique-gif/tab-history) |
| [URL Cards](https://obsidian.md/plugins?id=url-cards) | Shows web addresses as cards with title, description and image, and reads existing cardlink blocks. | [url-cards](https://github.com/perezamadorluisenrique-gif/url-cards) |
| [Vim Config](https://obsidian.md/plugins?id=vim-config) | Loads a vimrc-style file from your vault so your key mappings and editor commands are ready when vim mode starts. | [vim-config](https://github.com/perezamadorluisenrique-gif/vim-config) |
| [Task Archive](https://obsidian.md/plugins?id=task-archive) | Moves completed tasks, with their sub-items, into an archive section or note. | [task-archive](https://github.com/perezamadorluisenrique-gif/task-archive) |

All of them are in the community directory: Settings -> Community plugins ->
Browse, then search for the name.
