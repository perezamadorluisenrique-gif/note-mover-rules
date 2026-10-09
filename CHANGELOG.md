# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## 0.2.0

- Destinations can be built from the note: `{{date:YYYY/MM}}` (from a property or the creation time), `{{property:name}}`, `{{tag}}`, `{{title}}` and `{{parent}}`, so one rule files notes by year, project or type. A note whose placeholder is empty stays, and the settings show an example for the open note.

## 0.1.0

- First release: ordered rules on tags, properties, titles and paths; move the open note or preview a folder or the whole vault with a checkbox per move; undo the last batch; optional automatic moving; excluded folders and a `note-mover: disable` property.
