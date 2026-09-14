# Table cell editing smoke test

Open this file in SuperMarkdown Preview, then try the checklist below.

## Basic values

| Name     | Quantity | Status  |
| -------- | -------: | :-----: |
| Apples   |       12 |  Ready  |
| Bananas  |        7 | Waiting |
| Cherries |       24 |  Ready  |

## Empty and missing values

| Item   | Owner      | Notes            |
| ------ | ---------- | ---------------- |
| First  | Tristan    |                  |
| Second |            | Add a value here |
| Third  | Unassigned |

## Characters that need escaping

| Label   | Value            |
| ------- | ---------------- |
| Pipe    | A \| B           |
| Path    | folder/subfolder |
| Symbols | $12.50 + 8%      |

## Formatted cells

These cells contain inline Markdown. They should use the existing whole-table editor rather than direct cell editing, so their formatting is not lost.

| Type | Example                              |
| ---- | ------------------------------------ |
| Bold | **important**                        |
| Link | [SuperMarkdown](https://example.com) |
| Code | `const value = 1`                    |

## Checklist

- [ ] Double-click a plain cell and enter a new value
- [ ] Focus a plain cell with `Tab`, then press `Enter` to edit
- [ ] Press `Enter` to save and confirm the Markdown source updates
- [ ] Click outside an edited cell to save
- [ ] Press `Esc` to cancel and confirm the source does not change
- [ ] Enter a value containing `|` and confirm the table still renders correctly
- [ ] Fill the empty and missing values
- [ ] Use VS Code Undo and confirm the previous value returns
- [ ] Confirm formatted cells do not open the direct cell editor
